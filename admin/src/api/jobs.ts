import type { WorkflowStatus } from "./candidates";
import { apiRequest } from "./client";

// Job Management (src/services/jobService.js). ADMIN and JOB_HANDLER manage jobs;
// an ANALYST reads only the jobs holding their own candidates; the server
// enforces both.

export type JobStatus = "PROCESSING" | "COMPLETED" | "CANCELLED";
// all: every status. The server counts each status; All is their sum.
export type JobStatusView = "processing" | "completed" | "cancelled";
export type JobView = JobStatusView | "all";

export const JOB_VIEWS: { view: JobView; label: string; status: JobStatus | null }[] = [
    { view: "processing", label: "Processing", status: "PROCESSING" },
    { view: "completed", label: "Completed", status: "COMPLETED" },
    { view: "cancelled", label: "Cancelled", status: "CANCELLED" },
    { view: "all", label: "All", status: null },
];
export const jobViewCount = (counts: Record<JobStatusView, number>, view: JobView) =>
    view === "all" ? counts.processing + counts.completed + counts.cancelled : counts[view];

export type JobTypeRef = { id: string; code: string; name: string };

// Job Sector: a fixed list (the server keeps the same codes, jobService.js JOB_SECTORS).
export type JobSector = "CONSTRUCTION" | "INDUSTRIAL";
export const JOB_SECTOR_OPTIONS: { value: JobSector; label: string }[] = [
    { value: "CONSTRUCTION", label: "Construction" },
    { value: "INDUSTRIAL", label: "Industrial" },
];

export type JobSummary = {
    jobId: string;
    jobCode: string;
    // The employer's own Job ID (an editable label, never an identifier; shown as "Client Job ID"); null until known.
    companyJobId: string | null;
    status: JobStatus;
    jobType: JobTypeRef;
    jobTypes?: JobTypeRef[];
    // Job Sector (optional): null when not set, or from an older server.
    jobSector?: JobSector | null;
    client: { id: string; name: string };
    responsibleAgent: { id: string; name: string; countryCode: string };
    // To Country: the client's country (its agent's) when the job was created.
    countryCode: string;
    // From Country: RO by default for a new job; null for a job created before it was recorded.
    fromCountryCode: string | null;
    vacancies: number | null;
    createdAt: string | null;
    completedAt: string | null;
    cancelledAt: string | null;
    cancelReason: string | null;
    // Set for a Job created by the Google Sheet upload (JOB-YYYY-MMDDNN): its Interview Date, its Unique
    // Number range, and the code split into the fixed prefix and the editable last two digits.
    importGroup?: ImportJobGroup | null;
};

export type ImportJobGroup = { interviewDate: string | null; from: number; to: number; prefix: string; suffix: string };

// filled: at least as many assigned candidates as vacancies (derived on the server; more than the
// vacancies is allowed and stays filled). Separate from the job's status.
export type JobListItem = JobSummary & { candidateCount: number; filled: boolean };

export type JobList = {
    items: JobListItem[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number; totalItems?: number; hasNextPage?: boolean; hasPreviousPage?: boolean };
    counts: Record<JobStatusView, number>;
    filters: { view: JobView; search: string | null };
};

// workflowStatus: the Candidates list's own Status (src/services/candidateWorkflowStatus.js).
export type JobCandidateRow = { passportId: string; uniqueId: string; name: string | null; nic: string | null; assignedAt: string | null; workflowStatus: WorkflowStatus };

export type JobDetails = JobListItem & { createdBy: string | null; candidates: JobCandidateRow[] };

// A candidate's assignment as the Candidate Details page shows it.
export type CandidateJobAssignment = JobSummary & { assignedAt: string | null; removed: boolean; removedAt: string | null };

export type JobOptions = {
    jobTypes: { id: string; name: string; code: string }[];
    // Active clients with at least one active agent; agentIds are those agents (any can be the
    // job's responsible agent; with several, one must be chosen). The To Country is the chosen
    // agent's country (agents[].countryCode).
    clients: { id: string; name: string; agentIds: string[] }[];
    // countryCode is absent for an Agent created by the bulk import until its country is set: such an
    // Agent can't be a job's responsible agent (the server refuses, AGENT_COUNTRY_MISSING).
    agents: { id: string; name: string; countryCode?: string }[];
};

// responsibleAgentId must be one of the client's agents (optional only when it has exactly one).
// The To Country is never sent (the responsible agent's). candidateIds are assigned with the job in one
// transaction (none, one or many; the vacancies never limit them).
export type CreateJobInput = { jobTypeId?: string; jobTypeIds?: string[]; jobSector?: JobSector | null; clientId: string; responsibleAgentId?: string; vacancies: number | null; companyJobId?: string | null; fromCountryCode?: string; candidateIds?: string[] };
export type UpdateJobInput = { vacancies?: number | null; jobTypeId?: string; jobTypeIds?: string[]; clientId?: string; companyJobId?: string | null; fromCountryCode?: string };

// A new job's From Country unless changed (src/services/jobService.js DEFAULT_FROM_COUNTRY).
export const DEFAULT_FROM_COUNTRY = "RO";

const jobPath = (jobId: string) => `/api/admin/jobs/${encodeURIComponent(jobId)}`;

export function listJobs(token: string, params: { view: JobView; search?: string; page: number }, signal?: AbortSignal): Promise<JobList> {
    const query = new URLSearchParams({ view: params.view, page: String(params.page) });
    if (params.search) query.set("search", params.search);
    return apiRequest<JobList>(`/api/admin/jobs?${query.toString()}`, { token, signal });
}

// The job candidate picker (New job, Add candidates): only the candidates a job may take (test
// PASS), with only what the picker shows. ADMIN, TEAM_LEAD and JOB_HANDLER (the server checks);
// the JOB_HANDLER's only way to list candidates, as it has no Candidates area.
export type JobCandidateOption = { passportId: string; uniqueId: string; name: string | null; nic: string | null; workflowStatus: WorkflowStatus };
export type JobCandidateOptions = { items: JobCandidateOption[]; pagination: JobList["pagination"]; filters: { search: string | null } };

export function listJobCandidateOptions(token: string, params: { page: number; pageSize: number; search?: string }, signal?: AbortSignal): Promise<JobCandidateOptions> {
    const query = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) });
    if (params.search) query.set("search", params.search);
    return apiRequest<JobCandidateOptions>(`/api/admin/job-candidate-options?${query.toString()}`, { token, signal });
}

export const getJob = (token: string, jobId: string, signal?: AbortSignal) => apiRequest<JobDetails>(jobPath(jobId), { token, signal });
export const getJobOptions = (token: string, signal?: AbortSignal) => apiRequest<JobOptions>("/api/admin/job-options", { token, signal });
export const createJob = (token: string, body: CreateJobInput) => apiRequest<JobDetails>("/api/admin/jobs", { method: "POST", token, body });
export const updateJob = (token: string, jobId: string, body: UpdateJobInput) => apiRequest<JobDetails>(jobPath(jobId), { method: "PUT", token, body });
export const addCandidateToJob = (token: string, jobId: string, passportId: string) => apiRequest<JobDetails>(`${jobPath(jobId)}/candidates`, { method: "POST", token, body: { passportId } });
export const removeCandidateFromJob = (token: string, jobId: string, passportId: string) => apiRequest<JobDetails>(`${jobPath(jobId)}/candidates/${encodeURIComponent(passportId)}`, { method: "DELETE", token });
export const completeJob = (token: string, jobId: string) => apiRequest<JobDetails>(`${jobPath(jobId)}/complete`, { method: "POST", token, body: {} });
// The last two digits of a sheet-upload Job (ADMIN, OWNER, JOB_HANDLER, and an ANALYST for a Job holding
// one of their candidates; the server checks). Exactly two digits, 01-99; the code must stay unique.
export const updateImportJobSuffix = (token: string, jobId: string, suffix: string) =>
    apiRequest<{ jobId: string; jobCode: string }>(`${jobPath(jobId)}/import-suffix`, { method: "PATCH", token, body: { suffix } });
export const cancelJob = (token: string, jobId: string, reason: string) => apiRequest<JobDetails>(`${jobPath(jobId)}/cancel`, { method: "POST", token, body: { reason } });

// Reference data a job needs (job types are created inline from the New job form;
// agents and clients are managed in Admin > Agents and Admin > Client Management).
export const createJobType = (token: string, name: string) => apiRequest<{ id: string; name: string; code: string }>("/api/admin/job-types", { method: "POST", token, body: { name } });

// "No Preferred Type": a system option for a CANDIDATE's preference (never a Job's
// type). Stored as its code; shown with its label.
export const NO_PREFERRED_JOB_TYPE = { code: "NO_PREFERENCE", label: "No Preferred Type" } as const;
export const isNoPreference = (value: string) => [NO_PREFERRED_JOB_TYPE.code, NO_PREFERRED_JOB_TYPE.label.toUpperCase()].includes(value.trim().toUpperCase());
export const jobTypeLabel = (value: string) => (isNoPreference(value) ? NO_PREFERRED_JOB_TYPE.label : value);

// Settings > Job Types (ADMIN): every job type, active or not.
export type ManagedJobType = { id: string; code: string; name: string; isActive: boolean; jobCount: number; createdAt: string; updatedAt: string };
export type JobTypeList = { items: ManagedJobType[]; noPreference: { code: string; label: string } };
export const listJobTypes = (token: string, signal?: AbortSignal) => apiRequest<JobTypeList>("/api/admin/job-types", { token, signal });
export const updateJobType = (token: string, id: string, body: { name?: string; isActive?: boolean }) => apiRequest<ManagedJobType>(`/api/admin/job-types/${encodeURIComponent(id)}`, { method: "PATCH", token, body });

// The candidate job type choices (registration, Candidate Details): active names + No Preferred Type.
export type JobTypeChoices = { jobTypes: string[]; noPreference: { code: string; label: string } };
export const getJobTypeChoices = (token: string, signal?: AbortSignal) => apiRequest<JobTypeChoices>("/api/admin/job-type-choices", { token, signal });

// Candidate Form job-group link (src/services/candidateFormJobGroupService.js): ADMIN only.
// Bound to the job's immutable id on the server; the URL carries only an opaque secret.
export type JobGroupShareStatus = {
    jobId: string;
    jobCode: string;
    companyJobId: string | null;
    client: string;
    jobType: string;
    jobStatus: JobStatus;
    state: "OPEN" | "NONE";
    counts: { candidates: number; submitted: number; remaining: number };
    link: { linkId: string; createdAt: string; createdByName: string | null; expiresAt: string; lockedUntil: string | null } | null;
};
export type CreatedJobGroupShareLink = { url: string; linkId: string; expiresAt: string; status: JobGroupShareStatus };

export const getJobGroupShareStatus = (token: string, jobId: string, signal?: AbortSignal) => apiRequest<JobGroupShareStatus>(`${jobPath(jobId)}/form-share`, { token, signal });
export const createJobGroupShareLink = (token: string, jobId: string) => apiRequest<CreatedJobGroupShareLink>(`${jobPath(jobId)}/form-share`, { method: "POST", token, body: {} });
export const revokeJobGroupShareLink = (token: string, jobId: string) => apiRequest<JobGroupShareStatus>(`${jobPath(jobId)}/form-share/revoke`, { method: "POST", token, body: {} });
