// Google Sheet "Candidate Form Submissions" tab: the one definition of its columns and of how a
// submission becomes a row. Separate from sheetSchema.js (the 41-column operational mirror),
// which is not touched: the two tabs share only the spreadsheet.
//
// Like the mirror, columns are found by their HEADER TEXT (exact text), so the tab may hold the
// columns below in any order, with any operator columns around them. Every column below must be
// present exactly once. The columns:
//   _SYSTEM_CANDIDATE_ID  candidate.unique_id (the stable technical ID; never the passport or NIC)
//   _SUBMISSION_ID        candidate_form_sheet_sync.submission_id (stable per submission): THE row key
//   Passport Number, Candidate Name, Submitted At (UTC), Submission Status
//   every answer of the Candidate Form (ANSWER_FIELDS of candidateFormDataService.js) + WhatsApp Number
// Nothing about the share link or the candidate session is ever a column: no link ID, secret,
// token hash, token, IP address or idempotency key.

import { columnLetter, quoteSheetName } from "./sheetSchema.js";

// header text, field (this code's name), source. source: "row" (computed from the submission),
// or a candidate_form_response column.
const COLUMNS = [
    ["_SYSTEM_CANDIDATE_ID", "systemCandidateId", "row"],
    ["_SUBMISSION_ID", "submissionId", "row"],
    ["Passport Number", "passportNumber", "row"],
    ["Candidate Name", "candidateName", "row"],
    ["Submitted At", "submittedAt", "row"],
    ["Submission Status", "submissionStatus", "row"],
    ["Full Name", "fullName", "fullName"],
    ["Surname", "surname", "surname"],
    ["Other Names", "otherNames", "otherNames"],
    ["NIC Number", "nic", "nic"],
    ["Sex", "sex", "sex"],
    ["Civil Status", "civilStatus", "civilStatus"],
    ["Birth Date", "birthDate", "birthDate"],
    ["Birth Place", "birthPlace", "birthPlace"],
    ["Address", "address", "address"],
    ["City", "city", "city"],
    ["District", "district", "district"],
    ["DS Division", "dsDivision", "dsDivision"],
    ["GN Division", "gnDivision", "gnDivision"],
    ["WhatsApp Number", "whatsappNumber", "row"],
    ["Alternative Contact Number", "alternativePhone", "alternativePhone"],
    ["Email", "email", "email"],
    ["Passport Issue Date", "passportIssueDate", "passportIssueDate"],
    ["Passport Expiry Date", "passportExpiryDate", "passportExpiryDate"],
    ["Job Category", "jobCategory", "jobCategory"],
    ["Other Job Category", "jobCategoryOther", "jobCategoryOther"],
    ["Experience", "experience", "experience"],
    ["Other Skills 1", "otherSkills1", "otherSkills1"],
    ["Other Skills 2", "otherSkills2", "otherSkills2"],
    ["English Knowledge", "englishKnowledge", "englishKnowledge"],
    ["Shirt Size", "shirtSize", "shirtSize"],
    ["Waist Size", "waistSize", "waistSize"],
    ["Shoe Size", "shoeSize", "shoeSize"],
    ["Father Name", "fatherName", "fatherName"],
    ["Father Surname", "fatherSurname", "fatherSurname"],
    ["Father Passport Number", "fatherPassportNumber", "fatherPassportNumber"],
    ["Father Birth Date", "fatherBirthDate", "fatherBirthDate"],
    ["Mother Name", "motherName", "motherName"],
    ["Mother Surname", "motherSurname", "motherSurname"],
    ["Mother Passport Number", "motherPassportNumber", "motherPassportNumber"],
    ["Mother Birth Date", "motherBirthDate", "motherBirthDate"],
    ["Spouse Name", "spouseName", "spouseName"],
    ["Spouse Surname", "spouseSurname", "spouseSurname"],
    ["Spouse Passport Number", "spousePassportNumber", "spousePassportNumber"],
    ["Spouse Birth Date", "spouseBirthDate", "spouseBirthDate"],
    ["Child 1 Name", "child1Name", "child1Name"],
    ["Child 2 Name", "child2Name", "child2Name"],
    ["Child 3 Name", "child3Name", "child3Name"],
    ["Guardian Name", "guardianName", "guardianName"],
    ["Guardian Relationship", "guardianRelationship", "guardianRelationship"],
    ["Guardian NIC", "guardianNic", "guardianNic"],
    ["Guardian Birth Date", "guardianBirthDate", "guardianBirthDate"],
    ["Guardian Phone", "guardianPhone", "guardianPhone"],
    ["Guardian Address", "guardianAddress", "guardianAddress"],
];

// Answers of the Candidate Form that are NOT columns of this tab yet (the Personal Details and
// parents' alive answers of migration 20261101120000_candidate_form_personal_details). Every
// column above must already be in the live tab's header (readFormSubmissionLayout), so adding
// one here before the operators add its header to the Sheet would stop every sync. They are
// stored in candidate_form_response and shown in Admin; add them here together with the Sheet.
export const ANSWER_COLUMNS_NOT_IN_SHEET = Object.freeze(new Set([
    "bloodGroup", "height", "weightKg", "drivingLicence", "canReadDrawings", "teamLeadingSkills", "otherLanguages",
    "cityInRomania", "fatherAlive", "motherAlive",
]));

export const FORM_SUBMISSION_COLUMNS = Object.freeze(COLUMNS.map(([header, field, source], index) => Object.freeze({ index, header, field, source })));
export const FORM_SUBMISSION_COLUMN_COUNT = FORM_SUBMISSION_COLUMNS.length;
export const FORM_SUBMISSION_HEADERS = Object.freeze(FORM_SUBMISSION_COLUMNS.map((c) => c.header));
export const FORM_SUBMISSION_HEADER_ROW = 1;
export const FORM_SUBMISSION_FIRST_DATA_ROW = 2;
export const SUBMISSION_STATUS = Object.freeze({ SUBMITTED: "SUBMITTED" });

const indexOfField = (field) => FORM_SUBMISSION_COLUMNS.findIndex((c) => c.field === field);
export const SYSTEM_CANDIDATE_ID_INDEX = indexOfField("systemCandidateId");
export const SUBMISSION_ID_INDEX = indexOfField("submissionId");
export const SUBMISSION_ID_HEADER = FORM_SUBMISSION_COLUMNS[SUBMISSION_ID_INDEX].header;

// The response columns holding a date (YYYY-MM-DD).
const DATE_FIELDS = new Set(["birthDate", "passportIssueDate", "passportExpiryDate", "fatherBirthDate", "motherBirthDate", "spouseBirthDate", "guardianBirthDate"]);

// Fail at load time if the table above is ever edited inconsistently.
(function checkSchema() {
    const problems = [];
    if (new Set(FORM_SUBMISSION_HEADERS).size !== FORM_SUBMISSION_COLUMN_COUNT) problems.push("headers must be unique");
    if (new Set(FORM_SUBMISSION_COLUMNS.map((c) => c.field)).size !== FORM_SUBMISSION_COLUMN_COUNT) problems.push("field names must be unique");
    if (SYSTEM_CANDIDATE_ID_INDEX === -1 || SUBMISSION_ID_INDEX === -1) problems.push("the system candidate ID and submission ID columns are required");
    if (FORM_SUBMISSION_HEADERS.some((h) => h !== h.trim() || h === "")) problems.push("headers must be non-empty and trimmed");
    if (problems.length) throw new Error(`Invalid Candidate Form Submissions schema: ${problems.join("; ")}`);
})();

// ---------------------------------------------------------------- row

const toDate = (value) => {
    if (value === undefined || value === null || value === "") return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};
const dateOnly = (value) => toDate(value)?.toISOString().slice(0, 10) ?? "";
const utcTimestamp = (value) => toDate(value)?.toISOString().replace(/\.\d{3}Z$/, "Z") ?? "";
const text = (value) => (value === undefined || value === null ? "" : String(value));

// One submission -> field-ordered cells (FORM_SUBMISSION_COLUMN_COUNT strings, in the order above).
//   submissionId  candidate_form_sheet_sync.submission_id
//   candidate     { uniqueId, passportId, firstName, otherName, whatsappNumber } (the candidate's record)
//   response      the candidate_form_response row
export function buildSubmissionCells({ submissionId, candidate, response }) {
    const computed = {
        systemCandidateId: text(candidate.uniqueId),
        submissionId: text(submissionId),
        passportNumber: text(candidate.passportId),
        candidateName: text(response.fullName) || [candidate.firstName, candidate.otherName].filter((part) => text(part).trim()).join(" "),
        submittedAt: utcTimestamp(response.submittedAt),
        submissionStatus: SUBMISSION_STATUS.SUBMITTED,
        whatsappNumber: text(candidate.whatsappNumber),
    };
    return FORM_SUBMISSION_COLUMNS.map((c) => {
        if (c.source === "row") return computed[c.field];
        return DATE_FIELDS.has(c.field) ? dateOnly(response[c.source]) : text(response[c.source]);
    });
}

// ---------------------------------------------------------------- live layout

const cellText = (value) => (value === undefined || value === null ? "" : String(value));

// Reads row 1 as the Sheet returned it and maps every column to its live position.
// Returns { valid, empty, problems, layout }. empty: row 1 has no header at all (a new tab).
// problems: [{ problem: "MISSING" | "DUPLICATE", header, expected, found, columns }] (our own
// header names and letters, never the Sheet's other text). layout (when valid): frozen
//   width, header (as read, to detect a change mid-run), positions (canonical index -> live
//   index), runs (contiguous runs of our columns, so an existing row is written without
//   touching an operator column).
export function readFormSubmissionLayout(headerRow) {
    const row = (Array.isArray(headerRow) ? headerRow : []).map(cellText);
    let width = row.length;
    while (width > 0 && row[width - 1] === "") width--;
    if (width === 0) return { valid: false, empty: true, problems: [], layout: null };

    const found = new Map();
    for (let i = 0; i < width; i++) if (FORM_SUBMISSION_HEADERS.includes(row[i])) found.set(row[i], [...(found.get(row[i]) ?? []), i]);

    const problems = [];
    const positions = new Array(FORM_SUBMISSION_COLUMN_COUNT);
    for (const c of FORM_SUBMISSION_COLUMNS) {
        const live = found.get(c.header) ?? [];
        if (live.length !== 1) {
            problems.push({ problem: live.length < 1 ? "MISSING" : "DUPLICATE", header: c.header, expected: 1, found: live.length, columns: live.map(columnLetter) });
            continue;
        }
        positions[c.index] = live[0];
    }
    if (problems.length) return { valid: false, empty: false, problems, layout: null };

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
    return {
        valid: true,
        empty: false,
        problems: [],
        layout: Object.freeze({
            width,
            header: Object.freeze(row.slice(0, width)),
            positions: Object.freeze(positions),
            runs: Object.freeze(runs.map((r) => Object.freeze({ start: r.start, end: r.end, canonical: Object.freeze(r.canonical) }))),
        }),
    };
}

// A new row at its live width: our values at their live positions, "" in operator columns.
export function toLiveRow(cells, layout) {
    const row = new Array(layout.width).fill("");
    FORM_SUBMISSION_COLUMNS.forEach((c) => { row[layout.positions[c.index]] = cells[c.index]; });
    return row;
}

// A field-ordered row: exactly FORM_SUBMISSION_COLUMN_COUNT strings with both stable IDs.
export function assertSubmissionRow(cells) {
    if (!Array.isArray(cells) || cells.length !== FORM_SUBMISSION_COLUMN_COUNT || !cells.every((cell) => typeof cell === "string")) {
        throw new Error(`A Candidate Form Submissions row must have exactly ${FORM_SUBMISSION_COLUMN_COUNT} text cells`);
    }
    if (cells[SYSTEM_CANDIDATE_ID_INDEX].trim() === "" || cells[SUBMISSION_ID_INDEX].trim() === "") {
        throw new Error("A Candidate Form Submissions row must carry the system candidate ID and the submission ID");
    }
    return cells;
}

// ---------------------------------------------------------------- ranges (A1 notation)

const assertRowNumber = (rowNumber) => {
    if (!Number.isSafeInteger(rowNumber) || rowNumber < FORM_SUBMISSION_FIRST_DATA_ROW) {
        throw new Error(`A data row number must be a whole number from ${FORM_SUBMISSION_FIRST_DATA_ROW}`);
    }
};

// Row 1, however wide.
export const formHeaderRange = (tabName) => `${quoteSheetName(tabName)}!${FORM_SUBMISSION_HEADER_ROW}:${FORM_SUBMISSION_HEADER_ROW}`;
// Where a new tab's header goes: A1 across our columns.
export const formHeaderWriteRange = (tabName) => `${quoteSheetName(tabName)}!A${FORM_SUBMISSION_HEADER_ROW}:${columnLetter(FORM_SUBMISSION_COLUMN_COUNT - 1)}${FORM_SUBMISSION_HEADER_ROW}`;
// The live columns, for an append.
export const formAppendRange = (tabName, layout) => `${quoteSheetName(tabName)}!A:${columnLetter(layout.width - 1)}`;
// The live _SUBMISSION_ID column below the header.
export function submissionIdRange(tabName, layout) {
    const letter = columnLetter(layout.positions[SUBMISSION_ID_INDEX]);
    return `${quoteSheetName(tabName)}!${letter}${FORM_SUBMISSION_FIRST_DATA_ROW}:${letter}`;
}
// The writes for one existing row: one range per run of our columns (operator columns untouched).
export function formWriteRangesFor(tabName, rowNumber, layout, cells) {
    assertRowNumber(rowNumber);
    const tab = quoteSheetName(tabName);
    return layout.runs.map((run) => ({
        range: `${tab}!${columnLetter(run.start)}${rowNumber}:${columnLetter(run.end)}${rowNumber}`,
        values: [run.canonical.map((canonicalIndex) => cells[canonicalIndex])],
    }));
}
