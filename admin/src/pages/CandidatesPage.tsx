import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { listCandidates } from "../api/candidates";
import { useAdminResource } from "../api/useAdminResource";
import { canRegisterCandidates, useAuth } from "../auth/AuthProvider";
import { Pager } from "../components/ClientTable";
import { StageSummary } from "../components/candidate/CandidateStepper";
import { Icon } from "../components/Icon";
import { primaryButton } from "../components/Dialog";
import { Card, EmptyState, ErrorState, LoadingState } from "../components/States";
import { useRef } from "react";

// The server returns one page at a time (at most 100 candidates).
const PAGE_SIZE = 100;
const th = "h-[34px] whitespace-nowrap border-b border-border bg-canvas px-4 text-left text-label-caps uppercase text-ink-subtle";
const td = "h-11 border-b border-canvas-muted px-4 py-2 text-body-sm";

// Admin > Candidates: every candidate (users), newest first, 100 a page,
// paged on the server. Search and page live in the URL (?page=2), so a
// reload, Back and Forward keep the page. A row opens the candidate's
// deployment process.
export function CandidatesPage() {
    const { user } = useAuth();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const pageNumber = Number(searchParams.get("page"));
    const page = Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1;
    const search = searchParams.get("search") || undefined;
    const list = useAdminResource(`candidates?${searchParams.toString()}`, (token, signal) => listCandidates(token, { page, pageSize: PAGE_SIZE, search }, signal));
    const [searchText, setSearchText] = useState(search ?? "");
    useEffect(() => setSearchText(search ?? ""), [search]);

    const submitSearch = (event: FormEvent) => {
        event.preventDefault();
        const next = new URLSearchParams();
        if (searchText.trim()) next.set("search", searchText.trim());
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

            <Card className="p-4">
                <form role="search" onSubmit={submitSearch} className="flex gap-2 md:max-w-xl">
                    <label htmlFor="candidate-search" className="sr-only">Search candidates</label>
                    <input
                        id="candidate-search"
                        type="search"
                        value={searchText}
                        maxLength={100}
                        onChange={(event) => setSearchText(event.target.value)}
                        placeholder="Search by name, passport ID, NIC, contact or WhatsApp number…"
                        className="h-9 w-full rounded border border-border-strong bg-surface px-2 text-body-sm text-ink focus:border-primary focus:shadow-focus focus:outline-none"
                    />
                    <button type="submit" className="h-9 rounded bg-primary px-3 text-label-md text-on-primary hover:bg-primary-hover">Search</button>
                </form>
            </Card>

            <Card>
                <div ref={listRef} className="scroll-mt-4" />
                {list.status === "error" && <ErrorState message={list.error.message} onRetry={list.reload} />}
                {((list.status === "loading" && !data) || pastLastPage) && <LoadingState label="Loading candidates…" />}
                {data && data.items.length === 0 && !pastLastPage && (
                    <EmptyState
                        title={search ? "No candidates match this search" : "No candidates yet"}
                        action={search ? <button type="button" onClick={() => setSearchParams(new URLSearchParams())} className="text-label-md text-primary hover:underline">Clear search</button> : undefined}
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
                                        <th scope="col" className={th}>NIC</th>
                                        <th scope="col" className={th}>Job type</th>
                                        <th scope="col" className={th}>Progress</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.items.map((item) => (
                                        <tr key={item.passportId} onClick={() => open(item.passportId)} className="cursor-pointer hover:bg-canvas">
                                            <td className={td}>
                                                <Link to={`/candidates/${encodeURIComponent(item.passportId)}`} onClick={(event) => event.stopPropagation()} className="font-medium text-ink hover:text-primary hover:underline">
                                                    {item.name ?? item.passportId}
                                                </Link>
                                                <span className="block text-label-sm text-ink-subtle">{item.passportId}</span>
                                            </td>
                                            <td className={`${td} whitespace-nowrap text-ink-muted`}>{item.nic ?? "—"}</td>
                                            <td className={`${td} text-ink-muted`}>
                                                {item.jobTypes.length ? (
                                                    <span className="flex flex-wrap gap-1.5">
                                                        {item.jobTypes.map((jobType) => (
                                                            <span key={jobType} className="rounded bg-canvas-muted px-2 py-0.5 text-label-sm text-ink-soft">{jobType}</span>
                                                        ))}
                                                    </span>
                                                ) : "—"}
                                            </td>
                                            <td className={`${td} whitespace-nowrap`}><StageSummary stages={item.stages} /></td>
                                        </tr>
                                    ))}
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
