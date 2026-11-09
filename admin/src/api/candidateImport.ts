import { apiRequest } from "./client";

// Settings -> Google Sheet Sync -> Upload: the bulk candidate import
// (src/routes/candidateImport.js), ADMIN only. The workbook is read in
// the browser (components/importWorkbook.ts); only the allow-listed columns are
// sent, and the server validates everything again.

export type ImportSourceColumns = { allowed: string[]; required: string[] };

export type ImportRow = { rowNumber: number; values: Record<string, string> };

export type ImportSummary = {
    totalRows: number;
    new: number;
    existing: number;
    willFill: number;
    noChange: number;
    valid: number;
    warnings: number;
    invalid: number;
    duplicates: number;
    conflicts: number;
    skippedVerified: number;
    unknownJobRoles: number;
    legacyPassportFormat: number;
    whatsappConflicts: number;
    fieldsDiffering: number;
    ignoredSourceColumns: number;
    // Automatic actions (older servers may not send them).
    allocations?: number;
    testsToSet?: number;
    visaSubmitted?: number;
    departed?: number;
    clientsToCreate?: number;
    agentsToCreate?: number;
    companyNumbersToFill?: number;
    // Jobs from Interview Date + UNIQUE NUMBER (absent from an older server).
    jobsToCreate?: number;
    jobsReused?: number;
    jobGroupProblems?: number;
    jobMembers?: number;
};

// One Job of the upload: the candidates of one Interview Date whose UNIQUE NUMBER is in one hundreds block.
// state: NEW (created by the import; its last two digits can be chosen), EXISTING (an earlier upload
// created it: reused, ID unchanged), SKIPPED (nobody passed the test: no Job yet), ERROR (no Job).
export type ImportJobGroup = {
    key: string; interviewDate: string; from: number; to: number; prefix: string; suffix: string | null; jobCode: string | null;
    state: "NEW" | "EXISTING" | "SKIPPED" | "ERROR"; codes: string[]; messages?: string[]; candidates: number; passed: number;
    clientName: string | null; agentName: string | null; existingJobCode: string | null; edited: boolean;
};

// A row that is not plainly valid: the passport number is masked, the reasons are codes, and
// errors / warnings are their readable messages (the same ones as in rowIssues).
export type ImportProblem = { rowNumber: number; passport: string; status: string; action: string; codes: string[]; errors?: string[]; warnings?: string[] };

// Every row with an issue (no cell values): what the ERRORS / WARNINGS columns of the validation sheet hold.
export type ImportRowIssues = { rowNumber: number; errors: string[]; warnings: string[] };

// What the import will do on its own, shown before anything is confirmed (no candidate data).
export type ImportActions = {
    officers: { sheetName: string; userName: string; rows: number }[];
    officerAssignments: { userName: string; rows: number }[];
    clients: { name: string; action: "CREATE" | "REUSE"; rows: number }[];
    agents: { name: string; action: "CREATE" | "REUSE"; rows: number }[];
    // Every VISA STATUS becomes the candidate's Status. The outcomes are absent from an older server.
    visa: { VISA_SUBMITTED: number; VISA_APPROVED?: number; DEPARTED: number; VISA_NOT_GOING?: number; CANCELLED?: number; REJECTED?: number };
    tests: number;
    testsBlankResultAsPass: number;
};

export type ImportPreview = {
    importId: string;
    chunkSize: number;
    chunkCount: number;
    expiresAt: string;
    summary: ImportSummary;
    columns: { missingRequired: string[]; supported: string[]; ignored: string[]; systemGenerated: string[]; unresolved: string[]; unknown: string[] };
    problems: ImportProblem[];
    problemsTruncated: boolean;
    rowIssues?: ImportRowIssues[];
    actions?: ImportActions;
    jobGroups?: ImportJobGroup[];
};

export type ImportCounts = {
    rows?: number; created?: number; filled?: number; noChange?: number; skippedVerified?: number; invalid?: number;
    duplicates?: number; conflicts?: number; failed?: number; warnings?: number; uncommittedChunks?: number; uncommittedRows?: number;
    allocated?: number; testsSet?: number; stagesCompleted?: number; departed?: number; outcomes?: number; clientsCreated?: number; agentsCreated?: number;
    jobsCreated?: number; jobAssignments?: number;
};

export type ImportChunkResult = {
    chunkIndex: number;
    status: "COMMITTED" | "PARTIAL";
    counts: ImportCounts;
    failures: { rowNumber: number; passport: string; codes: string[]; errors?: string[] }[];
    alreadyCommitted?: boolean;
};

// The import that is committing now (at most one): for Resume / Abort. No candidate data.
export type ActiveImport = {
    importId: string; status: string; fileName: string; totalRows: number; chunkSize: number; chunkCount: number; committedChunks: number[];
    ownedByYou: boolean; stale: boolean; updatedAt: string;
};

// What a 409 IMPORT_ALREADY_ACTIVE (same file already being imported) carries, to resume that import.
export type ResumableImport = { importId: string; chunkSize: number; chunkCount: number; committedChunks: number[]; stale?: boolean };

export type ImportFinish = {
    importId: string;
    status: "COMPLETED" | "COMPLETED_WITH_ERRORS" | "FAILED" | "ABORTED";
    totalRows: number;
    counts: ImportCounts;
    syncRunId: string | null;
    sync?: { requested: boolean; runId: string | null; alreadyActive: boolean };
    alreadyFinished?: boolean;
};

const BASE = "/api/admin/settings/sheet-sync/import";

export function getImportSourceColumns(token: string, signal?: AbortSignal): Promise<ImportSourceColumns> {
    return apiRequest<ImportSourceColumns>(`${BASE}/source-columns`, { token, signal });
}

// idempotencyKey: one per file choice. The server returns the same import for a repeated or retried request.
export function previewImport(token: string, body: { fileName: string; headers: string[]; rows: ImportRow[] }, idempotencyKey?: string): Promise<ImportPreview> {
    return apiRequest<ImportPreview>(`${BASE}/preview`, { method: "POST", token, body, ...(idempotencyKey ? { headers: { "Idempotency-Key": idempotencyKey } } : {}) });
}

export function getActiveImport(token: string, signal?: AbortSignal): Promise<{ active: ActiveImport | null }> {
    return apiRequest<{ active: ActiveImport | null }>(`${BASE}/active`, { token, signal });
}

// Stops an import on purpose; the rows already imported are kept.
export function abortImport(token: string, importId: string): Promise<ImportFinish> {
    return apiRequest<ImportFinish>(`${BASE}/${encodeURIComponent(importId)}/abort`, { method: "POST", token, body: {} });
}

export function commitImportChunk(token: string, importId: string, chunkIndex: number, rows: ImportRow[]): Promise<ImportChunkResult> {
    return apiRequest<ImportChunkResult>(`${BASE}/${encodeURIComponent(importId)}/chunks/${chunkIndex}`, { method: "POST", token, body: { rows } });
}

// The last two digits of the NEW Jobs, chosen before the import ({ [group key]: "05" }); checked by the server.
export function updateImportJobGroups(token: string, importId: string, suffixes: Record<string, string>): Promise<{ jobGroups: ImportJobGroup[] }> {
    return apiRequest<{ jobGroups: ImportJobGroup[] }>(`${BASE}/${encodeURIComponent(importId)}/job-groups`, { method: "PUT", token, body: { suffixes } });
}

export function finishImport(token: string, importId: string): Promise<ImportFinish> {
    return apiRequest<ImportFinish>(`${BASE}/${encodeURIComponent(importId)}/finish`, { method: "POST", token, body: {} });
}
