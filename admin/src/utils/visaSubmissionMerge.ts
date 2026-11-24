import type { PDFDocument as PdfDocument } from "pdf-lib";
import type { VisaSubmissionSlot } from "../api/candidates";

// The unsigned Visa Submission file: every VERIFIED slot document, in manifest order, merged into one
// PDF in the browser. The server never merges: a Vercel function's response size and run time are
// capped, so it only streams one document at a time. The result is only ever saved to this computer.

// A4 portrait, in PDF points: the page an image (JPEG / PNG) is placed on.
export const A4_PAGE = { width: 595.28, height: 841.89 } as const;

export const visaSubmissionFileName = (passportId: string) => `${passportId}_Visa_Submission_Unsigned.pdf`;

// A document that could not be added; `label` is the slot's (e.g. "Medical").
export class VisaMergeError extends Error {
    readonly label: string;
    constructor(label: string, reason: string) {
        super(`${label} could not be added to the visa submission file: ${reason}`);
        this.name = "VisaMergeError";
        this.label = label;
    }
}

export type MergeProgress = { current: number; total: number; label: string };

export const verifiedSlots = (slots: readonly VisaSubmissionSlot[]) =>
    [...slots].sort((a, b) => a.order - b.order).filter((slot) => slot.status === "VERIFIED" && slot.document);

function pdfFailure(error: unknown): string {
    const name = (error as Error)?.name;
    const text = (error as Error)?.message ?? "";
    if (name === "EncryptedPDFError" || /encrypt/i.test(text)) return "the PDF is password-protected or encrypted.";
    return "the PDF is damaged or not a valid PDF.";
}

// Merges the VERIFIED slots. fetchFile loads one document's bytes; the files are fetched one at a
// time (not in parallel) so only one download is in flight and memory grows by one file at a time.
// Stops at the first document that fails, naming it.
export async function mergeVisaSubmission(
    slots: readonly VisaSubmissionSlot[],
    fetchFile: (slot: VisaSubmissionSlot) => Promise<Blob>,
    onProgress?: (progress: MergeProgress) => void,
): Promise<{ bytes: Uint8Array; includedSlots: string[] }> {
    const included = verifiedSlots(slots);
    if (included.length === 0) throw new Error("No verified document to merge.");
    // Loaded on first use, so pdf-lib is a separate chunk and not part of the initial bundle.
    const { PDFDocument } = await import("pdf-lib");
    const merged = await PDFDocument.create();

    for (const [index, slot] of included.entries()) {
        onProgress?.({ current: index + 1, total: included.length, label: slot.label });
        let blob: Blob;
        try {
            blob = await fetchFile(slot);
        } catch (error) {
            throw new VisaMergeError(slot.label, (error as Error)?.message || "the file could not be downloaded.");
        }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const mimeType = (slot.document!.mimeType || blob.type).toLowerCase();
        if (mimeType === "application/pdf") await appendPdf(merged, PDFDocument, bytes, slot.label);
        else if (mimeType === "image/jpeg" || mimeType === "image/png") await appendImage(merged, bytes, mimeType, slot.label);
        else throw new VisaMergeError(slot.label, `files of type ${mimeType || "unknown"} cannot be merged.`);
    }

    return { bytes: await merged.save(), includedSlots: included.map((slot) => slot.key) };
}

async function appendPdf(merged: PdfDocument, PDFDocument: typeof PdfDocument, bytes: Uint8Array, label: string) {
    let source: PdfDocument;
    let pages;
    try {
        source = await PDFDocument.load(bytes);
        pages = await merged.copyPages(source, source.getPageIndices());
    } catch (error) {
        throw new VisaMergeError(label, pdfFailure(error));
    }
    if (pages.length === 0) throw new VisaMergeError(label, "the PDF has no pages.");
    // copyPages keeps each page's own size.
    for (const page of pages) merged.addPage(page);
}

async function appendImage(merged: PdfDocument, bytes: Uint8Array, mimeType: string, label: string) {
    let image;
    try {
        image = mimeType === "image/png" ? await merged.embedPng(bytes) : await merged.embedJpg(bytes);
    } catch {
        throw new VisaMergeError(label, "the image is damaged or not a valid image.");
    }
    const page = merged.addPage([A4_PAGE.width, A4_PAGE.height]);
    // Scaled to fit the page (never past it), aspect ratio kept, centred.
    const scale = Math.min(A4_PAGE.width / image.width, A4_PAGE.height / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    page.drawImage(image, { x: (A4_PAGE.width - width) / 2, y: (A4_PAGE.height - height) / 2, width, height });
}

// Saves the merged file to this computer (a download; the object URL is revoked once the click has started it).
export function saveVisaSubmissionPdf(bytes: Uint8Array, fileName: string): void {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
    try {
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }
}
