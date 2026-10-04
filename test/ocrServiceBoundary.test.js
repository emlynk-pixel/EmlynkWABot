import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { MAX_FILE_SIZE } from "../src/utils/fileValidation.js";
import { OCR_RESOURCE_REASONS, TEXT_EXTRACTION_METHODS } from "../src/services/ocrContract.js";
import { MAX_DOCUMENT_BYTES } from "../ocr-worker/src/app.js";
import { TEXT_EXTRACTION_METHODS as SERVICE_METHODS } from "../ocr-worker/src/ocrService.js";

// The OCR runs in its own service (ocr-worker/), deployed separately. It
// carries copies of the backend code its OCR relies on: it picks the best
// read by passport MRZ check digits with the same parser the backend then
// extracts passport fields with. These tests keep both sides in step.
const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const code = (path) => source(path).replace(/\/\/.*$/gm, "");

describe("OCR service and backend stay in step", () => {
    test("the service's copies of shared utilities are identical to the backend's", () => {
        for (const file of ["mrz.js", "dateParsing.js", "safeLog.js"]) {
            assert.equal(source(`../ocr-worker/src/utils/${file}`), source(`../src/utils/${file}`), file);
        }
    });

    test("result methods and refusal reasons are the same on both sides", () => {
        assert.deepEqual(TEXT_EXTRACTION_METHODS, SERVICE_METHODS);
        const thrown = new Set([...source("../ocr-worker/src/ocrService.js").matchAll(/new OcrResourceError\("([A-Z_]+)"\)/g)].map((m) => m[1]));
        assert.deepEqual([...thrown].sort(), [...OCR_RESOURCE_REASONS].sort());
    });

    test("the service accepts every file the webhook accepts", () => {
        assert.ok(MAX_DOCUMENT_BYTES >= MAX_FILE_SIZE);
    });
});

describe("only the OCR integration layer knows OCR is remote", () => {
    test("the backend has no OCR engine: no Tesseract, PDF rendering or image decoding", () => {
        const { dependencies } = JSON.parse(source("../package.json"));
        for (const name of ["tesseract.js", "pdf-parse", "@napi-rs/canvas", "jpeg-js", "pngjs"]) {
            assert.ok(!(name in dependencies), name);
        }
    });

    test("downstream services never touch HTTP, Cloud Run or the OCR client", () => {
        for (const file of ["documentClassificationService.js", "passportExtractionService.js", "identityVerificationService.js", "storagePlacementService.js", "confidenceService.js", "documentProcessingService.js"]) {
            assert.ok(!/google-auth-library|fetch\(|OCR_SERVICE_URL|ocr-worker|tesseract/i.test(code(`../src/services/${file}`)), file);
        }
        // Only the pipeline's default text extraction comes from the client.
        assert.match(source("../src/services/documentProcessingService.js"), /import \{ extractDocumentText \} from "\.\/ocrClient\.js";/);
        for (const file of ["documentClassificationService.js", "passportExtractionService.js", "identityVerificationService.js", "storagePlacementService.js"]) {
            assert.ok(!/ocrClient|ocrContract/.test(code(`../src/services/${file}`)), file);
        }
    });
});
