import { createWorker } from "tesseract.js";
import { PDFParse } from "pdf-parse";

import { readImageDimensions } from "../utils/imageDimensions.js";
import { safeErrorInfo } from "../utils/safeLog.js";
import { createConcurrencyLimiter, LimiterBusyError } from "../utils/concurrencyLimiter.js";

// Below this, a PDF is treated as scanned (image-only) rather than text-based.
const MIN_TEXT_LENGTH = 30;

// Passports, police reports and medical reports are 1-2 pages. The limit
// keeps a long upload from tying up the webhook with OCR.
const MAX_SCANNED_PDF_PAGES = 3;

// Render pages at 2x (about 144 DPI). Tesseract is noticeably worse below that.
const SCANNED_PDF_RENDER_SCALE = 2;

// Resource limits (SEC-007). Checked before any expensive work, so a small
// upload can't make the server decode, render or OCR something huge.
//
// Any PDF with more pages than this is refused before its text is read.
export const MAX_PDF_PAGES = 20;
// Largest image, or rendered PDF page, that may be OCR'd. Allows normal
// phone photos including 48-50 MP modes (about 8160 x 6120) and an A0 page
// rendered at 2x (about 32 MP).
export const MAX_IMAGE_DIMENSION = 12_000;
export const MAX_IMAGE_PIXELS = 50_000_000;
// Parallel OCR jobs (each Tesseract worker needs roughly 100-300 MB), how
// many more may wait for a slot, and for how long.
export const MAX_CONCURRENT_OCR_JOBS = 2;
export const MAX_WAITING_OCR_JOBS = 10;
export const OCR_QUEUE_TIMEOUT_MS = 60_000;
// Upper bound for one document's OCR (all pages and retries). Tesseract
// can't cancel a single read, but terminating the worker stops its thread.
export const OCR_JOB_TIMEOUT_MS = 120_000;

// A document refused for resource reasons. The message holds only the
// reason code: no file names, text or personal data.
export class OcrResourceError extends Error {
    constructor(reason) {
        super(`OCR resource limit: ${reason}`);
        this.name = "OcrResourceError";
        this.reason = reason; // IMAGE_TOO_LARGE, IMAGE_UNREADABLE, PDF_TOO_MANY_PAGES, PDF_PAGE_TOO_LARGE, OCR_BUSY, OCR_TIMEOUT
    }
}

// In memory for this one process (resets on restart). Several app instances
// would each have their own limit; that needs a shared queue/worker system.
export const ocrJobLimiter = createConcurrencyLimiter({
    maxConcurrent: MAX_CONCURRENT_OCR_JOBS,
    maxWaiting: MAX_WAITING_OCR_JOBS,
    waitTimeoutMs: OCR_QUEUE_TIMEOUT_MS,
});

async function runOcrJob(task) {
    try {
        return await ocrJobLimiter.run(task);
    } catch (error) {
        if (error instanceof LimiterBusyError) {
            throw new OcrResourceError("OCR_BUSY");
        }
        throw error;
    }
}

function exceedsImageLimits(width, height) {
    return width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS;
}

// Measured from the file header only; the image is never decoded here.
export function assertImageWithinLimits(fileBuffer) {
    const dimensions = readImageDimensions(fileBuffer);
    if (!dimensions) {
        throw new OcrResourceError("IMAGE_UNREADABLE");
    }
    if (exceedsImageLimits(dimensions.width, dimensions.height)) {
        throw new OcrResourceError("IMAGE_TOO_LARGE");
    }
    return dimensions;
}

// Page count (cheap: no page content is read) and, for pages about to be
// rendered, their size at the render scale.
async function assertPdfWithinLimits(parser, { renderedPages = 0 } = {}) {
    const { total } = await parser.getInfo();
    if (total > MAX_PDF_PAGES) {
        throw new OcrResourceError("PDF_TOO_MANY_PAGES");
    }

    if (renderedPages > 0) {
        const { pages } = await parser.getInfo({ parsePageInfo: true, first: renderedPages });
        for (const page of pages) {
            const width = Math.ceil(page.width * SCANNED_PDF_RENDER_SCALE);
            const height = Math.ceil(page.height * SCANNED_PDF_RENDER_SCALE);
            if (!(width > 0 && height > 0) || exceedsImageLimits(width, height)) {
                throw new OcrResourceError("PDF_PAGE_TOO_LARGE");
            }
        }
    }

    return total;
}

export const TEXT_EXTRACTION_METHODS = Object.freeze({
    PDF_TEXT: "PDF_TEXT",
    PDF_OCR: "PDF_OCR",
    PDF_PARSE_FAILED: "PDF_PARSE_FAILED",
    OCR: "OCR",
    UNSUPPORTED_DOCUMENT_TYPE: "UNSUPPORTED_DOCUMENT_TYPE",
});

// How Tesseract turns the image into black text on white. Otsu (default)
// uses one cut-off for the whole page; Sauvola adapts to local brightness,
// which rescues shadowed phone photos but can be slightly worse on clean
// images. So Sauvola is only tried when the default read is weak.
export const OCR_THRESHOLDING = Object.freeze({
    OTSU: { name: "OTSU", tesseractValue: "0" },
    SAUVOLA: { name: "SAUVOLA", tesseractValue: "2" },
});

// Below this, the default read is retried with the alternative settings.
export const OCR_RETRY_BELOW_CONFIDENCE = 70;

// Tried in order after a weak default read. rotateAuto straightens small
// tilts, but on some real photos it detects a false angle and makes the
// read worse, so it's an alternative rather than always on.
const OCR_ALTERNATIVES = [
    { thresholding: OCR_THRESHOLDING.OTSU, rotateAuto: true },
    { thresholding: OCR_THRESHOLDING.SAUVOLA, rotateAuto: false },
    { thresholding: OCR_THRESHOLDING.SAUVOLA, rotateAuto: true },
];

// Parameters stick to the worker, so thresholding is set on every read.
async function readPage(worker, image, thresholding, rotateAuto) {
    await worker.setParameters({ thresholding_method: thresholding.tesseractValue });
    const result = await worker.recognize(image, { rotateAuto });

    return {
        text: result.data.text?.trim() || "",
        confidence: result.data.confidence || 0,
        thresholding: thresholding.name,
        rotateAuto,
    };
}

// Read one image with the default settings (Otsu, no rotation). If that's
// weak, try the alternatives and keep the most confident read of all of
// them, including the default, so the result is never worse than before.
export async function recognizeImage(worker, image) {
    let best = await readPage(worker, image, OCR_THRESHOLDING.OTSU, false);
    if (best.confidence >= OCR_RETRY_BELOW_CONFIDENCE) {
        return best;
    }

    for (const { thresholding, rotateAuto } of OCR_ALTERNATIVES) {
        const attempt = await readPage(worker, image, thresholding, rotateAuto);
        if (attempt.confidence > best.confidence) {
            best = attempt;
        }
    }

    return best;
}

const createEnglishWorker = () => createWorker("eng");

// OCR several images with one worker. Starting a worker is the slow part.
// The whole job is bounded by timeoutMs; on timeout the worker is
// terminated, which stops the OCR still running inside it.
async function recognizeImages(images, { createOcrWorker = createEnglishWorker, timeoutMs = OCR_JOB_TIMEOUT_MS } = {}) {
    const worker = await createOcrWorker();
    let timer;

    const work = (async () => {
        const pages = [];
        for (const image of images) {
            pages.push(await recognizeImage(worker, image));
        }
        return pages;
    })();
    // After a timeout, this rejects when the worker is terminated; nobody
    // is waiting for it any more.
    work.catch(() => {});

    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new OcrResourceError("OCR_TIMEOUT")), timeoutMs);
    });

    try {
        return await Promise.race([work, timeout]);
    } finally {
        clearTimeout(timer);
        await worker.terminate();
    }
}

// Weight each page's confidence by how much text it produced, so a
// near-empty page doesn't drag down a well-read one.
function combinePages(pages) {
    const text = pages.map((page) => page.text).filter(Boolean).join("\n");
    const totalLength = pages.reduce((sum, page) => sum + page.text.length, 0);

    const confidence = totalLength > 0
        ? pages.reduce((sum, page) => sum + page.confidence * page.text.length, 0) / totalLength
        : 0;

    return { text, confidence: Math.round(confidence * 100) / 100 };
}

// Read the embedded text layer of a PDF.
export async function extractTextFromPdf(fileBuffer) {
    let parser;

    try {
        parser = new PDFParse({
            data: fileBuffer,
        });

        await assertPdfWithinLimits(parser);

        // No page markers: "-- 1 of 3 --" lines would make a scanned PDF
        // look like it has text.
        const result = await parser.getText({ pageJoiner: "" });
        const text = result.text?.trim() || "";

        return {
            success: text.length >= MIN_TEXT_LENGTH,
            text,
            method: TEXT_EXTRACTION_METHODS.PDF_TEXT,
        };
    } catch (error) {
        // A size refusal is not a broken PDF: let the caller record it as such.
        if (error instanceof OcrResourceError) {
            throw error;
        }
        console.error("PDF text extraction failed:", safeErrorInfo(error));

        return {
            success: false,
            text: "",
            method: TEXT_EXTRACTION_METHODS.PDF_PARSE_FAILED,
        };
    } finally {
        if (parser) {
            await parser.destroy();
        }
    }
}

// Scanned PDFs have no text layer, so render the first pages and OCR them.
// Rendering is memory-heavy too, so it runs inside the OCR job slot.
export async function extractTextFromScannedPdf(fileBuffer, options = {}) {
    return runOcrJob(async () => {
        const parser = new PDFParse({ data: fileBuffer });

        let screenshots;
        try {
            await assertPdfWithinLimits(parser, { renderedPages: MAX_SCANNED_PDF_PAGES });
            screenshots = await parser.getScreenshot({
                first: MAX_SCANNED_PDF_PAGES,
                scale: SCANNED_PDF_RENDER_SCALE,
                imageBuffer: true,
                imageDataUrl: false,
            });
        } finally {
            await parser.destroy();
        }

        const pages = await recognizeImages(screenshots.pages.map((page) => Buffer.from(page.data)), options);
        const { text, confidence } = combinePages(pages);

        return {
            success: text.length > 0,
            text,
            method: TEXT_EXTRACTION_METHODS.PDF_OCR,
            confidence,
            pagesProcessed: pages.length,
            totalPages: screenshots.total,
            thresholding: pages.map((page) => page.thresholding),
            rotateAuto: pages.map((page) => page.rotateAuto),
        };
    });
}

// Run Tesseract OCR on a JPEG/PNG image. The size is checked from the header
// before the job even queues, so an oversized image never reaches Tesseract.
export async function extractTextFromImage(fileBuffer, options = {}) {
    assertImageWithinLimits(fileBuffer);
    const [page] = await runOcrJob(() => recognizeImages([fileBuffer], options));

    return {
        success: page.text.length > 0,
        text: page.text,
        method: TEXT_EXTRACTION_METHODS.OCR,
        confidence: page.confidence,
        thresholding: page.thresholding,
        rotateAuto: page.rotateAuto,
    };
}

// Pick the extraction method based on MIME type. `options` is only used by
// tests (a fake OCR worker, a short timeout).
export async function extractDocumentText({
    fileBuffer,
    mimeType,
}, options = {}) {
    if (mimeType === "application/pdf") {
        const pdfResult = await extractTextFromPdf(fileBuffer);

        // A PDF that can't be parsed at all is corrupt, not scanned. OCR won't help.
        if (pdfResult.success || pdfResult.method === TEXT_EXTRACTION_METHODS.PDF_PARSE_FAILED) {
            return pdfResult;
        }

        return await extractTextFromScannedPdf(fileBuffer, options);
    }

    if (mimeType === "image/jpeg" || mimeType === "image/png") {
        return await extractTextFromImage(fileBuffer, options);
    }

    return {
        success: false,
        text: "",
        method: TEXT_EXTRACTION_METHODS.UNSUPPORTED_DOCUMENT_TYPE,
    };
}
