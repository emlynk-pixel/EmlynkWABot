import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { listMissingDocuments, type MissingDocumentsParams } from "../api/admin";
import { useAdminResource } from "../api/useAdminResource";
import { ClientTable, Pager } from "../components/ClientTable";
import { documentTypeLabel, formatNumber } from "../components/format";
import { Card, EmptyState, ErrorState, LoadingState } from "../components/States";

const PAGE_SIZE = 25;

function paramsFrom(search: URLSearchParams): MissingDocumentsParams {
    const page = Number(search.get("page"));
    return {
        page: Number.isInteger(page) && page > 0 ? page : 1,
        pageSize: PAGE_SIZE,
        search: search.get("search") || undefined,
        documentType: search.get("documentType") || undefined,
    };
}

// Missing-document view (proposal §22, GET /documents/missing): incomplete
// clients, most documents missing first, filterable by the missing type.
export function MissingDocumentsPage() {
    const [searchParams, setSearchParams] = useSearchParams();
    const params = paramsFrom(searchParams);
    const list = useAdminResource(`missing?${searchParams.toString()}`, (token, signal) => listMissingDocuments(token, params, signal));
    const [searchText, setSearchText] = useState(params.search ?? "");
    useEffect(() => setSearchText(params.search ?? ""), [params.search]);

    const update = (changes: Record<string, string | undefined>, { keepPage = false } = {}) => {
        const next = new URLSearchParams(searchParams);
        for (const [name, value] of Object.entries(changes)) {
            if (value) next.set(name, value);
            else next.delete(name);
        }
        if (!keepPage) next.delete("page");
        setSearchParams(next);
    };
    const submitSearch = (event: FormEvent) => {
        event.preventDefault();
        update({ search: searchText.trim() || undefined });
    };
    const data = list.data;
    const summary = data?.summary;
    const control = "h-9 rounded border border-border-strong bg-surface px-2 text-body-sm text-ink focus:border-primary focus:shadow-focus focus:outline-none";
    const hasFilters = Boolean(params.search || params.documentType);

    return (
        <section aria-labelledby="page-title" className="space-y-4">
            <div>
                <h1 id="page-title" className="text-headline-lg text-ink">Missing Documents</h1>
                <p className="mt-1 text-body-sm text-ink-muted">
                    Clients whose required documents are not all verified. "Missing" means nothing of that type has been received; received files still waiting for review are shown with their status.
                </p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Card className="p-4">
                    <p className="text-label-caps uppercase text-ink-subtle">Incomplete clients</p>
                    <p className="mt-1 text-headline-xl tabular-nums text-ink">{summary ? formatNumber(summary.incomplete) : "—"}</p>
                    <p className="mt-1 text-label-sm text-ink-muted">{summary ? `${formatNumber(summary.complete)} complete of ${formatNumber(summary.total)}` : " "}</p>
                </Card>
                {(data?.requiredDocumentTypes ?? []).map((type) => {
                    const active = params.documentType === type;
                    const count = summary?.missingByType[type] ?? 0;
                    return (
                        <button
                            key={type}
                            type="button"
                            aria-pressed={active}
                            onClick={() => update({ documentType: active ? undefined : type })}
                            className={`rounded-lg border bg-surface p-4 text-left shadow-surface hover:border-border-focus ${active ? "border-primary" : "border-border"}`}
                        >
                            <span className="block text-label-caps uppercase text-ink-subtle">Missing {documentTypeLabel(type).toLowerCase()}</span>
                            <span className={`mt-1 block text-headline-xl tabular-nums ${count ? "text-critical" : "text-ink"}`}>{formatNumber(count)}</span>
                        </button>
                    );
                })}
            </div>

            <Card className="p-4">
                <div className="grid grid-cols-1 gap-2 md:grid-cols-12">
                    <form role="search" onSubmit={submitSearch} className="flex gap-2 md:col-span-8">
                        <label htmlFor="missing-search" className="sr-only">Search clients</label>
                        <input
                            id="missing-search"
                            type="search"
                            value={searchText}
                            maxLength={100}
                            onChange={(event) => setSearchText(event.target.value)}
                            placeholder="Search by passport ID, unique ID, name or WhatsApp number…"
                            className={`${control} w-full`}
                        />
                        <button type="submit" className="h-9 rounded bg-primary px-3 text-label-md text-on-primary hover:bg-primary-hover">Search</button>
                    </form>
                    <label className="md:col-span-4">
                        <span className="sr-only">Missing document type</span>
                        <select aria-label="Missing document type" value={params.documentType ?? ""} onChange={(e) => update({ documentType: e.target.value || undefined })} className={`${control} w-full`}>
                            <option value="">All incomplete clients</option>
                            {(data?.requiredDocumentTypes ?? []).map((type) => <option key={type} value={type}>Missing {documentTypeLabel(type).toLowerCase()}</option>)}
                        </select>
                    </label>
                </div>
            </Card>

            <Card>
                {list.status === "error" && <ErrorState message={list.error.message} onRetry={list.reload} />}
                {list.status === "loading" && <LoadingState label="Loading missing documents…" />}
                {list.status === "success" && data && data.items.length === 0 && (
                    <EmptyState
                        title={hasFilters ? "No clients match these filters" : "Every client is complete"}
                        description={hasFilters ? undefined : "All required documents of every client are verified."}
                        action={hasFilters ? <button type="button" onClick={() => setSearchParams(new URLSearchParams())} className="text-label-md text-primary hover:underline">Clear filters</button> : undefined}
                    />
                )}
                {list.status === "success" && data && data.items.length > 0 && (
                    <>
                        <ClientTable items={data.items} caption="Incomplete clients" showWhatsapp={false} />
                        <Pager pagination={data.pagination} noun={["incomplete client", "incomplete clients"]} onPage={(page) => update({ page: String(page) }, { keepPage: true })} />
                    </>
                )}
            </Card>
        </section>
    );
}
