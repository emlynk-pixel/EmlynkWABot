import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    extractDocumentText,
    recognizeImage,
    SAUVOLA_RETRY_BELOW_CONFIDENCE,
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

// A stand-in Tesseract worker that returns a set confidence per thresholding method.
function fakeWorker(confidenceByThresholding) {
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
            const confidence = confidenceByThresholding[thresholding];
            return { data: { text: confidence ? `text read with ${thresholding}` : "", confidence } };
        },
    };
}

describe("recognizeImage (OCR settings)", () => {
    test("a good read is kept and not retried", async () => {
        const worker = fakeWorker({ 0: 88, 2: 95 });
        const page = await recognizeImage(worker, Buffer.from("img"));

        assert.equal(page.thresholding, "OTSU");
        assert.equal(page.confidence, 88);
        assert.equal(worker.calls.filter((c) => c.recognize).length, 1);
    });

    test("every read straightens small tilts (rotateAuto)", async () => {
        const worker = fakeWorker({ 0: 50, 2: 60 });
        await recognizeImage(worker, Buffer.from("img"));

        const reads = worker.calls.filter((c) => c.recognize);
        assert.ok(reads.every((c) => c.recognize.rotateAuto === true));
    });

    test(`a weak read (< ${SAUVOLA_RETRY_BELOW_CONFIDENCE}) is retried with Sauvola and the better result kept`, async () => {
        const worker = fakeWorker({ 0: 59, 2: 81 });
        const page = await recognizeImage(worker, Buffer.from("img"));

        assert.equal(page.thresholding, "SAUVOLA");
        assert.equal(page.confidence, 81);
    });

    test("if the Sauvola retry is worse, the first read is kept", async () => {
        const worker = fakeWorker({ 0: 59, 2: 40 });
        const page = await recognizeImage(worker, Buffer.from("img"));

        assert.equal(page.thresholding, "OTSU");
        assert.equal(page.confidence, 59);
    });

    test("thresholding is set on every read, so a retry can't leak into the next page", async () => {
        const worker = fakeWorker({ 0: 59, 2: 81 });
        await recognizeImage(worker, Buffer.from("page1"));
        await recognizeImage(worker, Buffer.from("page2"));

        const settings = worker.calls.filter((c) => c.setParameters).map((c) => c.setParameters.thresholding_method);
        assert.deepEqual(settings, ["0", "2", "0", "2"]);
    });

    test("blank image: nothing read either way", async () => {
        const worker = fakeWorker({ 0: 0, 2: 0 });
        const page = await recognizeImage(worker, Buffer.from("img"));

        assert.equal(page.text, "");
        assert.equal(page.confidence, 0);
    });
});

describe("phone photos (real OCR, synthetic fixtures)", () => {
    ocrTest("harsh police certificate photo (tilt, shadow, blur, WhatsApp compression) is classified", async () => {
        const result = await extractDocumentText({ fileBuffer: loadFile("police-photo-harsh.jpg"), mimeType: "image/jpeg" });
        const classification = classifyDocumentContent(result.text);

        assert.equal(classification.documentType, "POLICE_REPORT");
        // The old default settings read this photo at about 63.
        assert.ok(result.confidence >= SAUVOLA_RETRY_BELOW_CONFIDENCE, `confidence ${result.confidence}`);
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
