// Google Sheet operational mirror: the one definition of the Sheet's columns
// (Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md, Section 6).
//
// Columns are found by their HEADER TEXT, not by their position. The live
// Sheet may hold the 41 system columns in any order, interleaved with any
// number of operator columns; readSheetLayout() reads row 1 and maps every
// system column to where it is now. Header text stays strict (exact text, no
// trimming, no case folding).
//
// Two orders exist, and only one is positional:
//   - the CANONICAL order below (SHEET_COLUMNS): the order a new Sheet is set
//     up in, and the order of the field-ordered "cells" arrays the mapper,
//     planner and engine work with. It says nothing about the live Sheet.
//   - the LIVE order: whatever row 1 says, read once per sync operation.
// The adapter (googleSheetsAdapter.js) translates between the two at its
// boundary; nothing else touches live positions.
//
// "POLICE REP SRI LANKA" is a required header TWICE (SL Verified, then SL
// Normal). Two columns with the same text can't be told apart by name, so
// those two keep their order RELATIVE TO EACH OTHER (the left one is SL
// Verified); each may still move anywhere else. Every other header must be
// unique. The legacy spelling "DRIVING LICIAN" is kept as it is in the Sheet.
//
// Nothing else may hard-code column letters, header text or ranges: use the
// constants and helpers below.

// Canonical order. `column` is the letter in a Sheet set up in this order
// (the template); `field` is this code's name for the column (unique, unlike
// the headers); `header` is the exact text in row 1.
const COLUMNS = [
    ["A", "TEST NUMBER", "testNumber"],
    ["B", "PASSPORT NUMBER", "passportNumber"],
    ["C", "FIRST NAME", "firstName"],
    ["D", "OTHER NAME", "otherName"],
    ["E", "TEST DATE", "testDate"],
    ["F", "BIRTHDAY", "birthday"],
    ["G", "PP EX DATE", "passportExpiryDate"],
    ["H", "JOB", "job"],
    ["I", "ID NUMBER", "idNumber"],
    ["J", "ADDRESS", "address"],
    ["K", "WHATSAPP NUM", "whatsappNumber"],
    ["L", "CONTACT NUM", "contactNumber"],
    ["M", "PASSPORT COPY", "passportCopy"],
    ["N", "POLICE REP SRI LANKA", "policeReportSriLankaVerified"],
    ["O", "POLICE REP ROMANIA", "policeReportRomania"],
    ["P", "MEDICAL", "medical"],
    ["Q", "SCAN", "scan"],
    ["R", "DRIVING LICIAN", "drivingLicence"],
    ["S", "NATIONAL ID", "nationalId"],
    ["T", "POLICE REPORT APPLIED", "policeReportApplied"],
    ["U", "SUBMIT DATE", "submitDate"],
    ["V", "POLICE REP SRI LANKA", "policeReportSriLankaNormal"],
    ["W", "POLICE REP FM", "policeReportFm"],
    ["X", "VIDEOS", "videos"],
    ["Y", "PLACE OF BIRTH", "placeOfBirth"],
    ["Z", "SEX", "sex"],
    ["AA", "NATIONALITY", "nationality"],
    ["AB", "PASSPORT ISSUE DATE", "passportIssueDate"],
    ["AC", "JOB EXPERIENCE", "jobExperience"],
    ["AD", "CANDIDATE DETAILS NOTE", "candidateDetailsNote"],
    ["AE", "TEST DETAILS STATUS", "testDetailsStatus"],
    ["AF", "CANDIDATE DETAILS STATUS", "candidateDetailsStatus"],
    ["AG", "DOCUMENT SUBMISSION STATUS", "documentSubmissionStatus"],
    ["AH", "IVS INTERVIEW STATUS", "ivsInterviewStatus"],
    ["AI", "VISA SUBMISSION STATUS", "visaSubmissionStatus"],
    ["AJ", "VISA APPROVAL STATUS", "visaApprovalStatus"],
    ["AK", "FINALIZING JOB STATUS", "finalizingJobStatus"],
    ["AL", "RECORD STATUS", "recordStatus"],
    ["AM", "REGISTERED AT", "registeredAt"],
    ["AN", "LAST MIRRORED AT", "lastMirroredAt"],
    ["AO", "_SYSTEM_CANDIDATE_ID", "systemCandidateId"],
];

// 0 -> "A", 25 -> "Z", 26 -> "AA", 52 -> "BA", 701 -> "ZZ", 702 -> "AAA".
export function columnLetter(index) {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("A column index must be a whole number from 0");
    let n = index + 1;
    let letters = "";
    while (n > 0) {
        const rest = (n - 1) % 26;
        letters = String.fromCharCode(65 + rest) + letters;
        n = Math.floor((n - 1) / 26);
    }
    return letters;
}

export const SHEET_COLUMNS = Object.freeze(COLUMNS.map(([column, header, field], index) => Object.freeze({ index, column, header, field })));

// The system columns: 40 business columns and the technical identity. The
// live Sheet may have more columns (operator columns), never fewer.
export const SHEET_COLUMN_COUNT = 41;
export const SHEET_BUSINESS_COLUMN_COUNT = 40;
export const SHEET_HEADER_ROW = 1;
export const SHEET_FIRST_DATA_ROW = 2;

// The system headers in canonical order.
export const SHEET_HEADERS = Object.freeze(SHEET_COLUMNS.map((c) => c.header));

// The technical row identity (users.unique_id). Never the passport number or
// NIC, never a row number, never a position: found by this header wherever it is.
export const SYSTEM_CANDIDATE_ID_FIELD = "systemCandidateId";
export const SYSTEM_CANDIDATE_ID_INDEX = SHEET_COLUMNS.findIndex((c) => c.field === SYSTEM_CANDIDATE_ID_FIELD);
export const SYSTEM_CANDIDATE_ID_HEADER = SHEET_COLUMNS[SYSTEM_CANDIDATE_ID_INDEX].header;

// Canonical index of a field.
export function fieldIndex(field) {
    const index = SHEET_COLUMNS.findIndex((c) => c.field === field);
    if (index === -1) throw new Error(`Unknown Google Sheet field ${field}`);
    return index;
}

// header text -> the canonical indexes that carry it, in canonical order
// (one, except POLICE REP SRI LANKA: two).
const CANONICAL_BY_HEADER = new Map();
for (const c of SHEET_COLUMNS) CANONICAL_BY_HEADER.set(c.header, [...(CANONICAL_BY_HEADER.get(c.header) ?? []), c.index]);

// Fail at load time, not at the first write, if the table above is ever
// edited inconsistently (wrong count, a letter out of place, a repeated field
// name, no identity column).
(function checkSchema() {
    const problems = [];
    if (SHEET_COLUMNS.length !== SHEET_COLUMN_COUNT) problems.push(`expected ${SHEET_COLUMN_COUNT} columns, found ${SHEET_COLUMNS.length}`);
    SHEET_COLUMNS.forEach((c) => {
        if (c.column !== columnLetter(c.index)) problems.push(`column ${c.index + 1} is ${c.column}, expected ${columnLetter(c.index)}`);
    });
    if (new Set(SHEET_COLUMNS.map((c) => c.field)).size !== SHEET_COLUMNS.length) problems.push("field names must be unique");
    if (SYSTEM_CANDIDATE_ID_INDEX === -1) problems.push("the system candidate ID column is missing");
    if (problems.length) throw new Error(`Invalid Google Sheet schema: ${problems.join("; ")}`);
})();

// ---------------------------------------------------------------- live layout

const cellText = (value) => (value === undefined || value === null ? "" : String(value));

// Reads row 1 as the Sheet returned it and maps every system column to its
// live position. The one place header lookup happens.
//
// Returns { valid, problems, layout }:
//   problems: [{ problem, header, expected, found, columns }]
//     MISSING    a system header appears fewer times than required (absent,
//                or renamed: header text must match exactly)
//     DUPLICATE  a system header appears more times than required, so its
//                column would be ambiguous
//     `header` is our own expected header text, `columns` the live letters
//     where it was found; the Sheet's other header text is never echoed.
//   layout (only when valid): frozen
//     width        live header width (up to the last non-empty header cell)
//     header       row 1 as read (width cells), to detect a change mid-run
//     positions    canonical index -> live column index
//     extraColumns how many columns are not system columns
//     runs         contiguous runs of system columns, for writes that never
//                  touch an operator column: [{ start, end, canonical: [...] }]
// Unknown (operator) headers and blank header cells are allowed and ignored.
export function readSheetLayout(headerRow) {
    const row = (Array.isArray(headerRow) ? headerRow : []).map(cellText);
    let width = row.length;
    while (width > 0 && row[width - 1] === "") width--;

    const found = new Map();
    for (let i = 0; i < width; i++) {
        if (CANONICAL_BY_HEADER.has(row[i])) found.set(row[i], [...(found.get(row[i]) ?? []), i]);
    }

    const problems = [];
    const positions = new Array(SHEET_COLUMN_COUNT);
    for (const [header, canonical] of CANONICAL_BY_HEADER) {
        const live = found.get(header) ?? [];
        if (live.length !== canonical.length) {
            problems.push({
                problem: live.length < canonical.length ? "MISSING" : "DUPLICATE",
                header,
                expected: canonical.length,
                found: live.length,
                columns: live.map(columnLetter),
            });
            continue;
        }
        // Left to right: a repeated header's columns keep their relative order.
        canonical.forEach((canonicalIndex, k) => { positions[canonicalIndex] = live[k]; });
    }
    if (problems.length) return { valid: false, problems, layout: null };

    const byLive = positions.map((live, canonicalIndex) => ({ live, canonicalIndex })).sort((a, b) => a.live - b.live);
    const runs = [];
    for (const { live, canonicalIndex } of byLive) {
        const last = runs.at(-1);
        if (last && last.end === live - 1) {
            last.end = live;
            last.canonical.push(canonicalIndex);
        } else {
            runs.push({ start: live, end: live, canonical: [canonicalIndex] });
        }
    }

    const layout = Object.freeze({
        width,
        header: Object.freeze(row.slice(0, width)),
        positions: Object.freeze(positions),
        extraColumns: width - SHEET_COLUMN_COUNT,
        runs: Object.freeze(runs.map((r) => Object.freeze({ start: r.start, end: r.end, canonical: Object.freeze(r.canonical) }))),
    });
    return { valid: true, problems: [], layout };
}

// The live letter of a field's column.
export function columnOf(layout, field) {
    return columnLetter(layout.positions[fieldIndex(field)]);
}

// A live row (as read, any width) -> field-ordered cells (canonical order,
// SHEET_COLUMN_COUNT strings). Operator columns are not part of the result.
export function toFieldCells(liveRow, layout) {
    const row = Array.isArray(liveRow) ? liveRow : [];
    return SHEET_COLUMNS.map((c) => cellText(row[layout.positions[c.index]]));
}

// Field-ordered cells -> a new live-width row: system values at their live
// positions, "" in operator columns. Only for a NEW row (an append); an
// existing row is written through writeRangesFor so operator cells are never touched.
export function toLiveRow(cells, layout) {
    const row = new Array(layout.width).fill("");
    SHEET_COLUMNS.forEach((c) => { row[layout.positions[c.index]] = cells[c.index]; });
    return row;
}

// Letters of the live columns whose field-ordered cells differ, in live
// order. `ignore`: fields left out of the comparison.
export function changedColumnLetters(expectedCells, actualCells, layout, ignore = new Set()) {
    return SHEET_COLUMNS
        .filter((c) => !ignore.has(c.field) && expectedCells[c.index] !== (actualCells?.[c.index] ?? ""))
        .map((c) => layout.positions[c.index])
        .sort((a, b) => a - b)
        .map(columnLetter);
}

// ---------------------------------------------------------------- ranges (A1 notation)

// A tab name in A1 notation: always quoted (the real tab name has spaces),
// with any single quote doubled.
export function quoteSheetName(tabName) {
    if (typeof tabName !== "string" || tabName.trim() === "") {
        throw new Error("A Google Sheet tab name is required");
    }
    return `'${tabName.replace(/'/g, "''")}'`;
}

const assertRowNumber = (rowNumber) => {
    if (!Number.isSafeInteger(rowNumber) || rowNumber < SHEET_FIRST_DATA_ROW) {
        throw new Error(`A data row number must be a whole number from ${SHEET_FIRST_DATA_ROW}`);
    }
};

const lastLetter = (layout) => columnLetter(layout.width - 1);

// Row 1, however wide: 'Tab'!1:1
export const headerRange = (tabName) => `${quoteSheetName(tabName)}!${SHEET_HEADER_ROW}:${SHEET_HEADER_ROW}`;

// Every data row, as wide as the live header: 'Tab'!A2:<last>
export const dataRange = (tabName, layout) => `${quoteSheetName(tabName)}!A${SHEET_FIRST_DATA_ROW}:${lastLetter(layout)}`;

// The live columns, for an append: 'Tab'!A:<last>
export const operationalRange = (tabName, layout) => `${quoteSheetName(tabName)}!A:${lastLetter(layout)}`;

// One data row, as wide as the live header: 'Tab'!A7:<last>7
export function rowRange(tabName, rowNumber, layout) {
    assertRowNumber(rowNumber);
    return `${quoteSheetName(tabName)}!A${rowNumber}:${lastLetter(layout)}${rowNumber}`;
}

// The live candidate ID column below the header: 'Tab'!<id>2:<id>
export function candidateIdRange(tabName, layout) {
    const id = columnOf(layout, SYSTEM_CANDIDATE_ID_FIELD);
    return `${quoteSheetName(tabName)}!${id}${SHEET_FIRST_DATA_ROW}:${id}`;
}

// The writes for one existing row: one range per contiguous run of system
// columns, so operator columns between them are never written.
// [{ range, values: [[...]] }]
export function writeRangesFor(tabName, rowNumber, layout, cells) {
    assertRowNumber(rowNumber);
    const tab = quoteSheetName(tabName);
    return layout.runs.map((run) => ({
        range: `${tab}!${columnLetter(run.start)}${rowNumber}:${columnLetter(run.end)}${rowNumber}`,
        values: [run.canonical.map((canonicalIndex) => cells[canonicalIndex])],
    }));
}

// ---------------------------------------------------------------- validation

// Validates row 1 by header name: every system header present exactly as many
// times as required, in any order, with any operator columns around them.
// Returns { valid, mismatches } (mismatches = readSheetLayout's problems).
export function validateHeaderRow(actualRow) {
    const { valid, problems } = readSheetLayout(actualRow);
    return { valid, mismatches: problems };
}

// A field-ordered row: exactly SHEET_COLUMN_COUNT strings, with a non-empty
// system candidate ID. Throws otherwise (the caller has a bug, not the data).
export function assertSheetRow(cells) {
    if (!Array.isArray(cells) || cells.length !== SHEET_COLUMN_COUNT) {
        throw new Error(`A Google Sheet row must have exactly ${SHEET_COLUMN_COUNT} cells`);
    }
    if (!cells.every((cell) => typeof cell === "string")) {
        throw new Error("Every Google Sheet cell must be a string");
    }
    if (cells[SYSTEM_CANDIDATE_ID_INDEX].trim() === "") {
        throw new Error(`A Google Sheet row must carry the system candidate ID (${SYSTEM_CANDIDATE_ID_HEADER})`);
    }
    return cells;
}
