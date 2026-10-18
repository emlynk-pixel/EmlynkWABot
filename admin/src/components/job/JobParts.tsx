import type { JobStatus, JobSummary } from "../../api/jobs";
import type { ReactNode } from "react";
import { ToneBadge, type Tone } from "../StatusBadge";
import { formatDate } from "../format";

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

export function Detail({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div>
            <dt className="text-label-caps uppercase text-ink-subtle">{label}</dt>
            <dd className="mt-0.5 text-body-sm text-ink">{children}</dd>
        </div>
    );
}
