export const ALLOWED_MIME_TYPES = [
    "application/pdf",
    "image/jpeg",
    "image/png"
];

// Temporary limit until the final size rules are agreed.
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// Check a downloaded file before it is stored.
export function validateDocumentFile({
    mimeType,
    fileSize,
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

    return {
        valid: true,
    };
}
