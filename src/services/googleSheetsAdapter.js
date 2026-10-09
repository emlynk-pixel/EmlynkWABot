// Google Sheets adapter for the candidate operational mirror
// (Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md, Sections 6.4, 8.6, 11.6).
//
// The only module that talks to Google, and the only one that knows live
// column positions. Columns are found by header name (sheetSchema.js
// readSheetLayout): the system columns may be in any order, with operator
// columns between them. Narrow on purpose:
//   readHeader()        row 1, however wide (1:1)
//   validateSchema()    row 1 against the system headers, by name
//   readLayout()        row 1 -> the live layout (where each system column is)
//   readCandidateIds(l) the _SYSTEM_CANDIDATE_ID column with each row number
//   readRows(l)         every data row, as field-ordered cells
//   readRow(n, l)       one data row, as field-ordered cells
//   readRowsByNumber(ns, l) several data rows, one batchGet
//   appendRow(cells, l) one new row
//   updateRow(n, cells, l) one existing row
//   writeRows({ updates, appends }, l) several rows: one batchUpdate + one append
// "Field-ordered cells" are SHEET_COLUMN_COUNT strings in the canonical order
// (sheetSchema.js SHEET_COLUMNS), whatever the live order is. Operator
// columns are never read into them and never written.
// There is no clear, delete or "reset" operation of any kind: the target is
// the real operational Sheet and rows are never removed.
//
// Safety:
//   - appendRow/updateRow/writeRows refuse (SheetSyncDisabledError) unless the write
//     gate is enabled (config/sheetSync.js), before any Google client exists;
//   - every write checks the rows, then re-reads row 1: a header that moved
//     or changed since the layout was read stops the write
//     (SheetLayoutChangedError), so nothing lands in a wrong column;
//   - existing rows are written only in the system columns' ranges, never in
//     operator columns;
//   - authentication is Application Default Credentials (the Cloud Run
//     runtime identity); no key file, no private key;
//   - the live client is never created under the Node test runner, so a
//     test can't reach the real Sheet even by mistake;
//   - errors carry an HTTP status, a Google reason code and a class, never
//     Google's message text (it can quote ranges, IDs or values). Nothing
//     here logs.

import {
    SHEET_FIRST_DATA_ROW,
    SYSTEM_CANDIDATE_ID_INDEX,
    assertSheetRow,
    candidateIdRange,
    dataRange,
    headerRange,
    operationalRange,
    readSheetLayout,
    rowRange,
    toFieldCells,
    toLiveRow,
    validateHeaderRow,
    writeRangesFor,
} from "./sheetSchema.js";

export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
// For read-only work (the connection/schema check): a token with this scope
// can't change the Sheet even if a code path tried.
export const SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

export const SHEETS_ERROR_CLASS = Object.freeze({
    RETRYABLE: "RETRYABLE", // rate limits, transient server and network failures
    CONFIG: "CONFIG",       // credentials, permission, spreadsheet/tab/range not found
    PERMANENT: "PERMANENT", // anything else; not retried automatically
});

export class SheetSyncDisabledError extends Error {
    constructor() {
        super("Google Sheet sync is disabled (SHEET_SYNC_ENABLED is not true); nothing was written");
        this.name = "SheetSyncDisabledError";
    }
}

export class SheetSchemaMismatchError extends Error {
    constructor(mismatches) {
        super(`The Google Sheet header row does not have the required system columns (${mismatches.map((m) => `${m.problem === "DUPLICATE" ? "duplicated" : "missing"}: ${m.header}`).join("; ")})`);
        this.name = "SheetSchemaMismatchError";
        // [{ problem, header, expected, found, columns }]: our own system
        // header names and column letters, never the Sheet's other text or row data.
        this.mismatches = mismatches;
    }
}

// Row 1 changed between reading the layout and writing (an operator moved,
// added or renamed a column during the run). Nothing was written; the next
// run reads the new layout. Retryable, not a configuration error.
export class SheetLayoutChangedError extends Error {
    constructor() {
        super("The Google Sheet header row changed during the sync; nothing was written");
        this.name = "SheetLayoutChangedError";
    }
}

export class SheetsAdapterError extends Error {
    constructor({ errorClass, status = null, reason = null, googleStatus = null }) {
        super(`Google Sheets request failed (${[status && `status ${status}`, reason && `reason ${reason}`, googleStatus && `google ${googleStatus}`].filter(Boolean).join(", ") || "no response"})`);
        this.name = "SheetsAdapterError";
        this.errorClass = errorClass;
        this.status = status;
        this.reason = reason;
        // Google's canonical status enum (INVALID_ARGUMENT, FAILED_PRECONDITION,
        // NOT_FOUND...), never message text.
        this.googleStatus = googleStatus;
    }
}

// Row ranges per values.batchGet request.
const BATCH_GET_CHUNK = 100;

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const CONFIG_STATUS = new Set([400, 401, 403, 404]);
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED", "RESOURCE_EXHAUSTED"]);
const NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ECONNABORTED"]);

// A Google client error -> { errorClass, status, reason }. Reads status and
// reason codes only.
export function classifySheetsError(error) {
    const status = Number(error?.response?.status ?? error?.status ?? error?.code) || null;
    const reason = error?.errors?.[0]?.reason
        ?? error?.response?.data?.error?.errors?.[0]?.reason
        ?? error?.response?.data?.error?.status
        ?? null;
    const rawGoogleStatus = error?.response?.data?.error?.status;
    const googleStatus = typeof rawGoogleStatus === "string" && /^[A-Z_]{1,40}$/.test(rawGoogleStatus) ? rawGoogleStatus : null;
    const code = typeof error?.code === "string" ? error.code : null;
    let errorClass = SHEETS_ERROR_CLASS.PERMANENT;
    if ((status && RETRYABLE_STATUS.has(status)) || (reason && RATE_LIMIT_REASONS.has(reason)) || (code && NETWORK_CODES.has(code))) {
        errorClass = SHEETS_ERROR_CLASS.RETRYABLE;
    } else if (status && CONFIG_STATUS.has(status)) {
        errorClass = SHEETS_ERROR_CLASS.CONFIG;
    }
    return { errorClass, status, reason: typeof reason === "string" ? reason : null, googleStatus };
}

// The live client: Google's official Sheets library with Application
// Default Credentials and the spreadsheets scope only. Imported lazily, so
// nothing Google-related loads unless a live adapter is actually built.
export async function createLiveSheetsClient({ env = process.env, scopes = [SHEETS_SCOPE] } = {}) {
    // The test runner is a fact about this process, whatever env a caller passes in.
    if (env.NODE_TEST_CONTEXT || process.env.NODE_TEST_CONTEXT) {
        throw new Error("The live Google Sheets client is not available under the test runner; inject a fake client");
    }
    const { sheets, auth } = await import("@googleapis/sheets");
    // No keyFile/credentials option: ADC resolves to the runtime identity.
    const googleAuth = new auth.GoogleAuth({ scopes });
    return sheets({ version: "v4", auth: googleAuth });
}

// config: readSheetSyncConfig() result (enabled, spreadsheetId, tabName).
// sheetsClient: an object shaped like the official client
//   (spreadsheets.values.get/batchGet/append/update/batchUpdate), or a factory returning one;
//   defaults to the live client, created on first use.
//
// Every read and write after the header goes through a layout (readLayout()):
// pass the same layout to every call of one sync operation so row 1 is read
// once. A method called without one reads the header itself.
export function createGoogleSheetsAdapter({ config, sheetsClient = createLiveSheetsClient } = {}) {
    if (!config || typeof config !== "object") throw new Error("Sheet sync configuration is required");
    const { spreadsheetId, tabName } = config;

    let client = null;
    const getClient = async () => {
        if (!client) client = typeof sheetsClient === "function" ? await sheetsClient() : sheetsClient;
        return client;
    };
    const requireTarget = () => {
        if (!spreadsheetId || !tabName) throw new Error("SHEET_SPREADSHEET_ID and SHEET_TAB_NAME are required");
    };
    const call = async (run) => {
        requireTarget();
        const values = (await getClient()).spreadsheets.values;
        try {
            return await run(values);
        } catch (error) {
            throw new SheetsAdapterError(classifySheetsError(error));
        }
    };
    const readRange = (range) => call(async (values) => {
        const response = await values.get({ spreadsheetId, range, majorDimension: "ROWS", valueRenderOption: "FORMATTED_VALUE" });
        return response?.data?.values ?? [];
    });

    // Row 1 as the Sheet has it (strings; trailing empty cells are left out by Google).
    const readHeader = async () => {
        requireTarget();
        return ((await readRange(headerRange(tabName)))[0] ?? []).map((cell) => (cell === undefined || cell === null ? "" : String(cell)));
    };

    const validateSchema = async () => validateHeaderRow(await readHeader());

    // The live layout, or SheetSchemaMismatchError when row 1 is not usable.
    const readLayout = async () => {
        const { valid, problems, layout } = readSheetLayout(await readHeader());
        if (!valid) throw new SheetSchemaMismatchError(problems);
        return layout;
    };
    const layoutFor = async (layout) => layout ?? readLayout();

    // Before a write: row 1 is still exactly the one the layout was built
    // from (one read, like the schema check every write always had). If an
    // operator moved, added or renamed a column since, nothing is written;
    // the next run reads the new layout.
    const confirmLayout = async (layout) => {
        const current = readSheetLayout(await readHeader());
        if (!current.valid) throw new SheetSchemaMismatchError(current.problems);
        const same = current.layout.width === layout.width && current.layout.header.every((h, i) => h === layout.header[i]);
        if (!same) throw new SheetLayoutChangedError();
    };

    // Writes: the gate first (a disabled sync never reaches Google), then the
    // rows, then row 1. Existing rows are written one range per run of system
    // columns, so operator columns are never written; new rows are appended
    // as wide as the header, with "" in operator columns.
    async function write({ updates = [], appends = [] }, layout) {
        if (config.enabled !== true) throw new SheetSyncDisabledError();
        requireTarget();
        for (const update of updates) {
            if (!Number.isSafeInteger(update.rowNumber) || update.rowNumber < SHEET_FIRST_DATA_ROW) {
                throw new Error(`A data row number must be a whole number from ${SHEET_FIRST_DATA_ROW}`);
            }
        }
        [...updates.map((u) => u.cells), ...appends].forEach((cells) => assertSheetRow(cells));
        if (!updates.length && !appends.length) return { updated: 0, appended: 0 };
        if (layout) await confirmLayout(layout);
        const target = layout ?? await readLayout();
        await call(async (values) => {
            if (updates.length) {
                await values.batchUpdate({
                    spreadsheetId,
                    requestBody: {
                        valueInputOption: "RAW",
                        data: updates.flatMap((u) => writeRangesFor(tabName, u.rowNumber, target, u.cells).map((w) => ({ range: w.range, majorDimension: "ROWS", values: w.values }))),
                    },
                });
            }
            if (appends.length) {
                await values.append({
                    spreadsheetId,
                    range: operationalRange(tabName, target),
                    valueInputOption: "RAW",
                    insertDataOption: "INSERT_ROWS",
                    requestBody: { majorDimension: "ROWS", values: appends.map((cells) => toLiveRow(cells, target)) },
                });
            }
        });
        return { updated: updates.length, appended: appends.length };
    }

    return Object.freeze({
        readHeader,
        validateSchema,
        readLayout,

        // [{ rowNumber, candidateId }] for every data row ("" when blank),
        // read from wherever _SYSTEM_CANDIDATE_ID is.
        async readCandidateIds(layout) {
            requireTarget();
            const rows = await readRange(candidateIdRange(tabName, await layoutFor(layout)));
            return rows.map((row, offset) => ({ rowNumber: SHEET_FIRST_DATA_ROW + offset, candidateId: row?.[0] === undefined ? "" : String(row[0]) }));
        },

        // { rowNumber, cells } for one data row; cells are field-ordered
        // (SHEET_COLUMN_COUNT strings), operator columns left out.
        async readRow(rowNumber, layout) {
            requireTarget();
            const live = await layoutFor(layout);
            const rows = await readRange(rowRange(tabName, rowNumber, live));
            return { rowNumber, cells: toFieldCells(rows[0] ?? [], live) };
        },

        // [{ rowNumber, cells }] for every data row, field-ordered.
        async readRows(layout) {
            requireTarget();
            const live = await layoutFor(layout);
            const rows = await readRange(dataRange(tabName, live));
            return rows.map((row, offset) => ({ rowNumber: SHEET_FIRST_DATA_ROW + offset, cells: toFieldCells(row, live) }));
        },

        // Map(rowNumber -> field-ordered cells) for the given data rows, one
        // batchGet per chunk of rows.
        async readRowsByNumber(rowNumbers, layout) {
            requireTarget();
            const live = await layoutFor(layout);
            const numbers = [...new Set(rowNumbers)];
            const cellsByRow = new Map();
            for (let i = 0; i < numbers.length; i += BATCH_GET_CHUNK) {
                const chunk = numbers.slice(i, i + BATCH_GET_CHUNK);
                const ranges = chunk.map((n) => rowRange(tabName, n, live));
                const valueRanges = await call(async (values) => {
                    const response = await values.batchGet({ spreadsheetId, ranges, majorDimension: "ROWS", valueRenderOption: "FORMATTED_VALUE" });
                    return response?.data?.valueRanges ?? [];
                });
                chunk.forEach((n, index) => cellsByRow.set(n, toFieldCells(valueRanges[index]?.values?.[0] ?? [], live)));
            }
            return cellsByRow;
        },

        // Rewrites existing rows (by row number) and appends new ones, after
        // the gate, the row checks and ONE header check. Updates go in one
        // values.batchUpdate, appends in one values.append (INSERT_ROWS:
        // nothing below is overwritten). Never clears or deletes anything.
        writeRows({ updates = [], appends = [] } = {}, layout) {
            return write({ updates, appends }, layout);
        },

        async appendRow(cells, layout) {
            if (config.enabled !== true) throw new SheetSyncDisabledError();
            assertSheetRow(cells);
            const target = await layoutFor(layout);
            if (layout) await confirmLayout(layout);
            return call(async (values) => {
                const response = await values.append({
                    spreadsheetId,
                    range: operationalRange(tabName, target),
                    valueInputOption: "RAW",
                    insertDataOption: "INSERT_ROWS",
                    requestBody: { majorDimension: "ROWS", values: [toLiveRow(cells, target)] },
                });
                return { updatedRange: response?.data?.updates?.updatedRange ?? null };
            });
        },

        async updateRow(rowNumber, cells, layout) {
            await write({ updates: [{ rowNumber, cells }] }, layout);
            return { rowNumber, candidateId: cells[SYSTEM_CANDIDATE_ID_INDEX] };
        },
    });
}

// The read methods of an adapter and nothing else, for code that must not
// be able to write (sync planning, the connection check).
export function readOnlySheetsView(adapter) {
    const view = {};
    for (const name of ["readHeader", "validateSchema", "readLayout", "readCandidateIds", "readRows", "readRow", "readRowsByNumber"]) {
        if (typeof adapter?.[name] !== "function") throw new Error(`The Sheets adapter has no ${name}()`);
        view[name] = (...args) => adapter[name](...args);
    }
    return Object.freeze(view);
}
