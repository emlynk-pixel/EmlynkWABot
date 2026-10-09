// Google Sheets adapter for the candidate operational mirror
// (Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md, Sections 6.4, 8.6, 11.6).
//
// The only module that talks to Google. Narrow on purpose:
//   readHeader()        row 1 (A1:AO1)
//   validateSchema()    row 1 against the expected headers, by position
//   readCandidateIds()  column AO with each row number
//   readRows()          every data row (A2:AO), 41 cells each
//   readRow(n)          one data row (An:AOn), 41 cells
//   readRowsByNumber(ns) several data rows, one batchGet
//   appendRow(cells)    one new row
//   updateRow(n, cells) one existing row
//   writeRows({ updates, appends }) several rows: one batchUpdate + one append
// There is no clear, delete or "reset" operation of any kind: the target is
// the real operational Sheet and rows are never removed.
//
// Safety:
//   - appendRow/updateRow/writeRows refuse (SheetSyncDisabledError) unless the write
//     gate is enabled (config/sheetSync.js), before any Google client exists;
//   - every write checks the 41-cell row and validates row 1 first;
//   - authentication is Application Default Credentials (the Cloud Run
//     runtime identity); no key file, no private key;
//   - the live client is never created under the Node test runner, so a
//     test can't reach the real Sheet even by mistake;
//   - errors carry an HTTP status, a Google reason code and a class, never
//     Google's message text (it can quote ranges, IDs or values). Nothing
//     here logs.

import {
    SHEET_COLUMN_COUNT,
    SHEET_FIRST_DATA_ROW,
    SYSTEM_CANDIDATE_ID_INDEX,
    assertSheetRow,
    candidateIdRange,
    dataRange,
    headerRange,
    operationalRange,
    rowRange,
    validateHeaderRow,
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
        super(`The Google Sheet header row does not match the expected schema (${mismatches.length} column(s) differ)`);
        this.name = "SheetSchemaMismatchError";
        // Header text only (column letters and expected/actual headers), never row data.
        this.mismatches = mismatches;
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
    // rangeOf(tabName) builds the A1 range once the target is known to be set.
    const readRange = (rangeOf) => call(async (values) => {
        const response = await values.get({ spreadsheetId, range: rangeOf(tabName), majorDimension: "ROWS", valueRenderOption: "FORMATTED_VALUE" });
        return response?.data?.values ?? [];
    });
    // Rows come back without trailing empty cells; pad to the schema width.
    const pad = (row) => Array.from({ length: SHEET_COLUMN_COUNT }, (_, i) => (row?.[i] === undefined || row?.[i] === null ? "" : String(row[i])));

    const readHeader = async () => pad((await readRange(headerRange))[0] ?? []);

    const validateSchema = async () => validateHeaderRow((await readRange(headerRange))[0] ?? []);

    const assertWritable = async (cells) => {
        // The gate comes first: a disabled sync never reaches Google.
        if (config.enabled !== true) throw new SheetSyncDisabledError();
        assertSheetRow(cells);
        const schema = await validateSchema();
        if (!schema.valid) throw new SheetSchemaMismatchError(schema.mismatches);
    };

    return Object.freeze({
        readHeader,
        validateSchema,

        // [{ rowNumber, candidateId }] for every data row ("" when blank).
        async readCandidateIds() {
            const rows = await readRange(candidateIdRange);
            return rows.map((row, offset) => ({ rowNumber: SHEET_FIRST_DATA_ROW + offset, candidateId: row?.[0] === undefined ? "" : String(row[0]) }));
        },

        // { rowNumber, cells } with 41 string cells, for one data row.
        async readRow(rowNumber) {
            const rows = await readRange((tab) => rowRange(tab, rowNumber));
            return { rowNumber, cells: pad(rows[0] ?? []) };
        },

        // [{ rowNumber, cells }] with 41 string cells each.
        async readRows() {
            const rows = await readRange(dataRange);
            return rows.map((row, offset) => ({ rowNumber: SHEET_FIRST_DATA_ROW + offset, cells: pad(row) }));
        },

        // Map(rowNumber -> 41 string cells) for the given data rows, one
        // batchGet per chunk of rows.
        async readRowsByNumber(rowNumbers) {
            const numbers = [...new Set(rowNumbers)];
            const cellsByRow = new Map();
            for (let i = 0; i < numbers.length; i += BATCH_GET_CHUNK) {
                const chunk = numbers.slice(i, i + BATCH_GET_CHUNK);
                const ranges = chunk.map((n) => rowRange(tabName, n));
                const valueRanges = await call(async (values) => {
                    const response = await values.batchGet({ spreadsheetId, ranges, majorDimension: "ROWS", valueRenderOption: "FORMATTED_VALUE" });
                    return response?.data?.valueRanges ?? [];
                });
                chunk.forEach((n, index) => cellsByRow.set(n, pad(valueRanges[index]?.values?.[0] ?? [])));
            }
            return cellsByRow;
        },

        // Rewrites existing rows (by row number) and appends new ones, after
        // the gate, the 41-cell check and ONE header validation. Updates go in
        // one values.batchUpdate, appends in one values.append (INSERT_ROWS:
        // nothing below is overwritten). Never clears or deletes anything.
        async writeRows({ updates = [], appends = [] } = {}) {
            if (config.enabled !== true) throw new SheetSyncDisabledError();
            requireTarget();
            for (const update of updates) rowRange(tabName, update.rowNumber);
            [...updates.map((u) => u.cells), ...appends].forEach((cells) => assertSheetRow(cells));
            if (!updates.length && !appends.length) return { updated: 0, appended: 0 };
            const schema = await validateSchema();
            if (!schema.valid) throw new SheetSchemaMismatchError(schema.mismatches);
            await call(async (values) => {
                if (updates.length) {
                    await values.batchUpdate({
                        spreadsheetId,
                        requestBody: {
                            valueInputOption: "RAW",
                            data: updates.map((u) => ({ range: rowRange(tabName, u.rowNumber), majorDimension: "ROWS", values: [u.cells] })),
                        },
                    });
                }
                if (appends.length) {
                    await values.append({
                        spreadsheetId,
                        range: operationalRange(tabName),
                        valueInputOption: "RAW",
                        insertDataOption: "INSERT_ROWS",
                        requestBody: { majorDimension: "ROWS", values: appends },
                    });
                }
            });
            return { updated: updates.length, appended: appends.length };
        },

        async appendRow(cells) {
            await assertWritable(cells);
            return call(async (values) => {
                const response = await values.append({
                    spreadsheetId,
                    range: operationalRange(tabName),
                    valueInputOption: "RAW",
                    insertDataOption: "INSERT_ROWS",
                    requestBody: { majorDimension: "ROWS", values: [cells] },
                });
                return { updatedRange: response?.data?.updates?.updatedRange ?? null };
            });
        },

        async updateRow(rowNumber, cells) {
            if (config.enabled !== true) throw new SheetSyncDisabledError();
            requireTarget();
            const range = rowRange(tabName, rowNumber);
            await assertWritable(cells);
            return call(async (values) => {
                await values.update({
                    spreadsheetId,
                    range,
                    valueInputOption: "RAW",
                    requestBody: { majorDimension: "ROWS", values: [cells] },
                });
                return { rowNumber, candidateId: cells[SYSTEM_CANDIDATE_ID_INDEX] };
            });
        },
    });
}

// The read methods of an adapter and nothing else, for code that must not
// be able to write (sync planning, the connection check).
export function readOnlySheetsView(adapter) {
    const view = {};
    for (const name of ["readHeader", "validateSchema", "readCandidateIds", "readRows", "readRow", "readRowsByNumber"]) {
        if (typeof adapter?.[name] !== "function") throw new Error(`The Sheets adapter has no ${name}()`);
        view[name] = (...args) => adapter[name](...args);
    }
    return Object.freeze(view);
}
