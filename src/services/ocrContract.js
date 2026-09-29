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

// The OCR service could not give an answer for this document: unreachable,
// timed out, overloaded, refused our credentials or failed internally.
// Nothing about the document is known, so the submission is processed again
// later (submissionQueue.js) instead of being recorded FAILED straight away.
export class OcrServiceUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = "OcrServiceUnavailableError";
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
