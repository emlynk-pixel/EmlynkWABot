import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { listCandidates } from "../api/candidates";
import { cleanFilters, FILTER_KEYS, getCandidateFilterOptions, type CandidateFilters } from "../api/candidateFilters";
import { jobTypeLabel } from "../api/jobs";
import { ActiveFilterChips, AdvancedFiltersButton } from "../components/AdvancedFilters";
import { CandidateSearchBox } from "../components/CandidateSearchBox";
import { formatNumber } from "../components/format";
import { useAdminResource } from "../api/useAdminResource";
import { canRegisterCandidates, useAuth } from "../auth/AuthProvider";
import { Pager } from "../components/ClientTable";
import { WorkflowStatusBadge } from "../components/candidate/WorkflowStatusBadge";
import { Icon } from "../components/Icon";
import { primaryButton } from "../components/Dialog";
import { Card, EmptyState, ErrorState, LoadingState } from "../components/States";
import { ConflictIndicator } from "../components/candidate/formConflicts";
import { useRef } from "react";

// The server returns one page at a time (at most 100 candidates).
const PAGE_SIZE = 100;
const th = "h-10 whitespace-nowrap border-b border-border px-4 text-left text-label-md text-ink";
const td = "h-10 border-b border-border px-4 py-2 text-body-sm";

// Admin > Candidates: every candidate (users), newest first, 100 a page,
// paged on the server. Search, advanced filters and page live in the URL
// (?page=2&jobType=Welder), so a reload, Back and Forward keep them. The
// server applies the search and every filter (AND) before paging. A row
// opens the candidate's deployment process.
export function CandidatesPage() {
    const { user } = useAuth();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const pageNumber = Number(searchParams.get("page"));
    const page = Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1;
    const search = searchParams.get("search") || undefined;
    const filters = cleanFilters(Object.fromEntries(FILTER_KEYS.map((key) => [key, searchParams.get(key) ?? ""])));
    const filtered = Object.keys(filters).length > 0;
    const list = useAdminResource(`candidates?${searchParams.toString()}`, (token, signal) => listCandidates(token, { page, pageSize: PAGE_SIZE, search, filters }, signal));
    const filterOptions = useAdminResource("candidate-filter-options", (token, signal) => getCandidateFilterOptions(token, signal));
    const [searchText, setSearchText] = useState(search ?? "");
    useEffect(() => setSearchText(search ?? ""), [search]);

    // A new search (typed, or a picked suggestion) or new filters start on page 1; the other one is kept.
    const runSearch = (text: string) => {
        const next = new URLSearchParams(searchParams);
        if (text.trim()) next.set("search", text.trim());
        else next.delete("search");
        next.delete("page");
        setSearchParams(next);
    };
    const submitSearch = (event: FormEvent) => {
        event.preventDefault();
        runSearch(searchText);
    };
    const clearSearch = () => {
        const next = new URLSearchParams(searchParams);
        next.delete("search");
        next.delete("page");
        setSearchParams(next);
    };
    const applyFilters = (nextFilters: CandidateFilters) => {
        const next = new URLSearchParams(searchParams);
        for (const key of FILTER_KEYS) next.delete(key);
        for (const [key, value] of Object.entries(cleanFilters(nextFilters))) next.set(key, value);
        next.delete("page");
        setSearchParams(next);
    };
    const open = (passportId: string) => navigate(`/candidates/${encodeURIComponent(passportId)}`);
    const listRef = useRef<HTMLDivElement>(null);
    const wasErrorRef = useRef(false);
    if (list.status === "error") wasErrorRef.current = true;
    if (list.status === "success") wasErrorRef.current = false;

    // A failed request shows its error only: the rows still held from an
    // earlier search or page are not the results of this one.
    // If retrying after an error, keep them hidden so they don't briefly reappear.
    const data = (list.status === "error" || (list.status === "loading" && wasErrorRef.current)) ? null : list.data;
    // Another page is loading: the current rows stay, dimmed, until it arrives.
    const changingPage = list.status === "loading" && Boolean(data);
    // A page past the last one (a stale link, or the last page emptied by a
    // removal): go to the last page that exists instead of an empty list.
    const pastLastPage = Boolean(data && data.items.length === 0 && data.pagination.total > 0 && page > data.pagination.totalPages);
    const lastPage = data?.pagination.totalPages ?? 1;
    useEffect(() => {
        if (!pastLastPage) return;
        const params = new URLSearchParams(searchParams);
        params.set("page", String(lastPage));
        setSearchParams(params, { replace: true });
    }, [pastLastPage, lastPage, searchParams, setSearchParams]);

    return (
        <section aria-labelledby="page-title" className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <h1 id="page-title" className="text-headline-lg text-ink">Candidates</h1>
                {canRegisterCandidates(user) && (
                    <Link to="/candidates/new" className={`${primaryButton} inline-flex items-center gap-1.5`}>
                        <Icon name="person_add" className="size-4" />Add candidate
                    </Link>
                )}
            </div>

            <Card className="space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                    <form role="search" onSubmit={submitSearch} className="flex min-w-0 flex-1 gap-2 md:max-w-xl">
                        <label htmlFor="candidate-search" className="sr-only">Search candidates</label>
                        <CandidateSearchBox
                            id="candidate-search"
                            value={searchText}
                            onChange={setSearchText}
                            onPick={runSearch}
                            placeholder="Search by name, passport ID, NIC, contact or WhatsApp number…"
                        />
                        <button type="submit" className="h-8 rounded-lg bg-primary px-3 text-label-md text-on-primary hover:bg-primary-hover">Search</button>
                    </form>
                    <AdvancedFiltersButton idPrefix="candidate-filter" value={filters} options={filterOptions.data} onApply={applyFilters} />
                </div>
                <ActiveFilterChips value={filters} options={filterOptions.data} onChange={applyFilters} />
                {filtered && data && (
                    <p className="text-label-sm text-ink-muted" aria-live="polite">
                        {formatNumber(data.pagination.total)} {data.pagination.total === 1 ? "candidate matches" : "candidates match"} the filters (all pages).
                    </p>
                )}
            </Card>

            <Card>
                <div ref={listRef} className="scroll-mt-4" />
                {list.status === "error" && <ErrorState message={list.error.message} onRetry={list.reload} />}
                {((list.status === "loading" && !data) || pastLastPage) && <LoadingState label="Loading candidates…" />}
                {data && data.items.length === 0 && !pastLastPage && (
                    <EmptyState
                        title={filtered ? "No candidates match the selected filters." : search ? "No candidates match this search" : "No candidates yet"}
                        action={filtered
                            ? <button type="button" onClick={() => applyFilters({})} className="text-label-md text-primary hover:underline">Clear filters</button>
                            : search ? <button type="button" onClick={clearSearch} className="text-label-md text-primary hover:underline">Clear search</button> : undefined}
                    />
                )}
                {data && data.items.length > 0 && (
                    <>
                        {changingPage && <p role="status" className="px-4 pt-3 text-label-sm text-ink-muted">Loading page…</p>}
                        <div aria-busy={changingPage} className={`overflow-x-auto transition-opacity ${changingPage ? "opacity-60" : ""}`}>
                            <table className="w-full border-separate border-spacing-0">
                                <caption className="sr-only">Candidates</caption>
                                <thead>
                                    <tr>
                                        <th scope="col" className={th}>Candidate</th>
                                        <th scope="col" className={th}>Job type</th>
                                        <th scope="col" className={th}>Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.items.map((item) => {
                                        const passport = item.passportId?.trim();
                                        const nic = item.nic?.trim();
                                        return (
                                            <tr key={item.passportId} onClick={() => open(item.passportId)} className="cursor-pointer hover:bg-canvas">
                                                <td className={td}>
                                                    <span className="inline-flex items-center gap-1.5">
                                                        <Link to={`/candidates/${encodeURIComponent(item.passportId)}`} onClick={(event) => event.stopPropagation()} className="font-medium text-ink hover:text-primary hover:underline">
                                                            {item.name ?? item.passportId}
                                                        </Link>
                                                        <ConflictIndicator passportId={item.passportId} fields={item.formConflicts} />
                                                    </span>
                                                    {(passport || nic) && (
                                                        <div className="flex flex-wrap items-center gap-x-2 text-label-sm text-ink-subtle">
                                                            {passport && <span title="Passport number">{passport}</span>}
                                                            {passport && nic && (
                                                                <span aria-hidden="true" className="select-none text-ink-subtle">|</span>
                                                            )}
                                                            {nic && <span title="NIC number">{nic}</span>}
                                                        </div>
                                                    )}
                                                </td>
                                                <td className={`${td} text-ink-muted`}>
                                                    {item.jobTypes.length ? (
                                                        <span className="flex flex-wrap gap-1.5">
                                                            {item.jobTypes.map((jobType) => (
                                                                <span key={jobType} className="rounded-lg bg-canvas-muted px-2 py-0.5 text-label-sm text-ink-soft">{jobTypeLabel(jobType)}</span>
                                                            ))}
                                                        </span>
                                                    ) : "—"}
                                                </td>
                                                <td className={`${td} whitespace-nowrap`}><WorkflowStatusBadge status={item.workflowStatus} /></td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                        <Pager
                            pagination={data.pagination}
                            noun={["candidate", "candidates"]}
                            onPage={(next) => {
                                const params = new URLSearchParams(searchParams);
                                params.set("page", String(next));
                                setSearchParams(params);
                                // Back to the top of the list for the new page.
                                listRef.current?.scrollIntoView?.({ block: "start" });
                            }}
                        />
                    </>
                )}
            </Card>
        </section>
    );
}
