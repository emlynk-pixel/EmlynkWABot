import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ApiError } from "../../api/client";
import { getCandidate, type CandidateDetails, type JobAssignments } from "../../api/candidates";
import { addCandidateToJob, listJobs, type CandidateJobAssignment, type JobListItem } from "../../api/jobs";
import { useAdminResource } from "../../api/useAdminResource";
import { canManageJobs, canViewJobs, useAuth } from "../../auth/AuthProvider";
import { ActionDialog, DialogError, primaryButton, secondaryButton } from "../Dialog";
import { formatDate } from "../format";
import { Detail, JobStatusBadge, NO_COMPANY_JOB_ID } from "../job/JobParts";
import { Card, EmptyState, ErrorState, LoadingState } from "../States";
import { filterControl } from "../ui";

// The candidate's Job assignment, read from the Job relation (job_candidate):
// the PROCESSING job they are on now, and the completed / cancelled history.
// Never from the old free-text candidate_stages.job_id.
//
// ADMIN and MANAGER get "Assign to Job" when the candidate has no PROCESSING
// job. It uses the same endpoint as Add to job on the Job page
// (POST /api/admin/jobs/:jobId/candidates), so the one-PROCESSING-job rule is the
// server's: a candidate already on a job is refused with 409, never moved.

function JobLine({ job, historic = false }: { job: CandidateJobAssignment; historic?: boolean }) {
    const { user } = useAuth();
    const code = canViewJobs(user) ? <Link to={`/jobs/${job.jobId}`} className="font-medium text-primary hover:underline">{job.jobCode}</Link> : <span className="font-medium">{job.jobCode}</span>;
    return (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Detail label="Internal job code">{code}</Detail>
            <Detail label="Company Job ID">{job.companyJobId ?? <span className="text-ink-muted">Not assigned</span>}</Detail>
            <Detail label="Job type">{job.jobType.name}</Detail>
            <Detail label="Company">{job.company.name}</Detail>
            <Detail label="Responsible agent">{job.responsibleAgent.name}</Detail>
            {!historic && <Detail label="Status"><JobStatusBadge status={job.status} /></Detail>}
            {historic && <Detail label="Status">{job.removed ? "Removed" : <JobStatusBadge status={job.status} />}</Detail>}
            {historic && <Detail label="Assigned">{formatDate(job.assignedAt)}</Detail>}
            {historic && job.status === "CANCELLED" && job.cancelReason && <Detail label="Cancel reason">{job.cancelReason}</Detail>}
        </dl>
    );
}

export function JobAssignmentPanel({ assignments, candidate, onChanged }: {
    assignments: JobAssignments;
    candidate?: { passportId: string; name: string | null };
    // Told with the candidate's fresh details after an assignment, so this card
    // and the Share Form (which reads the current job) update at once.
    onChanged?: (details: CandidateDetails) => void;
}) {
    const { user, token } = useAuth();
    const [assigning, setAssigning] = useState(false);
    const canAssign = canManageJobs(user) && Boolean(candidate && onChanged && token);
    return (
        <Card className="p-5">
            <section aria-label="Job assignment" className="space-y-4">
                <div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 className="text-headline-sm text-ink">Current processing job</h2>
                        {canAssign && !assignments.current && (
                            <button type="button" onClick={() => setAssigning(true)} className={primaryButton}>Assign to Job</button>
                        )}
                    </div>
                    <div className="mt-2">
                        {assignments.current
                            ? <JobLine job={assignments.current} />
                            : <p className="text-body-sm text-ink-muted">Not assigned to a processing job.</p>}
                    </div>
                </div>
                {assignments.history.length > 0 && (
                    <div>
                        <h3 className="text-label-md text-ink">Job history</h3>
                        <ul className="mt-2 divide-y divide-border">
                            {assignments.history.map((job) => <li key={job.jobId} className="py-3 first:pt-0 last:pb-0"><JobLine job={job} historic /></li>)}
                        </ul>
                    </div>
                )}
            </section>
            {assigning && candidate && token && onChanged && (
                <AssignToJobDialog
                    token={token}
                    candidate={candidate}
                    onClose={() => setAssigning(false)}
                    onAssigned={(details) => {
                        setAssigning(false);
                        onChanged(details);
                    }}
                />
            )}
        </Card>
    );
}

const message = (caught: unknown) => (caught instanceof ApiError ? caught.message : "Something went wrong. Please try again.");

// Pick one PROCESSING job (searchable), confirm, assign. Only PROCESSING jobs are
// requested, so completed and cancelled jobs can't be chosen; the server still
// checks everything (job status, one PROCESSING job per candidate).
function AssignToJobDialog({ token, candidate, onClose, onAssigned }: {
    token: string;
    candidate: { passportId: string; name: string | null };
    onClose: () => void;
    onAssigned: (details: CandidateDetails) => void;
}) {
    const [text, setText] = useState("");
    const [search, setSearch] = useState<string | undefined>(undefined);
    const [page, setPage] = useState(1);
    const [chosen, setChosen] = useState<JobListItem | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const jobs = useAdminResource(`assign-jobs:${search ?? ""}:${page}`, (t, signal) => listJobs(t, { view: "processing", search, page }, signal));
    const name = candidate.name ?? candidate.passportId;

    const submitSearch = (event: FormEvent) => {
        event.preventDefault();
        setSearch(text.trim() || undefined);
        setPage(1);
        setChosen(null);
        setError(null);
    };
    const assign = async () => {
        if (!chosen) return;
        setBusy(true);
        setError(null);
        try {
            await addCandidateToJob(token, chosen.jobId, candidate.passportId);
            // The candidate page and the Share Form read the job from the candidate's details.
            onAssigned(await getCandidate(token, candidate.passportId));
        } catch (caught) {
            setError(message(caught));
            setBusy(false);
        }
    };

    const items = jobs.data?.items ?? [];
    return (
        <ActionDialog title={`Assign ${name} to a job`} busy={busy} onClose={onClose}>
            {!chosen ? (
                <>
                    <p className="text-body-sm text-ink-soft">Only processing jobs are listed. A candidate can be on one processing job at a time.</p>
                    <form onSubmit={submitSearch} role="search" className="mt-3 flex gap-2">
                        <label htmlFor="assign-job-search" className="sr-only">Search jobs</label>
                        <input id="assign-job-search" type="search" value={text} maxLength={100} placeholder="Job code, Company Job ID, company…" onChange={(event) => setText(event.target.value)} className={filterControl} />
                        <button type="submit" className={secondaryButton}>Search</button>
                    </form>
                    {jobs.status === "loading" && !jobs.data && <LoadingState label="Loading jobs…" />}
                    {jobs.status === "error" && <ErrorState message={jobs.error.message} onRetry={jobs.reload} />}
                    {jobs.data && items.length === 0 && (
                        <EmptyState title={search ? "No processing jobs match your search" : "There are no processing jobs"} description={search ? undefined : "Create a job in Admin > Jobs first."} />
                    )}
                    {items.length > 0 && (
                        <ul aria-label="Processing jobs" className="mt-3 max-h-72 divide-y divide-border overflow-y-auto rounded border border-border">
                            {items.map((job) => (
                                <li key={job.jobId} className="flex items-center justify-between gap-3 px-3 py-2">
                                    <div className="min-w-0 text-body-sm">
                                        <p className="font-medium text-ink">{job.jobCode} <span className="font-normal text-ink-muted">· Company Job ID: {job.companyJobId ?? NO_COMPANY_JOB_ID}</span></p>
                                        <p className="text-ink-soft">{job.company.name} · {job.jobType.name}</p>
                                        <p className="text-label-sm text-ink-muted">{job.countryCode} · {job.responsibleAgent.name} · {job.candidateCount} candidate{job.candidateCount === 1 ? "" : "s"}</p>
                                    </div>
                                    <button type="button" className={secondaryButton} aria-label={`Select ${job.jobCode}`} onClick={() => { setChosen(job); setError(null); }}>Select</button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {jobs.data && jobs.data.pagination.totalPages > 1 && (
                        <div className="mt-2 flex items-center justify-between text-body-sm text-ink-muted">
                            <button type="button" className={secondaryButton} disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
                            <span>Page {page} of {jobs.data.pagination.totalPages}</span>
                            <button type="button" className={secondaryButton} disabled={page >= jobs.data.pagination.totalPages} onClick={() => setPage(page + 1)}>Next</button>
                        </div>
                    )}
                    <DialogError message={error} />
                    <div className="mt-4 flex justify-end">
                        <button type="button" className={secondaryButton} onClick={onClose}>Cancel</button>
                    </div>
                </>
            ) : (
                <>
                    <p className="text-body-sm text-ink-soft">
                        Assign <strong>{name}</strong> to <strong>{chosen.jobCode}</strong> ({chosen.company.name}, {chosen.jobType.name})?
                    </p>
                    <DialogError message={error} />
                    <div className="mt-4 flex justify-end gap-2">
                        <button type="button" className={secondaryButton} disabled={busy} onClick={() => { setChosen(null); setError(null); }}>Back</button>
                        <button type="button" className={primaryButton} disabled={busy} onClick={assign}>{busy ? "Assigning…" : "Confirm assignment"}</button>
                    </div>
                </>
            )}
        </ActionDialog>
    );
}
