import { useEffect, useId, useState, type FormEvent } from "react";
import { listCandidates, type CandidateList, type CandidateListItem } from "../api/candidates";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import {
    createJob,
    createJobType,
    DEFAULT_FROM_COUNTRY,
    getJobOptions,
    JOB_VIEWS,
    jobViewCount,
    listJobs,
    type JobOptions,
    type JobView,
} from "../api/jobs";
import { useAdminResource } from "../api/useAdminResource";
import { canCreateJobTypes, canManageJobs, canViewJobs, useAuth } from "../auth/AuthProvider";
import { Pager } from "../components/ClientTable";
import { ActionDialog, DialogError, primaryButton, secondaryButton } from "../components/Dialog";
import { WorkflowStatusBadge } from "../components/candidate/WorkflowStatusBadge";
import { formatNumber } from "../components/format";
import { Icon } from "../components/Icon";
import { JobStatusBadge, NO_COMPANY_JOB_ID, VacancyFill, jobCountry, jobDateNote } from "../components/job/JobParts";
import { CountrySelect } from "../components/master/MasterParts";
import { Card, EmptyState, ErrorState, LoadingState } from "../components/States";
import { filterControl, inputClass, tableCell, tableHead, tableRow } from "../components/ui";

// Admin > Jobs: Processing / Completed / Cancelled / All views of the jobs, newest
// first, paged on the server. ADMIN and MANAGER create and manage jobs; an
// ANALYST sees only jobs holding their own candidates (the server scopes the
// list and the candidate counts). The view, search and page live in the URL.
// With no view chosen it opens Processing, or All when there is no Processing
// job (but other jobs exist) rather than an empty list; a view picked from the
// tabs (Processing too) is kept as chosen.
// The Client is not shown in the list or on Job Details (the job keeps its client on the
// server, for its responsible agent, To Country, history and Client Management); New job
// still asks for it, because the client decides which agents can be responsible for the job.

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
    const counts = list.data?.counts;
    const fallBackToAll = requested === null && list.status !== "error" && !!counts && counts.processing === 0 && jobViewCount(counts, "all") > 0;
    useEffect(() => {
        if (!fallBackToAll) return;
        const next = new URLSearchParams(searchParams);
        next.set("view", "all");
        setSearchParams(next, { replace: true });
    }, [fallBackToAll, searchParams, setSearchParams]);

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

    // Right after the fall back, the Processing list (empty) is still held until All arrives.
    const switching = fallBackToAll || (list.status === "loading" && list.data?.filters?.view !== view);
    const items = list.status === "error" || fallBackToAll ? [] : list.data?.items ?? [];

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
                    <div role="tablist" aria-label="Job status" className="flex flex-wrap gap-1">
                        {JOB_VIEWS.map((v) => (
                            <button
                                key={v.view}
                                type="button"
                                role="tab"
                                aria-selected={v.view === view}
                                onClick={() => go({ view: v.view })}
                                className={`h-8 rounded px-3 text-label-md ${v.view === view ? "bg-primary text-on-primary" : "text-ink-soft hover:bg-canvas"}`}
                            >
                                {v.label}{counts ? ` (${formatNumber(jobViewCount(counts, v.view))})` : ""}
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
                            placeholder="Job code, Client Job ID, agent…"
                            onChange={(event) => setSearchText(event.target.value)}
                            className={`${filterControl} w-64`}
                        />
                        <button type="submit" className={secondaryButton}>Search</button>
                    </form>
                </div>

                {((list.status === "loading" && !list.data) || (switching && items.length === 0)) && <LoadingState label="Loading jobs…" />}
                {list.status === "error" && <ErrorState message={list.error.message} onRetry={list.reload} />}
                {list.status !== "error" && list.data && !switching && items.length === 0 && (
                    <EmptyState
                        title={search ? "No jobs match your search" : view === "all" ? "No jobs" : `No ${view} jobs`}
                        description={canManage && (view === "processing" || view === "all") && !search ? "Create a job to start assigning candidates." : undefined}
                    />
                )}
                {items.length > 0 && (
                    <div className="overflow-x-auto">
                        <table aria-label="Jobs" className="w-full border-collapse">
                            <thead>
                                <tr>
                                    <th className={tableHead}>Job code</th>
                                    <th className={tableHead}>Client Job ID</th>
                                    <th className={tableHead}>Job type</th>
                                    <th className={tableHead}>To Country</th>
                                    <th className={tableHead}>From Country</th>
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
                                        <td className={tableCell}>
                                            {(() => {
                                                const types = (job.jobTypes && job.jobTypes.length > 0)
                                                    ? job.jobTypes
                                                    : (job.jobType ? [job.jobType] : []);
                                                if (types.length === 0) return <span className="text-ink-muted">—</span>;
                                                if (types.length === 1) return <span>{types[0].name}</span>;
                                                if (types.length === 2) return <span>{types.map((t) => t.name).join(", ")}</span>;
                                                const shown = types.slice(0, 2).map((t) => t.name).join(", ");
                                                const remaining = types.length - 2;
                                                return (
                                                    <span title={types.map((t) => t.name).join(", ")}>
                                                        {shown} <span className="inline-block rounded bg-canvas-subtle px-1.5 py-0.5 text-label-sm font-medium text-ink-muted">+{remaining}</span>
                                                    </span>
                                                );
                                            })()}
                                        </td>
                                        <td className={tableCell}>{jobCountry(job.countryCode)}</td>
                                        <td className={tableCell}>{jobCountry(job.fromCountryCode)}</td>
                                        <td className={tableCell}>{job.responsibleAgent.name}</td>
                                        <td className={`${tableCell} text-right tabular-nums`}>{formatNumber(job.candidateCount)}</td>
                                        <td className={`${tableCell} text-right`}>{job.vacancies === null ? "—" : <VacancyFill job={job} />}</td>
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

// Multi-select control for Job Types with chips, inline adding, and duplicate prevention.
export function JobTypesMultiSelect({
    label = "Job type",
    value,
    onChange,
    options,
    disabled = false,
    adding = "Add job type",
    canAdd = true,
    onAdd,
}: {
    label?: string;
    value: string[];
    onChange: (ids: string[]) => void;
    options: { id: string; name?: string; label?: string }[];
    disabled?: boolean;
    adding?: string;
    canAdd?: boolean;
    onAdd?: (name: string) => Promise<void>;
}) {
    const id = useId();
    const [openAdd, setOpenAdd] = useState(false);
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const normalizedOptions = options.map((o) => ({ id: o.id, name: o.name ?? o.label ?? o.id }));
    const available = normalizedOptions.filter((o) => !value.includes(o.id));
    const selected = value.map((selectedId) => normalizedOptions.find((o) => o.id === selectedId) ?? { id: selectedId, name: selectedId });

    const addType = async () => {
        if (!onAdd || !name.trim()) return;
        setBusy(true);
        setError(null);
        try {
            await onAdd(name.trim());
            setOpenAdd(false);
            setName("");
        } catch (caught) {
            setError(message(caught));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div>
            <div className="flex items-center justify-between">
                <label htmlFor={id} className="text-label-md text-ink">
                    {label} <span className="text-critical">*</span>
                </label>
                {canAdd && onAdd && (
                    <button
                        type="button"
                        onClick={() => setOpenAdd((v) => !v)}
                        disabled={disabled || busy}
                        className="text-label-sm text-primary hover:underline"
                    >
                        {openAdd ? "Cancel" : adding}
                    </button>
                )}
            </div>

            {openAdd ? (
                <div className="mt-1 space-y-2 rounded border border-border bg-canvas p-2">
                    <input
                        aria-label="New job type name"
                        value={name}
                        maxLength={120}
                        placeholder="Name"
                        disabled={busy}
                        onChange={(event) => setName(event.target.value)}
                        className={inputClass()}
                    />
                    <button
                        type="button"
                        disabled={busy || !name.trim()}
                        onClick={addType}
                        className={primaryButton}
                    >
                        {busy ? "Saving…" : "Save job type"}
                    </button>
                    <DialogError message={error} />
                </div>
            ) : null}

            {/* Selected Job Types chips */}
            <div className="mt-1.5 flex min-h-[36px] flex-wrap items-center gap-1.5 rounded border border-border bg-canvas p-1.5" data-testid="selected-job-types">
                {selected.length === 0 ? (
                    <span className="text-label-sm text-ink-muted">Select at least one job type</span>
                ) : (
                    selected.map((item) => (
                        <span
                            key={item.id}
                            className="inline-flex items-center gap-1 rounded-md border border-border bg-canvas-subtle px-2 py-0.5 text-label-md font-medium text-ink"
                        >
                            <span>{item.name}</span>
                            {!disabled && (
                                <button
                                    type="button"
                                    onClick={() => onChange(value.filter((valId) => valId !== item.id))}
                                    aria-label={`Remove ${item.name}`}
                                    className="ml-0.5 rounded text-ink-muted hover:text-ink focus:outline-none"
                                >
                                    <Icon name="close" className="size-3.5" />
                                </button>
                            )}
                        </span>
                    ))
                )}
            </div>

            {/* Dropdown to add more */}
            <select
                id={id}
                value=""
                aria-label={label}
                disabled={disabled || busy || available.length === 0}
                onChange={(event) => {
                    const selectedVal = event.target.value;
                    if (selectedVal && !value.includes(selectedVal)) {
                        onChange([...value, selectedVal]);
                    }
                }}
                className={`${inputClass()} mt-1.5`}
            >
                <option value="">{available.length === 0 ? "All available job types selected" : "Select…"}</option>
                {available.map((option) => (
                    <option key={option.id} value={option.id}>
                        {option.name}
                    </option>
                ))}
            </select>
        </div>
    );
}

// New job, in two steps. Step 1 is the job's details (nothing is saved; Next only checks them);
// Step 2 picks the candidates to assign right away: candidates who passed the test (they may already
// be on other PROCESSING jobs; any job type preference, No Preferred Type too), none, one or many, and more
// than the vacancies if needed. Create job sends the job and the selection together: the server
// re-checks every rule and creates the job with all of them, or nothing.
type Step = 1 | 2;
const CANDIDATE_PAGE_SIZE = 50;

function NewJobDialog({ token, onClose, onCreated }: { token: string; onClose: () => void; onCreated: (jobId: string) => void }) {
    const { user } = useAuth();
    const canAddJobType = canCreateJobTypes(user);
    const options = useAdminResource("job-options", (t, signal) => getJobOptions(t, signal));
    const [step, setStep] = useState<Step>(1);
    const [created, setCreated] = useState<Partial<JobOptions>>({});
    const [jobTypeIds, setJobTypeIds] = useState<string[]>([]);
    const [clientId, setClientId] = useState("");
    const [fromCountryCode, setFromCountryCode] = useState(DEFAULT_FROM_COUNTRY);
    const [vacancies, setVacancies] = useState("");
    const [companyJobId, setCompanyJobId] = useState("");
    const [selected, setSelected] = useState<Map<string, CandidateListItem>>(() => new Map());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const vacanciesId = useId();
    const companyJobIdField = useId();
    const clientField = useId();

    const merged = <K extends keyof JobOptions>(key: K): JobOptions[K] => {
        const loaded = (options.data?.[key] ?? []) as JobOptions[K];
        const added = (created[key] ?? []) as JobOptions[K];
        return [...loaded, ...added] as JobOptions[K];
    };
    const client = merged("clients").find((c) => c.id === clientId);
    // The responsible agent is one of the client's active agents: taken as is when it has one,
    // chosen here when it has several (never pre-picked). The server re-checks the pair.
    const clientAgents = merged("agents").filter((a) => client?.agentIds.includes(a.id));
    const [chosenAgentId, setChosenAgentId] = useState("");
    const agent = clientAgents.length === 1 ? clientAgents[0] : clientAgents.find((a) => a.id === chosenAgentId);
    // The To Country is the responsible agent's country: shown, never typed (the server sets it).
    const toCountry = agent?.countryCode ?? null;
    const agentField = useId();
    const vacanciesNumber = vacancies.trim() === "" ? null : Number(vacancies);
    const vacanciesValid = vacanciesNumber === null || (Number.isInteger(vacanciesNumber) && vacanciesNumber >= 1 && vacanciesNumber <= 100000);
    const ready = Boolean(jobTypeIds.length > 0 && clientId && agent && fromCountryCode) && vacanciesValid;

    const next = (event: FormEvent) => {
        event.preventDefault();
        if (!ready) return;
        setError(null);
        setStep(2);
    };
    const toggle = (candidate: CandidateListItem) => setSelected((previous) => {
        const nextSelection = new Map(previous);
        if (nextSelection.has(candidate.passportId)) nextSelection.delete(candidate.passportId);
        else nextSelection.set(candidate.passportId, candidate);
        return nextSelection;
    });
    const submit = async () => {
        if (!ready) return;
        setBusy(true);
        setError(null);
        try {
            const job = await createJob(token, {
                jobTypeId: jobTypeIds[0],
                jobTypeIds,
                clientId,
                responsibleAgentId: agent?.id,
                vacancies: vacanciesNumber,
                companyJobId: companyJobId.trim() || null,
                fromCountryCode,
                candidateIds: [...selected.keys()],
            });
            onCreated(job.jobId);
        } catch (caught) {
            setError(message(caught));
            setBusy(false);
        }
    };

    return (
        <ActionDialog title="New job" busy={busy} onClose={onClose}>
            <ol aria-label="New job steps" className="mb-4 flex gap-4 border-b border-border text-label-md">
                {(["Job details", "Select candidates"] as const).map((label, index) => (
                    <li key={label} aria-current={step === index + 1 ? "step" : undefined} className={`-mb-px border-b-2 pb-2 ${step === index + 1 ? "border-primary font-medium text-ink" : "border-transparent text-ink-muted"}`}>
                        {index + 1}. {label}
                    </li>
                ))}
            </ol>
            {options.status === "loading" && !options.data && <LoadingState label="Loading…" />}
            {options.status === "error" && <ErrorState message={options.error.message} onRetry={options.reload} />}
            {options.data && step === 1 && (
                <form onSubmit={next} className="space-y-3">
                    <JobTypesMultiSelect
                        label="Job type"
                        value={jobTypeIds}
                        onChange={setJobTypeIds}
                        disabled={busy}
                        adding="Add job type"
                        canAdd={canAddJobType}
                        options={merged("jobTypes").map((o) => ({ id: o.id, name: o.name }))}
                        onAdd={async (name) => {
                            const row = await createJobType(token, name);
                            setCreated((c) => ({ ...c, jobTypes: [...(c.jobTypes ?? []), row] }));
                            setJobTypeIds((prev) => [...prev, row.id]);
                        }}
                    />
                    <div>
                        <label htmlFor={clientField} className="text-label-md text-ink">Client</label>
                        <select id={clientField} value={clientId} disabled={busy} onChange={(event) => { setClientId(event.target.value); setChosenAgentId(""); }} className={`${inputClass()} mt-1`}>
                            <option value="">Select a client…</option>
                            {merged("clients").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        {merged("clients").length === 0 && <p className="mt-1 text-label-sm text-ink-muted">No active client with an active agent yet. Add one in Client Management.</p>}
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {clientAgents.length > 1 ? (
                            <div>
                                <label htmlFor={agentField} className="text-label-md text-ink">Responsible agent</label>
                                <select id={agentField} value={chosenAgentId} disabled={busy} onChange={(event) => setChosenAgentId(event.target.value)} className={`${inputClass()} mt-1`}>
                                    <option value="">Select an agent…</option>
                                    {clientAgents.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.countryCode})</option>)}
                                </select>
                                <p className="mt-1 text-label-sm text-ink-muted">This client works with several agents.</p>
                            </div>
                        ) : (
                            <div>
                                <span className="text-label-md text-ink">Responsible agent</span>
                                <p className="mt-1 text-body-sm text-ink" data-testid="job-agent">{agent ? `${agent.name} (${agent.countryCode})` : <span className="text-ink-muted">Taken from the selected client</span>}</p>
                            </div>
                        )}
                        <div>
                            <span className="text-label-md text-ink">To Country</span>
                            <p className="mt-1 text-body-sm text-ink" data-testid="job-to-country">
                                {toCountry ? jobCountry(toCountry) : <span className="text-ink-muted">{clientAgents.length > 1 ? "The chosen agent's country" : "Taken from the selected client"}</span>}
                            </p>
                        </div>
                    </div>
                    <CountrySelect label="From Country" value={fromCountryCode} onChange={setFromCountryCode} disabled={busy} />
                    <div>
                        <label htmlFor={vacanciesId} className="text-label-md text-ink">Vacancies <span className="text-ink-muted">(optional)</span></label>
                        <input id={vacanciesId} inputMode="numeric" value={vacancies} disabled={busy} onChange={(event) => setVacancies(event.target.value)} className={`${inputClass(!vacanciesValid)} mt-1`} />
                        {!vacanciesValid && <p className="mt-1 text-label-sm text-critical">Enter a whole number from 1 to 100000, or leave it empty.</p>}
                    </div>
                    <div>
                        <label htmlFor={companyJobIdField} className="text-label-md text-ink">Client Job ID <span className="text-ink-muted">(optional, the employer&apos;s own ID; can be added later)</span></label>
                        <input id={companyJobIdField} value={companyJobId} maxLength={40} disabled={busy} onChange={(event) => setCompanyJobId(event.target.value)} className={`${inputClass()} mt-1`} />
                    </div>
                    <p className="text-body-sm text-ink-muted">Nothing is saved yet: choose the candidates next. The job code is generated when the job is created.</p>
                    <div className="flex justify-end gap-2 pt-1">
                        <button type="button" disabled={busy} onClick={onClose} className={secondaryButton}>Cancel</button>
                        <button type="submit" disabled={busy || !ready} className={primaryButton}>Next</button>
                    </div>
                </form>
            )}
            {options.data && step === 2 && (
                <div className="space-y-3">
                    <CandidatePicker token={token} selected={selected} onToggle={toggle} disabled={busy} />
                    <p role="status" className="text-body-sm text-ink" data-testid="selected-count">
                        {selected.size === 0 ? "No candidates selected. The job can be created without candidates." : `${formatNumber(selected.size)} selected`}
                        {vacanciesNumber !== null && selected.size > 0 && <span className="text-ink-muted">{` for ${formatNumber(vacanciesNumber)} vacancies`}{selected.size > vacanciesNumber ? " (more than the vacancies is allowed)" : ""}</span>}
                    </p>
                    <DialogError message={error} />
                    <div className="flex flex-wrap justify-between gap-2 pt-1">
                        <button type="button" disabled={busy} onClick={() => { setError(null); setStep(1); }} className={secondaryButton}>Back</button>
                        <div className="flex gap-2">
                            <button type="button" disabled={busy} onClick={onClose} className={secondaryButton}>Cancel</button>
                            <button type="button" disabled={busy || !ready} onClick={submit} className={primaryButton}>{busy ? "Creating…" : "Create job"}</button>
                        </div>
                    </div>
                </div>
            )}
        </ActionDialog>
    );
}

// The candidates who can be assigned now (the server's list: test PASS; candidates on other jobs included),
// searchable and paged. The selection is kept across searches and pages.
function CandidatePicker({ token, selected, onToggle, disabled }: { token: string; selected: Map<string, CandidateListItem>; onToggle: (candidate: CandidateListItem) => void; disabled: boolean }) {
    const [text, setText] = useState("");
    const [query, setQuery] = useState({ search: "", page: 1 });
    const [list, setList] = useState<CandidateList | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        const controller = new AbortController();
        setLoadError(null);
        listCandidates(token, { page: query.page, pageSize: CANDIDATE_PAGE_SIZE, search: query.search || undefined, testResult: "PASS" }, controller.signal)
            .then(setList)
            .catch((caught) => {
                if (!controller.signal.aborted) setLoadError(message(caught));
            });
        return () => controller.abort();
    }, [token, query, attempt]);
    const search = (event: FormEvent) => {
        event.preventDefault();
        setQuery({ search: text.trim(), page: 1 });
    };
    const items = list?.items ?? [];
    return (
        <div>
            <form onSubmit={search} role="search" className="flex gap-2">
                <label htmlFor="new-job-candidate-search" className="sr-only">Search candidates</label>
                <input id="new-job-candidate-search" type="search" value={text} maxLength={100} placeholder="Name, passport ID or NIC" onChange={(event) => setText(event.target.value)} className={filterControl} />
                <button type="submit" disabled={disabled} className={secondaryButton}>Search</button>
            </form>
            <p className="mt-2 text-label-sm text-ink-muted">Candidates who passed the test. A candidate can be on several processing jobs.</p>
            {loadError && <ErrorState message={loadError} onRetry={() => setAttempt((n) => n + 1)} />}
            {!loadError && !list && <LoadingState label="Loading candidates…" />}
            {!loadError && list && items.length === 0 && <p className="mt-3 text-body-sm text-ink-muted">{query.search ? "No eligible candidates match your search." : "No candidates can be assigned right now."}</p>}
            {!loadError && items.length > 0 && (
                <ul aria-label="Eligible candidates" className="mt-3 max-h-72 divide-y divide-border overflow-y-auto rounded border border-border">
                    {items.map((candidate) => {
                        const id = `pick-${candidate.passportId}`;
                        return (
                            <li key={candidate.passportId} className="flex items-center gap-3 px-3 py-2">
                                <input id={id} type="checkbox" checked={selected.has(candidate.passportId)} disabled={disabled} onChange={() => onToggle(candidate)} className="size-4 shrink-0 accent-primary" />
                                <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                                    <span className="block truncate text-body-sm text-ink">{candidate.name ?? candidate.passportId}</span>
                                    <span className="block text-label-sm text-ink-muted">{[candidate.passportId, candidate.nic ? `NIC: ${candidate.nic}` : null].filter(Boolean).join(" • ")}</span>
                                </label>
                                <WorkflowStatusBadge status={candidate.workflowStatus} />
                            </li>
                        );
                    })}
                </ul>
            )}
            {list && list.pagination.totalPages > 1 && (
                <div className="mt-2 flex items-center justify-between text-label-sm text-ink-muted">
                    <button type="button" disabled={disabled || query.page <= 1} onClick={() => setQuery((q) => ({ ...q, page: q.page - 1 }))} className="text-primary hover:underline disabled:text-ink-muted disabled:no-underline">Previous</button>
                    <span>Page {query.page} of {list.pagination.totalPages}</span>
                    <button type="button" disabled={disabled || query.page >= list.pagination.totalPages} onClick={() => setQuery((q) => ({ ...q, page: q.page + 1 }))} className="text-primary hover:underline disabled:text-ink-muted disabled:no-underline">Next page</button>
                </div>
            )}
        </div>
    );
}
