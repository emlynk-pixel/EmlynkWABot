import { createWorker } from "tesseract.js";
import { PDFParse } from "pdf-parse";

// Below this, a PDF is treated as scanned (image-only) rather than text-based.
const MIN_TEXT_LENGTH = 30;

// Passports, police reports and medical reports are 1-2 pages. The limit
// keeps a long upload from tying up the webhook with OCR.
const MAX_SCANNED_PDF_PAGES = 3;

// Render pages at 2x (about 144 DPI). Tesseract is noticeably worse below that.
const SCANNED_PDF_RENDER_SCALE = 2;

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
// images. So Sauvola is only a retry for weak reads.
export const OCR_THRESHOLDING = Object.freeze({
    OTSU: { name: "OTSU", tesseractValue: "0" },
    SAUVOLA: { name: "SAUVOLA", tesseractValue: "2" },
});

export const SAUVOLA_RETRY_BELOW_CONFIDENCE = 70;

// rotateAuto straightens small tilts, common in phone photos. Parameters
// stick to the worker, so thresholding is set on every read.
async function readPage(worker, image, thresholding) {
    await worker.setParameters({ thresholding_method: thresholding.tesseractValue });
    const result = await worker.recognize(image, { rotateAuto: true });

    return {
        text: result.data.text?.trim() || "",
        confidence: result.data.confidence || 0,
        thresholding: thresholding.name,
    };
}

// Read one image; retry a weak read with Sauvola and keep the better one.
export async function recognizeImage(worker, image) {
    const first = await readPage(worker, image, OCR_THRESHOLDING.OTSU);
    if (first.confidence >= SAUVOLA_RETRY_BELOW_CONFIDENCE) {
        return first;
    }

    const retry = await readPage(worker, image, OCR_THRESHOLDING.SAUVOLA);
    return retry.confidence > first.confidence ? retry : first;
}

// OCR several images with one worker. Starting a worker is the slow part.
async function recognizeImages(images) {
    const worker = await createWorker("eng");

    try {
        const pages = [];
        for (const image of images) {
            pages.push(await recognizeImage(worker, image));
        }
        return pages;
    } finally {
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
        console.error("PDF text extraction failed:", error.message);

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
export async function extractTextFromScannedPdf(fileBuffer) {
    const parser = new PDFParse({ data: fileBuffer });

    let screenshots;
    try {
        screenshots = await parser.getScreenshot({
            first: MAX_SCANNED_PDF_PAGES,
            scale: SCANNED_PDF_RENDER_SCALE,
            imageBuffer: true,
            imageDataUrl: false,
        });
    } finally {
        await parser.destroy();
    }

    const pages = await recognizeImages(screenshots.pages.map((page) => Buffer.from(page.data)));
    const { text, confidence } = combinePages(pages);

    return {
        success: text.length > 0,
        text,
        method: TEXT_EXTRACTION_METHODS.PDF_OCR,
        confidence,
        pagesProcessed: pages.length,
        totalPages: screenshots.total,
        thresholding: pages.map((page) => page.thresholding),
    };
}

// Run Tesseract OCR on a JPEG/PNG image.
export async function extractTextFromImage(fileBuffer) {
    const [page] = await recognizeImages([fileBuffer]);

    return {
        success: page.text.length > 0,
        text: page.text,
        method: TEXT_EXTRACTION_METHODS.OCR,
        confidence: page.confidence,
        thresholding: page.thresholding,
    };
}

// Pick the extraction method based on MIME type.
export async function extractDocumentText({
    fileBuffer,
    mimeType,
}) {
    if (mimeType === "application/pdf") {
        const pdfResult = await extractTextFromPdf(fileBuffer);

        // A PDF that can't be parsed at all is corrupt, not scanned. OCR won't help.
        if (pdfResult.success || pdfResult.method === TEXT_EXTRACTION_METHODS.PDF_PARSE_FAILED) {
            return pdfResult;
        }

        return await extractTextFromScannedPdf(fileBuffer);
    }

    if (mimeType === "image/jpeg" || mimeType === "image/png") {
        return await extractTextFromImage(fileBuffer);
    }

    return {
        success: false,
        text: "",
        method: TEXT_EXTRACTION_METHODS.UNSUPPORTED_DOCUMENT_TYPE,
    };
}
