import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { getDailyReport, type DailyReport } from "../api/admin";
import { useAdminResource } from "../api/useAdminResource";
import { documentTypeLabel, formatDateTime, formatDay, formatNumber, todayInSriLanka } from "../components/format";
import { AUDIT_ACTIONS } from "../components/reviewLabels";
import { Card, EmptyState, ErrorState, LoadingState, SectionHeading } from "../components/States";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const shiftDay = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

function Figure({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone?: "critical" }) {
    return (
        <div className="rounded-lg border border-border bg-surface p-4 shadow-surface">
            <p className="text-label-caps uppercase text-ink-subtle">{label}</p>
            <p className={`mt-1 text-headline-xl tabular-nums ${tone === "critical" && value > 0 ? "text-critical" : "text-ink"}`}>{formatNumber(value)}</p>
            {hint && <p className="mt-1 text-label-sm text-ink-muted">{hint}</p>}
        </div>
    );
}

function Counts({ label, entries }: { label: string; entries: [string, ReactNode, number][] }) {
    return (
        <ul aria-label={label} className="divide-y divide-border">
            {entries.map(([key, name, count]) => (
                <li key={key} className="flex items-center justify-between py-2 text-body-sm">
                    <span className="text-ink">{name}</span>
                    <span className="font-semibold tabular-nums text-ink">{formatNumber(count)}</span>
                </li>
            ))}
        </ul>
    );
}

function DailySection({ report }: { report: DailyReport }) {
    const { daily } = report;
    const actions = Object.entries(daily.adminActions);
    return (
        <section aria-labelledby="daily-heading" className="space-y-3">
            <SectionHeading
                title={`Received on ${formatDay(report.businessDate)}`}
                description={`Daily figures: WhatsApp submissions received between 00:00 and 24:00 Sri Lanka time${report.isToday ? " (today, so far)" : ""}.`}
            />
            <h2 id="daily-heading" className="sr-only">Daily figures</h2>
            {daily.totalReceived === 0 ? (
                <Card><EmptyState title="No documents were received on this day" description="Choose another date, or check back later today." /></Card>
            ) : (
                <>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <Figure label="Documents received" value={daily.totalReceived} />
                        <Figure label="Successfully processed" value={daily.successfullyProcessed} hint={`${formatNumber(daily.storedInClientFolder)} stored · ${formatNumber(daily.heldForReview)} held for review · ${formatNumber(daily.duplicates)} duplicates`} />
                        <Figure label="Failed processing" value={daily.failed} tone="critical" hint={daily.stillProcessing ? `${formatNumber(daily.stillProcessing)} still processing` : undefined} />
                        <Figure label="Unclear documents" value={daily.unclear} hint="Low confidence or unreliable read" />
                        <Figure label="Temporary documents" value={daily.temporary} hint="Received this day, still waiting in pending storage" />
                    </div>
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        <Card className="p-4">
                            <SectionHeading title="By document type" />
                            <Counts label="Documents by type" entries={Object.entries(daily.byType).map(([type, count]) => [type, documentTypeLabel(type), count])} />
                        </Card>
                        <Card className="p-4">
                            <SectionHeading title="Admin actions this day" description="From the audit log" />
                            {actions.length
                                ? <Counts label="Admin actions" entries={actions.map(([action, count]) => [action, AUDIT_ACTIONS[action]?.label ?? action, count])} />
                                : <p className="mt-2 text-body-sm text-ink-muted">No review actions or corrections this day.</p>}
                        </Card>
                    </div>
                </>
            )}
        </section>
    );
}

function CurrentSection({ report }: { report: DailyReport }) {
    const { clients, police } = report.current;
    return (
        <section aria-labelledby="current-heading" className="space-y-3">
            <div>
                <h2 id="current-heading" className="text-headline-md text-ink">Current status</h2>
                <p className="mt-0.5 text-body-sm text-ink-muted">
                    As of {formatDateTime(report.current.asOf)}. These figures are the state now, not on {formatDay(report.businessDate)}: no history of them is kept.
                </p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Figure label="Completed clients" value={clients.complete} hint={`of ${formatNumber(clients.total)} clients`} />
                <Figure label="Incomplete clients" value={clients.incomplete} />
                <Figure label="Missing documents" value={clients.missingDocuments} tone="critical" hint={`${formatNumber(clients.withMissing)} clients`} />
                <Figure label="Police reports due soon" value={police.dueSoon} hint="1–7 days left" />
                <Figure label="Police reports due today" value={police.dueToday} tone="critical" />
                <Figure label="Overdue police reports" value={police.overdue} tone="critical" />
            </div>
            <p className="text-body-sm">
                <Link to="/missing-documents" className="text-primary hover:underline">Missing Documents</Link>
                <span aria-hidden="true" className="px-2 text-ink-subtle">·</span>
                <Link to="/police" className="text-primary hover:underline">Police Workflow</Link>
            </p>
        </section>
    );
}

// Daily report (proposal §22 Daily Summary, §35) for a chosen business day.
export function DailyReportPage() {
    const [searchParams, setSearchParams] = useSearchParams();
    const today = todayInSriLanka();
    const requested = searchParams.get("date");
    const date = requested && DATE_PATTERN.test(requested) ? requested : today;
    const report = useAdminResource(`report?${date}`, (token, signal) => getDailyReport(token, date, signal));
    const setDate = (value: string) => {
        const next = new URLSearchParams(searchParams);
        if (value && value !== today) next.set("date", value);
        else next.delete("date");
        setSearchParams(next);
    };
    const button = "h-9 rounded border border-border-strong bg-surface px-3 text-label-md text-ink-soft hover:border-border-focus hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50";

    return (
        <section aria-labelledby="page-title" className="space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 id="page-title" className="text-headline-lg text-ink">Daily Report</h1>
                    <p className="mt-1 text-body-sm text-ink-muted">Figures for one business day in Sri Lanka, and the current status.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Report date">
                    <button type="button" className={button} onClick={() => setDate(shiftDay(date, -1))}>Previous day</button>
                    <label htmlFor="report-date" className="sr-only">Business date</label>
                    <input
                        id="report-date"
                        type="date"
                        min="2000-01-01"
                        max={today}
                        value={date}
                        onChange={(event) => setDate(event.target.value)}
                        className="h-9 rounded border border-border-strong bg-surface px-2 text-body-sm text-ink focus:border-primary focus:shadow-focus focus:outline-none"
                    />
                    <button type="button" className={button} disabled={date >= today} onClick={() => setDate(shiftDay(date, 1))}>Next day</button>
                    <button type="button" className={button} disabled={date === today} onClick={() => setDate(today)}>Today</button>
                </div>
            </div>

            {report.status === "error" && (
                <Card>
                    <ErrorState message={report.error.status === 400 ? "Choose a date between 1 January 2000 and today." : report.error.message} onRetry={report.error.status === 400 ? () => setDate(today) : report.reload} />
                </Card>
            )}
            {report.status === "loading" && <Card><LoadingState label="Loading daily report…" /></Card>}
            {report.status === "success" && (
                <>
                    <DailySection report={report.data} />
                    <CurrentSection report={report.data} />
                </>
            )}
        </section>
    );
}
