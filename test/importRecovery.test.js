// Bulk candidate import: AUTOMATIC RECOVERY of interrupted imports (importRecoveryService.js) end to end on a real
// PostgreSQL (PGlite, every migration). SYNTHETIC data only.
//
// An import is all-or-nothing: one the backend never recorded as finished is rolled back automatically (by the existing
// rollback), and an interrupted rollback is continued, with no browser. Time is simulated by moving the stored instants
// (commit lease, heartbeat, next attempt) into the past: the service compares them with the database's own now().
//
// PGlite is ONE session: transactions never overlap here. What needs two real connections (a recovery scan meeting a
// chunk transaction that holds the import row, two recovery runs racing on SKIP LOCKED) is exercised only
// sequentially here and must be verified on a real PostgreSQL (see the report).
import "./helpers/importLedgerKey.js";
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { authIdFor } from "./helpers/fakeSupabaseAuth.js";
import {
    IMPORT_COMMIT_LEASE_MS, abortImport, chunkRows, commitChunk, finishImport, getActiveImport, previewImport, recordImportHeartbeat,
} from "../src/services/candidateImportService.js";
import { createCandidate, parseCandidateBody } from "../src/services/candidateService.js";
import { LEDGER_ENTITY as E, LEDGER_STATUS } from "../src/services/candidateImportLedger.js";
import { executeRollback, getRollback } from "../src/services/candidateImportRollback.js";
import { LedgerKeyring } from "../src/services/importLedgerKeys.js";
import {
    RECOVERY_AUDIT_ACTION, RECOVERY_DEFAULTS, RECOVERY_ERROR, RECOVERY_REASON, RECOVERY_STATUS, backoffMs, listImportRecoveries, readRecoveryConfig, runImportRecovery,
} from "../src/services/importRecoveryService.js";
import { createTaskRouter, recoverySchedulerVerifier } from "../src/routes/tasks.js";

const ADMIN = { adminId: "admin-ADMIN", role: "ADMIN", name: "Admin User" };
const USERS = { "admin-ADMIN": ["Admin User", "ADMIN"], "admin-ANALYST": ["Ann Analyst", "ANALYST"], "u-john": ["John Silva", "ANALYST"] };
const HEADERS = [
    "PASSPORT NUMBER", "SURNAME", "OTHER NAME", "NIC NUMBER", "WHATSAPP NUMBER", "JOB ROLE", "OFFICER", "VISA STATUS", "INTERVIEW DATE", "INTERVIEW PASS FAIL",
    "COMPANY", "COMPANY NUMBER", "AGENT", "UNIQUE NUMBER", "ADDRESS", "BIRTH DATE", "SHIRT SIZE", "FATHER NAME",
];
const TODAY = new Date("2026-11-04T06:00:00Z");

let database;
let prisma;
let pg;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const [adminId, [name, role]] of Object.entries(USERS)) {
        await prisma.user.create({ data: { adminId, authUserId: authIdFor(adminId), name, email: `${adminId}@example.invalid`, role, status: "ACTIVE", activatedAt: new Date() } });
    }
});
after(async () => { await database?.close(); });
beforeEach(async () => {
    await pg.exec(`
        DELETE FROM "candidate_import"; DELETE FROM "candidate_allocation"; DELETE FROM "candidate_additional_details";
        DELETE FROM "import_job_group"; DELETE FROM "job_candidate"; DELETE FROM "job_job_type"; DELETE FROM "job"; DELETE FROM "job_code_counter";
        DELETE FROM "candidate_stages"; DELETE FROM "candidate_verification"; DELETE FROM "documents"; DELETE FROM "candidate";
        DELETE FROM "agent_client"; DELETE FROM "client"; DELETE FROM "agent"; DELETE FROM "sheet_sync_queue"; DELETE FROM "sheet_sync_runs";
        DELETE FROM "job_type";
    `);
    await prisma.jobType.create({ data: { code: "PLASTER", name: "PLASTER" } });
});

// ---------------------------------------------------------------- synthetic rows and helpers

const pad = (n, width) => String(n).padStart(width, "0");
const passportOf = (i) => `N7${pad(i, 6)}`;
const SECRETS = (i) => [passportOf(i), `SYNTHSURNAME${i}`, `${520000000 + i}V`, `074${pad(i, 7)}`, `${i} Synthetic Lane`];
function row(i, overrides = {}) {
    return {
        rowNumber: i + 1,
        values: {
            "PASSPORT NUMBER": passportOf(i), SURNAME: `SYNTHSURNAME${i}`, "OTHER NAME": `SYNTH GIVEN ${i}`, "NIC NUMBER": `${520000000 + i}V`,
            "WHATSAPP NUMBER": `074${pad(i, 7)}`, "JOB ROLE": "Plaster", OFFICER: "John", "INTERVIEW DATE": "11.07.2026", "INTERVIEW PASS FAIL": "PASS",
            COMPANY: "Synth Builders", AGENT: "Synth Agency", "UNIQUE NUMBER": String(3100 + (i % 90)),
            ADDRESS: `${i} Synthetic Lane`, "BIRTH DATE": "05.03.1990", "SHIRT SIZE": "2XL", "FATHER NAME": "SYNTHFATHER",
            ...overrides,
        },
    };
}
const renumber = (rows) => rows.map((r, k) => ({ ...r, rowNumber: k + 2 }));
const many = (count, start = 1, overrides = {}) => renumber(Array.from({ length: count }, (_, k) => row(start + k, overrides)));
const preview = (rows) => previewImport({ db: prisma, actor: ADMIN, fileName: "legacy.xlsx", headers: HEADERS, rows, now: TODAY });
const commit = (p, rows, index, db = prisma) => commitChunk({ db, actor: ADMIN, importId: p.importId, chunkIndex: index, rows: chunkRows(rows, p.chunkSize)[index], now: TODAY });
const importRow = (p) => prisma.candidateImport.findUnique({ where: { importId: p.importId } });
const ledgerOf = (p) => prisma.candidateImportChange.findMany({ where: { importId: p.importId } });
const rejection = (promise) => promise.then(() => assert.fail("expected a rejection"), (error) => error);
const auditCount = (action, importId) => prisma.auditLog.count({ where: { action, reason: { contains: importId } } });

// The log of a run, kept for assertions (and to check that it holds no candidate data).
function captureLog() {
    const lines = [];
    const push = (level) => (line) => lines.push({ level, line: String(line) });
    return { lines, log: { log: push("info"), warn: push("warn"), error: push("error") }, events: (name) => lines.filter((l) => l.line.includes(`"candidate_import.${name}"`)) };
}
const quiet = { log() {}, warn() {}, error() {} };
const recover = ({ config = {}, ...options } = {}) => runImportRecovery({ db: prisma, log: quiet, config: { ...RECOVERY_DEFAULTS, ...config }, ...options });

// Time travel, in the database: the lease ran out `leaseAgoMs` ago; the last heartbeat was `heartbeatAgoMs` ago (null: never).
async function stopped(p, { leaseAgoMs = 5 * 60_000, heartbeatAgoMs = null } = {}) {
    const heartbeat = heartbeatAgoMs === null ? "NULL" : `now() - make_interval(secs => ${heartbeatAgoMs / 1000})`;
    await pg.exec(`UPDATE "candidate_import" SET "commit_lease_expires_at" = now() - make_interval(secs => ${leaseAgoMs / 1000}), "heartbeat_at" = ${heartbeat} WHERE "import_id" = '${p.importId}'`);
}
const makeDue = (p) => pg.exec(`UPDATE "candidate_import" SET "recovery_next_attempt_at" = now() - interval '1 second' WHERE "import_id" = '${p.importId}'`);
// What the sheet worker does after a successful writing reconciliation (sheetSyncWorker.js): the queued run succeeds and
// the open approvals are consumed.
async function sheetWorkerReconciles({ status = "SUCCEEDED", dryRun = false, consume = true } = {}) {
    await pg.exec(`UPDATE "sheet_sync_runs" SET "status" = '${status}', "dry_run" = ${dryRun}, "started_at" = now(), "finished_at" = now() WHERE "status" IN ('QUEUED', 'RUNNING')`);
    if (consume && status === "SUCCEEDED" && !dryRun) await pg.exec(`UPDATE "sheet_deletion_approval" SET "consumed_at" = now() WHERE "consumed_at" IS NULL`);
}
// Runs recovery until it stops making progress on this import (each run is time-bounded).
async function recoverUntilSettled(p, options = {}) {
    for (let i = 0; i < 20; i++) {
        await makeDue(p);
        await recover(options);
        const r = await importRow(p);
        if (r.status !== "ROLLING_BACK") return r;
    }
    return importRow(p);
}
async function register(i, extra = {}) {
    const { values, errors } = parseCandidateBody({
        passportId: passportOf(i), surname: `SYNTHSURNAME${i}`, otherNames: `SYNTH GIVEN ${i}`, nic: `${520000000 + i}V`, whatsappNumber: `074${pad(i, 7)}`, jobTypes: ["PLASTER"], ...extra,
    }, { creating: true });
    assert.equal(errors, undefined);
    return createCandidate({ db: prisma, values, actor: ADMIN });
}
// A client whose transactions run `hook(callNumber)` after their work, before commit (throwing = the process died there).
function withTransactionHook(hook) {
    let calls = 0;
    return new Proxy(prisma, {
        get(target, prop) {
            if (prop === "$transaction") return (fn, options) => target.$transaction(async (tx) => { const result = await fn(tx); await hook(++calls); return result; }, options);
            const value = target[prop];
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}
const crash = () => { throw Object.assign(new Error("synthetic crash"), { code: "ECONNRESET" }); };

// ---------------------------------------------------------------- configuration

describe("configuration and backoff", () => {
    test("defaults; valid values are taken; invalid ones keep the default and are reported by name only", () => {
        assert.equal(readRecoveryConfig({}).config.heartbeatGraceMs, 90_000);
        const ok = readRecoveryConfig({ IMPORT_RECOVERY_HEARTBEAT_GRACE_MS: "60000", IMPORT_RECOVERY_MAX_IDLE_MS: "600000", IMPORT_RECOVERY_MAX_ATTEMPTS: "5" });
        assert.deepEqual([ok.config.heartbeatGraceMs, ok.config.maxIdleMs, ok.config.maxAttempts, ok.problems], [60_000, 600_000, 5, []]);
        const bad = readRecoveryConfig({ IMPORT_RECOVERY_HEARTBEAT_GRACE_MS: "1000", IMPORT_RECOVERY_MAX_ATTEMPTS: "lots" });
        assert.equal(bad.config.heartbeatGraceMs, 90_000);
        assert.equal(bad.problems.length, 2);
        assert.ok(bad.problems.every((p) => p.startsWith("IMPORT_RECOVERY_")) && !bad.problems.some((p) => p.includes("lots")));
    });
    test("the backoff doubles and is capped", () => {
        assert.deepEqual([1, 2, 3, 10, 20].map((n) => backoffMs(n)), [60_000, 120_000, 240_000, 3_600_000, 3_600_000]);
    });
});

// ---------------------------------------------------------------- the commit lease and the heartbeat

describe("the commit lease and the heartbeat", () => {
    test("each chunk sets the commit lease in database time; the heartbeat records heartbeat_at and never moves the lease", async () => {
        const rows = many(150);
        const p = await preview(rows);
        assert.equal((await importRow(p)).commitLeaseExpiresAt, null, "a preview takes no lease");
        await commit(p, rows, 0);
        const [{ ahead }] = (await pg.query(`SELECT extract(epoch FROM "commit_lease_expires_at" - now())::int AS "ahead" FROM "candidate_import" WHERE "import_id" = '${p.importId}'`)).rows;
        assert.ok(ahead > IMPORT_COMMIT_LEASE_MS / 1000 - 10 && ahead <= IMPORT_COMMIT_LEASE_MS / 1000, `lease ${ahead} s ahead`);
        await stopped(p, { leaseAgoMs: 60_000, heartbeatAgoMs: 60_000 });
        const before = (await importRow(p)).commitLeaseExpiresAt;
        assert.deepEqual(await recordImportHeartbeat({ db: prisma, actor: ADMIN, importId: p.importId }), { status: "COMMITTING", recorded: true });
        const afterBeat = await importRow(p);
        assert.equal(afterBeat.commitLeaseExpiresAt.getTime(), before.getTime(), "the heartbeat did not renew the lease");
        assert.ok(Date.now() - afterBeat.heartbeatAt.getTime() < 10_000);
    });

    test("a heartbeat before the first chunk is accepted without recording; another administrator's import is not found", async () => {
        const p = await preview(many(3));
        assert.deepEqual(await recordImportHeartbeat({ db: prisma, actor: ADMIN, importId: p.importId }), { status: "PREVIEWED", recorded: false });
        const other = await rejection(recordImportHeartbeat({ db: prisma, actor: { adminId: "admin-ANALYST", role: "ADMIN" }, importId: p.importId }));
        assert.equal(other.code, "IMPORT_NOT_FOUND");
    });
});

// ---------------------------------------------------------------- detection

describe("detecting an abandoned import", () => {
    test("(1) the browser closes during the import: lease expired, no heartbeat -> claimed and rolled back without any browser", async () => {
        const rows = many(250);
        const p = await preview(rows);
        await commit(p, rows, 0);
        await stopped(p);
        const summary = await recover();
        assert.deepEqual(summary.claimed, [p.importId]);
        const record = await importRow(p);
        assert.equal(record.rollbackPreviousStatus, "COMMITTING");
        assert.equal(record.recoveryReason, RECOVERY_REASON.ABANDONED_COMMIT);
        assert.equal(await prisma.candidate.count(), 0, "what the import made is gone");
        assert.equal(record.status, "ROLLED_BACK");
        assert.equal(record.recoveryStatus, RECOVERY_STATUS.SHEET_PENDING, "not complete until the Sheet is reconciled");
        assert.equal(record.resultCounts.uncommittedChunks, 2);
        assert.equal(await auditCount(RECOVERY_AUDIT_ACTION.STARTED, p.importId), 1);
    });

    test("(2) the computer loses power after several committed chunks: everything those chunks wrote is reverted", async () => {
        const rows = many(350);
        const p = await preview(rows);
        for (const index of [0, 1, 2]) await commit(p, rows, index);
        assert.equal(await prisma.candidate.count(), 300);
        await stopped(p, { leaseAgoMs: 4 * 60_000, heartbeatAgoMs: 4 * 60_000 });
        const record = await recoverUntilSettled(p);
        assert.equal(record.status, "ROLLED_BACK");
        assert.deepEqual(await Promise.all([prisma.candidate.count(), prisma.job.count(), prisma.client.count(), prisma.agent.count(), prisma.candidateStage.count()]), [0, 0, 0, 0, 0]);
        assert.equal((await ledgerOf(p)).filter((e) => e.status === LEDGER_STATUS.APPLIED).length, 0);
    });

    test("(3) the backend crashes inside a chunk: that chunk leaves nothing (one transaction); the chunks before it are reverted", async () => {
        const rows = many(250);
        const p = await preview(rows);
        await commit(p, rows, 0);
        const entriesBefore = (await ledgerOf(p)).length;
        // Every transaction of chunk 1 dies before commit (the process is gone).
        await rejection(commit(p, rows, 1, withTransactionHook(crash)));
        assert.equal(await prisma.candidate.count(), 100, "the crashed chunk wrote nothing");
        assert.equal((await ledgerOf(p)).length, entriesBefore, "and recorded nothing");
        await stopped(p);
        const record = await recoverUntilSettled(p);
        assert.equal(record.status, "ROLLED_BACK");
        assert.equal(await prisma.candidate.count(), 0);
    });

    test("(4) the backend crashes after the last chunk but before finishImport: rolled back, never marked COMPLETED", async () => {
        const rows = many(120);
        const p = await preview(rows);
        await commit(p, rows, 0);
        await commit(p, rows, 1);
        assert.equal((await importRow(p)).status, "COMMITTING", "every chunk committed, but the import was never finished");
        await stopped(p);
        const record = await recoverUntilSettled(p);
        assert.equal(record.status, "ROLLED_BACK");
        assert.notEqual(record.status, "COMPLETED");
        assert.equal(record.completedAt, null);
        assert.equal(await prisma.candidate.count(), 0);
        assert.equal(await auditCount("BULK_IMPORT_COMPLETED", p.importId), 0);
    });

    test("(5) a network failure after the commit but before the response: the retried chunk is not written twice, and a finished import is never recovered", async () => {
        const rows = many(150);
        const p = await preview(rows);
        await commit(p, rows, 0); // the answer is lost on the way back
        const entries = (await ledgerOf(p)).length;
        const retried = await commit(p, rows, 0);
        assert.equal(retried.alreadyCommitted, true);
        assert.equal((await ledgerOf(p)).length, entries, "no change recorded twice");
        await commit(p, rows, 1);
        await finishImport({ db: prisma, actor: ADMIN, importId: p.importId });
        await stopped(p, { leaseAgoMs: 60 * 60_000 });
        const summary = await recover();
        assert.deepEqual(summary.claimed, []);
        assert.equal((await importRow(p)).status, "COMPLETED");
        assert.equal(await prisma.candidate.count(), 150, "a completed import keeps everything");
    });

    test("(6) only an EXPIRED lease is recovered: a lease still running keeps the import, whatever the heartbeat", async () => {
        const rows = many(150);
        const p = await preview(rows);
        await commit(p, rows, 0);
        // The lease from the chunk is still running; no heartbeat at all.
        await pg.exec(`UPDATE "candidate_import" SET "heartbeat_at" = NULL WHERE "import_id" = '${p.importId}'`);
        assert.deepEqual((await recover()).claimed, []);
        await stopped(p, { leaseAgoMs: 1_000 });
        assert.deepEqual((await recover()).claimed, [p.importId]);
    });

    test("(7) a slow but active import is not recovered: a fresh heartbeat holds it, but only up to the maximum idle time", async () => {
        const rows = many(150);
        const p = await preview(rows);
        await commit(p, rows, 0);
        // Lease expired 3 minutes ago, browser seen 10 s ago (a long chunk request, a cold start): kept.
        await stopped(p, { leaseAgoMs: 3 * 60_000, heartbeatAgoMs: 10_000 });
        assert.deepEqual((await recover()).claimed, []);
        assert.equal((await importRow(p)).status, "COMMITTING");
        // The browser goes on and commits: nothing was lost.
        await commit(p, rows, 1);
        await finishImport({ db: prisma, actor: ADMIN, importId: p.importId });
        assert.equal(await prisma.candidate.count(), 150);
    });

    test("(7b) a tab left open while nothing reaches the backend cannot hold an import for ever (maximum idle time)", async () => {
        const rows = many(150);
        const p = await preview(rows);
        await commit(p, rows, 0);
        await stopped(p, { leaseAgoMs: RECOVERY_DEFAULTS.maxIdleMs + 60_000, heartbeatAgoMs: 5_000 });
        assert.deepEqual((await recover()).claimed, [p.importId]);
    });

    test("an import that predates the commit lease is never recovered automatically, and is listed for an administrator", async () => {
        const rows = many(150);
        const p = await preview(rows);
        await commit(p, rows, 0);
        await pg.exec(`UPDATE "candidate_import" SET "commit_lease_expires_at" = NULL, "heartbeat_at" = NULL, "updated_at" = now() - interval '2 hours' WHERE "import_id" = '${p.importId}'`);
        assert.deepEqual((await recover()).claimed, []);
        assert.equal((await importRow(p)).status, "COMMITTING");
        const listed = await listImportRecoveries({ db: prisma });
        const item = listed.items.find((i) => i.importId === p.importId);
        assert.equal(item.tracked, false);
        assert.equal(item.needsAttention, true);
        assert.equal(listed.summary.untrackedCommitting, 1);
    });

    test("(8) two recovery runs at once claim the import exactly once", async () => {
        const rows = many(150);
        const p = await preview(rows);
        await commit(p, rows, 0);
        await stopped(p);
        const [a, b] = await Promise.all([recover(), recover()]);
        assert.equal(a.claimed.length + b.claimed.length, 1);
        assert.equal(await auditCount(RECOVERY_AUDIT_ACTION.STARTED, p.importId), 1);
        assert.equal(await auditCount("BULK_IMPORT_ROLLBACK_STARTED", p.importId), 1);
        const record = await recoverUntilSettled(p);
        assert.equal(record.status, "ROLLED_BACK");
        assert.equal(await prisma.candidate.count(), 0);
    });
});

// ---------------------------------------------------------------- the returning browser

describe("(11) a browser that comes back after the recovery has started", () => {
    test("chunk, finish, abort and heartbeat are refused with IMPORT_RECOVERY_STARTED; nothing more is written; the dialog sees the recovery", async () => {
        const rows = many(250);
        const p = await preview(rows);
        await commit(p, rows, 0);
        await stopped(p);
        // Claimed only (no time to work on it in this run).
        await recover({ config: { timeBudgetMs: 0 } });
        assert.equal((await importRow(p)).status, "ROLLING_BACK");
        const before = await prisma.candidate.count();
        for (const attempt of [
            () => commit(p, rows, 1),
            () => commit(p, rows, 0),
            () => finishImport({ db: prisma, actor: ADMIN, importId: p.importId }),
            () => abortImport({ db: prisma, actor: ADMIN, importId: p.importId }),
            () => recordImportHeartbeat({ db: prisma, actor: ADMIN, importId: p.importId }),
        ]) assert.equal((await rejection(attempt())).code, "IMPORT_RECOVERY_STARTED");
        assert.equal(await prisma.candidate.count(), before, "the refused chunk wrote nothing");
        const { active } = await getActiveImport({ db: prisma, actor: ADMIN });
        assert.equal(active.recovery, RECOVERY_STATUS.ROLLING_BACK);
        // The administrator's slot is free again: a new upload can start.
        const next = await preview(many(3, 900));
        await commit(next, many(3, 900), 0);
    });
});

// ---------------------------------------------------------------- crash during the rollback, resumption

describe("(9, 10) the rollback itself is interrupted, and resumed", () => {
    test("a rollback batch dies halfway: its work is undone with it; the next run continues and finishes without repeating anything", async () => {
        const rows = many(200);
        const p = await preview(rows);
        await commit(p, rows, 0);
        await commit(p, rows, 1);
        await stopped(p);
        // Transactions: 1 claim, 2 adopt, 3 the rollback's lease claim, 4 first batch, 5 second batch (dies).
        await runImportRecovery({ db: withTransactionHook((n) => (n === 5 ? crash() : null)), log: quiet });
        const interrupted = await importRow(p);
        assert.equal(interrupted.status, "ROLLING_BACK");
        assert.equal(interrupted.recoveryStatus, RECOVERY_STATUS.ROLLING_BACK);
        assert.equal(interrupted.recoveryAttempts, 1);
        assert.equal(interrupted.recoveryLastError, "ROLLBACK_INTERRUPTED");
        const partly = await ledgerOf(p);
        assert.ok(partly.some((e) => e.status === LEDGER_STATUS.REVERTED), "the first batch stayed done");
        assert.ok(partly.some((e) => e.status === LEDGER_STATUS.APPLIED), "the dead batch left its entries to do");
        assert.ok(await prisma.candidate.count() > 0 && await prisma.candidate.count() < 200);
        // Backoff: not due yet, so the next run leaves it.
        assert.deepEqual((await recover()).worked, []);
        const record = await recoverUntilSettled(p);
        assert.equal(record.status, "ROLLED_BACK");
        assert.equal(record.recoveryAttempts, 0, "progress resets the failure count");
        assert.equal(await prisma.candidate.count(), 0);
        const entries = await ledgerOf(p);
        assert.ok(entries.every((e) => e.status === LEDGER_STATUS.REVERTED || e.status === LEDGER_STATUS.SKIPPED));
        // Each reverted unit was audited once: no unit was reverted twice.
        const audits = await prisma.auditLog.findMany({ where: { action: "BULK_IMPORT_ROLLBACK_ENTRY", reason: { contains: p.importId } }, select: { newValue: true } });
        const changeIds = audits.flatMap((a) => JSON.parse(a.newValue).entries);
        assert.equal(new Set(changeIds).size, changeIds.length);
    });

    test("a rollback an administrator started and abandoned is adopted and finished", async () => {
        const rows = many(150);
        const p = await preview(rows);
        await commit(p, rows, 0);
        await commit(p, rows, 1);
        await finishImport({ db: prisma, actor: ADMIN, importId: p.importId });
        // The administrator starts it; the browser is closed after the first (zero-budget) call.
        const first = await executeRollback({ db: prisma, actor: ADMIN, importId: p.importId, confirm: true, timeBudgetMs: 0 });
        assert.equal(first.done, false);
        // Just interrupted: left to the administrator for a while.
        assert.deepEqual((await recover()).adopted, []);
        await pg.exec(`UPDATE "candidate_import" SET "rollback_lease_expires_at" = now() - interval '10 minutes' WHERE "import_id" = '${p.importId}'`);
        assert.deepEqual((await recover()).adopted, [p.importId]);
        const record = await recoverUntilSettled(p);
        assert.equal(record.status, "ROLLED_BACK");
        assert.equal(record.recoveryReason, RECOVERY_REASON.ROLLBACK_INTERRUPTED);
        assert.equal(await prisma.candidate.count(), 0);
    });
});

// ---------------------------------------------------------------- the ledger key

describe("(12) the ledger key is unavailable", () => {
    test("nothing is restored or deleted without it; the state is kept, counted, alerted after the limit, and finished once the key is back", async () => {
        const rows = many(150);
        const p = await preview(rows);
        await commit(p, rows, 0);
        await stopped(p);
        const capture = captureLog();
        for (let i = 0; i < 3; i++) {
            await makeDue(p);
            await runImportRecovery({ db: prisma, keyring: null, log: capture.log, config: { ...RECOVERY_DEFAULTS, maxAttempts: 2 } });
        }
        const waiting = await importRow(p);
        assert.equal(waiting.status, "ROLLING_BACK", "kept in its incomplete recovery state");
        assert.equal(waiting.recoveryStatus, RECOVERY_STATUS.NEEDS_ATTENTION);
        assert.equal(waiting.recoveryLastError, RECOVERY_ERROR.KEY_NOT_CONFIGURED);
        assert.equal(waiting.recoveryAttempts, 3);
        assert.equal(await prisma.candidate.count(), 100, "nothing was touched");
        assert.ok((await ledgerOf(p)).every((e) => e.status === LEDGER_STATUS.APPLIED), "no entry was judged without the key");
        assert.equal(await auditCount(RECOVERY_AUDIT_ACTION.ATTENTION, p.importId), 1, "alerted once, not on every run");
        assert.equal(capture.events("recovery_attention").length, 1);
        assert.equal(capture.events("recovery_attention")[0].level, "error");
        // The key is configured again: the next run finishes it by itself.
        const record = await recoverUntilSettled(p);
        assert.equal(record.status, "ROLLED_BACK");
        assert.equal(await prisma.candidate.count(), 0);
    });

    test("a keyring without the key id the entries were signed with is treated the same (never a plain-hash fallback)", async () => {
        const rows = many(150);
        const p = await preview(rows);
        await commit(p, rows, 0);
        await stopped(p);
        const other = new LedgerKeyring({ current: { id: "unrelated", secret: "u".repeat(40) } });
        await recover({ keyring: other });
        const record = await importRow(p);
        assert.equal(record.recoveryLastError, RECOVERY_ERROR.KEY_ID_UNAVAILABLE);
        assert.equal(await prisma.candidate.count(), 100);
    });
});

// ---------------------------------------------------------------- conflicts

describe("(13) a candidate changed by someone else after the import", () => {
    test("the newer change is kept, the entry is a conflict with its reason, the import is never reported clean, administrators are alerted", async () => {
        const rows = many(150);
        const p = await preview(rows);
        await commit(p, rows, 0);
        await prisma.candidate.update({ where: { passportId: passportOf(1) }, data: { firstName: "CHANGEDBYOFFICER" } });
        await stopped(p);
        const capture = captureLog();
        let record = await recoverUntilSettled(p);
        assert.equal(record.status, "ROLLED_BACK_WITH_CONFLICTS");
        assert.equal((await prisma.candidate.findUnique({ where: { passportId: passportOf(1) } })).firstName, "CHANGEDBYOFFICER", "never overwritten");
        assert.equal(await prisma.candidate.count(), 1, "only the changed candidate stays");
        const conflict = (await ledgerOf(p)).find((e) => e.status === LEDGER_STATUS.CONFLICT && e.entityType === E.CANDIDATE);
        assert.ok(conflict.revertDetail.reasons.some((r) => r.startsWith("FIELD_CHANGED")));
        // The Sheet is reconciled; the import still needs an administrator.
        await sheetWorkerReconciles();
        await makeDue(p);
        await runImportRecovery({ db: prisma, log: capture.log });
        record = await importRow(p);
        assert.equal(record.recoveryStatus, RECOVERY_STATUS.NEEDS_ATTENTION);
        assert.equal(record.recoveryLastError, RECOVERY_ERROR.ROLLBACK_CONFLICTS);
        assert.equal(await auditCount(RECOVERY_AUDIT_ACTION.ATTENTION, p.importId), 1);
        assert.equal(await auditCount(RECOVERY_AUDIT_ACTION.COMPLETED, p.importId), 0);
        const report = await getRollback({ db: prisma, actor: ADMIN, importId: p.importId });
        assert.equal(report.status, "ROLLED_BACK_WITH_CONFLICTS");
        assert.equal(report.sheet.complete, false, "not complete while an administrator must act");
        // Nothing personal in the alert or the logs.
        const logged = capture.lines.map((l) => l.line).join("\n");
        for (const secret of [...SECRETS(1), "CHANGEDBYOFFICER"]) assert.ok(!logged.includes(secret), "no candidate data in the logs");
    });
});

// ---------------------------------------------------------------- job types

describe("(14, 15) job types the import created", () => {
    const welderRows = (count, start = 1) => many(count, start, { "JOB ROLE": "Welder" });

    test("(14) created inside the chunk transaction, recorded in the ledger, and removed by the recovery", async () => {
        const rows = welderRows(150);
        const p = await preview(rows);
        assert.equal(await prisma.jobType.count({ where: { code: "WELDER" } }), 0, "a preview creates nothing");
        await commit(p, rows, 0);
        const type = await prisma.jobType.findUnique({ where: { code: "WELDER" } });
        assert.ok(type);
        const entry = (await ledgerOf(p)).find((e) => e.entityType === E.JOB_TYPE);
        assert.equal(entry.entityKey, type.id);
        assert.equal(entry.op, "CREATE");
        assert.deepEqual(Object.keys(entry.changes).sort(), ["code", "isActive", "name"]);
        await stopped(p);
        const record = await recoverUntilSettled(p);
        assert.equal(record.status, "ROLLED_BACK");
        assert.equal(await prisma.jobType.count({ where: { code: "WELDER" } }), 0);
        assert.ok(await prisma.jobType.findUnique({ where: { code: "PLASTER" } }), "an existing type is never touched");
    });

    test("(14b) a chunk that fails leaves no job type behind (the type is part of the chunk's transaction)", async () => {
        const rows = welderRows(150);
        const p = await preview(rows);
        await rejection(commit(p, rows, 0, withTransactionHook(crash)));
        assert.equal(await prisma.jobType.count({ where: { code: "WELDER" } }), 0);
        assert.equal((await ledgerOf(p)).length, 0);
    });

    test("(15) a job type used since by a candidate preference or by a Job stays; only its entry is kept as a conflict", async () => {
        const rows = welderRows(150);
        const p = await preview(rows);
        await commit(p, rows, 0);
        const type = await prisma.jobType.findUnique({ where: { code: "WELDER" } });
        await register(900, { jobTypes: [type.name] }); // someone registers a welder by hand
        await stopped(p);
        const record = await recoverUntilSettled(p);
        assert.equal(record.status, "ROLLED_BACK_WITH_CONFLICTS");
        assert.ok(await prisma.jobType.findUnique({ where: { id: type.id } }), "the shared type is preserved");
        const entry = (await ledgerOf(p)).find((e) => e.entityType === E.JOB_TYPE);
        assert.equal(entry.status, LEDGER_STATUS.CONFLICT);
        assert.deepEqual(entry.revertDetail.reasons, ["HAS_CANDIDATE_PREFERENCES"]);
        assert.equal(await prisma.candidate.count(), 1, "only the hand-registered candidate is left");
    });

    test("(15b) a job type an existing Job uses is preserved", async () => {
        const rows = welderRows(150);
        const p = await preview(rows);
        await commit(p, rows, 0);
        const type = await prisma.jobType.findUnique({ where: { code: "WELDER" } });
        const importJob = await prisma.job.findFirst({ select: { clientId: true, responsibleAgentId: true } });
        await prisma.job.create({ data: { jobCode: "JOB-2026-900001", jobTypeId: type.id, clientId: importJob.clientId, responsibleAgentId: importJob.responsibleAgentId, countryCode: "RO", fromCountryCode: "LK", createdById: ADMIN.adminId, jobTypes: { create: [{ jobTypeId: type.id }] } } });
        await stopped(p);
        await recoverUntilSettled(p);
        assert.ok(await prisma.jobType.findUnique({ where: { id: type.id } }));
        const entry = (await ledgerOf(p)).find((e) => e.entityType === E.JOB_TYPE);
        assert.equal(entry.status, LEDGER_STATUS.CONFLICT);
        assert.ok(entry.revertDetail.reasons.some((r) => r.startsWith("HAS_DEPENDENT_RECORDS")));
    });
});

// ---------------------------------------------------------------- the Google Sheet

describe("(16, 17) Google Sheet reconciliation", () => {
    test("(16) the database rollback records one approval per deleted candidate and requests a reconciliation; complete only once they are consumed", async () => {
        const rows = many(150);
        const p = await preview(rows);
        await commit(p, rows, 0);
        await stopped(p);
        let record = await recoverUntilSettled(p);
        assert.equal(record.recoveryStatus, RECOVERY_STATUS.SHEET_PENDING);
        assert.equal(await prisma.sheetSyncDeletionApproval.count({ where: { importId: p.importId, consumedAt: null } }), 100);
        assert.equal(await prisma.sheetSyncRun.count({ where: { kind: "RECONCILE", status: "QUEUED" } }), 1, "the existing reconciliation was requested (one, reused)");
        let report = await getRollback({ db: prisma, actor: ADMIN, importId: p.importId });
        assert.equal(report.status, "ROLLED_BACK");
        assert.equal(report.sheet.complete, false, "not claimed complete while the Sheet is pending");
        assert.equal(report.sheet.pendingApprovals, 100);
        const listed = (await listImportRecoveries({ db: prisma })).items.find((i) => i.importId === p.importId);
        assert.deepEqual(listed.sheet, { pendingApprovals: 100, reconciled: false });
        // A run still queued: the recovery waits for it.
        await makeDue(p);
        await recover();
        assert.equal((await importRow(p)).recoveryStatus, RECOVERY_STATUS.SHEET_PENDING);
        // The sheet worker reconciles and consumes the approvals.
        await sheetWorkerReconciles();
        await makeDue(p);
        await recover();
        record = await importRow(p);
        assert.equal(record.recoveryStatus, RECOVERY_STATUS.COMPLETED);
        assert.ok(record.recoveryCompletedAt);
        assert.equal(await auditCount(RECOVERY_AUDIT_ACTION.COMPLETED, p.importId), 1);
        report = await getRollback({ db: prisma, actor: ADMIN, importId: p.importId });
        assert.deepEqual(report.sheet, { pendingApprovals: 0, complete: true });
        assert.equal(report.recovery.status, RECOVERY_STATUS.COMPLETED);
    });

    test("(17) a failed reconciliation (and a dry run that consumes nothing) is retried with backoff, then completes", async () => {
        const rows = many(150);
        const p = await preview(rows);
        await commit(p, rows, 0);
        await stopped(p);
        await recoverUntilSettled(p);
        await sheetWorkerReconciles({ status: "FAILED" });
        await makeDue(p);
        await recover();
        let record = await importRow(p);
        assert.equal(record.recoveryStatus, RECOVERY_STATUS.SHEET_PENDING);
        assert.equal(record.recoveryLastError, RECOVERY_ERROR.SHEET_INCOMPLETE);
        assert.equal(record.recoveryAttempts, 1);
        assert.equal(await prisma.sheetSyncRun.count({ where: { status: "QUEUED" } }), 1, "a new reconciliation was requested");
        assert.ok(record.recoveryNextAttemptAt.getTime() - Date.now() > 50_000, "after a backoff");
        await sheetWorkerReconciles({ dryRun: true });
        await makeDue(p);
        await recover();
        record = await importRow(p);
        assert.equal(record.recoveryAttempts, 2, "a dry run does not reconcile the Sheet");
        assert.equal(await prisma.sheetSyncDeletionApproval.count({ where: { importId: p.importId, consumedAt: null } }), 100);
        await sheetWorkerReconciles();
        await makeDue(p);
        await recover();
        record = await importRow(p);
        assert.equal(record.recoveryStatus, RECOVERY_STATUS.COMPLETED);
        assert.equal(record.recoveryResult.sheetRunsRequested >= 2, true);
    });
});

// ---------------------------------------------------------------- retry limits and alerts

describe("(18) retry limits and administrator alerts", () => {
    test("repeated Sheet failures end in NEEDS_ATTENTION with one alert; retries go on and a later success completes it", async () => {
        const rows = many(150);
        const p = await preview(rows);
        await commit(p, rows, 0);
        await stopped(p);
        await recoverUntilSettled(p);
        const capture = captureLog();
        const config = { ...RECOVERY_DEFAULTS, maxAttempts: 3 };
        for (let i = 0; i < 5; i++) {
            await sheetWorkerReconciles({ status: "FAILED" });
            await makeDue(p);
            await runImportRecovery({ db: prisma, log: capture.log, config });
        }
        let record = await importRow(p);
        assert.equal(record.recoveryStatus, RECOVERY_STATUS.NEEDS_ATTENTION);
        assert.equal(record.recoveryLastError, RECOVERY_ERROR.SHEET_INCOMPLETE);
        assert.ok(record.recoveryNotifiedAt);
        assert.equal(await auditCount(RECOVERY_AUDIT_ACTION.ATTENTION, p.importId), 1);
        assert.equal(capture.events("recovery_attention").length, 1);
        assert.ok(capture.events("recovery_retry").length >= 3);
        const listed = await listImportRecoveries({ db: prisma });
        assert.equal(listed.summary.needsAttention, 1);
        // Not abandoned: once the worker succeeds, the next run completes it.
        await sheetWorkerReconciles();
        await makeDue(p);
        await runImportRecovery({ db: prisma, log: capture.log, config });
        record = await importRow(p);
        assert.equal(record.recoveryStatus, RECOVERY_STATUS.COMPLETED);
    });
});

// ---------------------------------------------------------------- the task endpoint and the admin routes

describe("the scheduled task endpoint", () => {
    const appWith = (options) => {
        const app = express();
        app.use(express.json());
        app.use("/api/tasks", createTaskRouter({ db: prisma, log: quiet, env: {}, ...options }));
        app.use((error, req, res, next) => res.status(500).json({ message: "Internal server error" })); // eslint-disable-line no-unused-vars
        return app;
    };
    const call = async (app, headers = {}) => {
        const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
        try {
            const res = await fetch(`http://127.0.0.1:${server.address().port}/api/tasks/import-recovery`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
            return { status: res.status, body: res.status === 200 ? await res.json() : null };
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    };

    test("disabled (404) without the scheduler audience and invoker; never runs", async () => {
        assert.equal(recoverySchedulerVerifier({}), null);
        assert.equal(recoverySchedulerVerifier({ IMPORT_RECOVERY_SCHEDULER_AUDIENCE: "https://x" }), null);
        let ran = false;
        const { status } = await call(appWith({ verifyScheduler: null, runRecovery: async () => { ran = true; } }));
        assert.equal(status, 404);
        assert.equal(ran, false);
    });

    test("a call without a valid token is refused (401) and runs nothing", async () => {
        let ran = false;
        const { status } = await call(appWith({ verifyScheduler: async (auth) => auth === "Bearer good", runRecovery: async () => { ran = true; } }), { authorization: "Bearer bad" });
        assert.equal(status, 401);
        assert.equal(ran, false);
    });

    test("a valid scheduler call runs one recovery and answers counts and ids only", async () => {
        const rows = many(150);
        const p = await preview(rows);
        await commit(p, rows, 0);
        await stopped(p);
        const { status, body } = await call(appWith({ verifyScheduler: async (auth) => auth === "Bearer good" }), { authorization: "Bearer good" });
        assert.equal(status, 200);
        assert.deepEqual(body.claimed, [p.importId]);
        const text = JSON.stringify(body);
        for (const secret of SECRETS(1)) assert.ok(!text.includes(secret));
    });
});
