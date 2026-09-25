import { createWorker } from "tesseract.js";
import { PDFParse } from "pdf-parse";

import { readImageDimensions } from "../utils/imageDimensions.js";
import { findPassportMrz, parsePassportMrz } from "../utils/mrz.js";
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

// A read with fewer non-space characters than this is treated as having read
// nothing, whatever confidence Tesseract reports for it (an empty page can
// come back as 95%).
export const MIN_OCR_TEXT_CHARS = 10;

// Reads this close in confidence count as equally good; a valid passport MRZ
// then decides (see isBetterRead).
export const SIMILAR_CONFIDENCE_MARGIN = 5;

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

// Confidence used to compare reads; 0 for a (nearly) empty read.
function selectionConfidence(read) {
    return read.text.replace(/\s/g, "").length >= MIN_OCR_TEXT_CHARS ? read.confidence : 0;
}

// Passport MRZ evidence in a read, 0-4: MRZ line 1 found, plus each valid
// check digit for the passport number, date of birth and expiry on line 2.
// Text without an MRZ (police, medical, anything else) always scores 0, so
// it is never affected.
export const FULL_MRZ_EVIDENCE = 4;

export function mrzEvidence(text) {
    const mrz = findPassportMrz(text);
    if (!mrz) return 0;
    const parsed = parsePassportMrz(mrz);
    return [Boolean(mrz.line1), parsed.passportNumberCheckValid, parsed.dateOfBirthCheckValid, parsed.expiryDateCheckValid]
        .filter((valid) => valid === true).length;
}

// Clearly higher confidence wins. When two reads are within the margin, the
// one with more valid MRZ check digits wins; if that's equal too (always the
// case for non-passports), plain confidence decides as before.
function isBetterRead(candidate, best) {
    const candidateConfidence = selectionConfidence(candidate);
    const bestConfidence = selectionConfidence(best);

    if (Math.abs(candidateConfidence - bestConfidence) <= SIMILAR_CONFIDENCE_MARGIN) {
        const candidateMrz = mrzEvidence(candidate.text);
        const bestMrz = mrzEvidence(best.text);
        if (candidateMrz !== bestMrz) return candidateMrz > bestMrz;
    }
    return candidateConfidence > bestConfidence;
}

// Read one image with the default settings (Otsu, no rotation). If that's
// weak (or empty), try the alternatives and keep the best read of all of
// them, including the default, so the result is never worse than before.
// The returned confidence is always the one Tesseract reported.
export async function recognizeImage(worker, image) {
    let best = await readPage(worker, image, OCR_THRESHOLDING.OTSU, false);
    if (selectionConfidence(best) >= OCR_RETRY_BELOW_CONFIDENCE) {
        return best;
    }

    for (const { thresholding, rotateAuto } of OCR_ALTERNATIVES) {
        const attempt = await readPage(worker, image, thresholding, rotateAuto);
        if (isBetterRead(attempt, best)) {
            best = attempt;
        }
    }

    return best;
}

const createEnglishWorker = () => createWorker("eng");

// OCR several images with one worker. Starting a worker is the slow part.
// The whole job is bounded by timeoutMs; on timeout the worker is
// terminated, which stops the OCR still running inside it.
// `recognize` reads one image with the worker (recognizeImage by default).
async function recognizeImages(images, { createOcrWorker = createEnglishWorker, timeoutMs = OCR_JOB_TIMEOUT_MS, recognize = recognizeImage } = {}) {
    const worker = await createOcrWorker();
    let timer;

    const work = (async () => {
        const pages = [];
        for (const image of images) {
            pages.push(await recognize(worker, image));
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

// Small images get a second read at 2x. WhatsApp passport photos are often
// only 400-900 px for the whole page, so the MRZ letters are a few pixels
// high (Tesseract estimates ~110 DPI) and can't be read reliably; 2x brings
// them to ~200 DPI, like the 2x render of scanned PDFs. It is only a second
// candidate: on images that already read well, 2x can read worse (tested),
// so the native read is always tried first and kept unless 2x is better.
// 3x was tested and read worse. Photos >= 1200 px are never enlarged.
export const UPSCALE_BELOW_LONG_SIDE = 1200;
export const SMALL_IMAGE_SCALE = 2;

// Size of the 2x read, or null when the image is not enlarged. Never beyond
// the image limits.
export function ocrImageSize({ width, height }) {
    if (Math.max(width, height) >= UPSCALE_BELOW_LONG_SIDE) {
        return null;
    }
    const scaled = { width: width * SMALL_IMAGE_SCALE, height: height * SMALL_IMAGE_SCALE };
    return exceedsImageLimits(scaled.width, scaled.height) ? null : scaled;
}

// Decode an upload into RGBA pixels with pure-JavaScript decoders. A bad
// file makes them throw, nothing worse. The native canvas decoder is never
// given the upload: it crashes the whole process (segfault) on some
// malformed files, e.g. a truncated PNG, which any sender could send.
// jpeg-js also enforces its own resolution and memory caps.
async function decodeImagePixels(fileBuffer, format) {
    if (format === "jpeg") {
        const { default: jpeg } = await import("jpeg-js");
        return jpeg.decode(fileBuffer, {
            useTArray: true,
            formatAsRGBA: true,
            maxResolutionInMP: MAX_IMAGE_PIXELS / 1_000_000,
            maxMemoryUsageInMB: 512,
        });
    }
    if (format === "png") {
        const { PNG } = await import("pngjs");
        return PNG.sync.read(fileBuffer); // always 8-bit RGBA
    }
    return null;
}

// Decode and enlarge a small image. Only called after the header size check.
// The decoded size must match the header, so a file can't claim one size and
// decode to another. Returns null if the image can't be decoded (the native
// read is then used). Canvas only resamples the already-decoded pixels.
export async function upscaleImage(fileBuffer, dimensions) {
    const target = ocrImageSize(dimensions);
    if (!target) {
        return null;
    }

    let pixels;
    try {
        pixels = await decodeImagePixels(fileBuffer, dimensions.format);
    } catch {
        return null;
    }
    if (!pixels) {
        return null;
    }
    if (pixels.width !== dimensions.width || pixels.height !== dimensions.height) {
        throw new OcrResourceError("IMAGE_UNREADABLE");
    }

    const { createCanvas } = await import("@napi-rs/canvas");
    const source = createCanvas(pixels.width, pixels.height);
    const sourceContext = source.getContext("2d");
    const imageData = sourceContext.createImageData(pixels.width, pixels.height);
    imageData.data.set(pixels.data);
    // Grayscale (BT.601 luma) before resampling, so colour noise from the
    // background print and JPEG chroma isn't enlarged into the letters.
    const rgba = imageData.data;
    for (let i = 0; i < rgba.length; i += 4) {
        const luma = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
        rgba[i] = rgba[i + 1] = rgba[i + 2] = luma;
    }
    sourceContext.putImageData(imageData, 0, 0);

    const canvas = createCanvas(target.width, target.height);
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, target.width, target.height);

    // PNG: lossless, so no new compression artefacts on top of WhatsApp's.
    return canvas.toBuffer("image/png");
}

// A native read that is weak (or empty), or that shows a passport MRZ it
// couldn't fully validate, is worth a second read at 2x. A good read of a
// police or medical photo has no MRZ, so it never gets one.
function needsUpscaledRead(read) {
    if (selectionConfidence(read) < OCR_RETRY_BELOW_CONFIDENCE) return true;
    return findPassportMrz(read.text) !== null && mrzEvidence(read.text) < FULL_MRZ_EVIDENCE;
}

// Native vs 2x: MRZ evidence first (check digits are objective proof of a
// correct read, Tesseract's confidence is not), then confidence. Text
// without an MRZ scores 0 on both, so confidence alone decides.
function isBetterUpscaledRead(upscaled, native) {
    const upscaledMrz = mrzEvidence(upscaled.text);
    const nativeMrz = mrzEvidence(native.text);
    if (upscaledMrz !== nativeMrz) return upscaledMrz > nativeMrz;
    return selectionConfidence(upscaled) > selectionConfidence(native);
}

// Native read (with its usual retries), then, for a small image with a weak
// or incomplete result, a 2x read. The better of the two is returned with
// its own reported confidence.
export async function recognizeImageWithUpscale(worker, image, dimensions, { upscale = upscaleImage } = {}) {
    const native = await recognizeImage(worker, image);
    if (!ocrImageSize(dimensions) || !needsUpscaledRead(native)) {
        return { ...native, upscaled: false };
    }

    const enlarged = await upscale(image, dimensions);
    if (!enlarged) {
        return { ...native, upscaled: false };
    }

    const upscaled = await recognizeImage(worker, enlarged);
    return isBetterUpscaledRead(upscaled, native)
        ? { ...upscaled, upscaled: true }
        : { ...native, upscaled: false };
}

// Run Tesseract OCR on a JPEG/PNG image. The size is checked from the header
// before the job even queues, so an oversized image is never decoded or
// OCR'd. The 2x read, if any, runs in the same job slot and time limit.
export async function extractTextFromImage(fileBuffer, options = {}) {
    const dimensions = assertImageWithinLimits(fileBuffer);
    const [page] = await runOcrJob(() => recognizeImages([fileBuffer], {
        ...options,
        recognize: (worker, image) => recognizeImageWithUpscale(worker, image, dimensions, options),
    }));

    return {
        success: page.text.length > 0,
        text: page.text,
        method: TEXT_EXTRACTION_METHODS.OCR,
        confidence: page.confidence,
        thresholding: page.thresholding,
        rotateAuto: page.rotateAuto,
        upscaled: page.upscaled,
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
