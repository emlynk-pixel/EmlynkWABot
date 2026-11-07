import type { ImportRowIssues } from "../api/candidateImport";
import { headerKey } from "./importWorkbook";

// The validation sheet (Upload preview > Download validation sheet): a COPY of the uploaded workbook
// with two more columns on its first sheet (the sheet the import reads), ERRORS and WARNINGS, holding
// each row's messages. Built HERE, from the file the admin chose and the preview's rowIssues: the
// file never leaves this computer and the server keeps no copy. The admin fixes the rows and uploads
// the corrected sheet again (the server ignores ERRORS / WARNINGS).
//
// Everything else is kept: the other sheets, every column (in its place), every value and formula, the
// sheet names. An ERRORS / WARNINGS column already there (an earlier validation sheet) is reused and
// only its values are replaced; otherwise the two are added after the last column. The messages are
// the preview's own (one catalog on the server, candidateImportIssues.js), one per line in a cell.

export const ERRORS_HEADER = "ERRORS";
export const WARNINGS_HEADER = "WARNINGS";
const MESSAGE_SEPARATOR = "\n";

type ExcelModule = typeof import("exceljs");

// The writer is loaded only when a validation sheet is asked for.
async function loadExcel(): Promise<ExcelModule> {
    const loaded = (await import("exceljs")) as ExcelModule & { default?: ExcelModule };
    return loaded.default ?? loaded;
}

// The uploaded workbook's bytes + the preview's row issues -> the validation workbook's bytes.
export async function buildValidationWorkbook(source: ArrayBuffer, rowIssues: readonly ImportRowIssues[]): Promise<ArrayBuffer> {
    const { Workbook } = await loadExcel();
    const workbook = new Workbook();
    await workbook.xlsx.load(source);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error("The workbook has no sheet.");

    const header = sheet.getRow(1);
    let errorsColumn = 0;
    let warningsColumn = 0;
    header.eachCell({ includeEmpty: false }, (cell, column) => {
        const key = headerKey(cell.text);
        if (key === ERRORS_HEADER && !errorsColumn) errorsColumn = column;
        if (key === WARNINGS_HEADER && !warningsColumn) warningsColumn = column;
    });
    let last = sheet.columnCount;
    if (!errorsColumn) errorsColumn = ++last;
    if (!warningsColumn) warningsColumn = ++last;
    for (const [column, title] of [[errorsColumn, ERRORS_HEADER], [warningsColumn, WARNINGS_HEADER]] as const) {
        const cell = header.getCell(column);
        cell.value = title;
        cell.font = { ...cell.font, bold: true };
    }

    const byRow = new Map(rowIssues.map((issue) => [issue.rowNumber, issue]));
    const lastRow = Math.max(sheet.rowCount, ...rowIssues.map((issue) => issue.rowNumber));
    for (let rowNumber = 2; rowNumber <= lastRow; rowNumber++) {
        const issue = byRow.get(rowNumber);
        const row = sheet.getRow(rowNumber);
        for (const [column, messages] of [[errorsColumn, issue?.errors ?? []], [warningsColumn, issue?.warnings ?? []]] as const) {
            const cell = row.getCell(column);
            if (!messages.length) {
                // A clean row: blank (an earlier sheet's message is cleared).
                if (cell.value !== null && cell.value !== undefined) cell.value = null;
                continue;
            }
            cell.value = messages.join(MESSAGE_SEPARATOR);
            cell.alignment = { ...cell.alignment, wrapText: true, vertical: "top" };
        }
    }
    sheet.getColumn(errorsColumn).width ??= 50;
    sheet.getColumn(warningsColumn).width ??= 50;
    return workbook.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}

// "Legacy Candidates.xlsx" -> "Legacy Candidates - validation.xlsx"
export const validationFileName = (fileName: string) => `${fileName.replace(/\.xlsx$/i, "")} - validation.xlsx`;

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Builds the validation sheet from the chosen file and saves it to this computer (a download; no URL
// outlives the click).
export async function downloadValidationWorkbook(file: File, rowIssues: readonly ImportRowIssues[]): Promise<void> {
    const bytes = await buildValidationWorkbook(await file.arrayBuffer(), rowIssues);
    const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
    try {
        const link = document.createElement("a");
        link.href = url;
        link.download = validationFileName(file.name);
        document.body.appendChild(link);
        link.click();
        link.remove();
    } finally {
        // Revoked after the click has started the download.
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }
}
