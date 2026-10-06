// Google Sheet operational mirror: what the Admin Settings page shows
// (Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md, Sections 12.4 and 13).
//
// Runs in the Admin API (Vercel), which holds NO Google credentials and never
// calls Google: everything here is read from PostgreSQL (the state row the
// sheet-sync worker maintains, queue counts, run records). Action requests
// only insert durable run records; the worker executes them.
//
// The payload holds states, timestamps, counts and codes. Never credentials,
// tokens, the full spreadsheet ID, candidate data or Google message text.

import { RUN_KIND, RUN_STATUS, createSheetSyncStore } from "./sheetSyncStore.js";

// The worker heartbeats every poll (10 s by default); older than this means
// it is not running, so queued runs won't progress.
export const WORKER_STALE_MS = 2 * 60_000;

const iso = (date) => (date ? new Date(date).toISOString() : null);

export function serializeRun(run) {
    if (!run) return null;
    return {
        runId: run.runId,
        kind: run.kind,
        trigger: run.triggerSource,
        status: run.status,
        dryRun: run.dryRun ?? null,
        createdAt: iso(run.createdAt),
        startedAt: iso(run.startedAt),
        finishedAt: iso(run.finishedAt),
        errorClass: run.errorClass ?? null,
        errorCode: run.errorCode ?? null,
        summary: run.summary ?? null,
    };
}

export async function getSheetSyncStatus({ db, now = new Date() }) {
    const store = createSheetSyncStore({ db });
    const [state, queue, lastReconciliation, lastSuccessfulReconciliation, lastConnectionTest, activeReconcile, activeTest] = await Promise.all([
        store.getState(),
        store.queueCounts(),
        store.latestRun(RUN_KIND.RECONCILE, { status: { in: [RUN_STATUS.SUCCEEDED, RUN_STATUS.FAILED, RUN_STATUS.SKIPPED] } }),
        store.latestRun(RUN_KIND.RECONCILE, { status: RUN_STATUS.SUCCEEDED }),
        store.latestRun(RUN_KIND.TEST_CONNECTION, { status: { in: [RUN_STATUS.SUCCEEDED, RUN_STATUS.FAILED] } }),
        store.latestRun(RUN_KIND.RECONCILE, { status: { in: [RUN_STATUS.QUEUED, RUN_STATUS.RUNNING] } }),
        store.latestRun(RUN_KIND.TEST_CONNECTION, { status: { in: [RUN_STATUS.QUEUED, RUN_STATUS.RUNNING] } }),
    ]);
    const heartbeat = state?.workerHeartbeatAt ?? null;
    return {
        worker: {
            online: Boolean(heartbeat) && now.getTime() - new Date(heartbeat).getTime() <= WORKER_STALE_MS,
            lastHeartbeatAt: iso(heartbeat),
        },
        configured: state?.configured ?? null,
        writeGate: state?.writeGate ?? "UNKNOWN",
        target: state?.targetHint ?? null,
        integration: {
            state: state?.integrationState ?? "UNKNOWN",
            lastErrorClass: state?.lastErrorClass ?? null,
            lastErrorCode: state?.lastErrorCode ?? null,
            lastErrorAt: iso(state?.lastErrorAt),
        },
        queue,
        lastSuccessfulSyncAt: iso(state?.lastSyncSuccessAt),
        lastReconciliation: serializeRun(lastReconciliation),
        lastSuccessfulReconciliationAt: iso(lastSuccessfulReconciliation?.finishedAt),
        lastConnectionTest: serializeRun(lastConnectionTest),
        activeRuns: { reconcile: serializeRun(activeReconcile), testConnection: serializeRun(activeTest) },
    };
}

// A durable run request: { run, created }. An already queued/running run of
// the same kind is returned instead of a second one.
export async function requestSheetSyncRun({ db, kind, triggerSource, requestedBy = null, now = new Date() }) {
    const { run, created } = await createSheetSyncStore({ db }).requestRun({ kind, triggerSource, requestedBy, now });
    return { run: serializeRun(run), created };
}

export async function getSheetSyncRun({ db, runId }) {
    return serializeRun(await createSheetSyncStore({ db }).getRun(runId));
}

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isValidRunId = (value) => typeof value === "string" && RUN_ID_PATTERN.test(value);
