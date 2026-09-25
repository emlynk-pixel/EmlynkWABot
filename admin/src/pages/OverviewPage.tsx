import { Link } from "react-router";
import { getOverview, type Overview } from "../api/admin";
import { useAdminResource } from "../api/useAdminResource";
import { useAuth } from "../auth/AuthProvider";
import { DocumentsTable } from "../components/DocumentsTable";
import { documentTypeLabel, formatDate, formatDateTime, formatNumber } from "../components/format";
import { Icon, type IconName } from "../components/Icon";
import { Card, EmptyState, ErrorState, LoadingState, SectionHeading } from "../components/States";
import { StatusBadge, statusLabel, statusTone, toneDotClass } from "../components/StatusBadge";

function KpiCard({ label, value, hint, icon }: { label: string; value: number; hint: string; icon: IconName }) {
    return (
        <Card className="flex flex-col justify-between p-4">
            <div className="flex items-start justify-between">
                <div>
                    <p className="text-label-caps uppercase text-ink-subtle">{label}</p>
                    <p className="mt-1 text-headline-xl tabular-nums text-ink">{formatNumber(value)}</p>
                </div>
                <span className="flex size-9 items-center justify-center rounded bg-primary-soft text-primary">
                    <Icon name={icon} className="size-5" />
                </span>
            </div>
            <p className="mt-4 border-t border-border pt-1 text-body-sm text-ink-muted">{hint}</p>
        </Card>
    );
}

// Horizontal bars with count and share (Stitch "Document Processing Statuses").
function Breakdown({ counts, label, dotClass }: { counts: Record<string, number>; label: (key: string) => string; dotClass: (key: string) => string }) {
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((sum, [, n]) => sum + n, 0);
    if (total === 0) return <EmptyState title="No submissions yet" description="Documents received on WhatsApp will be counted here." />;

    return (
        <ul className="space-y-3">
            {entries.map(([key, count]) => {
                const share = (count / total) * 100;
                return (
                    <li key={key} className="space-y-1">
                        <div className="flex items-center justify-between text-body-sm">
                            <span className="flex items-center gap-2 font-medium text-ink">
                                <span className={`size-2.5 rounded-full ${dotClass(key)}`} aria-hidden="true" />
                                {label(key)}
                            </span>
                            <span>
                                <span className="font-semibold tabular-nums text-ink">{formatNumber(count)}</span>
                                <span className="ml-1 text-label-caps tabular-nums text-ink-subtle">({share.toFixed(1)}%)</span>
                            </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-canvas-muted">
                            <div className={`h-full rounded-full ${dotClass(key)}`} style={{ width: `${share}%` }} />
                        </div>
                    </li>
                );
            })}
        </ul>
    );
}

// Final police reports by 21-day status; each links to the filtered Police Workflow.
function PoliceDue({ police }: { police: Overview["police"] }) {
    const items = [
        { label: "Overdue", value: police.overdue, status: "OVERDUE", critical: true },
        { label: "Due today", value: police.dueToday, status: "DUE_TODAY", critical: true },
        { label: "Due soon (1–7 days)", value: police.dueSoon, status: "DUE_SOON", critical: false },
    ];
    return (
        <Card className="space-y-3 p-4">
            <SectionHeading
                title="Police reports"
                description="Final police reports due 21 days after the police slip was submitted"
                action={<Link to="/police" className="text-label-md text-primary hover:underline">Open Police Workflow</Link>}
            />
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3" aria-label="Police reports by status">
                {items.map((item) => (
                    <li key={item.status}>
                        <Link to={`/police?status=${item.status}`} className="flex items-center justify-between rounded-lg bg-canvas px-3 py-2 hover:bg-canvas-muted">
                            <span className="text-body-sm text-ink">{item.label}</span>
                            <span className={`text-headline-md tabular-nums ${item.critical && item.value > 0 ? "text-critical" : "text-ink"}`}>{formatNumber(item.value)}</span>
                        </Link>
                    </li>
                ))}
            </ul>
        </Card>
    );
}

function OverviewContent({ data }: { data: Overview }) {
    const { kpis, reviewQueue } = data;
    return (
        <div className="space-y-6">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <KpiCard label="Total clients" value={kpis.totalClients} hint="Client profiles on record" icon="group" />
                <KpiCard label="Total documents" value={kpis.totalDocuments} hint="Stored in client folders" icon="description" />
                <KpiCard label="Pending review" value={kpis.pendingReview} hint="Waiting files + stored files to review" icon="fact_check" />
                <KpiCard label="Received today" value={kpis.receivedToday} hint={`WhatsApp submissions on ${formatDate(`${data.businessDate}T12:00:00+05:30`)}`} icon="mail" />
            </div>

            <PoliceDue police={data.police} />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
                <Card className="space-y-4 p-4 lg:col-span-7">
                    <SectionHeading title="Document processing statuses" description="Outcome of every document received on WhatsApp" />
                    <Breakdown counts={data.submissionsByStatus} label={statusLabel} dotClass={(key) => toneDotClass(statusTone(key))} />
                </Card>
                <Card className="space-y-4 p-4 lg:col-span-5">
                    <SectionHeading title="Documents by type" description="Received documents by detected type" />
                    <Breakdown counts={data.submissionsByType} label={documentTypeLabel} dotClass={() => "bg-primary"} />
                </Card>
            </div>

            <Card>
                <div className="p-4">
                    <SectionHeading
                        title="Recent documents"
                        description="Latest files stored in client folders"
                        action={<Link to="/documents" className="text-label-md text-primary hover:underline">View all</Link>}
                    />
                </div>
                {data.recentDocuments.length ? (
                    <DocumentsTable documents={data.recentDocuments} caption="Recent documents" />
                ) : (
                    <EmptyState title="No documents stored yet" />
                )}
            </Card>

            <Card>
                <div className="space-y-3 p-4">
                    <SectionHeading
                        title={`Review queue — ${formatNumber(reviewQueue.total)} ${reviewQueue.total === 1 ? "item" : "items"}`}
                        description={`${formatNumber(reviewQueue.pendingFiles)} files waiting in pending storage · ${formatNumber(reviewQueue.reviewRequiredDocuments)} stored files marked Review required`}
                        action={
                            <Link to="/review" className="text-label-md text-primary hover:underline">
                                Open Review Queue
                            </Link>
                        }
                    />
                    {Object.keys(reviewQueue.pendingByStatus).length > 0 && (
                        <ul className="flex flex-wrap gap-2" aria-label="Waiting files by reason">
                            {Object.entries(reviewQueue.pendingByStatus).map(([status, count]) => (
                                <li key={status} className="flex items-center gap-1.5">
                                    <StatusBadge status={status} />
                                    <span className="text-label-sm tabular-nums text-ink-muted">{formatNumber(count)}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                {reviewQueue.items.length ? (
                    <div className="overflow-x-auto">
                        <table className="w-full border-separate border-spacing-0">
                            <caption className="sr-only">Latest files waiting for review</caption>
                            <thead>
                                <tr>
                                    {["Type", "Reason", "Client", "Received"].map((heading) => (
                                        <th key={heading} scope="col" className="h-[34px] border-b border-border bg-canvas px-4 text-left text-label-caps uppercase text-ink-subtle">{heading}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {reviewQueue.items.map((item) => (
                                    <tr key={item.temporaryId} className="hover:bg-canvas">
                                        <td className="h-11 border-b border-canvas-muted px-4 text-body-sm">
                                            <Link to={`/review/pending-${encodeURIComponent(item.temporaryId)}`} className="text-primary hover:underline">{documentTypeLabel(item.documentType)}</Link>
                                        </td>
                                        <td className="h-11 border-b border-canvas-muted px-4"><StatusBadge status={item.processingStatus} /></td>
                                        <td className="h-11 border-b border-canvas-muted px-4 text-body-sm">
                                            {item.client ? (
                                                <Link to={`/clients/${encodeURIComponent(item.client.passportId)}`} className="text-primary hover:underline">
                                                    {item.client.name ?? item.client.passportId}
                                                </Link>
                                            ) : (
                                                <span className="text-ink-subtle">Not identified</span>
                                            )}
                                        </td>
                                        <td className="h-11 border-b border-canvas-muted px-4 text-label-sm text-ink-muted">{formatDateTime(item.receivedDate)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <EmptyState title="Nothing waiting for review" />
                )}
            </Card>
        </div>
    );
}

export function OverviewPage() {
    const { admin } = useAuth();
    const overview = useAdminResource("overview", (token, signal) => getOverview(token, signal));

    return (
        <section aria-labelledby="page-title" className="space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 id="page-title" className="text-headline-lg text-ink">Overview</h1>
                    <p className="mt-1 text-body-sm text-ink-muted">Welcome{admin ? `, ${admin.name}` : ""}. Figures use Sri Lanka time.</p>
                </div>
                <button
                    type="button"
                    onClick={overview.reload}
                    disabled={overview.status === "loading"}
                    className="h-8 rounded border border-border-strong bg-surface px-3 text-label-md text-ink-soft shadow-surface hover:border-border-focus hover:bg-canvas disabled:opacity-60"
                >
                    Refresh
                </button>
            </div>

            {overview.status === "error" && !overview.data && <Card><ErrorState message={overview.error.message} onRetry={overview.reload} /></Card>}
            {overview.status === "loading" && !overview.data && <Card><LoadingState label="Loading overview…" /></Card>}
            {overview.data && <OverviewContent data={overview.data} />}
        </section>
    );
}
