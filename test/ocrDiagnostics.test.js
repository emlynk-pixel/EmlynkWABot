import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { describeTextForDiagnostics } from "../src/utils/ocrDiagnostics.js";
import { loadDocumentText } from "./helpers/fixtures.js";

describe("describeTextForDiagnostics", () => {
    test("never includes document text: names, numbers and dates stay out", () => {
        const report = describeTextForDiagnostics(loadDocumentText("police-clearance"));
        const serialized = JSON.stringify(report);

        for (const value of ["Kamal", "KAMAL", "Perera", "N1234567", "02/09/2026", "2026"]) {
            assert.ok(!serialized.includes(value), `report leaks ${value}`);
        }
    });

    test("reports classification indicators and scores", () => {
        const report = describeTextForDiagnostics(loadDocumentText("police-clearance"));

        assert.equal(report.classification.documentType, "POLICE_REPORT");
        assert.ok(report.classification.indicators.includes("criminal_record"));
        assert.ok(report.vocabulary.POLICE_REPORT.exact.includes("clearance"));
    });

    test("OCR misspellings show up as near-misses, reported as the vocabulary word", () => {
        const report = describeTextForDiagnostics("SRI LANKA P0LICE\nCLEARENCE CERTIFlCATE\nno crirninal records");
        const { exact, near } = report.vocabulary.POLICE_REPORT;

        assert.ok(near.includes("clearance"));
        assert.ok(near.includes("certificate"));
        assert.ok(near.includes("criminal"));
        assert.ok(exact.includes("records"));
        assert.ok(!JSON.stringify(report).includes("CLEARENCE"));
    });

    test("short words must match exactly (no fuzzy 'fit' matches)", () => {
        const report = describeTextForDiagnostics("fix fin fat");
        assert.deepEqual(report.vocabulary.MEDICAL, { exact: [], near: [] });
    });

    test("noise from a non-Latin page gives a low letter ratio", () => {
        const report = describeTextForDiagnostics("@#% ~~ 1|| 2;; )(* !! 0o0 %%% ;; ||");

        assert.ok(report.letterRatio < 0.3);
        assert.equal(report.classification.documentType, "UNKNOWN");
    });

    test("MRZ lines are counted, not printed", () => {
        const report = describeTextForDiagnostics(loadDocumentText("passport-mrz"));

        assert.equal(report.mrzLinesFound, 2);
        assert.ok(!JSON.stringify(report).includes("LKAPERERA"));
    });

    test("empty text", () => {
        const report = describeTextForDiagnostics("");

        assert.equal(report.textLength, 0);
        assert.equal(report.letterRatio, 0);
    });
});
