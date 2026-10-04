// Text extraction by the OCR service (ocr-worker/, on Google Cloud Run).
//
// extractDocumentText({ fileBuffer, mimeType }) sends the document to the
// service and returns its result unchanged (ocrContract.js), so the pipeline
// works exactly as it did with in-process OCR. A document the service refuses
// throws OcrResourceError with the same message as before; a service that
// can't answer throws OcrServiceUnavailableError, and the submission is
// processed again later (submissionQueue.js).
//
// Authentication is Cloud Run IAM: each request carries a Google-signed
// identity token for the service URL, from Application Default Credentials
// (a service account holding roles/run.invoker on the service). A loopback
// URL (the service run locally, reachable from this machine only) gets none.
// Errors name statuses and codes only, never the token or document data.

import {
    OCR_RESOURCE_REASONS,
    OCR_UNAVAILABLE_REASONS,
    OcrRequestRejectedError,
    OcrResourceError,
    OcrServiceUnavailableError,
} from "./ocrContract.js";

// Above the service's own worst case (60 s waiting for a slot + 120 s of OCR,
// plus a cold start), well inside the queue's 10-minute lease.
export const OCR_REQUEST_TIMEOUT_MS = 240_000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackUrl(url) {
    try {
        return LOOPBACK_HOSTS.has(new URL(url).hostname);
    } catch {
        return false;
    }
}

// Authorization header with a Google identity token whose audience is the
// service URL. google-auth-library caches the token and renews it before it
// expires; a failed lookup is retried on the next request.
export function googleIdTokenHeaders(serviceUrl) {
    const audience = new URL(serviceUrl).origin;
    let client = null;
    return async () => {
        try {
            client ??= import("google-auth-library").then(({ GoogleAuth }) => new GoogleAuth().getIdTokenClient(audience));
            const headers = new Headers(await (await client).getRequestHeaders());
            const authorization = headers.get("authorization");
            if (!authorization) throw new Error("No identity token");
            return { authorization };
        } catch (error) {
            client = null;
            throw error;
        }
    };
}

const noAuthHeaders = async () => ({});

async function readJson(response) {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

function isExtractionResult(body) {
    return typeof body?.success === "boolean" && typeof body.text === "string" && typeof body.method === "string";
}

function errorCode(body) {
    const code = body?.error?.code;
    return typeof code === "string" && /^[A-Z_]{1,40}$/.test(code) ? code : null;
}

export function createOcrClient({
    serviceUrl = process.env.OCR_SERVICE_URL,
    fetch: fetchImpl = globalThis.fetch,
    authHeaders = serviceUrl && !isLoopbackUrl(serviceUrl) ? googleIdTokenHeaders(serviceUrl) : noAuthHeaders,
    timeoutMs = OCR_REQUEST_TIMEOUT_MS,
} = {}) {
    return async function extractDocumentText({ fileBuffer, mimeType }) {
        if (!serviceUrl) {
            throw new OcrServiceUnavailableError("OCR service is not configured (OCR_SERVICE_URL)", OCR_UNAVAILABLE_REASONS.NOT_CONFIGURED);
        }

        let auth;
        try {
            auth = await authHeaders();
        } catch (error) {
            throw new OcrServiceUnavailableError(`OCR service credentials unavailable (${error?.name ?? "Error"})`, OCR_UNAVAILABLE_REASONS.CREDENTIALS);
        }

        let response;
        try {
            response = await fetchImpl(new URL("/process", serviceUrl), {
                method: "POST",
                headers: { ...auth, "content-type": mimeType },
                body: fileBuffer,
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            throw new OcrServiceUnavailableError(
                error?.name === "TimeoutError" ? "OCR service timed out" : "OCR service unreachable",
                OCR_UNAVAILABLE_REASONS.NETWORK,
            );
        }

        const body = await readJson(response);
        if (response.ok) {
            if (isExtractionResult(body)) return body;
            throw new OcrServiceUnavailableError(`OCR service returned an invalid response (HTTP ${response.status})`, OCR_UNAVAILABLE_REASONS.SERVER_ERROR);
        }

        const code = errorCode(body);
        // The document itself was refused, as the in-process OCR did before.
        if (response.status === 422 && OCR_RESOURCE_REASONS.includes(code)) {
            throw new OcrResourceError(code);
        }
        // Overloaded: the same message as before, so a submission that is
        // finally given up still shows OCR_BUSY in the dashboard.
        if (response.status === 503 && code === "OCR_BUSY") {
            throw new OcrServiceUnavailableError(new OcrResourceError(code).message, OCR_UNAVAILABLE_REASONS.BUSY);
        }
        if (response.status === 400 || response.status === 413) {
            throw new OcrRequestRejectedError(`OCR service rejected the request (HTTP ${response.status}${code ? ` ${code}` : ""})`);
        }
        // 401/403: the token was rejected (a real setup problem, e.g. the
        // caller lacks roles/run.invoker); 404: wrong URL/path; 429: no
        // instance free; other 5xx: the service itself failed.
        const reason = response.status === 401 || response.status === 403
            ? OCR_UNAVAILABLE_REASONS.AUTH
            : response.status === 404
                ? OCR_UNAVAILABLE_REASONS.NOT_FOUND
                : response.status === 429
                    ? OCR_UNAVAILABLE_REASONS.BUSY
                    : OCR_UNAVAILABLE_REASONS.SERVER_ERROR;
        throw new OcrServiceUnavailableError(`OCR service error (HTTP ${response.status}${code ? ` ${code}` : ""})`, reason);
    };
}

let defaultClient = null;

// The pipeline's default text extraction (documentProcessingService.js).
// Configured from the environment on first use.
export function extractDocumentText(input) {
    defaultClient ??= createOcrClient();
    return defaultClient(input);
}
