import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    extractDocumentText,
    recognizeImage,
    OCR_RETRY_BELOW_CONFIDENCE,
    TEXT_EXTRACTION_METHODS,
} from "../src/services/ocrService.js";
import { classifyDocumentContent } from "../src/services/documentClassificationService.js";
import { extractPassportFields } from "../src/services/passportExtractionService.js";

const loadFile = (name) => readFileSync(new URL(`./fixtures/files/${name}`, import.meta.url));

// Tesseract downloads its language data on first use and takes a few
// seconds per page, so real OCR tests are opt-in: RUN_OCR_TESTS=1 npm test
const ocrTest = process.env.RUN_OCR_TESTS === "1" ? test : test.skip;

describe("extractDocumentText", () => {
    test("text-based PDF uses the embedded text layer", async () => {
        const result = await extractDocumentText({ fileBuffer: loadFile("text-passport.pdf"), mimeType: "application/pdf" });

        assert.equal(result.method, TEXT_EXTRACTION_METHODS.PDF_TEXT);
        assert.equal(result.success, true);
        assert.match(result.text, /Passport No N1234567/);
        assert.doesNotMatch(result.text, /-- 1 of 1 --/);
    });

    test("corrupt PDF is reported as PDF_PARSE_FAILED, not as scanned", async () => {
        const result = await extractDocumentText({ fileBuffer: loadFile("corrupt.pdf"), mimeType: "application/pdf" });

        assert.equal(result.method, TEXT_EXTRACTION_METHODS.PDF_PARSE_FAILED);
        assert.equal(result.success, false);
    });

    test("unsupported MIME type", async () => {
        const result = await extractDocumentText({ fileBuffer: Buffer.from("x"), mimeType: "text/plain" });
        assert.equal(result.method, TEXT_EXTRACTION_METHODS.UNSUPPORTED_DOCUMENT_TYPE);
    });

    ocrTest("scanned PDF falls back to OCR and can be classified", async () => {
        const result = await extractDocumentText({ fileBuffer: loadFile("scanned-police.pdf"), mimeType: "application/pdf" });

        assert.equal(result.method, TEXT_EXTRACTION_METHODS.PDF_OCR);
        assert.equal(result.success, true);
        assert.equal(result.pagesProcessed, 1);
        assert.ok(result.confidence > 60);
        assert.equal(classifyDocumentContent(result.text).documentType, "POLICE_REPORT");
    });

    ocrTest("image OCR reads a medical report", async () => {
        const result = await extractDocumentText({ fileBuffer: loadFile("image-medical.png"), mimeType: "image/png" });

        assert.equal(result.method, TEXT_EXTRACTION_METHODS.OCR);
        assert.equal(result.success, true);
        assert.ok(result.confidence > 60);
        assert.equal(classifyDocumentContent(result.text).documentType, "MEDICAL");
    });

    ocrTest("blank image is not a success", async () => {
        const result = await extractDocumentText({ fileBuffer: loadFile("blank.png"), mimeType: "image/png" });

        assert.equal(result.success, false);
        assert.equal(result.text, "");
    });
});

// A stand-in Tesseract worker. Confidence depends on both settings, keyed
// as "<thresholding>-<rotateAuto>", e.g. "0-false" (Otsu, no rotation) or
// "2-true" (Sauvola with rotation). Missing keys read nothing.
function fakeWorker(confidenceBySettings) {
    const calls = [];
    let thresholding = "0";
    return {
        calls,
        async setParameters(params) {
            thresholding = params.thresholding_method;
            calls.push({ setParameters: params });
        },
        async recognize(image, options) {
            calls.push({ recognize: options });
            const confidence = confidenceBySettings[`${thresholding}-${options.rotateAuto}`] ?? 0;
            return { data: { text: confidence ? `text read with ${thresholding}` : "", confidence } };
        },
    };
}

const readsOf = (worker) =>
    worker.calls.filter((c) => c.recognize).map((c) => c.recognize.rotateAuto);

describe("recognizeImage (OCR settings)", () => {
    test("a good default read is kept: Otsu, no rotation, one read only", async () => {
        const worker = fakeWorker({ "0-false": 88, "2-true": 95 });
        const page = await recognizeImage(worker, Buffer.from("img"));

        assert.equal(page.thresholding, "OTSU");
        assert.equal(page.rotateAuto, false);
        assert.equal(page.confidence, 88);
        assert.deepEqual(readsOf(worker), [false]);
    });

    test("regression: rotation that makes a real photo worse is not chosen (59 kept over 32 and 41)", async () => {
        // Confidences from the real police certificate diagnostic.
        const worker = fakeWorker({ "0-false": 59, "0-true": 32, "2-false": 45, "2-true": 41 });
        const page = await recognizeImage(worker, Buffer.from("img"));

        assert.equal(page.confidence, 59);
        assert.equal(page.thresholding, "OTSU");
        assert.equal(page.rotateAuto, false);
    });

    test(`a weak default read (< ${OCR_RETRY_BELOW_CONFIDENCE}) tries every alternative`, async () => {
        const worker = fakeWorker({ "0-false": 59 });
        await recognizeImage(worker, Buffer.from("img"));

        const settings = worker.calls.filter((c) => c.setParameters).map((c) => c.setParameters.thresholding_method);
        assert.deepEqual(settings, ["0", "0", "2", "2"]);
        assert.deepEqual(readsOf(worker), [false, true, false, true]);
    });

    test("the most confident alternative wins when it beats the default", async () => {
        const worker = fakeWorker({ "0-false": 63, "0-true": 84, "2-false": 81, "2-true": 86 });
        const page = await recognizeImage(worker, Buffer.from("img"));

        assert.equal(page.confidence, 86);
        assert.equal(page.thresholding, "SAUVOLA");
        assert.equal(page.rotateAuto, true);
    });

    test("Sauvola without rotation can win", async () => {
        const worker = fakeWorker({ "0-false": 50, "0-true": 30, "2-false": 77, "2-true": 35 });
        const page = await recognizeImage(worker, Buffer.from("img"));

        assert.equal(page.confidence, 77);
        assert.equal(page.thresholding, "SAUVOLA");
        assert.equal(page.rotateAuto, false);
    });

    test("thresholding is set on every read, so a retry can't leak into the next page", async () => {
        const worker = fakeWorker({ "0-false": 59, "2-true": 81 });
        await recognizeImage(worker, Buffer.from("page1"));
        await recognizeImage(worker, Buffer.from("page2"));

        const settings = worker.calls.filter((c) => c.setParameters).map((c) => c.setParameters.thresholding_method);
        assert.deepEqual(settings, ["0", "0", "2", "2", "0", "0", "2", "2"]);
    });

    test("blank image: nothing read with any setting", async () => {
        const worker = fakeWorker({});
        const page = await recognizeImage(worker, Buffer.from("img"));

        assert.equal(page.text, "");
        assert.equal(page.confidence, 0);
        assert.equal(page.rotateAuto, false);
    });
});

describe("phone photos (real OCR, synthetic fixtures)", () => {
    ocrTest("harsh police certificate photo (tilt, shadow, blur, WhatsApp compression) is classified", async () => {
        const result = await extractDocumentText({ fileBuffer: loadFile("police-photo-harsh.jpg"), mimeType: "image/jpeg" });
        const classification = classifyDocumentContent(result.text);

        assert.equal(classification.documentType, "POLICE_REPORT");
        // The old default settings read this photo at about 63.
        assert.ok(result.confidence >= OCR_RETRY_BELOW_CONFIDENCE, `confidence ${result.confidence}`);
        assert.ok(classification.indicators.includes("police_clearance"));
    });

    ocrTest("typical police certificate photo is classified", async () => {
        const result = await extractDocumentText({ fileBuffer: loadFile("police-photo-hard.jpg"), mimeType: "image/jpeg" });

        assert.equal(classifyDocumentContent(result.text).documentType, "POLICE_REPORT");
        assert.ok(result.confidence > 85, `confidence ${result.confidence}`);
    });

    ocrTest("passport photo still reads the MRZ with valid check digits", async () => {
        const result = await extractDocumentText({ fileBuffer: loadFile("passport-photo.jpg"), mimeType: "image/jpeg" });
        const passport = extractPassportFields(result.text);

        assert.equal(classifyDocumentContent(result.text).documentType, "PASSPORT");
        assert.equal(passport.status, "COMPLETE");
        assert.equal(passport.mrz.linesFound, 2);
        assert.equal(passport.mrz.compositeCheckValid, true);
        assert.equal(passport.fields.passportId.value, "N1234567");
    });
});
