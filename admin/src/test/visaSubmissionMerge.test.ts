import { PDFDocument, PDFPage } from "pdf-lib";
import { describe, expect, test, vi } from "vitest";
import type { VisaSubmissionSlot } from "../api/candidates";
import { A4_PAGE, VisaMergeError, mergeVisaSubmission, visaSubmissionFileName } from "../utils/visaSubmissionMerge";

// The browser-side merge of the unsigned Visa Submission file. Synthetic documents only, built here.

// A 1x1 PNG.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
// A minimal 1x1 JPEG.
const JPEG = Uint8Array.from(atob("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="), (c) => c.charCodeAt(0));

async function pdfWithPages(sizes: [number, number][]): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    for (const size of sizes) pdf.addPage(size);
    return pdf.save();
}

let ids = 0;
function slot(order: number, key: string, label: string, status: VisaSubmissionSlot["status"], mimeType = "application/pdf"): VisaSubmissionSlot {
    const documentId = `doc-${++ids}`;
    return {
        order, key, label, documentType: "MEDICAL", variant: null, status,
        document: status === "VERIFIED" ? { documentId, mimeType, size: 100, fileUrl: `/files/${documentId}` } : null,
    };
}

const fetcherFor = (files: Record<string, Uint8Array>) => vi.fn(async (s: VisaSubmissionSlot) => new Blob([files[s.key] as BlobPart], { type: s.document!.mimeType }));

describe("mergeVisaSubmission", () => {
    test("merges the VERIFIED documents in manifest slot order, every page at its own size; skips the others", async () => {
        const passport = slot(1, "PASSPORT", "Passport", "VERIFIED");
        const romania = slot(4, "ROMANIA_POLICE_REPORT", "Romania Police Report", "UNVERIFIED");
        const medical = slot(5, "MEDICAL", "Medical", "VERIFIED");
        const scan = slot(6, "SCAN", "Scan", "MISSING");
        const fetchFile = fetcherFor({
            PASSPORT: await pdfWithPages([[300, 400]]),
            MEDICAL: await pdfWithPages([[500, 600], [612, 792]]),
        });
        const progress = vi.fn();
        // Given out of order: the slot order decides.
        const { bytes, includedSlots } = await mergeVisaSubmission([scan, medical, romania, passport], fetchFile, progress);

        expect(includedSlots).toEqual(["PASSPORT", "MEDICAL"]);
        expect(fetchFile.mock.calls.map(([s]) => s.key)).toEqual(["PASSPORT", "MEDICAL"]);
        expect(progress.mock.calls.map(([p]) => p)).toEqual([
            { current: 1, total: 2, label: "Passport" },
            { current: 2, total: 2, label: "Medical" },
        ]);
        const merged = await PDFDocument.load(bytes);
        expect(merged.getPages().map((p) => [p.getWidth(), p.getHeight()])).toEqual([[300, 400], [500, 600], [612, 792]]);
    });

    test("an image is placed on its own A4 page, scaled to fit with its aspect ratio kept, centred", async () => {
        const draw = vi.spyOn(PDFPage.prototype, "drawImage");
        const { bytes } = await mergeVisaSubmission([slot(6, "SCAN", "Scan", "VERIFIED", "image/png")], fetcherFor({ SCAN: PNG }));
        const merged = await PDFDocument.load(bytes);
        expect(merged.getPageCount()).toBe(1);
        const page = merged.getPage(0);
        expect(page.getWidth()).toBeCloseTo(A4_PAGE.width, 2);
        expect(page.getHeight()).toBeCloseTo(A4_PAGE.height, 2);
        // A 1x1 image: as wide as the page, square, vertically centred.
        const options = draw.mock.calls[0][1]!;
        expect(options.width).toBeCloseTo(A4_PAGE.width, 2);
        expect(options.height).toBeCloseTo(A4_PAGE.width, 2);
        expect(options.x).toBeCloseTo(0, 2);
        expect(options.y).toBeCloseTo((A4_PAGE.height - A4_PAGE.width) / 2, 2);
    });

    test("a JPEG is embedded on an A4 page too, between PDF pages in slot order", async () => {
        const { bytes } = await mergeVisaSubmission(
            [slot(1, "PASSPORT", "Passport", "VERIFIED", "image/jpeg"), slot(5, "MEDICAL", "Medical", "VERIFIED")],
            fetcherFor({ PASSPORT: JPEG, MEDICAL: await pdfWithPages([[300, 400]]) }),
        );
        const merged = await PDFDocument.load(bytes);
        expect(merged.getPages().map((p) => Math.round(p.getHeight()))).toEqual([Math.round(A4_PAGE.height), 400]);
    });

    test("a damaged image stops the merge, naming the document", async () => {
        await expect(mergeVisaSubmission([slot(6, "SCAN", "Scan", "VERIFIED", "image/png")], fetcherFor({ SCAN: new TextEncoder().encode("not a png") })))
            .rejects.toMatchObject({ label: "Scan", message: expect.stringMatching(/^Scan could not be added.*image/) });
    });

    test("a damaged PDF stops the merge with an error naming that document; later documents are not fetched", async () => {
        const fetchFile = fetcherFor({ PASSPORT: await pdfWithPages([[300, 400]]), MEDICAL: new TextEncoder().encode("not a pdf at all"), SCAN: await pdfWithPages([[300, 400]]) });
        const run = mergeVisaSubmission([slot(1, "PASSPORT", "Passport", "VERIFIED"), slot(5, "MEDICAL", "Medical", "VERIFIED"), slot(6, "SCAN", "Scan", "VERIFIED")], fetchFile);
        await expect(run).rejects.toBeInstanceOf(VisaMergeError);
        await expect(run).rejects.toMatchObject({ label: "Medical", message: expect.stringMatching(/^Medical could not be added.*damaged/) });
        expect(fetchFile).toHaveBeenCalledTimes(2);
    });

    test("a password-protected (encrypted) PDF is refused, naming the document", async () => {
        const pdf = await PDFDocument.create();
        pdf.addPage([300, 400]);
        pdf.context.trailerInfo.Encrypt = pdf.context.register(pdf.context.obj({ Filter: "Standard" }));
        const encrypted = await pdf.save();
        await expect(mergeVisaSubmission([slot(5, "MEDICAL", "Medical", "VERIFIED")], fetcherFor({ MEDICAL: encrypted })))
            .rejects.toMatchObject({ label: "Medical", message: expect.stringMatching(/password-protected or encrypted/) });
    });

    test("a document that cannot be fetched stops the merge, naming it", async () => {
        const fetchFile = vi.fn(async () => { throw new Error("The file could not be loaded from storage"); });
        await expect(mergeVisaSubmission([slot(2, "SL_NORMAL_POLICE_REPORT", "SL Normal Police Report", "VERIFIED")], fetchFile))
            .rejects.toMatchObject({ label: "SL Normal Police Report", message: expect.stringContaining("could not be loaded from storage") });
    });

    test("nothing verified: refused; and the merge itself never sends anything anywhere", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        await expect(mergeVisaSubmission([slot(5, "MEDICAL", "Medical", "MISSING")], vi.fn())).rejects.toThrow(/No verified document/);
        await mergeVisaSubmission([slot(5, "MEDICAL", "Medical", "VERIFIED")], fetcherFor({ MEDICAL: await pdfWithPages([[300, 400]]) }));
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test("the download file name", () => {
        expect(visaSubmissionFileName("N0000002")).toBe("N0000002_Visa_Submission_Unsigned.pdf");
    });
});
