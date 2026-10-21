import type { JobListItem, JobStatus, JobSummary } from "../../api/jobs";
import type { ReactNode } from "react";
import { ToneBadge, type Tone } from "../StatusBadge";
import { formatDate, formatNumber } from "../format";
import { countryName } from "../master/MasterParts";

// Shared by the Jobs list, Job details and the Candidate Details job section.

export const JOB_STATUS_LABEL: Record<JobStatus, string> = { PROCESSING: "Processing", COMPLETED: "Completed", CANCELLED: "Cancelled" };

const JOB_STATUS_TONE: Record<JobStatus, Tone> = { PROCESSING: "review", COMPLETED: "verified", CANCELLED: "critical" };

export function JobStatusBadge({ status }: { status: JobStatus }) {
    return <ToneBadge tone={JOB_STATUS_TONE[status]}>{JOB_STATUS_LABEL[status]}</ToneBadge>;
}

// "Completed 12 Oct 2026", "Cancelled 12 Oct 2026", or the created date.
export function jobDateNote(job: JobSummary): string {
    if (job.status === "COMPLETED") return `Completed ${formatDate(job.completedAt)}`;
    if (job.status === "CANCELLED") return `Cancelled ${formatDate(job.cancelledAt)}`;
    return `Created ${formatDate(job.createdAt)}`;
}

export const NO_COMPANY_JOB_ID = "Not assigned";

// Filled: at least as many assigned candidates as vacancies (the server's `filled`). Never a limit:
// 23 / 20 is shown as it is and stays Filled. Separate from the job's status.
export function FilledBadge() {
    return <ToneBadge tone="verified">Filled</ToneBadge>;
}

// "23 / 20" (assigned / vacancies) with Filled once reached; the count alone when the job has no vacancies.
export function VacancyFill({ job }: { job: Pick<JobListItem, "candidateCount" | "vacancies" | "filled"> }) {
    return (
        <span className="inline-flex flex-wrap items-center gap-2">
            <span className="tabular-nums" aria-label={job.vacancies === null ? `${job.candidateCount} assigned, no vacancies set` : `${job.candidateCount} assigned of ${job.vacancies} vacancies`}>
                {formatNumber(job.candidateCount)}{job.vacancies === null ? "" : ` / ${formatNumber(job.vacancies)}`}
            </span>
            {job.filled && <FilledBadge />}
        </span>
    );
}

// A job's countries by name. The From Country of a job created before it was recorded is null.
export const NOT_RECORDED = "Not recorded";
export const jobCountry = (code: string | null) => (code ? countryName(code) : NOT_RECORDED);

export function Detail({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div>
            <dt className="text-label-caps uppercase text-ink-subtle">{label}</dt>
            <dd className="mt-0.5 text-body-sm text-ink">{children}</dd>
        </div>
    );
}
