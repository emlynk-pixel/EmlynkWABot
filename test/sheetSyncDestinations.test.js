// Google Sheet Sync -> Sync Destination. Configuration (SHEET_SYNC_DESTINATIONS
// with the single-Sheet fallback), the switch request API, the worker's
// validation-before-activation, the audit entry, and that every run uses
// (and records) the active destination. Real PostgreSQL (PGlite, every
// migration), the real store, engine, adapter, worker and admin router; only
// Google is replaced, by in-memory Sheets (test/helpers/fakeGoogleSheet.js):
// nothing here can reach Google or a real Sheet.
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase, migrationNames } from "./helpers/pgliteDatabase.js";
import { createFakeGoogleSheet } from "./helpers/fakeGoogleSheet.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createCandidate, parseCandidateBody } from "../src/services/candidateService.js";
import { createCandidateAggregateReader } from "../src/services/candidateAggregateReader.js";
import { createGoogleSheetsAdapter } from "../src/services/googleSheetsAdapter.js";
import { createSheetSyncEngine } from "../src/services/sheetSyncEngine.js";
import { createSheetSyncStore } from "../src/services/sheetSyncStore.js";
import { createSheetSyncWorker } from "../src/services/sheetSyncWorker.js";
import { runSheetHealthCheck } from "../src/services/sheetHealthCheck.js";
import { getSheetSyncStatus, requestDestinationSwitch } from "../src/services/sheetSyncStatusService.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { DEFAULT_DESTINATION_KEY, SHEET_SYNC_SCHEDULE, publicDestination, readSheetSyncConfig, readSheetSyncTuning, resolveDestination } from "../src/config/sheetSync.js";
import { SHEET_HEADERS, SYSTEM_CANDIDATE_ID_INDEX } from "../src/services/sheetSchema.js";

const MIGRATION = "20261012120000_sheet_sync_destination";
const OPS_ID = "opsSpreadsheetId0000000000JirMpE";
const RO_ID = "romaniaSpreadsheet00000000Ro1234";
const BAD_ID = "brokenSpreadsheet000000000Bad999";
const DESTINATIONS = [
    { key: "operational", name: "Emlynk Candidate Operational Mirror", spreadsheetId: OPS_ID, tabName: "Emlynk Candidate Operational Mirror" },
    { key: "romania", name: "Romania Candidates", spreadsheetId: RO_ID, tabName: "Romania" },
    { key: "broken", name: "Broken Sheet", spreadsheetId: BAD_ID, tabName: "Broken" },
];
const ADMIN = { adminId: "user-admin", authUserId: "00000000-0000-4000-8000-000000000001", name: "Ada Admin", email: "ada@example.invalid", role: "ADMIN" };

let database;
let prisma;
let pg;
before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    await prisma.user.create({ data: ADMIN });
});
after(async () => database?.close());
beforeEach(async () => {
    await pg.exec(`
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "documents"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
        DELETE FROM "sheet_sync_queue"; DELETE FROM "sheet_sync_runs";
        UPDATE "sheet_sync_state" SET "integration_state" = 'UNKNOWN', "writer_lease_owner" = NULL, "writer_lease_expires_at" = NULL,
            "last_error_class" = NULL, "last_error_code" = NULL, "last_sync_success_at" = NULL,
            "destinations" = NULL, "active_destination_key" = NULL, "requested_destination_key" = NULL;
    `);
    const { values } = parseCandidateBody({
        passportId: "N1023757", surname: "De Soysa", otherNames: "Anusha", nic: "965404378V", whatsappNumber: "+94771234567",
        jobTypes: ["Caregiver"], jobExperience: "2 years", passportIssueDate: "2020-01-15", passportExpiryDate: "2030-01-14",
    }, { creating: true });
    await createCandidate({ db: prisma, values });
});

// The worker with one in-memory Sheet per destination ("broken" has a
// renamed required header), as src/sheetSyncWorker.js wires it.
function setup({ destinations = DESTINATIONS, enabled = true } = {}) {
    const env = { SHEET_SYNC_ENABLED: enabled ? "true" : "false", SHEET_SYNC_DESTINATIONS: JSON.stringify(destinations) };
    const config = readSheetSyncConfig(env);
    assert.deepEqual(config.problems, []);
    const badHeader = SHEET_HEADERS.map((h) => (h === "PASSPORT NUMBER" ? "PASSPORT NO" : h));
    const sheets = Object.fromEntries(destinations.map((d) => [d.key, createFakeGoogleSheet({ tabName: d.tabName, ...(d.key === "broken" ? { header: badHeader } : {}) })]));
    const reader = createCandidateAggregateReader({ db: prisma });
    const runners = new Map();
    const forDestination = (destination) => {
        if (!runners.has(destination.key)) {
            const sheet = sheets[destination.key];
            const adapter = createGoogleSheetsAdapter({ config: { ...config, spreadsheetId: destination.spreadsheetId, tabName: destination.tabName }, sheetsClient: sheet.client });
            runners.set(destination.key, {
                engine: createSheetSyncEngine({ reader, sheets: adapter }),
                healthCheck: () => runSheetHealthCheck({ env, sheetsClient: sheet.client, destination }),
            });
        }
        return runners.get(destination.key);
    };
    const store = createSheetSyncStore({ db: prisma });
    const lines = [];
    const log = { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
    const worker = createSheetSyncWorker({ store, forDestination, destinations: config.destinations, config, tuning: readSheetSyncTuning(env), log });
    return { store, worker, sheets, lines, config };
}

const state = () => prisma.sheetSyncState.findUnique({ where: { stateId: "sheet-sync" } });
const ids = (sheet) => sheet.dataRows().map((r) => r[SYSTEM_CANDIDATE_ID_INDEX]);
async function reconcile(store, worker, triggerSource) {
    const { run } = await store.requestRun({ kind: "RECONCILE", triggerSource, requestedBy: triggerSource === "ADMIN" ? ADMIN.adminId : null });
    await worker.tick();
    return store.getRun(run.runId);
}
async function switchTo(key) {
    return requestDestinationSwitch({ db: prisma, key, requestedBy: ADMIN.adminId });
}

async function withAdminApi(role, work) {
    const app = express();
    app.use(express.json());
    const requireAdmin = (req, res, next) => { req.user = { ...ADMIN, role, status: "ACTIVE" }; next(); };
    app.use("/api/admin", createAdminRouter({ db: prisma, requireAdmin, apiLimiter: noRateLimit }));
    app.use(errorHandler);
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    try {
        return await work(async (method, urlPath, body) => {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/settings/sheet-sync${urlPath}`, {
                method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: await response.json() };
        });
    } finally {
        server.close();
    }
}

describe("configuration", () => {
    test("fallback: without SHEET_SYNC_DESTINATIONS the existing SHEET_SPREADSHEET_ID / SHEET_TAB_NAME are the one (default) destination", () => {
        const config = readSheetSyncConfig({ SHEET_SYNC_ENABLED: "true", SHEET_SPREADSHEET_ID: OPS_ID, SHEET_TAB_NAME: "Emlynk Candidate Operational Mirror" });
        assert.deepEqual(config.problems, []);
        assert.deepEqual(config.destinations, [{ key: DEFAULT_DESTINATION_KEY, name: "Emlynk Candidate Operational Mirror", spreadsheetId: OPS_ID, tabName: "Emlynk Candidate Operational Mirror" }]);
        assert.equal(config.spreadsheetId, OPS_ID, "the plain fields are unchanged");
        assert.equal(config.tabName, "Emlynk Candidate Operational Mirror");
        assert.deepEqual(readSheetSyncConfig({}).destinations, [], "nothing configured: no destination");
        assert.deepEqual(readSheetSyncConfig({ SHEET_SYNC_ENABLED: "true" }).problems, ["SHEET_SPREADSHEET_ID is missing", "SHEET_TAB_NAME is missing"]);
    });

    test("SHEET_SYNC_DESTINATIONS: a JSON list; the first is the default and fills the plain fields", () => {
        const config = readSheetSyncConfig({ SHEET_SYNC_ENABLED: "true", SHEET_SYNC_DESTINATIONS: JSON.stringify(DESTINATIONS.slice(0, 2)) });
        assert.deepEqual(config.problems, [], "SHEET_SPREADSHEET_ID is not needed then");
        assert.deepEqual(config.destinations.map((d) => d.key), ["operational", "romania"]);
        assert.equal(config.spreadsheetId, OPS_ID);
        assert.equal(resolveDestination(config.destinations, null).key, "operational", "nothing chosen = the first");
        assert.equal(resolveDestination(config.destinations, "romania").key, "romania");
        assert.equal(resolveDestination(config.destinations, "gone"), null, "a key no longer configured resolves to nothing, never another Sheet");
    });

    test("invalid lists are refused, naming the variable only (never a value)", () => {
        const problems = (value) => readSheetSyncConfig({ SHEET_SYNC_DESTINATIONS: value }).problems;
        for (const value of [
            "not json", "{}", "[]",
            JSON.stringify([{ key: "Bad Key", name: "x", spreadsheetId: OPS_ID, tabName: "t" }]),
            JSON.stringify([{ key: "a", name: "", spreadsheetId: OPS_ID, tabName: "t" }]),
            JSON.stringify([{ key: "a", name: "x", spreadsheetId: "bad id!", tabName: "t" }]),
            JSON.stringify([{ key: "a", name: "x", spreadsheetId: OPS_ID, tabName: "" }]),
            JSON.stringify([{ key: "a", name: "x", spreadsheetId: OPS_ID, tabName: "t" }, { key: "a", name: "y", spreadsheetId: RO_ID, tabName: "u" }]),
        ]) {
            const found = problems(value);
            assert.equal(found.length, 1, value);
            assert.match(found[0], /^SHEET_SYNC_DESTINATIONS /);
            assert.doesNotMatch(found[0], new RegExp(OPS_ID));
        }
    });

    test("the Admin page's metadata never holds the full spreadsheet ID", () => {
        assert.deepEqual(publicDestination(DESTINATIONS[0]), { key: "operational", name: "Emlynk Candidate Operational Mirror", hint: "…JirMpE", tabName: "Emlynk Candidate Operational Mirror" });
    });

    test("migration: four nullable columns on the existing Sheet Sync tables, nothing else", () => {
        assert.ok(migrationNames().includes(MIGRATION));
        const sql = fs.readFileSync(path.join("prisma", "migrations", MIGRATION, "migration.sql"), "utf8").replace(/--.*$/gm, "");
        assert.doesNotMatch(sql, /CREATE TABLE|DROP|NOT NULL|UPDATE "|DELETE/i);
        assert.deepEqual((sql.match(/ADD COLUMN "\w+"/g) ?? []).sort(), ['ADD COLUMN "active_destination_key"', 'ADD COLUMN "destination_key"', 'ADD COLUMN "destinations"', 'ADD COLUMN "requested_destination_key"']);
    });

    test("14. the automatic schedule is unchanged: 06:00, 12:00, 18:00 Asia/Colombo", () => {
        assert.deepEqual([SHEET_SYNC_SCHEDULE.cron, SHEET_SYNC_SCHEDULE.timeZone, [...SHEET_SYNC_SCHEDULE.times]], ["0 6,12,18 * * *", "Asia/Colombo", ["06:00", "12:00", "18:00"]]);
    });
});

describe("runs use the active destination", () => {
    test("the worker publishes the configured destinations (safe metadata only) and the active one's hint", async () => {
        const { worker } = setup();
        await worker.tick();
        const row = await state();
        assert.deepEqual(row.destinations.map((d) => d.key), ["operational", "romania", "broken"]);
        assert.doesNotMatch(JSON.stringify(row.destinations), new RegExp(`${OPS_ID}|${RO_ID}|${BAD_ID}`));
        assert.equal(row.targetHint, "…JirMpE / Emlynk Candidate Operational Mirror");
        const status = await getSheetSyncStatus({ db: prisma });
        assert.deepEqual(status.destination.available.map((d) => d.name), ["Emlynk Candidate Operational Mirror", "Romania Candidates", "Broken Sheet"]);
        assert.equal(status.destination.activeKey, "operational", "nothing chosen yet = the first (default)");
        assert.equal(status.destination.requestedKey, null);
        assert.doesNotMatch(JSON.stringify(status), new RegExp(`${OPS_ID}|${RO_ID}|${BAD_ID}`));
    });

    test("9. a scheduled run and 8. a manual run (Sync Now) write to the active destination only and record its key", async () => {
        const { store, worker, sheets } = setup();
        const scheduled = await reconcile(store, worker, "SCHEDULER");
        assert.equal(scheduled.status, "SUCCEEDED");
        assert.equal(scheduled.destinationKey, "operational");
        assert.equal(ids(sheets.operational).length, 1);
        assert.deepEqual(sheets.romania.writes(), [], "no other Sheet is touched");

        const manual = await reconcile(store, worker, "ADMIN");
        assert.equal(manual.destinationKey, "operational");
        assert.equal(manual.triggerSource, "ADMIN");
    });

    test("7. Test Connection checks the active destination and records it", async () => {
        const { store, worker, sheets } = setup();
        await prisma.sheetSyncState.update({ where: { stateId: "sheet-sync" }, data: { activeDestinationKey: "romania" } });
        const { run } = await store.requestRun({ kind: "TEST_CONNECTION", triggerSource: "ADMIN", requestedBy: ADMIN.adminId });
        await worker.tick();
        const finished = await store.getRun(run.runId);
        assert.equal(finished.status, "SUCCEEDED");
        assert.equal(finished.destinationKey, "romania");
        assert.ok(sheets.romania.calls.some((c) => c.method === "get"), "the romania Sheet was read");
        assert.deepEqual(sheets.operational.calls, [], "the operational Sheet was not");
    });

    test("an active key that is no longer configured: nothing is synced, the run fails clearly, no other Sheet is used", async () => {
        const { store, worker, sheets } = setup();
        await prisma.sheetSyncState.update({ where: { stateId: "sheet-sync" }, data: { activeDestinationKey: "removed" } });
        const run = await reconcile(store, worker, "SCHEDULER");
        assert.equal(run.status, "FAILED");
        assert.equal(run.errorClass, "DESTINATION_NOT_CONFIGURED");
        for (const sheet of Object.values(sheets)) assert.deepEqual(sheet.writes(), []);
        assert.equal((await state()).integrationState, "CONFIG_ERROR");
    });
});

describe("switching the destination", () => {
    test("5-6, 8-9. a valid destination: pending, validated by the worker, then active; later runs use it; the change is audited", async () => {
        const { store, worker, sheets } = setup();
        await worker.tick(); // publishes the destinations
        await reconcile(store, worker, "SCHEDULER");
        const opsWritesBefore = sheets.operational.writes().length;

        const requested = await switchTo("romania");
        assert.equal(requested.status, "PENDING");
        assert.equal(requested.run.kind, "TEST_CONNECTION");
        assert.equal(requested.run.destinationKey, "romania");
        let row = await state();
        assert.equal(row.requestedDestinationKey, "romania");
        assert.equal(row.activeDestinationKey, null, "still the previous (default) destination until validated");

        await worker.tick(); // runs the validation
        row = await state();
        assert.equal(row.activeDestinationKey, "romania");
        assert.equal(row.requestedDestinationKey, null);
        const check = await store.getRun(requested.run.runId);
        assert.equal(check.status, "SUCCEEDED");
        assert.equal(check.summary.purpose, "DESTINATION_SWITCH");
        assert.equal(check.summary.promoted, true);
        assert.equal(row.targetHint, "…JirMpE / Emlynk Candidate Operational Mirror", "the hint follows on the next heartbeat");
        await worker.tick();
        assert.equal((await state()).targetHint, "…Ro1234 / Romania");

        const audit = await prisma.auditLog.findMany({ where: { action: "SET_SHEET_DESTINATION" } });
        assert.equal(audit.length, 1);
        assert.deepEqual([audit[0].adminId, audit[0].previousStatus, audit[0].newStatus, audit[0].previousValue, audit[0].newValue],
            [ADMIN.adminId, "operational", "romania", "Emlynk Candidate Operational Mirror", "Romania Candidates"]);
        assert.doesNotMatch(JSON.stringify(audit), new RegExp(`${OPS_ID}|${RO_ID}`), "no spreadsheet IDs in the audit log");

        const scheduled = await reconcile(store, worker, "SCHEDULER");
        assert.equal(scheduled.destinationKey, "romania");
        assert.equal(ids(sheets.romania).length, 1, "the new destination receives the database rows");
        assert.equal(sheets.operational.writes().length, opsWritesBefore, "11. the previous Sheet is neither written nor cleared");
        assert.equal(ids(sheets.operational).length, 1, "its rows are left as they were");
        assert.equal((await reconcile(store, worker, "ADMIN")).destinationKey, "romania");

        const status = await getSheetSyncStatus({ db: prisma });
        assert.equal(status.destination.activeKey, "romania");
        assert.equal(status.destination.lastSwitch.status, "SUCCEEDED");
    });

    test("12. an invalid destination (renamed header) never becomes active: the previous one stays, the error is recorded, nothing syncs there", async () => {
        const { store, worker, sheets } = setup();
        await worker.tick();
        const requested = await switchTo("broken");
        await worker.tick();
        const row = await state();
        assert.equal(row.activeDestinationKey, null, "the previous (default) destination is unchanged");
        assert.equal(row.requestedDestinationKey, null, "the request is withdrawn");
        assert.equal(row.integrationState, "UNKNOWN", "the active destination's state is not touched");
        const check = await store.getRun(requested.run.runId);
        assert.equal(check.status, "FAILED");
        assert.equal(check.errorClass, "SCHEMA_INVALID");
        assert.equal(check.errorCode, "MISSING:PASSPORT NUMBER");
        assert.equal(await prisma.auditLog.count({ where: { action: "SET_SHEET_DESTINATION" } }), 0, "no audit entry for a switch that didn't happen");

        const run = await reconcile(store, worker, "SCHEDULER");
        assert.equal(run.destinationKey, "operational");
        assert.deepEqual(sheets.broken.writes(), []);
        const status = await getSheetSyncStatus({ db: prisma });
        assert.equal(status.destination.lastSwitch.errorClass, "SCHEMA_INVALID");
        assert.equal(status.destination.lastSwitch.destinationKey, "broken");
    });

    test("the switch is never applied while a writer holds the lease; the previous destination stays", async () => {
        const { store, worker } = setup();
        await worker.tick();
        await switchTo("romania");
        await store.acquireWriterLease({ owner: "another-worker", now: new Date(), leaseMs: 60_000 });
        await worker.tick();
        const row = await state();
        assert.equal(row.activeDestinationKey, null);
        assert.equal(row.requestedDestinationKey, null);
        const check = (await store.recentRuns("TEST_CONNECTION", 1))[0];
        assert.equal(check.errorClass, "WRITER_BUSY");
        await store.releaseWriterLease({ owner: "another-worker" });
    });

    test("11. switching reads only the new Sheet's header and never changes the database", async () => {
        const { worker, sheets } = setup();
        await worker.tick();
        const before = await prisma.candidate.findMany({ orderBy: { passportId: "asc" } });
        await switchTo("romania");
        await worker.tick();
        assert.deepEqual(sheets.romania.calls.map((c) => c.method), ["get"], "one read: row 1");
        assert.match(sheets.romania.calls[0].range, /!1:1$/);
        assert.deepEqual(await prisma.candidate.findMany({ orderBy: { passportId: "asc" } }), before);
    });

    test("requests: unknown 400, already active 200, a pending switch or a running test 409; no fake destinations", async () => {
        const { worker } = setup({ destinations: DESTINATIONS.slice(0, 2) });
        await worker.tick();
        await assert.rejects(switchTo("israel"), (e) => e.status === 400 && e.code === "UNKNOWN_DESTINATION");
        assert.deepEqual(await switchTo("operational"), { status: "ALREADY_ACTIVE", activeKey: "operational", run: null });
        await switchTo("romania");
        await assert.rejects(switchTo("romania"), (e) => e.status === 409 && e.code === "SWITCH_PENDING");
        assert.deepEqual((await getSheetSyncStatus({ db: prisma })).destination.available.map((d) => d.key), ["operational", "romania"], "3-4. only the configured ones");
    });

    test("a request while a connection test is running is refused and leaves no pending switch", async () => {
        const { store, worker } = setup();
        await worker.tick();
        await store.requestRun({ kind: "TEST_CONNECTION", triggerSource: "ADMIN", requestedBy: ADMIN.adminId });
        await assert.rejects(switchTo("romania"), (e) => e.status === 409 && e.code === "TEST_RUNNING");
        assert.equal((await state()).requestedDestinationKey, null);
    });

    test("single destination (the current deployment): one option, active, nothing to switch to", async () => {
        const env = { SHEET_SYNC_ENABLED: "true", SHEET_SPREADSHEET_ID: OPS_ID, SHEET_TAB_NAME: "Emlynk Candidate Operational Mirror" };
        const config = readSheetSyncConfig(env);
        const sheet = createFakeGoogleSheet({ tabName: config.tabName });
        const store = createSheetSyncStore({ db: prisma });
        const worker = createSheetSyncWorker({
            store, config, tuning: readSheetSyncTuning(env), log: { log() {}, warn() {}, error() {} },
            engine: createSheetSyncEngine({ reader: createCandidateAggregateReader({ db: prisma }), sheets: createGoogleSheetsAdapter({ config, sheetsClient: sheet.client }) }),
            healthCheck: () => runSheetHealthCheck({ env, sheetsClient: sheet.client }),
        });
        await worker.tick();
        const status = await getSheetSyncStatus({ db: prisma });
        assert.deepEqual(status.destination.available, [{ key: "default", name: "Emlynk Candidate Operational Mirror", hint: "…JirMpE", tabName: "Emlynk Candidate Operational Mirror" }]);
        assert.equal(status.destination.activeKey, "default");
        const run = await reconcile(store, worker, "SCHEDULER");
        assert.equal(run.status, "SUCCEEDED");
        assert.equal(run.destinationKey, "default");
        assert.equal(ids(sheet).length, 1);
    });
});

describe("API: PUT /settings/sheet-sync/destination", () => {
    test("10. ADMIN only: other roles get 403 and nothing is recorded", async () => {
        const { worker } = setup();
        await worker.tick();
        for (const role of ["MANAGER", "ANALYST", "REGISTRATION_DESK"]) {
            const response = await withAdminApi(role, (call) => call("PUT", "/destination", { key: "romania" }));
            assert.equal(response.status, 403, role);
        }
        assert.equal((await state()).requestedDestinationKey, null);
        assert.equal(await prisma.sheetSyncRun.count(), 0);
    });

    test("ADMIN: 202 with the pending check; invalid body 400; unknown 400; status shows the pending switch", async () => {
        const { worker } = setup();
        await worker.tick();
        await withAdminApi("ADMIN", async (call) => {
            assert.equal((await call("PUT", "/destination", {})).status, 400);
            assert.equal((await call("PUT", "/destination", { key: "Not A Key" })).status, 400);
            const unknown = await call("PUT", "/destination", { key: "israel" });
            assert.deepEqual([unknown.status, unknown.body.code], [400, "UNKNOWN_DESTINATION"]);
            const accepted = await call("PUT", "/destination", { key: "romania" });
            assert.equal(accepted.status, 202);
            assert.equal(accepted.body.requestedKey, "romania");
            const status = await call("GET", "/status");
            assert.equal(status.body.destination.requestedKey, "romania");
            assert.equal(status.body.destination.activeKey, "operational");
            assert.equal(status.body.activeRuns.testConnection.destinationKey, "romania");
        });
    });
});
