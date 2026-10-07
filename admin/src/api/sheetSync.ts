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
};

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
