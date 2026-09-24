import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    getConfidenceBand,
    getExtractionConfidence,
    getClassificationConfidence,
    assessDocumentConfidence,
    getPassportFieldConfidence,
    assessPassportFieldConfidence,
    DOCUMENT_FLAGS,
} from "../src/services/confidenceService.js";
import {
    classifyDocument,
    classifyDocumentContent,
    resolveDocumentType,
} from "../src/services/documentClassificationService.js";
import { extractPassportFields, CROSS_CHECK } from "../src/services/passportExtractionService.js";
import { loadDocumentText } from "./helpers/fixtures.js";

describe("getConfidenceBand (proposal §17)", () => {
    const cases = [
        [100, "VERIFIED"],
        [95.01, "VERIFIED"],
        [95, "HIGH_CONFIDENCE"],
        [90, "HIGH_CONFIDENCE"],
        [89.99, "SLIGHTLY_UNCLEAR"],
        [60, "SLIGHTLY_UNCLEAR"],
        [59.99, "UNCLEAR"],
        [40, "UNCLEAR"],
        [39.99, "UNDEFINED"],
        [0, "UNDEFINED"],
        [undefined, "UNDEFINED"],
        [NaN, "UNDEFINED"],
    ];

    for (const [value, band] of cases) {
        test(`${value} -> ${band}`, () => assert.equal(getConfidenceBand(value).name, band));
    }

    test("only UNCLEAR and UNDEFINED require review; only >=60 may be renamed", () => {
        assert.equal(getConfidenceBand(96).reviewRequired, false);
        assert.equal(getConfidenceBand(70).renameAllowed, true);
        assert.equal(getConfidenceBand(50).reviewRequired, true);
        assert.equal(getConfidenceBand(50).renameAllowed, false);
        assert.equal(getConfidenceBand(10).storageArea, "UNDEFINED");
    });
});

describe("getExtractionConfidence", () => {
    test("PDF text layer is exact", () => {
        assert.equal(getExtractionConfidence({ success: true, method: "PDF_TEXT", text: "x" }), 100);
    });
    test("OCR uses Tesseract confidence", () => {
        assert.equal(getExtractionConfidence({ success: true, method: "OCR", confidence: 72.5 }), 72.5);
        assert.equal(getExtractionConfidence({ success: true, method: "PDF_OCR", confidence: 88 }), 88);
    });
    test("low-confidence OCR stays low", () => {
        assert.equal(getExtractionConfidence({ success: true, method: "OCR", confidence: 35 }), 35);
    });
    test("failed extraction is 0", () => {
        assert.equal(getExtractionConfidence({ success: false, method: "OCR", confidence: 90 }), 0);
        assert.equal(getExtractionConfidence(undefined), 0);
    });
});

const classify = (fileName, text) => {
    const contentClassification = classifyDocumentContent(text);
    const resolvedType = resolveDocumentType({
        filenameClassification: classifyDocument({ fileName }),
        contentClassification,
    });
    return { contentClassification, resolvedType };
};

describe("getClassificationConfidence", () => {
    test("strong content evidence", () => {
        assert.equal(getClassificationConfidence(classify("x.pdf", loadDocumentText("passport-mrz"))), 100);
    });
    test("MRZ-only passport (score 4)", () => {
        assert.equal(getClassificationConfidence(classify("x.pdf", loadDocumentText("passport-mrz-only-noisy"))), 90);
    });
    test("borderline police slip (score 3)", () => {
        assert.equal(getClassificationConfidence(classify("x.pdf", loadDocumentText("police-slip"))), 80);
    });
    test("filename-only type is below 40", () => {
        assert.equal(getClassificationConfidence(classify("passport.pdf", "")), 30);
    });
    test("unknown type is 0", () => {
        assert.equal(getClassificationConfidence(classify("x.pdf", loadDocumentText("random-invoice"))), 0);
    });
});

describe("assessDocumentConfidence", () => {
    const pdfText = (text) => ({ success: true, method: "PDF_TEXT", text });

    test("clean text PDF passport is VERIFIED", () => {
        const text = loadDocumentText("passport-mrz");
        const result = assessDocumentConfidence({ textExtraction: pdfText(text), ...classify("a.pdf", text) });

        assert.equal(result.documentConfidence, 100);
        assert.equal(result.band, "VERIFIED");
        assert.equal(result.reviewRequired, false);
        assert.deepEqual(result.flags, []);
    });

    test("well-classified document but low-confidence OCR is limited by the OCR", () => {
        const text = loadDocumentText("medical-gamca");
        const result = assessDocumentConfidence({
            textExtraction: { success: true, method: "OCR", text, confidence: 45 },
            ...classify("a.jpg", text),
        });

        assert.equal(result.documentConfidence, 45);
        assert.equal(result.band, "UNCLEAR");
        assert.equal(result.reviewRequired, true);
    });

    test("wrong document (filename says medical, content is passport) needs review even when VERIFIED", () => {
        const text = loadDocumentText("passport-mrz");
        const result = assessDocumentConfidence({ textExtraction: pdfText(text), ...classify("medical.pdf", text) });

        assert.equal(result.band, "VERIFIED");
        assert.ok(result.flags.includes(DOCUMENT_FLAGS.WRONG_DOCUMENT_SUSPECTED));
        assert.equal(result.reviewRequired, true);
    });

    test("unreadable document classified by filename only is UNDEFINED", () => {
        const result = assessDocumentConfidence({
            textExtraction: { success: false, method: "OCR", text: "", confidence: 0 },
            ...classify("passport.jpg", ""),
        });

        assert.equal(result.band, "UNDEFINED");
        assert.ok(result.flags.includes(DOCUMENT_FLAGS.NO_READABLE_TEXT));
        assert.ok(result.flags.includes(DOCUMENT_FLAGS.CLASSIFIED_FROM_FILENAME_ONLY));
    });

    test("corrupt PDF is flagged and UNDEFINED", () => {
        const result = assessDocumentConfidence({
            textExtraction: { success: false, method: "PDF_PARSE_FAILED", text: "" },
            ...classify("x.pdf", ""),
        });

        assert.equal(result.band, "UNDEFINED");
        assert.deepEqual(result.flags, [DOCUMENT_FLAGS.CORRUPT_FILE]);
    });

    test("unknown document is UNDEFINED", () => {
        const text = loadDocumentText("random-invoice");
        const result = assessDocumentConfidence({ textExtraction: pdfText(text), ...classify("x.pdf", text) });
        assert.equal(result.band, "UNDEFINED");
    });
});

describe("getPassportFieldConfidence", () => {
    const field = (overrides) => ({ value: "X", source: "MRZ", checkDigitValid: true, crossCheck: CROSS_CHECK.MATCH, ...overrides });

    test("MRZ check digit valid and printed value agrees", () => assert.equal(getPassportFieldConfidence(field(), 60), 100));
    test("MRZ check digit valid, no printed value", () =>
        assert.equal(getPassportFieldConfidence(field({ crossCheck: CROSS_CHECK.NOT_AVAILABLE }), 60), 97));
    test("MRZ check digit failed, nothing to confirm it", () =>
        assert.equal(getPassportFieldConfidence(field({ checkDigitValid: false, crossCheck: CROSS_CHECK.NOT_AVAILABLE }), 99), 30));
    test("MRZ and printed value disagree", () =>
        assert.equal(getPassportFieldConfidence(field({ crossCheck: CROSS_CHECK.MISMATCH }), 100), 30));
    test("printed value only is capped by OCR confidence", () => {
        const printed = field({ source: "VIZ", checkDigitValid: null, crossCheck: CROSS_CHECK.NOT_AVAILABLE });
        assert.equal(getPassportFieldConfidence(printed, 100), 90);
        assert.equal(getPassportFieldConfidence(printed, 55), 55);
    });
    test("corrupted MRZ that agrees with the printed value", () =>
        assert.equal(getPassportFieldConfidence(field({ source: "VIZ", checkDigitValid: false }), 100), 90));
    test("MRZ name (no check digit) confirmed by the printed name", () =>
        assert.equal(getPassportFieldConfidence(field({ checkDigitValid: null }), 50), 97));
    test("missing value", () => assert.equal(getPassportFieldConfidence({ value: null }, 100), 0));
});

describe("assessPassportFieldConfidence", () => {
    test("ICAO specimen: MRZ fields VERIFIED, place of birth (printed only) HIGH_CONFIDENCE", () => {
        const result = assessPassportFieldConfidence(
            extractPassportFields(loadDocumentText("passport-icao-specimen")),
            100
        );

        assert.equal(result.passportId.band, "VERIFIED");
        assert.equal(result.dateOfBirth.band, "VERIFIED");
        assert.equal(result.surname.band, "VERIFIED");
        assert.equal(result.placeOfBirth.confidence, 90);
    });

    test("MRZ/printed passport number mismatch lands in UNDEFINED", () => {
        const result = assessPassportFieldConfidence(
            extractPassportFields(loadDocumentText("passport-mrz-viz-mismatch")),
            100
        );
        assert.equal(result.passportId.band, "UNDEFINED");
    });
});
