import { Link, useSearchParams } from "react-router";
import { getReviewQueue, type ReviewQueueParams } from "../api/admin";
import { useAdminResource } from "../api/useAdminResource";
import { Confidence } from "../components/Confidence";
import { documentTypeLabel, formatDateTime, formatNumber, shortId } from "../components/format";
import { Icon, type IconName } from "../components/Icon";
import { CATEGORY_LABELS, REVIEW_REASONS, failureLabel, reviewReasonLabel, reviewReasonTone } from "../components/reviewLabels";
import { Card, EmptyState, ErrorState, LoadingState } from "../components/States";
import { StatusBadge, ToneBadge } from "../components/StatusBadge";
import { filterControl, tableCell, tableHead } from "../components/ui";

const PAGE_SIZE = 25;

function paramsFrom(search: URLSearchParams): ReviewQueueParams {
    const page = Number(search.get("page"));
    return {
        page: Number.isInteger(page) && page > 0 ? page : 1,
        pageSize: PAGE_SIZE,
        kind: (search.get("kind") as ReviewQueueParams["kind"]) ?? undefined,
        documentType: search.get("documentType") ?? undefined,
        reviewReason: search.get("reviewReason") ?? undefined,
        order: (search.get("order") as ReviewQueueParams["order"]) ?? undefined,
    };
}

function StatCard({ label, value, icon }: { label: string; value: number | undefined; icon: IconName }) {
    return (
        <Card className="flex items-start justify-between p-5">
            <div>
                <p className="text-label-caps uppercase text-ink-subtle">{label}</p>
                <p className="mt-1 text-headline-xl tabular-nums text-ink">{value === undefined ? "—" : formatNumber(value)}</p>
            </div>
            <span className="flex size-9 items-center justify-center rounded bg-primary-soft text-primary"><Icon name={icon} className="size-5" /></span>
        </Card>
    );
}

// Review Queue (Stitch "Review Queue"): the list of items waiting for a
// person. The actions are on the Review Detail page.
export function ReviewQueuePage() {
    const [searchParams, setSearchParams] = useSearchParams();
    const params = paramsFrom(searchParams);
    const key = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
    const queue = useAdminResource(`review?${key}`, (token, signal) => getReviewQueue(token, params, signal));

    const update = (changes: Record<string, string | undefined>, { keepPage = false } = {}) => {
        const next = new URLSearchParams(searchParams);
        for (const [name, value] of Object.entries(changes)) {
            if (value) next.set(name, value);
            else next.delete(name);
        }
        if (!keepPage) next.delete("page");
        setSearchParams(next);
    };
    const hasFilters = ["kind", "documentType", "reviewReason", "order"].some((name) => searchParams.get(name));
    const showingFailed = params.kind === "FAILED";
    const data = queue.data;
    const summary = data?.summary;
    const control = filterControl;
    const th = tableHead;
    const td = tableCell;

    return (
        <section aria-labelledby="page-title" className="space-y-4">
            <div>
                <h1 id="page-title" className="text-headline-lg text-ink">Review Queue</h1>
                <p className="mt-1 text-body-sm text-ink-muted">
                    {showingFailed
                        ? "Submissions whose processing failed. Nothing was stored for the client; they can be inspected here (there is no retry)."
                        : "Files waiting in pending storage and stored documents marked Review required. Oldest first."}
                </p>
            </div>

            {!showingFailed && Boolean(summary?.failed) && (
                <div role="note" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-critical-border bg-critical-bg px-3 py-2 text-body-sm">
                    <span className="text-ink">
                        <span className="font-medium text-critical">{formatNumber(summary!.failed!)} {summary!.failed === 1 ? "submission" : "submissions"} failed processing</span> and {summary!.failed === 1 ? "is" : "are"} not in this queue.
                    </span>
                    <button type="button" onClick={() => update({ kind: "FAILED", reviewReason: undefined })} className="text-label-md text-primary hover:underline">View failed submissions</button>
                </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard label="Pending reviews" value={summary?.total} icon="fact_check" />
                <StatCard label={CATEGORY_LABELS.IDENTITY} value={summary?.byCategory.IDENTITY} icon="group" />
                <StatCard label={CATEGORY_LABELS.QUALITY} value={summary?.byCategory.QUALITY} icon="description" />
                <StatCard label={CATEGORY_LABELS.CONFLICT} value={summary?.byCategory.CONFLICT} icon="error" />
            </div>

            <Card className="grid grid-cols-1 gap-2 p-5 md:grid-cols-4">
                <select aria-label="Source" value={params.kind ?? ""} onChange={(e) => update({ kind: e.target.value || undefined })} className={control}>
                    <option value="">All items</option>
                    <option value="PENDING">Files waiting in pending storage</option>
                    <option value="DOCUMENT">Stored documents to review</option>
                    <option value="FAILED">Failed processing{summary?.failed !== undefined ? ` (${formatNumber(summary.failed)})` : ""}</option>
                </select>
                <select aria-label="Review reason" value={params.reviewReason ?? ""} onChange={(e) => update({ reviewReason: e.target.value || undefined })} className={control}>
                    <option value="">All reasons</option>
                    {Object.entries(REVIEW_REASONS).map(([code, { label }]) => <option key={code} value={code}>{label}</option>)}
                </select>
                <select aria-label="Document type" value={params.documentType ?? ""} onChange={(e) => update({ documentType: e.target.value || undefined })} className={control}>
                    <option value="">All types</option>
                    {["PASSPORT", "POLICE_SLIP", "POLICE_REPORT", "MEDICAL", "UNKNOWN"].map((type) => <option key={type} value={type}>{documentTypeLabel(type)}</option>)}
                </select>
                <select aria-label="Sort" value={params.order ?? "asc"} onChange={(e) => update({ order: e.target.value === "asc" ? undefined : e.target.value })} className={control}>
                    <option value="asc">Oldest first</option>
                    <option value="desc">Newest first</option>
                </select>
            </Card>

            <Card>
                {queue.status === "error" && <ErrorState message={queue.error.message} onRetry={queue.reload} />}
                {queue.status === "loading" && <LoadingState label="Loading review queue…" />}
                {queue.status === "success" && data && data.items.length === 0 && (
                    <EmptyState
                        title={showingFailed && !params.documentType && !params.reviewReason ? "No failed submissions" : hasFilters ? "No items match the selected filters" : "Nothing waiting for review"}
                        action={hasFilters ? <button type="button" onClick={() => setSearchParams(new URLSearchParams())} className="text-label-md text-primary hover:underline">Reset filters</button> : undefined}
                    />
                )}
                {queue.status === "success" && data && data.items.length > 0 && (
                    <>
                        <div className="overflow-x-auto">
                            <table className="w-full border-separate border-spacing-0">
                                <caption className="sr-only">Review queue</caption>
                                <thead>
                                    <tr>
                                        {["Item", "Client", "Document type", showingFailed ? "Failure reason" : "Review reason", "Confidence", "Received", "Status", "Action"].map((h) => (
                                            <th key={h} scope="col" className={`${th} ${h === "Confidence" || h === "Action" ? "text-right" : ""}`}>{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.items.map((item) => (
                                        <tr key={item.reviewId} className="hover:bg-canvas">
                                            <td className={td}>
                                                <span className="font-medium text-primary">{shortId(item.reviewId.replace(/^(pending|document|failed)-/, ""))}</span>
                                                <span className="ml-2 text-label-sm text-ink-subtle">{item.kind === "PENDING" ? "Waiting file" : item.kind === "FAILED" ? "Failed" : "Stored"}</span>
                                            </td>
                                            <td className={td}>
                                                {item.client ? (
                                                    <div className="flex flex-col">
                                                        <span className="font-medium text-ink">{item.client.name ?? "—"}</span>
                                                        <span className="text-label-sm text-ink-subtle">{item.client.passportId}</span>
                                                    </div>
                                                ) : <span className="text-ink-subtle">Not identified</span>}
                                            </td>
                                            <td className={td}>{documentTypeLabel(item.documentType)}</td>
                                            <td className={td}>
                                                {item.kind === "FAILED"
                                                    ? <ToneBadge tone="critical">{failureLabel(item.failure?.code)}</ToneBadge>
                                                    : <ToneBadge tone={reviewReasonTone(item.reviewReason)}>{reviewReasonLabel(item.reviewReason)}</ToneBadge>}
                                            </td>
                                            <td className={`${td} text-right`}><Confidence value={item.confidence} /></td>
                                            <td className={`${td} text-label-sm text-ink-muted`}>{formatDateTime(item.receivedDate)}</td>
                                            <td className={td}><StatusBadge status={item.verificationStatus ?? item.processingStatus} /></td>
                                            <td className={`${td} text-right`}>
                                                <Link to={`/review/${encodeURIComponent(item.reviewId)}`} className="text-label-md text-primary hover:underline">{item.kind === "FAILED" ? "View" : "Review"}</Link>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-body-sm text-ink-muted">
                            <p>{formatNumber(data.pagination.total)} {data.pagination.total === 1 ? "item" : "items"}</p>
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
