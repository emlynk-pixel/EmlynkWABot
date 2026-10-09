// Google Sheet operational mirror: the background WORKER (Phase 3/4).
// (Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md, Sections 8.5-8.7, 9, 11.5.)
//
// Runs only in the dedicated sheet-sync process (src/sheetSyncWorker.js, the
// Cloud Run service emlynk-sheet-sync-worker). Never on Vercel, never in the
// browser: closing the Admin Console changes nothing here.
//
// One sequential loop per process. Each tick:
//   1. heartbeat: write gate / configured / target hint into sheet_sync_state
//      (the Admin status page reads it from there);
//   2. at most one durable run (sheet_sync_runs): TEST_CONNECTION (the
//      read-only health check) or RECONCILE (full reconciliation; a dry run
//      while SHEET_SYNC_ENABLED is off);
//   3. one incremental batch from sheet_sync_queue, only while writes are
//      enabled and the integration is not halted (during the first-write
//      pilot, SHEET_SYNC_PILOT_CANDIDATE_IDS, only those candidates, and
//      reconciliations are dry runs);
//   4. now and then: prune old completed queue rows.
// Google writes happen only while holding the writer lease (one writer per
// Sheet, whatever the number of processes).
//
// Failures (classifySyncError):
//   CONFIG          schema mismatch, access denied, sheet/tab not found, bad
//                   request: the integration is HALTED (CONFIG_ERROR); queue
//                   items go back to PENDING without using an attempt; the
//                   worker re-checks the Sheet read-only every
//                   CONFIG_RECHECK_MS and resumes when it is fine (or after a
//                   successful Test Connection / reconciliation).
//   DATA_INTEGRITY  duplicate candidate IDs in column AO: halted the same way;
//                   nothing is written until a person fixes the Sheet.
//   RETRYABLE       429, 5xx, network: bounded exponential backoff, then the
//   / other         item is dead-lettered (FAILED); reconciliation heals it.
// A candidate database write never depends on any of this: the triggers
// only queue work, and this process runs elsewhere.
//
// Logs: one JSON object per line, event names sheet_sync.*, with run IDs,
// candidate unique IDs (opaque internal IDs), actions, counts and error
// codes only. Never names, passport numbers, NICs, phone numbers, cell
// values, Google message text or tokens.

import os from "node:os";
import { randomUUID } from "node:crypto";

import { SheetSchemaMismatchError, SheetSyncDisabledError, SheetsAdapterError, SHEETS_ERROR_CLASS } from "./googleSheetsAdapter.js";
import { SheetDuplicateCandidateIdError } from "./sheetSyncPlanner.js";
import { IncompleteSnapshotError } from "./candidateAggregateReader.js";
import { ENGINE_ACTION } from "./sheetSyncEngine.js";
import { INTEGRATION_STATE, RUN_KIND, RUN_STATUS, backoffDelayMs } from "./sheetSyncStore.js";

export const WORKER_TIMINGS = Object.freeze({
    queueLeaseMs: 2 * 60_000,
    runLeaseMs: 10 * 60_000,
    writerLeaseMs: 2 * 60_000,
    runMaxAttempts: 3,
    configRecheckMs: 5 * 60_000,
    pruneEveryMs: 60 * 60_000,
    completedRetentionMs: 7 * 24 * 60 * 60_000,
});

export class WriterLeaseLostError extends Error {
    constructor() {
        super("The Sheet writer lease was lost");
        this.name = "WriterLeaseLostError";
    }
}

const SAFE_CODE = /^[A-Za-z_]{1,40}$/;

function googleCode(error) {
    const parts = [];
    if (Number.isInteger(error.status)) parts.push(String(error.status));
    for (const value of [error.googleStatus, error.reason]) {
        if (typeof value === "string" && SAFE_CODE.test(value) && !parts.includes(value)) parts.push(value);
    }
    return parts.join("/") || null;
}

// An error -> { kind, errorClass, errorCode }: codes only, never messages.
//   kind: CONFIG | DATA_INTEGRITY | RETRYABLE | PERMANENT | DISABLED | INTERNAL
export function classifySyncError(error) {
    if (error instanceof SheetSchemaMismatchError) {
        return { kind: "CONFIG", errorClass: "SCHEMA_INVALID", errorCode: (error.mismatches ?? []).map((m) => m.column).join(",").slice(0, 120) || null };
    }
    if (error instanceof SheetDuplicateCandidateIdError) {
        return { kind: "DATA_INTEGRITY", errorClass: "DUPLICATE_CANDIDATE_ID", errorCode: String(error.duplicates?.length ?? 0) };
    }
    if (error instanceof SheetSyncDisabledError) return { kind: "DISABLED", errorClass: "WRITES_DISABLED", errorCode: null };
    if (error instanceof IncompleteSnapshotError) return { kind: "RETRYABLE", errorClass: "SNAPSHOT_INCOMPLETE", errorCode: null };
    if (error instanceof SheetsAdapterError) {
        const errorCode = googleCode(error);
        if (error.errorClass === SHEETS_ERROR_CLASS.RETRYABLE) return { kind: "RETRYABLE", errorClass: "GOOGLE_UNAVAILABLE", errorCode };
        if (error.status === 401 || error.status === 403) return { kind: "CONFIG", errorClass: "ACCESS_DENIED", errorCode };
        if (error.status === 404) return { kind: "CONFIG", errorClass: "NOT_FOUND", errorCode };
        if (error.status === 400) return { kind: "CONFIG", errorClass: "BAD_REQUEST", errorCode };
        // No HTTP response and not a network error: typically no usable
        // credentials (ADC). Treated as configuration, so it isn't hammered.
        if (error.status === null) return { kind: "CONFIG", errorClass: "GOOGLE_REQUEST_FAILED", errorCode };
        return { kind: "PERMANENT", errorClass: "GOOGLE_ERROR", errorCode };
    }
    return { kind: "INTERNAL", errorClass: "INTERNAL", errorCode: typeof error?.code === "string" && /^[A-Z0-9_]{1,20}$/.test(error.code) ? error.code : null };
}

const HALTED = new Set([INTEGRATION_STATE.CONFIG_ERROR, INTEGRATION_STATE.DATA_INTEGRITY]);
const haltState = (kind) => (kind === "DATA_INTEGRITY" ? INTEGRATION_STATE.DATA_INTEGRITY : INTEGRATION_STATE.CONFIG_ERROR);

// store: createSheetSyncStore(...); engine: createSheetSyncEngine(...) (its
// Sheets adapter was built from the same `config`); healthCheck: () => the
// read-only check's result (runSheetHealthCheck); config:
// readSheetSyncConfig(); tuning: readSheetSyncTuning(); targetHint: string.
export function createSheetSyncWorker({
    store, engine, healthCheck, config, tuning, targetHint = null,
    clock = () => new Date(), log = console, owner = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    timings = WORKER_TIMINGS, random = Math.random,
} = {}) {
    if (!store || !engine || !healthCheck || !config || !tuning) throw new Error("store, engine, healthCheck, config and tuning are required");
    const configured = Boolean(config.spreadsheetId && config.tabName);
    let lastRecheckAt = 0;
    let lastPruneAt = 0;
    let pausedLogged = false;

    const emit = (level, event, fields = {}) => {
        const line = JSON.stringify({ event, ...fields });
        (level === "error" ? log.error : level === "warn" ? (log.warn ?? log.log) : log.log).call(log, line);
    };

    async function withWriterLease(work) {
        const now = clock();
        if (!(await store.acquireWriterLease({ owner, now, leaseMs: timings.writerLeaseMs }))) return { busy: true };
        try {
            return { busy: false, value: await work() };
        } finally {
            await store.releaseWriterLease({ owner }).catch(() => {});
        }
    }

    const renewWriterLease = async () => {
        if (!(await store.acquireWriterLease({ owner, now: clock(), leaseMs: timings.writerLeaseMs }))) throw new WriterLeaseLostError();
    };

    async function recordFailure(classified) {
        const now = clock();
        if (classified.kind === "CONFIG" || classified.kind === "DATA_INTEGRITY") {
            await store.setIntegrationState({ state: haltState(classified.kind), errorClass: classified.errorClass, errorCode: classified.errorCode, now });
            lastRecheckAt = now.getTime();
            emit("error", classified.kind === "CONFIG" ? "sheet_sync.config_error" : "sheet_sync.duplicate_key_detected", { errorClass: classified.errorClass, errorCode: classified.errorCode });
        } else if (classified.kind !== "DISABLED") {
            await store.recordTransientError({ errorClass: classified.errorClass, errorCode: classified.errorCode, now });
        }
    }

    // ------------------------------------------------------------ runs

    async function runTestConnection(run) {
        const result = await healthCheck();
        const summary = {
            status: result.status, schema: result.schema, mismatchedColumns: result.mismatchedColumns ?? [],
            httpStatus: result.httpStatus ?? null, reason: result.reason ?? null, googleStatus: result.googleStatus ?? null, writeGate: config.gate,
        };
        const now = clock();
        await store.finishRun(run, { status: result.ok ? RUN_STATUS.SUCCEEDED : RUN_STATUS.FAILED, summary, errorClass: result.ok ? null : result.status, now });
        const state = await store.getState();
        if (result.ok && state?.integrationState !== INTEGRATION_STATE.DATA_INTEGRITY) {
            await store.setIntegrationState({ state: INTEGRATION_STATE.OK, now });
        } else if (!result.ok && result.status !== "UNAVAILABLE") {
            await store.setIntegrationState({ state: INTEGRATION_STATE.CONFIG_ERROR, errorClass: result.schema === "SCHEMA_INVALID" ? "SCHEMA_INVALID" : result.status, errorCode: result.httpStatus ? String(result.httpStatus) : null, now });
        }
        emit(result.ok ? "info" : "warn", "sheet_sync.connection_test", { runId: run.runId, status: result.status, schema: result.schema, httpStatus: summary.httpStatus, googleStatus: summary.googleStatus });
    }

    async function runReconcile(run) {
        const startedAt = clock();
        if (!configured) {
            await store.finishRun(run, { status: RUN_STATUS.FAILED, errorClass: "NOT_CONFIGURED", now: startedAt });
            return;
        }
        // During the first-write pilot a reconciliation never writes.
        const dryRun = config.enabled !== true || Boolean(tuning.pilotCandidateIds);
        emit("info", "sheet_sync.reconcile_started", { runId: run.runId, trigger: run.triggerSource, dryRun, pilot: Boolean(tuning.pilotCandidateIds) });
        const execute = () => engine.reconcile({
            dryRun,
            guard: { max: tuning.deletionGuardMax, fraction: tuning.deletionGuardFraction },
            beforeWrite: async () => {
                await renewWriterLease();
                if (!(await store.renewRun(run, { now: clock(), leaseMs: timings.runLeaseMs }))) throw new WriterLeaseLostError();
            },
        });
        try {
            const outcome = dryRun ? { busy: false, value: await execute() } : await withWriterLease(execute);
            const now = clock();
            if (outcome.busy) {
                await store.finishRun(run, { status: RUN_STATUS.SKIPPED, errorClass: "WRITER_BUSY", dryRun, now });
                emit("info", "sheet_sync.reconcile_skipped", { runId: run.runId, reason: "WRITER_BUSY" });
                return;
            }
            const summary = outcome.value;
            await store.finishRun(run, { status: RUN_STATUS.SUCCEEDED, summary, dryRun, now });
            await store.setIntegrationState({ state: INTEGRATION_STATE.OK, now });
            if (!dryRun) {
                await store.recordSyncSuccess({ now });
                await store.resolveFailedBefore(startedAt, now);
            }
            if (summary.deletionGuardTriggered) emit("warn", "sheet_sync.reconcile_deletion_guard", { runId: run.runId, wouldMarkInactive: summary.notInDatabase });
            emit("info", "sheet_sync.reconcile_completed", { runId: run.runId, dryRun, durationMs: now - startedAt, ...summary });
        } catch (error) {
            const classified = classifySyncError(error);
            await store.finishRun(run, { status: RUN_STATUS.FAILED, errorClass: classified.errorClass, errorCode: classified.errorCode, dryRun, now: clock() });
            await recordFailure(classified);
            emit("error", "sheet_sync.reconcile_failed", { runId: run.runId, errorClass: classified.errorClass, errorCode: classified.errorCode });
        }
    }

    async function processRun() {
        const run = await store.claimRun({ owner, now: clock(), leaseMs: timings.runLeaseMs, maxAttempts: timings.runMaxAttempts });
        if (!run) return null;
        try {
            if (run.kind === RUN_KIND.TEST_CONNECTION) await runTestConnection(run);
            else await runReconcile(run);
        } catch (error) {
            const classified = classifySyncError(error);
            await store.finishRun(run, { status: RUN_STATUS.FAILED, errorClass: classified.errorClass, errorCode: classified.errorCode, now: clock() }).catch(() => {});
            emit("error", "sheet_sync.run_failed", { runId: run.runId, kind: run.kind, errorClass: classified.errorClass });
        }
        return run.runId;
    }

    // ------------------------------------------------------------ incremental

    // Halted (CONFIG_ERROR / DATA_INTEGRITY): re-check read-only now and then.
    async function haltedStillHalted(state) {
        if (!HALTED.has(state?.integrationState)) return false;
        const now = clock();
        if (now.getTime() - lastRecheckAt < timings.configRecheckMs) return true;
        lastRecheckAt = now.getTime();
        try {
            await engine.checkTarget();
            await store.setIntegrationState({ state: INTEGRATION_STATE.OK, now: clock() });
            emit("info", "sheet_sync.resumed", { previousState: state.integrationState });
            return false;
        } catch (error) {
            await recordFailure(classifySyncError(error));
            return true;
        }
    }

    async function settle(items, results) {
        const now = clock();
        let wrote = false;
        for (const item of items) {
            const result = results.get(item.uniqueId);
            if (result?.action === ENGINE_ACTION.MAPPING_FAILED) {
                await store.failQueueItem(item, { errorClass: "MAPPING_FAILED", now });
                emit("error", "sheet_sync.failed", { candidateRef: item.uniqueId, errorClass: "MAPPING_FAILED", attempts: item.attempts });
                continue;
            }
            await store.completeQueueItem(item, { result: result?.action ?? ENGINE_ACTION.NOT_IN_DATABASE, now });
            if ([ENGINE_ACTION.APPENDED, ENGINE_ACTION.UPDATED, ENGINE_ACTION.MARKED_INACTIVE].includes(result?.action)) wrote = true;
        }
        if (wrote) await store.recordSyncSuccess({ now });
    }

    async function retryOrFail(items, classified) {
        const now = clock();
        for (const item of items) {
            if (classified.kind === "CONFIG" || classified.kind === "DATA_INTEGRITY" || classified.kind === "DISABLED") {
                // Not the item's fault: given back without using an attempt.
                await store.retryQueueItem(item, { nextAttemptAt: new Date(now.getTime() + timings.configRecheckMs), errorClass: classified.errorClass, errorCode: classified.errorCode, countAttempt: false, now });
            } else if (item.attempts >= tuning.maxAttempts) {
                await store.failQueueItem(item, { errorClass: classified.errorClass, errorCode: classified.errorCode, now });
                emit("error", "sheet_sync.failed", { candidateRef: item.uniqueId, errorClass: classified.errorClass, attempts: item.attempts });
            } else {
                const retryInMs = backoffDelayMs(item.attempts, { random });
                await store.retryQueueItem(item, { nextAttemptAt: new Date(now.getTime() + retryInMs), errorClass: classified.errorClass, errorCode: classified.errorCode, now });
                emit("warn", "sheet_sync.retry_scheduled", { candidateRef: item.uniqueId, attempt: item.attempts, errorClass: classified.errorClass, errorCode: classified.errorCode, retryInMs });
            }
        }
    }

    async function processQueue() {
        if (config.enabled !== true || !configured) {
            if (!pausedLogged) emit("info", "sheet_sync.incremental_paused", { reason: configured ? "WRITES_DISABLED" : "NOT_CONFIGURED" });
            pausedLogged = true;
            return 0;
        }
        pausedLogged = false;
        if (await haltedStillHalted(await store.getState())) return 0;

        const outcome = await withWriterLease(async () => {
            const items = await store.claimQueueBatch({ owner, now: clock(), leaseMs: timings.queueLeaseMs, limit: tuning.batchSize, onlyUniqueIds: tuning.pilotCandidateIds ?? null });
            if (!items.length) return 0;
            // Claimed more often than allowed (e.g. it crashed the worker
            // each time): dead-lettered without another attempt.
            const exhausted = items.filter((item) => item.attempts > tuning.maxAttempts);
            for (const item of exhausted) await store.failQueueItem(item, { errorClass: "ATTEMPTS_EXHAUSTED", now: clock() });
            const live = items.filter((item) => item.attempts <= tuning.maxAttempts);
            if (!live.length) return items.length;

            const byCandidate = new Map();
            for (const item of live) {
                const entry = byCandidate.get(item.uniqueId) ?? { uniqueId: item.uniqueId, candidateDeleted: false };
                entry.candidateDeleted ||= item.candidateDeleted;
                byCandidate.set(item.uniqueId, entry);
            }
            const startedAt = clock();
            emit("info", "sheet_sync.started", { batchSize: byCandidate.size });
            try {
                const results = await engine.syncCandidates([...byCandidate.values()], { beforeWrite: renewWriterLease });
                await settle(live, results);
                const counts = {};
                for (const { action } of results.values()) counts[action] = (counts[action] ?? 0) + 1;
                emit("info", "sheet_sync.completed", { batchSize: byCandidate.size, durationMs: clock() - startedAt, ...counts });
                const state = await store.getState();
                if (state?.integrationState !== INTEGRATION_STATE.OK) await store.setIntegrationState({ state: INTEGRATION_STATE.OK, now: clock() });
            } catch (error) {
                const classified = classifySyncError(error);
                await retryOrFail(live, classified);
                await recordFailure(classified);
            }
            return items.length;
        });
        return outcome.busy ? 0 : outcome.value;
    }

    // ------------------------------------------------------------ loop

    async function tick() {
        const now = clock();
        await store.heartbeat({ writeGate: config.gate, configured, targetHint, now });
        const runId = await processRun();
        const processed = await processQueue();
        if (now.getTime() - lastPruneAt >= timings.pruneEveryMs) {
            lastPruneAt = now.getTime();
            await store.pruneCompleted(new Date(now.getTime() - timings.completedRetentionMs));
        }
        return { runId, processed };
    }

    let stopped = false;
    let wake = null;
    let loopPromise = null;

    function start({ pollMs = tuning.pollIntervalMs } = {}) {
        if (loopPromise) return loopPromise;
        loopPromise = (async () => {
            while (!stopped) {
                let busy = false;
                try {
                    const result = await tick();
                    busy = Boolean(result.runId) || result.processed > 0;
                } catch (error) {
                    emit("error", "sheet_sync.tick_failed", classifySyncError(error));
                }
                if (stopped) break;
                // More work may be waiting: go again at once.
                if (busy) continue;
                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, pollMs);
                    wake = () => { clearTimeout(timer); resolve(); };
                });
                wake = null;
            }
        })();
        return loopPromise;
    }

    // The shutdown contract of src/shutdown.js. Work in progress may finish
    // within timeoutMs; otherwise its leases simply run out and the next
    // process takes it over (claims are fenced, writes idempotent).
    async function stop({ timeoutMs = Infinity } = {}) {
        stopped = true;
        wake?.();
        if (!loopPromise) return { finished: true, released: 0 };
        let timer;
        const finished = Number.isFinite(timeoutMs)
            ? await Promise.race([loopPromise.then(() => true), new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, timeoutMs), false); })])
            : await loopPromise.then(() => true);
        clearTimeout(timer);
        await store.releaseWriterLease({ owner }).catch(() => {});
        return { finished, released: 0 };
    }

    return Object.freeze({ tick, start, stop, owner });
}
