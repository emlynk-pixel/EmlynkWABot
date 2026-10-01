import { describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

import { ocrServiceUrl } from "./helpers/localOcrService.js";
import { extractDocumentText } from "../src/services/ocrClient.js";
import { TEXT_EXTRACTION_METHODS } from "../src/services/ocrContract.js";
import { classifyDocumentContent } from "../src/services/documentClassificationService.js";
import { extractPassportFields } from "../src/services/passportExtractionService.js";
import { processDocument } from "../src/services/documentProcessingService.js";
import { PASSPORT_ACCEPTANCE_FLAG } from "../src/services/passportAcceptanceService.js";
import { mrzEvidence, OCR_JOB_TIMEOUT_MS, OCR_RETRY_BELOW_CONFIDENCE } from "../ocr-worker/src/ocrService.js";
import { createFakePrisma } from "./helpers/fakePrisma.js";
import { createFakeBucket } from "./helpers/fakeStorage.js";

// The pipeline on real text extraction: the backend's OCR client, over HTTP,
// to the OCR service running locally (helpers/localOcrService.js).
// Tesseract takes a few seconds per page, so real OCR tests are opt-in:
//   RUN_OCR_TESTS=1 npm test
// Synthetic data only.
const loadFile = (name) => readFileSync(new URL(`./fixtures/files/${name}`, import.meta.url));
const ocrTest = process.env.RUN_OCR_TESTS === "1" ? test : test.skip;
const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const mimeOf = (name) => (name.endsWith(".png") ? "image/png" : name.endsWith(".pdf") ? "application/pdf" : "image/jpeg");
const extractFile = (name) => extractDocumentText({ fileBuffer: loadFile(name), mimeType: mimeOf(name) });

function pngHeader(width, height) {
    const buffer = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
    buffer.writeUInt32BE(13, 8);
    buffer.write("IHDR", 12, "ascii");
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer;
}

// Rotates an image clockwise pixel by pixel (pngjs / jpeg-js only),
// independent of the code under test, and returns a PNG.
function turnImage(buffer, degrees) {
    const src = buffer[0] === 0x89 ? PNG.sync.read(buffer) : jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
    const { width: w, height: h, data } = src;
    const sideways = degrees % 180 !== 0;
    const out = new PNG({ width: sideways ? h : w, height: sideways ? w : h });
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const [nx, ny] = {
                0: [x, y],
                90: [h - 1 - y, x],
                180: [w - 1 - x, h - 1 - y],
                270: [y, w - 1 - x],
            }[degrees];
            const s = (y * w + x) * 4;
            const d = (ny * out.width + nx) * 4;
            out.data[d] = data[s]; out.data[d + 1] = data[s + 1]; out.data[d + 2] = data[s + 2]; out.data[d + 3] = 255;
        }
    }
    return PNG.sync.write(out);
}

describe("text extraction through the OCR service", () => {
    test("the backend uses the local OCR service over HTTP", () => {
        assert.equal(process.env.OCR_SERVICE_URL, ocrServiceUrl);
        assert.match(ocrServiceUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    });

    test("a text PDF is read from its text layer", async () => {
        const result = await extractFile("text-passport.pdf");
        assert.equal(result.method, TEXT_EXTRACTION_METHODS.PDF_TEXT);
        assert.equal(result.success, true);
        assert.match(result.text, /Passport No N1234567/);
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

describe("real OCR, classified (RUN_OCR_TESTS=1)", () => {
    ocrTest("scanned PDF falls back to OCR and can be classified", async () => {
        const result = await extractFile("scanned-police.pdf");

        assert.equal(result.method, TEXT_EXTRACTION_METHODS.PDF_OCR);
        assert.equal(result.success, true);
        assert.equal(result.pagesProcessed, 1);
        assert.ok(result.confidence > 60);
        assert.equal(classifyDocumentContent(result.text).documentType, "POLICE_REPORT");
    });

    ocrTest("image OCR reads a medical report", async () => {
        const result = await extractFile("image-medical.png");

        assert.equal(result.method, TEXT_EXTRACTION_METHODS.OCR);
        assert.equal(result.success, true);
        assert.ok(result.confidence > 60);
        assert.equal(classifyDocumentContent(result.text).documentType, "MEDICAL");
    });

    ocrTest("harsh police certificate photo (tilt, shadow, blur, WhatsApp compression) is classified", async () => {
        const result = await extractFile("police-photo-harsh.jpg");
        const classification = classifyDocumentContent(result.text);

        assert.equal(classification.documentType, "POLICE_REPORT");
        // The old default settings read this photo at about 63.
        assert.ok(result.confidence >= OCR_RETRY_BELOW_CONFIDENCE, `confidence ${result.confidence}`);
        assert.ok(classification.indicators.includes("police_clearance"));
    });

    ocrTest("typical police certificate photo is classified", async () => {
        const result = await extractFile("police-photo-hard.jpg");

        assert.equal(classifyDocumentContent(result.text).documentType, "POLICE_REPORT");
        assert.ok(result.confidence > 85, `confidence ${result.confidence}`);
    });

    ocrTest("passport photo still reads the MRZ with valid check digits", async () => {
        const result = await extractFile("passport-photo.jpg");
        const passport = extractPassportFields(result.text);

        assert.equal(classifyDocumentContent(result.text).documentType, "PASSPORT");
        assert.equal(passport.status, "COMPLETE");
        assert.equal(passport.mrz.linesFound, 2);
        assert.equal(passport.mrz.compositeCheckValid, true);
        assert.equal(passport.fields.passportId.value, "N1234567");
    });

    ocrTest("380 x 520 low-quality passport JPEG: 2x read finds both MRZ lines with valid check digits", async () => {
        const started = Date.now();
        const result = await extractFile("passport-photo-small.jpg");
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
});

describe("small passport photo through the pipeline (real OCR)", () => {
    const SMALL_PASSPORT = "passport-photo-small.jpg";
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
        const real = await extractFile(SMALL_PASSPORT);
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

describe("OCR orientation with real Tesseract (RUN_OCR_TESTS=1)", () => {
    const cases = [
        ["passport-photo.jpg", "PASSPORT"],
        ["image-medical.png", "MEDICAL"],
        ["police-photo-hard.jpg", "POLICE_REPORT"],
    ];
    for (const [file, type] of cases) {
        for (const received of [0, 90, 180, 270]) {
            ocrTest(`${file} received at ${received}° -> ${type}, same read as upright`, async () => {
                const result = received === 0
                    ? await extractFile(file)
                    : await extractDocumentText({ fileBuffer: turnImage(loadFile(file), received), mimeType: "image/png" });
                assert.equal(classifyDocumentContent(result.text).documentType, type);
                assert.equal(result.rotation, (360 - received) % 360);
                assert.ok(result.confidence >= 80, `confidence ${result.confidence}`);
                if (type === "PASSPORT") assert.equal(mrzEvidence(result.text), 4);
            });
        }
    }

    ocrTest("pipeline: a passport photo received at 90° is stored as VERIFIED; the stored file is the received file, unchanged", async () => {
        const received = turnImage(loadFile("passport-photo.jpg"), 90);
        const before = Buffer.from(received);
        const TEMP = "temporary/rotated.png";
        const objects = new Map([[TEMP, received]]);
        const bucket = {
            objects,
            async exists(p) { return objects.has(p) ? { data: true, error: null } : { data: false, error: { statusCode: "404", message: "Object not found" } }; },
            async copy(from, to) { if (objects.has(to)) return { data: null, error: { statusCode: "409", message: "exists" } }; objects.set(to, objects.get(from)); return { data: { path: to }, error: null }; },
            async upload() { throw new Error("the pipeline must not upload anything"); },
            async remove(paths) { paths.forEach((p) => objects.delete(p)); return { data: paths, error: null }; },
        };
        const db = createFakePrisma([{ passportId: "N1234567", uniqueId: "0001", whatsappNumber: "0771234567", firstName: "KAMAL NIMAL", otherName: "PERERA", dateOfBirth: null, placeOfBirth: null, passportExpiryDate: null }]);
        const { summary } = await processDocument({
            temporaryId: "tmp-rotated", whatsappNumber: "94771234567", fileName: null, mimeType: "image/png",
            fileBuffer: received, temporaryStoragePath: TEMP, deps: { db, bucket, now: new Date("2026-09-27T08:00:00Z") },
        });
        assert.equal(summary.documentType, "PASSPORT");
        assert.equal(summary.ocrRotation, 270);
        assert.equal(summary.storage.placement, "CLIENT");
        const stored = [...objects.keys()].find((p) => p.startsWith("clients/"));
        assert.ok(stored, "stored in the client folder");
        assert.equal(sha(objects.get(stored)), sha(before), "the stored copy is the received file, not the turned OCR input");
        assert.equal(sha(objects.get(TEMP)), sha(before), "the temporary object is unchanged");
        assert.ok(received.equals(before));
    });
});
