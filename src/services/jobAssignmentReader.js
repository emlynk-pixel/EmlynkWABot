// A candidate's Job assignments, read from the relational model
// (job_candidate -> job). The ONLY source of "which job is this candidate on":
// candidate_stages.job_id is deprecated legacy text and is never read for it.
// Kept apart from jobService.js so candidateService.js can use it without a
// circular import.

export const JOB_STATUS = Object.freeze({ PROCESSING: "PROCESSING", COMPLETED: "COMPLETED", CANCELLED: "CANCELLED" });

export const JOB_SELECT = Object.freeze({
    id: true, jobCode: true, companyJobId: true, status: true, countryCode: true, vacancies: true,
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
        countryCode: job.countryCode,
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
        orderBy: [{ assignedAt: "desc" }],
    });
    const view = (row) => ({ ...jobSummaryView(row.job), assignedAt: iso(row.assignedAt), removed: Boolean(row.releasedAt), removedAt: iso(row.releasedAt) });
    const active = rows.find((row) => row.isActive);
    return { current: active ? view(active) : null, history: rows.filter((row) => row !== active).map(view) };
}
