import { apiRequest } from "./client";

// Settings -> Google Sheet Sync -> Update Sheet: the bulk candidate import
// (src/routes/candidateImport.js), ADMIN and MANAGER. The workbook is read in
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
};

// A row that is not plainly valid: the passport number is masked, the reasons are codes.
export type ImportProblem = { rowNumber: number; passport: string; status: string; action: string; codes: string[] };

export type ImportPreview = {
    importId: string;
    chunkSize: number;
    chunkCount: number;
    expiresAt: string;
    summary: ImportSummary;
    columns: { missingRequired: string[]; supported: string[]; ignored: string[]; systemGenerated: string[]; unresolved: string[]; unknown: string[] };
    problems: ImportProblem[];
    problemsTruncated: boolean;
};

export type ImportCounts = {
    rows?: number; created?: number; filled?: number; noChange?: number; skippedVerified?: number; invalid?: number;
    duplicates?: number; conflicts?: number; failed?: number; warnings?: number; uncommittedChunks?: number; uncommittedRows?: number;
};

export type ImportChunkResult = {
    chunkIndex: number;
    status: "COMMITTED" | "PARTIAL";
    counts: ImportCounts;
    failures: { rowNumber: number; passport: string; codes: string[] }[];
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
