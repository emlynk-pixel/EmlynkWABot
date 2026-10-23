import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ApiError } from "../../api/client";
import { activeJobsOf, getCandidate, type CandidateDetails, type JobAssignments } from "../../api/candidates";
import { addCandidateToJob, listJobs, type CandidateJobAssignment, type JobListItem } from "../../api/jobs";
import { useAdminResource } from "../../api/useAdminResource";
import { canManageCandidates, canManageJobs, canViewJobs, useAuth } from "../../auth/AuthProvider";
import { ActionDialog, DialogError, primaryButton, secondaryButton } from "../Dialog";
import { formatDate } from "../format";
import { Detail, JobStatusBadge, NO_COMPANY_JOB_ID } from "../job/JobParts";
import { Card, EmptyState, ErrorState, LoadingState } from "../States";
import { filterControl } from "../ui";

// The candidate's Job assignments, read from the Job relation (job_candidate): every
// PROCESSING job they are on now (a candidate may hold several), and the completed /
// cancelled / removed history. Never from the old free-text candidate_stages.job_id.
//
// ADMIN and MANAGER get "Assign to Job" (also when the candidate already has jobs). It uses
// the same endpoint as Add to job on the Job page (POST /api/admin/jobs/:jobId/candidates);
// the server refuses the same job twice (409), and other jobs are never touched.
// Only a candidate whose Test result is PASS can be assigned (the server also
// refuses others with CANDIDATE_TEST_NOT_PASSED), so the button stays disabled until then.

function JobLine({ job, historic = false }: { job: CandidateJobAssignment; historic?: boolean }) {
    const { user } = useAuth();
    const code = canViewJobs(user) ? <Link to={`/jobs/${job.jobId}`} className="font-medium text-primary hover:underline">{job.jobCode}</Link> : <span className="font-medium">{job.jobCode}</span>;
    return (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Detail label="Internal job code">{code}</Detail>
            <Detail label="Client Job ID">{job.companyJobId ?? <span className="text-ink-muted">Not assigned</span>}</Detail>
            <Detail label="Job type">{job.jobType.name}</Detail>
            <Detail label="Client">{job.client.name}</Detail>
            <Detail label="Responsible agent">{job.responsibleAgent.name}</Detail>
            {!historic && <Detail label="Status"><JobStatusBadge status={job.status} /></Detail>}
            {historic && <Detail label="Status">{job.removed ? "Removed" : <JobStatusBadge status={job.status} />}</Detail>}
            {historic && <Detail label="Assigned">{formatDate(job.assignedAt)}</Detail>}
            {historic && job.status === "CANCELLED" && job.cancelReason && <Detail label="Cancel reason">{job.cancelReason}</Detail>}
        </dl>
    );
}

export function JobAssignmentPanel({ assignments, candidate, testPassed = false, onChanged }: {
    assignments: JobAssignments;
    // Test details > Test result is PASS.
    testPassed?: boolean;
    candidate?: { passportId: string; name: string | null };
    // Told with the candidate's fresh details after an assignment, so this card
    // and the Share Form (which reads the current job) update at once.
    onChanged?: (details: CandidateDetails) => void;
}) {
    const { user, token } = useAuth();
    const [assigning, setAssigning] = useState(false);
    // A JOB_HANDLER reads this page only (it assigns from the Jobs module): the action is offered
    // to roles that both manage jobs and change candidates (ADMIN and MANAGER, as before).
    const canAssign = canManageJobs(user) && canManageCandidates(user) && Boolean(candidate && onChanged && token);
    const active = activeJobsOf(assignments);
    return (
        <Card className="p-5">
            <section aria-label="Job assignment" className="space-y-4">
                <div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 className="text-headline-sm text-ink">{active.length > 1 ? `Current processing jobs (${active.length})` : "Current processing job"}</h2>
                        {canAssign && (
                            <button type="button" disabled={!testPassed} title={testPassed ? undefined : "Only a candidate who passed the test can be assigned to a job"} onClick={() => setAssigning(true)} className={primaryButton}>Assign to Job</button>
                        )}
                    </div>
                    <div className="mt-2">
                        {active.length > 0
                            ? (
                                <ul aria-label="Current processing jobs" className="divide-y divide-border">
                                    {active.map((job) => <li key={job.jobId} className="py-3 first:pt-0 last:pb-0"><JobLine job={job} /></li>)}
                                </ul>
                            )
                            : <p className="text-body-sm text-ink-muted">Not assigned to a processing job.{canAssign && !testPassed && " Only a candidate whose Test result is PASS can be assigned."}</p>}
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
                    assignedJobIds={active.map((job) => job.jobId)}
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
// requested, so completed and cancelled jobs can't be chosen; jobs the candidate is
// already on are shown but can't be picked. The server still checks everything.
function AssignToJobDialog({ token, candidate, assignedJobIds = [], onClose, onAssigned }: {
    token: string;
    candidate: { passportId: string; name: string | null };
    assignedJobIds?: readonly string[];
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
                    <p className="text-body-sm text-ink-soft">Only processing jobs are listed. A candidate can be on several processing jobs, but only once on each.</p>
                    <form onSubmit={submitSearch} role="search" className="mt-3 flex gap-2">
                        <label htmlFor="assign-job-search" className="sr-only">Search jobs</label>
                        <input id="assign-job-search" type="search" value={text} maxLength={100} placeholder="Job code, Client Job ID, client…" onChange={(event) => setText(event.target.value)} className={filterControl} />
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
                                        <p className="font-medium text-ink">{job.jobCode} <span className="font-normal text-ink-muted">· Client Job ID: {job.companyJobId ?? NO_COMPANY_JOB_ID}</span></p>
                                        <p className="text-ink-soft">{job.client.name} · {job.jobType.name}</p>
                                        <p className="text-label-sm text-ink-muted">{job.countryCode} · {job.responsibleAgent.name} · {job.candidateCount} candidate{job.candidateCount === 1 ? "" : "s"}</p>
                                    </div>
                                    {assignedJobIds.includes(job.jobId)
                                        ? <span className="shrink-0 text-label-sm text-ink-muted">Already assigned</span>
                                        : <button type="button" className={secondaryButton} aria-label={`Select ${job.jobCode}`} onClick={() => { setChosen(job); setError(null); }}>Select</button>}
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
                        Assign <strong>{name}</strong> to <strong>{chosen.jobCode}</strong> ({chosen.client.name}, {chosen.jobType.name})?
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
