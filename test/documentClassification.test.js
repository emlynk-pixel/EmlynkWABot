import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    classifyDocument,
    classifyDocumentContent,
    resolveDocumentType,
    DOCUMENT_TYPES,
    CONTENT_CLASSIFICATION_REASONS,
} from "../src/services/documentClassificationService.js";
import { loadDocumentText } from "./helpers/fixtures.js";

const { PASSPORT, POLICE_SLIP, POLICE_REPORT, MEDICAL, UNKNOWN } = DOCUMENT_TYPES;
const { NO_TEXT, INSUFFICIENT_EVIDENCE, AMBIGUOUS_CONTENT } = CONTENT_CLASSIFICATION_REASONS;

describe("classifyDocumentContent", () => {
    describe("passport", () => {
        test("passport with keywords and MRZ", () => {
            const result = classifyDocumentContent(loadDocumentText("passport-mrz"));
            assert.equal(result.documentType, PASSPORT);
            assert.equal(result.reason, null);
            assert.ok(result.indicators.includes("mrz_line_1"));
            assert.ok(result.indicators.includes("mrz_line_2"));
        });

        test("blurry passport where OCR only read the two MRZ lines", () => {
            const result = classifyDocumentContent(loadDocumentText("passport-mrz-only-noisy"));
            assert.equal(result.documentType, PASSPORT);
            assert.deepEqual(result.indicators, ["mrz_line_1", "mrz_line_2"]);
        });

        test("passport keywords without MRZ", () => {
            const result = classifyDocumentContent(loadDocumentText("passport-keywords-no-mrz"));
            assert.equal(result.documentType, PASSPORT);
        });

        test("a single MRZ line alone is not enough", () => {
            const result = classifyDocumentContent(loadDocumentText("passport-one-mrz-line"));
            assert.equal(result.documentType, UNKNOWN);
            assert.equal(result.reason, INSUFFICIENT_EVIDENCE);
        });

        test("a single MRZ line plus a passport keyword is enough", () => {
            const result = classifyDocumentContent(loadDocumentText("passport-one-mrz-line-with-keyword"));
            assert.equal(result.documentType, PASSPORT);
        });
    });

    describe("police documents", () => {
        test("clearance certificate that also mentions passport number and nationality -> POLICE_REPORT", () => {
            const result = classifyDocumentContent(loadDocumentText("police-clearance"));
            assert.equal(result.documentType, POLICE_REPORT);
            assert.ok(result.scores.POLICE > result.scores[PASSPORT]);
        });

        test("police clearance application slip -> POLICE_SLIP", () => {
            const result = classifyDocumentContent(loadDocumentText("police-slip"));
            assert.equal(result.documentType, POLICE_SLIP);
        });
    });

    describe("medical", () => {
        test("GAMCA medical examination report", () => {
            const result = classifyDocumentContent(loadDocumentText("medical-gamca"));
            assert.equal(result.documentType, MEDICAL);
        });

        test("simple hospital medical certificate", () => {
            const result = classifyDocumentContent(loadDocumentText("medical-simple"));
            assert.equal(result.documentType, MEDICAL);
        });
    });

    describe("unknown", () => {
        test("unrelated document (invoice)", () => {
            const result = classifyDocumentContent(loadDocumentText("random-invoice"));
            assert.equal(result.documentType, UNKNOWN);
            assert.equal(result.reason, INSUFFICIENT_EVIDENCE);
        });

        test("one weak passport keyword is not enough", () => {
            const result = classifyDocumentContent(loadDocumentText("weak-passport-mention"));
            assert.equal(result.documentType, UNKNOWN);
            assert.equal(result.reason, INSUFFICIENT_EVIDENCE);
        });

        test("mixed police and medical wording is ambiguous", () => {
            const result = classifyDocumentContent(loadDocumentText("ambiguous-police-medical"));
            assert.equal(result.documentType, UNKNOWN);
            assert.equal(result.reason, AMBIGUOUS_CONTENT);
        });

        test("blank text", () => {
            const result = classifyDocumentContent("   ");
            assert.equal(result.documentType, UNKNOWN);
            assert.equal(result.reason, NO_TEXT);
        });
    });

    test("result contains indicator IDs, not document text", () => {
        const result = classifyDocumentContent(loadDocumentText("passport-mrz"));
        const serialized = JSON.stringify(result);
        assert.ok(!serialized.includes("N1234567"));
        assert.ok(!serialized.includes("PERERA"));
    });
});

describe("resolveDocumentType", () => {
    const resolve = (fileName, text) =>
        resolveDocumentType({
            filenameClassification: classifyDocument({ fileName }),
            contentClassification: classifyDocumentContent(text),
        });

    test("misleading filename does not override passport content, and is flagged", () => {
        assert.deepEqual(resolve("medical.pdf", loadDocumentText("passport-mrz")), {
            documentType: PASSPORT,
            source: "CONTENT",
            filenameMismatch: true,
        });
    });

    test("random numeric filename is classified from police content", () => {
        assert.deepEqual(resolve("6325523527323.pdf", loadDocumentText("police-clearance")), {
            documentType: POLICE_REPORT,
            source: "CONTENT",
            filenameMismatch: false,
        });
    });

    test("matching filename and content", () => {
        assert.deepEqual(resolve("passport.pdf", loadDocumentText("passport-mrz")), {
            documentType: PASSPORT,
            source: "CONTENT",
            filenameMismatch: false,
        });
    });

    test("no readable text falls back to the filename hint", () => {
        assert.deepEqual(resolve("passport.pdf", ""), {
            documentType: PASSPORT,
            source: "FILENAME",
            filenameMismatch: false,
        });
    });

    test("no readable text and a random filename stays UNKNOWN", () => {
        assert.deepEqual(resolve("123.pdf", ""), {
            documentType: UNKNOWN,
            source: "CONTENT",
            filenameMismatch: false,
        });
    });

    test("ambiguous content does not use the filename hint", () => {
        assert.deepEqual(resolve("medical.pdf", loadDocumentText("ambiguous-police-medical")), {
            documentType: UNKNOWN,
            source: "CONTENT",
            filenameMismatch: false,
        });
    });

    test("weak content does not use the filename hint", () => {
        assert.deepEqual(resolve("passport.pdf", loadDocumentText("weak-passport-mention")), {
            documentType: UNKNOWN,
            source: "CONTENT",
            filenameMismatch: false,
        });
    });
});

describe("classifyDocument (filename hint)", () => {
    const cases = [
        [undefined, UNKNOWN, 0],
        ["", UNKNOWN, 0],
        ["Passport.pdf", PASSPORT, 50],
        ["my TRAVEL DOCUMENT.jpg", PASSPORT, 50],
        ["medical_report.pdf", MEDICAL, 50],
        ["health.png", MEDICAL, 50],
        ["police_clearance.pdf", POLICE_REPORT, 50],
        ["clearance.pdf", POLICE_REPORT, 50],
        ["Police Report.PDF", POLICE_REPORT, 50],
        ["6325523527323.pdf", UNKNOWN, 0],
        ["passport_medical.pdf", PASSPORT, 50],
        ["medical police.pdf", MEDICAL, 50],
        ["random.png", UNKNOWN, 0],
        ["healthy.pdf", MEDICAL, 50],
    ];

    for (const [fileName, documentType, confidence] of cases) {
        test(`${JSON.stringify(fileName)} -> ${documentType}`, () => {
            assert.deepEqual(classifyDocument({ fileName }), {
                documentType,
                confidence,
                source: "FILENAME",
            });
        });
    }
});
