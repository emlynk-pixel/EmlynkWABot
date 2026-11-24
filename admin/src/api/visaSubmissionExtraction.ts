import { apiGetForFile, apiRequest } from "./client";
import type { JobStatus } from "./jobs";

// Visa Submission Phase 2 (src/services/visaExtractionService.js, visaSubmissionStorage.js): a Job's
// signed submissions copied into VISA SUBMISSION/{date}/Plan B/ with the Client's Excel files, and a
// read-only browser of VISA SUBMISSION/. roles.ts VISA_SUBMISSION_ROLES; the server checks every request.

const BASE = "/api/admin/visa-submission";

export type ExtractionJob = {
    jobId: string;
    jobCode: string;
    companyJobId: string | null;
    status: JobStatus;
    client: { id: string; name: string } | null;
    primaryTrade: string | null;
};
export type ExtractionJobSummary = ExtractionJob & { eligibleCount: number };

export type ExtractionSkipReason = "ALREADY_EXTRACTED" | "NOT_ELIGIBLE" | "INVALID_PASSPORT_NUMBER" | "DUPLICATE_PASSPORT_NUMBER";
export type ExtractionSkip = { passportId: string; reason: ExtractionSkipReason | string; message: string };

export type ExtractionPreview = {
    job: ExtractionJob;
    date: string;
    folder: string;
    files: { candidateDetails: string; extraDetails: string };
    candidates: { passportId: string; firstName: string | null; otherName: string | null; documentId: string; uploadedAt: string | null }[];
    // Candidates of the Job left out, with the reason (warnings, shown before confirming).
    skipped: ExtractionSkip[];
    batchSize: number;
    maxBatchSize: number;
};

export type ExtractionBatchResult = {
    date: string;
    folder: string;
    processed: number;
    extracted: { passportId: string; documentId: string; file: string }[];
    skipped: ExtractionSkip[];
    failed: { passportId: string; reason: "PDF_COPY_FAILED" | string }[];
    // Not reached in this batch: sent again with the next one.
    deferred: string[];
    // Informational only: never loop until it is 0 (a failing candidate would never leave it).
    remaining: number;
};

export function listExtractionJobs(token: string, signal?: AbortSignal): Promise<{ jobs: ExtractionJobSummary[] }> {
    return apiRequest(`${BASE}/extraction/jobs`, { token, signal });
}

// 404 JOB_NOT_FOUND.
export function getExtractionPreview(token: string, jobId: string, signal?: AbortSignal): Promise<ExtractionPreview> {
    return apiRequest(`${BASE}/extraction/jobs/${encodeURIComponent(jobId)}`, { token, signal });
}

// 1 to maxBatchSize distinct passport IDs. 409 EXTRACTION_IN_PROGRESS (another batch of this Job is
// running), 502 EXCEL_UPDATE_FAILED, 404 JOB_NOT_FOUND.
export function extractBatch(token: string, jobId: string, passportIds: string[], signal?: AbortSignal): Promise<ExtractionBatchResult> {
    return apiRequest(`${BASE}/extraction/jobs/${encodeURIComponent(jobId)}/extract`, { method: "POST", token, body: { passportIds }, signal });
}

export type StorageEntry = { name: string; type: "folder" | "file"; size: number | null; updatedAt: string | null };
export type StorageFolder = { root: string; path: string; entries: StorageEntry[]; truncated: boolean };

// `path`: relative to VISA SUBMISSION/, "" for the root, always as the server listed it. Encoded once
// (the server refuses a "%" in the decoded path). 404 FOLDER_NOT_FOUND, 400 INVALID_PATH, 502 STORAGE_UNAVAILABLE.
const pathQuery = (path: string) => `path=${encodeURIComponent(path)}`;

export function browseVisaStorage(token: string, path: string, signal?: AbortSignal): Promise<StorageFolder> {
    return apiRequest(`${BASE}/storage${path ? `?${pathQuery(path)}` : ""}`, { token, signal });
}

export function downloadVisaStorageFile(token: string, path: string): Promise<{ blob: Blob; filename: string | null }> {
    return apiGetForFile(`${BASE}/storage/file?${pathQuery(path)}`, { token });
}

// A folder (never the root) as one ZIP. 413 ZIP_TOO_LARGE before anything is sent.
export function downloadVisaStorageZip(token: string, path: string): Promise<{ blob: Blob; filename: string | null }> {
    return apiGetForFile(`${BASE}/storage/zip?${pathQuery(path)}`, { token });
}
