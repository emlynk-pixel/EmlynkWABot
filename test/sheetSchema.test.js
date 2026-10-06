// Google Sheet mirror: the 40-column schema (sheetSchema.js). Pure, no Google.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    SHEET_COLUMNS,
    SHEET_COLUMN_COUNT,
    SHEET_BUSINESS_COLUMN_COUNT,
    SHEET_HEADERS,
    SHEET_LAST_COLUMN,
    SYSTEM_CANDIDATE_ID_COLUMN,
    SYSTEM_CANDIDATE_ID_INDEX,
    assertSheetRow,
    candidateIdRange,
    columnLetter,
    dataRange,
    headerRange,
    operationalRange,
    quoteSheetName,
    rowRange,
    validateHeaderRow,
} from "../src/services/sheetSchema.js";

const TAB = "Emlynk Candidate Operational Mirror";

// The manually finalized real Sheet, A to AN.
const FINAL_HEADERS = [
    "TEST NUMBER", "PASSPORT NUMBER", "FIRST NAME", "OTHER NAME", "TEST DATE", "BIRTHDAY", "PP EX DATE", "JOB",
    "ID NUMBER", "ADDRESS", "WHATSAPP NUM", "CONTACT NUM", "PASSPORT COPY", "POLICE REP SRI LANKA", "POLICE REP ROMANIA",
    "MEDICAL", "SCAN", "DRIVING LICIAN", "NATIONAL ID", "POLICE REPORT APPLIED", "SUBMIT DATE", "POLICE REP SRI LANKA",
    "POLICE REP FM", "VIDEOS", "PLACE OF BIRTH", "SEX", "NATIONALITY", "PASSPORT ISSUE DATE", "JOB EXPERIENCE",
    "CANDIDATE DETAILS NOTE", "TEST DETAILS STATUS", "CANDIDATE DETAILS STATUS", "DOCUMENT SUBMISSION STATUS",
    "IVS INTERVIEW STATUS", "VISA APPROVAL STATUS", "FINALIZING JOB STATUS", "RECORD STATUS", "REGISTERED AT",
    "LAST MIRRORED AT", "_SYSTEM_CANDIDATE_ID",
];

describe("Google Sheet schema", () => {
    test("has exactly 40 columns: 39 business columns and the technical ID", () => {
        assert.equal(SHEET_COLUMN_COUNT, 40);
        assert.equal(SHEET_COLUMNS.length, 40);
        assert.equal(SHEET_BUSINESS_COLUMN_COUNT, 39);
        assert.equal(SHEET_LAST_COLUMN, "AN");
    });

    test("headers are in the exact final order, A to AN", () => {
        assert.deepEqual([...SHEET_HEADERS], FINAL_HEADERS);
        assert.deepEqual(SHEET_COLUMNS.map((c) => c.column), Array.from({ length: 40 }, (_, i) => columnLetter(i)));
        assert.equal(SHEET_COLUMNS[0].column, "A");
        assert.equal(SHEET_COLUMNS[39].column, "AN");
    });

    test("the two POLICE REP SRI LANKA headers stay distinct by position (N and V)", () => {
        const positions = SHEET_COLUMNS.filter((c) => c.header === "POLICE REP SRI LANKA");
        assert.deepEqual(positions.map((c) => [c.column, c.field]), [["N", "policeReportSriLankaVerified"], ["V", "policeReportSriLankaNormal"]]);
        // Every column has its own field name even where headers repeat.
        assert.equal(new Set(SHEET_COLUMNS.map((c) => c.field)).size, 40);
        assert.equal(new Set(SHEET_HEADERS).size, 39, "only POLICE REP SRI LANKA repeats");
    });

    test("one SCAN column only, the legacy DRIVING LICIAN spelling, no agreement/affidavit columns", () => {
        assert.equal(SHEET_HEADERS.filter((h) => h === "SCAN").length, 1);
        assert.equal(SHEET_COLUMNS.find((c) => c.header === "SCAN").column, "Q");
        assert.ok(SHEET_HEADERS.includes("DRIVING LICIAN"));
        assert.equal(SHEET_HEADERS.filter((h) => /AGREEMENT|AFFIDAVIT/i.test(h)).length, 0);
        assert.equal(SHEET_HEADERS.filter((h) => h === "PASSPORT COPY").length, 1);
        assert.equal(SHEET_HEADERS.filter((h) => h === "POLICE REP ROMANIA").length, 1);
    });

    test("the technical candidate ID is the last column, AN", () => {
        assert.equal(SYSTEM_CANDIDATE_ID_INDEX, 39);
        assert.equal(SYSTEM_CANDIDATE_ID_COLUMN, "AN");
        assert.equal(SHEET_HEADERS[39], "_SYSTEM_CANDIDATE_ID");
    });

    test("the schema can't be changed at runtime", () => {
        assert.ok(Object.isFrozen(SHEET_COLUMNS));
        assert.ok(Object.isFrozen(SHEET_COLUMNS[0]));
        assert.ok(Object.isFrozen(SHEET_HEADERS));
        assert.throws(() => { SHEET_COLUMNS[0].header = "X"; });
    });
});

describe("Google Sheet ranges", () => {
    test("every range is A:AN on the quoted tab", () => {
        assert.equal(headerRange(TAB), "'Emlynk Candidate Operational Mirror'!A1:AN1");
        assert.equal(dataRange(TAB), "'Emlynk Candidate Operational Mirror'!A2:AN");
        assert.equal(operationalRange(TAB), "'Emlynk Candidate Operational Mirror'!A:AN");
        assert.equal(rowRange(TAB, 7), "'Emlynk Candidate Operational Mirror'!A7:AN7");
        assert.equal(candidateIdRange(TAB), "'Emlynk Candidate Operational Mirror'!AN2:AN");
    });

    test("a quote in the tab name is escaped; an empty tab name is refused", () => {
        assert.equal(quoteSheetName("Bob's tab"), "'Bob''s tab'");
        assert.throws(() => quoteSheetName(""), /tab name/);
    });

    test("the header row can never be addressed as a data row", () => {
        assert.throws(() => rowRange(TAB, 1), /data row number/);
        assert.throws(() => rowRange(TAB, 0), /data row number/);
        assert.throws(() => rowRange(TAB, 2.5), /data row number/);
    });
});

describe("header validation (positional)", () => {
    test("the exact final header row is valid", () => {
        assert.deepEqual(validateHeaderRow([...FINAL_HEADERS]), { valid: true, mismatches: [] });
    });

    test("swapping the two POLICE REP SRI LANKA neighbours is caught by position", () => {
        const swapped = [...FINAL_HEADERS];
        [swapped[13], swapped[14]] = [swapped[14], swapped[13]];
        const result = validateHeaderRow(swapped);
        assert.equal(result.valid, false);
        assert.deepEqual(result.mismatches.map((m) => m.column), ["N", "O"]);
    });

    test("a renamed, missing or reordered header is rejected", () => {
        const renamed = [...FINAL_HEADERS];
        renamed[17] = "DRIVING LICENSE";
        assert.deepEqual(validateHeaderRow(renamed).mismatches, [{ column: "R", position: 18, expected: "DRIVING LICIAN", actual: "DRIVING LICENSE" }]);

        const missingId = FINAL_HEADERS.slice(0, 39);
        assert.deepEqual(validateHeaderRow(missingId).mismatches.map((m) => m.column), ["AN"]);

        const shifted = ["NEW COLUMN", ...FINAL_HEADERS.slice(0, 39)];
        assert.equal(validateHeaderRow(shifted).valid, false);
    });

    test("text must match exactly (no trimming, no case folding)", () => {
        const spaced = [...FINAL_HEADERS];
        spaced[16] = "SCAN ";
        assert.equal(validateHeaderRow(spaced).valid, false);
        const lower = [...FINAL_HEADERS];
        lower[16] = "scan";
        assert.equal(validateHeaderRow(lower).valid, false);
    });

    test("a non-empty header beyond AN is reported; empty trailing cells are fine", () => {
        assert.equal(validateHeaderRow([...FINAL_HEADERS, ""]).valid, true);
        assert.deepEqual(validateHeaderRow([...FINAL_HEADERS, "EXTRA"]).mismatches, [{ column: "AO", position: 41, expected: null, actual: "EXTRA" }]);
    });

    test("an empty or missing header row is invalid", () => {
        assert.equal(validateHeaderRow([]).valid, false);
        assert.equal(validateHeaderRow(undefined).mismatches.length, 40);
    });
});

describe("row shape", () => {
    const row = () => Array.from({ length: 40 }, (_, i) => (i === 39 ? "0042" : ""));

    test("a 40-string row with a candidate ID is accepted", () => {
        assert.equal(assertSheetRow(row()).length, 40);
    });

    test("a wrong length, a non-string cell or a blank candidate ID is refused", () => {
        assert.throws(() => assertSheetRow(row().slice(0, 39)), /exactly 40/);
        assert.throws(() => assertSheetRow([...row(), ""]), /exactly 40/);
        const withNumber = row();
        withNumber[0] = 5;
        assert.throws(() => assertSheetRow(withNumber), /string/);
        const noId = row();
        noId[39] = " ";
        assert.throws(() => assertSheetRow(noId), /system candidate ID/);
    });
});
