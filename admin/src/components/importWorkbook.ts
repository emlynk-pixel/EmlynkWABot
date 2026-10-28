import type { ImportRow } from "../api/candidateImport";

// Reading the legacy candidate workbook IN THE BROWSER (Update Sheet). The file
// never leaves this machine: only the allow-listed columns of each row are
// sent to the server (which validates everything again). Nothing here logs.

export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 3000;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export class WorkbookError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorkbookError";
    }
}

// "  Job   role " -> "JOB ROLE" (the server matches headers the same way).
export const headerKey = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();

// The file itself: a .xlsx workbook (an Office Open XML ZIP), no macro or legacy formats, within the size limit.
export async function checkWorkbookFile(file: File): Promise<void> {
    if (!/\.xlsx$/i.test(file.name)) throw new WorkbookError("Choose an Excel workbook (.xlsx). Other formats, including macro-enabled workbooks (.xlsm) and old .xls files, are not accepted.");
    if (file.type && file.type !== XLSX_MIME) throw new WorkbookError("This file is not an Excel workbook (.xlsx).");
    if (file.size === 0) throw new WorkbookError("The file is empty.");
    if (file.size > MAX_IMPORT_FILE_BYTES) throw new WorkbookError(`The file is larger than ${MAX_IMPORT_FILE_BYTES / (1024 * 1024)} MB.`);
    // Every .xlsx is a ZIP archive: "PK\x03\x04".
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 0x03 || head[3] !== 0x04) throw new WorkbookError("This file is not a valid Excel workbook (.xlsx).");
}

type Cell = string | number | boolean | Date | null | undefined | unknown;

// A cell as text: dates as YYYY-MM-DD (a date cell has no time zone), numbers exactly as stored.
function cellText(cell: Cell): string {
    if (cell === null || cell === undefined) return "";
    if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? "" : cell.toISOString().slice(0, 10);
    return String(cell).trim();
}

// The sheet's rows (row 1 = headers) -> the headers, and each non-empty data row with ONLY the
// allow-listed columns. rowNumber is the row's number in Excel (data starts at 2).
export function extractRows(data: Cell[][], { allowed, required, maxRows = MAX_IMPORT_ROWS }: { allowed: readonly string[]; required: readonly string[]; maxRows?: number }) {
    const headerRow = data[0] ?? [];
    const headers = headerRow.map(cellText);
    const allowedSet = new Set(allowed);
    const columns: { index: number; header: string }[] = [];
    const taken = new Set<string>();
    headers.forEach((header, index) => {
        const key = headerKey(header);
        if (allowedSet.has(key) && !taken.has(key)) {
            taken.add(key);
            columns.push({ index, header: key });
        }
    });
    const missingRequired = required.filter((header) => !taken.has(header));
    const rows: ImportRow[] = [];
    for (let i = 1; i < data.length; i++) {
        const values: Record<string, string> = {};
        let any = false;
        for (const { index, header } of columns) {
            const text = cellText(data[i]?.[index]);
            values[header] = text;
            if (text) any = true;
        }
        if (!any) continue;
        rows.push({ rowNumber: i + 1, values });
        if (rows.length > maxRows) throw new WorkbookError(`The sheet has more than ${maxRows} candidate rows. Split it into smaller files.`);
    }
    return { headers: headers.filter(Boolean), rows, missingRequired };
}

// The first sheet of the workbook, read here; numbers are kept as their exact text (a 12-digit NIC
// or a phone number is never rounded). The reader is loaded only when a sheet is chosen.
export async function readWorkbook(file: File, options: { allowed: readonly string[]; required: readonly string[] }) {
    await checkWorkbookFile(file);
    let data: Cell[][];
    try {
        const { readSheet } = await import("read-excel-file/browser");
        data = (await readSheet(file, { parseNumber: (text: string) => text })) as Cell[][];
    } catch {
        throw new WorkbookError("The workbook could not be read. Open it in Excel, save it again as .xlsx, and retry.");
    }
    if (!data.length) throw new WorkbookError("The first sheet of the workbook is empty.");
    return extractRows(data, options);
}
