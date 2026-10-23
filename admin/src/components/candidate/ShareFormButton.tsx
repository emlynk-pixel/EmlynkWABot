import { useEffect, useState } from "react";
import { ApiError } from "../../api/client";
import { createFormShareLink, getFormShareStatus, revokeFormShareLink, type CreatedFormShareLink, type FormShareStatus } from "../../api/candidates";
import { createJobGroupShareLink, getJobGroupShareStatus, revokeJobGroupShareLink, type CandidateJobAssignment, type CreatedJobGroupShareLink, type JobGroupShareStatus } from "../../api/jobs";
import { canManageJobs, useAuth } from "../../auth/AuthProvider";
import { ActionDialog, DialogError, dangerButton, primaryButton, secondaryButton } from "../Dialog";
import { formatDateTime } from "../format";

// "Share Form": a link that opens the public Candidate Form for THIS
// candidate only. The candidate must still verify with their Passport Number
// and NIC; the form is locked until a link exists, and locked for good once
// they submit (src/services/candidateFormShareService.js).
//
// The link is shown ONCE, right after it is created (only a hash is stored).
// Creating a new link replaces the old one; revoking locks the form again.
//
// ADMIN and MANAGER also get "Share link for the job group": one link for every
// candidate on one of the candidate's PROCESSING jobs (chosen when they hold several;
// bound to the job's immutable id;
// each candidate still verifies with their own Passport and NIC and submits once).
// Like the personal link it is shown once, here, and is gone when the dialog closes.
export function ShareFormButton({ passportId, currentJob = null, activeJobs }: { passportId: string; currentJob?: CandidateJobAssignment | null; activeJobs?: CandidateJobAssignment[] }) {
    const [open, setOpen] = useState(false);
    const jobs = (activeJobs ?? (currentJob ? [currentJob] : [])).filter((job) => job.status === "PROCESSING");
    return (
        <>
            <button type="button" className={secondaryButton} onClick={() => setOpen(true)}>Share Form</button>
            {open && <ShareFormDialog passportId={passportId} jobs={jobs} onClose={() => setOpen(false)} />}
        </>
    );
}

const STATE_TEXT: Record<FormShareStatus["state"], string> = {
    LOCKED: "Locked: no active link. The candidate cannot open the form.",
    OPEN: "Open: the candidate can open the form with the link and verify.",
    SUBMITTED: "Submitted: the form is locked and can't be changed or shared again.",
};

function ShareFormDialog({ passportId, jobs, onClose }: { passportId: string; jobs: CandidateJobAssignment[]; onClose: () => void }) {
    const { token } = useAuth();
    const [status, setStatus] = useState<FormShareStatus | null>(null);
    const [created, setCreated] = useState<CreatedFormShareLink | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [confirmRevoke, setConfirmRevoke] = useState(false);

    useEffect(() => {
        if (!token) return undefined;
        const controller = new AbortController();
        getFormShareStatus(token, passportId, controller.signal)
            .then(setStatus)
            .catch((e: unknown) => {
                if ((e as Error)?.name === "AbortError") return;
                setError(e instanceof ApiError ? e.message : "The share status could not be loaded.");
            });
        return () => controller.abort();
    }, [token, passportId]);

    const run = async (action: () => Promise<void>) => {
        if (!token || busy) return;
        setBusy(true);
        setError(null);
        try {
            await action();
        } catch (e) {
            setError(e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
        } finally {
            setBusy(false);
        }
    };
    const create = () => run(async () => {
        const result = await createFormShareLink(token!, passportId);
        setCreated(result);
        setStatus(result.status);
        setCopied(false);
        setConfirmRevoke(false);
    });
    const revoke = () => run(async () => {
        setStatus(await revokeFormShareLink(token!, passportId));
        setCreated(null);
        setConfirmRevoke(false);
    });
    const copy = async () => {
        if (!created) return;
        try {
            await navigator.clipboard.writeText(created.url);
            setCopied(true);
        } catch {
            setError("Copy didn't work in this browser. Select the link and copy it.");
        }
    };

    const whatsappText = created ? encodeURIComponent(`Please fill in your details for Emlynk using this link. You will need your Passport Number and NIC Number.\n${created.url}`) : "";

    return (
        <ActionDialog title="Share the Candidate Form" busy={busy} onClose={onClose}>
            <p className="text-body-sm text-ink-soft">
                The link opens the form for this candidate only. They must verify with their own Passport Number and NIC Number, and can submit once.
            </p>

            {!status && !error && <p role="status" className="mt-3 text-body-sm text-ink-muted">Loading…</p>}
            {status && (
                <div className="mt-3 rounded border border-border bg-canvas px-3 py-2 text-body-sm" role="status">
                    <p className="font-medium text-ink">{STATE_TEXT[status.state]}</p>
                    {status.link && (
                        <p className="mt-1 text-ink-muted">
                            Link created {formatDateTime(status.link.createdAt)}{status.link.createdByName ? ` by ${status.link.createdByName}` : ""}; expires {formatDateTime(status.link.expiresAt)}.
                            {status.link.lockedUntil && ` Locked after too many wrong attempts until ${formatDateTime(status.link.lockedUntil)}.`}
                        </p>
                    )}
                    {status.submittedAt && <p className="mt-1 text-ink-muted">Submitted {formatDateTime(status.submittedAt)}.</p>}
                </div>
            )}

            {created && (
                <div className="mt-3 space-y-2">
                    <label htmlFor="share-link-url" className="block text-label-md text-ink">Share link for this candidate</label>
                    <input id="share-link-url" readOnly value={created.url} onFocus={(e) => e.currentTarget.select()} className="h-9 w-full rounded border border-border-strong bg-surface px-2 text-body-sm text-ink" />
                    <p className="text-label-sm text-ink-muted">
                        Shown only now: if it is lost, create a new link. Send it only to the candidate. Expires {formatDateTime(created.expiresAt)}.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <button type="button" className={primaryButton} onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
                        <a className={`${secondaryButton} inline-flex items-center`} href={`https://wa.me/?text=${whatsappText}`} target="_blank" rel="noopener noreferrer">Share on WhatsApp</a>
                    </div>
                </div>
            )}

            <DialogError message={error} />

            {status && status.state !== "SUBMITTED" && (
                <div className="mt-4 flex flex-wrap justify-end gap-2">
                    {status.state === "OPEN" && !confirmRevoke && (
                        <button type="button" className={dangerButton} disabled={busy} onClick={() => setConfirmRevoke(true)}>Revoke link</button>
                    )}
                    {confirmRevoke && (
                        <>
                            <span className="self-center text-body-sm text-ink-soft">Revoke the link and lock the form?</span>
                            <button type="button" className={secondaryButton} disabled={busy} onClick={() => setConfirmRevoke(false)}>Keep it</button>
                            <button type="button" className={dangerButton} disabled={busy} onClick={revoke}>Revoke</button>
                        </>
                    )}
                    {!confirmRevoke && (
                        <button type="button" className={primaryButton} disabled={busy} onClick={create}>
                            {busy ? "Working…" : status.state === "OPEN" ? "Create a new link (replaces the current one)" : "Create share link"}
                        </button>
                    )}
                </div>
            )}
            <JobGroupSection jobs={jobs} />
            <div className="mt-3 flex justify-end">
                <button type="button" className={secondaryButton} disabled={busy} onClick={onClose}>Close</button>
            </div>
        </ActionDialog>
    );
}

const whatsappLink = (url: string) => `https://wa.me/?text=${encodeURIComponent(`Please fill in your details for Emlynk using this link. You will need your Passport Number and NIC Number.\n${url}`)}`;

// "Share link for the job group". Only for roles that manage jobs; needs the
// candidate to be on a PROCESSING job (otherwise disabled, with the reason). With
// several, the job is chosen first (the newest is preselected).
function JobGroupSection({ jobs }: { jobs: CandidateJobAssignment[] }) {
    const [selectedId, setSelectedId] = useState<string | null>(jobs[0]?.jobId ?? null);
    const currentJob = jobs.find((job) => job.jobId === selectedId) ?? jobs[0] ?? null;
    const { user, token } = useAuth();
    const [status, setStatus] = useState<JobGroupShareStatus | null>(null);
    const [created, setCreated] = useState<CreatedJobGroupShareLink | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [confirm, setConfirm] = useState<"create" | "revoke" | null>(null);
    const manages = canManageJobs(user);
    const jobId = currentJob && currentJob.status === "PROCESSING" ? currentJob.jobId : null;

    useEffect(() => {
        setStatus(null);
        setCreated(null);
        setError(null);
        if (!token || !jobId || !manages) return undefined;
        const controller = new AbortController();
        getJobGroupShareStatus(token, jobId, controller.signal)
            .then(setStatus)
            .catch((e: unknown) => {
                if ((e as Error)?.name === "AbortError") return;
                setError(e instanceof ApiError ? e.message : "The job-group status could not be loaded.");
            });
        return () => controller.abort();
    }, [token, jobId, manages]);

    if (!manages) return null;

    const run = async (action: () => Promise<void>) => {
        if (!token || busy) return;
        setBusy(true);
        setError(null);
        try {
            await action();
        } catch (e) {
            setError(e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
        } finally {
            setBusy(false);
            setConfirm(null);
        }
    };
    const create = () => run(async () => {
        const result = await createJobGroupShareLink(token!, jobId!);
        setCreated(result);
        setStatus(result.status);
        setCopied(false);
    });
    const revoke = () => run(async () => {
        setStatus(await revokeJobGroupShareLink(token!, jobId!));
        setCreated(null);
    });
    const copy = async () => {
        if (!created) return;
        try {
            await navigator.clipboard.writeText(created.url);
            setCopied(true);
        } catch {
            setError("Copy did not work in this browser. Select the link and copy it.");
        }
    };

    return (
        <section aria-label="Job group" className="mt-5 border-t border-border pt-4">
            <h3 className="text-label-md font-semibold text-ink">Share link for the job group</h3>
            {!jobId && (
                <>
                    <p className="mt-1 text-body-sm text-ink-muted">This candidate is not on a processing job. Add them to a job in Admin &gt; Jobs to share a job-group link.</p>
                    <button type="button" disabled className={`${secondaryButton} mt-2`}>Create job-group link</button>
                </>
            )}
            {jobs.length > 1 && (
                <div className="mt-2">
                    <label htmlFor="group-link-job" className="mb-1 block text-label-sm text-ink-muted">Job ({jobs.length} processing jobs)</label>
                    <select id="group-link-job" value={currentJob?.jobId ?? ""} disabled={busy} onChange={(event) => { setSelectedId(event.target.value); setConfirm(null); }} className="h-9 w-full rounded border border-border-strong bg-surface px-2 text-body-sm text-ink">
                        {jobs.map((job) => <option key={job.jobId} value={job.jobId}>{job.jobCode} · {job.jobType.name}</option>)}
                    </select>
                </div>
            )}
            {jobId && currentJob && (
                <>
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 rounded border border-border bg-canvas px-3 py-2 text-body-sm">
                        <dt className="text-ink-muted">Job code</dt><dd className="text-ink">{currentJob.jobCode}</dd>
                        <dt className="text-ink-muted">Client Job ID</dt><dd className="text-ink">{currentJob.companyJobId ?? "Not assigned"}</dd>
                        <dt className="text-ink-muted">Client</dt><dd className="text-ink">{currentJob.client.name}</dd>
                        <dt className="text-ink-muted">Job type</dt><dd className="text-ink">{currentJob.jobType.name}</dd>
                        {status && (
                            <>
                                <dt className="text-ink-muted">Candidates on the job</dt><dd className="text-ink">{status.counts.candidates}</dd>
                                <dt className="text-ink-muted">Already submitted</dt><dd className="text-ink">{status.counts.submitted}</dd>
                            </>
                        )}
                    </dl>
                    {status && (
                        <p role="status" className="mt-2 text-body-sm text-ink-soft">
                            {status.state === "OPEN" && status.link
                                ? `A group link is open (created ${formatDateTime(status.link.createdAt)}${status.link.createdByName ? ` by ${status.link.createdByName}` : ""}; expires ${formatDateTime(status.link.expiresAt)}).`
                                : "No active group link."}
                        </p>
                    )}
                    {created && (
                        <div className="mt-2 space-y-2">
                            <label htmlFor="group-link-url" className="block text-label-md text-ink">Job-group link</label>
                            <input id="group-link-url" readOnly value={created.url} onFocus={(e) => e.currentTarget.select()} className="h-9 w-full rounded border border-border-strong bg-surface px-2 text-body-sm text-ink" />
                            <p className="text-label-sm text-ink-muted">Shown only now: if it is lost, create a new group link. Each candidate must verify with their own Passport Number and NIC Number. Expires {formatDateTime(created.expiresAt)}.</p>
                            <div className="flex flex-wrap gap-2">
                                <button type="button" className={primaryButton} onClick={copy}>{copied ? "Copied" : "Copy group link"}</button>
                                <a className={`${secondaryButton} inline-flex items-center`} href={whatsappLink(created.url)} target="_blank" rel="noopener noreferrer">Share group link on WhatsApp</a>
                            </div>
                        </div>
                    )}
                    <DialogError message={error} />
                    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                        {confirm === "create" && (
                            <>
                                <span className="text-body-sm text-ink-soft">Open the form for everyone on {currentJob.jobCode}{status?.state === "OPEN" ? " and replace the current group link" : ""}?</span>
                                <button type="button" className={secondaryButton} disabled={busy} onClick={() => setConfirm(null)}>Not now</button>
                                <button type="button" className={primaryButton} disabled={busy} onClick={create}>{busy ? "Working…" : "Yes, create link"}</button>
                            </>
                        )}
                        {confirm === "revoke" && (
                            <>
                                <span className="text-body-sm text-ink-soft">Revoke the group link? Candidates who have not submitted lose access.</span>
                                <button type="button" className={secondaryButton} disabled={busy} onClick={() => setConfirm(null)}>Keep it</button>
                                <button type="button" className={dangerButton} disabled={busy} onClick={revoke}>Revoke group link</button>
                            </>
                        )}
                        {!confirm && (
                            <>
                                {status?.state === "OPEN" && <button type="button" className={dangerButton} disabled={busy} onClick={() => setConfirm("revoke")}>Revoke group link</button>}
                                <button type="button" className={secondaryButton} disabled={busy || !status} onClick={() => setConfirm("create")}>
                                    {status?.state === "OPEN" ? "Create a new group link (replaces the current one)" : "Create job-group link"}
                                </button>
                            </>
                        )}
                    </div>
                </>
            )}
        </section>
    );
}
