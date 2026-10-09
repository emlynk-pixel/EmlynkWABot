// Google Sheet mirror, Phases 3-4 end to end (locally): real PostgreSQL
// (PGlite, every migration incl. the outbox triggers), the real candidate
// service, store, reader, engine, adapter and worker. Only Google is replaced,
// by an in-memory Sheet (test/helpers/fakeGoogleSheet.js): no test here can
// reach Google or the real operational Sheet.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { createFakeGoogleSheet, googleError } from "./helpers/fakeGoogleSheet.js";
import { createCandidate, parseCandidateBody, parseStageBody, updateStage } from "../src/services/candidateService.js";
import { createCandidateAggregateReader } from "../src/services/candidateAggregateReader.js";
import { createGoogleSheetsAdapter } from "../src/services/googleSheetsAdapter.js";
import { createSheetSyncEngine } from "../src/services/sheetSyncEngine.js";
import { createSheetSyncStore } from "../src/services/sheetSyncStore.js";
import { createSheetSyncWorker, WORKER_TIMINGS } from "../src/services/sheetSyncWorker.js";
import { runSheetHealthCheck } from "../src/services/sheetHealthCheck.js";
import { readSheetSyncConfig, readSheetSyncTuning } from "../src/config/sheetSync.js";
import { SHEET_COLUMN_COUNT, SHEET_COLUMNS, SHEET_HEADERS, SYSTEM_CANDIDATE_ID_INDEX } from "../src/services/sheetSchema.js";

const TAB = "Emlynk Candidate Operational Mirror";
const col = (field) => SHEET_COLUMNS.findIndex((c) => c.field === field);
const AL = col("recordStatus");
const AN = col("lastMirroredAt");
const B = col("passportNumber");
const C = col("firstName");

const BODY = {
    passportId: "N1023757", surname: "De Soysa", otherNames: "Anusha", nic: "965404378V",
    whatsappNumber: "+94771234567", jobTypes: ["Caregiver"], jobExperience: "2 years", passportIssueDate: "2020-01-15", passportExpiryDate: "2030-01-14",
};
const SECOND = { passportId: "N7654321", surname: "Perera", otherNames: "Kamal", nic: "199012345678", whatsappNumber: "+94770000002" };

let database;
let prisma;
let pg;
before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
});
after(async () => database?.close());
beforeEach(async () => {
    await pg.exec(`
        DELETE FROM "documents"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
        DELETE FROM "sheet_sync_queue"; DELETE FROM "sheet_sync_runs";
        UPDATE "sheet_sync_state" SET "integration_state" = 'UNKNOWN', "writer_lease_owner" = NULL, "writer_lease_expires_at" = NULL,
            "last_error_class" = NULL, "last_error_code" = NULL, "last_sync_success_at" = NULL;
    `);
});

// The clock can jump forward (offsetMs) to make retries due.
function setup({ enabled = true, rows = [], header, env = {} } = {}) {
    let offsetMs = 0;
    const clock = () => new Date(Date.now() + offsetMs);
    const sheet = createFakeGoogleSheet({ tabName: TAB, rows, ...(header ? { header } : {}) });
    const configEnv = { SHEET_SYNC_ENABLED: enabled ? "true" : "false", SHEET_SPREADSHEET_ID: "fake-spreadsheet-id", SHEET_TAB_NAME: TAB, ...env };
    const config = readSheetSyncConfig(configEnv);
    const tuning = readSheetSyncTuning(configEnv);
    const adapter = createGoogleSheetsAdapter({ config, sheetsClient: sheet.client });
    const engine = createSheetSyncEngine({ reader: createCandidateAggregateReader({ db: prisma }), sheets: adapter, clock });
    const store = createSheetSyncStore({ db: prisma });
    const lines = [];
    const log = { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
    // Another worker process on the same Sheet, clock and database; its store
    // can be wrapped (e.g. to simulate a crash).
    const newWorker = (workerStore = store) => createSheetSyncWorker({
        store: workerStore, engine, config, tuning, clock, log, random: () => 0.5, targetHint: "…id / tab",
        healthCheck: () => runSheetHealthCheck({ env: configEnv, sheetsClient: sheet.client, clock }),
    });
    const worker = newWorker();
    return { sheet, store, worker, newWorker, lines, advance: (ms) => { offsetMs += ms; }, tuning };
}

async function register(body = {}) {
    const { values, errors } = parseCandidateBody({ ...BODY, ...body }, { creating: true });
    assert.equal(errors, undefined);
    return createCandidate({ db: prisma, values });
}

const queueRows = () => prisma.sheetSyncQueue.findMany({ orderBy: { createdAt: "asc" } });
const state = () => prisma.sheetSyncState.findUnique({ where: { stateId: "sheet-sync" } });
const rowFor = (sheet, uniqueId) => sheet.dataRows().filter((r) => r[SYSTEM_CANDIDATE_ID_INDEX] === uniqueId);

describe("incremental sync", () => {
    test("registration -> durable queue row -> worker appends exactly one row and completes the item", async () => {
        const { sheet, worker } = setup();
        const { uniqueId } = await register();
        assert.equal((await queueRows())[0].status, "PENDING");

        await worker.tick();
        const rows = rowFor(sheet, uniqueId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0][B], "N1023757");
        assert.equal(rows[0][AL], "ACTIVE");
        assert.match(rows[0][AN], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        const [item] = await queueRows();
        assert.deepEqual([item.status, item.lastResult], ["COMPLETED", "APPENDED"]);
        const appendCall = sheet.writes().find((c) => c.method === "append");
        assert.deepEqual([appendCall.range, appendCall.insertDataOption, appendCall.valueInputOption], [`'${TAB}'!A:AO`, "INSERT_ROWS", "RAW"]);
        assert.ok((await state()).lastSyncSuccessAt);
    });

    test("multiple rapid updates are coalesced: one queue row, one Sheet write with the latest state", async () => {
        const { sheet, worker } = setup();
        const { passportId, uniqueId } = await register();
        for (const stage of ["IVS_INTERVIEW", "VISA_APPROVAL", "FINALIZING_JOB"]) {
            await updateStage({ db: prisma, passportId, stage, values: parseStageBody({ completed: true }, stage).values });
        }
        assert.equal((await queueRows()).length, 1);
        await worker.tick();
        assert.equal(sheet.writes().length, 1);
        const [row] = rowFor(sheet, uniqueId);
        assert.deepEqual([row[col("ivsInterviewStatus")], row[col("visaApprovalStatus")], row[col("finalizingJobStatus")]], ["COMPLETED", "COMPLETED", "COMPLETED"]);
    });

    test("an existing candidate row is updated in place (found by AO, not by position or passport number)", async () => {
        const { uniqueId } = await register();
        // The candidate's row sits below an unrelated row, with stale data.
        const stale = Array(SHEET_COLUMN_COUNT).fill("");
        stale[C] = "OLD NAME";
        stale[SYSTEM_CANDIDATE_ID_INDEX] = uniqueId;
        const other = Array(SHEET_COLUMN_COUNT).fill("x");
        other[SYSTEM_CANDIDATE_ID_INDEX] = "9999";
        const { sheet, worker } = setup({ rows: [other, stale] });
        await worker.tick();
        assert.deepEqual(sheet.writes().map((c) => [c.method, c.ranges]), [["batchUpdate", [`'${TAB}'!A3:AO3`]]]);
        assert.equal(sheet.row(3)[C], "Anusha");
        assert.deepEqual(sheet.row(2), other, "the unrelated row is untouched");
        assert.equal(sheet.dataRows().length, 2, "no row was appended");
    });

    test("an unchanged row is not rewritten and keeps its LAST MIRRORED AT", async () => {
        const { sheet, worker } = setup();
        const { passportId, uniqueId } = await register();
        await worker.tick();
        const firstMirroredAt = rowFor(sheet, uniqueId)[0][AN];
        // A change that does not alter any mirrored cell (job ID is not mirrored).
        await updateStage({ db: prisma, passportId, stage: "TEST_DETAILS", values: parseStageBody({ jobId: "J-77" }, "TEST_DETAILS").values });
        await worker.tick();
        assert.equal(sheet.writes().length, 1, "only the first append wrote");
        assert.equal(rowFor(sheet, uniqueId)[0][AN], firstMirroredAt);
        assert.equal((await queueRows()).at(-1).lastResult, "UNCHANGED");
    });

    test("syncing the same candidate again (e.g. after a crash before completion) never appends a duplicate row", async () => {
        const { sheet, worker, advance } = setup();
        const { uniqueId } = await register();
        // Claim the item, then "crash" (never settle it).
        const store = createSheetSyncStore({ db: prisma });
        await store.claimQueueBatch({ owner: "crashed-worker", now: new Date(), leaseMs: 1_000, limit: 10 });
        await sheet.client.spreadsheets.values.append({ range: `'${TAB}'!A:AO`, insertDataOption: "INSERT_ROWS", valueInputOption: "RAW", requestBody: { values: [Object.assign(Array(SHEET_COLUMN_COUNT).fill(""), { [SYSTEM_CANDIDATE_ID_INDEX]: uniqueId })] } });
        advance(WORKER_TIMINGS.queueLeaseMs + 5_000);
        await worker.tick(); // reclaims the expired lease
        assert.equal(rowFor(sheet, uniqueId).length, 1);
        assert.equal(rowFor(sheet, uniqueId)[0][C], "Anusha");
        assert.equal((await queueRows())[0].status, "COMPLETED");
    });

    test("Google write succeeds, the process dies before completing the item: the reclaim finds the row, UNCHANGED, not APPENDED", async () => {
        const { sheet, store, worker, newWorker, advance } = setup();
        const { uniqueId } = await register();
        // The process dies right after Google accepted the append: nothing is
        // settled and the leases are never released.
        const died = () => Promise.reject(new Error("process died"));
        const crashed = newWorker({ ...store, completeQueueItem: died, retryQueueItem: died, failQueueItem: died, releaseWriterLease: async () => {} });
        await assert.rejects(crashed.tick(), /process died/);
        assert.equal(rowFor(sheet, uniqueId).length, 1);
        assert.equal((await queueRows())[0].status, "PROCESSING");
        const appendsBefore = sheet.writes().filter((c) => c.method === "append").length;

        advance(Math.max(WORKER_TIMINGS.queueLeaseMs, WORKER_TIMINGS.writerLeaseMs) + 5_000);
        await worker.tick(); // reclaims the expired lease
        assert.equal(rowFor(sheet, uniqueId).length, 1);
        assert.equal(sheet.writes().filter((c) => c.method === "append").length, appendsBefore);
        const [item] = await queueRows();
        assert.deepEqual([item.status, item.lastResult], ["COMPLETED", "UNCHANGED"]);
    });

    test("a blank AO cell identifies nobody: the candidate is appended and the blank row is untouched", async () => {
        const blank = Array(SHEET_COLUMN_COUNT).fill("");
        blank[B] = "N1023757"; // same passport number, but no AO
        blank[C] = "Manual entry";
        const { sheet, worker } = setup({ rows: [blank] });
        const { uniqueId } = await register();
        await worker.tick();
        assert.deepEqual(sheet.row(2), blank);
        assert.equal(rowFor(sheet, uniqueId).length, 1);
    });

    test("duplicate AO: hard data-integrity stop, no write at all, the duplicate rows untouched, the item kept", async () => {
        const { uniqueId } = await register();
        const dup = Array(SHEET_COLUMN_COUNT).fill("");
        dup[SYSTEM_CANDIDATE_ID_INDEX] = uniqueId;
        const dupA = [...dup];
        dupA[C] = "copy A";
        const dupB = [...dup];
        dupB[C] = "copy B";
        const { sheet, worker } = setup({ rows: [dupA, dupB] });
        await worker.tick();
        assert.deepEqual(sheet.writes(), []);
        assert.deepEqual([sheet.row(2), sheet.row(3)], [dupA, dupB]);
        const [item] = await queueRows();
        assert.deepEqual([item.status, item.attempts, item.lastErrorClass], ["PENDING", 0, "DUPLICATE_CANDIDATE_ID"]);
        assert.equal((await state()).integrationState, "DATA_INTEGRITY");
    });

    test("deleted candidate: the row is kept, RECORD STATUS becomes DELETED / INACTIVE, other cells unchanged", async () => {
        const { sheet, worker } = setup();
        const { passportId, uniqueId } = await register();
        await worker.tick();
        const before = rowFor(sheet, uniqueId)[0];
        await prisma.candidate.delete({ where: { passportId } });
        await worker.tick();
        const after = rowFor(sheet, uniqueId);
        assert.equal(after.length, 1, "never deleted");
        assert.equal(after[0][AL], "DELETED / INACTIVE");
        for (let i = 0; i < SHEET_COLUMN_COUNT; i++) if (i !== AL && i !== AN) assert.equal(after[0][i], before[i]);
        assert.equal((await queueRows()).at(-1).lastResult, "MARKED_INACTIVE");
    });

    test("an unknown unique ID without a delete hint changes nothing (NOT_IN_DATABASE)", async () => {
        const row = Array(SHEET_COLUMN_COUNT).fill("v");
        row[SYSTEM_CANDIDATE_ID_INDEX] = "7777";
        const { sheet, worker } = setup({ rows: [row] });
        await prisma.sheetSyncQueue.create({ data: { uniqueId: "7777" } });
        await worker.tick();
        assert.deepEqual(sheet.writes(), []);
        assert.equal((await queueRows())[0].lastResult, "NOT_IN_DATABASE");
    });
});

describe("failures: the database stays authoritative and unaffected", () => {
    test("Google unavailable: registration still succeeds; the item retries with backoff and later syncs", async () => {
        const { sheet, worker, advance } = setup();
        sheet.failNext("*", googleError(503, { reason: "backendError", googleStatus: "UNAVAILABLE" }), 100);
        const { uniqueId } = await register();
        assert.ok(await prisma.candidate.findUnique({ where: { uniqueId } }), "the candidate is in the database");

        await worker.tick();
        let [item] = await queueRows();
        assert.deepEqual([item.status, item.attempts, item.lastErrorClass, item.lastErrorCode], ["PENDING", 1, "GOOGLE_UNAVAILABLE", "503/UNAVAILABLE/backendError"]);
        assert.ok(item.nextAttemptAt.getTime() > Date.now(), "not due again at once");

        sheet.clearFailures();
        await worker.tick();
        assert.equal(rowFor(sheet, uniqueId).length, 0, "backoff respected: nothing before the retry is due");
        advance(20 * 60_000);
        await worker.tick();
        [item] = await queueRows();
        assert.equal(item.status, "COMPLETED");
        assert.equal(rowFor(sheet, uniqueId).length, 1);
    });

    test("429 / 5xx / network: bounded exponential backoff, then dead letter (FAILED); no endless retries", async () => {
        const { sheet, worker, advance, tuning } = setup({ env: { SHEET_SYNC_MAX_RETRIES: "2" } });
        assert.equal(tuning.maxAttempts, 3);
        await register();
        const errors = [googleError(429, { reason: "rateLimitExceeded" }), googleError(500), Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })];
        const delays = [];
        for (const error of errors) {
            sheet.failNext("*", error, 1);
            const before = Date.now();
            await worker.tick();
            const [item] = await queueRows();
            if (item.status === "PENDING") delays.push(item.nextAttemptAt.getTime() - before);
            advance(60 * 60_000);
        }
        const [item] = await queueRows();
        assert.deepEqual([item.status, item.attempts, item.lastErrorClass], ["FAILED", 3, "GOOGLE_UNAVAILABLE"]);
        assert.equal(delays.length, 2);
        assert.ok(delays[1] > delays[0] * 2, "exponential growth");
        const calls = sheet.calls.length;
        await worker.tick();
        assert.equal(sheet.calls.length, calls, "a dead-lettered item is not retried");
        assert.equal((await prisma.sheetSyncQueue.count({ where: { status: "FAILED" } })), 1);
    });

    test("permanent schema error: CONFIG_ERROR, no writes, no attempts used, no retry loop; resumes once fixed", async () => {
        const header = [...SHEET_HEADERS];
        header[5] = "RENAMED";
        const { sheet, worker, advance } = setup({ header });
        const { uniqueId } = await register();
        await worker.tick();
        assert.deepEqual(sheet.writes(), []);
        let [item] = await queueRows();
        assert.deepEqual([item.status, item.attempts, item.lastErrorClass, item.lastErrorCode], ["PENDING", 0, "SCHEMA_INVALID", "MISSING:BIRTHDAY"]);
        assert.equal((await state()).integrationState, "CONFIG_ERROR");

        const calls = sheet.calls.length;
        await worker.tick();
        await worker.tick();
        assert.equal(sheet.calls.length, calls, "halted: Google is not called again before the re-check interval");

        sheet.setHeader(SHEET_HEADERS);
        advance(WORKER_TIMINGS.configRecheckMs + 1_000);
        await worker.tick();
        assert.equal((await state()).integrationState, "OK");
        [item] = await queueRows();
        assert.equal(item.status, "COMPLETED");
        assert.equal(rowFor(sheet, uniqueId).length, 1);
    });

    test("access denied (403) is a configuration error, never retried as transient", async () => {
        const { sheet, worker } = setup();
        sheet.failNext("*", googleError(403, { reason: "forbidden", googleStatus: "PERMISSION_DENIED" }), 1);
        await register();
        await worker.tick();
        const s = await state();
        assert.deepEqual([s.integrationState, s.lastErrorClass, s.lastErrorCode], ["CONFIG_ERROR", "ACCESS_DENIED", "403/PERMISSION_DENIED/forbidden"]);
        assert.equal((await queueRows())[0].attempts, 0);
    });

    test("SHEET_SYNC_ENABLED=false: the worker never writes and leaves the queue pending", async () => {
        const { sheet, worker } = setup({ enabled: false });
        await register();
        await worker.tick();
        assert.deepEqual(sheet.writes(), []);
        assert.equal((await queueRows())[0].status, "PENDING");
        assert.equal((await state()).writeGate, "DISABLED");
    });

    test("first-write pilot: only the listed candidate is written; others wait untouched; reconciliation is a dry run", async () => {
        const first = await register();
        const second = await register(SECOND);
        const { sheet, worker, store } = setup({ env: { SHEET_SYNC_PILOT_CANDIDATE_IDS: first.uniqueId } });
        await worker.tick();
        assert.equal(rowFor(sheet, first.uniqueId).length, 1);
        assert.equal(rowFor(sheet, second.uniqueId).length, 0);
        const waiting = await prisma.sheetSyncQueue.findFirst({ where: { uniqueId: second.uniqueId } });
        assert.deepEqual([waiting.status, waiting.attempts], ["PENDING", 0]);
        const writes = sheet.writes().length;
        const { run } = await store.requestRun({ kind: "RECONCILE", triggerSource: "ADMIN" });
        await worker.tick();
        const done = await store.getRun(run.runId);
        assert.deepEqual([done.status, done.dryRun, done.summary.appended], ["SUCCEEDED", true, 1]);
        assert.equal(sheet.writes().length, writes, "no write during the pilot reconciliation");
    });

    test("another process holding the writer lease: this worker writes nothing", async () => {
        const { sheet, worker } = setup();
        await register();
        await prisma.sheetSyncState.update({ where: { stateId: "sheet-sync" }, data: { writerLeaseOwner: "other-process", writerLeaseExpiresAt: new Date(Date.now() + 60_000) } });
        await worker.tick();
        assert.deepEqual(sheet.writes(), []);
        assert.equal((await queueRows())[0].status, "PENDING");
    });

    test("logs carry IDs, actions and codes only: no names, passport numbers, phone numbers or Google text", async () => {
        const { sheet, worker, lines, advance } = setup();
        sheet.failNext("*", googleError(503), 1);
        await register();
        await worker.tick();
        advance(60 * 60_000);
        await worker.tick();
        const text = lines.join("\n");
        assert.ok(lines.length > 0);
        for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
        assert.doesNotMatch(text, /N1023757|Anusha|De Soysa|94771234567|965404378V|ya29|Fake Tab|fake Google error/);
    });
});

describe("reconciliation and durable runs", () => {
    async function reconcileRun(store) {
        const { run } = await store.requestRun({ kind: "RECONCILE", triggerSource: "ADMIN" });
        return run.runId;
    }

    test("repairs drift (manual edit, missing row) and leaves matching rows unwritten; the run records counts only", async () => {
        const { sheet, worker, store } = setup();
        const a = await register();
        const b = await register(SECOND);
        await worker.tick();
        await prisma.sheetSyncQueue.deleteMany();
        const aRow = sheet.dataRows().findIndex((r) => r[SYSTEM_CANDIDATE_ID_INDEX] === a.uniqueId) + 2;
        sheet.setCell(aRow, C, "EDITED BY HAND");
        const writesBefore = sheet.writes().length;

        const runId = await reconcileRun(store);
        await worker.tick();
        const run = await store.getRun(runId);
        assert.equal(run.status, "SUCCEEDED");
        assert.equal(run.dryRun, false);
        assert.deepEqual(
            { updated: run.summary.updated, unchanged: run.summary.unchanged, appended: run.summary.appended, markedInactive: run.summary.markedInactive },
            { updated: 1, unchanged: 1, appended: 0, markedInactive: 0 },
        );
        assert.equal(sheet.row(aRow)[C], "Anusha");
        assert.deepEqual(sheet.writes().slice(writesBefore).map((c) => c.ranges ?? c.method), [[`'${TAB}'!A${aRow}:AO${aRow}`]], "only the drifted row is written");
        assert.doesNotMatch(JSON.stringify(run), /Anusha|N1023757|Kamal/);
        assert.equal(rowFor(sheet, b.uniqueId).length, 1);
    });

    test("no drift: a second reconciliation writes nothing", async () => {
        const { sheet, worker, store } = setup();
        await register();
        await worker.tick();
        const writes = sheet.writes().length;
        await reconcileRun(store);
        await worker.tick();
        assert.equal(sheet.writes().length, writes);
    });

    test("Sheet-only AO (candidate absent from a complete snapshot): marked inactive within the guard, never deleted", async () => {
        const orphan = Array(SHEET_COLUMN_COUNT).fill("kept");
        orphan[AL] = "ACTIVE";
        orphan[SYSTEM_CANDIDATE_ID_INDEX] = "0500";
        const rows = [orphan];
        // Enough identified rows that one orphan is within the 5% guard.
        const { sheet, worker, store } = setup({ rows });
        for (let i = 0; i < 20; i++) await register({ passportId: `N10000${String(i).padStart(2, "0")}`, nic: `1990000000${String(i).padStart(2, "0")}`, whatsappNumber: `+947700001${String(i).padStart(2, "0")}` });
        await worker.tick();
        const runId = await reconcileRun(store);
        await worker.tick();
        const run = await store.getRun(runId);
        assert.equal(run.summary.markedInactive, 1);
        assert.equal(sheet.row(2)[AL], "DELETED / INACTIVE");
        assert.equal(sheet.row(2)[C], "kept");
        assert.equal(sheet.dataRows().length, 21, "no row removed");
    });

    test("deletion guard: too many absent candidates -> nothing marked, reported NOT_IN_DATABASE, rows unchanged", async () => {
        const orphans = ["0601", "0602", "0603"].map((id) => Object.assign(Array(SHEET_COLUMN_COUNT).fill("kept"), { [AL]: "ACTIVE", [SYSTEM_CANDIDATE_ID_INDEX]: id }));
        const { sheet, worker, store, lines } = setup({ rows: orphans.map((r) => [...r]) });
        await register();
        await worker.tick();
        const runId = await reconcileRun(store);
        await worker.tick();
        const run = await store.getRun(runId);
        assert.equal(run.summary.deletionGuardTriggered, true);
        assert.equal(run.summary.notInDatabase, 3);
        assert.equal(run.summary.markedInactive, 0);
        for (let n = 2; n <= 4; n++) assert.equal(sheet.row(n)[AL], "ACTIVE");
        assert.ok(lines.some((l) => l.includes("sheet_sync.reconcile_deletion_guard")));
    });

    test("an empty database snapshot never marks anything inactive", async () => {
        const orphan = Object.assign(Array(SHEET_COLUMN_COUNT).fill("kept"), { [AL]: "ACTIVE", [SYSTEM_CANDIDATE_ID_INDEX]: "0700" });
        const { sheet, worker, store } = setup({ rows: [orphan], env: { SHEET_SYNC_DELETION_GUARD_MAX: "100", SHEET_SYNC_DELETION_GUARD_FRACTION: "1" } });
        await reconcileRun(store);
        await worker.tick();
        assert.equal(sheet.row(2)[AL], "ACTIVE");
        assert.deepEqual(sheet.writes(), []);
    });

    test("a reconciliation with writes disabled is a DRY RUN: full comparison, zero writes", async () => {
        const { sheet, worker, store } = setup({ enabled: false });
        await register();
        const runId = await reconcileRun(store);
        await worker.tick();
        const run = await store.getRun(runId);
        assert.deepEqual([run.status, run.dryRun, run.summary.appended], ["SUCCEEDED", true, 1]);
        assert.deepEqual(sheet.writes(), []);
    });

    test("duplicate AO stops a reconciliation before any write; the run is FAILED with a code", async () => {
        const dup = Object.assign(Array(SHEET_COLUMN_COUNT).fill(""), { [SYSTEM_CANDIDATE_ID_INDEX]: "0001" });
        const { sheet, worker, store } = setup({ rows: [[...dup], [...dup]] });
        await register();
        await prisma.sheetSyncQueue.deleteMany();
        const runId = await reconcileRun(store);
        await worker.tick();
        const run = await store.getRun(runId);
        assert.deepEqual([run.status, run.errorClass], ["FAILED", "DUPLICATE_CANDIDATE_ID"]);
        assert.deepEqual(sheet.writes(), []);
    });

    test("a reconciliation whose worker died (lease expired) is taken over and finished; never two at once", async () => {
        const { worker, store, advance } = setup();
        await register();
        const { run } = await store.requestRun({ kind: "RECONCILE", triggerSource: "SCHEDULER" });
        const second = await store.requestRun({ kind: "RECONCILE", triggerSource: "ADMIN" });
        assert.equal(second.created, false);
        assert.equal(second.run.runId, run.runId);
        await store.claimRun({ owner: "dead-worker", now: new Date(), leaseMs: 1_000, maxAttempts: 3 });
        advance(WORKER_TIMINGS.runLeaseMs + 5_000);
        await worker.tick();
        assert.equal((await store.getRun(run.runId)).status, "SUCCEEDED");
    });

    test("a successful write reconciliation resolves earlier dead-lettered items", async () => {
        const { worker, store } = setup();
        const { uniqueId } = await register();
        await prisma.sheetSyncQueue.updateMany({ data: { status: "FAILED", updatedAt: new Date(Date.now() - 60_000) } });
        await reconcileRun(store);
        await worker.tick();
        assert.equal(await prisma.sheetSyncQueue.count({ where: { uniqueId, status: "FAILED" } }), 0);
    });

    test("Test Connection run: the read-only health check, no Sheet write, result stored on the run", async () => {
        const { sheet, worker, store } = setup();
        const { run } = await store.requestRun({ kind: "TEST_CONNECTION", triggerSource: "ADMIN" });
        await worker.tick();
        const done = await store.getRun(run.runId);
        assert.equal(done.status, "SUCCEEDED");
        assert.deepEqual([done.summary.status, done.summary.schema], ["CONNECTED", "SCHEMA_VALID"]);
        assert.deepEqual(sheet.writes(), []);
        assert.equal((await state()).integrationState, "OK");
    });

    test("runs are processed by the worker alone: no browser or HTTP request has to stay open", async () => {
        const { worker, store } = setup();
        await register();
        const { run } = await store.requestRun({ kind: "RECONCILE", triggerSource: "ADMIN" });
        // The requester is gone; only the worker loop runs.
        worker.start({ pollMs: 20 });
        for (let i = 0; i < 100 && (await store.getRun(run.runId)).status !== "SUCCEEDED"; i++) await new Promise((r) => setTimeout(r, 20));
        const result = await worker.stop({ timeoutMs: 2_000 });
        assert.equal((await store.getRun(run.runId)).status, "SUCCEEDED");
        assert.equal(result.finished, true);
        assert.equal((await state()).writerLeaseOwner, null, "the writer lease is released on stop");
    });
});
