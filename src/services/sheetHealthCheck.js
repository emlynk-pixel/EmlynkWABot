// Google Sheet operational mirror: READ-ONLY connection and schema check.
// (Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md, Sections 11.6 and 13.2.)
//
// Proves that the runtime identity can reach the configured spreadsheet and
// tab, and that row 1 is the exact 40-column header, by reading A1:AN1 and
// nothing else. It never appends, updates, clears, deletes, formats, creates
// tabs or touches metadata:
//   - the live client asks for the spreadsheets.readonly scope only, so its
//     token cannot write;
//   - the adapter it uses is built with writes disabled and reduced to its
//     read methods;
//   - only readHeader() is called.
//
// It does NOT depend on SHEET_SYNC_ENABLED: verifying access must not require
// enabling candidate writes. Write enablement is a separate switch.
//
// The result is sanitized: a status, the schema verdict, the letters of any
// mismatched header columns, an HTTP status / Google reason code on failure.
// Never tokens, credentials, Google's message text, header text or Sheet data.

import { readSheetSyncConfig } from "../config/sheetSync.js";
import { validateHeaderRow } from "./sheetSchema.js";
import {
    SHEETS_ERROR_CLASS,
    SHEETS_READONLY_SCOPE,
    SheetsAdapterError,
    createGoogleSheetsAdapter,
    createLiveSheetsClient,
    readOnlySheetsView,
} from "./googleSheetsAdapter.js";

export const HEALTH_STATUS = Object.freeze({
    CONNECTED: "CONNECTED",
    NOT_CONFIGURED: "NOT_CONFIGURED",       // spreadsheet ID or tab name missing
    CONFIG_ERROR: "CONFIG_ERROR",           // e.g. a key file configured (not allowed)
    ACCESS_DENIED: "ACCESS_DENIED",         // 401/403: identity, sharing or API not enabled
    NOT_FOUND: "NOT_FOUND",                 // 404: spreadsheet not found
    BAD_REQUEST: "BAD_REQUEST",             // 400: range/tab unparseable or document unsupported (see googleStatus)
    UNAVAILABLE: "UNAVAILABLE",             // rate limited / transient Google or network failure
    FAILED: "FAILED",                       // anything else (e.g. no credentials available)
});

export const SCHEMA_STATUS = Object.freeze({
    VALID: "SCHEMA_VALID",
    INVALID: "SCHEMA_INVALID",
    NOT_CHECKED: "NOT_CHECKED",
});

function failureStatus(error) {
    if (!(error instanceof SheetsAdapterError)) return { status: HEALTH_STATUS.FAILED, httpStatus: null, reason: null };
    let status = HEALTH_STATUS.FAILED;
    if (error.errorClass === SHEETS_ERROR_CLASS.RETRYABLE) status = HEALTH_STATUS.UNAVAILABLE;
    else if (error.status === 401 || error.status === 403) status = HEALTH_STATUS.ACCESS_DENIED;
    else if (error.status === 404) status = HEALTH_STATUS.NOT_FOUND;
    else if (error.status === 400) status = HEALTH_STATUS.BAD_REQUEST;
    return { status, httpStatus: error.status, reason: error.reason, googleStatus: error.googleStatus ?? null };
}

// env: the environment to read SHEET_SPREADSHEET_ID / SHEET_TAB_NAME from.
// sheetsClient: injected client or factory (tests); defaults to the live
//   client with the read-only scope (Application Default Credentials).
// clock: () => Date for checkedAt.
export async function runSheetHealthCheck({ env = process.env, sheetsClient, clock = () => new Date() } = {}) {
    const config = readSheetSyncConfig(env);
    const result = (fields) => Object.freeze({
        ok: fields.status === HEALTH_STATUS.CONNECTED && fields.schema === SCHEMA_STATUS.VALID,
        schema: SCHEMA_STATUS.NOT_CHECKED,
        mismatchedColumns: [],
        httpStatus: null,
        reason: null,
        googleStatus: null,
        // Informational: whether candidate writes are switched on. The check
        // itself never writes either way.
        writeGate: config.gate,
        checkedAt: clock().toISOString(),
        ...fields,
    });

    if (!config.spreadsheetId || !config.tabName) {
        return result({ status: HEALTH_STATUS.NOT_CONFIGURED });
    }
    if (typeof env.GOOGLE_APPLICATION_CREDENTIALS === "string" && env.GOOGLE_APPLICATION_CREDENTIALS.trim() !== "") {
        return result({ status: HEALTH_STATUS.CONFIG_ERROR, reason: "KEY_FILE_NOT_ALLOWED" });
    }

    const adapter = createGoogleSheetsAdapter({
        // Writes forced off, whatever SHEET_SYNC_ENABLED says.
        config: { enabled: false, spreadsheetId: config.spreadsheetId, tabName: config.tabName },
        sheetsClient: sheetsClient ?? (() => createLiveSheetsClient({ env, scopes: [SHEETS_READONLY_SCOPE] })),
    });
    const sheet = readOnlySheetsView(adapter);

    let header;
    try {
        header = await sheet.readHeader();
    } catch (error) {
        return result(failureStatus(error));
    }
    const { valid, mismatches } = validateHeaderRow(header);
    return result({
        status: HEALTH_STATUS.CONNECTED,
        schema: valid ? SCHEMA_STATUS.VALID : SCHEMA_STATUS.INVALID,
        mismatchedColumns: mismatches.map((m) => m.column),
    });
}
