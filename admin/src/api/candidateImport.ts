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
};

export type ImportCounts = {
    rows?: number; created?: number; filled?: number; noChange?: number; skippedVerified?: number; invalid?: number;
    duplicates?: number; conflicts?: number; failed?: number; warnings?: number; uncommittedChunks?: number; uncommittedRows?: number;
    allocated?: number; testsSet?: number; stagesCompleted?: number; departed?: number; outcomes?: number; clientsCreated?: number; agentsCreated?: number;
};

export type ImportChunkResult = {
    chunkIndex: number;
    status: "COMMITTED" | "PARTIAL";
    counts: ImportCounts;
    failures: { rowNumber: number; passport: string; codes: string[]; errors?: string[] }[];
    alreadyCommitted?: boolean;
};

export type ImportFinish = {
    importId: string;
    status: "COMPLETED" | "COMPLETED_WITH_ERRORS" | "FAILED";
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

export function previewImport(token: string, body: { fileName: string; headers: string[]; rows: ImportRow[] }): Promise<ImportPreview> {
    return apiRequest<ImportPreview>(`${BASE}/preview`, { method: "POST", token, body });
}

export function commitImportChunk(token: string, importId: string, chunkIndex: number, rows: ImportRow[]): Promise<ImportChunkResult> {
    return apiRequest<ImportChunkResult>(`${BASE}/${encodeURIComponent(importId)}/chunks/${chunkIndex}`, { method: "POST", token, body: { rows } });
}

export function finishImport(token: string, importId: string): Promise<ImportFinish> {
    return apiRequest<ImportFinish>(`${BASE}/${encodeURIComponent(importId)}/finish`, { method: "POST", token, body: {} });
}
