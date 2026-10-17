import { apiRequest } from "./client";

// Job Management (src/services/jobService.js). ADMIN and MANAGER manage jobs;
// an ANALYST reads only the jobs holding their own candidates; the server
// enforces both.

export type JobStatus = "PROCESSING" | "COMPLETED" | "CANCELLED";
export type JobView = "processing" | "completed" | "cancelled";

export const JOB_VIEWS: { view: JobView; label: string; status: JobStatus }[] = [
    { view: "processing", label: "Processing", status: "PROCESSING" },
    { view: "completed", label: "Completed", status: "COMPLETED" },
    { view: "cancelled", label: "Cancelled", status: "CANCELLED" },
];

export type JobSummary = {
    jobId: string;
    jobCode: string;
    // The employer's own Job ID (an editable label, never an identifier); null until known.
    companyJobId: string | null;
    status: JobStatus;
    jobType: { id: string; code: string; name: string };
    company: { id: string; name: string };
    responsibleAgent: { id: string; name: string; countryCode: string };
    countryCode: string;
    vacancies: number | null;
    createdAt: string | null;
    completedAt: string | null;
    cancelledAt: string | null;
    cancelReason: string | null;
};

export type JobListItem = JobSummary & { candidateCount: number };

export type JobList = {
    items: JobListItem[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number; totalItems?: number; hasNextPage?: boolean; hasPreviousPage?: boolean };
    counts: Record<JobView, number>;
    filters: { view: JobView; search: string | null };
};

export type JobCandidateRow = { passportId: string; uniqueId: string; name: string | null; nic: string | null; assignedAt: string | null };

export type JobDetails = JobListItem & { createdBy: string | null; candidates: JobCandidateRow[] };

// A candidate's assignment as the Candidate Details page shows it.
export type CandidateJobAssignment = JobSummary & { assignedAt: string | null; removed: boolean; removedAt: string | null };

export type JobOptions = {
    jobTypes: { id: string; name: string; code: string }[];
    companies: { id: string; name: string }[];
    agents: { id: string; name: string; countryCode: string }[];
};

export type CreateJobInput = { jobTypeId: string; companyId: string; responsibleAgentId: string; vacancies: number | null; companyJobId?: string | null };
export type UpdateJobInput = { vacancies?: number | null; jobTypeId?: string; companyId?: string; companyJobId?: string | null };

const jobPath = (jobId: string) => `/api/admin/jobs/${encodeURIComponent(jobId)}`;

export function listJobs(token: string, params: { view: JobView; search?: string; page: number }, signal?: AbortSignal): Promise<JobList> {
    const query = new URLSearchParams({ view: params.view, page: String(params.page) });
    if (params.search) query.set("search", params.search);
    return apiRequest<JobList>(`/api/admin/jobs?${query.toString()}`, { token, signal });
}

export const getJob = (token: string, jobId: string, signal?: AbortSignal) => apiRequest<JobDetails>(jobPath(jobId), { token, signal });
export const getJobOptions = (token: string, signal?: AbortSignal) => apiRequest<JobOptions>("/api/admin/job-options", { token, signal });
export const createJob = (token: string, body: CreateJobInput) => apiRequest<JobDetails>("/api/admin/jobs", { method: "POST", token, body });
export const updateJob = (token: string, jobId: string, body: UpdateJobInput) => apiRequest<JobDetails>(jobPath(jobId), { method: "PUT", token, body });
export const addCandidateToJob = (token: string, jobId: string, passportId: string) => apiRequest<JobDetails>(`${jobPath(jobId)}/candidates`, { method: "POST", token, body: { passportId } });
export const removeCandidateFromJob = (token: string, jobId: string, passportId: string) => apiRequest<JobDetails>(`${jobPath(jobId)}/candidates/${encodeURIComponent(passportId)}`, { method: "DELETE", token });
export const completeJob = (token: string, jobId: string) => apiRequest<JobDetails>(`${jobPath(jobId)}/complete`, { method: "POST", token, body: {} });
export const cancelJob = (token: string, jobId: string, reason: string) => apiRequest<JobDetails>(`${jobPath(jobId)}/cancel`, { method: "POST", token, body: { reason } });

// Reference data a job needs (created inline from the New job form).
export const createJobType = (token: string, name: string) => apiRequest<{ id: string; name: string; code: string }>("/api/admin/job-types", { method: "POST", token, body: { name } });
export const createCompany = (token: string, name: string) => apiRequest<{ id: string; name: string }>("/api/admin/companies", { method: "POST", token, body: { name } });
export const createAgent = (token: string, name: string, countryCode: string) => apiRequest<{ id: string; name: string; countryCode: string }>("/api/admin/agents", { method: "POST", token, body: { name, countryCode } });

// Candidate Form job-group link (src/services/candidateFormJobGroupService.js): ADMIN and MANAGER.
export type JobGroupShareStatus = {
    jobId: string;
    jobCode: string;
    companyJobId: string | null;
    company: string;
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
