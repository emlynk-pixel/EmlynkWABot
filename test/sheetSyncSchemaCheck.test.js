import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { evaluateSheetSyncSchema, REQUIRED_TABLES, REQUIRED_TRIGGERS } from "../src/services/sheetSyncSchemaCheck.js";

const healthy = { tables: [...REQUIRED_TABLES], triggers: [...REQUIRED_TRIGGERS], stateRows: 1, migrationTableSchemas: ["public"] };

describe("Sheet Sync schema check (read-only rules)", () => {
    test("a healthy database passes with no warnings", () => {
        assert.deepEqual(evaluateSheetSyncSchema(healthy), { ok: true, problems: [], warnings: [] });
    });

    test("the missing state row (the 2026-11-09 production finding) is a problem", () => {
        const result = evaluateSheetSyncSchema({ ...healthy, stateRows: 0 });
        assert.equal(result.ok, false);
        assert.deepEqual(result.problems.map((p) => p.code), ["STATE_ROW_MISSING"]);
    });

    test("a duplicated state row, a missing table and a missing trigger are problems", () => {
        assert.deepEqual(evaluateSheetSyncSchema({ ...healthy, stateRows: 2 }).problems.map((p) => p.code), ["STATE_ROW_DUPLICATED"]);
        assert.deepEqual(evaluateSheetSyncSchema({ ...healthy, tables: ["sheet_sync_state", "sheet_sync_runs"] }).problems.map((p) => p.code), ["TABLE_MISSING"]);
        assert.deepEqual(evaluateSheetSyncSchema({ ...healthy, triggers: REQUIRED_TRIGGERS.slice(1) }).problems.map((p) => p.code), ["TRIGGER_MISSING"]);
    });

    test("no migration history is only a warning", () => {
        const result = evaluateSheetSyncSchema({ ...healthy, migrationTableSchemas: [] });
        assert.equal(result.ok, true);
        assert.deepEqual(result.warnings.map((w) => w.code), ["NO_MIGRATION_HISTORY"]);
    });
});
