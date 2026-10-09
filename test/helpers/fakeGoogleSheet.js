// An in-memory stand-in for the Google Sheets `spreadsheets.values` API, with
// the behaviour the sync relies on: quoted A1 ranges, trailing empty cells and
// rows left out of read responses, values.append with INSERT_ROWS after the
// last non-empty row, a 400 for an unknown tab, and injectable failures.
// It is the `sheetsClient` given to the REAL adapter (googleSheetsAdapter.js),
// so tests exercise the real range construction, gate and validation while
// nothing can reach Google.
import { SHEET_COLUMN_COUNT, SHEET_HEADERS, columnLetter } from "../../src/services/sheetSchema.js";

const letterIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

function parseRange(range) {
    const rows = /^'((?:[^']|'')+)'!(\d+):(\d+)$/.exec(range);
    if (rows) return { tab: rows[1].replace(/''/g, "'"), firstCol: 0, lastCol: Infinity, firstRow: Number(rows[2]), lastRow: Number(rows[3]) };
    const match = /^'((?:[^']|'')+)'!([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/.exec(range);
    if (!match) throw Object.assign(new Error(`Unable to parse range: ${range}`), { response: { status: 400, data: { error: { status: "INVALID_ARGUMENT", errors: [{ reason: "badRequest" }] } } } });
    const [, tab, c1, r1, c2, r2] = match;
    const lastRow = r2 ? Number(r2) : r1 && c2 === undefined ? Number(r1) : Infinity;
    return { tab: tab.replace(/''/g, "'"), firstCol: letterIndex(c1), lastCol: letterIndex(c2 ?? c1), firstRow: r1 ? Number(r1) : 1, lastRow };
}

export const googleError = (status, { reason = null, googleStatus = null } = {}) =>
    Object.assign(new Error(`fake Google error ${status} with secret-looking text ya29.TOKEN 'Fake Tab'!A1`), {
        response: { status, data: { error: { status: googleStatus, errors: reason ? [{ reason }] : [] } } },
    });

export function createFakeGoogleSheet({ tabName = "Fake Tab", header = [...SHEET_HEADERS], rows = [] } = {}) {
    // grid[0] is row 1. Cells are strings.
    const grid = [[...header], ...rows.map((r) => [...r])];
    const calls = [];
    const failures = [];

    const trimRow = (row) => {
        const out = [...row];
        while (out.length && (out.at(-1) === "" || out.at(-1) === undefined || out.at(-1) === null)) out.pop();
        return out;
    };
    const width = () => Math.max(SHEET_COLUMN_COUNT, trimRow(grid[0] ?? []).length);
    const lastNonEmptyRow = () => {
        for (let i = grid.length - 1; i >= 0; i--) if (trimRow(grid[i] ?? []).length) return i + 1;
        return 0;
    };

    function check(method, range) {
        const index = failures.findIndex((f) => f.method === method || f.method === "*");
        if (index !== -1) {
            const failure = failures[index];
            if (--failure.times <= 0) failures.splice(index, 1);
            throw failure.error;
        }
        if (range !== undefined && parseRange(range).tab !== tabName) {
            throw googleError(400, { reason: "badRequest", googleStatus: "INVALID_ARGUMENT" });
        }
    }

    function read(range) {
        const r = parseRange(range);
        const last = Math.min(r.lastRow, lastNonEmptyRow());
        const values = [];
        for (let n = r.firstRow; n <= last; n++) values.push(trimRow((grid[n - 1] ?? []).slice(r.firstCol, r.lastCol + 1)));
        while (values.length && !values.at(-1).length) values.pop();
        return values;
    }

    function writeRow(range, cells) {
        const r = parseRange(range);
        const target = (grid[r.firstRow - 1] ??= []);
        cells.forEach((cell, i) => { target[r.firstCol + i] = String(cell); });
        for (let i = 0; i < grid.length; i++) grid[i] ??= [];
    }

    const values = {
        async get(params) {
            calls.push({ method: "get", range: params.range });
            check("get", params.range);
            return { data: { values: read(params.range) } };
        },
        async batchGet(params) {
            calls.push({ method: "batchGet", ranges: params.ranges });
            for (const range of params.ranges) check("batchGet", range);
            return { data: { valueRanges: params.ranges.map((range) => ({ range, values: read(range) })) } };
        },
        async batchUpdate(params) {
            const data = params.requestBody.data;
            calls.push({ method: "batchUpdate", ranges: data.map((d) => d.range), valueInputOption: params.requestBody.valueInputOption });
            for (const d of data) check("batchUpdate", d.range);
            for (const d of data) writeRow(d.range, d.values[0]);
            return { data: { totalUpdatedRows: data.length } };
        },
        async update(params) {
            calls.push({ method: "update", range: params.range });
            check("update", params.range);
            writeRow(params.range, params.requestBody.values[0]);
            return { data: {} };
        },
        async append(params) {
            calls.push({ method: "append", range: params.range, rows: params.requestBody.values.length, insertDataOption: params.insertDataOption, valueInputOption: params.valueInputOption });
            check("append", params.range);
            const start = lastNonEmptyRow() + 1;
            params.requestBody.values.forEach((cells, i) => { grid[start - 1 + i] = cells.map(String); });
            const width = Math.max(...params.requestBody.values.map((cells) => cells.length));
            return { data: { updates: { updatedRange: `'${tabName}'!A${start}:${columnLetter(width - 1)}${start + params.requestBody.values.length - 1}` } } };
        },
        async clear() { throw new Error("clear must never be called"); },
    };

    return {
        client: { spreadsheets: { values, batchUpdate: async () => { throw new Error("structural batchUpdate must never be called"); } } },
        calls,
        tabName,
        // Fail the next `times` calls of a method ("*" = any) with `error`.
        failNext(method, error, times = 1) { failures.push({ method, error, times }); },
        clearFailures() { failures.length = 0; },
        writes: () => calls.filter((c) => ["batchUpdate", "update", "append"].includes(c.method)),
        // Data rows (row 2 onwards) as stored, padded to the live header's
        // width (at least the system column count): positions as in the Sheet.
        dataRows: () => grid.slice(1, lastNonEmptyRow()).map((row) => Array.from({ length: width() }, (_, i) => row?.[i] ?? "")),
        row: (n) => Array.from({ length: width() }, (_, i) => grid[n - 1]?.[i] ?? ""),
        header: () => trimRow(grid[0] ?? []),
        setCell(rowNumber, columnIndex, value) { (grid[rowNumber - 1] ??= [])[columnIndex] = value; },
        setHeader(cells) { grid[0] = [...cells]; },
    };
}
