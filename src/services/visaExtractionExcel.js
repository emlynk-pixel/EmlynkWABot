// Visa Submission Phase 2: the two Excel files of a Client in VISA SUBMISSION/{date}/Plan B/
// (visaExtractionService.js writes them under the per-(date, Client) lock):
//   Candidate_Details_{Client}.xlsx  First name | Last name | Passport number | Profession
//   Extra_Details_{Client}.xlsx      a title row, then the eleven columns of EXTRA_DETAILS_HEADERS
// Each run adds its candidates in extraction order; a passport number that already has a row (the same
// day's re-extraction after a re-upload) has that row updated instead, so a retried or repeated batch
// never duplicates a row. Every text cell passes spreadsheetSafe (no formula injection).

import { spreadsheetSafe } from "./auditLogExportWriters.js";
import { mapEnglishKnowledge } from "./englishKnowledgeLevels.js";

export const CANDIDATE_DETAILS_HEADERS = Object.freeze(["First name", "Last name", "Passport number", "Profession"]);
export const EXTRA_DETAILS_HEADERS = Object.freeze([
    "GROUP",
    "Running No.",
    "Candidate's First Name",
    "Candidate's Last Name",
    "Primary Trade מקצוע ראשי",
    "Secondary Trade מקצוע משני / Soft skill",
    "PP No.",
    "Communication Skills ידע אנגלית-רמת תקשורת",
    "cloths size",
    "Pant size",
    "Shoe size",
]);
export const extraDetailsTitle = (clientName) => `EXTRA DETAIL FOR (${clientName})`;

// Columns (1-based) the rows are keyed and numbered by.
const CANDIDATE_PASSPORT_COLUMN = 3;
const EXTRA_RUNNING_COLUMN = 2;
const EXTRA_PASSPORT_COLUMN = 7;
const CANDIDATE_FIRST_ROW = 2;
const EXTRA_FIRST_ROW = 3;

const YELLOW = "FFFFFF00";
const DARK_BLUE = "FF1F3864";
const WHITE = "FFFFFFFF";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const cell = (value) => spreadsheetSafe(text(value));

// "Can Read Drawings: Yes, Team Leading: Yes, Languages: …", only the parts that are recorded.
export function softSkillsOf(details) {
    const parts = [];
    if (details?.canReadDrawings === true) parts.push("Can Read Drawings: Yes");
    if (details?.teamLeadingSkills === true) parts.push("Team Leading: Yes");
    if (text(details?.otherLanguages)) parts.push(`Languages: ${text(details.otherLanguages)}`);
    return parts.join(", ");
}

// candidate: { passportId, firstName, otherName, additionalDetails (or null) }; Last name is other_name.
export const candidateDetailsValues = (candidate) => [cell(candidate.firstName), cell(candidate.otherName), cell(candidate.passportId), ""];

// The Extra Details values except Running No. (column 2, set when the row is written).
export function extraDetailsValues(candidate, primaryTrade) {
    const details = candidate.additionalDetails ?? null;
    return [
        "",
        null,
        cell(candidate.firstName),
        cell(candidate.otherName),
        cell(primaryTrade),
        cell(softSkillsOf(details)),
        cell(candidate.passportId),
        cell(mapEnglishKnowledge(details?.englishKnowledge ?? null)),
        cell(details?.tshirtSize),
        cell(details?.pantSize),
        cell(details?.shoeSize),
    ];
}

const loadExcel = async () => (await import("exceljs")).default;

// A cell's text as a row key (a guarded value's leading apostrophe ignored).
const keyOf = (value) => text(value?.text ?? value).replace(/^'/, "").toUpperCase();

// Row numbers of the data rows by passport number, and the last used row.
function indexRows(sheet, firstRow, passportColumn) {
    const byPassport = new Map();
    let lastRow = firstRow - 1;
    for (let r = firstRow; r <= sheet.rowCount; r += 1) {
        const row = sheet.getRow(r);
        if (!row.hasValues) continue;
        lastRow = r;
        const key = keyOf(row.getCell(passportColumn));
        if (key && !byPassport.has(key)) byPassport.set(key, r);
    }
    return { byPassport, lastRow };
}

// Writes values onto a row; on an existing row the columns in `keep` are left as they are.
function writeRow(row, values, keep = []) {
    values.forEach((value, index) => {
        const column = index + 1;
        if (keep.includes(column) || value === null) return;
        row.getCell(column).value = value;
    });
}

function newCandidateDetailsBook(ExcelJS) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Candidate Details");
    sheet.columns = [{ width: 24 }, { width: 24 }, { width: 18 }, { width: 24 }];
    const header = sheet.getRow(1);
    header.values = [...CANDIDATE_DETAILS_HEADERS];
    header.font = { bold: true };
    return workbook;
}

function newExtraDetailsBook(ExcelJS, clientName) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Extra Details");
    sheet.columns = [10, 12, 22, 22, 26, 40, 14, 26, 12, 12, 12].map((width) => ({ width }));
    const lastColumn = EXTRA_DETAILS_HEADERS.length;
    sheet.mergeCells(1, 1, 1, lastColumn);
    const title = sheet.getCell(1, 1);
    title.value = spreadsheetSafe(extraDetailsTitle(clientName));
    title.font = { bold: true };
    title.alignment = { horizontal: "center", vertical: "middle" };
    title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: YELLOW } };
    const header = sheet.getRow(2);
    header.values = [...EXTRA_DETAILS_HEADERS];
    for (let c = 1; c <= lastColumn; c += 1) {
        const headerCell = header.getCell(c);
        headerCell.font = { bold: true, color: { argb: WHITE } };
        headerCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: DARK_BLUE } };
        headerCell.alignment = { wrapText: true, vertical: "middle", horizontal: "center" };
    }
    return workbook;
}

async function workbookFrom(ExcelJS, existing, create) {
    if (!existing) return create();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(existing);
    if (!workbook.worksheets[0]) throw new Error("The stored workbook has no worksheet");
    return workbook;
}

// existing: the stored file (Buffer) or null for a new one. Returns the new file's Buffer.
export async function upsertCandidateDetails(existing, candidates) {
    const ExcelJS = await loadExcel();
    const workbook = await workbookFrom(ExcelJS, existing, () => newCandidateDetailsBook(ExcelJS));
    const sheet = workbook.worksheets[0];
    const { byPassport, lastRow } = indexRows(sheet, CANDIDATE_FIRST_ROW, CANDIDATE_PASSPORT_COLUMN);
    let next = lastRow + 1;
    for (const candidate of candidates) {
        const key = keyOf(candidate.passportId);
        const at = byPassport.get(key);
        const values = candidateDetailsValues(candidate);
        if (at) {
            // Profession is left as it is on an existing row.
            writeRow(sheet.getRow(at), values, [4]);
        } else {
            writeRow(sheet.getRow(next), values);
            byPassport.set(key, next);
            next += 1;
        }
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

// Running No. continues from the highest number already in the file; an updated row keeps its
// number and GROUP.
export async function upsertExtraDetails(existing, { clientName, primaryTrade, candidates }) {
    const ExcelJS = await loadExcel();
    const workbook = await workbookFrom(ExcelJS, existing, () => newExtraDetailsBook(ExcelJS, clientName));
    const sheet = workbook.worksheets[0];
    const { byPassport, lastRow } = indexRows(sheet, EXTRA_FIRST_ROW, EXTRA_PASSPORT_COLUMN);
    let running = 0;
    for (let r = EXTRA_FIRST_ROW; r <= lastRow; r += 1) {
        const value = Number(sheet.getRow(r).getCell(EXTRA_RUNNING_COLUMN).value);
        if (Number.isFinite(value) && value > running) running = value;
    }
    let next = lastRow + 1;
    for (const candidate of candidates) {
        const key = keyOf(candidate.passportId);
        const at = byPassport.get(key);
        const values = extraDetailsValues(candidate, primaryTrade);
        if (at) {
            writeRow(sheet.getRow(at), values, [1, EXTRA_RUNNING_COLUMN]);
        } else {
            running += 1;
            values[EXTRA_RUNNING_COLUMN - 1] = running;
            const row = sheet.getRow(next);
            writeRow(row, values);
            byPassport.set(key, next);
            next += 1;
        }
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
