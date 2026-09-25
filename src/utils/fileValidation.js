export const ALLOWED_MIME_TYPES = [
    "application/pdf",
    "image/jpeg",
    "image/png"
];

// Temporary limit until the final size rules are agreed.
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// PDF readers accept a header anywhere in the first 1024 bytes.
const PDF_HEADER = Buffer.from("%PDF-");
const PDF_HEADER_SEARCH_BYTES = 1024;
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Do the file's first bytes match the declared MIME type? (SEC-009)
// The MIME type comes from the sender's WhatsApp app, so on its own it says
// nothing about what the bytes really are.
export function fileSignatureMatches(fileBuffer, mimeType) {
    if (!Buffer.isBuffer(fileBuffer)) return false;

    switch (mimeType) {
        case "application/pdf":
            return fileBuffer.subarray(0, PDF_HEADER_SEARCH_BYTES).includes(PDF_HEADER);
        case "image/jpeg":
            return fileBuffer.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE);
        case "image/png":
            return fileBuffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
        default:
            return false;
    }
}

// Check a downloaded file before it is stored. When fileBuffer is given
// (the webhook always passes it), its content must match mimeType too.
export function validateDocumentFile({
    mimeType,
    fileSize,
    fileBuffer,
}) {
    if (!mimeType) {
        return {
            valid: false,
            reason: "MISSING_MIME_TYPE",
        };
    }

    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
        return {
            valid: false,
            reason: "UNSUPPORTED_FILE_TYPE",
        };
    }

    if (!fileSize || fileSize <= 0) {
        return {
            valid: false,
            reason: "INVALID_FILE_SIZE",
        };
    }

    if (fileSize > MAX_FILE_SIZE) {
        return {
            valid: false,
            reason: "FILE_TOO_LARGE",
        };
    }

    if (fileBuffer !== undefined && !fileSignatureMatches(fileBuffer, mimeType)) {
        return {
            valid: false,
            reason: "FILE_SIGNATURE_MISMATCH",
        };
    }

    return {
        valid: true,
    };
}
