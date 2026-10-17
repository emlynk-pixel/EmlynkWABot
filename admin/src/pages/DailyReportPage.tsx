import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { getDailyRoleSummary, getDailySummary, getIncompleteCandidates, type DailyRoleSummary, type DailySummary, type IncompleteStage } from "../api/admin";
import { STAGE_LABELS, type CandidateStageKey } from "../api/candidates";
import { useAdminResource } from "../api/useAdminResource";
import { useAuth } from "../auth/AuthProvider";
import { ROLE_LABELS, ROLES, hasRole, type Role } from "../auth/roles";
import { activityLabel, exportRolePdf, exportSummaryPdf, reportTypeLabel } from "../components/dailyReportPdf";
import { formatDateTime, formatDay, formatNumber, formatTime, todayInSriLanka } from "../components/format";
import { Icon } from "../components/Icon";
import { AUDIT_ACTIONS } from "../components/reviewLabels";
import { Card, ErrorState, LoadingState } from "../components/States";
import { DatePicker } from "../components/DatePicker";

// Daily Report (Admin > Daily Report): one business day in Sri Lanka
// (00:00–24:00 Asia/Colombo). Two views:
//   Summary            daily KPIs, documents, completed candidates, calls,
//                      and the CURRENT state (incomplete candidates, police)
//   Summary by Roles   calls and staff uploads by the staff of one role
//                      (ADMIN and MANAGER only, like the API)
// Date, view and role live in the URL. Export PDF exports the open view.

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const shiftDay = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
// The order of the role selector.
const REPORT_ROLES: Role[] = [ROLES.ANALYST, ROLES.MANAGER, ROLES.ADMIN, ROLES.REGISTRATION_DESK];
const ROLE_VIEW_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER];
const PREVIEW_ROWS = 10;

const button = "h-9 rounded border border-border-strong bg-surface px-3 text-label-md text-ink-soft hover:border-border-focus hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50";
const th = "border-b border-border px-3 py-2 text-left text-label-caps uppercase text-ink-subtle";
const thRight = `${th} text-right`;
const td = "border-b border-border px-3 py-2 text-body-sm text-ink";
const tdRight = `${td} text-right tabular-nums`;
const stageLabel = (stage: string) => STAGE_LABELS[stage as CandidateStageKey] ?? stage;
const roleLabel = (role: string | null) => (role ? ROLE_LABELS[role as Role] ?? role : "—");

// ---------------------------------------------------------------- building blocks

function Kpi({ label, value, hint }: { label: string; value: number; hint?: string }) {
    return (
        <Card className="px-4 py-3.5">
            <p className="text-label-md text-ink-muted">{label}</p>
            <p className="mt-1 text-headline-xl tabular-nums text-ink">{formatNumber(value)}</p>
            {hint && <p className="mt-0.5 text-label-sm text-ink-subtle">{hint}</p>}
        </Card>
    );
}

function Panel({ title, description, aside, children }: { title: string; description?: ReactNode; aside?: ReactNode; children: ReactNode }) {
    return (
        <Card>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-3">
                <div>
                    <h2 className="text-headline-sm text-ink">{title}</h2>
                    {description && <p className="mt-0.5 text-body-sm text-ink-muted">{description}</p>}
                </div>
                {aside}
            </div>
            <div className="px-1 py-1">{children}</div>
        </Card>
    );
}

function Empty({ children }: { children: ReactNode }) {
    return <p className="px-3 py-4 text-body-sm text-ink-muted">{children}</p>;
}

// Shows the first rows, then "Show all".
function useExpandable<T>(rows: T[]) {
    const [all, setAll] = useState(false);
    const shown = all ? rows : rows.slice(0, PREVIEW_ROWS);
    const toggle = rows.length > PREVIEW_ROWS
        ? <button type="button" className="text-label-md text-primary hover:underline" onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${formatNumber(rows.length)}`}</button>
        : null;
    return { shown, toggle };
}

// ---------------------------------------------------------------- Summary view

function DocumentsPanel({ report }: { report: DailySummary }) {
    const { documents, whatsappProcessing: w } = report;
    return (
        <Panel title="Documents submitted" description={`${formatNumber(documents.total)} in total: ${formatNumber(documents.whatsapp)} received on WhatsApp, ${formatNumber(documents.manual)} uploaded by staff.`}>
            <div className="overflow-x-auto">
                <table aria-label="Documents submitted by type" className="w-full border-collapse">
                    <thead><tr><th className={th}>Document type</th><th className={thRight}>Total</th><th className={thRight}>WhatsApp</th><th className={thRight}>Manual</th></tr></thead>
                    <tbody>
                        {documents.byType.map((row) => (
                            <tr key={row.type}>
                                <td className={td}>{reportTypeLabel(row.type)}</td>
                                <td className={`${tdRight} font-medium`}>{formatNumber(row.total)}</td>
                                <td className={`${tdRight} text-ink-muted`}>{formatNumber(row.whatsapp)}</td>
                                <td className={`${tdRight} text-ink-muted`}>{formatNumber(row.manual)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {w.received > 0 && (
                <p className="px-3 py-2.5 text-label-sm text-ink-muted">
                    WhatsApp processing: {formatNumber(w.successfullyProcessed)} processed ({formatNumber(w.storedInCandidateFolder)} stored, {formatNumber(w.heldForReview)} held for review, {formatNumber(w.duplicates)} duplicates) · {formatNumber(w.failed)} failed
                    {w.stillProcessing ? ` · ${formatNumber(w.stillProcessing)} still processing` : ""} · {formatNumber(w.unclear)} unclear · {formatNumber(w.temporary)} still in temporary storage
                </p>
            )}
        </Panel>
    );
}

function RegisteredPanel({ report }: { report: DailySummary }) {
    const { registeredCandidates: r } = report;
    const { shown, toggle } = useExpandable(r.items);
    return (
        <Panel title="Registered candidates" description="Candidates registered on this day, with or without documents." aside={toggle}>
            {r.items.length === 0 ? <Empty>No candidate was registered on this day.</Empty> : (
                <div className="overflow-x-auto">
                    <table aria-label="Registered candidates" className="w-full border-collapse">
                        <thead><tr><th className={th}>Passport number</th><th className={th}>Name</th><th className={th}>Registered</th><th className={th}>Registered by</th><th className={thRight}>Documents now</th><th className={th}>Progress now</th></tr></thead>
                        <tbody>
                            {shown.map((row) => (
                                <tr key={row.passportId}>
                                    <td className={`${td} tabular-nums`}><Link to={`/candidates/${encodeURIComponent(row.passportId)}`} className="text-primary hover:underline">{row.passportId}</Link></td>
                                    <td className={td}>{row.name ?? "—"}</td>
                                    <td className={`${td} tabular-nums`}>{formatTime(row.registeredAt)}</td>
                                    <td className={td}>{row.registeredBy ?? "—"}</td>
                                    <td className={row.documents ? tdRight : `${tdRight} text-ink-muted`}>{row.documents ? formatNumber(row.documents) : "No documents"}</td>
                                    <td className={`${td} text-ink-muted`}>{row.stagesComplete} of {row.stagesTotal} stages</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {r.truncated && <p className="px-3 py-2 text-label-sm text-ink-muted">Showing the first {formatNumber(r.items.length)} of {formatNumber(r.total)}.</p>}
        </Panel>
    );
}

function CompletedPanel({ report }: { report: DailySummary }) {
    const { completedCandidates: c } = report;
    const { shown, toggle } = useExpandable(c.items);
    return (
        <Panel title="Completed candidates" description="Candidates whose final stage, Finalizing the job, was completed on this day." aside={toggle}>
            {c.items.length === 0 ? <Empty>No candidate completed on this day.</Empty> : (
                <div className="overflow-x-auto">
                    <table aria-label="Completed candidates" className="w-full border-collapse">
                        <thead><tr><th className={th}>Passport number</th><th className={th}>Name</th><th className={th}>Completed</th><th className={th}>All stages now</th></tr></thead>
                        <tbody>
                            {shown.map((row) => (
                                <tr key={row.passportId}>
                                    <td className={`${td} tabular-nums`}><Link to={`/candidates/${encodeURIComponent(row.passportId)}`} className="text-primary hover:underline">{row.passportId}</Link></td>
                                    <td className={td}>{row.name ?? "—"}</td>
                                    <td className={`${td} tabular-nums`}>{formatTime(row.completedAt)}</td>
                                    <td className={`${td} ${row.allStagesComplete ? "text-verified" : "text-ink-muted"}`}>{row.allStagesComplete ? "Complete" : "Some stages open"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {c.truncated && <p className="px-3 py-2 text-label-sm text-ink-muted">Showing the first {formatNumber(c.items.length)} of {formatNumber(c.total)}.</p>}
        </Panel>
    );
}

function CallsPanel({ report }: { report: DailySummary }) {
    const { calls } = report;
    const { shown, toggle } = useExpandable(calls.items);
    return (
        <Panel title="Calls taken" description={`${formatNumber(calls.total)} call(s) logged on this day.`} aside={toggle}>
            {calls.items.length === 0 ? <Empty>No calls were logged on this day.</Empty> : (
                <div className="overflow-x-auto">
                    <table aria-label="Calls taken" className="w-full border-collapse">
                        <thead><tr><th className={th}>Time</th><th className={th}>Candidate</th><th className={th}>Passport number</th><th className={th}>Handled by</th><th className={th}>Role</th></tr></thead>
                        <tbody>
                            {shown.map((call) => (
                                <tr key={call.callLogId}>
                                    <td className={`${td} tabular-nums`}>{formatTime(call.calledAt)}</td>
                                    <td className={td}>{call.candidateName ?? "—"}</td>
                                    <td className={`${td} tabular-nums`}>{call.passportId}</td>
                                    <td className={td}>{call.handledBy ?? "—"}</td>
                                    <td className={`${td} text-ink-muted`}>{roleLabel(call.role)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {calls.truncated && <p className="px-3 py-2 text-label-sm text-ink-muted">Showing the latest {formatNumber(calls.items.length)} of {formatNumber(calls.total)}.</p>}
        </Panel>
    );
}

// The candidates behind one incomplete stage (current state), paged.
function IncompleteDetails({ stage }: { stage: string }) {
    const [page, setPage] = useState(1);
    const list = useAdminResource(`daily-incomplete:${stage}:${page}`, (token, signal) => getIncompleteCandidates(token, stage, page, signal));
    if (list.status === "loading" && !list.data) return <LoadingState label="Loading candidates…" />;
    if (list.status === "error" && !list.data) return <ErrorState message={list.error.message} onRetry={list.reload} />;
    const data = list.data!;
    return (
        <div className="bg-canvas/60 px-2 py-2">
            <table aria-label={`Candidates with ${stageLabel(stage)} incomplete`} className="w-full border-collapse">
                <thead><tr><th className={th}>Passport number</th><th className={th}>Candidate</th><th className={th}>Reason</th></tr></thead>
                <tbody>
                    {data.items.map((row) => (
                        <tr key={row.passportId}>
                            <td className={`${td} tabular-nums`}><Link to={`/candidates/${encodeURIComponent(row.passportId)}`} className="text-primary hover:underline">{row.passportId}</Link></td>
                            <td className={td}>{row.name ?? "—"}</td>
                            <td className={`${td} text-ink-muted`}>{row.reasons.join(" · ")}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {data.pagination.totalPages > 1 && (
                <div className="flex items-center justify-end gap-2 px-2 pt-2 text-label-sm text-ink-muted">
                    <button type="button" className={button} disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
                    <span>Page {data.pagination.page} of {data.pagination.totalPages}</span>
                    <button type="button" className={button} disabled={page >= data.pagination.totalPages} onClick={() => setPage(page + 1)}>Next</button>
                </div>
            )}
        </div>
    );
}

function IncompleteRow({ row }: { row: IncompleteStage }) {
    const [open, setOpen] = useState(false);
    const reasons = row.reasons.slice(0, 3);
    return (
        <>
            <tr>
                <td className={td}>{stageLabel(row.stage)}</td>
                <td className={`${tdRight} font-medium`}>{formatNumber(row.count)}</td>
                <td className={`${td} text-ink-muted`}>
                    {reasons.length ? reasons.map((r) => `${r.reason} (${formatNumber(r.count)})`).join(" · ") : "—"}
                    {row.reasons.length > 3 && <span className="text-ink-subtle"> · +{row.reasons.length - 3} more</span>}
                </td>
                <td className={`${td} text-right`}>
                    {row.count > 0 && (
                        <button type="button" aria-expanded={open} className="text-label-md text-primary hover:underline" onClick={() => setOpen((v) => !v)}>
                            {open ? "Hide" : "View"}<span className="sr-only"> {stageLabel(row.stage)} candidates</span>
                        </button>
                    )}
                </td>
            </tr>
            {open && <tr><td colSpan={4} className="p-0"><IncompleteDetails stage={row.stage} /></td></tr>}
        </>
    );
}

function CurrentState({ report }: { report: DailySummary }) {
    const { incomplete, police } = report.current;
    return (
        <section aria-labelledby="current-heading" className="space-y-3">
            <div className="border-t border-border pt-4">
                <h2 id="current-heading" className="text-headline-md text-ink">Current state</h2>
                <p className="mt-0.5 text-body-sm text-ink-muted">
                    As of {formatDateTime(report.current.asOf)}. These show the state now, not on {formatDay(report.businessDate)}: no history of them is kept.
                </p>
            </div>
            <Panel title="Incomplete candidates" description={`${formatNumber(incomplete.incompleteCandidates)} of ${formatNumber(incomplete.totalCandidates)} candidates have at least one stage open. Stages are independent; a stage completed out of order counts as complete.`}>
                <div className="overflow-x-auto">
                    <table aria-label="Incomplete candidates by process" className="w-full border-collapse">
                        <thead><tr><th className={th}>Process</th><th className={thRight}>Candidates</th><th className={th}>Main reasons</th><th className={th}><span className="sr-only">Details</span></th></tr></thead>
                        <tbody>{incomplete.byStage.map((row) => <IncompleteRow key={row.stage} row={row} />)}</tbody>
                    </table>
                </div>
            </Panel>
            <Panel
                title="Police reports"
                description="21-day police report status of every candidate."
                aside={<Link to="/police" className="text-label-md text-primary hover:underline">Police Workflow</Link>}
            >
                <dl aria-label="Police report status" className="grid grid-cols-2 gap-x-4 gap-y-3 px-3 py-3 sm:grid-cols-5">
                    {([
                        ["Due soon (1–7 days)", police.dueSoon],
                        ["Due today", police.dueToday],
                        ["Overdue", police.overdue],
                        ["Missing slip date", police.missingSlipDate],
                        ["Slip not uploaded", police.notUploaded],
                    ] as const).map(([label, value]) => (
                        <div key={label}>
                            <dt className="text-label-sm text-ink-muted">{label}</dt>
                            <dd className={`text-headline-sm tabular-nums ${value > 0 && label !== "Due soon (1–7 days)" ? "text-critical" : "text-ink"}`}>{formatNumber(value)}</dd>
                        </div>
                    ))}
                </dl>
            </Panel>
        </section>
    );
}

function SummaryView({ report }: { report: DailySummary }) {
    const { summary, documents } = report;
    const actions = Object.entries(report.adminActions);
    return (
        <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                <Kpi label="Candidates registered" value={summary.candidatesRegistered} hint="New candidate records" />
                <Kpi label="Candidates completed" value={summary.candidatesCompleted} hint="Final stage completed" />
                <Kpi label="Visa completed" value={summary.visaCompleted} hint="Visa approval completed" />
                <Kpi label="Calls taken" value={summary.callsTaken} />
                <Kpi label="Documents submitted" value={summary.documentsSubmitted} hint={`${formatNumber(documents.whatsapp)} WhatsApp · ${formatNumber(documents.manual)} manual`} />
            </div>
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <RegisteredPanel report={report} />
                <CompletedPanel report={report} />
            </div>
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <DocumentsPanel report={report} />
                <CallsPanel report={report} />
            </div>
            {actions.length > 0 && (
                <details className="rounded-lg border border-border bg-surface px-4 py-3 text-body-sm">
                    <summary className="cursor-pointer text-label-md text-ink-soft">Review and admin actions this day ({formatNumber(actions.reduce((sum, [, n]) => sum + n, 0))})</summary>
                    <ul className="mt-2 divide-y divide-border">
                        {actions.map(([action, count]) => (
                            <li key={action} className="flex justify-between py-1.5"><span>{AUDIT_ACTIONS[action]?.label ?? action}</span><span className="tabular-nums">{formatNumber(count)}</span></li>
                        ))}
                    </ul>
                </details>
            )}
            <CurrentState report={report} />
        </div>
    );
}

// ---------------------------------------------------------------- Summary by Roles view

function RoleView({ report }: { report: DailyRoleSummary }) {
    const { shown, toggle } = useExpandable(report.activity);
    return (
        <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Kpi label="Calls taken" value={report.callsTaken} />
                <Kpi label="Documents uploaded" value={report.documentsUploaded} hint="Staff uploads; WhatsApp files are not attributed to staff" />
            </div>
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <Panel title="Documents uploaded by type">
                    <table aria-label="Documents uploaded by type" className="w-full border-collapse">
                        <thead><tr><th className={th}>Document type</th><th className={thRight}>Uploaded</th></tr></thead>
                        <tbody>
                            {report.documentsByType.map((row) => (
                                <tr key={row.type}><td className={td}>{reportTypeLabel(row.type)}</td><td className={tdRight}>{formatNumber(row.count)}</td></tr>
                            ))}
                        </tbody>
                    </table>
                </Panel>
                <Panel title="Staff" description={`${formatNumber(report.staffCount)} staff member(s) with this role.`}>
                    {report.staff.length === 0 ? <Empty>No staff member has this role.</Empty> : (
                        <table aria-label="Staff activity" className="w-full border-collapse">
                            <thead><tr><th className={th}>Staff member</th><th className={thRight}>Calls</th><th className={thRight}>Documents</th></tr></thead>
                            <tbody>
                                {report.staff.map((s) => (
                                    <tr key={s.adminId}>
                                        <td className={td}>{s.name}{s.status !== "ACTIVE" && <span className="text-ink-subtle"> ({s.status.toLowerCase()})</span>}</td>
                                        <td className={tdRight}>{formatNumber(s.calls)}</td>
                                        <td className={tdRight}>{formatNumber(s.documents)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </Panel>
            </div>
            <Panel title="Activity details" description="Calls and document uploads, newest first." aside={toggle}>
                {report.activity.length === 0 ? <Empty>No calls or uploads by this role on this day.</Empty> : (
                    <div className="overflow-x-auto">
                        <table aria-label="Activity details" className="w-full border-collapse">
                            <thead><tr><th className={th}>Time</th><th className={th}>Staff member</th><th className={th}>Action</th><th className={th}>Candidate</th><th className={th}>Passport number</th></tr></thead>
                            <tbody>
                                {shown.map((a, i) => (
                                    <tr key={`${a.kind}-${a.at}-${i}`}>
                                        <td className={`${td} tabular-nums`}>{formatTime(a.at)}</td>
                                        <td className={td}>{a.staff ?? "—"}</td>
                                        <td className={td}>{activityLabel(a)}</td>
                                        <td className={td}>{a.candidateName ?? "—"}</td>
                                        <td className={`${td} tabular-nums`}>{a.passportId ?? "—"}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {report.truncated && <p className="px-3 py-2 text-label-sm text-ink-muted">Showing the latest {formatNumber(report.activity.length)} of {formatNumber(report.activityTotal)}.</p>}
            </Panel>
            <p className="text-label-sm text-ink-subtle">A staff member is counted under their current role.</p>
        </div>
    );
}

// ---------------------------------------------------------------- data + page

type Exportable = { kind: "summary"; data: DailySummary } | { kind: "roles"; data: DailyRoleSummary } | null;

function SummaryData({ date, onData }: { date: string; onData: (value: Exportable) => void }) {
    const report = useAdminResource(`daily-summary?${date}`, (token, signal) => getDailySummary(token, date, signal));
    const data = report.status === "success" ? report.data : null;
    useEffect(() => onData(data ? { kind: "summary", data } : null), [data, onData]);
    if (report.status === "error") return <Card><ErrorState message={report.error.message} onRetry={report.reload} /></Card>;
    if (report.status === "loading") return <Card><LoadingState label="Loading daily report…" /></Card>;
    return <SummaryView report={report.data} />;
}

function RoleData({ date, role, onData }: { date: string; role: Role; onData: (value: Exportable) => void }) {
    const report = useAdminResource(`daily-roles?${date}&${role}`, (token, signal) => getDailyRoleSummary(token, date, role, signal));
    const data = report.status === "success" ? report.data : null;
    useEffect(() => onData(data ? { kind: "roles", data } : null), [data, onData]);
    if (report.status === "error") return <Card><ErrorState message={report.error.message} onRetry={report.reload} /></Card>;
    if (report.status === "loading") return <Card><LoadingState label="Loading role summary…" /></Card>;
    return <RoleView report={report.data} />;
}

export function DailyReportPage() {
    const { user } = useAuth();
    const [searchParams, setSearchParams] = useSearchParams();
    const [exportable, setExportable] = useState<Exportable>(null);
    const [exporting, setExporting] = useState(false);
    const today = todayInSriLanka();
    const requested = searchParams.get("date");
    const date = requested && DATE_PATTERN.test(requested) && requested <= today ? requested : today;
    const canSeeRoles = hasRole(user, ROLE_VIEW_ROLES);
    const view = canSeeRoles && searchParams.get("view") === "roles" ? "roles" : "summary";
    const requestedRole = searchParams.get("role") as Role | null;
    const role: Role = requestedRole && REPORT_ROLES.includes(requestedRole) ? requestedRole : ROLES.ANALYST;

    const update = (changes: Record<string, string | null>) => {
        const next = new URLSearchParams(searchParams);
        for (const [key, value] of Object.entries(changes)) {
            if (value === null) next.delete(key);
            else next.set(key, value);
        }
        setSearchParams(next);
    };
    const setDate = (value: string) => update({ date: value && value !== today ? value : null });

    const handleExport = async () => {
        if (!exportable) return;
        setExporting(true);
        try {
            if (exportable.kind === "summary") await exportSummaryPdf(exportable.data);
            else await exportRolePdf(exportable.data);
        } finally {
            setExporting(false);
        }
    };

    const tab = (active: boolean) => `h-8 rounded px-3 text-label-md ${active ? "bg-surface text-ink shadow-surface" : "text-ink-muted hover:text-ink"}`;

    return (
        <section aria-labelledby="page-title" className="space-y-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 id="page-title" className="text-headline-lg text-ink">Daily Report</h1>
                    <p className="mt-1 text-body-sm text-ink-muted">
                        {formatDay(date)}{date === today ? " (today, so far)" : ""} · 00:00–24:00 Sri Lanka time
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Report date">
                    <button type="button" className={button} onClick={() => setDate(shiftDay(date, -1))}>Previous day</button>
                    <label htmlFor="report-date" className="sr-only">Business date</label>
                    <DatePicker
                        id="report-date"
                        min="2000-01-01"
                        max={today}
                        required
                        value={date}
                        onChange={(next) => next && setDate(next)}
                        className="h-9 w-40 rounded border border-border-strong bg-surface px-2 text-body-sm text-ink focus:border-primary focus:shadow-focus focus:outline-none"
                    />
                    <button type="button" className={button} disabled={date >= today} onClick={() => setDate(shiftDay(date, 1))}>Next day</button>
                    <button type="button" className={button} disabled={date === today} onClick={() => setDate(today)}>Today</button>
                    <button type="button" className={`${button} inline-flex items-center gap-1.5`} onClick={handleExport} disabled={!exportable || exporting} aria-label="Export PDF">
                        <Icon name="picture_as_pdf" className="size-4" />
                        {exporting ? "Exporting…" : "Export PDF"}
                    </button>
                </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
                {canSeeRoles ? (
                    <div role="tablist" aria-label="Report view" className="inline-flex rounded-md border border-border bg-canvas p-0.5">
                        <button type="button" role="tab" aria-selected={view === "summary"} className={tab(view === "summary")} onClick={() => update({ view: null })}>Summary</button>
                        <button type="button" role="tab" aria-selected={view === "roles"} className={tab(view === "roles")} onClick={() => update({ view: "roles" })}>Summary by Roles</button>
                    </div>
                ) : <span />}
                {view === "roles" && (
                    <label className="flex items-center gap-2 text-label-md text-ink-muted">
                        Role
                        <select
                            aria-label="Role"
                            value={role}
                            onChange={(event) => update({ role: event.target.value })}
                            className="h-9 rounded border border-border-strong bg-surface px-2 text-body-sm text-ink focus:border-primary focus:shadow-focus focus:outline-none"
                        >
                            {REPORT_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                        </select>
                    </label>
                )}
            </div>

            {view === "summary"
                ? <SummaryData date={date} onData={setExportable} />
                : <RoleData date={date} role={role} onData={setExportable} />}
        </section>
    );
}
