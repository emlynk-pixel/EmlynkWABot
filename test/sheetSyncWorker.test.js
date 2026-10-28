// Google Sheet mirror end to end (locally): real PostgreSQL (PGlite, every
// migration incl. the outbox triggers), the real candidate service, store,
// reader, engine, adapter and worker. The Sheet is synchronized only by
// RECONCILE runs (scheduled or Sync Now), never in real time. Only Google is replaced,
// by an in-memory Sheet (test/helpers/fakeGoogleSheet.js): no test here can
// reach Google or the real operational Sheet.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { createFakeGoogleSheet, googleError } from "./helpers/fakeGoogleSheet.js";
import { CANDIDATE_DOCUMENT_TYPES, createCandidate, parseCandidateBody, parseStageBody, updateStage } from "../src/services/candidateService.js";
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
const C = col("otherNames");

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
    return { sheet, store, worker, newWorker, engine, lines, advance: (ms) => { offsetMs += ms; }, tuning };
}

async function register(body = {}) {
    const { values, errors } = parseCandidateBody({ ...BODY, ...body }, { creating: true });
    assert.equal(errors, undefined);
    return createCandidate({ db: prisma, values });
}

const queueRows = () => prisma.sheetSyncQueue.findMany({ orderBy: { createdAt: "asc" } });
const state = () => prisma.sheetSyncState.findUnique({ where: { stateId: "sheet-sync" } });
const rowFor = (sheet, uniqueId) => sheet.dataRows().filter((r) => r[SYSTEM_CANDIDATE_ID_INDEX] === uniqueId);

// A durable RECONCILE run, as Cloud Scheduler (SCHEDULER) or Sync Now (ADMIN)
// records it, then one worker tick that executes it. Returns the finished run.
async function sync(store, worker, triggerSource = "SCHEDULER") {
    const { run } = await store.requestRun({ kind: "RECONCILE", triggerSource });
    await worker.tick();
    return store.getRun(run.runId);
}

async function addDocument(passportId, documentType, { receivedDate = new Date(), variant = null, status = "VERIFIED" } = {}) {
    return prisma.document.create({
        data: {
            documentId: randomUUID(), passportId, documentType, originalFilename: "file.pdf", storedFilename: "file.pdf",
            storagePath: `clients/${passportId}/${randomUUID()}.pdf`, receivedDate, processingStatus: "STORED", verificationStatus: status, documentVariant: variant,
        },
    });
}

describe("no real-time synchronization: database changes wait for a scheduled or manual run", () => {
    test("candidate registration and detail update: queued, never written to the Sheet by the worker loop", async () => {
        const { sheet, worker } = setup();
        const { passportId } = await register();
        await prisma.candidate.update({ where: { passportId }, data: { firstName: "Changed" } });
        for (let i = 0; i < 3; i++) await worker.tick();
        assert.deepEqual(sheet.calls.filter((c) => c.method !== "get"), [], "no Sheet write");
        assert.deepEqual(sheet.writes(), []);
        const rows = await queueRows();
        assert.deepEqual(rows.map((r) => r.status), ["PENDING"], "one coalesced row waits for the next run");
    });

    test("document change: queued, no immediate Sheet write", async () => {
        const { sheet, worker } = setup();
        const { passportId } = await register();
        await prisma.sheetSyncQueue.deleteMany();
        await addDocument(passportId, "MEDICAL");
        await worker.tick();
        assert.deepEqual(sheet.writes(), []);
        assert.equal((await queueRows())[0].status, "PENDING");
    });

    test("stage change: queued, no immediate Sheet write", async () => {
        const { sheet, worker } = setup();
        const { passportId } = await register();
        await prisma.sheetSyncQueue.deleteMany();
        await updateStage({ db: prisma, passportId, stage: "IVS_INTERVIEW", values: parseStageBody({ completed: true }, "IVS_INTERVIEW").values });
        await worker.tick();
        assert.deepEqual(sheet.writes(), []);
        assert.equal((await queueRows())[0].status, "PENDING");
    });

    test("deleting a candidate writes nothing until the next run", async () => {
        const { sheet, store, worker } = setup();
        const { passportId } = await register();
        await sync(store, worker);
        const writes = sheet.writes().length;
        await prisma.candidate.delete({ where: { passportId } });
        await worker.tick();
        assert.equal(sheet.writes().length, writes);
    });
});

describe("scheduled and manual reconciliation", () => {
    test("a scheduled run mirrors the current database and settles the queue rows it covered", async () => {
        const { sheet, store, worker } = setup();
        const { uniqueId } = await register();
        const run = await sync(store, worker, "SCHEDULER");
        assert.deepEqual([run.status, run.triggerSource, run.dryRun, run.summary.appended, run.summary.queueSettled], ["SUCCEEDED", "SCHEDULER", false, 1, 1]);
        const rows = rowFor(sheet, uniqueId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0][B], "N1023757");
        assert.equal(rows[0][AL], "ACTIVE");
        assert.match(rows[0][AN], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        const [item] = await queueRows();
        assert.deepEqual([item.status, item.lastResult], ["COMPLETED", "RECONCILED"]);
        const appendCall = sheet.writes().find((c) => c.method === "append");
        assert.deepEqual([appendCall.range, appendCall.insertDataOption, appendCall.valueInputOption], [`'${TAB}'!A:CF`, "INSERT_ROWS", "RAW"]);
        assert.ok((await state()).lastSyncSuccessAt);
    });

    test("manual Sync Now (ADMIN) performs the same reconciliation immediately, from the current database", async () => {
        const { sheet, store, worker } = setup();
        const { passportId, uniqueId } = await register();
        await sync(store, worker, "SCHEDULER");
        await prisma.candidate.update({ where: { passportId }, data: { firstName: "Latest" } });
        const run = await sync(store, worker, "ADMIN");
        assert.deepEqual([run.status, run.triggerSource, run.summary.updated], ["SUCCEEDED", "ADMIN", 1]);
        assert.equal(rowFor(sheet, uniqueId)[0][C], "Latest");
        assert.equal(await prisma.sheetSyncQueue.count({ where: { status: "PENDING" } }), 0);
    });

    test("several changes between runs: one write per run, with the latest state only", async () => {
        const { sheet, store, worker } = setup();
        const { passportId, uniqueId } = await register();
        for (const stage of ["IVS_INTERVIEW", "VISA_APPROVAL", "FINALIZING_JOB"]) {
            await updateStage({ db: prisma, passportId, stage, values: parseStageBody({ completed: true }, stage).values });
        }
        await prisma.candidate.update({ where: { passportId }, data: { firstName: "First" } });
        await prisma.candidate.update({ where: { passportId }, data: { firstName: "Final" } });
        assert.equal((await queueRows()).length, 1, "coalesced");
        await sync(store, worker);
        assert.equal(sheet.writes().length, 1);
        const [row] = rowFor(sheet, uniqueId);
        assert.equal(row[C], "Final");
        assert.deepEqual([row[col("ivsInterviewStatus")], row[col("visaApprovalStatus")], row[col("finalizingJobStatus")]], ["COMPLETED", "COMPLETED", "COMPLETED"]);
    });

    test("idempotent: running again (scheduled or manual) with no change writes nothing and keeps LAST MIRRORED AT", async () => {
        const { sheet, store, worker } = setup();
        const { uniqueId } = await register();
        await sync(store, worker, "SCHEDULER");
        const mirroredAt = rowFor(sheet, uniqueId)[0][AN];
        const writes = sheet.writes().length;
        const manual = await sync(store, worker, "ADMIN");
        const scheduled = await sync(store, worker, "SCHEDULER");
        assert.deepEqual([manual.summary.unchanged, scheduled.summary.unchanged], [1, 1]);
        assert.equal(sheet.writes().length, writes);
        assert.equal(rowFor(sheet, uniqueId)[0][AN], mirroredAt);
        assert.equal(rowFor(sheet, uniqueId).length, 1, "never a duplicate row");
    });

    test("a change made while a run is in progress is not lost: its queue row stays PENDING for the next run", async () => {
        const { store, newWorker } = setup();
        const { passportId } = await register();
        // Right after the run has read the open queue rows, a stage changes.
        const racing = newWorker({
            ...store,
            openQueueItems: async (options) => {
                const rows = await store.openQueueItems(options);
                await new Promise((resolve) => setTimeout(resolve, 5));
                await updateStage({ db: prisma, passportId, stage: "VISA_APPROVAL", values: parseStageBody({ completed: true }, "VISA_APPROVAL").values });
                return rows;
            },
        });
        const { run } = await store.requestRun({ kind: "RECONCILE", triggerSource: "SCHEDULER" });
        await racing.tick();
        assert.equal((await store.getRun(run.runId)).summary.queueSettled, 0);
        assert.equal(await prisma.sheetSyncQueue.count({ where: { status: "PENDING" } }), 1);
    });

    test("an existing candidate row is updated in place (found by AO, not by position or passport number)", async () => {
        const { uniqueId } = await register();
        const stale = Array(SHEET_COLUMN_COUNT).fill("");
        stale[C] = "OLD NAME";
        stale[SYSTEM_CANDIDATE_ID_INDEX] = uniqueId;
        const other = Array(SHEET_COLUMN_COUNT).fill("x");
        other[SYSTEM_CANDIDATE_ID_INDEX] = "9999";
        other[AL] = "ACTIVE";
        const { sheet, store, worker } = setup({ rows: [other, stale] });
        const run = await sync(store, worker);
        assert.equal(run.summary.updated, 1);
        assert.equal(sheet.row(3)[C], "Anusha");
        assert.deepEqual(sheet.row(2), other, "the unrelated row is untouched (the deletion guard keeps it)");
        assert.equal(sheet.dataRows().length, 2, "no row was appended");
    });

    test("a blank AO cell identifies nobody: the candidate is appended and the blank row is untouched", async () => {
        const blank = Array(SHEET_COLUMN_COUNT).fill("");
        blank[B] = "N1023757"; // same passport number, but no AO
        blank[C] = "Manual entry";
        const { sheet, store, worker } = setup({ rows: [blank] });
        const { uniqueId } = await register();
        await sync(store, worker);
        assert.deepEqual(sheet.row(2), blank);
        assert.equal(rowFor(sheet, uniqueId).length, 1);
    });

    test("a manual Sheet edit is overwritten from the database; nothing from the Sheet is written to the database", async () => {
        const { sheet, store, worker } = setup();
        const { passportId, uniqueId } = await register();
        await sync(store, worker);
        const before = await prisma.candidate.findUnique({ where: { passportId } });
        const rowNumber = sheet.dataRows().findIndex((r) => r[SYSTEM_CANDIDATE_ID_INDEX] === uniqueId) + 2;
        sheet.setCell(rowNumber, C, "EDITED IN SHEET");
        await sync(store, worker);
        assert.equal(sheet.row(rowNumber)[C], "Anusha");
        assert.deepEqual(await prisma.candidate.findUnique({ where: { passportId } }), before, "the database is unchanged");
        assert.equal(await prisma.document.count({ where: { passportId } }), 0, "no document created or removed from Sheet content");
    });
});

describe("failures: the database stays authoritative and unaffected", () => {
    test("Google unavailable: registration still succeeds; the run fails with a code, the queue waits, the next run syncs", async () => {
        const { sheet, store, worker } = setup();
        sheet.failNext("*", googleError(503, { reason: "backendError", googleStatus: "UNAVAILABLE" }), 100);
        const { uniqueId } = await register();
        assert.ok(await prisma.candidate.findUnique({ where: { uniqueId } }), "the candidate is in the database");

        const failed = await sync(store, worker);
        assert.deepEqual([failed.status, failed.errorClass, failed.errorCode], ["FAILED", "GOOGLE_UNAVAILABLE", "503/UNAVAILABLE/backendError"]);
        assert.equal((await queueRows())[0].status, "PENDING");

        sheet.clearFailures();
        const next = await sync(store, worker);
        assert.equal(next.status, "SUCCEEDED");
        assert.equal(rowFor(sheet, uniqueId).length, 1);
        assert.equal((await queueRows())[0].status, "COMPLETED");
    });

    test("permanent schema error: CONFIG_ERROR, no writes; the next run after the fix resumes", async () => {
        const header = [...SHEET_HEADERS];
        header[header.indexOf("BIRTH DATE")] = "RENAMED";
        const { sheet, store, worker } = setup({ header });
        const { uniqueId } = await register();
        const failed = await sync(store, worker);
        assert.deepEqual([failed.status, failed.errorClass, failed.errorCode], ["FAILED", "SCHEMA_INVALID", "MISSING:BIRTH DATE"]);
        assert.deepEqual(sheet.writes(), []);
        assert.equal((await state()).integrationState, "CONFIG_ERROR");

        sheet.setHeader(SHEET_HEADERS);
        await sync(store, worker);
        assert.equal((await state()).integrationState, "OK");
        assert.equal(rowFor(sheet, uniqueId).length, 1);
    });

    test("access denied (403) is a configuration error", async () => {
        const { sheet, store, worker } = setup();
        sheet.failNext("*", googleError(403, { reason: "forbidden", googleStatus: "PERMISSION_DENIED" }), 1);
        await register();
        await sync(store, worker);
        const s = await state();
        assert.deepEqual([s.integrationState, s.lastErrorClass, s.lastErrorCode], ["CONFIG_ERROR", "ACCESS_DENIED", "403/PERMISSION_DENIED/forbidden"]);
    });

    test("duplicate AO: hard data-integrity stop, no write at all, the duplicate rows untouched, the queue kept", async () => {
        const { uniqueId } = await register();
        const dup = Array(SHEET_COLUMN_COUNT).fill("");
        dup[SYSTEM_CANDIDATE_ID_INDEX] = uniqueId;
        const dupA = [...dup];
        dupA[C] = "copy A";
        const dupB = [...dup];
        dupB[C] = "copy B";
        const { sheet, store, worker } = setup({ rows: [dupA, dupB] });
        const run = await sync(store, worker);
        assert.deepEqual([run.status, run.errorClass], ["FAILED", "DUPLICATE_CANDIDATE_ID"]);
        assert.deepEqual(sheet.writes(), []);
        assert.deepEqual([sheet.row(2), sheet.row(3)], [dupA, dupB]);
        assert.equal((await queueRows())[0].status, "PENDING");
        assert.equal((await state()).integrationState, "DATA_INTEGRITY");
    });

    test("SHEET_SYNC_ENABLED=false: runs are dry runs, nothing is written and the queue stays pending", async () => {
        const { sheet, store, worker } = setup({ enabled: false });
        await register();
        const run = await sync(store, worker);
        assert.deepEqual([run.status, run.dryRun, run.summary.appended], ["SUCCEEDED", true, 1]);
        assert.deepEqual(sheet.writes(), []);
        assert.equal((await queueRows())[0].status, "PENDING");
        assert.equal((await state()).writeGate, "DISABLED");
    });

    test("first-write pilot: a run writes only the listed candidate; others are left untouched and stay queued", async () => {
        const first = await register();
        const second = await register(SECOND);
        const orphan = Object.assign(Array(SHEET_COLUMN_COUNT).fill("kept"), { [AL]: "ACTIVE", [SYSTEM_CANDIDATE_ID_INDEX]: "0800" });
        const { sheet, store, worker } = setup({ rows: [orphan], env: { SHEET_SYNC_PILOT_CANDIDATE_IDS: first.uniqueId, SHEET_SYNC_DELETION_GUARD_MAX: "100", SHEET_SYNC_DELETION_GUARD_FRACTION: "1" } });
        const run = await sync(store, worker);
        assert.deepEqual([run.status, run.dryRun, run.summary.appended, run.summary.outsideScope, run.summary.markedInactive], ["SUCCEEDED", false, 1, 1, 0]);
        assert.equal(rowFor(sheet, first.uniqueId).length, 1);
        assert.equal(rowFor(sheet, second.uniqueId).length, 0);
        assert.equal(sheet.row(2)[AL], "ACTIVE", "a pilot run never marks rows inactive");
        const waiting = await prisma.sheetSyncQueue.findFirst({ where: { uniqueId: second.uniqueId } });
        assert.equal(waiting.status, "PENDING");
    });

    test("another process holding the writer lease: the run is skipped and nothing is written", async () => {
        const { sheet, store, worker } = setup();
        await register();
        await prisma.sheetSyncState.update({ where: { stateId: "sheet-sync" }, data: { writerLeaseOwner: "other-process", writerLeaseExpiresAt: new Date(Date.now() + 60_000) } });
        const run = await sync(store, worker);
        assert.deepEqual([run.status, run.errorClass], ["SKIPPED", "WRITER_BUSY"]);
        assert.deepEqual(sheet.writes(), []);
        assert.equal((await queueRows())[0].status, "PENDING");
    });

    test("logs carry IDs, actions and codes only: no names, passport numbers, phone numbers or Google text", async () => {
        const { sheet, store, worker, lines } = setup();
        sheet.failNext("*", googleError(503), 1);
        await register();
        await sync(store, worker);
        await sync(store, worker);
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
        await sync(store, worker);
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
        assert.deepEqual(sheet.writes().slice(writesBefore).map((c) => c.ranges ?? c.method), [[`'${TAB}'!A${aRow}:CF${aRow}`]], "only the drifted row is written");
        assert.doesNotMatch(JSON.stringify(run), /Anusha|N1023757|Kamal/);
        assert.equal(rowFor(sheet, b.uniqueId).length, 1);
    });

    test("no drift: a second reconciliation writes nothing", async () => {
        const { sheet, worker, store } = setup();
        await register();
        await sync(store, worker);
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
        await sync(store, worker); // the 20 candidates are in the Sheet first
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
        await sync(store, worker);
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

describe("document columns: submission date or \"Not Submitted\"", () => {
    const DOCUMENT_FIELDS = ["passportCopy", "policeReportSriLankaVerified", "policeReportRomania", "medical", "scan", "drivingLicence", "nationalId", "policeReportApplied", "policeReportSriLankaNormal", "policeReportFm", "videos"];

    test("a scheduled run writes each document's submission date, and exactly \"Not Submitted\" where there is none", async () => {
        const { sheet, store, worker } = setup();
        const { passportId, uniqueId } = await register();
        await addDocument(passportId, "PASSPORT", { receivedDate: new Date("2026-10-09T03:00:00.000Z") });
        await addDocument(passportId, "POLICE_REPORT", { variant: "SL_VERIFIED", receivedDate: new Date("2026-10-07T03:00:00.000Z") });
        await addDocument(passportId, "SCAN", { receivedDate: new Date("2026-10-08T03:00:00.000Z") });
        await sync(store, worker);
        const [row] = rowFor(sheet, uniqueId);
        assert.equal(row[col("passportCopy")], "2026-10-09");
        assert.equal(row[col("policeReportSriLankaVerified")], "2026-10-07");
        assert.equal(row[col("scan")], "2026-10-08");
        for (const field of ["policeReportRomania", "medical", "nationalId", "policeReportApplied", "policeReportSriLankaNormal", "videos"]) {
            assert.equal(row[col(field)], "Not Submitted", field);
        }
        assert.equal(row[col("drivingLicence")], "Not Submitted", "no document type exists for DRIVING LICENSE");
        assert.equal(row[col("policeReportFm")], "Not Submitted", "no document type exists for POLICE REP FM");
    });

    test("a replaced document shows the replacement's date after the next run", async () => {
        const { sheet, store, worker } = setup();
        const { passportId, uniqueId } = await register();
        const old = await addDocument(passportId, "MEDICAL", { receivedDate: new Date("2026-09-01T03:00:00.000Z") });
        await sync(store, worker);
        assert.equal(rowFor(sheet, uniqueId)[0][col("medical")], "2026-09-01");
        // Replacement, as the application stores it: the old row SUPERSEDED, a new current row.
        await prisma.document.update({ where: { documentId: old.documentId }, data: { verificationStatus: "SUPERSEDED" } });
        await addDocument(passportId, "MEDICAL", { receivedDate: new Date("2026-10-08T03:00:00.000Z") });
        assert.equal(rowFor(sheet, uniqueId)[0][col("medical")], "2026-09-01", "not before the next run");
        await sync(store, worker);
        assert.equal(rowFor(sheet, uniqueId)[0][col("medical")], "2026-10-08");
    });

    test("reconciliation and the per-candidate comparison produce identical document cells (one mapper)", async () => {
        const { sheet, store, worker, engine } = setup();
        const { passportId, uniqueId } = await register();
        await addDocument(passportId, "NIC", { receivedDate: new Date("2026-10-03T03:00:00.000Z") });
        await addDocument(passportId, "SKILL_VIDEO", { receivedDate: new Date("2026-10-04T20:00:00.000Z") });
        await sync(store, worker);
        const [row] = rowFor(sheet, uniqueId);
        assert.deepEqual([row[col("nationalId")], row[col("videos")]], ["2026-10-03", "2026-10-05"]);
        const results = await engine.syncCandidates([{ uniqueId, candidateDeleted: false }], { dryRun: true });
        assert.deepEqual([results.get(uniqueId).action, results.get(uniqueId).changedColumns], ["UNCHANGED", []]);
    });

    test("manual edits to document cells are restored from the database; Sheet values never reach the database", async () => {
        const { sheet, store, worker } = setup();
        const { passportId, uniqueId } = await register();
        await addDocument(passportId, "SCAN", { receivedDate: new Date("2026-10-08T03:00:00.000Z") });
        await sync(store, worker);
        const rowNumber = sheet.dataRows().findIndex((r) => r[SYSTEM_CANDIDATE_ID_INDEX] === uniqueId) + 2;
        const documentsBefore = await prisma.document.findMany({ where: { passportId }, orderBy: { documentId: "asc" } });
        sheet.setCell(rowNumber, col("scan"), "Not Submitted");
        sheet.setCell(rowNumber, col("medical"), "2026-01-01");
        sheet.setCell(rowNumber, col("passportCopy"), "VERIFIED");
        await sync(store, worker);
        const restored = sheet.row(rowNumber);
        assert.deepEqual([restored[col("scan")], restored[col("medical")], restored[col("passportCopy")]], ["2026-10-08", "Not Submitted", "Not Submitted"]);
        assert.deepEqual(await prisma.document.findMany({ where: { passportId }, orderBy: { documentId: "asc" } }), documentsBefore, "\"Not Submitted\" in the Sheet deleted nothing");
    });

    test("DRIVING LICENSE (S) and POLICE REP FM (X): Sheet output \"Not Submitted\" only; no database write, no new document type", async () => {
        const { sheet, store, worker } = setup();
        const { passportId, uniqueId } = await register();
        await addDocument(passportId, "PASSPORT", { receivedDate: new Date("2026-10-09T03:00:00.000Z") });
        const snapshot = async () => ({
            candidate: await prisma.candidate.findUnique({ where: { passportId } }),
            documents: await prisma.document.findMany({ where: { passportId }, orderBy: { documentId: "asc" } }),
            stages: await prisma.candidateStage.findMany({ where: { passportId } }),
            documentTypes: (await prisma.document.findMany({ distinct: ["documentType"], select: { documentType: true } })).map((d) => d.documentType).sort(),
        });
        const before = await snapshot();
        await sync(store, worker);
        const [row] = rowFor(sheet, uniqueId);
        assert.deepEqual([row[col("drivingLicence")], row[col("policeReportFm")]], ["Not Submitted", "Not Submitted"]);
        assert.equal(row[col("passportCopy")], "2026-10-09", "tracked mappings unchanged");
        assert.equal(row[col("submitDate")], "", "SUBMIT DATE (U) unchanged");
        assert.deepEqual(await snapshot(), before, "no candidate, document, stage or document-type change");
        assert.deepEqual(Object.keys(CANDIDATE_DOCUMENT_TYPES).sort(), ["MEDICAL", "NIC", "PASSPORT", "POLICE_REPORT", "POLICE_SLIP", "SCAN", "SKILL_VIDEO", "VISA_SUBMISSION"], "no document type added");
    });

    test("every document column follows the rule for a candidate with no documents", async () => {
        const { sheet, store, worker } = setup();
        const { uniqueId } = await register();
        await sync(store, worker);
        const [row] = rowFor(sheet, uniqueId);
        assert.deepEqual(DOCUMENT_FIELDS.map((field) => row[col(field)]), DOCUMENT_FIELDS.map(() => "Not Submitted"));
    });
});
