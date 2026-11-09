// READ-ONLY check of the Sheet Sync database objects:
//   DATABASE_URL=<read-only role URL> node scripts/verifySheetSyncSchema.mjs
// Runs SELECTs inside a READ ONLY transaction (nothing can be written), prints names and counts
// only (no row data, no connection string) and exits 1 when something is wrong.
// It never loads .env files: pass the URL (ideally of a read-only role) in the environment.

import pg from "pg";
import { evaluateSheetSyncSchema, REQUIRED_TRIGGERS } from "../src/services/sheetSyncSchemaCheck.js";

const url = process.env.DATABASE_URL;
if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(2);
}

const client = new pg.Client({ connectionString: url });
try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    const tables = (await client.query("SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'sheet_sync_%'")).rows.map((r) => r.table_name);
    const triggers = (await client.query("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1)", [REQUIRED_TRIGGERS])).rows.map((r) => r.tgname);
    const migrationTableSchemas = (await client.query("SELECT table_schema FROM information_schema.tables WHERE table_name = '_prisma_migrations'")).rows.map((r) => r.table_schema);
    const stateRows = tables.includes("sheet_sync_state") ? Number((await client.query("SELECT count(*) AS n FROM sheet_sync_state")).rows[0].n) : 0;
    await client.query("ROLLBACK");
    const result = evaluateSheetSyncSchema({ tables, triggers, stateRows, migrationTableSchemas });
    for (const p of result.problems) console.log(`PROBLEM  ${p.code}: ${p.message}`);
    for (const w of result.warnings) console.log(`WARNING  ${w.code}: ${w.message}`);
    if (result.ok) console.log("OK       Sheet Sync tables, state row and capture triggers are present.");
    process.exitCode = result.ok ? 0 : 1;
} catch (error) {
    console.error(`Check failed: ${error?.code ?? error?.name ?? "error"}`);
    process.exitCode = 2;
} finally {
    await client.end().catch(() => {});
}
