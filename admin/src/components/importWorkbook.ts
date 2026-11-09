import type { ImportRow } from "../api/candidateImport";

// Reading the legacy candidate workbook IN THE BROWSER (Upload). The file
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

export const WORKBOOK_READ_TIMEOUT_MS = 30_000;

// The reader unzips in a Web Worker started from a blob: URL. A page policy without
// worker-src 'self' blob: (vercel.json) blocks it, and the reader then never answers or fails: the
// dialog used to wait for ever. This turns that and any other stall into an error a person can read:
//   - a securitypolicyviolation event for a blob / worker / script source rejects at once;
//   - no answer within timeoutMs rejects;
//   - the reader's own errors pass through.
// A result that arrives after one of these is ignored.
export function guardWorkbookRead<T>(
    work: () => Promise<T>,
    { timeoutMs = WORKBOOK_READ_TIMEOUT_MS, target = typeof document === "undefined" ? null : document }: { timeoutMs?: number; target?: EventTarget | null } = {},
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onViolation = (event: Event) => {
            const violation = event as Partial<SecurityPolicyViolationEvent>;
            if (String(violation.blockedURI ?? "").startsWith("blob") || /worker-src|script-src/.test(String(violation.effectiveDirective ?? ""))) {
                settle(() => reject(new WorkbookError("This browser blocked the spreadsheet reader (a page security policy). Nothing was uploaded. Tell your administrator; reloading the page will not fix it.")));
            }
        };
        function settle(action: () => void) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            target?.removeEventListener("securitypolicyviolation", onViolation);
            action();
        }
        target?.addEventListener("securitypolicyviolation", onViolation);
        timer = setTimeout(() => settle(() => reject(new WorkbookError("Reading the workbook took too long and was stopped. Nothing was uploaded. Try again, or open it in Excel and save it as .xlsx first."))), timeoutMs);
        work().then((value) => settle(() => resolve(value)), (error) => settle(() => reject(error)));
    });
}

// The first sheet of the workbook, read here; numbers are kept as their exact text (a 12-digit NIC
// or a phone number is never rounded). The reader is loaded only when a sheet is chosen.
export async function readWorkbook(file: File, options: { allowed: readonly string[]; required: readonly string[] }) {
    await checkWorkbookFile(file);
    let data: Cell[][];
    try {
        data = await guardWorkbookRead(async () => {
            const { readSheet } = await import("read-excel-file/browser");
            return (await readSheet(file, { parseNumber: (text: string) => text })) as Cell[][];
        });
    } catch (error) {
        if (error instanceof WorkbookError) throw error;
        throw new WorkbookError("The workbook could not be read. Open it in Excel, save it again as .xlsx, and retry.");
    }
    if (!data.length) throw new WorkbookError("The first sheet of the workbook is empty.");
    return extractRows(data, options);
}
