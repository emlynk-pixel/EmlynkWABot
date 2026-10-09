// Google Sheet mirror, Phase 2: candidate aggregate reader, read-only sync
// planning and the read-only connection/schema check. Synthetic data, a fake
// Prisma client and a recording fake Sheets client only: nothing here can
// reach a database or Google (the live Sheets client refuses to start under
// the test runner).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { SHEET_COLUMNS, SHEET_HEADERS } from "../src/services/sheetSchema.js";
import { CANDIDATE_AGGREGATE_SELECT, mapCandidateToSheetRow } from "../src/services/candidateSheetMapper.js";
import { createCandidateAggregateReader, MAX_AGGREGATE_BATCH_SIZE } from "../src/services/candidateAggregateReader.js";
import { SYNC_ACTION, SheetDuplicateCandidateIdError, buildCandidateRowIndex, createSheetSyncPlanner } from "../src/services/sheetSyncPlanner.js";
import { HEALTH_STATUS, SCHEMA_STATUS, runSheetHealthCheck } from "../src/services/sheetHealthCheck.js";
import { SheetSchemaMismatchError, createGoogleSheetsAdapter, readOnlySheetsView } from "../src/services/googleSheetsAdapter.js";
import { isSheetSyncEnabled, readSheetSyncConfig } from "../src/config/sheetSync.js";
import { runCheckCommand } from "../src/sheetSyncCheck.js";

const TAB = "Fake Tab";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const PII = ["SYNPASS01", "SYNPASS02", "SYNPASS03", "000000001V", "000000002V", "000000003V", "GIVEN ONE", "SURNAME ONE", "94700000001"];

// ---------------------------------------------------------------- fakes

function candidateRow(n, overrides = {}) {
    return {
        passportId: `SYNPASS0${n}`, uniqueId: `000${n}`, firstName: n === 1 ? "GIVEN ONE" : `GIVEN ${n}`, otherName: n === 1 ? "SURNAME ONE" : `SURNAME ${n}`,
        dateOfBirth: new Date("1990-01-01T00:00:00.000Z"), placeOfBirth: null, passportExpiryDate: null, passportIssueDate: null,
        address: "1 Example Road", job: "Job One", nic: `00000000${n}V`, jobExperience: "Example", whatsappNumber: `9470000000${n}`,
        contactNumber: null, nationality: null, sex: null, createdDate: new Date("2026-10-01T10:00:00.000Z"),
        stages: [{ stage: "TEST_DETAILS", completed: false, notes: null, testDate: null }],
        documents: [{ documentId: `00000000-0000-4000-8000-00000000000${n}`, documentType: "PASSPORT", documentVariant: null, verificationStatus: "VERIFIED", receivedDate: new Date("2026-10-02T00:00:00.000Z"), createdDate: new Date("2026-10-02T00:00:00.000Z"), policeSubmittedDate: null }],
        ...overrides,
    };
}

// Just enough of Prisma's candidate model; records every query.
function fakeDb(rows) {
    const queries = [];
    return {
        queries,
        candidate: {
            async findUnique(args) {
                queries.push({ method: "findUnique", ...args });
                return structuredClone(rows.find((r) => r.uniqueId === args.where.uniqueId) ?? null);
            },
            async findMany(args) {
                queries.push({ method: "findMany", ...args });
                const after = args.where?.uniqueId?.gt;
                return structuredClone(rows
                    .filter((r) => after === undefined || r.uniqueId > after)
                    .sort((a, b) => (a.uniqueId < b.uniqueId ? -1 : a.uniqueId > b.uniqueId ? 1 : 0))
                    .slice(0, args.take));
            },
        },
    };
}

// Shaped like the official client's spreadsheets.values; records every call.
function fakeSheets({ header = [...SHEET_HEADERS], rows = [], fail = null } = {}) {
    const calls = [];
    const respond = (method, params, data) => {
        calls.push({ method, ...params });
        if (fail) return Promise.reject(fail);
        return Promise.resolve({ data });
    };
    const rowFor = (range) => Number(range.match(/!A(\d+):AO\d+$/)?.[1]);
    return {
        calls,
        spreadsheets: {
            values: {
                get: (params) => {
                    const { range } = params;
                    if (range.endsWith("!A1:AO1")) return respond("get", params, { values: [header] });
                    if (range.endsWith("!AO2:AO")) return respond("get", params, { values: rows.map((r) => [r[40] ?? ""]) });
                    if (range.endsWith("!A2:AO")) return respond("get", params, { values: rows });
                    const n = rowFor(range);
                    return respond("get", params, { values: rows[n - 2] ? [rows[n - 2]] : [] });
                },
                append: (params) => respond("append", params, {}),
                update: (params) => respond("update", params, {}),
                clear: (params) => respond("clear", params, {}),
                batchUpdate: (params) => respond("batchUpdate", params, {}),
            },
        },
    };
}

const writes = (client) => client.calls.filter((c) => c.method !== "get");
const sheetAdapter = (client, enabled = false) => createGoogleSheetsAdapter({ config: { enabled, spreadsheetId: "fake-id", tabName: TAB }, sheetsClient: client });
const expectedRow = (n, overrides) => {
    const { stages, documents, ...user } = candidateRow(n, overrides);
    return mapCandidateToSheetRow({ user, stages, documents }, { mirroredAt: NOW });
};
const blankRow = (id = "") => Array.from({ length: 41 }, (_, i) => (i === 40 ? id : ""));

// ---------------------------------------------------------------- reader

describe("candidate aggregate reader", () => {
    test("fetches one candidate by unique_id with the mapper's select, in one query", async () => {
        const db = fakeDb([candidateRow(1), candidateRow(2)]);
        const reader = createCandidateAggregateReader({ db });
        const aggregate = await reader.findByUniqueId("0002");
        assert.equal(aggregate.user.uniqueId, "0002");
        assert.equal(aggregate.stages.length, 1);
        assert.equal(aggregate.documents.length, 1);
        assert.equal("stages" in aggregate.user, false, "relations are split off the user");
        assert.equal(db.queries.length, 1);
        assert.deepEqual(db.queries[0].where, { uniqueId: "0002" });
        assert.equal(db.queries[0].select, CANDIDATE_AGGREGATE_SELECT);
        assert.equal(await reader.findByUniqueId("9999"), null);
    });

    test("refuses a blank unique ID instead of looking anything else up", async () => {
        const db = fakeDb([candidateRow(1)]);
        const reader = createCandidateAggregateReader({ db });
        for (const value of ["", "  ", null, undefined, 42]) await assert.rejects(reader.findByUniqueId(value), /unique ID/);
        assert.equal(db.queries.length, 0);
    });

    test("reads batches in unique_id order with a keyset cursor, one query per batch", async () => {
        const db = fakeDb([candidateRow(3), candidateRow(1), candidateRow(5), candidateRow(2), candidateRow(4)]);
        const reader = createCandidateAggregateReader({ db });
        const first = await reader.readBatch({ limit: 2 });
        assert.deepEqual(first.aggregates.map((a) => a.user.uniqueId), ["0001", "0002"]);
        assert.equal(first.nextCursor, "0002");
        const second = await reader.readBatch({ afterUniqueId: first.nextCursor, limit: 2 });
        assert.deepEqual(second.aggregates.map((a) => a.user.uniqueId), ["0003", "0004"]);
        const last = await reader.readBatch({ afterUniqueId: second.nextCursor, limit: 2 });
        assert.deepEqual(last.aggregates.map((a) => a.user.uniqueId), ["0005"]);
        assert.equal(last.nextCursor, null);
        assert.equal(db.queries.length, 3);
        assert.deepEqual(db.queries[1], { method: "findMany", where: { uniqueId: { gt: "0002" } }, orderBy: { uniqueId: "asc" }, take: 2, select: CANDIDATE_AGGREGATE_SELECT });
    });

    test("ordering is deterministic: the same data gives the same batches", async () => {
        const rows = [candidateRow(2), candidateRow(4), candidateRow(1), candidateRow(3)];
        const collect = async () => {
            const out = [];
            for await (const batch of createCandidateAggregateReader({ db: fakeDb(rows) }).readAll({ limit: 3 })) out.push(batch.map((a) => a.user.uniqueId));
            return out;
        };
        assert.deepEqual(await collect(), [["0001", "0002", "0003"], ["0004"]]);
        assert.deepEqual(await collect(), await collect());
    });

    test("batch size and cursor are validated; the reader never writes", async () => {
        const db = fakeDb([candidateRow(1)]);
        const reader = createCandidateAggregateReader({ db });
        for (const limit of [0, -1, 1.5, MAX_AGGREGATE_BATCH_SIZE + 1]) await assert.rejects(reader.readBatch({ limit }), /batch size/);
        await assert.rejects(reader.readBatch({ afterUniqueId: "" }), /cursor/);
        assert.ok(db.queries.every((q) => q.method === "findUnique" || q.method === "findMany"));
    });

    test("reader output maps to exactly 41 cells with AO = unique_id", async () => {
        const reader = createCandidateAggregateReader({ db: fakeDb([candidateRow(1)]) });
        const row = mapCandidateToSheetRow(await reader.findByUniqueId("0001"), { mirroredAt: NOW });
        assert.equal(row.length, 41);
        assert.equal(row[40], "0001");
        assert.equal(row[1], "SYNPASS01");
    });
});

// ---------------------------------------------------------------- row identity

describe("AO row identity", () => {
    test("builds unique_id -> row from AO; blank AO cells identify no one", () => {
        const { index, blankRows } = buildCandidateRowIndex([
            { rowNumber: 2, candidateId: "0001" },
            { rowNumber: 3, candidateId: "" },
            { rowNumber: 4, candidateId: "   " },
            { rowNumber: 5, candidateId: "0002" },
        ]);
        assert.deepEqual([...index], [["0001", 2], ["0002", 5]]);
        assert.equal(blankRows, 2);
        assert.equal(index.has(""), false);
    });

    test("a duplicate non-empty AO ID is a hard data-integrity error, reported with rows, no guess", () => {
        const error = (() => {
            try {
                buildCandidateRowIndex([{ rowNumber: 2, candidateId: "0001" }, { rowNumber: 3, candidateId: "0002" }, { rowNumber: 9, candidateId: "0001" }]);
            } catch (e) {
                return e;
            }
        })();
        assert.ok(error instanceof SheetDuplicateCandidateIdError);
        assert.equal(error.errorClass, "DATA_INTEGRITY");
        assert.deepEqual(error.duplicates, [{ candidateId: "0001", rowNumbers: [2, 9] }]);
    });

    test("IDs match exactly as text: 42 is not 0042", () => {
        const { index } = buildCandidateRowIndex([{ rowNumber: 2, candidateId: "42" }]);
        assert.equal(index.get("0042"), undefined);
    });
});

// ---------------------------------------------------------------- planner

describe("sync planner (read-only)", () => {
    const planner = (dbRows, sheetRows, client = fakeSheets({ rows: sheetRows })) => ({
        client,
        planner: createSheetSyncPlanner({ reader: createCandidateAggregateReader({ db: fakeDb(dbRows) }), sheets: sheetAdapter(client, true), clock: () => NOW }),
    });

    test("a candidate absent from the Sheet is planned as APPEND", async () => {
        const { planner: p, client } = planner([candidateRow(1)], [expectedRow(2)]);
        assert.deepEqual(await p.planCandidate("0001"), { action: SYNC_ACTION.APPEND, candidateId: "0001", rowNumber: null, changedColumns: [] });
        assert.deepEqual(writes(client), []);
    });

    test("a matching row is UNCHANGED (LAST MIRRORED AT ignored); a different row is UPDATE with column letters only", async () => {
        const sheetRows = [expectedRow(2), expectedRow(1)];
        sheetRows[1][SHEET_COLUMNS.findIndex((c) => c.field === "lastMirroredAt")] = "2020-01-01T00:00:00Z";
        const { planner: p } = planner([candidateRow(1)], sheetRows);
        assert.deepEqual(await p.planCandidate("0001"), { action: SYNC_ACTION.UNCHANGED, candidateId: "0001", rowNumber: 3, changedColumns: [] });

        const stale = [expectedRow(1)];
        stale[0][9] = "OLD ADDRESS";
        stale[0][12] = "MISSING";
        const { planner: p2, client } = planner([candidateRow(1)], stale);
        const plan = await p2.planCandidate("0001");
        assert.deepEqual(plan, { action: SYNC_ACTION.UPDATE, candidateId: "0001", rowNumber: 2, changedColumns: ["J", "M"] });
        assert.doesNotMatch(JSON.stringify(plan), /Example Road|OLD ADDRESS|SYNPASS/);
        assert.deepEqual(writes(client), []);
    });

    test("a candidate not in the database is reported, not planned", async () => {
        const { planner: p } = planner([], [expectedRow(1)]);
        assert.equal((await p.planCandidate("0001")).action, SYNC_ACTION.NOT_IN_DATABASE);
    });

    test("duplicate AO IDs stop planning", async () => {
        const { planner: p, client } = planner([candidateRow(1)], [expectedRow(1), expectedRow(2), expectedRow(1)]);
        await assert.rejects(p.planCandidate("0001"), SheetDuplicateCandidateIdError);
        await assert.rejects(p.planBatch({ limit: 10 }), SheetDuplicateCandidateIdError);
        assert.deepEqual(writes(client), []);
    });

    test("passport number and NIC are never a fallback identity", async () => {
        // The Sheet has this candidate's passport number and NIC, but no AO ID.
        const unkeyed = expectedRow(1);
        unkeyed[40] = "";
        const { planner: p } = planner([candidateRow(1)], [unkeyed]);
        const plan = await p.planCandidate("0001");
        assert.equal(plan.action, SYNC_ACTION.APPEND, "the unkeyed row is not adopted");
        assert.equal(plan.rowNumber, null);
        // Same when the passport number is in AO: it is not this candidate's unique ID.
        const passportKeyed = expectedRow(1);
        passportKeyed[40] = "SYNPASS01";
        assert.equal((await planner([candidateRow(1)], [passportKeyed]).planner.planCandidate("0001")).action, SYNC_ACTION.APPEND);
    });

    test("an invalid Sheet header stops planning before reading candidates", async () => {
        const header = [...SHEET_HEADERS];
        header[21] = "POLICE REP SL NORMAL";
        const client = fakeSheets({ header, rows: [] });
        const db = fakeDb([candidateRow(1)]);
        const p = createSheetSyncPlanner({ reader: createCandidateAggregateReader({ db }), sheets: sheetAdapter(client, true), clock: () => NOW });
        const error = await p.planCandidate("0001").catch((e) => e);
        assert.ok(error instanceof SheetSchemaMismatchError);
        assert.deepEqual(error.mismatches.map((m) => m.column), ["V"]);
        assert.equal(db.queries.length, 0);
    });

    test("batch planning reads the Sheet once and plans each candidate in unique_id order", async () => {
        const sheetRows = [expectedRow(2), blankRow(), expectedRow(3)];
        sheetRows[2][16] = "VERIFIED"; // SCAN differs
        const { planner: p, client } = planner([candidateRow(3), candidateRow(1), candidateRow(2)], sheetRows);
        const { plans, nextCursor, blankSheetRows } = await p.planBatch({ limit: 10 });
        assert.deepEqual(plans.map((x) => [x.candidateId, x.action, x.rowNumber, x.changedColumns]), [
            ["0001", "APPEND", null, []],
            ["0002", "UNCHANGED", 2, []],
            ["0003", "UPDATE", 4, ["Q"]],
        ]);
        assert.equal(nextCursor, null);
        assert.equal(blankSheetRows, 1);
        assert.deepEqual(client.calls.map((c) => c.range.split("!")[1]), ["A1:AO1", "A2:AO"]);
    });

    test("the planner cannot write, even when handed a write-enabled adapter", async () => {
        const client = fakeSheets({ rows: [] });
        const p = createSheetSyncPlanner({ reader: createCandidateAggregateReader({ db: fakeDb([candidateRow(1)]) }), sheets: sheetAdapter(client, true), clock: () => NOW });
        await p.planCandidate("0001");
        await p.planBatch({ limit: 5 });
        assert.deepEqual(writes(client), [], "no append, update, clear or batchUpdate");
        assert.deepEqual(Object.keys(p).sort(), ["planBatch", "planCandidate"]);
        const view = readOnlySheetsView(sheetAdapter(client, true));
        assert.equal(view.appendRow, undefined);
        assert.equal(view.updateRow, undefined);
        assert.ok(Object.isFrozen(view));
    });
});

// ---------------------------------------------------------------- read-only health check

describe("read-only connection/schema check", () => {
    const env = { SHEET_SPREADSHEET_ID: "fake-id", SHEET_TAB_NAME: TAB };

    test("exact header: CONNECTED and SCHEMA_VALID, reading A1:AO1 only", async () => {
        const client = fakeSheets({ rows: [expectedRow(1)] });
        const result = await runSheetHealthCheck({ env, sheetsClient: client, clock: () => NOW });
        assert.equal(result.ok, true);
        assert.equal(result.status, HEALTH_STATUS.CONNECTED);
        assert.equal(result.schema, SCHEMA_STATUS.VALID);
        assert.deepEqual(client.calls.map((c) => [c.method, c.range]), [["get", `'${TAB}'!A1:AO1`]]);
        assert.equal(client.calls[0].spreadsheetId, "fake-id");
    });

    test("wrong header: CONNECTED but SCHEMA_INVALID, with column letters only", async () => {
        const header = [...SHEET_HEADERS];
        header[0] = "TEST NO";
        header[40] = "";
        const result = await runSheetHealthCheck({ env, sheetsClient: fakeSheets({ header }), clock: () => NOW });
        assert.equal(result.ok, false);
        assert.equal(result.schema, SCHEMA_STATUS.INVALID);
        assert.deepEqual(result.mismatchedColumns, ["A", "AO"]);
        assert.doesNotMatch(JSON.stringify(result), /TEST NO|_SYSTEM_CANDIDATE_ID/);
    });

    test("never calls append/update/clear/batchUpdate, and works with writes disabled", async () => {
        const client = fakeSheets();
        await runSheetHealthCheck({ env, sheetsClient: client, clock: () => NOW });
        assert.deepEqual(writes(client), []);
        assert.equal(readSheetSyncConfig(env).enabled, false, "SHEET_SYNC_ENABLED was not needed");
    });

    test("does not write even when SHEET_SYNC_ENABLED=true; reports the gate as information", async () => {
        const client = fakeSheets();
        const result = await runSheetHealthCheck({ env: { ...env, SHEET_SYNC_ENABLED: "true" }, sheetsClient: client, clock: () => NOW });
        assert.equal(result.writeGate, "ENABLED");
        assert.deepEqual(writes(client), []);
    });

    test("Google failures become safe categories without Google's message or credentials", async () => {
        const cases = [
            [{ response: { status: 403 } }, HEALTH_STATUS.ACCESS_DENIED],
            [{ response: { status: 401 } }, HEALTH_STATUS.ACCESS_DENIED],
            [{ response: { status: 404 } }, HEALTH_STATUS.NOT_FOUND],
            [{ response: { status: 400 } }, HEALTH_STATUS.BAD_REQUEST],
            [{ response: { status: 503 } }, HEALTH_STATUS.UNAVAILABLE],
            [{ code: "ECONNRESET" }, HEALTH_STATUS.UNAVAILABLE],
        ];
        for (const [fields, expected] of cases) {
            const error = Object.assign(new Error("Request had invalid credentials: token ya29.SECRET for fake-id 'Fake Tab'!A1 SYNPASS01"), fields);
            const result = await runSheetHealthCheck({ env, sheetsClient: fakeSheets({ fail: error }), clock: () => NOW });
            assert.equal(result.status, expected);
            assert.equal(result.ok, false);
            assert.doesNotMatch(JSON.stringify(result), /ya29|SECRET|invalid credentials|fake-id|Fake Tab|SYNPASS01/);
        }
    });

    test("not configured, or a key file configured: refused without contacting Google", async () => {
        const client = fakeSheets();
        assert.equal((await runSheetHealthCheck({ env: {}, sheetsClient: client })).status, HEALTH_STATUS.NOT_CONFIGURED);
        const keyFile = await runSheetHealthCheck({ env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: "/x/key.json" }, sheetsClient: client });
        assert.equal(keyFile.status, HEALTH_STATUS.CONFIG_ERROR);
        assert.equal(keyFile.reason, "KEY_FILE_NOT_ALLOWED");
        assert.doesNotMatch(JSON.stringify(keyFile), /key\.json/);
        assert.deepEqual(client.calls, []);
    });

    test("the result holds no candidate data even when the Sheet has rows", async () => {
        const result = await runSheetHealthCheck({ env, sheetsClient: fakeSheets({ rows: [expectedRow(1)] }), clock: () => NOW });
        const text = JSON.stringify(result);
        for (const value of PII) assert.equal(text.includes(value), false, value);
    });

    test("under the test runner the default (live) client is refused: no Google contact possible", async () => {
        const result = await runSheetHealthCheck({ env, clock: () => NOW });
        assert.equal(result.status, HEALTH_STATUS.FAILED);
        assert.equal(result.ok, false);
    });

    test("the CLI entry prints one sanitized JSON line and exits 0 only when connected with a valid schema", async () => {
        const lines = [];
        const ok = await runCheckCommand({ env, sheetsClient: fakeSheets(), write: (t) => lines.push(t) });
        assert.equal(ok, 0);
        const printed = JSON.parse(lines[0]);
        assert.equal(printed.event, "sheet_sync.health_check");
        assert.equal(printed.status, "CONNECTED");
        assert.equal(printed.schema, "SCHEMA_VALID");
        const bad = await runCheckCommand({ env: {}, write: () => {} });
        assert.equal(bad, 1);
    });
});

describe("write gate stays off by default", () => {
    test("SHEET_SYNC_ENABLED defaults to disabled, and this test process has it disabled", () => {
        assert.equal(readSheetSyncConfig({}).enabled, false);
        assert.equal(isSheetSyncEnabled(), false);
    });

    test("a write through the default adapter is refused while disabled, before any Google call", async () => {
        const client = fakeSheets();
        const adapter = createGoogleSheetsAdapter({ config: readSheetSyncConfig({ SHEET_SPREADSHEET_ID: "fake-id", SHEET_TAB_NAME: TAB }), sheetsClient: client });
        await assert.rejects(adapter.appendRow(blankRow("0001")), /disabled/);
        assert.deepEqual(client.calls, []);
    });

    test("the schema still has exactly 41 columns with AO as the system candidate ID", () => {
        assert.equal(SHEET_COLUMNS.length, 41);
        assert.equal(SHEET_COLUMNS[40].header, "_SYSTEM_CANDIDATE_ID");
    });
});
