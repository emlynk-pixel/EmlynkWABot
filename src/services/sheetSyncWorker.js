// Google Sheet operational mirror: the background WORKER (Phase 3/4).
// (Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md, Sections 8.5-8.7, 9, 11.5.)
//
// Runs only in the dedicated sheet-sync process (src/sheetSyncWorker.js, the
// Cloud Run service emlynk-sheet-sync-worker). Never on Vercel, never in the
// browser: closing the Admin Console changes nothing here.
//
// There is NO real-time synchronization. A database change only records a
// queue row (sheet_sync_queue, by database triggers); the Sheet is written
// only by a full RECONCILE run, requested by Cloud Scheduler at 06:00, 12:00
// and 18:00 Asia/Colombo (POST /tasks/reconcile, SHEET_SYNC_SCHEDULE) or by
// an ADMIN's Sync Now. Each run mirrors the CURRENT database, so several
// changes between runs end up as the latest state, once.
//
// One sequential loop per process. Each tick:
//   1. heartbeat: write gate / configured / target hint into sheet_sync_state
//      (the Admin status page reads it from there);
//   2. at most one durable run (sheet_sync_runs): TEST_CONNECTION (the
//      read-only health check) or RECONCILE (full reconciliation; a dry run
//      while SHEET_SYNC_ENABLED is off; during the first-write pilot,
//      SHEET_SYNC_PILOT_CANDIDATE_IDS, it writes only those candidates).
//      A successful write reconciliation settles the queue rows it covered;
//   3. the Candidate Form submissions (formSubmissionSync.js): the due rows of their own outbox
//      go to their own tab, in real time (every tick), only while SHEET_SYNC_ENABLED is true.
//      Separate from the reconciliation: nothing in it reads or changes the mirror's queue,
//      runs or integration state, and a failure in it never fails or delays the above;
//   4. now and then: prune old completed queue rows.
// Google writes happen only while holding the writer lease (one writer per
// Sheet, whatever the number of processes).
//
// Sync Destination: every run resolves the ACTIVE destination when it starts
// (sheet_sync_state.active_destination_key; null = the first configured one)
// and records it on the run (destination_key). A writing reconciliation
// resolves it inside the writer lease, and a switch is applied only under the
// same lease, so the destination never changes in the middle of a run. A
// switch an ADMIN requested is a TEST_CONNECTION run carrying the requested
// destination: it checks that Sheet's access and headers, and only if both
// pass makes it active (with an audit entry); otherwise the active one stays.
//
// Failures (classifySyncError) fail the run with a code:
//   CONFIG          schema mismatch, access denied, sheet/tab not found, bad
//                   request: the integration is HALTED (CONFIG_ERROR) until a
//                   successful Test Connection or reconciliation.
//   DATA_INTEGRITY  duplicate candidate IDs in the _SYSTEM_CANDIDATE_ID
//                   column: halted the same way; nothing is written until a
//                   person fixes the Sheet.
//   RETRYABLE       429, 5xx, network: recorded; the next scheduled (or
//   / other         manual) run tries again with the then-current database.
// A candidate database write never depends on any of this: the triggers
// only record queue rows, and this process runs elsewhere.
//
// Logs: one JSON object per line, event names sheet_sync.*, with run IDs,
// candidate unique IDs (opaque internal IDs), actions, counts and error
// codes only. Never names, passport numbers, NICs, phone numbers, cell
// values, Google message text or tokens.

import os from "node:os";
import { randomUUID } from "node:crypto";

import { SheetLayoutChangedError, SheetSchemaMismatchError, SheetSyncDisabledError, SheetsAdapterError, SHEETS_ERROR_CLASS } from "./googleSheetsAdapter.js";
import { SheetDuplicateCandidateIdError } from "./sheetSyncPlanner.js";
import { IncompleteSnapshotError } from "./candidateAggregateReader.js";
import { INTEGRATION_STATE, RUN_KIND, RUN_STATUS } from "./sheetSyncStore.js";
import { DEFAULT_DESTINATION_KEY, publicDestination, resolveDestination, sheetTargetHint } from "../config/sheetSync.js";

export const WORKER_TIMINGS = Object.freeze({
    runLeaseMs: 10 * 60_000,
    writerLeaseMs: 2 * 60_000,
    runMaxAttempts: 3,
    pruneEveryMs: 60 * 60_000,
    completedRetentionMs: 7 * 24 * 60 * 60_000,
});

export class WriterLeaseLostError extends Error {
    constructor() {
        super("The Sheet writer lease was lost");
        this.name = "WriterLeaseLostError";
    }
}

// The active destination key names a destination that is no longer
// configured: nothing is synced until an ADMIN picks a configured one.
export class DestinationNotConfiguredError extends Error {
    constructor() {
        super("The active Google Sheet sync destination is not configured");
        this.name = "DestinationNotConfiguredError";
    }
}

export const SWITCH_PURPOSE = "DESTINATION_SWITCH";

const SAFE_CODE = /^[A-Za-z_]{1,40}$/;

function googleCode(error) {
    const parts = [];
    if (Number.isInteger(error.status)) parts.push(String(error.status));
    for (const value of [error.googleStatus, error.reason]) {
        if (typeof value === "string" && SAFE_CODE.test(value) && !parts.includes(value)) parts.push(value);
    }
    return parts.join("/") || null;
}

// "MISSING:VISA SUBMISSION STATUS,DUPLICATE:_SYSTEM_CANDIDATE_ID": which
// system headers are wrong (our own header names), for Settings.
export const schemaProblemCode = (mismatches) => (mismatches ?? []).map((m) => `${m.problem}:${m.header}`).join(",").slice(0, 120) || null;

// An error -> { kind, errorClass, errorCode }: codes only, never messages.
//   kind: CONFIG | DATA_INTEGRITY | RETRYABLE | PERMANENT | DISABLED | INTERNAL
export function classifySyncError(error) {
    if (error instanceof SheetSchemaMismatchError) {
        return { kind: "CONFIG", errorClass: "SCHEMA_INVALID", errorCode: schemaProblemCode(error.mismatches) };
    }
    // Row 1 changed during the run (columns moved/added): nothing was written;
    // the retry reads the new layout.
    if (error instanceof SheetLayoutChangedError) return { kind: "RETRYABLE", errorClass: "SHEET_LAYOUT_CHANGED", errorCode: null };
    if (error instanceof SheetDuplicateCandidateIdError) {
        return { kind: "DATA_INTEGRITY", errorClass: "DUPLICATE_CANDIDATE_ID", errorCode: String(error.duplicates?.length ?? 0) };
    }
    if (error instanceof SheetSyncDisabledError) return { kind: "DISABLED", errorClass: "WRITES_DISABLED", errorCode: null };
    if (error instanceof DestinationNotConfiguredError) return { kind: "CONFIG", errorClass: "DESTINATION_NOT_CONFIGURED", errorCode: null };
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

const haltState = (kind) => (kind === "DATA_INTEGRITY" ? INTEGRATION_STATE.DATA_INTEGRITY : INTEGRATION_STATE.CONFIG_ERROR);

// A test connection's failure as { errorClass, errorCode } (codes only).
function testFailure(result) {
    const schemaInvalid = result.schema === "SCHEMA_INVALID";
    return {
        errorClass: schemaInvalid ? "SCHEMA_INVALID" : result.status,
        errorCode: schemaInvalid
            ? schemaProblemCode([...(result.missingHeaders ?? []).map((header) => ({ problem: "MISSING", header })), ...(result.duplicateHeaders ?? []).map((header) => ({ problem: "DUPLICATE", header }))])
            : (result.httpStatus ? String(result.httpStatus) : null),
    };
}

// store: createSheetSyncStore(...); config: readSheetSyncConfig(); tuning:
// readSheetSyncTuning().
// destinations: the configured Sync Destinations (config.destinations by
// default; else the one in config.spreadsheetId / tabName).
// forDestination(destination) -> { engine, healthCheck } for that Sheet; or,
// with a single Sheet, engine (createSheetSyncEngine(...)) and healthCheck
// (() => runSheetHealthCheck(...)) used for every run.
// targetHint: fixed hint to publish (default: the active destination's).
export function createSheetSyncWorker({
    store, engine, healthCheck, forDestination = null, destinations = null, config, tuning, targetHint = null, formSubmissions = null,
    clock = () => new Date(), log = console, owner = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    timings = WORKER_TIMINGS,
} = {}) {
    if (!store || !config || !tuning || (!forDestination && (!engine || !healthCheck))) {
        throw new Error("store, config, tuning and either forDestination or engine and healthCheck are required");
    }
    const destinationList = destinations ?? config.destinations
        ?? (config.spreadsheetId && config.tabName ? [{ key: DEFAULT_DESTINATION_KEY, name: config.tabName, spreadsheetId: config.spreadsheetId, tabName: config.tabName }] : []);
    const configured = destinationList.length > 0;
    const runnerFor = (destination) => (forDestination ? forDestination(destination) : { engine, healthCheck });
    const activeDestination = async () => resolveDestination(destinationList, (await store.getState())?.activeDestinationKey ?? null);
    let lastPruneAt = 0;

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
            emit("error", classified.kind === "CONFIG" ? "sheet_sync.config_error" : "sheet_sync.duplicate_key_detected", { errorClass: classified.errorClass, errorCode: classified.errorCode });
        } else if (classified.kind !== "DISABLED") {
            await store.recordTransientError({ errorClass: classified.errorClass, errorCode: classified.errorCode, now });
        }
    }

    // ------------------------------------------------------------ runs

    const testSummary = (result, purpose) => ({
        status: result.status, schema: result.schema, mismatchedColumns: result.mismatchedColumns ?? [],
        missingHeaders: result.missingHeaders ?? [], duplicateHeaders: result.duplicateHeaders ?? [],
        httpStatus: result.httpStatus ?? null, reason: result.reason ?? null, googleStatus: result.googleStatus ?? null, writeGate: config.gate, purpose,
    });

    // A switch to run.destinationKey: validate that Sheet; activate it only
    // if access and headers pass. The integration state (which describes the
    // ACTIVE destination) is not changed by a failed switch.
    async function runDestinationSwitch(run) {
        const key = run.destinationKey;
        const target = destinationList.find((d) => d.key === key) ?? null;
        if (!target) {
            await store.finishRun(run, { status: RUN_STATUS.FAILED, summary: { status: "NOT_CONFIGURED", purpose: SWITCH_PURPOSE }, errorClass: "DESTINATION_NOT_CONFIGURED", now: clock() });
            await store.clearRequestedDestination({ key, now: clock() });
            emit("warn", "sheet_sync.destination_switch_failed", { runId: run.runId, destinationKey: key, errorClass: "DESTINATION_NOT_CONFIGURED" });
            return;
        }
        const result = await runnerFor(target).healthCheck();
        const summary = testSummary(result, SWITCH_PURPOSE);
        if (!result.ok) {
            const failure = testFailure(result);
            await store.finishRun(run, { status: RUN_STATUS.FAILED, summary, ...failure, now: clock() });
            await store.clearRequestedDestination({ key, now: clock() });
            emit("warn", "sheet_sync.destination_switch_failed", { runId: run.runId, destinationKey: key, errorClass: failure.errorClass, errorCode: failure.errorCode });
            return;
        }
        const state = await store.getState();
        const previous = resolveDestination(destinationList, state?.activeDestinationKey ?? null);
        // Under the writer lease: never while a reconciliation is writing.
        const outcome = await withWriterLease(() => store.promoteDestination({ key, previous, next: target, requestedBy: run.requestedBy ?? null, now: clock() }));
        const now = clock();
        if (outcome.busy) {
            await store.finishRun(run, { status: RUN_STATUS.FAILED, summary, errorClass: "WRITER_BUSY", now });
            await store.clearRequestedDestination({ key, now });
            emit("warn", "sheet_sync.destination_switch_failed", { runId: run.runId, destinationKey: key, errorClass: "WRITER_BUSY" });
            return;
        }
        await store.finishRun(run, { status: RUN_STATUS.SUCCEEDED, summary: { ...summary, promoted: outcome.value }, now });
        if (outcome.value && state?.integrationState !== INTEGRATION_STATE.DATA_INTEGRITY) await store.setIntegrationState({ state: INTEGRATION_STATE.OK, now });
        emit("info", "sheet_sync.destination_switched", { runId: run.runId, destinationKey: key, previousKey: previous?.key ?? null, promoted: outcome.value });
    }

    async function runTestConnection(run) {
        if (run.destinationKey) return runDestinationSwitch(run);
        const destination = await activeDestination();
        if (!destination) {
            const now = clock();
            await store.finishRun(run, { status: RUN_STATUS.FAILED, summary: { status: "NOT_CONFIGURED", purpose: "CONNECTION_TEST" }, errorClass: configured ? "DESTINATION_NOT_CONFIGURED" : "NOT_CONFIGURED", now });
            if (configured) await recordFailure({ kind: "CONFIG", errorClass: "DESTINATION_NOT_CONFIGURED", errorCode: null });
            return;
        }
        await store.setRunDestination(run, destination.key);
        const result = await runnerFor(destination).healthCheck();
        const summary = testSummary(result, "CONNECTION_TEST");
        const now = clock();
        await store.finishRun(run, { status: result.ok ? RUN_STATUS.SUCCEEDED : RUN_STATUS.FAILED, summary, errorClass: result.ok ? null : result.status, now });
        const state = await store.getState();
        if (result.ok && state?.integrationState !== INTEGRATION_STATE.DATA_INTEGRITY) {
            await store.setIntegrationState({ state: INTEGRATION_STATE.OK, now });
        } else if (!result.ok && result.status !== "UNAVAILABLE") {
            const failure = testFailure(result);
            await store.setIntegrationState({ state: INTEGRATION_STATE.CONFIG_ERROR, errorClass: failure.errorClass, errorCode: failure.errorCode, now });
        }
        emit(result.ok ? "info" : "warn", "sheet_sync.connection_test", { runId: run.runId, status: result.status, schema: result.schema, httpStatus: summary.httpStatus, googleStatus: summary.googleStatus });
    }

    async function runReconcile(run) {
        const startedAt = clock();
        if (!configured) {
            await store.finishRun(run, { status: RUN_STATUS.FAILED, errorClass: "NOT_CONFIGURED", now: startedAt });
            return;
        }
        const dryRun = config.enabled !== true;
        // During the first-write pilot only the listed candidates are written.
        const onlyUniqueIds = tuning.pilotCandidateIds ?? null;
        emit("info", "sheet_sync.reconcile_started", { runId: run.runId, trigger: run.triggerSource, dryRun, pilot: Boolean(onlyUniqueIds) });
        let covered = [];
        let destination = null;
        const execute = async () => {
            // The active destination, resolved now (inside the writer lease
            // when writing, so a switch can't happen during the run).
            destination = await activeDestination();
            if (!destination) throw new DestinationNotConfiguredError();
            await store.setRunDestination(run, destination.key);
            // Read before the engine reads the database: every change these
            // rows stand for is in the snapshot the engine mirrors.
            if (!dryRun) covered = await store.openQueueItems({ onlyUniqueIds });
            return runnerFor(destination).engine.reconcile({
                dryRun,
                onlyUniqueIds,
                guard: { max: tuning.deletionGuardMax, fraction: tuning.deletionGuardFraction },
                beforeWrite: async () => {
                    await renewWriterLease();
                    if (!(await store.renewRun(run, { now: clock(), leaseMs: timings.runLeaseMs }))) throw new WriterLeaseLostError();
                },
            });
        };
        try {
            const outcome = dryRun ? { busy: false, value: await execute() } : await withWriterLease(execute);
            const now = clock();
            if (outcome.busy) {
                await store.finishRun(run, { status: RUN_STATUS.SKIPPED, errorClass: "WRITER_BUSY", dryRun, now });
                emit("info", "sheet_sync.reconcile_skipped", { runId: run.runId, reason: "WRITER_BUSY" });
                return;
            }
            const summary = outcome.value;
            if (!dryRun) summary.queueSettled = await store.settleReconciled(covered, { now });
            await store.finishRun(run, { status: RUN_STATUS.SUCCEEDED, summary, dryRun, now });
            await store.setIntegrationState({ state: INTEGRATION_STATE.OK, now });
            if (!dryRun) {
                await store.recordSyncSuccess({ now });
                if (!onlyUniqueIds) await store.resolveFailedBefore(startedAt, now);
            }
            if (summary.deletionGuardTriggered) emit("warn", "sheet_sync.reconcile_deletion_guard", { runId: run.runId, wouldMarkInactive: summary.notInDatabase });
            emit("info", "sheet_sync.reconcile_completed", { runId: run.runId, destinationKey: destination?.key ?? null, dryRun, durationMs: now - startedAt, ...summary });
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

    // ------------------------------------------------------------ loop

    async function tick() {
        const now = clock();
        const active = await activeDestination();
        await store.heartbeat({
            writeGate: config.gate, configured, now,
            targetHint: targetHint ?? (active ? sheetTargetHint(active) : null),
            destinations: destinationList.map(publicDestination),
        });
        // No queue processing here: queue rows wait for the next reconciliation.
        const runId = await processRun();
        // The Candidate Form submissions: their own outbox and tab (never the mirror's), after the
        // run so a reconciliation is not delayed by them. A problem here is logged and retried by
        // the rows themselves; it never reaches the mirror or the loop.
        let formBatchFull = false;
        if (formSubmissions && config.enabled === true) {
            try {
                const form = await formSubmissions.processDue({ owner, destination: active, withWriterLease });
                formBatchFull = (form?.claimed ?? 0) >= (formSubmissions.batchSize ?? Infinity);
            } catch (error) {
                emit("error", "sheet_sync.form_submissions_tick_failed", classifySyncError(error));
            }
        }
        if (now.getTime() - lastPruneAt >= timings.pruneEveryMs) {
            lastPruneAt = now.getTime();
            await store.pruneCompleted(new Date(now.getTime() - timings.completedRetentionMs));
        }
        return { runId, formBatchFull };
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
                    busy = Boolean(result.runId) || Boolean(result.formBatchFull);
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
