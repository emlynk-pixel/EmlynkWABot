import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ApiError } from "../api/client";
import { listCandidates, type CandidateListItem } from "../api/candidates";
import { addCandidateToJob, cancelJob, completeJob, getJob, removeCandidateFromJob, updateJob, type JobDetails } from "../api/jobs";
import { useAdminResource } from "../api/useAdminResource";
import { canManageJobs, canViewJobs, useAuth } from "../auth/AuthProvider";
import { ActionDialog, DialogError, dangerSolidButton, primaryButton, secondaryButton } from "../components/Dialog";
import { WorkflowStatusBadge } from "../components/candidate/WorkflowStatusBadge";
import { formatDate, formatDateTime } from "../components/format";
import { Icon } from "../components/Icon";
import { Detail, JobStatusBadge, NO_COMPANY_JOB_ID, VacancyFill, jobCountry } from "../components/job/JobParts";
import { CountrySelect } from "../components/master/MasterParts";
import { Card, ErrorState, LoadingState } from "../components/States";
import { filterControl, inputClass, tableCell, tableHead, tableRow, textareaClass } from "../components/ui";

// Admin > Jobs > one job, in two tabs: Job Details (the default) and Assigned
// Candidates. The tab is page state only (no route): switching keeps every open
// dialog and loaded value, and the actions above the tabs work from either. ADMIN and
// MANAGER add / remove candidates and complete or cancel a PROCESSING job; an
// ANALYST sees the job with only their own candidates. A candidate already on
// another PROCESSING job is refused by the server (409) and the message is
// shown here; nothing is moved silently.

const message = (caught: unknown) => (caught instanceof ApiError ? caught.message : "Something went wrong. Please try again.");

export function JobDetailsPage() {
    const { user } = useAuth();
    if (!canViewJobs(user)) {
        return (
            <div className="mx-auto max-w-4xl p-6">
                <div role="alert" className="rounded border border-critical-border bg-critical-bg p-6 text-center text-critical">
                    <Icon name="lock" className="mx-auto mb-2 size-8 text-critical" />
                    <h1 className="text-headline-sm font-semibold">Access Restricted</h1>
                    <p className="mt-1 text-body-sm text-ink-muted">Your role cannot view jobs.</p>
                </div>
            </div>
        );
    }
    return <JobDetailsView />;
}

type Dialog = "add" | "complete" | "cancel" | "companyJobId" | "fromCountry" | { remove: JobDetails["candidates"][number] } | null;
type Tab = "details" | "candidates";

const tabClass = (active: boolean) =>
    `-mb-px whitespace-nowrap border-b-2 px-1 pb-2.5 pt-1 text-label-md transition-colors ${active
        ? "border-primary font-medium text-ink"
        : "border-transparent text-ink-muted hover:border-border-strong hover:text-ink"}`;

function JobDetailsView() {
    const { user, token } = useAuth();
    const { jobId = "" } = useParams();
    const canManage = canManageJobs(user);
    const resource = useAdminResource(`job:${jobId}`, (t, signal) => getJob(t, jobId, signal));
    const [updated, setUpdated] = useState<JobDetails | null>(null);
    const [dialog, setDialog] = useState<Dialog>(null);
    const [tab, setTab] = useState<Tab>("details");
    const job = updated?.jobId === jobId ? updated : resource.data?.jobId === jobId ? resource.data : null;

    if (!job) {
        return (
            <div className="mx-auto max-w-5xl space-y-4">
                <Link to="/jobs" className="text-label-md text-primary hover:underline">Jobs</Link>
                <Card>{resource.status === "error" ? <ErrorState message={resource.error.message} onRetry={resource.reload} /> : <LoadingState label="Loading job…" />}</Card>
            </div>
        );
    }

    const processing = job.status === "PROCESSING";
    const changed = (next: JobDetails) => {
        setUpdated(next);
        setDialog(null);
    };

    return (
        <section aria-labelledby="page-title" className="mx-auto max-w-5xl space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                    <Link to="/jobs" className="text-label-md text-primary hover:underline">Jobs</Link>
                    <h1 id="page-title" className="mt-1 flex flex-wrap items-center gap-3 text-headline-lg text-ink">{job.jobCode}<JobStatusBadge status={job.status} /></h1>
                </div>
                {canManage && processing && (
                    <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => setDialog("add")} className={`${primaryButton} inline-flex items-center gap-1.5`}><Icon name="person_add" className="size-4" />Add to job</button>
                        <button type="button" onClick={() => setDialog("complete")} className={`${secondaryButton} inline-flex items-center gap-1.5`}><Icon name="task_alt" className="size-4" />Complete job</button>
                        <button type="button" onClick={() => setDialog("cancel")} className={`${secondaryButton} inline-flex items-center gap-1.5`}><Icon name="cancel" className="size-4" />Cancel job</button>
                    </div>
                )}
            </div>

            <div role="tablist" aria-label="Job sections" className="flex gap-6 overflow-x-auto border-b border-border">
                <button type="button" role="tab" id="job-tab-details" aria-controls="job-panel-details" aria-selected={tab === "details"} onClick={() => setTab("details")} className={tabClass(tab === "details")}>Job Details</button>
                <button type="button" role="tab" id="job-tab-candidates" aria-controls="job-panel-candidates" aria-selected={tab === "candidates"} onClick={() => setTab("candidates")} className={tabClass(tab === "candidates")}>Assigned Candidates ({job.candidateCount})</button>
            </div>

            {tab === "details" && (
                <div role="tabpanel" id="job-panel-details" aria-labelledby="job-tab-details">
                    <Card className="p-5">
                        <dl aria-label="Job details" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            <Detail label="Internal job code">{job.jobCode}</Detail>
                            <Detail label="Client Job ID">
                                {job.companyJobId ?? <span className="text-ink-muted">{NO_COMPANY_JOB_ID}</span>}
                                {canManage && <button type="button" onClick={() => setDialog("companyJobId")} aria-label={`${job.companyJobId ? "Change" : "Add"} Client Job ID`} className="ml-2 text-label-md text-primary hover:underline">{job.companyJobId ? "Change" : "Add"}</button>}
                            </Detail>
                            <Detail label="Job type">{job.jobType.name}</Detail>
                            <Detail label="Client">{job.client.name}</Detail>
                            <Detail label="To Country">{jobCountry(job.countryCode)}</Detail>
                            <Detail label="From Country">
                                <span className={job.fromCountryCode ? undefined : "text-ink-muted"}>{jobCountry(job.fromCountryCode)}</span>
                                {canManage && processing && <button type="button" onClick={() => setDialog("fromCountry")} aria-label="Change From Country" className="ml-2 text-label-md text-primary hover:underline">Change</button>}
                            </Detail>
                            <Detail label="Responsible agent">{job.responsibleAgent.name}</Detail>
                            <Detail label="Status">{job.status === "PROCESSING" ? "Processing" : job.status === "COMPLETED" ? "Completed" : "Cancelled"}</Detail>
                            <Detail label="Vacancies">{job.vacancies === null ? "—" : job.vacancies}</Detail>
                            <Detail label="Assigned / vacancies"><VacancyFill job={job} /></Detail>
                            <Detail label="Created">{formatDateTime(job.createdAt)}{job.createdBy ? ` by ${job.createdBy}` : ""}</Detail>
                            {job.status === "COMPLETED" && <Detail label="Completed">{formatDateTime(job.completedAt)}</Detail>}
                            {job.status === "CANCELLED" && <Detail label="Cancelled">{formatDateTime(job.cancelledAt)}</Detail>}
                            {job.status === "CANCELLED" && <Detail label="Cancel reason">{job.cancelReason}</Detail>}
                        </dl>
                    </Card>
                </div>
            )}

            {tab === "candidates" && (
                <div role="tabpanel" id="job-panel-candidates" aria-labelledby="job-tab-candidates">
                    <Card>
                        <div className="border-b border-border px-4 py-3">
                            <div className="flex flex-wrap items-center gap-3">
                                <h2 className="text-headline-sm text-ink">Assigned candidates ({job.candidateCount})</h2>
                                {job.vacancies !== null && <span className="text-body-sm text-ink-muted"><VacancyFill job={job} /></span>}
                            </div>
                            {!processing && <p className="text-body-sm text-ink-muted">This job is {job.status === "COMPLETED" ? "completed" : "cancelled"}; the assignment history is kept.</p>}
                        </div>
                        {job.candidates.length === 0 ? (
                            <p className="px-4 py-8 text-center text-body-sm text-ink-muted">No candidates are assigned to this job.</p>
                        ) : (
                            <div className="relative overflow-x-auto">
                                {/* relative: keeps the sr-only (absolute) Actions header inside this scroll box, so a wide table never widens the page */}
                                <table aria-label="Assigned candidates" className="w-full border-collapse">
                                    <thead>
                                        <tr>
                                            <th className={tableHead}>Name</th>
                                            <th className={tableHead}>Passport / NIC</th>
                                            <th className={tableHead}>Status</th>
                                            <th className={tableHead}>Assigned</th>
                                            {canManage && processing && <th className={tableHead}><span className="sr-only">Actions</span></th>}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {job.candidates.map((candidate) => (
                                            <tr key={candidate.passportId} className={tableRow}>
                                                <td className={tableCell}><Link to={`/candidates/${encodeURIComponent(candidate.passportId)}`} className="font-medium text-primary hover:underline">{candidate.name ?? candidate.passportId}</Link></td>
                                                <td className={tableCell}>
                                                    <span className="block">{candidate.passportId}</span>
                                                    {candidate.nic && <span className="block text-label-sm text-ink-muted">NIC: {candidate.nic}</span>}
                                                </td>
                                                <td className={tableCell}>{candidate.workflowStatus ? <WorkflowStatusBadge status={candidate.workflowStatus} /> : <span className="text-ink-muted">—</span>}</td>
                                                <td className={tableCell}>{formatDate(candidate.assignedAt)}</td>
                                                {canManage && processing && (
                                                    <td className={`${tableCell} text-right`}>
                                                        <button type="button" onClick={() => setDialog({ remove: candidate })} className="text-label-md text-critical hover:underline" aria-label={`Remove ${candidate.name ?? candidate.passportId} from the job`}>Remove</button>
                                                    </td>
                                                )}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </Card>
                </div>
            )}

            {token && dialog === "fromCountry" && <FromCountryDialog token={token} job={job} onDone={changed} onClose={() => setDialog(null)} />}
            {token && dialog === "companyJobId" && <CompanyJobIdDialog token={token} job={job} onDone={changed} onClose={() => setDialog(null)} />}
            {token && dialog === "add" && <AddCandidateDialog token={token} job={job} onChanged={setUpdated} onClose={() => setDialog(null)} />}
            {token && dialog === "complete" && (
                <ConfirmDialog title={`Complete ${job.jobCode}?`} confirmLabel="Complete job" run={() => completeJob(token, job.jobId)} onDone={changed} onClose={() => setDialog(null)}>
                    The job is marked completed. All {job.candidateCount} assignments are kept as history, and the candidates can be assigned to another processing job.
                </ConfirmDialog>
            )}
            {token && dialog === "cancel" && <CancelDialog token={token} job={job} onDone={changed} onClose={() => setDialog(null)} />}
            {token && typeof dialog === "object" && dialog && (
                <ConfirmDialog
                    title="Remove candidate?"
                    confirmLabel="Remove"
                    run={() => removeCandidateFromJob(token, job.jobId, dialog.remove.passportId)}
                    onDone={changed}
                    onClose={() => setDialog(null)}
                >
                    {dialog.remove.name ?? dialog.remove.passportId} is taken off {job.jobCode} (kept in the job&apos;s history) and can be assigned to another processing job.
                </ConfirmDialog>
            )}
        </section>
    );
}

function ConfirmDialog({ title, confirmLabel, run, onDone, onClose, children }: {
    title: string;
    confirmLabel: string;
    run: () => Promise<JobDetails>;
    onDone: (job: JobDetails) => void;
    onClose: () => void;
    children: ReactNode;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const confirm = async () => {
        setBusy(true);
        setError(null);
        try {
            onDone(await run());
        } catch (caught) {
            setError(message(caught));
            setBusy(false);
        }
    };
    return (
        <ActionDialog title={title} busy={busy} onClose={onClose}>
            <p className="text-body-sm text-ink-soft">{children}</p>
            <DialogError message={error} />
            <div className="mt-4 flex justify-end gap-2">
                <button type="button" disabled={busy} onClick={onClose} className={secondaryButton}>Keep as is</button>
                <button type="button" disabled={busy} onClick={confirm} className={primaryButton}>{busy ? "Working…" : confirmLabel}</button>
            </div>
        </ActionDialog>
    );
}

function CancelDialog({ token, job, onDone, onClose }: { token: string; job: JobDetails; onDone: (job: JobDetails) => void; onClose: () => void }) {
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            onDone(await cancelJob(token, job.jobId, reason.trim()));
        } catch (caught) {
            setError(message(caught));
            setBusy(false);
        }
    };
    return (
        <ActionDialog title={`Cancel ${job.jobCode}?`} busy={busy} onClose={onClose}>
            <form onSubmit={submit}>
                <p className="text-body-sm text-ink-soft">The job is marked cancelled. Its {job.candidateCount} assignments are kept as history and the candidates are released.</p>
                <label htmlFor="cancel-reason" className="mt-3 block text-label-md text-ink">Reason for cancelling</label>
                <textarea id="cancel-reason" rows={3} maxLength={500} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} className={textareaClass()} />
                <DialogError message={error} />
                <div className="mt-4 flex justify-end gap-2">
                    <button type="button" disabled={busy} onClick={onClose} className={secondaryButton}>Keep job</button>
                    <button type="submit" disabled={busy || !reason.trim()} className={dangerSolidButton}>{busy ? "Cancelling…" : "Cancel job"}</button>
                </div>
            </form>
        </ActionDialog>
    );
}

// Search the candidates and add them one at a time. The dialog stays open so
// several can be added; a refusal (already on another PROCESSING job, already
// here) is shown next to the search.
function AddCandidateDialog({ token, job, onChanged, onClose }: { token: string; job: JobDetails; onChanged: (job: JobDetails) => void; onClose: () => void }) {
    const [text, setText] = useState("");
    const [results, setResults] = useState<CandidateListItem[] | null>(null);
    const [added, setAdded] = useState<Set<string>>(() => new Set(job.candidates.map((c) => c.passportId)));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const search = async (event: FormEvent) => {
        event.preventDefault();
        const term = text.trim();
        if (!term) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            setResults((await listCandidates(token, { page: 1, pageSize: 100, search: term, testResult: "PASS" })).items.slice(0, 20));
        } catch (caught) {
            setError(message(caught));
        } finally {
            setBusy(false);
        }
    };
    const add = async (candidate: CandidateListItem) => {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const next = await addCandidateToJob(token, job.jobId, candidate.passportId);
            setAdded((previous) => new Set(previous).add(candidate.passportId));
            setNotice(`${candidate.name ?? candidate.passportId} was added.`);
            onChanged(next);
        } catch (caught) {
            setError(message(caught));
        } finally {
            setBusy(false);
        }
    };

    return (
        <ActionDialog title={`Add candidates to ${job.jobCode}`} busy={busy} onClose={onClose}>
            <form onSubmit={search} role="search" className="flex gap-2">
                <label htmlFor="add-candidate-search" className="sr-only">Search candidates</label>
                <input id="add-candidate-search" type="search" value={text} maxLength={100} placeholder="Name, passport ID or NIC" onChange={(event) => setText(event.target.value)} className={filterControl} />
                <button type="submit" disabled={busy || !text.trim()} className={secondaryButton}>Search</button>
            </form>
            <p className="mt-2 text-label-sm text-ink-muted">Only candidates who passed the test can be added to a job.</p>
            {results && results.length === 0 && <p className="mt-3 text-body-sm text-ink-muted">No eligible candidates found.</p>}
            {results && results.length > 0 && (
                <ul aria-label="Candidates found" className="mt-3 divide-y divide-border rounded border border-border">
                    {results.map((candidate) => (
                        <li key={candidate.passportId} className="flex items-center justify-between gap-3 px-3 py-2">
                            <div className="min-w-0">
                                <p className="truncate text-body-sm text-ink">{candidate.name ?? candidate.passportId}</p>
                                <p className="text-label-sm text-ink-muted">{[candidate.passportId, candidate.nic].filter(Boolean).join(" • ")}</p>
                            </div>
                            {added.has(candidate.passportId)
                                ? <span className="text-label-sm text-ink-muted">On this job</span>
                                : <button type="button" disabled={busy} onClick={() => add(candidate)} className={primaryButton} aria-label={`Add ${candidate.name ?? candidate.passportId}`}>Add</button>}
                        </li>
                    ))}
                </ul>
            )}
            {notice && <p role="status" className="mt-3 rounded border border-verified-border bg-verified-bg px-3 py-2 text-body-sm text-verified">{notice}</p>}
            <DialogError message={error} />
            <div className="mt-4 flex justify-end">
                <button type="button" disabled={busy} onClick={onClose} className={secondaryButton}>Done</button>
            </div>
        </ActionDialog>
    );
}

// The From Country (editable while the job is PROCESSING). The To Country is the
// client's and is never edited here.
function FromCountryDialog({ token, job, onDone, onClose }: { token: string; job: JobDetails; onDone: (job: JobDetails) => void; onClose: () => void }) {
    const [value, setValue] = useState(job.fromCountryCode ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            onDone(await updateJob(token, job.jobId, { fromCountryCode: value }));
        } catch (caught) {
            setError(message(caught));
            setBusy(false);
        }
    };
    return (
        <ActionDialog title="From Country" busy={busy} onClose={onClose}>
            <form onSubmit={submit}>
                <p className="mb-3 text-body-sm text-ink-soft">The country the candidates of {job.jobCode} travel from. The To Country ({jobCountry(job.countryCode)}) is the client&apos;s.</p>
                <CountrySelect label="From Country" value={value} onChange={setValue} disabled={busy} />
                <DialogError message={error} />
                <div className="mt-4 flex justify-end gap-2">
                    <button type="button" disabled={busy} onClick={onClose} className={secondaryButton}>Cancel</button>
                    <button type="submit" disabled={busy || !value || value === job.fromCountryCode} className={primaryButton}>{busy ? "Saving…" : "Save"}</button>
                </div>
            </form>
        </ActionDialog>
    );
}

// The employer's own Job ID: a plain label. Changing it never changes the job's identity,
// its candidates (everything uses the internal job id).
function CompanyJobIdDialog({ token, job, onDone, onClose }: { token: string; job: JobDetails; onDone: (job: JobDetails) => void; onClose: () => void }) {
    const [value, setValue] = useState(job.companyJobId ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            onDone(await updateJob(token, job.jobId, { companyJobId: value.trim() || null }));
        } catch (caught) {
            setError(message(caught));
            setBusy(false);
        }
    };
    return (
        <ActionDialog title="Client Job ID" busy={busy} onClose={onClose}>
            <form onSubmit={submit}>
                <p className="text-body-sm text-ink-soft">The employer&apos;s own ID for {job.jobCode} (for example Y26S01). Changing it does not change the job, its candidates.</p>
                <label htmlFor="company-job-id" className="mt-3 block text-label-md text-ink">Client Job ID</label>
                <input id="company-job-id" value={value} maxLength={40} disabled={busy} onChange={(event) => setValue(event.target.value)} className={`${inputClass()} mt-1`} />
                <p className="mt-1 text-label-sm text-ink-muted">Letters, digits, spaces and . _ / # - ; saved in capitals. Leave empty to clear it.</p>
                <DialogError message={error} />
                <div className="mt-4 flex justify-end gap-2">
                    <button type="button" disabled={busy} onClick={onClose} className={secondaryButton}>Cancel</button>
                    <button type="submit" disabled={busy || value.trim() === (job.companyJobId ?? "")} className={primaryButton}>{busy ? "Saving…" : "Save"}</button>
                </div>
            </form>
        </ActionDialog>
    );
}
