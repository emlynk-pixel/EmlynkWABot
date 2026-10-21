// A candidate's Job assignments, read from the relational model
// (job_candidate -> job). The ONLY source of "which job is this candidate on":
// candidate_stages.job_id is deprecated legacy text and is never read for it.
// Kept apart from jobService.js so candidateService.js can use it without a
// circular import.

export const JOB_STATUS = Object.freeze({ PROCESSING: "PROCESSING", COMPLETED: "COMPLETED", CANCELLED: "CANCELLED" });

export const JOB_SELECT = Object.freeze({
    id: true, jobCode: true, companyJobId: true, status: true, countryCode: true, fromCountryCode: true, vacancies: true,
    createdAt: true, completedAt: true, cancelledAt: true, cancelReason: true,
    jobType: { select: { id: true, code: true, name: true } },
    client: { select: { id: true, name: true } },
    responsibleAgent: { select: { id: true, name: true, countryCode: true } },
});

const iso = (value) => (value ? value.toISOString() : null);

export function jobSummaryView(job) {
    return {
        jobId: job.id,
        jobCode: job.jobCode,
        companyJobId: job.companyJobId ?? null,
        status: job.status,
        jobType: { id: job.jobType.id, code: job.jobType.code, name: job.jobType.name },
        client: { id: job.client.id, name: job.client.name },
        responsibleAgent: { id: job.responsibleAgent.id, name: job.responsibleAgent.name, countryCode: job.responsibleAgent.countryCode },
        // To Country: the Client's country when the job was created. From Country: null when not recorded.
        countryCode: job.countryCode,
        fromCountryCode: job.fromCountryCode ?? null,
        vacancies: job.vacancies ?? null,
        createdAt: iso(job.createdAt),
        completedAt: iso(job.completedAt),
        cancelledAt: iso(job.cancelledAt),
        cancelReason: job.cancelReason ?? null,
    };
}

// { current, history }: current = the PROCESSING job the candidate is active
// on (or null); history = every other assignment, newest first (COMPLETED and
// CANCELLED jobs, and jobs the candidate was removed from: `removed: true`).
export async function candidateJobAssignments(db, passportId) {
    const rows = await db.jobCandidate.findMany({
        where: { passportId },
        select: { assignedAt: true, isActive: true, releasedAt: true, job: { select: JOB_SELECT } },
        // Newest assignment first. "Latest" is job_candidate.assigned_at (set when the candidate is
        // assigned, and again if a removed candidate is put back on the same job); ties fall back to
        // the row's created_at and then the job id, so the order is always the same.
        orderBy: [{ assignedAt: "desc" }, { createdAt: "desc" }, { jobId: "desc" }],
    });
    const view = (row) => ({ ...jobSummaryView(row.job), assignedAt: iso(row.assignedAt), removed: Boolean(row.releasedAt), removedAt: iso(row.releasedAt) });
    const active = rows.find((row) => row.isActive);
    return { current: active ? view(active) : null, history: rows.filter((row) => row !== active).map(view) };
}

// The Job the candidate page's Job details stage shows, from the result of
// candidateJobAssignments. Display-only: nothing is written or re-activated.
//   A. the current PROCESSING assignment   -> source CURRENT
//   B. else the latest historical one      -> source HISTORICAL (history is newest first)
//   C. else none                           -> source NONE
// status: the job's status, or REMOVED when the candidate was taken off a job that is still
// PROCESSING. A job_candidate row is never deleted (removal sets released_at), so the history is complete.
export function displayJob(assignments) {
    if (assignments?.current) return { source: "CURRENT", job: assignments.current, status: assignments.current.status };
    const latest = assignments?.history?.[0];
    if (latest) return { source: "HISTORICAL", job: latest, status: latest.removed && latest.status === JOB_STATUS.PROCESSING ? "REMOVED" : latest.status };
    return { source: "NONE", job: null, status: null };
}
