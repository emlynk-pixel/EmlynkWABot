import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import {
    createAgent,
    createCompany,
    createJob,
    createJobType,
    getJobOptions,
    JOB_VIEWS,
    listJobs,
    type JobOptions,
    type JobView,
} from "../api/jobs";
import { useAdminResource } from "../api/useAdminResource";
import { canManageJobs, canViewJobs, useAuth } from "../auth/AuthProvider";
import { Pager } from "../components/ClientTable";
import { ActionDialog, DialogError, primaryButton, secondaryButton } from "../components/Dialog";
import { formatNumber } from "../components/format";
import { Icon } from "../components/Icon";
import { JobStatusBadge, NO_COMPANY_JOB_ID, jobDateNote } from "../components/job/JobParts";
import { Card, EmptyState, ErrorState, LoadingState } from "../components/States";
import { filterControl, inputClass, tableCell, tableHead, tableRow } from "../components/ui";

// Admin > Jobs: Processing / Completed / Cancelled views of the jobs, newest
// first, paged on the server. ADMIN and MANAGER create and manage jobs; an
// ANALYST sees only jobs holding their own candidates (the server scopes the
// list and the candidate counts). The view, search and page live in the URL.

const message = (caught: unknown) => (caught instanceof ApiError ? caught.message : "Something went wrong. Please try again.");

export function JobsPage() {
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
    return <JobsView />;
}

function JobsView() {
    const { user, token } = useAuth();
    const navigate = useNavigate();
    const canManage = canManageJobs(user);
    const [searchParams, setSearchParams] = useSearchParams();
    const requested = searchParams.get("view");
    const view: JobView = JOB_VIEWS.find((v) => v.view === requested)?.view ?? "processing";
    const search = searchParams.get("search") || undefined;
    const pageNumber = Number(searchParams.get("page"));
    const page = Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1;
    const [searchText, setSearchText] = useState(search ?? "");
    useEffect(() => setSearchText(search ?? ""), [search]);
    const [creating, setCreating] = useState(false);

    const list = useAdminResource(`jobs?${searchParams.toString()}`, (t, signal) => listJobs(t, { view, search, page }, signal));

    const go = (changes: Record<string, string | null>) => {
        const next = new URLSearchParams(searchParams);
        for (const [key, value] of Object.entries(changes)) {
            if (value) next.set(key, value);
            else next.delete(key);
        }
        if (!("page" in changes)) next.delete("page");
        setSearchParams(next);
    };
    const submitSearch = (event: FormEvent) => {
        event.preventDefault();
        go({ search: searchText.trim() || null });
    };

    const items = list.status === "error" ? [] : list.data?.items ?? [];
    const counts = list.data?.counts;

    return (
        <section aria-labelledby="page-title" className="mx-auto max-w-6xl space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 id="page-title" className="text-headline-lg text-ink">Jobs</h1>
                    <p className="text-body-sm text-ink-muted">
                        {canManage ? "Jobs and the candidates assigned to them." : "Jobs that include candidates allocated to you."}
                    </p>
                </div>
                {canManage && token && (
                    <button type="button" onClick={() => setCreating(true)} className={`${primaryButton} inline-flex items-center gap-1.5`}>
                        <Icon name="work" className="size-4" />New job
                    </button>
                )}
            </div>

            <Card>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                    <div role="tablist" aria-label="Job status" className="flex gap-1">
                        {JOB_VIEWS.map((v) => (
                            <button
                                key={v.view}
                                type="button"
                                role="tab"
                                aria-selected={v.view === view}
                                onClick={() => go({ view: v.view === "processing" ? null : v.view })}
                                className={`h-8 rounded px-3 text-label-md ${v.view === view ? "bg-primary text-on-primary" : "text-ink-soft hover:bg-canvas"}`}
                            >
                                {v.label}{counts ? ` (${formatNumber(counts[v.view])})` : ""}
                            </button>
                        ))}
                    </div>
                    <form onSubmit={submitSearch} role="search" className="flex items-center gap-2">
                        <label htmlFor="job-search" className="sr-only">Search jobs</label>
                        <input
                            id="job-search"
                            type="search"
                            value={searchText}
                            maxLength={100}
                            placeholder="Job code, Company Job ID, company, agent…"
                            onChange={(event) => setSearchText(event.target.value)}
                            className={`${filterControl} w-64`}
                        />
                        <button type="submit" className={secondaryButton}>Search</button>
                    </form>
                </div>

                {list.status === "loading" && !list.data && <LoadingState label="Loading jobs…" />}
                {list.status === "error" && <ErrorState message={list.error.message} onRetry={list.reload} />}
                {list.status !== "error" && list.data && items.length === 0 && (
                    <EmptyState
                        title={search ? "No jobs match your search" : `No ${view} jobs`}
                        description={canManage && view === "processing" && !search ? "Create a job to start assigning candidates." : undefined}
                    />
                )}
                {items.length > 0 && (
                    <div className="overflow-x-auto">
                        <table aria-label="Jobs" className="w-full border-collapse">
                            <thead>
                                <tr>
                                    <th className={tableHead}>Job code</th>
                                    <th className={tableHead}>Company Job ID</th>
                                    <th className={tableHead}>Job type</th>
                                    <th className={tableHead}>Country</th>
                                    <th className={tableHead}>Company</th>
                                    <th className={tableHead}>Responsible agent</th>
                                    <th className={`${tableHead} text-right`}>Candidates</th>
                                    <th className={`${tableHead} text-right`}>Vacancies</th>
                                    <th className={tableHead}>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {items.map((job) => (
                                    <tr key={job.jobId} className={tableRow}>
                                        <td className={tableCell}>
                                            <Link to={`/jobs/${job.jobId}`} className="font-medium text-primary hover:underline">{job.jobCode}</Link>
                                            <div className="text-label-sm text-ink-muted">{jobDateNote(job)}</div>
                                        </td>
                                        <td className={tableCell}>{job.companyJobId ?? <span className="text-ink-muted">{NO_COMPANY_JOB_ID}</span>}</td>
                                        <td className={tableCell}>{job.jobType.name}</td>
                                        <td className={tableCell}>{job.countryCode}</td>
                                        <td className={tableCell}>{job.company.name}</td>
                                        <td className={tableCell}>{job.responsibleAgent.name}</td>
                                        <td className={`${tableCell} text-right tabular-nums`}>{formatNumber(job.candidateCount)}</td>
                                        <td className={`${tableCell} text-right tabular-nums`}>{job.vacancies === null ? "—" : formatNumber(job.vacancies)}</td>
                                        <td className={tableCell}><JobStatusBadge status={job.status} /></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {list.data && items.length > 0 && <Pager pagination={list.data.pagination} noun={["job", "jobs"]} onPage={(next) => go({ page: next > 1 ? String(next) : null })} />}
            </Card>

            {creating && token && (
                <NewJobDialog
                    token={token}
                    onClose={() => setCreating(false)}
                    onCreated={(jobId) => {
                        setCreating(false);
                        navigate(`/jobs/${jobId}`);
                    }}
                />
            )}
        </section>
    );
}

// A reference list (job type, company, agent) with an inline "add new" row, so
// the first jobs can be created without a separate management screen.
function ReferenceSelect({ label, value, onChange, options, disabled, adding, onAdd, extraField }: {
    label: string;
    value: string;
    onChange: (id: string) => void;
    options: { id: string; label: string }[];
    disabled: boolean;
    adding: string;
    onAdd: (name: string, extra: string) => Promise<void>;
    extraField?: { label: string; placeholder: string };
}) {
    const id = useId();
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [extra, setExtra] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const add = async () => {
        setBusy(true);
        setError(null);
        try {
            await onAdd(name.trim(), extra.trim());
            setOpen(false);
            setName("");
            setExtra("");
        } catch (caught) {
            setError(message(caught));
        } finally {
            setBusy(false);
        }
    };
    return (
        <div>
            <div className="flex items-center justify-between">
                <label htmlFor={id} className="text-label-md text-ink">{label}</label>
                <button type="button" onClick={() => setOpen((v) => !v)} disabled={disabled} className="text-label-sm text-primary hover:underline">{open ? "Cancel" : adding}</button>
            </div>
            {open ? (
                <div className="mt-1 space-y-2 rounded border border-border bg-canvas p-2">
                    <input aria-label={`${label} name`} value={name} maxLength={120} placeholder="Name" onChange={(event) => setName(event.target.value)} className={inputClass()} />
                    {extraField && <input aria-label={extraField.label} value={extra} maxLength={2} placeholder={extraField.placeholder} onChange={(event) => setExtra(event.target.value.toUpperCase())} className={inputClass()} />}
                    <button type="button" disabled={busy || !name.trim() || (Boolean(extraField) && extra.trim().length !== 2)} onClick={add} className={primaryButton}>{`Save ${label.toLowerCase()}`}</button>
                    <DialogError message={error} />
                </div>
            ) : (
                <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className={`${inputClass()} mt-1`}>
                    <option value="">Select…</option>
                    {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
            )}
        </div>
    );
}

function NewJobDialog({ token, onClose, onCreated }: { token: string; onClose: () => void; onCreated: (jobId: string) => void }) {
    const options = useAdminResource("job-options", (t, signal) => getJobOptions(t, signal));
    const [created, setCreated] = useState<Partial<JobOptions>>({});
    const [jobTypeId, setJobTypeId] = useState("");
    const [companyId, setCompanyId] = useState("");
    const [agentId, setAgentId] = useState("");
    const [vacancies, setVacancies] = useState("");
    const [companyJobId, setCompanyJobId] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const vacanciesId = useId();
    const companyJobIdField = useId();

    const merged = <K extends keyof JobOptions>(key: K): JobOptions[K] => {
        const loaded = (options.data?.[key] ?? []) as JobOptions[K];
        const added = (created[key] ?? []) as JobOptions[K];
        return [...loaded, ...added] as JobOptions[K];
    };
    const agent = merged("agents").find((a) => a.id === agentId);
    const vacanciesNumber = vacancies.trim() === "" ? null : Number(vacancies);
    const vacanciesValid = vacanciesNumber === null || (Number.isInteger(vacanciesNumber) && vacanciesNumber >= 1 && vacanciesNumber <= 100000);
    const ready = Boolean(jobTypeId && companyId && agentId) && vacanciesValid;

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (!ready) return;
        setBusy(true);
        setError(null);
        try {
            const job = await createJob(token, { jobTypeId, companyId, responsibleAgentId: agentId, vacancies: vacanciesNumber, companyJobId: companyJobId.trim() || null });
            onCreated(job.jobId);
        } catch (caught) {
            setError(message(caught));
            setBusy(false);
        }
    };

    return (
        <ActionDialog title="New job" busy={busy} onClose={onClose}>
            {options.status === "loading" && !options.data && <LoadingState label="Loading…" />}
            {options.status === "error" && <ErrorState message={options.error.message} onRetry={options.reload} />}
            {options.data && (
                <form onSubmit={submit} className="space-y-3">
                    <ReferenceSelect
                        label="Job type" value={jobTypeId} onChange={setJobTypeId} disabled={busy} adding="Add job type"
                        options={merged("jobTypes").map((o) => ({ id: o.id, label: o.name }))}
                        onAdd={async (name) => {
                            const row = await createJobType(token, name);
                            setCreated((c) => ({ ...c, jobTypes: [...(c.jobTypes ?? []), row] }));
                            setJobTypeId(row.id);
                        }}
                    />
                    <ReferenceSelect
                        label="Company" value={companyId} onChange={setCompanyId} disabled={busy} adding="Add company"
                        options={merged("companies").map((o) => ({ id: o.id, label: o.name }))}
                        onAdd={async (name) => {
                            const row = await createCompany(token, name);
                            setCreated((c) => ({ ...c, companies: [...(c.companies ?? []), row] }));
                            setCompanyId(row.id);
                        }}
                    />
                    <ReferenceSelect
                        label="Responsible agent" value={agentId} onChange={setAgentId} disabled={busy} adding="Add agent"
                        options={merged("agents").map((o) => ({ id: o.id, label: `${o.name} (${o.countryCode})` }))}
                        extraField={{ label: "Agent country code", placeholder: "Country code, e.g. RO" }}
                        onAdd={async (name, country) => {
                            const row = await createAgent(token, name, country);
                            setCreated((c) => ({ ...c, agents: [...(c.agents ?? []), row] }));
                            setAgentId(row.id);
                        }}
                    />
                    <div>
                        <label htmlFor={vacanciesId} className="text-label-md text-ink">Vacancies <span className="text-ink-muted">(optional)</span></label>
                        <input id={vacanciesId} inputMode="numeric" value={vacancies} disabled={busy} onChange={(event) => setVacancies(event.target.value)} className={`${inputClass(!vacanciesValid)} mt-1`} />
                        {!vacanciesValid && <p className="mt-1 text-label-sm text-critical">Enter a whole number from 1 to 100000, or leave it empty.</p>}
                    </div>
                    <div>
                        <label htmlFor={companyJobIdField} className="text-label-md text-ink">Company Job ID <span className="text-ink-muted">(optional, the employer&apos;s own ID; can be added later)</span></label>
                        <input id={companyJobIdField} value={companyJobId} maxLength={40} disabled={busy} onChange={(event) => setCompanyJobId(event.target.value)} className={`${inputClass()} mt-1`} />
                    </div>
                    <p className="text-body-sm text-ink-muted">Country: {agent ? agent.countryCode : "taken from the responsible agent"}. The job code is generated when you save.</p>
                    <DialogError message={error} />
                    <div className="flex justify-end gap-2 pt-1">
                        <button type="button" disabled={busy} onClick={onClose} className={secondaryButton}>Cancel</button>
                        <button type="submit" disabled={busy || !ready} className={primaryButton}>{busy ? "Creating…" : "Create job"}</button>
                    </div>
                </form>
            )}
        </ActionDialog>
    );
}
