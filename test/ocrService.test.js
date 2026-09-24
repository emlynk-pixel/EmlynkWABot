import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { extractDocumentText, TEXT_EXTRACTION_METHODS } from "../src/services/ocrService.js";
import { classifyDocumentContent } from "../src/services/documentClassificationService.js";

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
