import { apiRequest } from "./client";

// Settings -> Google Sheet Sync (src/routes/sheetSyncSettings.js), ADMIN only.
// The API reads PostgreSQL and records run requests; the sheet-sync worker
// (Cloud Run) does the work. Nothing here talks to Google.

export type SheetSyncRunStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED";

export type SheetSyncRun = {
    runId: string;
    kind: "RECONCILE" | "TEST_CONNECTION";
    trigger: "ADMIN" | "SCHEDULER" | "OPERATOR";
    status: SheetSyncRunStatus;
    dryRun: boolean | null;
    createdAt: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    errorClass: string | null;
    errorCode: string | null;
    // Counts (reconciliation) or the connection check result; never candidate data.
    summary: Record<string, unknown> | null;
    // The Sync Destination the run used (or, for a switch check, validated).
    destinationKey?: string | null;
};

// A configured Google Sheet the mirror can write to. Safe metadata only: the
// full spreadsheet ID stays on the sheet-sync worker.
export type SyncDestination = { key: string; name: string; hint: string | null; tabName: string | null };

export type SheetSyncStatus = {
    worker: { online: boolean; lastHeartbeatAt: string | null };
    configured: boolean | null;
    writeGate: "ENABLED" | "DISABLED" | "UNKNOWN";
    target: string | null;
    integration: { state: "UNKNOWN" | "OK" | "CONFIG_ERROR" | "DATA_INTEGRITY"; lastErrorClass: string | null; lastErrorCode: string | null; lastErrorAt: string | null };
    queue: { pending: number; processing: number; failed: number };
    lastSuccessfulSyncAt: string | null;
    lastReconciliation: SheetSyncRun | null;
    lastSuccessfulReconciliationAt: string | null;
    // The latest successful reconciliation (either source), and of each source
    // by its stored trigger: automatic = SCHEDULER; manual = ADMIN (Sync Now)
    // or OPERATOR (operator command). Null when there has been none.
    lastSuccessfulReconciliation?: SheetSyncRun | null;
    lastAutomaticSync?: SheetSyncRun | null;
    lastManualSync?: SheetSyncRun | null;
    // The automatic schedule, informational (Cloud Scheduler runs it).
    schedule?: { times: string[]; timeZone: string };
    // Sync Destination: the configured Sheets, the active one, a switch waiting
    // for its access/header check, and the last finished switch check.
    destination?: { available: SyncDestination[]; activeKey: string | null; requestedKey: string | null; lastSwitch: SheetSyncRun | null };
    lastConnectionTest: SheetSyncRun | null;
    activeRuns: { reconcile: SheetSyncRun | null; testConnection: SheetSyncRun | null };
};

export type SheetSyncRunRequest = { run: SheetSyncRun; alreadyActive: boolean };

const BASE = "/api/admin/settings/sheet-sync";

export function getSheetSyncStatus(token: string, signal?: AbortSignal): Promise<SheetSyncStatus> {
    return apiRequest<SheetSyncStatus>(`${BASE}/status`, { token, signal });
}

export function requestConnectionTest(token: string): Promise<SheetSyncRunRequest> {
    return apiRequest<SheetSyncRunRequest>(`${BASE}/test`, { method: "POST", token, body: {} });
}

export function requestSyncNow(token: string): Promise<SheetSyncRunRequest> {
    return apiRequest<SheetSyncRunRequest>(`${BASE}/run`, { method: "POST", token, body: {} });
}

// Ask to switch to another configured destination. PENDING: the worker
// checks its access and headers and only then makes it active.
export function setSyncDestination(token: string, key: string): Promise<{ status: "PENDING" | "ALREADY_ACTIVE"; activeKey: string | null; requestedKey?: string; run: SheetSyncRun | null }> {
    return apiRequest(`${BASE}/destination`, { method: "PUT", token, body: { key } });
}
