// Why a submission FAILED, as a safe code for the admin dashboard (H3).
//
// When processing throws, documentProcessingService records FAILED with a
// PII-free summary: the `stage` it was in and a redacted one-line `error`.
// Only codes that the implementation actually produces are derived here;
// the error text itself is never returned to the dashboard.

// OcrResourceError reasons (ocrService.js): "OCR resource limit: <REASON>".
export const OCR_FAILURE_CODES = Object.freeze([
    "IMAGE_TOO_LARGE",
    "IMAGE_UNREADABLE",
    "PDF_TOO_MANY_PAGES",
    "PDF_PAGE_TOO_LARGE",
    "OCR_BUSY",
    "OCR_TIMEOUT",
]);

// Processing stages (documentProcessingService.js), in pipeline order.
export const PROCESSING_STAGES = Object.freeze([
    "TEXT_EXTRACTION", "CLASSIFICATION", "FIELD_EXTRACTION", "IDENTITY",
    "DUPLICATE_CHECK", "RECONCILIATION", "STORAGE", "RECORD_UPDATE",
    // M1 background worker (submissionQueue.js)
    "FILE_LOAD", "WORKER",
]);

export const FAILURE_CODE = Object.freeze({
    ...Object.fromEntries(OCR_FAILURE_CODES.map((code) => [code, code])),
    TEXT_EXTRACTION_FAILED: "TEXT_EXTRACTION_FAILED", // reading the text failed (other than a resource limit)
    STORAGE_FAILED: "STORAGE_FAILED",                 // copying the file or recording the document failed
    PROCESSING_FAILED: "PROCESSING_FAILED",           // any other stage
    FILE_UNAVAILABLE: "FILE_UNAVAILABLE",             // the worker could not load the received file (M1)
    ATTEMPTS_EXHAUSTED: "ATTEMPTS_EXHAUSTED",         // processing never finished after the bounded attempts (M1)
    NOT_RECORDED: "NOT_RECORDED",                     // processed before failure details were saved
});

// { code, stage } from a stored processing summary.
export function describeFailure(summary) {
    const stage = PROCESSING_STAGES.includes(summary?.stage) ? summary.stage : null;
    if (!stage) return { code: FAILURE_CODE.NOT_RECORDED, stage: null };
    const ocr = typeof summary.error === "string" ? summary.error.match(/OCR resource limit: ([A-Z_]+)/) : null;
    if (ocr && OCR_FAILURE_CODES.includes(ocr[1])) return { code: ocr[1], stage };
    if (stage === "TEXT_EXTRACTION") return { code: FAILURE_CODE.TEXT_EXTRACTION_FAILED, stage };
    if (stage === "STORAGE") return { code: FAILURE_CODE.STORAGE_FAILED, stage };
    if (stage === "FILE_LOAD") return { code: FAILURE_CODE.FILE_UNAVAILABLE, stage };
    if (stage === "WORKER") return { code: FAILURE_CODE.ATTEMPTS_EXHAUSTED, stage };
    return { code: FAILURE_CODE.PROCESSING_FAILED, stage };
}
