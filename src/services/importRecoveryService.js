// Bulk candidate import: AUTOMATIC RECOVERY of interrupted imports (migration 20261113120000).
//
// The business rule is all-or-nothing: an import that the backend has recorded as finished (finishImport) keeps its
// data; one that stopped before that (the browser closed, the computer lost power, the network or the backend failed,
// the process was killed) is rolled back, from its change ledger, without any browser. If the rollback itself is
// interrupted, the next run continues it.
//
// It runs as a scheduled backend task (POST /api/tasks/import-recovery, routes/tasks.js; Cloud Scheduler about once a
// minute, OIDC-authenticated), in the API, which holds IMPORT_LEDGER_HMAC_SECRET. One run (runImportRecovery):
//
//   1. DETECT and CLAIM abandoned imports, in one transaction, with FOR UPDATE SKIP LOCKED. An import is abandoned only
//      when ALL of these hold:
//        - it is COMMITTING and not already under recovery (a state recovery may start from),
//        - it committed at least one chunk under this code (commit_lease_expires_at is set: imports that predate the
//          lease are never touched automatically, see the migration),
//        - its commit lease has expired (database time): no chunk transaction has renewed it for IMPORT_COMMIT_LEASE_MS,
//        - its browser heartbeat is older than the grace period, OR the lease expired longer ago than the maximum idle
//          time (a tab left open while nothing reaches the backend cannot hold an import for ever),
//        - no transaction holds its row: every chunk (and row) transaction locks the import row, and SKIP LOCKED passes
//          a locked row by, so a slow but active chunk is never taken for an abandoned import.
//      Claiming moves it, in the same transaction, to the EXISTING rollback state ROLLING_BACK (rollback_previous_status
//      COMMITTING): the per-administrator COMMITTING slot is freed, and a returning browser is refused from then on
//      (IMPORT_RECOVERY_STARTED) by the chunk, finish, abort and heartbeat paths, which all check under the row lock.
//      Two recovery runs can never claim the same import: the second skips the locked row or no longer matches it.
//   2. ADOPT a rollback an administrator started that was interrupted (ROLLING_BACK, its lease expired for longer than
//      a grace period): it is continued exactly where it stopped.
//   3. WORK, within a time budget, on every recovery that is due (exponential backoff after a failure):
//        ROLLING_BACK     executeRollback of candidateImportRollback.js: the SAME units, leases, batches, per-unit
//                         savepoints, conflict rules and finalization as a rollback from the browser. Nothing is
//                         duplicated here. Without a usable ledger key nothing is attempted (no plain-hash fallback, no
//                         blind restore): the state is kept, the attempt counted, administrators alerted, and it is
//                         retried until the key is configured again.
//        SHEET_PENDING    the database is rolled back; the Google Sheet is not yet confirmed. Confirmed = no unconsumed
//                         sheet_deletion_approval of this import AND a successful, writing (not dry-run) reconciliation
//                         that started after the rollback finished. Otherwise a reconciliation is requested (the existing
//                         sheet_sync_runs; the worker alone writes the Sheet, and only through its unchanged deletion
//                         guard, except for exactly the approved, absent candidates). Nothing here touches the Sheet.
//        COMPLETED        rolled back cleanly AND reconciled.
//        NEEDS_ATTENTION  an administrator must look: entries were kept as conflicts (changed or used since: never
//                         overwritten or deleted), or retries ran out. A conflicted import is never reported clean.
//                         Retries continue at the longest backoff, so a restored configuration or a resolved conflict
//                         (re-run from the Upload dialog) is picked up by itself.
//
// Alerts: an audit entry BULK_IMPORT_RECOVERY_ATTENTION and one structured error log event
// candidate_import.recovery_attention (for a log-based alert) when an import first needs attention for a reason.
// Logs, audit entries and results hold import ids, statuses, counts and codes only: never candidate data or a secret.

import crypto from "node:crypto";

import { CandidateImportError, IMPORT_STATUS, importCountsOf } from "./candidateImportService.js";
import { LEDGER_STATUS } from "./candidateImportLedger.js";
import { ROLLBACK_AUDIT_ACTION, executeRollback } from "./candidateImportRollback.js";
import { HMAC_METHOD, LedgerKeyConfigError, readLedgerKeyring } from "./importLedgerKeys.js";
import { requestSheetSyncRun } from "./sheetSyncStatusService.js";
import { RUN_KIND, RUN_STATUS, RUN_TRIGGER } from "./sheetSyncStore.js";

export const RECOVERY_STATUS = Object.freeze({ ROLLING_BACK: "ROLLING_BACK", SHEET_PENDING: "SHEET_PENDING", COMPLETED: "COMPLETED", NEEDS_ATTENTION: "NEEDS_ATTENTION" });
export const RECOVERY_REASON = Object.freeze({ ABANDONED_COMMIT: "ABANDONED_COMMIT", ROLLBACK_INTERRUPTED: "ROLLBACK_INTERRUPTED" });
export const RECOVERY_AUDIT_ACTION = Object.freeze({
    STARTED: "BULK_IMPORT_RECOVERY_STARTED", COMPLETED: "BULK_IMPORT_RECOVERY_COMPLETED", ATTENTION: "BULK_IMPORT_RECOVERY_ATTENTION",
});
export const RECOVERY_ERROR = Object.freeze({
    KEY_NOT_CONFIGURED: "LEDGER_KEY_NOT_CONFIGURED", KEY_ID_UNAVAILABLE: "LEDGER_KEY_ID_UNAVAILABLE", ROLLBACK_CONFLICTS: "ROLLBACK_CONFLICTS",
    SHEET_INCOMPLETE: "SHEET_RECONCILIATION_INCOMPLETE", SHEET_RUN_STUCK: "SHEET_RUN_STUCK", UNEXPECTED_STATE: "UNEXPECTED_STATE",
});

export const RECOVERY_DEFAULTS = Object.freeze({
    heartbeatGraceMs: 90_000, // the browser beats every ~20 s: four missed beats
    maxIdleMs: 10 * 60_000, // a heartbeat delays recovery at most this long after the lease expired
    rollbackResumeGraceMs: 5 * 60_000, // an administrator's own interrupted rollback is left to them this long
    maxAttempts: 8, // consecutive failures before NEEDS_ATTENTION (retries go on at the longest backoff)
    backoffBaseMs: 60_000,
    backoffMaxMs: 60 * 60_000,
    claimLimit: 10, // imports claimed per run
    workLimit: 10, // recoveries worked on per run
    timeBudgetMs: 40_000, // under the API function's 60 s
    minStepMs: 5_000, // a step is not started with less time than this left
    waitMs: 60_000, // the next look at a recovery that is waiting (for a Sheet run, for another caller's lease)
    sheetRunStaleMs: 30 * 60_000, // a queued / running reconciliation older than this counts as a failed attempt
    attentionRecheckMs: 60 * 60_000, // how often an import with kept conflicts is looked at again
});
// Codes of conflicts that may disappear by themselves (an unexpected database error in one unit, a unit not reached):
// such an import is rolled back again, within the retry limit, before it is reported.
const TRANSIENT_CONFLICTS = new Set(["REVERT_FAILED", "NOT_REACHED"]);
const TX = Object.freeze({ timeout: 30_000, maxWait: 10_000 });

const ENV_LIMITS = Object.freeze({
    IMPORT_RECOVERY_HEARTBEAT_GRACE_MS: { key: "heartbeatGraceMs", min: 45_000, max: 60 * 60_000 },
    IMPORT_RECOVERY_MAX_IDLE_MS: { key: "maxIdleMs", min: 2 * 60_000, max: 24 * 60 * 60_000 },
    IMPORT_RECOVERY_MAX_ATTEMPTS: { key: "maxAttempts", min: 1, max: 50 },
});

// The configurable parts (environment), checked: a bad value keeps the default and is reported (names, never values).
export function readRecoveryConfig(env = process.env) {
    const config = { ...RECOVERY_DEFAULTS };
    const problems = [];
    for (const [name, { key, min, max }] of Object.entries(ENV_LIMITS)) {
        const raw = env[name];
        if (raw === undefined || raw === "") continue;
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value < min || value > max) problems.push(`${name} must be a whole number from ${min} to ${max}`);
        else config[key] = value;
    }
    if (config.maxIdleMs < config.heartbeatGraceMs) problems.push("IMPORT_RECOVERY_MAX_IDLE_MS must not be shorter than IMPORT_RECOVERY_HEARTBEAT_GRACE_MS");
    return { config, problems };
}

export const backoffMs = (attempts, config = RECOVERY_DEFAULTS) => Math.min(config.backoffBaseMs * 2 ** Math.max(0, attempts - 1), config.backoffMaxMs);
const secs = (ms) => ms / 1000;
const auditRow = (adminId, data) => ({ auditId: crypto.randomUUID(), adminId, ...data });
const codeOf = (reason) => String(reason).split(":")[0];
const safeCode = (error) => (typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : "DB_ERROR");

// The keyring for this run: the injected one (tests), else the server's. A missing or invalid key is a state, not an error.
function keyringFor(injected) {
    if (injected !== undefined) return injected;
    try {
        return readLedgerKeyring();
    } catch (error) {
        if (error instanceof LedgerKeyConfigError) return null;
        throw error;
    }
}

// The actor a recovery's rollback runs as: the administrator who ran the import (audit entries need an existing user;
// the recovery's own audit entries say that it was automatic). It passes the rollback's access check as that owner.
const actorOf = (record) => ({ adminId: record.adminId, role: "SYSTEM", automatic: true });

// ---------------------------------------------------------------- detection and claim

// Steps 1 and 2. Returns the claimed / adopted import ids.
async function claimAbandoned(db, config) {
    return db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw`
            SELECT c."import_id"::text AS "importId", now() AS "dbNow"
            FROM "candidate_import" c
            WHERE c."status" = 'COMMITTING' AND c."recovery_status" IS NULL
              AND c."commit_lease_expires_at" IS NOT NULL AND c."commit_lease_expires_at" < now()
              AND (c."heartbeat_at" IS NULL
                   OR c."heartbeat_at" < now() - make_interval(secs => ${secs(config.heartbeatGraceMs)}::double precision)
                   OR c."commit_lease_expires_at" < now() - make_interval(secs => ${secs(config.maxIdleMs)}::double precision))
            ORDER BY c."commit_lease_expires_at"
            LIMIT ${config.claimLimit}
            FOR UPDATE OF c SKIP LOCKED`;
        for (const { importId, dbNow } of rows) {
            const record = await tx.candidateImport.findUnique({ where: { importId } });
            const counts = importCountsOf(record);
            await tx.candidateImport.update({
                where: { importId },
                data: {
                    // The existing rollback lifecycle, free for executeRollback to take (no lease held).
                    status: IMPORT_STATUS.ROLLING_BACK, rollbackPreviousStatus: IMPORT_STATUS.COMMITTING, rollbackAdminId: record.adminId, rollbackStartedAt: dbNow,
                    rollbackCompletedAt: null, rollbackResult: null, rollbackLeaseToken: null, rollbackLeaseExpiresAt: null,
                    resultCounts: counts,
                    recoveryStatus: RECOVERY_STATUS.ROLLING_BACK, recoveryReason: RECOVERY_REASON.ABANDONED_COMMIT, recoveryAttempts: 0,
                    recoveryStartedAt: dbNow, recoveryCompletedAt: null, recoveryNextAttemptAt: dbNow, recoveryLastError: null,
                    recoveryResult: {
                        committedChunks: Object.values(record.chunkResults ?? {}).filter((r) => r?.status === "COMMITTED").length,
                        chunkCount: Array.isArray(record.chunkHashes) ? record.chunkHashes.length : 0,
                        leaseExpiredAt: record.commitLeaseExpiresAt?.toISOString() ?? null, lastHeartbeatAt: record.heartbeatAt?.toISOString() ?? null, sheetRunsRequested: 0,
                    },
                    updatedAt: dbNow,
                },
            });
            await tx.auditLog.createMany({
                data: [
                    auditRow(record.adminId, {
                        action: RECOVERY_AUDIT_ACTION.STARTED, previousStatus: IMPORT_STATUS.COMMITTING, newStatus: IMPORT_STATUS.ROLLING_BACK,
                        reason: `Bulk candidate import ${importId} stopped before it finished (no chunk and no browser for too long): it is being rolled back automatically`,
                        newValue: JSON.stringify({ importId, reason: RECOVERY_REASON.ABANDONED_COMMIT, ...counts }),
                    }),
                    auditRow(record.adminId, {
                        action: ROLLBACK_AUDIT_ACTION.STARTED, previousStatus: IMPORT_STATUS.COMMITTING, newStatus: IMPORT_STATUS.ROLLING_BACK,
                        reason: `Rollback of bulk candidate import ${importId} started (automatic recovery)`, newValue: JSON.stringify({ importId, automatic: true }),
                    }),
                ],
            });
        }
        return rows.map((row) => row.importId);
    }, TX);
}

async function adoptInterruptedRollbacks(db, config) {
    return db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw`
            SELECT c."import_id"::text AS "importId", c."admin_id" AS "adminId", now() AS "dbNow"
            FROM "candidate_import" c
            WHERE c."status" = 'ROLLING_BACK' AND c."recovery_status" IS NULL
              AND (c."rollback_lease_expires_at" IS NULL OR c."rollback_lease_expires_at" < now() - make_interval(secs => ${secs(config.rollbackResumeGraceMs)}::double precision))
            ORDER BY c."updated_at"
            LIMIT ${config.claimLimit}
            FOR UPDATE OF c SKIP LOCKED`;
        for (const { importId, adminId, dbNow } of rows) {
            await tx.candidateImport.update({
                where: { importId },
                data: {
                    recoveryStatus: RECOVERY_STATUS.ROLLING_BACK, recoveryReason: RECOVERY_REASON.ROLLBACK_INTERRUPTED, recoveryAttempts: 0, recoveryStartedAt: dbNow,
                    recoveryCompletedAt: null, recoveryNextAttemptAt: dbNow, recoveryLastError: null, recoveryResult: { sheetRunsRequested: 0 },
                },
            });
            await tx.auditLog.create({
                data: auditRow(adminId, {
                    action: RECOVERY_AUDIT_ACTION.STARTED, previousStatus: IMPORT_STATUS.ROLLING_BACK, newStatus: IMPORT_STATUS.ROLLING_BACK,
                    reason: `The rollback of bulk candidate import ${importId} was interrupted: it is being continued automatically`,
                    newValue: JSON.stringify({ importId, reason: RECOVERY_REASON.ROLLBACK_INTERRUPTED }),
                }),
            });
        }
        return rows.map((row) => row.importId);
    }, TX);
}

// ---------------------------------------------------------------- state changes (one place, codes only)

function createRecorder(db, { config, log, now }) {
    const emit = (level, event, fields) => log[level === "error" ? "error" : level === "warn" ? "warn" : "log"](JSON.stringify({ event: `candidate_import.${event}`, ...fields }));
    const save = (record, data) => db.candidateImport.update({ where: { importId: record.importId }, data });
    const resultOf = (record, extra) => ({ ...(record.recoveryResult ?? {}), ...extra });

    // The first time an import needs attention for this reason: an audit entry and an error log event (the alert).
    async function attention(record, code, { next, result = {} } = {}) {
        const fresh = record.recoveryStatus !== RECOVERY_STATUS.NEEDS_ATTENTION || record.recoveryLastError !== code;
        await save(record, {
            recoveryStatus: RECOVERY_STATUS.NEEDS_ATTENTION, recoveryLastError: code, recoveryNextAttemptAt: next ?? new Date(now().getTime() + config.backoffMaxMs),
            recoveryResult: resultOf(record, result), ...(fresh ? { recoveryNotifiedAt: now() } : {}),
        });
        if (!fresh) return;
        await db.auditLog.create({
            data: auditRow(record.adminId, {
                action: RECOVERY_AUDIT_ACTION.ATTENTION, previousStatus: record.recoveryStatus ?? "NONE", newStatus: RECOVERY_STATUS.NEEDS_ATTENTION,
                reason: `The automatic recovery of bulk candidate import ${record.importId} needs an administrator (${code})`,
                newValue: JSON.stringify({ importId: record.importId, code, attempts: record.recoveryAttempts, ...result }),
            }),
        });
        emit("error", "recovery_attention", { importId: record.importId, adminId: record.adminId, code, status: record.status, attempts: record.recoveryAttempts, ...result });
    }

    return {
        emit,
        // A failed attempt: counted, retried after a backoff; after maxAttempts the import needs attention (retries go on).
        async fail(record, code, extra = {}) {
            const attempts = record.recoveryAttempts + 1;
            const next = new Date(now().getTime() + backoffMs(attempts, config));
            const updated = { ...record, recoveryAttempts: attempts };
            await save(record, { recoveryAttempts: attempts, recoveryNextAttemptAt: next, recoveryLastError: code, recoveryResult: resultOf(record, extra) });
            emit("warn", "recovery_retry", { importId: record.importId, code, attempts, retryInMs: next.getTime() - now().getTime() });
            if (attempts >= config.maxAttempts) await attention({ ...updated, recoveryResult: resultOf(record, extra) }, code, { next, result: extra });
            return "FAILED";
        },
        async wait(record, ms = config.waitMs, extra = {}) {
            await save(record, { recoveryNextAttemptAt: new Date(now().getTime() + ms), recoveryResult: resultOf(record, extra) });
            return "WAITING";
        },
        // Progress was made: failures are no longer consecutive.
        async progress(record, data = {}) {
            await save(record, { recoveryAttempts: 0, recoveryLastError: null, recoveryNextAttemptAt: now(), ...data });
            return "PROGRESS";
        },
        attention,
        async complete(record, result) {
            await save(record, { recoveryStatus: RECOVERY_STATUS.COMPLETED, recoveryCompletedAt: now(), recoveryNextAttemptAt: null, recoveryLastError: null, recoveryAttempts: 0, recoveryResult: resultOf(record, result) });
            await db.auditLog.create({
                data: auditRow(record.adminId, {
                    action: RECOVERY_AUDIT_ACTION.COMPLETED, previousStatus: record.recoveryStatus, newStatus: RECOVERY_STATUS.COMPLETED,
                    reason: `Bulk candidate import ${record.importId} was rolled back automatically and the Google Sheet reconciled`,
                    newValue: JSON.stringify({ importId: record.importId, ...result }),
                }),
            });
            emit("info", "recovery_completed", { importId: record.importId, ...result });
            return "COMPLETED";
        },
    };
}

// ---------------------------------------------------------------- the steps

// Every key id the import's still-unreverted entries were signed with must be loaded, or nothing can be verified.
async function missingKeyIds(db, importId, keyring) {
    const rows = await db.$queryRaw`
        SELECT DISTINCT e."value"->'after'->>'k' AS "k"
        FROM "candidate_import_change" c CROSS JOIN LATERAL jsonb_each(c."changes") e
        WHERE c."import_id" = ${importId}::uuid AND c."status" IN ('APPLIED', 'CONFLICT')
          AND jsonb_typeof(e."value"->'after') = 'object' AND e."value"->'after'->>'m' = ${HMAC_METHOD}`;
    return rows.map((row) => row.k).filter((k) => k && !keyring.has(k));
}

const ledgerCounts = async (db, importId) => {
    const groups = await db.candidateImportChange.groupBy({ by: ["status"], where: { importId }, _count: { _all: true } });
    const n = (status) => groups.find((g) => g.status === status)?._count._all ?? 0;
    return { reverted: n(LEDGER_STATUS.REVERTED), conflicts: n(LEDGER_STATUS.CONFLICT), skipped: n(LEDGER_STATUS.SKIPPED), remaining: n(LEDGER_STATUS.APPLIED) };
};
const pendingApprovalsOf = (db, importId) => db.sheetSyncDeletionApproval.count({ where: { importId, consumedAt: null } });

// ROLLING_BACK: the database rollback, through executeRollback, for at most the time left.
async function stepRollback(db, record, { keyring, recorder, remainingMs, clock }) {
    // Already rolled back cleanly (an administrator finished it meanwhile): on to the Sheet. ROLLED_BACK_WITH_CONFLICTS
    // here means a retry of transient conflicts was decided (stepVerify): executeRollback runs it afresh.
    if (record.status === IMPORT_STATUS.ROLLED_BACK) return recorder.progress(record, { recoveryStatus: RECOVERY_STATUS.SHEET_PENDING });
    // No key: nothing is attempted (an HMAC is never skipped, a value never restored blindly). Kept as it is, retried.
    if (!keyring) return recorder.fail(record, RECOVERY_ERROR.KEY_NOT_CONFIGURED);
    const missing = await missingKeyIds(db, record.importId, keyring);
    if (missing.length) return recorder.fail(record, RECOVERY_ERROR.KEY_ID_UNAVAILABLE, { missingKeyIds: missing });
    try {
        const report = await executeRollback({ db, actor: actorOf(record), importId: record.importId, confirm: true, expectedEligible: null, keyring, clock, timeBudgetMs: remainingMs });
        recorder.emit("info", "recovery_rollback_step", { importId: record.importId, status: report.status, done: report.done, ...report.counts });
        if (!report.done) return recorder.progress(record); // the time budget ran out: continued by the next run
        return recorder.progress(record, { recoveryStatus: RECOVERY_STATUS.SHEET_PENDING });
    } catch (error) {
        // Someone else holds the rollback right now (an administrator continuing it, another run): look again later.
        if (error instanceof CandidateImportError && (error.code === "ROLLBACK_IN_PROGRESS" || error.code === "ROLLBACK_LEASE_LOST")) return recorder.wait(record);
        if (error instanceof CandidateImportError && error.code === "ALREADY_ROLLED_BACK") return recorder.progress(record, { recoveryStatus: RECOVERY_STATUS.SHEET_PENDING });
        return recorder.fail(record, safeCode(error), error?.details?.code ? { lastRollbackError: safeCode(error.details) } : {});
    }
}

// SHEET_PENDING / NEEDS_ATTENTION after the database rollback finished: transient conflicts retried, the Sheet confirmed.
async function stepVerify(db, record, { recorder, config, now }) {
    const counts = await ledgerCounts(db, record.importId);
    if (counts.conflicts) {
        const conflicted = await db.candidateImportChange.findMany({ where: { importId: record.importId, status: LEDGER_STATUS.CONFLICT }, select: { revertDetail: true } });
        const transient = conflicted.some((row) => (row.revertDetail?.reasons ?? []).some((reason) => TRANSIENT_CONFLICTS.has(codeOf(reason))));
        if (transient && record.recoveryAttempts < config.maxAttempts) {
            // Rolled back again (a fresh run from ROLLED_BACK_WITH_CONFLICTS retries every conflict), after a backoff
            // (counted as a failed attempt: the last allowed one turns into NEEDS_ATTENTION, then it is reported).
            await db.candidateImport.update({ where: { importId: record.importId }, data: { recoveryStatus: RECOVERY_STATUS.ROLLING_BACK } });
            await recorder.fail(record, "TRANSIENT_CONFLICTS", { ...counts });
            return "RETRY_CONFLICTS";
        }
    }
    const sheet = { pendingApprovals: await pendingApprovalsOf(db, record.importId) };
    const since = record.rollbackCompletedAt ?? record.recoveryStartedAt;
    const required = counts.reverted > 0;
    const reconciled = await db.sheetSyncRun.findFirst({
        where: { kind: RUN_KIND.RECONCILE, status: RUN_STATUS.SUCCEEDED, dryRun: false, startedAt: { gte: since } }, orderBy: { startedAt: "desc" }, select: { runId: true },
    });
    const sheetDone = !required || (sheet.pendingApprovals === 0 && Boolean(reconciled));
    const result = { ...counts, sheet: { ...sheet, reconciled: sheetDone, reconciledByRunId: reconciled?.runId ?? null } };

    if (!sheetDone) {
        const active = await db.sheetSyncRun.findFirst({ where: { kind: RUN_KIND.RECONCILE, status: { in: [RUN_STATUS.QUEUED, RUN_STATUS.RUNNING] } }, orderBy: { createdAt: "desc" }, select: { runId: true, createdAt: true } });
        if (active) {
            if (now().getTime() - new Date(active.createdAt).getTime() > config.sheetRunStaleMs) return recorder.fail(record, RECOVERY_ERROR.SHEET_RUN_STUCK, result);
            return recorder.wait(record, config.waitMs, result);
        }
        // A run that started after the rollback and still did not reconcile it (failed, skipped, a dry run, approvals
        // left): a failed attempt. The first request is not.
        const finishedSince = await db.sheetSyncRun.findFirst({ where: { kind: RUN_KIND.RECONCILE, startedAt: { gte: since }, finishedAt: { not: null } }, select: { runId: true, status: true } });
        const { run } = await requestSheetSyncRun({ db, kind: RUN_KIND.RECONCILE, triggerSource: RUN_TRIGGER.SCHEDULER, requestedBy: record.adminId, now: now() });
        const requested = { ...result, sheetRunsRequested: (record.recoveryResult?.sheetRunsRequested ?? 0) + 1, lastSheetRunId: run.runId };
        recorder.emit("info", "recovery_sheet_requested", { importId: record.importId, runId: run.runId, pendingApprovals: sheet.pendingApprovals });
        if (finishedSince) return recorder.fail(record, RECOVERY_ERROR.SHEET_INCOMPLETE, { ...requested, lastSheetRunStatus: finishedSince.status });
        return recorder.wait(record, config.waitMs, requested);
    }
    // The Sheet is reconciled. Entries kept as conflicts: never reported clean, an administrator decides.
    if (counts.conflicts) return recorder.attention(record, RECOVERY_ERROR.ROLLBACK_CONFLICTS, { next: new Date(now().getTime() + config.attentionRecheckMs), result });
    return recorder.complete(record, result);
}

// ---------------------------------------------------------------- one run

// One scheduled run: detect, claim, adopt, then work on what is due until the time budget is used. Safe to run several
// at once (row locks, SKIP LOCKED, the rollback's own lease). Returns counts and ids only.
export async function runImportRecovery({ db, keyring, config = RECOVERY_DEFAULTS, log = console, clock = () => new Date() } = {}) {
    const startedAt = clock().getTime();
    const [{ dbNow }] = await db.$queryRaw`SELECT now() AS "dbNow"`;
    // Database time, advanced by the elapsed process time: what every stored instant is compared with.
    const now = () => new Date(new Date(dbNow).getTime() + (clock().getTime() - startedAt));
    const remaining = () => config.timeBudgetMs - (clock().getTime() - startedAt);
    const recorder = createRecorder(db, { config, log, now });
    const keys = keyringFor(keyring);

    const claimed = await claimAbandoned(db, config);
    const adopted = await adoptInterruptedRollbacks(db, config);
    for (const importId of claimed) recorder.emit("warn", "recovery_claimed", { importId, reason: RECOVERY_REASON.ABANDONED_COMMIT });
    for (const importId of adopted) recorder.emit("warn", "recovery_claimed", { importId, reason: RECOVERY_REASON.ROLLBACK_INTERRUPTED });

    const summary = { claimed, adopted, worked: [], keyAvailable: Boolean(keys), budgetExhausted: false };
    const due = await db.candidateImport.findMany({
        where: { recoveryStatus: { in: [RECOVERY_STATUS.ROLLING_BACK, RECOVERY_STATUS.SHEET_PENDING, RECOVERY_STATUS.NEEDS_ATTENTION] }, recoveryNextAttemptAt: { lte: now() } },
        orderBy: { recoveryNextAttemptAt: "asc" }, take: config.workLimit,
    });
    for (const candidate of due) {
        if (remaining() < config.minStepMs) { summary.budgetExhausted = true; break; }
        let record = candidate;
        let outcome;
        try {
            if (record.status === IMPORT_STATUS.ROLLING_BACK || record.recoveryStatus === RECOVERY_STATUS.ROLLING_BACK) {
                outcome = await stepRollback(db, record, { keyring: keys, recorder, remainingMs: remaining() - config.minStepMs / 2, clock });
                record = await db.candidateImport.findUnique({ where: { importId: record.importId } });
                // Finished the database part with time left: confirm the Sheet at once.
                if (record.recoveryStatus === RECOVERY_STATUS.SHEET_PENDING && remaining() >= config.minStepMs) outcome = await stepVerify(db, record, { recorder, config, now });
            } else if (record.status === IMPORT_STATUS.ROLLED_BACK || record.status === IMPORT_STATUS.ROLLED_BACK_WITH_CONFLICTS) {
                outcome = await stepVerify(db, record, { recorder, config, now });
            } else {
                outcome = await recorder.attention(record, RECOVERY_ERROR.UNEXPECTED_STATE, { result: { status: record.status } });
            }
        } catch (error) {
            // Never silently dropped: counted and retried, alerted after the limit.
            outcome = await recorder.fail(record, safeCode(error)).catch(() => "FAILED");
        }
        summary.worked.push({ importId: record.importId, outcome });
    }
    return summary;
}

// ---------------------------------------------------------------- monitoring (administrators)

// What is being recovered, what needs attention, and the imports committing now (a COMMITTING import that predates
// the commit lease is never recovered automatically: listed as untracked). Counts, states and codes only.
export async function listImportRecoveries({ db, config = RECOVERY_DEFAULTS, limit = 50 }) {
    const [[{ dbNow }], records] = await Promise.all([
        db.$queryRaw`SELECT now() AS "dbNow"`,
        db.candidateImport.findMany({
            where: { OR: [{ recoveryStatus: { not: null } }, { status: IMPORT_STATUS.COMMITTING }] },
            orderBy: { updatedAt: "desc" }, take: limit,
            select: {
                importId: true, adminId: true, fileName: true, status: true, totalRows: true, createdAt: true, updatedAt: true, heartbeatAt: true, commitLeaseExpiresAt: true,
                recoveryStatus: true, recoveryReason: true, recoveryAttempts: true, recoveryStartedAt: true, recoveryCompletedAt: true, recoveryNextAttemptAt: true,
                recoveryNotifiedAt: true, recoveryLastError: true, recoveryResult: true, rollbackCompletedAt: true,
            },
        }),
    ]);
    const ids = records.map((r) => r.importId);
    const [ledger, approvals] = ids.length
        ? await Promise.all([
            db.candidateImportChange.groupBy({ by: ["importId", "status"], where: { importId: { in: ids } }, _count: { _all: true } }),
            db.sheetSyncDeletionApproval.groupBy({ by: ["importId"], where: { importId: { in: ids }, consumedAt: null }, _count: { _all: true } }),
        ])
        : [[], []];
    const now = new Date(dbNow).getTime();
    const items = records.map((r) => {
        const n = (status) => ledger.find((g) => g.importId === r.importId && g.status === status)?._count._all ?? 0;
        const pendingApprovals = approvals.find((g) => g.importId === r.importId)?._count._all ?? 0;
        const tracked = Boolean(r.commitLeaseExpiresAt) || Boolean(r.recoveryStatus);
        const leaseExpired = r.commitLeaseExpiresAt ? new Date(r.commitLeaseExpiresAt).getTime() < now : null;
        return {
            importId: r.importId, adminId: r.adminId, fileName: r.fileName, status: r.status, totalRows: r.totalRows, createdAt: r.createdAt, updatedAt: r.updatedAt,
            lastHeartbeatAt: r.heartbeatAt, commitLeaseExpiresAt: r.commitLeaseExpiresAt, leaseExpired, tracked,
            recovery: r.recoveryStatus
                ? { status: r.recoveryStatus, reason: r.recoveryReason, attempts: r.recoveryAttempts, lastError: r.recoveryLastError, startedAt: r.recoveryStartedAt, completedAt: r.recoveryCompletedAt, nextAttemptAt: r.recoveryNextAttemptAt, notifiedAt: r.recoveryNotifiedAt, sheetRunsRequested: r.recoveryResult?.sheetRunsRequested ?? 0 }
                : null,
            changes: { reverted: n(LEDGER_STATUS.REVERTED), conflicts: n(LEDGER_STATUS.CONFLICT), skipped: n(LEDGER_STATUS.SKIPPED), remaining: n(LEDGER_STATUS.APPLIED) },
            sheet: { pendingApprovals, reconciled: r.recoveryStatus === RECOVERY_STATUS.COMPLETED || Boolean(r.recoveryResult?.sheet?.reconciled) },
            // An administrator must act: the recovery says so, or an old COMMITTING import (no lease) has stopped.
            needsAttention: r.recoveryStatus === RECOVERY_STATUS.NEEDS_ATTENTION
                || (r.status === IMPORT_STATUS.COMMITTING && !tracked && now - new Date(r.updatedAt).getTime() > config.maxIdleMs),
        };
    });
    const count = (predicate) => items.filter(predicate).length;
    return {
        summary: {
            inRecovery: count((i) => i.recovery && i.recovery.status !== RECOVERY_STATUS.COMPLETED),
            rollingBack: count((i) => i.recovery?.status === RECOVERY_STATUS.ROLLING_BACK),
            sheetPending: count((i) => i.recovery?.status === RECOVERY_STATUS.SHEET_PENDING),
            needsAttention: count((i) => i.needsAttention),
            completed: count((i) => i.recovery?.status === RECOVERY_STATUS.COMPLETED),
            committing: count((i) => i.status === IMPORT_STATUS.COMMITTING),
            untrackedCommitting: count((i) => i.status === IMPORT_STATUS.COMMITTING && !i.tracked),
        },
        items,
        checkedAt: new Date(dbNow).toISOString(),
    };
}
