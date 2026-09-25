import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { getPoliceWorkflow, type PoliceListParams, type PoliceStatus } from "../api/admin";
import { useAdminResource } from "../api/useAdminResource";
import { formatDay, formatNumber } from "../components/format";
import { Icon, type IconName } from "../components/Icon";
import { POLICE_STATUSES, daysLeftLabel, policeStatusLabel } from "../components/policeLabels";
import { Card, EmptyState, ErrorState, LoadingState } from "../components/States";
import { StatusBadge, ToneBadge, statusTone } from "../components/StatusBadge";

const PAGE_SIZE = 25;
const STATUS_VALUES = POLICE_STATUSES.map((s) => s.status);

function paramsFrom(search: URLSearchParams): PoliceListParams {
    const page = Number(search.get("page"));
    const status = search.get("status") as PoliceStatus | null;
    return {
        page: Number.isInteger(page) && page > 0 ? page : 1,
        pageSize: PAGE_SIZE,
        status: status && STATUS_VALUES.includes(status) ? status : undefined,
        search: search.get("search") || undefined,
    };
}

function StatCard({ label, value, icon, status, active, onSelect }: { label: string; value: number | undefined; icon: IconName; status: PoliceStatus; active: boolean; onSelect: (status: PoliceStatus) => void }) {
    return (
        <button
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(status)}
            className={`flex items-start justify-between rounded-lg border bg-surface p-4 text-left shadow-surface hover:border-border-focus ${active ? "border-primary" : "border-border"}`}
        >
            <span>
                <span className="block text-label-caps uppercase text-ink-subtle">{label}</span>
                <span className="mt-1 block text-headline-xl tabular-nums text-ink">{value === undefined ? "—" : formatNumber(value)}</span>
            </span>
            <span className={`flex size-9 items-center justify-center rounded ${statusTone(status) === "critical" ? "bg-critical-bg text-critical" : "bg-primary-soft text-primary"}`}>
                <Icon name={icon} className="size-5" />
            </span>
        </button>
    );
}

// Police Workflow (Stitch "Police Workflow"): the 21-day follow-up for the
// final police report of every client, calculated by the backend. Read-only;
// the search only narrows the list (passport ID, unique ID or name).
export function PoliceWorkflowPage() {
    const [searchParams, setSearchParams] = useSearchParams();
    const params = paramsFrom(searchParams);
    const key = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
    const list = useAdminResource(`police?${key}`, (token, signal) => getPoliceWorkflow(token, params, signal));

    const update = (changes: Record<string, string | undefined>, { keepPage = false } = {}) => {
        const next = new URLSearchParams(searchParams);
        for (const [name, value] of Object.entries(changes)) {
            if (value) next.set(name, value);
            else next.delete(name);
        }
        if (!keepPage) next.delete("page");
        setSearchParams(next);
    };
    const toggleStatus = (status: PoliceStatus) => update({ status: params.status === status ? undefined : status });
    const [searchText, setSearchText] = useState(params.search ?? "");
    useEffect(() => setSearchText(params.search ?? ""), [params.search]);
    const submitSearch = (event: FormEvent) => {
        event.preventDefault();
        update({ search: searchText.trim() || undefined });
    };
    const data = list.data;
    const byStatus = data?.summary.byStatus;
    const control = "h-9 w-full rounded border border-border-strong bg-surface px-2 text-body-sm text-ink focus:border-primary focus:shadow-focus focus:outline-none";
    const th = "h-[34px] whitespace-nowrap border-b border-border bg-canvas px-4 text-left text-label-caps uppercase text-ink-subtle";
    const td = "h-11 whitespace-nowrap border-b border-canvas-muted px-4 text-body-sm";

    return (
        <section aria-labelledby="page-title" className="space-y-4">
            <div>
                <h1 id="page-title" className="text-headline-lg text-ink">Police Workflow</h1>
                <p className="mt-1 text-body-sm text-ink-muted">
                    The final police report is due 21 days after the police slip was submitted (Sri Lanka calendar days). A verified police report completes the workflow.
                </p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard label="Overdue" value={byStatus?.OVERDUE} icon="error" status="OVERDUE" active={params.status === "OVERDUE"} onSelect={toggleStatus} />
                <StatCard label="Due today" value={byStatus?.DUE_TODAY} icon="error" status="DUE_TODAY" active={params.status === "DUE_TODAY"} onSelect={toggleStatus} />
                <StatCard label="Due soon (1–7 days)" value={byStatus?.DUE_SOON} icon="local_police" status="DUE_SOON" active={params.status === "DUE_SOON"} onSelect={toggleStatus} />
                <StatCard label="Pending (over 7 days)" value={byStatus?.PENDING} icon="local_police" status="PENDING" active={params.status === "PENDING"} onSelect={toggleStatus} />
            </div>

            <Card className="flex flex-wrap items-center gap-3 p-4">
                <form role="search" onSubmit={submitSearch} className="flex w-full gap-2 md:w-auto md:min-w-[22rem]">
                    <label htmlFor="police-search" className="sr-only">Search clients</label>
                    <input
                        id="police-search"
                        type="search"
                        value={searchText}
                        maxLength={100}
                        onChange={(event) => setSearchText(event.target.value)}
                        placeholder="Search by passport ID, unique ID or name…"
                        className={control}
                    />
                    <button type="submit" className="h-9 rounded bg-primary px-3 text-label-md text-on-primary hover:bg-primary-hover">Search</button>
                </form>
                <label htmlFor="police-status" className="text-label-md text-ink">Status</label>
                <select id="police-status" value={params.status ?? ""} onChange={(e) => update({ status: e.target.value || undefined })} className={`${control} max-w-xs`}>
                    <option value="">All clients{data ? ` (${formatNumber(data.summary.total)})` : ""}</option>
                    {POLICE_STATUSES.map(({ status, label }) => (
                        <option key={status} value={status}>{label}{byStatus ? ` (${formatNumber(byStatus[status])})` : ""}</option>
                    ))}
                </select>
                {byStatus && (
                    <ul className="flex flex-wrap gap-2 text-label-sm text-ink-muted" aria-label="Other statuses">
                        {(["DATE_MISSING", "NOT_UPLOADED", "COMPLETED"] as const).map((status) => (
                            <li key={status} className="flex items-center gap-1.5">
                                <StatusBadge status={status} />
                                <span className="tabular-nums">{formatNumber(byStatus[status])}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </Card>

            <Card>
                {list.status === "error" && <ErrorState message={list.error.message} onRetry={list.reload} />}
                {list.status === "loading" && <LoadingState label="Loading police workflow…" />}
                {list.status === "success" && data && data.items.length === 0 && (
                    <EmptyState
                        title={params.search ? `No clients match "${params.search}"${params.status ? ` with status "${policeStatusLabel(params.status)}"` : ""}` : params.status ? `No clients with status "${policeStatusLabel(params.status)}"` : "No clients yet"}
                        action={params.status || params.search ? <button type="button" onClick={() => setSearchParams(new URLSearchParams())} className="text-label-md text-primary hover:underline">Show all clients</button> : undefined}
                    />
                )}
                {list.status === "success" && data && data.items.length > 0 && (
                    <>
                        <div className="overflow-x-auto">
                            <table className="w-full border-separate border-spacing-0">
                                <caption className="sr-only">Police workflow</caption>
                                <thead>
                                    <tr>
                                        {["Client", "Status", "Slip submitted", "Report due", "Days", "Police slip", "Final report", ""].map((h, i) => (
                                            <th key={h || i} scope="col" className={th}>{h || <span className="sr-only">Action</span>}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.items.map((item) => (
                                        <tr key={item.client.passportId} className="hover:bg-canvas">
                                            <td className={td}>
                                                <div className="flex flex-col">
                                                    <span className="font-medium text-ink">{item.client.name ?? "—"}</span>
                                                    <span className="text-label-sm text-ink-subtle">{item.client.passportId} · {item.client.uniqueId}</span>
                                                </div>
                                            </td>
                                            <td className={td}><ToneBadge tone={statusTone(item.status)}>{policeStatusLabel(item.status)}</ToneBadge></td>
                                            <td className={td}>{formatDay(item.submittedDate)}</td>
                                            <td className={td}>{formatDay(item.dueDate)}</td>
                                            <td className={`${td} tabular-nums ${item.daysRemaining !== null && item.daysRemaining <= 0 ? "font-medium text-critical" : "text-ink"}`}>{daysLeftLabel(item)}</td>
                                            <td className={td}>
                                                {item.slip ? <StatusBadge status={item.slip.verificationStatus} /> : item.slipAwaitingReview ? <span className="text-label-sm text-ink-muted">Waiting for review</span> : <span className="text-ink-subtle">—</span>}
                                            </td>
                                            <td className={td}>{item.report ? <StatusBadge status="VERIFIED" /> : <span className="text-ink-subtle">—</span>}</td>
                                            <td className={`${td} text-right`}>
                                                <Link to={`/clients/${encodeURIComponent(item.client.passportId)}`} className="text-label-md text-primary hover:underline">View client</Link>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-body-sm text-ink-muted">
                            <p>{formatNumber(data.pagination.total)} {data.pagination.total === 1 ? "client" : "clients"} · as of {formatDay(data.businessDate)}</p>
                            <div className="flex items-center gap-2">
                                <button type="button" disabled={data.pagination.page <= 1} onClick={() => update({ page: String(data.pagination.page - 1) }, { keepPage: true })} className="h-8 rounded border border-border-strong bg-surface px-3 text-label-md text-ink-soft disabled:opacity-50">Previous</button>
                                <span aria-current="page">Page {data.pagination.page} of {data.pagination.totalPages}</span>
                                <button type="button" disabled={data.pagination.page >= data.pagination.totalPages} onClick={() => update({ page: String(data.pagination.page + 1) }, { keepPage: true })} className="h-8 rounded border border-border-strong bg-surface px-3 text-label-md text-ink-soft disabled:opacity-50">Next</button>
                            </div>
                        </nav>
                    </>
                )}
            </Card>
        </section>
    );
}
