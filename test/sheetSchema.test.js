// Google Sheet mirror: the schema (sheetSchema.js). Columns are found by
// header NAME: the canonical order below is only the template / field order;
// the live Sheet may put the system columns anywhere, with operator columns
// between them. Pure, no Google.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    SHEET_COLUMNS,
    SHEET_COLUMN_COUNT,
    SHEET_BUSINESS_COLUMN_COUNT,
    SHEET_HEADERS,
    SYSTEM_CANDIDATE_ID_HEADER,
    SYSTEM_CANDIDATE_ID_INDEX,
    assertSheetRow,
    candidateIdRange,
    changedColumnLetters,
    columnLetter,
    columnOf,
    dataRange,
    fieldIndex,
    headerRange,
    operationalRange,
    quoteSheetName,
    readSheetLayout,
    rowRange,
    toFieldCells,
    toLiveRow,
    validateHeaderRow,
    writeRangesFor,
} from "../src/services/sheetSchema.js";

const TAB = "Emlynk Candidate Operational Mirror";

// The real Sheet's current header (the canonical template): the manually
// finalized 40 columns plus VISA SUBMISSION STATUS, left of VISA APPROVAL STATUS.
const FINAL_HEADERS = [
    "TEST NUMBER", "PASSPORT NUMBER", "FIRST NAME", "OTHER NAME", "TEST DATE", "BIRTHDAY", "PP EX DATE", "JOB",
    "ID NUMBER", "ADDRESS", "WHATSAPP NUM", "CONTACT NUM", "PASSPORT COPY", "POLICE REP SRI LANKA", "POLICE REP ROMANIA",
    "MEDICAL", "SCAN", "DRIVING LICIAN", "NATIONAL ID", "POLICE REPORT APPLIED", "SUBMIT DATE", "POLICE REP SRI LANKA",
    "POLICE REP FM", "VIDEOS", "PLACE OF BIRTH", "SEX", "NATIONALITY", "PASSPORT ISSUE DATE", "JOB EXPERIENCE",
    "CANDIDATE DETAILS NOTE", "TEST DETAILS STATUS", "CANDIDATE DETAILS STATUS", "DOCUMENT SUBMISSION STATUS",
    "IVS INTERVIEW STATUS", "VISA SUBMISSION STATUS", "VISA APPROVAL STATUS", "FINALIZING JOB STATUS", "RECORD STATUS", "REGISTERED AT",
    "LAST MIRRORED AT", "_SYSTEM_CANDIDATE_ID",
];
// The 40-column header the live Sheet had before VISA SUBMISSION STATUS.
const PREVIOUS_HEADERS = FINAL_HEADERS.filter((header) => header !== "VISA SUBMISSION STATUS");

const without = (headers, header) => headers.filter((h) => h !== header);
// A live row from a header and field values: system values at their header's
// position, "" elsewhere. (The two POLICE REP SRI LANKA columns: left = SL Verified.)
const field = (name) => SHEET_COLUMNS[fieldIndex(name)];
const layoutOf = (headers) => {
    const result = readSheetLayout(headers);
    assert.equal(result.valid, true, JSON.stringify(result.problems));
    return result.layout;
};
// Field-ordered cells where every system cell is its own field name (easy to see where it lands).
const NAMED_CELLS = SHEET_COLUMNS.map((c) => c.field);

describe("Google Sheet schema (canonical template)", () => {
    test("has exactly 41 system columns: 40 business columns and the technical ID", () => {
        assert.equal(SHEET_COLUMN_COUNT, 41);
        assert.equal(SHEET_COLUMNS.length, 41);
        assert.equal(SHEET_BUSINESS_COLUMN_COUNT, 40);
    });

    test("the canonical (template / field) order is the real Sheet's current order, A to AO", () => {
        assert.deepEqual([...SHEET_HEADERS], FINAL_HEADERS);
        assert.deepEqual(SHEET_COLUMNS.map((c) => c.column), Array.from({ length: 41 }, (_, i) => columnLetter(i)));
        assert.equal(SHEET_COLUMNS.find((c) => c.field === "visaSubmissionStatus").column, "AI", "in the template; the live Sheet may put it anywhere");
    });

    test("the two POLICE REP SRI LANKA headers are two fields (SL Verified first, then SL Normal)", () => {
        const both = SHEET_COLUMNS.filter((c) => c.header === "POLICE REP SRI LANKA");
        assert.deepEqual(both.map((c) => c.field), ["policeReportSriLankaVerified", "policeReportSriLankaNormal"]);
        assert.equal(new Set(SHEET_COLUMNS.map((c) => c.field)).size, 41);
        assert.equal(new Set(SHEET_HEADERS).size, 40, "only POLICE REP SRI LANKA repeats");
    });

    test("one SCAN column only, the legacy DRIVING LICIAN spelling, no agreement/affidavit columns", () => {
        assert.equal(SHEET_HEADERS.filter((h) => h === "SCAN").length, 1);
        assert.ok(SHEET_HEADERS.includes("DRIVING LICIAN"));
        assert.equal(SHEET_HEADERS.filter((h) => /AGREEMENT|AFFIDAVIT/i.test(h)).length, 0);
        assert.equal(SHEET_HEADERS.filter((h) => h === "PASSPORT COPY").length, 1);
        assert.equal(SHEET_HEADERS.filter((h) => h === "POLICE REP ROMANIA").length, 1);
    });

    test("the technical candidate ID is a field found by its header, not a position", () => {
        assert.equal(SYSTEM_CANDIDATE_ID_HEADER, "_SYSTEM_CANDIDATE_ID");
        assert.equal(SHEET_HEADERS[SYSTEM_CANDIDATE_ID_INDEX], "_SYSTEM_CANDIDATE_ID");
    });

    test("the schema can't be changed at runtime", () => {
        assert.ok(Object.isFrozen(SHEET_COLUMNS));
        assert.ok(Object.isFrozen(SHEET_COLUMNS[0]));
        assert.ok(Object.isFrozen(SHEET_HEADERS));
        assert.throws(() => { SHEET_COLUMNS[0].header = "X"; });
    });

    test("column letters: A-Z, AA-AZ, BA..., ZZ, AAA", () => {
        assert.deepEqual([0, 25, 26, 51, 52, 701, 702, 16383].map(columnLetter), ["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA", "XFD"]);
        assert.throws(() => columnLetter(-1));
        assert.throws(() => columnLetter(1.5));
    });
});

describe("header validation by name (order is irrelevant)", () => {
    test("1. the current canonical header is valid and maps every column where it is", () => {
        const layout = layoutOf(FINAL_HEADERS);
        assert.equal(layout.width, 41);
        assert.equal(layout.extraColumns, 0);
        SHEET_COLUMNS.forEach((c) => assert.equal(layout.positions[c.index], c.index, c.header));
        assert.deepEqual(validateHeaderRow([...FINAL_HEADERS]), { valid: true, mismatches: [] });
    });

    test("2/8. a fully reversed header is valid; every field is found at its new position", () => {
        const reversed = [...FINAL_HEADERS].reverse();
        const layout = layoutOf(reversed);
        for (const c of SHEET_COLUMNS) {
            if (c.header === "POLICE REP SRI LANKA") continue;
            assert.equal(reversed[layout.positions[c.index]], c.header, c.header);
        }
    });

    test("3/4/5. _SYSTEM_CANDIDATE_ID first, in the middle or last", () => {
        const others = without(FINAL_HEADERS, "_SYSTEM_CANDIDATE_ID");
        const first = ["_SYSTEM_CANDIDATE_ID", ...others];
        const middle = [...others.slice(0, 20), "_SYSTEM_CANDIDATE_ID", ...others.slice(20)];
        const last = [...others, "_SYSTEM_CANDIDATE_ID"];
        assert.equal(columnOf(layoutOf(first), "systemCandidateId"), "A");
        assert.equal(columnOf(layoutOf(middle), "systemCandidateId"), "U");
        assert.equal(columnOf(layoutOf(last), "systemCandidateId"), "AO");
        assert.equal(candidateIdRange(TAB, layoutOf(first)), `'${TAB}'!A2:A`);
        assert.equal(candidateIdRange(TAB, layoutOf(middle)), `'${TAB}'!U2:U`);
    });

    test("6/7. VISA SUBMISSION STATUS and VISA APPROVAL STATUS can be anywhere, apart or swapped", () => {
        const moved = ["VISA APPROVAL STATUS", ...without(without(FINAL_HEADERS, "VISA SUBMISSION STATUS"), "VISA APPROVAL STATUS"), "VISA SUBMISSION STATUS"];
        const layout = layoutOf(moved);
        assert.equal(columnOf(layout, "visaApprovalStatus"), "A");
        assert.equal(columnOf(layout, "visaSubmissionStatus"), "AO");
    });

    test("9/10. extra operator columns (one or several, anywhere, with or without a header) are allowed and ignored", () => {
        const one = [...FINAL_HEADERS.slice(0, 5), "Operator Note", ...FINAL_HEADERS.slice(5)];
        assert.equal(layoutOf(one).extraColumns, 1);
        const several = ["Internal Note", ...FINAL_HEADERS.slice(0, 10), "Follow-up", "", ...FINAL_HEADERS.slice(10), "Agent", "Phone call 2"];
        const layout = layoutOf(several);
        assert.equal(layout.width, 46);
        assert.equal(layout.extraColumns, 5);
        assert.equal(columnOf(layout, "testNumber"), "B");
    });

    test("an unusual layout: every known field still maps to the right header", () => {
        const others = without(without(without(FINAL_HEADERS, "_SYSTEM_CANDIDATE_ID"), "VISA SUBMISSION STATUS"), "PASSPORT NUMBER");
        const unusual = ["_SYSTEM_CANDIDATE_ID", "Operator Note", "VISA SUBMISSION STATUS", "PASSPORT NUMBER", "Another Note",
            ...without(others, "VISA APPROVAL STATUS"), "VISA APPROVAL STATUS"];
        const layout = layoutOf(unusual);
        const live = toLiveRow(NAMED_CELLS, layout);
        assert.deepEqual(live.slice(0, 5), ["systemCandidateId", "", "visaSubmissionStatus", "passportNumber", ""]);
        assert.equal(live.at(-1), "visaApprovalStatus");
        // Reading the live row back gives the field-ordered cells again; operator columns are not part of it.
        assert.deepEqual(toFieldCells(live, layout), NAMED_CELLS);
    });

    test("12. a missing system header -> SCHEMA_INVALID, naming the header", () => {
        const result = readSheetLayout(without(FINAL_HEADERS, "VISA SUBMISSION STATUS"));
        assert.equal(result.valid, false);
        assert.equal(result.layout, null);
        assert.deepEqual(result.problems, [{ problem: "MISSING", header: "VISA SUBMISSION STATUS", expected: 1, found: 0, columns: [] }]);
        // The Sheet as it was before VISA SUBMISSION STATUS: exactly that one header is missing, nothing else shifts.
        assert.deepEqual(validateHeaderRow(PREVIOUS_HEADERS).mismatches.map((m) => [m.problem, m.header]), [["MISSING", "VISA SUBMISSION STATUS"]]);
    });

    test("13. a duplicated system header -> SCHEMA_INVALID (ambiguous), naming the header and where it was found", () => {
        const result = readSheetLayout([...FINAL_HEADERS, "_SYSTEM_CANDIDATE_ID"]);
        assert.equal(result.valid, false);
        assert.deepEqual(result.problems, [{ problem: "DUPLICATE", header: "_SYSTEM_CANDIDATE_ID", expected: 1, found: 2, columns: ["AO", "AP"] }]);
        const thirdPolice = readSheetLayout([...FINAL_HEADERS, "POLICE REP SRI LANKA"]);
        assert.deepEqual(thirdPolice.problems.map((p) => [p.problem, p.header, p.found]), [["DUPLICATE", "POLICE REP SRI LANKA", 3]]);
    });

    test("14. a renamed system header -> SCHEMA_INVALID: text must match exactly (no trimming, no case folding)", () => {
        for (const renamed of ["DRIVING LICENSE", "SCAN ", "scan", " _SYSTEM_CANDIDATE_ID"]) {
            const headers = [...FINAL_HEADERS];
            const target = renamed.trim().toUpperCase().startsWith("_SYSTEM") ? FINAL_HEADERS.indexOf("_SYSTEM_CANDIDATE_ID") : renamed.startsWith("DRIVING") ? 17 : 16;
            headers[target] = renamed;
            const result = readSheetLayout(headers);
            assert.equal(result.valid, false, JSON.stringify(renamed));
            assert.equal(result.problems[0].problem, "MISSING");
        }
    });

    test("the two POLICE REP SRI LANKA columns keep their order relative to each other; each may move anywhere else", () => {
        const others = FINAL_HEADERS.filter((h) => h !== "POLICE REP SRI LANKA");
        const layout = layoutOf(["POLICE REP SRI LANKA", ...others.slice(0, 30), "POLICE REP SRI LANKA", ...others.slice(30)]);
        assert.equal(columnOf(layout, "policeReportSriLankaVerified"), "A", "the left one is SL Verified");
        assert.equal(columnOf(layout, "policeReportSriLankaNormal"), "AF");
        assert.deepEqual(readSheetLayout(without(FINAL_HEADERS, "POLICE REP SRI LANKA")).problems.map((p) => [p.problem, p.found]), [["MISSING", 0]]);
    });

    test("an empty or missing header row is invalid: every system header is missing", () => {
        assert.equal(validateHeaderRow([]).valid, false);
        assert.equal(validateHeaderRow(undefined).mismatches.length, 40, "one problem per distinct header (POLICE REP SRI LANKA counted once)");
    });
});

describe("layout ranges and writes", () => {
    test("row 1 is read whole; data ranges are as wide as the live header", () => {
        assert.equal(headerRange(TAB), `'${TAB}'!1:1`);
        const canonical = layoutOf(FINAL_HEADERS);
        assert.equal(dataRange(TAB, canonical), `'${TAB}'!A2:AO`);
        assert.equal(operationalRange(TAB, canonical), `'${TAB}'!A:AO`);
        assert.equal(rowRange(TAB, 7, canonical), `'${TAB}'!A7:AO7`);
        const wide = layoutOf([...FINAL_HEADERS, "Note 1", "Note 2"]);
        assert.equal(dataRange(TAB, wide), `'${TAB}'!A2:AQ`);
    });

    test("an existing row is written one range per run of system columns, never into an operator column", () => {
        // Canonical: one range, exactly as before this change.
        const canonical = layoutOf(FINAL_HEADERS);
        assert.deepEqual(writeRangesFor(TAB, 7, canonical, NAMED_CELLS), [{ range: `'${TAB}'!A7:AO7`, values: [NAMED_CELLS] }]);

        const layout = layoutOf(["_SYSTEM_CANDIDATE_ID", "Operator Note", "VISA SUBMISSION STATUS", "PASSPORT NUMBER", "Another Note",
            ...FINAL_HEADERS.filter((h) => !["_SYSTEM_CANDIDATE_ID", "VISA SUBMISSION STATUS", "PASSPORT NUMBER"].includes(h))]);
        const writes = writeRangesFor(TAB, 9, layout, NAMED_CELLS);
        assert.deepEqual(writes.map((w) => w.range), [`'${TAB}'!A9:A9`, `'${TAB}'!C9:D9`, `'${TAB}'!F9:AQ9`]);
        assert.deepEqual(writes[0].values, [["systemCandidateId"]]);
        assert.deepEqual(writes[1].values, [["visaSubmissionStatus", "passportNumber"]]);
        assert.equal(writes[2].values[0][0], "testNumber");
        // B and E (the operator columns) are in no range.
        const written = new Set(writes.flatMap((w) => { const [a, b] = w.range.split("!")[1].split(":").map((x) => x.replace(/\d+/g, "")); const out = []; for (let i = fieldColumn(a); i <= fieldColumn(b); i++) out.push(i); return out; }));
        assert.ok(!written.has(1) && !written.has(4));
    });

    test("changed columns are named by their live letters", () => {
        const layout = layoutOf(["_SYSTEM_CANDIDATE_ID", "Operator Note", "VISA SUBMISSION STATUS", ...FINAL_HEADERS.filter((h) => !["_SYSTEM_CANDIDATE_ID", "VISA SUBMISSION STATUS"].includes(h))]);
        const actual = [...NAMED_CELLS];
        actual[field("visaSubmissionStatus").index] = "old";
        actual[field("passportNumber").index] = "old";
        assert.deepEqual(changedColumnLetters(NAMED_CELLS, actual, layout), ["C", "E"]);
    });

    test("the header row can never be addressed as a data row", () => {
        const layout = layoutOf(FINAL_HEADERS);
        assert.throws(() => rowRange(TAB, 1, layout), /data row number/);
        assert.throws(() => rowRange(TAB, 0, layout), /data row number/);
        assert.throws(() => writeRangesFor(TAB, 1, layout, NAMED_CELLS), /data row number/);
    });

    test("a quote in the tab name is escaped; an empty tab name is refused", () => {
        assert.equal(quoteSheetName("Bob's tab"), "'Bob''s tab'");
        assert.throws(() => quoteSheetName(""), /tab name/);
    });
});

// "AQ" -> 42 (0-based index)
function fieldColumn(letters) {
    return [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
}

describe("row shape (field-ordered cells)", () => {
    const row = () => Array.from({ length: 41 }, (_, i) => (i === SYSTEM_CANDIDATE_ID_INDEX ? "0042" : ""));

    test("a 41-string row with a candidate ID is accepted", () => {
        assert.equal(assertSheetRow(row()).length, 41);
    });

    test("a wrong length, a non-string cell or a blank candidate ID is refused", () => {
        assert.throws(() => assertSheetRow(row().slice(0, 40)), /exactly 41/);
        assert.throws(() => assertSheetRow([...row(), ""]), /exactly 41/);
        const withNumber = row();
        withNumber[0] = 5;
        assert.throws(() => assertSheetRow(withNumber), /string/);
        const noId = row();
        noId[SYSTEM_CANDIDATE_ID_INDEX] = " ";
        assert.throws(() => assertSheetRow(noId), /system candidate ID/);
    });
});
