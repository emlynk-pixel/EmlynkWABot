// Fetch WhatsApp media from the Meta Graph API.
//
// Anyone who knows the business number can send a file, so the size limit is
// enforced here, before and during the download, not only after it: Meta's
// reported size is checked first, then the bytes are counted as they arrive.

import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE } from "../utils/fileValidation.js";

// Metadata is a small JSON response; the download may be up to 10 MB on a
// slow connection. Both are aborted after this long.
export const MEDIA_METADATA_TIMEOUT_MS = 10_000;
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;

// A file refused for size or type. Same outcome as a failed validation.
export class MediaRejectedError extends Error {
    constructor(reason) {
        super(`WhatsApp media rejected: ${reason}`);
        this.name = "MediaRejectedError";
        this.reason = reason;
    }
}

function getAuthHeaders() {
    if (!process.env.WHATSAPP_ACCESS_TOKEN) {
        throw new Error("WHATSAPP_ACCESS_TOKEN not found in env variables");
    }

    return {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
    };
}

const isTimeout = (error) => error?.name === "TimeoutError" || error?.name === "AbortError";

// Meta's mime_type can carry parameters ("image/jpeg; ..."); compare the type only.
function baseMimeType(mimeType) {
    return String(mimeType).split(";")[0].trim().toLowerCase();
}

// Refuse a file Meta already tells us is too large or of the wrong type,
// before downloading any of it. Missing values are allowed through: the
// download itself is still limited.
function checkMediaMetadata({ file_size: fileSize, mime_type: mimeType }) {
    const reportedSize = Number(fileSize);
    if (Number.isFinite(reportedSize) && reportedSize > MAX_FILE_SIZE) {
        throw new MediaRejectedError("FILE_TOO_LARGE");
    }

    if (mimeType && !ALLOWED_MIME_TYPES.includes(baseMimeType(mimeType))) {
        throw new MediaRejectedError("UNSUPPORTED_FILE_TYPE");
    }
}

// Meta doesn't send the file itself, only a media ID. Exchange it for a
// short-lived download URL, checking the reported size and type on the way.
export async function getWhatsappMediaUrl(mediaId, { timeoutMs = MEDIA_METADATA_TIMEOUT_MS } = {}) {
    const headers = getAuthHeaders();

    if (!process.env.WHATSAPP_API_VERSION) {
        throw new Error("WHATSAPP_API_VERSION not found in env variables");
    }

    const url = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}/${mediaId}`;

    let data;
    try {
        const response = await fetch(url, {
            method: "GET",
            headers,
            signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
            // Graph API errors are short JSON; cap what ends up in the logs anyway.
            const errorData = (await response.text()).slice(0, 300);
            throw new Error(`Failed to get Whatsapp media URL: ${response.status} - ${errorData}`);
        }

        data = await response.json();
    } catch (error) {
        if (isTimeout(error)) {
            throw new Error("WhatsApp media metadata request timed out");
        }
        throw error;
    }

    if (!data.url) {
        throw new Error("Whatsapp media url not found");
    }

    checkMediaMetadata(data);
    return data.url;
}

// Read the body chunk by chunk and stop as soon as it passes maxBytes, so at
// most one chunk more than the limit is ever held in memory.
async function readBodyWithLimit(response, maxBytes) {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw new MediaRejectedError("FILE_TOO_LARGE");
    }

    if (!response.body) {
        return Buffer.alloc(0);
    }

    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new MediaRejectedError("FILE_TOO_LARGE");
        }
        chunks.push(value);
    }

    return Buffer.concat(chunks, totalBytes);
}

// The download URL also needs the access token. The URL itself is never put
// in error messages: it's a signed link to the client's file.
export async function downloadWhatsappMedia(mediaUrl, { timeoutMs = MEDIA_DOWNLOAD_TIMEOUT_MS, maxBytes = MAX_FILE_SIZE } = {}) {
    const headers = getAuthHeaders();

    try {
        const response = await fetch(mediaUrl, {
            method: "GET",
            headers,
            // Also covers reading the body, not just the response headers.
            signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw new Error(`Failed to download Whatsapp media: ${response.status}`);
        }

        return await readBodyWithLimit(response, maxBytes);
    } catch (error) {
        if (isTimeout(error)) {
            throw new Error("WhatsApp media download timed out");
        }
        throw error;
    }
}
