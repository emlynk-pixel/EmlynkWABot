import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { listClients, type ClientListParams, type Completion } from "../api/admin";
import { useAdminResource } from "../api/useAdminResource";
import { ClientTable, Pager } from "../components/ClientTable";
import { documentTypeLabel, formatNumber } from "../components/format";
import { Card, EmptyState, ErrorState, LoadingState } from "../components/States";

const PAGE_SIZE = 25;
const COMPLETIONS: Completion[] = ["COMPLETE", "INCOMPLETE"];

function paramsFrom(search: URLSearchParams): ClientListParams {
    const page = Number(search.get("page"));
    const completion = search.get("completion") as Completion | null;
    return {
        page: Number.isInteger(page) && page > 0 ? page : 1,
        pageSize: PAGE_SIZE,
        search: search.get("search") || undefined,
        completion: completion && COMPLETIONS.includes(completion) ? completion : undefined,
        missingType: search.get("missingType") || undefined,
    };
}

function SummaryButton({ label, value, active, onClick }: { label: string; value: number | undefined; active: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            aria-pressed={active}
            onClick={onClick}
            className={`rounded-lg border bg-surface p-4 text-left shadow-surface hover:border-border-focus ${active ? "border-primary" : "border-border"}`}
        >
            <span className="block text-label-caps uppercase text-ink-subtle">{label}</span>
            <span className="mt-1 block text-headline-xl tabular-nums text-ink">{value === undefined ? "—" : formatNumber(value)}</span>
        </button>
    );
}

// Clients directory: every client with the status of the required
// documents. Search, filters and page live in the URL.
export function ClientsPage() {
    const [searchParams, setSearchParams] = useSearchParams();
    const params = paramsFrom(searchParams);
    const key = searchParams.toString();
    const list = useAdminResource(`clients?${key}`, (token, signal) => listClients(token, params, signal));
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
    const hasFilters = Boolean(params.search || params.completion || params.missingType);

    return (
        <section aria-labelledby="page-title" className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 id="page-title" className="text-headline-lg text-ink">Clients</h1>
                    <p className="mt-1 text-body-sm text-ink-muted">
                        Every client and their required documents{data ? ` (${data.requiredDocumentTypes.map(documentTypeLabel).join(", ")})` : ""}. A client is complete when each one is verified.
                    </p>
                </div>
                <Link to="/missing-documents" className="text-label-md text-primary hover:underline">Missing Documents view</Link>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <SummaryButton label="Clients" value={summary?.total} active={!params.completion && !params.missingType} onClick={() => update({ completion: undefined, missingType: undefined })} />
                <SummaryButton label="Complete" value={summary?.complete} active={params.completion === "COMPLETE"} onClick={() => update({ completion: params.completion === "COMPLETE" ? undefined : "COMPLETE" })} />
                <SummaryButton label="Incomplete" value={summary?.incomplete} active={params.completion === "INCOMPLETE"} onClick={() => update({ completion: params.completion === "INCOMPLETE" ? undefined : "INCOMPLETE" })} />
                <Link to="/missing-documents" className="rounded-lg border border-border bg-surface p-4 shadow-surface hover:border-border-focus">
                    <span className="block text-label-caps uppercase text-ink-subtle">Missing documents</span>
                    <span className={`mt-1 block text-headline-xl tabular-nums ${summary?.missingDocuments ? "text-critical" : "text-ink"}`}>{summary ? formatNumber(summary.missingDocuments) : "—"}</span>
                    <span className="mt-1 block text-label-sm text-ink-muted">{summary ? `${formatNumber(summary.withMissing)} ${summary.withMissing === 1 ? "client" : "clients"} · open view` : "Open view"}</span>
                </Link>
            </div>

            <Card className="p-4">
                <div className="grid grid-cols-1 gap-2 md:grid-cols-12">
                    <form role="search" onSubmit={submitSearch} className="flex gap-2 md:col-span-6">
                        <label htmlFor="client-search" className="sr-only">Search clients</label>
                        <input
                            id="client-search"
                            type="search"
                            value={searchText}
                            maxLength={100}
                            onChange={(event) => setSearchText(event.target.value)}
                            placeholder="Search by passport ID, unique ID, name or WhatsApp number…"
                            className={`${control} w-full`}
                        />
                        <button type="submit" className="h-9 rounded bg-primary px-3 text-label-md text-on-primary hover:bg-primary-hover">Search</button>
                    </form>
                    <label className="md:col-span-3">
                        <span className="sr-only">Completion</span>
                        <select aria-label="Completion" value={params.completion ?? ""} onChange={(e) => update({ completion: e.target.value || undefined })} className={`${control} w-full`}>
                            <option value="">Complete and incomplete</option>
                            <option value="COMPLETE">Complete</option>
                            <option value="INCOMPLETE">Incomplete</option>
                        </select>
                    </label>
                    <label className="md:col-span-3">
                        <span className="sr-only">Missing document</span>
                        <select aria-label="Missing document" value={params.missingType ?? ""} onChange={(e) => update({ missingType: e.target.value || undefined })} className={`${control} w-full`}>
                            <option value="">Any missing document</option>
                            {(data?.requiredDocumentTypes ?? []).map((type) => (
                                <option key={type} value={type}>Missing {documentTypeLabel(type).toLowerCase()}{summary ? ` (${formatNumber(summary.missingByType[type] ?? 0)})` : ""}</option>
                            ))}
                        </select>
                    </label>
                </div>
            </Card>

            <Card>
                {list.status === "error" && <ErrorState message={list.error.message} onRetry={list.reload} />}
                {list.status === "loading" && <LoadingState label="Loading clients…" />}
                {list.status === "success" && data && data.items.length === 0 && (
                    <EmptyState
                        title={hasFilters ? "No clients match these filters" : "No clients yet"}
                        description={hasFilters ? undefined : "Clients are added from the client records."}
                        action={hasFilters ? <button type="button" onClick={() => setSearchParams(new URLSearchParams())} className="text-label-md text-primary hover:underline">Clear filters</button> : undefined}
                    />
                )}
                {list.status === "success" && data && data.items.length > 0 && (
                    <>
                        <ClientTable items={data.items} caption="Clients" />
                        <Pager pagination={data.pagination} noun={["client", "clients"]} onPage={(page) => update({ page: String(page) }, { keepPage: true })} />
                    </>
                )}
            </Card>
        </section>
    );
}
