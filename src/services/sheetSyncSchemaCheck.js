// Read-only health rules for the Sheet Sync database objects (used by
// scripts/verifySheetSyncSchema.mjs). Pure: it judges facts the script SELECTed.
//
// Why this exists: the single sheet_sync_state row is seeded only by an INSERT inside migration
// 20261006120000. A database whose schema was applied by hand (no _prisma_migrations) can miss it,
// and the worker then fails silently (heartbeat and lease are updateMany on that row).

export const REQUIRED_TABLES = Object.freeze(["sheet_sync_state", "sheet_sync_queue", "sheet_sync_runs"]);
export const REQUIRED_TRIGGERS = Object.freeze([
    "candidate_sheet_sync_capture",
    "candidate_additional_details_sheet_sync_capture",
    "candidate_stages_sheet_sync_capture",
    "documents_sheet_sync_capture",
]);
export const STATE_ID = "sheet-sync";

// facts: { tables: string[], triggers: string[], stateRows: number, migrationTableSchemas: string[] }
// -> { ok, problems: [{ code, message }], warnings: [{ code, message }] }
export function evaluateSheetSyncSchema(facts) {
    const problems = [];
    const warnings = [];
    for (const table of REQUIRED_TABLES.filter((t) => !facts.tables.includes(t))) {
        problems.push({ code: "TABLE_MISSING", message: `Table ${table} does not exist.` });
    }
    if (facts.tables.includes("sheet_sync_state") && facts.stateRows !== 1) {
        problems.push({
            code: facts.stateRows === 0 ? "STATE_ROW_MISSING" : "STATE_ROW_DUPLICATED",
            message: facts.stateRows === 0
                ? `sheet_sync_state has no '${STATE_ID}' row: the worker cannot store a heartbeat or take the writer lease.`
                : `sheet_sync_state has ${facts.stateRows} rows; exactly one is expected.`,
        });
    }
    for (const trigger of REQUIRED_TRIGGERS.filter((t) => !facts.triggers.includes(t))) {
        problems.push({ code: "TRIGGER_MISSING", message: `Change-capture trigger ${trigger} is missing: changes to that table are not queued.` });
    }
    if (!facts.migrationTableSchemas.length) {
        warnings.push({ code: "NO_MIGRATION_HISTORY", message: "No _prisma_migrations table: the schema was not applied with prisma migrate, so seed rows and later migrations are not tracked. Baseline it (prisma migrate resolve) once the schema is verified." });
    }
    return { ok: problems.length === 0, problems, warnings };
}
