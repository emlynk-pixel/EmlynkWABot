// Google Sheet operational mirror: the durable PostgreSQL side (Phase 3/4).
// (Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md, Sections 8.2-8.5, 9.5, 11.5.)
//
//   queue  sheet_sync_queue  "candidate X needs synchronization" (rows are
//          written by database triggers, see migration
//          20261006120000_sheet_sync_outbox; this module claims and settles them)
//   runs   sheet_sync_runs   durable RECONCILE / TEST_CONNECTION requests
//   state  sheet_sync_state  one row: integration state, worker heartbeat,
//          and the WRITER LEASE (one process writes to the Sheet at a time)
//
// Every claim is a compare-and-swap (same pattern as submissionQueue.js): a
// row is claimed only if it is still in the state it was read in, so two
// workers never own the same item. A claim is a lease; when the process dies
// the lease runs out and the item is claimed again. Every settlement is
// fenced on the claim (status, lease owner, attempt number): a worker that
// lost its claim changes nothing.
//
// Only codes and counts are stored (error class, HTTP status / Google status
// code, action names): never candidate data, Google message text or tokens.
// Nothing here calls Google.

import { randomUUID } from "node:crypto";

export const QUEUE_STATUS = Object.freeze({ PENDING: "PENDING", PROCESSING: "PROCESSING", COMPLETED: "COMPLETED", FAILED: "FAILED" });
export const RUN_KIND = Object.freeze({ RECONCILE: "RECONCILE", TEST_CONNECTION: "TEST_CONNECTION" });
export const RUN_TRIGGER = Object.freeze({ ADMIN: "ADMIN", SCHEDULER: "SCHEDULER", OPERATOR: "OPERATOR" });
export const RUN_STATUS = Object.freeze({ QUEUED: "QUEUED", RUNNING: "RUNNING", SUCCEEDED: "SUCCEEDED", FAILED: "FAILED", SKIPPED: "SKIPPED" });
export const INTEGRATION_STATE = Object.freeze({ UNKNOWN: "UNKNOWN", OK: "OK", CONFIG_ERROR: "CONFIG_ERROR", DATA_INTEGRITY: "DATA_INTEGRITY" });

export const STATE_ID = "sheet-sync";
const ACTIVE_RUN_STATUSES = [RUN_STATUS.QUEUED, RUN_STATUS.RUNNING];

const later = (now, ms) => new Date(now.getTime() + ms);
const isUniqueViolation = (error) => error?.code === "P2002";
const maxDate = (a, b) => (a.getTime() >= b.getTime() ? a : b);

// Bounded exponential backoff with jitter: base * 4^(attempt-1), capped,
// +/- 20 %. attempt is 1-based. random: () => [0, 1).
export const BACKOFF = Object.freeze({ baseMs: 15_000, factor: 4, capMs: 15 * 60_000, jitter: 0.2 });
export function backoffDelayMs(attempt, { random = Math.random, ...options } = {}) {
    const { baseMs, factor, capMs, jitter } = { ...BACKOFF, ...options };
    const raw = Math.min(capMs, baseMs * factor ** Math.max(0, attempt - 1));
    return Math.round(raw * (1 - jitter + 2 * jitter * random()));
}

export function createSheetSyncStore({ db } = {}) {
    if (!db?.sheetSyncQueue || !db?.sheetSyncRun || !db?.sheetSyncState) throw new Error("A database client with the sheet sync tables is required");

    // ------------------------------------------------------------ queue

    // Up to `limit` due items (PENDING whose next attempt is due, or
    // PROCESSING whose lease ran out), claimed for `owner`. attempts counts
    // claims, so an item that crashes the worker every time still reaches
    // the dead letter.
    // onlyUniqueIds (the first-write pilot): claim only these candidates.
    async function claimQueueBatch({ owner, now, leaseMs, limit, onlyUniqueIds = null }) {
        const due = await db.sheetSyncQueue.findMany({
            where: {
                ...(onlyUniqueIds ? { uniqueId: { in: [...onlyUniqueIds] } } : {}),
                OR: [
                    { status: QUEUE_STATUS.PENDING, nextAttemptAt: { lte: now } },
                    { status: QUEUE_STATUS.PROCESSING, leaseExpiresAt: { lt: now } },
                ],
            },
            orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
            take: limit,
        });
        const claimed = [];
        for (const row of due) {
            const data = { status: QUEUE_STATUS.PROCESSING, leaseOwner: owner, leaseExpiresAt: later(now, leaseMs), attempts: row.attempts + 1, updatedAt: now };
            const { count } = await db.sheetSyncQueue.updateMany({
                where: { queueId: row.queueId, status: row.status, attempts: row.attempts },
                data,
            });
            if (count === 1) claimed.push({ ...row, ...data });
        }
        return claimed;
    }

    const ownedBy = (row) => ({ queueId: row.queueId, status: QUEUE_STATUS.PROCESSING, leaseOwner: row.leaseOwner, attempts: row.attempts });

    // Done. Earlier dead-lettered rows of the same candidate are resolved
    // too: the Sheet now holds this candidate's current state.
    async function completeQueueItem(row, { result, now }) {
        const { count } = await db.sheetSyncQueue.updateMany({
            where: ownedBy(row),
            data: { status: QUEUE_STATUS.COMPLETED, lastResult: result, completedAt: now, updatedAt: now, leaseOwner: null, leaseExpiresAt: null, lastErrorClass: null, lastErrorCode: null },
        });
        if (count === 1) {
            await db.sheetSyncQueue.updateMany({
                where: { uniqueId: row.uniqueId, status: QUEUE_STATUS.FAILED },
                data: { status: QUEUE_STATUS.COMPLETED, lastResult: "RESOLVED", completedAt: now, updatedAt: now },
            });
        }
        return count === 1;
    }

    // Dead letter: no more automatic attempts; the next successful sync of
    // the candidate, or a reconciliation, resolves it.
    async function failQueueItem(row, { errorClass, errorCode = null, now }) {
        const { count } = await db.sheetSyncQueue.updateMany({
            where: ownedBy(row),
            data: { status: QUEUE_STATUS.FAILED, lastErrorClass: errorClass, lastErrorCode: errorCode, updatedAt: now, leaseOwner: null, leaseExpiresAt: null },
        });
        return count === 1;
    }

    // Back to PENDING at nextAttemptAt. countAttempt=false (configuration
    // halt, shutdown) gives the claim back without using up an attempt.
    // If the candidate already has a newer PENDING row (a change arrived
    // meanwhile), this row is settled SUPERSEDED and the pending row inherits
    // the later retry time and the higher attempt count, so the backoff and
    // the attempt bound still hold.
    async function retryQueueItem(row, { nextAttemptAt, errorClass = null, errorCode = null, countAttempt = true, now }) {
        const attempts = countAttempt ? row.attempts : Math.max(0, row.attempts - 1);
        for (let tries = 0; tries < 3; tries++) {
            try {
                return await db.$transaction(async (tx) => {
                    const pending = await tx.sheetSyncQueue.findFirst({ where: { uniqueId: row.uniqueId, status: QUEUE_STATUS.PENDING } });
                    if (pending) {
                        const { count } = await tx.sheetSyncQueue.updateMany({
                            where: ownedBy(row),
                            data: { status: QUEUE_STATUS.COMPLETED, lastResult: "SUPERSEDED", completedAt: now, updatedAt: now, leaseOwner: null, leaseExpiresAt: null },
                        });
                        if (count !== 1) return false;
                        await tx.sheetSyncQueue.update({
                            where: { queueId: pending.queueId },
                            data: {
                                nextAttemptAt: maxDate(pending.nextAttemptAt, nextAttemptAt),
                                attempts: Math.max(pending.attempts, attempts),
                                candidateDeleted: pending.candidateDeleted || row.candidateDeleted,
                                lastErrorClass: errorClass, lastErrorCode: errorCode, updatedAt: now,
                            },
                        });
                        return true;
                    }
                    const { count } = await tx.sheetSyncQueue.updateMany({
                        where: ownedBy(row),
                        data: { status: QUEUE_STATUS.PENDING, attempts, nextAttemptAt, lastErrorClass: errorClass, lastErrorCode: errorCode, updatedAt: now, leaseOwner: null, leaseExpiresAt: null },
                    });
                    return count === 1;
                });
            } catch (error) {
                // A trigger inserted a PENDING row between the check and the
                // update: run again, the first branch then applies.
                if (!isUniqueViolation(error)) throw error;
            }
        }
        return false;
    }

    async function queueCounts() {
        const [pending, processing, failed] = await Promise.all(
            [QUEUE_STATUS.PENDING, QUEUE_STATUS.PROCESSING, QUEUE_STATUS.FAILED].map((status) => db.sheetSyncQueue.count({ where: { status } })),
        );
        return { pending, processing, failed };
    }

    // A completed write reconciliation repaired everything that had failed
    // before it started.
    async function resolveFailedBefore(before, now) {
        const { count } = await db.sheetSyncQueue.updateMany({
            where: { status: QUEUE_STATUS.FAILED, updatedAt: { lt: before } },
            data: { status: QUEUE_STATUS.COMPLETED, lastResult: "RESOLVED", completedAt: now, updatedAt: now },
        });
        return count;
    }

    async function pruneCompleted(before) {
        const { count } = await db.sheetSyncQueue.deleteMany({ where: { status: QUEUE_STATUS.COMPLETED, completedAt: { lt: before } } });
        return count;
    }

    // ------------------------------------------------------------ runs

    // A new QUEUED run, or the kind's active (QUEUED/RUNNING) run if there is
    // one already: { run, created }. The partial unique index makes this
    // safe against concurrent requests.
    async function requestRun({ kind, triggerSource, requestedBy = null, now = new Date() }) {
        if (!Object.values(RUN_KIND).includes(kind)) throw new Error("Unknown run kind");
        if (!Object.values(RUN_TRIGGER).includes(triggerSource)) throw new Error("Unknown run trigger");
        for (let tries = 0; tries < 3; tries++) {
            const active = await db.sheetSyncRun.findFirst({ where: { kind, status: { in: ACTIVE_RUN_STATUSES } }, orderBy: { createdAt: "asc" } });
            if (active) return { run: active, created: false };
            try {
                const run = await db.sheetSyncRun.create({ data: { runId: randomUUID(), kind, triggerSource, requestedBy, status: RUN_STATUS.QUEUED, createdAt: now, updatedAt: now } });
                return { run, created: true };
            } catch (error) {
                if (!isUniqueViolation(error)) throw error;
            }
        }
        throw new Error("The run request could not be recorded");
    }

    // The oldest QUEUED run (TEST_CONNECTION before RECONCILE: it is quick),
    // or a RUNNING one whose lease ran out (its worker died; reconciliation
    // is idempotent, so it is simply run again). A run abandoned
    // `maxAttempts` times is recorded FAILED instead.
    async function claimRun({ owner, now, leaseMs, maxAttempts }) {
        const candidates = await db.sheetSyncRun.findMany({
            where: { OR: [{ status: RUN_STATUS.QUEUED }, { status: RUN_STATUS.RUNNING, leaseExpiresAt: { lt: now } }] },
            orderBy: [{ kind: "desc" }, { createdAt: "asc" }],
            take: 5,
        });
        for (const run of candidates) {
            const where = { runId: run.runId, status: run.status, attempts: run.attempts };
            if (run.attempts >= maxAttempts) {
                await db.sheetSyncRun.updateMany({ where, data: { status: RUN_STATUS.FAILED, errorClass: "RUN_ABANDONED", finishedAt: now, updatedAt: now, leaseOwner: null, leaseExpiresAt: null } });
                continue;
            }
            const data = { status: RUN_STATUS.RUNNING, attempts: run.attempts + 1, leaseOwner: owner, leaseExpiresAt: later(now, leaseMs), startedAt: run.startedAt ?? now, updatedAt: now };
            const { count } = await db.sheetSyncRun.updateMany({ where, data });
            if (count === 1) return { ...run, ...data };
        }
        return null;
    }

    const runOwnedBy = (run) => ({ runId: run.runId, status: RUN_STATUS.RUNNING, leaseOwner: run.leaseOwner, attempts: run.attempts });

    async function renewRun(run, { now, leaseMs }) {
        const { count } = await db.sheetSyncRun.updateMany({ where: runOwnedBy(run), data: { leaseExpiresAt: later(now, leaseMs), updatedAt: now } });
        return count === 1;
    }

    async function finishRun(run, { status, summary = null, errorClass = null, errorCode = null, dryRun = null, now }) {
        const { count } = await db.sheetSyncRun.updateMany({
            where: runOwnedBy(run),
            data: { status, summary, errorClass, errorCode, dryRun, finishedAt: now, updatedAt: now, leaseOwner: null, leaseExpiresAt: null },
        });
        return count === 1;
    }

    const getRun = (runId) => db.sheetSyncRun.findUnique({ where: { runId } });

    const latestRun = (kind, where = {}) => db.sheetSyncRun.findFirst({ where: { kind, ...where }, orderBy: { createdAt: "desc" } });

    // ------------------------------------------------------------ state

    const getState = () => db.sheetSyncState.findUnique({ where: { stateId: STATE_ID } });

    // The writer lease: free, expired, or already ours -> ours until now+leaseMs.
    async function acquireWriterLease({ owner, now, leaseMs }) {
        const { count } = await db.sheetSyncState.updateMany({
            where: {
                stateId: STATE_ID,
                OR: [{ writerLeaseOwner: null }, { writerLeaseExpiresAt: { lt: now } }, { writerLeaseOwner: owner }],
            },
            data: { writerLeaseOwner: owner, writerLeaseExpiresAt: later(now, leaseMs) },
        });
        return count === 1;
    }

    async function releaseWriterLease({ owner }) {
        await db.sheetSyncState.updateMany({ where: { stateId: STATE_ID, writerLeaseOwner: owner }, data: { writerLeaseOwner: null, writerLeaseExpiresAt: null } });
    }

    async function heartbeat({ writeGate, configured, targetHint, now }) {
        await db.sheetSyncState.updateMany({ where: { stateId: STATE_ID }, data: { writeGate, configured, targetHint, workerHeartbeatAt: now, updatedAt: now } });
    }

    async function setIntegrationState({ state, errorClass = null, errorCode = null, now }) {
        const data = { integrationState: state, updatedAt: now };
        if (state === INTEGRATION_STATE.OK) Object.assign(data, { lastErrorClass: null, lastErrorCode: null });
        else Object.assign(data, { lastErrorClass: errorClass, lastErrorCode: errorCode, lastErrorAt: now });
        await db.sheetSyncState.updateMany({ where: { stateId: STATE_ID }, data });
    }

    // A transient failure: shown in Settings, but the integration stays usable.
    async function recordTransientError({ errorClass, errorCode = null, now }) {
        await db.sheetSyncState.updateMany({ where: { stateId: STATE_ID }, data: { lastErrorClass: errorClass, lastErrorCode: errorCode, lastErrorAt: now, updatedAt: now } });
    }

    async function recordSyncSuccess({ now }) {
        await db.sheetSyncState.updateMany({ where: { stateId: STATE_ID }, data: { lastSyncSuccessAt: now, updatedAt: now } });
    }

    return Object.freeze({
        claimQueueBatch, completeQueueItem, failQueueItem, retryQueueItem, queueCounts, resolveFailedBefore, pruneCompleted,
        requestRun, claimRun, renewRun, finishRun, getRun, latestRun,
        getState, acquireWriterLease, releaseWriterLease, heartbeat, setIntegrationState, recordTransientError, recordSyncSuccess,
    });
}
