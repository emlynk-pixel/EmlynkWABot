import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    extractDocumentText,
    assertImageWithinLimits,
    ocrJobLimiter,
    OcrResourceError,
    MAX_PDF_PAGES,
    MAX_IMAGE_DIMENSION,
    MAX_IMAGE_PIXELS,
    MAX_CONCURRENT_OCR_JOBS,
    MAX_WAITING_OCR_JOBS,
    OCR_JOB_TIMEOUT_MS,
    TEXT_EXTRACTION_METHODS,
} from "../src/services/ocrService.js";
import { readImageDimensions } from "../src/utils/imageDimensions.js";
import { createConcurrencyLimiter, LimiterBusyError } from "../src/utils/concurrencyLimiter.js";
import { processDocument } from "../src/services/documentProcessingService.js";
import { createFakePrisma } from "./helpers/fakePrisma.js";
import { createFakeBucket } from "./helpers/fakeStorage.js";

const loadFile = (name) => readFileSync(new URL(`./fixtures/files/${name}`, import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Header-only images: enough for the size check, never decoded. A 30000 x
// 30000 "image" here is 33 bytes, like a real decompression bomb's header.
function pngHeader(width, height) {
    const buffer = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
    buffer.writeUInt32BE(13, 8);
    buffer.write("IHDR", 12, "ascii");
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer;
}

function jpegHeader(width, height) {
    const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
    const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
    return Buffer.from([0xff, 0xd8, ...app0, ...sof0]);
}

// Stand-in for a Tesseract worker. Records how many exist at once.
function fakeOcr({ delayMs = 0, hang = false, text = "synthetic words" } = {}) {
    const stats = { created: 0, terminated: 0, alive: 0, peakAlive: 0 };
    const createOcrWorker = async () => {
        stats.created += 1;
        stats.alive += 1;
        stats.peakAlive = Math.max(stats.peakAlive, stats.alive);
        let stopHang;
        return {
            async setParameters() {},
            async recognize() {
                if (hang) return new Promise((_, reject) => { stopHang = reject; });
                await sleep(delayMs);
                return { data: { text, confidence: 95 } };
            },
            async terminate() {
                stats.terminated += 1;
                stats.alive -= 1;
                stopHang?.(new Error("worker terminated"));
            },
        };
    };
    return { createOcrWorker, stats };
}

const rejectsWithReason = (promise, reason) =>
    assert.rejects(promise, (error) => error instanceof OcrResourceError && error.reason === reason);

describe("limit values", () => {
    test("named limits are set to the intended values", () => {
        assert.equal(MAX_PDF_PAGES, 20);
        assert.equal(MAX_IMAGE_DIMENSION, 12_000);
        assert.equal(MAX_IMAGE_PIXELS, 50_000_000);
        assert.equal(MAX_CONCURRENT_OCR_JOBS, 2);
        assert.equal(MAX_WAITING_OCR_JOBS, 10);
        assert.equal(OCR_JOB_TIMEOUT_MS, 120_000);
    });
});

describe("readImageDimensions (header only)", () => {
    test("real PNG and JPEG fixtures", () => {
        assert.deepEqual(readImageDimensions(loadFile("image-medical.png")), { format: "png", width: 1240, height: 700 });
        assert.deepEqual(readImageDimensions(loadFile("passport-photo.jpg")), { format: "jpeg", width: 1280, height: 949 });
    });

    test("synthetic headers", () => {
        assert.deepEqual(readImageDimensions(pngHeader(4000, 3000)), { format: "png", width: 4000, height: 3000 });
        assert.deepEqual(readImageDimensions(jpegHeader(4000, 3000)), { format: "jpeg", width: 4000, height: 3000 });
    });

    test("format comes from the bytes, not a label", () => {
        // A PNG sent as image/jpeg is still measured as a PNG.
        assert.equal(readImageDimensions(pngHeader(10, 10)).format, "png");
    });

    test("unknown, truncated or zero-sized images -> null", () => {
        const cases = [
            Buffer.from("GIF89a...."),
            Buffer.from([0x42, 0x4d, 0, 0, 0, 0]),          // BMP
            Buffer.from([0x49, 0x49, 0x2a, 0x00]),          // TIFF
            Buffer.from("plain text, not an image"),
            pngHeader(10, 10).subarray(0, 20),              // truncated
            pngHeader(0, 100),
            Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]), // JPEG data with no frame header
            Buffer.alloc(0),
        ];
        for (const buffer of cases) assert.equal(readImageDimensions(buffer), null);
    });
});

describe("image size limit", () => {
    test("1. normal-size images are allowed", () => {
        for (const file of ["image-medical.png", "passport-photo.jpg", "police-photo-hard.jpg"]) {
            assert.doesNotThrow(() => assertImageWithinLimits(loadFile(file)), file);
        }
        assert.doesNotThrow(() => assertImageWithinLimits(jpegHeader(8160, 6120))); // 50 MP phone photo
    });

    test("2. images exactly at the limits are allowed", () => {
        assert.doesNotThrow(() => assertImageWithinLimits(pngHeader(10_000, 5_000)));   // exactly 50,000,000 px
        assert.doesNotThrow(() => assertImageWithinLimits(pngHeader(12_000, 4_000)));   // longest side exactly 12,000
    });

    test("3. images above the limits are rejected", () => {
        assert.throws(() => assertImageWithinLimits(pngHeader(10_001, 5_000)), (e) => e.reason === "IMAGE_TOO_LARGE");
        assert.throws(() => assertImageWithinLimits(pngHeader(12_001, 100)), (e) => e.reason === "IMAGE_TOO_LARGE");
        assert.throws(() => assertImageWithinLimits(pngHeader(30_000, 30_000)), (e) => e.reason === "IMAGE_TOO_LARGE");
        assert.throws(() => assertImageWithinLimits(jpegHeader(65_000, 65_000)), (e) => e.reason === "IMAGE_TOO_LARGE");
    });

    test("3b. an oversized image is rejected before any OCR worker exists", async () => {
        const ocr = fakeOcr();
        await rejectsWithReason(
            extractDocumentText({ fileBuffer: pngHeader(30_000, 30_000), mimeType: "image/png" }, ocr),
            "IMAGE_TOO_LARGE"
        );
        assert.equal(ocr.stats.created, 0);
    });

    test("a huge PNG disguised as image/jpeg is still caught", async () => {
        const ocr = fakeOcr();
        await rejectsWithReason(
            extractDocumentText({ fileBuffer: pngHeader(30_000, 30_000), mimeType: "image/jpeg" }, ocr),
            "IMAGE_TOO_LARGE"
        );
        assert.equal(ocr.stats.created, 0);
    });

    test("content that isn't a readable PNG/JPEG is not handed to OCR", async () => {
        const ocr = fakeOcr();
        await rejectsWithReason(
            extractDocumentText({ fileBuffer: Buffer.from([0x49, 0x49, 0x2a, 0x00, 1, 2, 3]), mimeType: "image/jpeg" }, ocr),
            "IMAGE_UNREADABLE"
        );
        assert.equal(ocr.stats.created, 0);
    });

    test("an image at the boundary goes through to OCR", async () => {
        const ocr = fakeOcr();
        const result = await extractDocumentText({ fileBuffer: pngHeader(10_000, 5_000), mimeType: "image/png" }, ocr);

        assert.equal(result.method, TEXT_EXTRACTION_METHODS.OCR);
        assert.equal(result.text, "synthetic words");
        assert.equal(ocr.stats.created, 1);
        assert.equal(ocr.stats.terminated, 1);
    });
});

describe("PDF limits", () => {
    test("4. normal text PDF is allowed", async () => {
        const result = await extractDocumentText({ fileBuffer: loadFile("text-passport.pdf"), mimeType: "application/pdf" });

        assert.equal(result.method, TEXT_EXTRACTION_METHODS.PDF_TEXT);
        assert.equal(result.success, true);
    });

    test("5. PDF above the page limit is rejected before its text is read", async () => {
        const ocr = fakeOcr();
        await rejectsWithReason(
            extractDocumentText({ fileBuffer: loadFile("many-pages.pdf"), mimeType: "application/pdf" }, ocr),
            "PDF_TOO_MANY_PAGES"
        );
        assert.equal(ocr.stats.created, 0);
    });

    test("a scanned page too large to render is rejected before rendering", async () => {
        const ocr = fakeOcr();
        await rejectsWithReason(
            extractDocumentText({ fileBuffer: loadFile("huge-page.pdf"), mimeType: "application/pdf" }, ocr),
            "PDF_PAGE_TOO_LARGE"
        );
        assert.equal(ocr.stats.created, 0);
    });

    test("6. scanned PDF still OCRs only its first 3 pages", async () => {
        const ocr = fakeOcr();
        const result = await extractDocumentText({ fileBuffer: loadFile("scanned-five-pages.pdf"), mimeType: "application/pdf" }, ocr);

        assert.equal(result.method, TEXT_EXTRACTION_METHODS.PDF_OCR);
        assert.equal(result.totalPages, 5);
        assert.equal(result.pagesProcessed, 3);
    });

    test("a corrupt PDF is still reported as PDF_PARSE_FAILED (unchanged)", async () => {
        const result = await extractDocumentText({ fileBuffer: loadFile("corrupt.pdf"), mimeType: "application/pdf" });
        assert.equal(result.method, TEXT_EXTRACTION_METHODS.PDF_PARSE_FAILED);
    });
});

describe("concurrency limiter", () => {
    test("never runs more than maxConcurrent tasks; the rest wait their turn", async () => {
        const limiter = createConcurrencyLimiter({ maxConcurrent: 2, maxWaiting: 10, waitTimeoutMs: 1_000 });
        let running = 0;
        let peak = 0;
        const order = [];

        await Promise.all([1, 2, 3, 4, 5].map((id) => limiter.run(async () => {
            running += 1;
            peak = Math.max(peak, running);
            await sleep(20);
            order.push(id);
            running -= 1;
        })));

        assert.equal(peak, 2);
        assert.deepEqual(order.slice(2), [3, 4, 5], "waiting tasks start first-come, first-served");
    });

    test("a full queue is refused immediately", async () => {
        const limiter = createConcurrencyLimiter({ maxConcurrent: 1, maxWaiting: 1, waitTimeoutMs: 1_000 });
        const slow = () => limiter.run(() => sleep(50));

        const first = slow();
        const second = slow();
        await assert.rejects(slow(), (e) => e instanceof LimiterBusyError && e.reason === "QUEUE_FULL");
        await Promise.all([first, second]);
    });

    test("waiting too long is refused", async () => {
        const limiter = createConcurrencyLimiter({ maxConcurrent: 1, maxWaiting: 5, waitTimeoutMs: 20 });
        const blocker = limiter.run(() => sleep(100));

        await assert.rejects(limiter.run(async () => "never"), (e) => e.reason === "WAIT_TIMEOUT");
        await blocker;
        assert.equal(limiter.waiting, 0);
    });

    test("a failing task frees its slot", async () => {
        const limiter = createConcurrencyLimiter({ maxConcurrent: 1, maxWaiting: 1, waitTimeoutMs: 1_000 });
        await assert.rejects(limiter.run(async () => { throw new Error("task failed"); }));

        assert.equal(await limiter.run(async () => "ok"), "ok");
        assert.equal(limiter.active, 0);
    });
});

describe("OCR concurrency and timeout in the real pipeline", () => {
    test("7. concurrent OCR jobs never exceed MAX_CONCURRENT_OCR_JOBS", async () => {
        const ocr = fakeOcr({ delayMs: 30 });
        const jobs = Array.from({ length: 6 }, () =>
            extractDocumentText({ fileBuffer: pngHeader(1000, 800), mimeType: "image/png" }, ocr));

        const results = await Promise.all(jobs);
        assert.equal(results.length, 6);
        assert.equal(ocr.stats.peakAlive, MAX_CONCURRENT_OCR_JOBS);
        assert.ok(ocrJobLimiter.peakActive <= MAX_CONCURRENT_OCR_JOBS);
        assert.equal(ocrJobLimiter.active, 0);
    });

    test("8. beyond the running + waiting capacity, a request fails safely with OCR_BUSY", async () => {
        const ocr = fakeOcr({ delayMs: 100 });
        const image = { fileBuffer: pngHeader(1000, 800), mimeType: "image/png" };

        const accepted = Array.from({ length: MAX_CONCURRENT_OCR_JOBS + MAX_WAITING_OCR_JOBS }, () =>
            extractDocumentText(image, ocr));
        await sleep(10); // let the first jobs take their slots

        await rejectsWithReason(extractDocumentText(image, ocr), "OCR_BUSY");
        const results = await Promise.all(accepted);
        assert.equal(results.length, 12, "every accepted job still completes");
        assert.equal(ocr.stats.peakAlive, MAX_CONCURRENT_OCR_JOBS);
    });

    test("OCR that runs too long is stopped with OCR_TIMEOUT and the worker is terminated", async () => {
        const ocr = fakeOcr({ hang: true });

        await rejectsWithReason(
            extractDocumentText({ fileBuffer: pngHeader(1000, 800), mimeType: "image/png" }, { ...ocr, timeoutMs: 50 }),
            "OCR_TIMEOUT"
        );
        assert.equal(ocr.stats.terminated, 1);
        assert.equal(ocrJobLimiter.active, 0, "the slot is freed after a timeout");
    });
});

describe("9. resource-limit errors carry no document data", () => {
    test("messages are only the reason code", async () => {
        const errors = [];
        const capture = (promise) => promise.catch((error) => errors.push(error));

        await capture(extractDocumentText({ fileBuffer: pngHeader(30_000, 30_000), mimeType: "image/png" }));
        await capture(extractDocumentText({ fileBuffer: loadFile("many-pages.pdf"), mimeType: "application/pdf" }));
        await capture(extractDocumentText({ fileBuffer: loadFile("huge-page.pdf"), mimeType: "application/pdf" }));

        assert.equal(errors.length, 3);
        for (const error of errors) {
            assert.match(error.message, /^OCR resource limit: [A-Z_]+$/);
            assert.doesNotMatch(error.message, /Synthetic filler|page \d|\.pdf|\\|\//);
        }
    });

    test("processDocument records a refusal as FAILED at TEXT_EXTRACTION with the reason only", async () => {
        const db = createFakePrisma([]);
        const { summary } = await processDocument({
            temporaryId: "tmp-limit",
            whatsappNumber: "94770000000",
            fileName: "Synthetic Person passport.png",
            mimeType: "image/png",
            fileBuffer: pngHeader(30_000, 30_000),
            temporaryStoragePath: "temporary/tmp-limit.png",
            deps: { db, bucket: createFakeBucket(["temporary/tmp-limit.png"]) },
        });

        assert.equal(summary.processingStatus, "FAILED");
        assert.equal(summary.stage, "TEXT_EXTRACTION");
        assert.equal(summary.error, "OCR resource limit: IMAGE_TOO_LARGE");
        assert.ok(!JSON.stringify(summary).includes("Synthetic Person"));
        const { processingSummary, reviewReason, ...status } = db.calls.at(-1).data;
        assert.deepEqual(status, { processingStatus: "FAILED" });
        assert.equal(reviewReason, "PROCESSING_FAILED");
        assert.equal(processingSummary.error, "OCR resource limit: IMAGE_TOO_LARGE");
        assert.ok(!JSON.stringify(processingSummary).includes("Synthetic Person"), "stored summary has no file name");
    });
});
