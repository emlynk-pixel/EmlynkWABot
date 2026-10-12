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

import { SHEET_SYNC_SCHEDULE, isValidDestinationKey } from "../config/sheetSync.js";
import { RUN_KIND, RUN_STATUS, RUN_TRIGGER, createSheetSyncStore } from "./sheetSyncStore.js";

// The summary purpose of a destination-switch check (sheetSyncWorker.js).
const SWITCH_PURPOSE = "DESTINATION_SWITCH";

// Who started a reconciliation, from the run's stored trigger_source (never
// from the time it ran, so a late scheduled run is still automatic):
// automatic = Cloud Scheduler; manual = Sync Now (ADMIN) or the operator
// command (OPERATOR, npm run sheet:request).
const AUTOMATIC_TRIGGERS = [RUN_TRIGGER.SCHEDULER];
const MANUAL_TRIGGERS = [RUN_TRIGGER.ADMIN, RUN_TRIGGER.OPERATOR];

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
        destinationKey: run.destinationKey ?? null,
    };
}

// The destinations as the worker published them: only the safe fields
// (key, name, short hint, tab name), never a full spreadsheet ID.
function publishedDestinations(state) {
    if (!Array.isArray(state?.destinations)) return [];
    return state.destinations
        .filter((d) => d && isValidDestinationKey(d.key) && typeof d.name === "string")
        .map((d) => ({ key: d.key, name: d.name, hint: typeof d.hint === "string" ? d.hint : null, tabName: typeof d.tabName === "string" ? d.tabName : null }));
}

export async function getSheetSyncStatus({ db, now = new Date() }) {
    const store = createSheetSyncStore({ db });
    const [state, queue, lastReconciliation, lastSuccessfulReconciliation, lastConnectionTest, activeReconcile, activeTest, lastAutomaticSync, lastManualSync] = await Promise.all([
        store.getState(),
        store.queueCounts(),
        store.latestRun(RUN_KIND.RECONCILE, { status: { in: [RUN_STATUS.SUCCEEDED, RUN_STATUS.FAILED, RUN_STATUS.SKIPPED] } }),
        store.latestRun(RUN_KIND.RECONCILE, { status: RUN_STATUS.SUCCEEDED }),
        store.latestRun(RUN_KIND.TEST_CONNECTION, { status: { in: [RUN_STATUS.SUCCEEDED, RUN_STATUS.FAILED] } }),
        store.latestRun(RUN_KIND.RECONCILE, { status: { in: [RUN_STATUS.QUEUED, RUN_STATUS.RUNNING] } }),
        store.latestRun(RUN_KIND.TEST_CONNECTION, { status: { in: [RUN_STATUS.QUEUED, RUN_STATUS.RUNNING] } }),
        store.latestRun(RUN_KIND.RECONCILE, { status: RUN_STATUS.SUCCEEDED, triggerSource: { in: AUTOMATIC_TRIGGERS } }),
        store.latestRun(RUN_KIND.RECONCILE, { status: RUN_STATUS.SUCCEEDED, triggerSource: { in: MANUAL_TRIGGERS } }),
    ]);
    const heartbeat = state?.workerHeartbeatAt ?? null;
    const available = publishedDestinations(state);
    const lastSwitch = (await store.recentRuns(RUN_KIND.TEST_CONNECTION, 10)).find((run) => run.summary?.purpose === SWITCH_PURPOSE) ?? null;
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
        // The latest successful reconciliation of each source, and of either
        // (with its trigger), so a manual run is never shown as the scheduled one.
        lastSuccessfulReconciliation: serializeRun(lastSuccessfulReconciliation),
        lastAutomaticSync: serializeRun(lastAutomaticSync),
        lastManualSync: serializeRun(lastManualSync),
        // Sync Destination: the configured Sheets (safe metadata), the active
        // one (null key = the first), a switch waiting for its validation, and
        // the last finished switch check (its error when one failed).
        destination: {
            available,
            activeKey: state?.activeDestinationKey ?? available[0]?.key ?? null,
            requestedKey: state?.requestedDestinationKey ?? null,
            lastSwitch: serializeRun(lastSwitch),
        },
        // The automatic schedule (informational; Cloud Scheduler runs it).
        schedule: { times: [...SHEET_SYNC_SCHEDULE.times], timeZone: SHEET_SYNC_SCHEDULE.timeZone },
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

export class DestinationSwitchError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = "DestinationSwitchError";
        this.status = status;
        this.code = code;
    }
}

// An ADMIN's switch to another configured destination. Recorded as pending
// (requested_destination_key) with a durable TEST_CONNECTION run for that
// destination; the worker validates its access and headers and only then
// makes it active. Nothing is synced, read back or deleted by the request.
export async function requestDestinationSwitch({ db, key, requestedBy, now = new Date() }) {
    const store = createSheetSyncStore({ db });
    const state = await store.getState();
    const available = publishedDestinations(state);
    if (!available.some((d) => d.key === key)) throw new DestinationSwitchError(400, "UNKNOWN_DESTINATION", "This destination is not configured.");
    const activeKey = state?.activeDestinationKey ?? available[0]?.key ?? null;
    if (state?.requestedDestinationKey) throw new DestinationSwitchError(409, "SWITCH_PENDING", "A destination change is already being checked.");
    if (key === activeKey) return { status: "ALREADY_ACTIVE", activeKey, run: null };
    const activeTest = await store.latestRun(RUN_KIND.TEST_CONNECTION, { status: { in: [RUN_STATUS.QUEUED, RUN_STATUS.RUNNING] } });
    if (activeTest) throw new DestinationSwitchError(409, "TEST_RUNNING", "A connection test is running. Try again when it has finished.");
    if (!(await store.requestDestination({ key, now }))) throw new DestinationSwitchError(409, "SWITCH_PENDING", "A destination change is already being checked.");
    const { run, created } = await store.requestRun({ kind: RUN_KIND.TEST_CONNECTION, triggerSource: RUN_TRIGGER.ADMIN, requestedBy, destinationKey: key, now });
    if (!created) {
        // Another test started in between: withdraw rather than wait on a check that won't run.
        await store.clearRequestedDestination({ key, now });
        throw new DestinationSwitchError(409, "TEST_RUNNING", "A connection test is running. Try again when it has finished.");
    }
    return { status: "PENDING", activeKey, requestedKey: key, run: serializeRun(run) };
}

export async function getSheetSyncRun({ db, runId }) {
    return serializeRun(await createSheetSyncStore({ db }).getRun(runId));
}

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isValidRunId = (value) => typeof value === "string" && RUN_ID_PATTERN.test(value);
