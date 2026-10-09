// Google Sheet operational mirror: the one definition of the Sheet's columns
// (Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md, Section 6).
//
// The real Sheet was finalized by hand: 40 business columns (A-AN) and one
// technical identity column (AO, _SYSTEM_CANDIDATE_ID = users.unique_id),
// 41 columns in all. Header text and position are both part of the
// contract. VISA SUBMISSION STATUS (AI) was added with the Visa submission
// stage: the live Sheet gets it by inserting one column left of VISA
// APPROVAL STATUS, which moves every later column (and the identity) right. "POLICE REP SRI LANKA" appears twice (N and V) on purpose, so a
// column is only ever identified by its position or its `field` name here,
// never by looking its header up. The legacy spelling "DRIVING LICIAN" is
// kept as it is in the Sheet.
//
// Nothing else may hard-code column letters, header text or ranges: use the
// constants and helpers below.

// In Sheet order. `field` is this code's name for the column (unique, unlike
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

// 0 -> "A", 25 -> "Z", 26 -> "AA", 40 -> "AO".
export function columnLetter(index) {
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

export const SHEET_COLUMN_COUNT = 41;
export const SHEET_BUSINESS_COLUMN_COUNT = 40;
export const SHEET_FIRST_COLUMN = "A";
export const SHEET_LAST_COLUMN = "AO";
export const SHEET_HEADER_ROW = 1;
export const SHEET_FIRST_DATA_ROW = 2;

// Expected row 1, in order.
export const SHEET_HEADERS = Object.freeze(SHEET_COLUMNS.map((c) => c.header));

// The technical row identity (users.unique_id). Never the passport number or NIC.
export const SYSTEM_CANDIDATE_ID_FIELD = "systemCandidateId";
export const SYSTEM_CANDIDATE_ID_INDEX = SHEET_COLUMNS.findIndex((c) => c.field === SYSTEM_CANDIDATE_ID_FIELD);
export const SYSTEM_CANDIDATE_ID_COLUMN = SHEET_COLUMNS[SYSTEM_CANDIDATE_ID_INDEX].column;

// Fail at load time, not at the first write, if the table above is ever
// edited inconsistently (wrong count, a letter out of place, a repeated field
// name, the key not in the last column).
(function checkSchema() {
    const problems = [];
    if (SHEET_COLUMNS.length !== SHEET_COLUMN_COUNT) problems.push(`expected ${SHEET_COLUMN_COUNT} columns, found ${SHEET_COLUMNS.length}`);
    SHEET_COLUMNS.forEach((c) => {
        if (c.column !== columnLetter(c.index)) problems.push(`column ${c.index + 1} is ${c.column}, expected ${columnLetter(c.index)}`);
    });
    if (new Set(SHEET_COLUMNS.map((c) => c.field)).size !== SHEET_COLUMNS.length) problems.push("field names must be unique");
    if (SHEET_COLUMNS.at(-1).column !== SHEET_LAST_COLUMN) problems.push(`last column must be ${SHEET_LAST_COLUMN}`);
    if (SYSTEM_CANDIDATE_ID_INDEX !== SHEET_COLUMN_COUNT - 1) problems.push("the system candidate ID must be the last column");
    if (problems.length) throw new Error(`Invalid Google Sheet schema: ${problems.join("; ")}`);
})();

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

// Row 1: 'Tab'!A1:AO1
export const headerRange = (tabName) => `${quoteSheetName(tabName)}!${SHEET_FIRST_COLUMN}${SHEET_HEADER_ROW}:${SHEET_LAST_COLUMN}${SHEET_HEADER_ROW}`;

// Every data row: 'Tab'!A2:AO
export const dataRange = (tabName) => `${quoteSheetName(tabName)}!${SHEET_FIRST_COLUMN}${SHEET_FIRST_DATA_ROW}:${SHEET_LAST_COLUMN}`;

// The operational columns, for an append: 'Tab'!A:AO
export const operationalRange = (tabName) => `${quoteSheetName(tabName)}!${SHEET_FIRST_COLUMN}:${SHEET_LAST_COLUMN}`;

// One data row: 'Tab'!A7:AO7
export function rowRange(tabName, rowNumber) {
    assertRowNumber(rowNumber);
    return `${quoteSheetName(tabName)}!${SHEET_FIRST_COLUMN}${rowNumber}:${SHEET_LAST_COLUMN}${rowNumber}`;
}

// The candidate ID column below the header: 'Tab'!AO2:AO
export const candidateIdRange = (tabName) => `${quoteSheetName(tabName)}!${SYSTEM_CANDIDATE_ID_COLUMN}${SHEET_FIRST_DATA_ROW}:${SYSTEM_CANDIDATE_ID_COLUMN}`;

// ---------------------------------------------------------------- validation

// Compares a row 1 read from the Sheet with the expected headers, position
// by position and with exact text (no trimming, no case folding). Cells the
// Sheet leaves out at the end count as empty. Returns { valid, mismatches },
// each mismatch { column, position, expected, actual }; `expected` is null
// for an unexpected non-empty cell beyond AO.
export function validateHeaderRow(actualRow) {
    const row = Array.isArray(actualRow) ? actualRow : [];
    const mismatches = [];
    SHEET_COLUMNS.forEach((c) => {
        const actual = row[c.index] ?? "";
        if (actual !== c.header) {
            mismatches.push({ column: c.column, position: c.index + 1, expected: c.header, actual: String(actual) });
        }
    });
    row.slice(SHEET_COLUMN_COUNT).forEach((value, offset) => {
        if (value !== "" && value !== null && value !== undefined) {
            const index = SHEET_COLUMN_COUNT + offset;
            mismatches.push({ column: columnLetter(index), position: index + 1, expected: null, actual: String(value) });
        }
    });
    return { valid: mismatches.length === 0, mismatches };
}

// A complete row in Sheet order: exactly 41 strings, with a non-empty
// system candidate ID. Throws otherwise (the caller has a bug, not the data).
export function assertSheetRow(cells) {
    if (!Array.isArray(cells) || cells.length !== SHEET_COLUMN_COUNT) {
        throw new Error(`A Google Sheet row must have exactly ${SHEET_COLUMN_COUNT} cells`);
    }
    if (!cells.every((cell) => typeof cell === "string")) {
        throw new Error("Every Google Sheet cell must be a string");
    }
    if (cells[SYSTEM_CANDIDATE_ID_INDEX].trim() === "") {
        throw new Error(`A Google Sheet row must carry the system candidate ID (${SYSTEM_CANDIDATE_ID_COLUMN})`);
    }
    return cells;
}
