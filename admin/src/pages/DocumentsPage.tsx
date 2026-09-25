import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { listDocuments, type DocumentListParams } from "../api/admin";
import { useAdminResource } from "../api/useAdminResource";
import { DocumentsTable } from "../components/DocumentsTable";
import { formatNumber } from "../components/format";
import { Card, EmptyState, ErrorState, LoadingState } from "../components/States";

const PAGE_SIZE = 25;
const FILTER_KEYS = ["search", "documentType", "verificationStatus", "receivedFrom", "receivedTo", "sort", "order", "page"] as const;

const TYPE_OPTIONS = [
    ["", "All types"], ["PASSPORT", "Passport"], ["POLICE_SLIP", "Police slip"], ["POLICE_REPORT", "Police report"], ["MEDICAL", "Medical"],
] as const;
const SORT_OPTIONS = [
    ["receivedDate:desc", "Newest first"], ["receivedDate:asc", "Oldest first"],
    ["ocrConfidence:asc", "Lowest confidence"], ["ocrConfidence:desc", "Highest confidence"], ["documentType:asc", "Type (A–Z)"],
] as const;

// Filters live in the URL, so reload, back/forward and links from the
// Overview (e.g. ?verificationStatus=REVIEW_REQUIRED) keep them.
function paramsFrom(search: URLSearchParams): DocumentListParams {
    const page = Number(search.get("page"));
    return {
        page: Number.isInteger(page) && page > 0 ? page : 1,
        pageSize: PAGE_SIZE,
        search: search.get("search") ?? undefined,
        documentType: search.get("documentType") ?? undefined,
        verificationStatus: search.get("verificationStatus") ?? undefined,
        receivedFrom: search.get("receivedFrom") ?? undefined,
        receivedTo: search.get("receivedTo") ?? undefined,
        sort: (search.get("sort") as DocumentListParams["sort"]) ?? undefined,
        order: (search.get("order") as DocumentListParams["order"]) ?? undefined,
    };
}

export function DocumentsPage() {
    const [searchParams, setSearchParams] = useSearchParams();
    const params = paramsFrom(searchParams);
    const key = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
    const documents = useAdminResource(`documents?${key}`, (token, signal) => listDocuments(token, params, signal));
    const [searchText, setSearchText] = useState(params.search ?? "");

    useEffect(() => setSearchText(params.search ?? ""), [params.search]);

    // Any filter change starts again at page 1.
    const update = (changes: Record<string, string | undefined>, { keepPage = false } = {}) => {
        const next = new URLSearchParams(searchParams);
        for (const [name, value] of Object.entries(changes)) {
            if (value) next.set(name, value);
            else next.delete(name);
        }
        if (!keepPage) next.delete("page");
        setSearchParams(next);
    };

    const submitSearch = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        update({ search: searchText.trim() || undefined });
    };

    const hasFilters = FILTER_KEYS.some((name) => name !== "page" && searchParams.get(name));
    const resetFilters = () => setSearchParams(new URLSearchParams());
    const data = documents.data;
    const summary = data?.summary;
    const chips: [string | undefined, string, number | undefined][] = [
        [undefined, "All", summary?.total],
        ["VERIFIED", "Verified", summary?.byVerificationStatus.VERIFIED ?? 0],
        ["REVIEW_REQUIRED", "Review required", summary?.byVerificationStatus.REVIEW_REQUIRED ?? 0],
    ];

    const control = "h-9 rounded border border-border-strong bg-surface px-2 text-body-sm text-ink focus:border-primary focus:shadow-focus focus:outline-none";
    const sortValue = `${params.sort ?? "receivedDate"}:${params.order ?? "desc"}`;

    return (
        <section aria-labelledby="page-title" className="space-y-4">
            <div>
                <h1 id="page-title" className="text-headline-lg text-ink">Documents</h1>
                <p className="mt-1 text-body-sm text-ink-muted">Files stored in client folders, with their verification status.</p>
            </div>

            <Card className="space-y-3 p-4">
                <div className="grid grid-cols-1 gap-2 md:grid-cols-12">
                    <form role="search" onSubmit={submitSearch} className="flex gap-2 md:col-span-5">
                        <label htmlFor="document-search" className="sr-only">Search documents</label>
                        <input
                            id="document-search"
                            type="search"
                            value={searchText}
                            maxLength={100}
                            onChange={(event) => setSearchText(event.target.value)}
                            placeholder="Search by document ID, client name, passport or unique ID…"
                            className={`${control} w-full`}
                        />
                        <button type="submit" className="h-9 rounded bg-primary px-3 text-label-md text-white hover:bg-primary-hover">Search</button>
                    </form>
                    <label className="md:col-span-2">
                        <span className="sr-only">Document type</span>
                        <select aria-label="Document type" value={params.documentType ?? ""} onChange={(event) => update({ documentType: event.target.value || undefined })} className={`${control} w-full`}>
                            {TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                    </label>
                    <label className="flex items-center gap-1 md:col-span-3">
                        <span className="sr-only">Received from</span>
                        <input aria-label="Received from" type="date" value={params.receivedFrom ?? ""} max={params.receivedTo} onChange={(event) => update({ receivedFrom: event.target.value || undefined })} className={`${control} w-full`} />
                        <span aria-hidden="true" className="text-ink-subtle">–</span>
                        <span className="sr-only">Received to</span>
                        <input aria-label="Received to" type="date" value={params.receivedTo ?? ""} min={params.receivedFrom} onChange={(event) => update({ receivedTo: event.target.value || undefined })} className={`${control} w-full`} />
                    </label>
                    <label className="md:col-span-2">
                        <span className="sr-only">Sort</span>
                        <select
                            aria-label="Sort"
                            value={sortValue}
                            onChange={(event) => {
                                const [sort, order] = event.target.value.split(":");
                                update({ sort, order });
                            }}
                            className={`${control} w-full`}
                        >
                            {SORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                    </label>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Verification status">
                        {chips.map(([value, label, count]) => {
                            const active = (params.verificationStatus ?? undefined) === value;
                            return (
                                <button
                                    key={label}
                                    type="button"
                                    aria-pressed={active}
                                    onClick={() => update({ verificationStatus: value })}
                                    className={`rounded-full px-3 py-1 text-label-sm ${active ? "bg-primary text-white" : "bg-canvas-muted text-ink-muted hover:text-ink"}`}
                                >
                                    {label}{count !== undefined ? ` (${formatNumber(count)})` : ""}
                                </button>
                            );
                        })}
                    </div>
                    {hasFilters && (
                        <button type="button" onClick={resetFilters} className="text-label-md text-primary hover:underline">Reset all filters</button>
                    )}
                </div>
            </Card>

            <Card>
                {documents.status === "error" && <ErrorState message={documents.error.message} onRetry={documents.reload} />}
                {documents.status === "loading" && <LoadingState label="Loading documents…" />}
                {documents.status === "success" && data && data.items.length === 0 && (
                    <EmptyState
                        title="No documents match the selected criteria"
                        description={hasFilters ? "Try other filters or reset them." : "No documents have been stored yet."}
                        action={hasFilters ? <button type="button" onClick={resetFilters} className="text-label-md text-primary hover:underline">Reset all filters</button> : undefined}
                    />
                )}
                {documents.status === "success" && data && data.items.length > 0 && (
                    <>
                        <DocumentsTable documents={data.items} caption="Documents" />
                        <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-body-sm text-ink-muted">
                            <p>
                                Showing {formatNumber((data.pagination.page - 1) * data.pagination.pageSize + 1)}–
                                {formatNumber((data.pagination.page - 1) * data.pagination.pageSize + data.items.length)} of {formatNumber(data.pagination.total)}
                            </p>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    disabled={data.pagination.page <= 1}
                                    onClick={() => update({ page: String(data.pagination.page - 1) }, { keepPage: true })}
                                    className="h-8 rounded border border-border-strong bg-surface px-3 text-label-md text-ink-soft disabled:opacity-50"
                                >
                                    Previous
                                </button>
                                <span aria-current="page">Page {data.pagination.page} of {data.pagination.totalPages}</span>
                                <button
                                    type="button"
                                    disabled={data.pagination.page >= data.pagination.totalPages}
                                    onClick={() => update({ page: String(data.pagination.page + 1) }, { keepPage: true })}
                                    className="h-8 rounded border border-border-strong bg-surface px-3 text-label-md text-ink-soft disabled:opacity-50"
                                >
                                    Next
                                </button>
                            </div>
                        </nav>
                    </>
                )}
            </Card>
        </section>
    );
}
