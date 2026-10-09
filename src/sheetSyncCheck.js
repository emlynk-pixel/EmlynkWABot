// Google Sheet operational mirror: one-off READ-ONLY connection/schema check.
//
//   npm run sheet:check        (locally; reads .env)
//   node src/sheetSyncCheck.js (container / Cloud Run Job)
//
// Reads row 1 of the configured tab with the runtime identity (Application
// Default Credentials, spreadsheets.readonly scope) and prints one sanitized
// JSON line (sheetHealthCheck.js). Exit code 0 when CONNECTED and
// SCHEMA_VALID, 1 otherwise. Needs only SHEET_SPREADSHEET_ID and
// SHEET_TAB_NAME: no database, no Supabase, no SHEET_SYNC_ENABLED. It never
// writes to the Sheet.
//
// Intended to run as the dedicated sheet-sync runtime identity
// (emlynk-sheet-sync@...), e.g. a Cloud Run Job built from the same image
// with this command, before any write path is deployed.

import { pathToFileURL } from "node:url";
import { runSheetHealthCheck } from "./services/sheetHealthCheck.js";

export async function runCheckCommand({ env = process.env, sheetsClient, write = (text) => process.stdout.write(text) } = {}) {
    const result = await runSheetHealthCheck({ env, ...(sheetsClient ? { sheetsClient } : {}) });
    write(`${JSON.stringify({ event: "sheet_sync.health_check", ...result })}\n`);
    return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    // Only when run directly: load a local .env, then check.
    await import("dotenv/config");
    process.exitCode = await runCheckCommand();
}
