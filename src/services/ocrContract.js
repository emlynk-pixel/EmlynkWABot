// What text extraction returns and the errors it reports. The OCR itself
// runs in the separate OCR service (ocr-worker/); these definitions are the
// contract the pipeline relies on, wherever the text was read.
//
// Result: { success, text, method, confidence?, thresholding?, rotateAuto?,
// upscaled?, rotation?, pagesProcessed?, totalPages? }

export const TEXT_EXTRACTION_METHODS = Object.freeze({
    PDF_TEXT: "PDF_TEXT",
    PDF_OCR: "PDF_OCR",
    PDF_PARSE_FAILED: "PDF_PARSE_FAILED",
    OCR: "OCR",
    UNSUPPORTED_DOCUMENT_TYPE: "UNSUPPORTED_DOCUMENT_TYPE",
});

// Reasons the OCR service refuses a document (its OcrResourceError).
export const OCR_RESOURCE_REASONS = Object.freeze([
    "IMAGE_TOO_LARGE",
    "IMAGE_UNREADABLE",
    "PDF_TOO_MANY_PAGES",
    "PDF_PAGE_TOO_LARGE",
    "OCR_BUSY",
    "OCR_TIMEOUT",
]);

// A document refused for resource reasons. The message holds only the
// reason code: no file names, text or personal data.
export class OcrResourceError extends Error {
    constructor(reason) {
        super(`OCR resource limit: ${reason}`);
        this.name = "OcrResourceError";
        this.reason = reason;
    }
}

// Why the OCR service gave no answer, for diagnosis only (submissionQueue.js
// logs it). Never changes what happens next: every reason is retried the
// same way, within the existing attempt/lease rules. NOT_CONFIGURED and
// CREDENTIALS usually mean a deployment/setup problem (a missing
// OCR_SERVICE_URL, or Application Default Credentials not available to this
// process) rather than the service being temporarily down, so they are worth
// noticing quickly even though retries proceed exactly as before.
export const OCR_UNAVAILABLE_REASONS = Object.freeze({
    NOT_CONFIGURED: "NOT_CONFIGURED",   // OCR_SERVICE_URL is not set
    CREDENTIALS: "CREDENTIALS",         // couldn't obtain a Google identity token (ADC)
    NETWORK: "NETWORK",                 // request could not be sent or timed out
    AUTH: "AUTH",                       // the service answered 401/403 (token rejected)
    NOT_FOUND: "NOT_FOUND",             // the service answered 404 (wrong URL/path)
    BUSY: "BUSY",                       // 429, or 503 other than the OCR job queue itself
    SERVER_ERROR: "SERVER_ERROR",       // 5xx, or an answer that didn't match the contract
});

// The OCR service could not give an answer for this document: unreachable,
// timed out, overloaded, refused our credentials or failed internally.
// Nothing about the document is known, so the submission is processed again
// later (submissionQueue.js) instead of being recorded FAILED straight away.
export class OcrServiceUnavailableError extends Error {
    constructor(message, reason = null) {
        super(message);
        this.name = "OcrServiceUnavailableError";
        this.reason = reason;
    }
}

// The OCR service answered that the request itself is unusable (malformed,
// or larger than it accepts). Sending it again can't help.
export class OcrRequestRejectedError extends Error {
    constructor(message) {
        super(message);
        this.name = "OcrRequestRejectedError";
    }
}
