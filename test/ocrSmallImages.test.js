import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    extractDocumentText,
    recognizeImage,
    recognizeImageWithUpscale,
    ocrImageSize,
    upscaleImage,
    mrzEvidence,
    OcrResourceError,
    MAX_IMAGE_DIMENSION,
    MAX_IMAGE_PIXELS,
    OCR_JOB_TIMEOUT_MS,
    UPSCALE_BELOW_LONG_SIDE,
} from "../src/services/ocrService.js";
import { readImageDimensions } from "../src/utils/imageDimensions.js";
import { classifyDocumentContent } from "../src/services/documentClassificationService.js";
import { extractPassportFields } from "../src/services/passportExtractionService.js";
import { processDocument } from "../src/services/documentProcessingService.js";
import { PASSPORT_ACCEPTANCE_FLAG } from "../src/services/passportAcceptanceService.js";
import { createFakePrisma } from "./helpers/fakePrisma.js";
import { createFakeBucket } from "./helpers/fakeStorage.js";
import { loadDocumentText } from "./helpers/fixtures.js";

const loadFile = (name) => readFileSync(new URL(`./fixtures/files/${name}`, import.meta.url));
const ocrTest = process.env.RUN_OCR_TESTS === "1" ? test : test.skip;

// passport-photo-small.jpg: a synthetic passport page (fictional N1234567,
// same values as passport-mrz.txt) drawn at 380 x 520 with a background
// pattern and JPEG quality 45, like a low-quality WhatsApp photo. As in the
// real photos, the printed passport number isn't legible; the MRZ is. Read
// at its own size, OCR finds one MRZ line and no valid check digits.
const SMALL_PASSPORT = "passport-photo-small.jpg";

// Synthetic OCR texts.
const MRZ_TEXT = loadDocumentText("passport-mrz").trim(); // OCR reads are trimmed
const MRZ_LINE_2 = "N1234567<7LKA9003129M3005110<<<<<<<<<<<<<<02";
const MRZ_TEXT_BAD_DOB = MRZ_TEXT.replace(MRZ_LINE_2, MRZ_LINE_2.slice(0, 19) + "3" + MRZ_LINE_2.slice(20));
const POLICE_TEXT = "SRI LANKA POLICE\nPolice Clearance Certificate\nNo criminal records found.";

// A stand-in Tesseract worker. `reads(image, thresholding, rotateAuto)`
// returns { text, confidence } for each read; every read is recorded.
function scriptedWorker(reads) {
    const calls = [];
    let thresholding = "0";
    return {
        calls,
        async setParameters(params) {
            thresholding = params.thresholding_method;
        },
        async recognize(image, options) {
            const key = { image: image.toString(), thresholding, rotateAuto: options.rotateAuto };
            calls.push(key);
            const { text = "", confidence = 0 } = reads(key) ?? {};
            return { data: { text, confidence } };
        },
    };
}

// Default read = Otsu without rotation; the rest are the alternatives.
const isDefaultRead = ({ thresholding, rotateAuto }) => thresholding === "0" && rotateAuto === false;

describe("mrzEvidence", () => {
    test("full valid MRZ = 4; a failed check digit lowers it; no MRZ = 0", () => {
        assert.equal(mrzEvidence(MRZ_TEXT), 4);
        assert.equal(mrzEvidence(MRZ_TEXT_BAD_DOB), 3);
        assert.equal(mrzEvidence(POLICE_TEXT), 0);
        assert.equal(mrzEvidence(""), 0);
    });
});

describe("recognizeImage: candidate selection", () => {
    test("an empty read with a high reported confidence cannot win or stop the retries", async () => {
        const worker = scriptedWorker((read) =>
            isDefaultRead(read) ? { text: "", confidence: 95 } : { text: POLICE_TEXT, confidence: 60 });
        const page = await recognizeImage(worker, Buffer.from("img"));

        assert.equal(worker.calls.length, 4, "alternatives were tried");
        assert.equal(page.text, POLICE_TEXT);
        assert.equal(page.confidence, 60, "the reported confidence is kept, not changed");
    });

    test("near-empty text (a few stray characters) counts as empty", async () => {
        const worker = scriptedWorker((read) =>
            isDefaultRead(read) ? { text: " | . ~ ", confidence: 91 } : { text: POLICE_TEXT, confidence: 40 });
        const page = await recognizeImage(worker, Buffer.from("img"));
        assert.equal(page.text, POLICE_TEXT);
    });

    test("a meaningful read at >= 70 still ends the search after one read", async () => {
        const worker = scriptedWorker(() => ({ text: POLICE_TEXT, confidence: 88 }));
        await recognizeImage(worker, Buffer.from("img"));
        assert.equal(worker.calls.length, 1);
    });

    test("similar confidence: the read with more valid MRZ evidence wins", async () => {
        const worker = scriptedWorker((read) =>
            isDefaultRead(read) ? { text: MRZ_TEXT_BAD_DOB, confidence: 62 } : { text: MRZ_TEXT, confidence: 58 });
        const page = await recognizeImage(worker, Buffer.from("img"));
        assert.equal(page.text, MRZ_TEXT);
        assert.equal(page.confidence, 58);
    });

    test("similar confidence: a valid MRZ is not given up for a slightly more confident read", async () => {
        const worker = scriptedWorker((read) =>
            isDefaultRead(read) ? { text: MRZ_TEXT, confidence: 64 } : { text: MRZ_TEXT_BAD_DOB, confidence: 68 });
        const page = await recognizeImage(worker, Buffer.from("img"));
        assert.equal(page.text, MRZ_TEXT);
    });

    test("clearly higher confidence still wins (MRZ only decides between similar reads)", async () => {
        const worker = scriptedWorker((read) =>
            isDefaultRead(read) ? { text: MRZ_TEXT, confidence: 45 } : { text: MRZ_TEXT_BAD_DOB, confidence: 66 });
        const page = await recognizeImage(worker, Buffer.from("img"));
        assert.equal(page.confidence, 66);
    });

    test("police/medical text is compared by confidence only, as before", async () => {
        const higher = scriptedWorker((read) =>
            isDefaultRead(read) ? { text: POLICE_TEXT, confidence: 60 } : { text: `${POLICE_TEXT} x`, confidence: 63 });
        assert.equal((await recognizeImage(higher, Buffer.from("img"))).confidence, 63);

        const lower = scriptedWorker((read) =>
            isDefaultRead(read) ? { text: POLICE_TEXT, confidence: 60 } : { text: `${POLICE_TEXT} x`, confidence: 58 });
        assert.equal((await recognizeImage(lower, Buffer.from("img"))).confidence, 60);
    });
});

describe("ocrImageSize: which images get a 2x read", () => {
    test("long side below 1200 px -> exactly 2x, aspect ratio preserved", () => {
        for (const [width, height] of [[378, 514], [714, 936], [1199, 800], [600, 1199], [1, 1]]) {
            const size = ocrImageSize({ width, height });
            assert.deepEqual(size, { width: width * 2, height: height * 2 });
            assert.equal(size.width / size.height, width / height);
        }
    });

    test("long side 1200 px or more -> never enlarged", () => {
        for (const [width, height] of [[1200, 900], [900, 1200], [1280, 949], [4032, 3024]]) {
            assert.equal(ocrImageSize({ width, height }), null);
        }
        assert.equal(UPSCALE_BELOW_LONG_SIDE, 1200);
    });

    test("the enlarged size never exceeds the image limits", () => {
        const largest = ocrImageSize({ width: 1199, height: 1199 });
        assert.ok(largest.width <= MAX_IMAGE_DIMENSION && largest.height <= MAX_IMAGE_DIMENSION);
        assert.ok(largest.width * largest.height <= MAX_IMAGE_PIXELS);
    });
});

describe("upscaleImage", () => {
    test("a small JPEG becomes a PNG exactly twice the size", async () => {
        const jpeg = loadFile(SMALL_PASSPORT);
        const original = readImageDimensions(jpeg);
        const png = await upscaleImage(jpeg, original);
        const scaled = readImageDimensions(png);

        assert.equal(scaled.format, "png");
        assert.deepEqual({ width: scaled.width, height: scaled.height }, { width: original.width * 2, height: original.height * 2 });
    });

    test("a normal-size photo is not decoded or enlarged", async () => {
        const jpeg = loadFile("passport-photo.jpg");
        assert.equal(await upscaleImage(jpeg, readImageDimensions(jpeg)), null);
    });

    test("truncated or corrupt files don't crash the process; no 2x read (native read kept)", async () => {
        // This exact truncated PNG made the native canvas decoder segfault.
        const truncatedPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 1, 0, 8, 2, 0, 0, 0]);
        assert.equal(await upscaleImage(truncatedPng, { format: "png", width: 256, height: 256 }), null);

        // Headers intact (so the size check passes), image data cut or overwritten.
        const jpeg = loadFile(SMALL_PASSPORT);
        const dimensions = readImageDimensions(jpeg);
        assert.equal(await upscaleImage(jpeg.subarray(0, jpeg.length / 3), dimensions), null);

        const garbage = Buffer.from(jpeg);
        garbage.fill(0xab, 1000);
        assert.equal(await upscaleImage(garbage, dimensions), null);
    });

    test("a file whose decoded size differs from its header is refused", async () => {
        const jpeg = loadFile(SMALL_PASSPORT); // really 380 x 520
        await assert.rejects(upscaleImage(jpeg, { format: "jpeg", width: 100, height: 100 }),
            (error) => error instanceof OcrResourceError && error.reason === "IMAGE_UNREADABLE");
    });

    test("PNG input is decoded and enlarged too", async () => {
        const png = await upscaleImage(loadFile(SMALL_PASSPORT), readImageDimensions(loadFile(SMALL_PASSPORT))); // 760 x 1040
        const again = readImageDimensions(await upscaleImage(png, readImageDimensions(png)));
        assert.deepEqual({ width: again.width, height: again.height }, { width: 1520, height: 2080 });
    });
});

describe("recognizeImageWithUpscale", () => {
    const NATIVE = Buffer.from("NATIVE");
    const SMALL = { width: 380, height: 520 };
    const LARGE = { width: 1280, height: 949 };
    const upscaleSpy = () => {
        const spy = async () => { spy.calls += 1; return Buffer.from("UPSCALED"); };
        spy.calls = 0;
        return spy;
    };
    const byImage = (native, upscaled) => ({ image }) => (image === "NATIVE" ? native : upscaled);

    test("weak native read of a small image -> 2x read; the better one is kept", async () => {
        const upscale = upscaleSpy();
        const worker = scriptedWorker(byImage({ text: MRZ_TEXT_BAD_DOB, confidence: 39 }, { text: MRZ_TEXT, confidence: 54 }));
        const page = await recognizeImageWithUpscale(worker, NATIVE, SMALL, { upscale });

        assert.equal(upscale.calls, 1);
        assert.equal(page.upscaled, true);
        assert.equal(page.text, MRZ_TEXT);
        assert.equal(page.confidence, 54, "the 2x read's own confidence");
    });

    test("a good native read without MRZ (e.g. police photo) is never enlarged", async () => {
        const upscale = upscaleSpy();
        const worker = scriptedWorker(byImage({ text: POLICE_TEXT, confidence: 85 }, { text: POLICE_TEXT, confidence: 95 }));
        const page = await recognizeImageWithUpscale(worker, NATIVE, SMALL, { upscale });

        assert.equal(upscale.calls, 0);
        assert.equal(page.upscaled, false);
        assert.equal(page.confidence, 85);
    });

    test("a confident native read with an incomplete MRZ gets a 2x read", async () => {
        const upscale = upscaleSpy();
        const worker = scriptedWorker(byImage({ text: MRZ_TEXT_BAD_DOB, confidence: 80 }, { text: MRZ_TEXT, confidence: 60 }));
        const page = await recognizeImageWithUpscale(worker, NATIVE, SMALL, { upscale });

        assert.equal(upscale.calls, 1);
        assert.equal(page.text, MRZ_TEXT, "valid check digits beat Tesseract's confidence");
    });

    test("a native read with a valid MRZ is kept over a more confident 2x read without one", async () => {
        const worker = scriptedWorker(byImage({ text: MRZ_TEXT, confidence: 50 }, { text: POLICE_TEXT, confidence: 90 }));
        const page = await recognizeImageWithUpscale(worker, NATIVE, SMALL, { upscale: upscaleSpy() });
        assert.equal(page.text, MRZ_TEXT);
        assert.equal(page.upscaled, false);
    });

    test("weak police/medical read: the 2x read wins only on confidence", async () => {
        const better = scriptedWorker(byImage({ text: POLICE_TEXT, confidence: 50 }, { text: POLICE_TEXT, confidence: 65 }));
        assert.equal((await recognizeImageWithUpscale(better, NATIVE, SMALL, { upscale: upscaleSpy() })).upscaled, true);

        const worse = scriptedWorker(byImage({ text: POLICE_TEXT, confidence: 50 }, { text: POLICE_TEXT, confidence: 45 }));
        assert.equal((await recognizeImageWithUpscale(worse, NATIVE, SMALL, { upscale: upscaleSpy() })).upscaled, false);
    });

    test("large images are never enlarged, however weak the read", async () => {
        const upscale = upscaleSpy();
        const worker = scriptedWorker(() => ({ text: "", confidence: 0 }));
        await recognizeImageWithUpscale(worker, NATIVE, LARGE, { upscale });
        assert.equal(upscale.calls, 0);
    });

    test("if the image can't be enlarged, the native read is used", async () => {
        const worker = scriptedWorker(() => ({ text: POLICE_TEXT, confidence: 40 }));
        const page = await recognizeImageWithUpscale(worker, NATIVE, SMALL, { upscale: async () => null });
        assert.equal(page.upscaled, false);
        assert.equal(page.confidence, 40);
    });

    test("resource limits are checked before anything is decoded or OCR'd", async () => {
        const upscale = upscaleSpy();
        let workersCreated = 0;
        const createOcrWorker = async () => { workersCreated += 1; return scriptedWorker(() => ({})); };
        const oversized = Buffer.alloc(33);
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversized, 0);
        oversized.writeUInt32BE(13, 8);
        oversized.write("IHDR", 12, "ascii");
        oversized.writeUInt32BE(30_000, 16);
        oversized.writeUInt32BE(30_000, 20);

        await assert.rejects(
            extractDocumentText({ fileBuffer: oversized, mimeType: "image/png" }, { createOcrWorker, upscale }),
            (error) => error.reason === "IMAGE_TOO_LARGE");
        assert.equal(upscale.calls, 0);
        assert.equal(workersCreated, 0);
    });
});

describe("small passport photo (real OCR, synthetic fixture)", () => {
    ocrTest("380 x 520 low-quality passport JPEG: 2x read finds both MRZ lines with valid check digits", async () => {
        const started = Date.now();
        const result = await extractDocumentText({ fileBuffer: loadFile(SMALL_PASSPORT), mimeType: "image/jpeg" });
        const elapsedMs = Date.now() - started;
        const passport = extractPassportFields(result.text);

        assert.equal(result.upscaled, true);
        assert.equal(classifyDocumentContent(result.text).documentType, "PASSPORT");
        assert.equal(passport.mrz.linesFound, 2);
        assert.equal(passport.fields.passportId.value, "N1234567");
        for (const field of ["passportId", "dateOfBirth", "passportExpiryDate"]) {
            assert.equal(passport.fields[field].source, "MRZ", field);
            assert.equal(passport.fields[field].checkDigitValid, true, field);
        }
        assert.ok(result.confidence < 60, `the low measured confidence is kept (${result.confidence})`);
        assert.ok(elapsedMs < OCR_JOB_TIMEOUT_MS / 4, `OCR took ${elapsedMs} ms`);
    });

    ocrTest("normal photos keep today's single read (not enlarged)", async () => {
        for (const [name, mimeType] of [["passport-photo.jpg", "image/jpeg"], ["police-photo-harsh.jpg", "image/jpeg"], ["police-photo-hard.jpg", "image/jpeg"], ["image-medical.png", "image/png"]]) {
            const result = await extractDocumentText({ fileBuffer: loadFile(name), mimeType });
            assert.equal(result.upscaled, false, name);
        }
    });
});

describe("small passport photo through the pipeline (real OCR)", () => {
    const TEMP_PATH = "temporary/tmp-small.jpeg";
    const users = () => [
        {
            passportId: "N1234567", uniqueId: "0001", whatsappNumber: "0771234567",
            firstName: "KAMAL NIMAL", otherName: "PERERA",
            dateOfBirth: new Date("1990-03-12T00:00:00Z"),
            passportExpiryDate: new Date("2030-05-11T00:00:00Z"),
            placeOfBirth: null,
        },
    ];

    async function run({ extractText } = {}) {
        const db = createFakePrisma(users());
        const bucket = createFakeBucket([TEMP_PATH]);
        const { summary } = await processDocument({
            temporaryId: "tmp-small",
            whatsappNumber: "94771234567",
            fileName: null,
            mimeType: "image/jpeg",
            fileBuffer: loadFile(SMALL_PASSPORT),
            temporaryStoragePath: TEMP_PATH,
            deps: { db, bucket, now: new Date("2026-09-25T08:00:00Z"), ...(extractText ? { extractText } : {}) },
        });
        return { summary, db, objects: [...bucket.objects.keys()] };
    }

    ocrTest("matching client -> accepted for review in the client folder, real confidence kept", async () => {
        const { summary, db, objects } = await run();

        assert.equal(summary.documentType, "PASSPORT");
        assert.equal(summary.ocrUpscaled, true);
        assert.equal(summary.passport.mrzLinesFound, 2);
        assert.equal(summary.passport.passportIdBand, "VERIFIED");
        assert.equal(summary.identity.status, "VERIFIED_MATCH");
        assert.equal(summary.confidence.document, Math.min(summary.confidence.extraction, summary.confidence.classification));
        assert.ok(summary.confidence.document < 60, `measured ${summary.confidence.document}`);
        assert.ok(summary.confidence.flags.includes(PASSPORT_ACCEPTANCE_FLAG));
        assert.equal(summary.storage.placement, "CLIENT");
        assert.equal(summary.storage.verificationStatus, "REVIEW_REQUIRED");
        assert.equal(summary.storage.documentStored, true);
        assert.ok(objects.some((path) => path.startsWith("clients/N1234567/passport/")));
        assert.equal(db.documentRows[0].verificationStatus, "REVIEW_REQUIRED");
    });

    // The real OCR read of the photo, with the MRZ date-of-birth check digit changed.
    async function tamperedRead() {
        const real = await extractDocumentText({ fileBuffer: loadFile(SMALL_PASSPORT), mimeType: "image/jpeg" });
        const text = real.text.replace(/(LKA\d{6})\d/, (match, head) => `${head}${(Number(match.at(-1)) + 1) % 10}`);
        assert.notEqual(text, real.text);
        return { ...real, text };
    }

    ocrTest("DOB check digit fails at company-photo confidence (~34, UNDEFINED) -> not accepted, stays pending", async () => {
        // 34 is what the real low-quality WhatsApp passport photos measured.
        const read = { ...(await tamperedRead()), confidence: 34 };
        const { summary, objects, db } = await run({ extractText: async () => read });

        assert.ok(!summary.confidence.flags.includes(PASSPORT_ACCEPTANCE_FLAG));
        assert.deepEqual(summary.passportAcceptance.failedConditions, ["DATE_OF_BIRTH_VERIFIED"]);
        assert.equal(summary.processingStatus, "UNDEFINED");
        assert.equal(summary.storage.placement, "PENDING");
        assert.ok(!objects.some((path) => path.startsWith("clients/")));
        assert.equal(db.documentRows.length, 0);
    });

    ocrTest("DOB check digit fails at confidence 40-59 (UNCLEAR) -> not accepted; existing UNCLEAR rule: review only, never VERIFIED", async () => {
        const { summary } = await run({ extractText: async () => tamperedRead() });

        assert.ok(!summary.confidence.flags.includes(PASSPORT_ACCEPTANCE_FLAG));
        assert.equal(summary.confidence.band, "UNCLEAR");
        assert.equal(summary.storage.verificationStatus, "REVIEW_REQUIRED");
    });
});
