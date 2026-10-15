import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import { STAGE_LABELS } from "../api/candidates";
import { useAdminResource } from "../api/useAdminResource";
import {
    assignCandidates,
    listAllocationAnalysts,
    listAllocationCandidates,
    unassignCandidates,
    type AllocationCandidate,
    type AllocationStatus,
} from "../api/workAllocation";
import { canManageAllocations, useAuth } from "../auth/AuthProvider";
import { Pager } from "../components/ClientTable";
import { ActionDialog, DialogError, dangerSolidButton, primaryButton, secondaryButton } from "../components/Dialog";
import { formatDate, formatNumber } from "../components/format";
import { Icon } from "../components/Icon";
import { Card, EmptyState, ErrorState, LoadingState } from "../components/States";

// Admin > Work Allocation (ADMIN and MANAGER): assign candidates to
// Analysts. The list is paged on the server (100 a page, newest registered
// first), like Candidates. Selection is per page: Select all ticks the rows
// on this page only, and changing page, view or search clears it, so a
// selection can never silently grow beyond what is on screen. One request
// assigns the whole selection (all or nothing on the server).

const th = "h-[34px] whitespace-nowrap border-b border-border bg-canvas px-3 text-left text-label-caps uppercase text-ink-subtle";
const td = "h-11 border-b border-canvas-muted px-3 py-2 text-body-sm align-middle";
const countInput = "h-8 w-16 rounded border border-border-strong bg-surface px-2 text-right text-body-sm tabular-nums text-ink focus:border-primary focus:shadow-focus focus:outline-none";

const VIEWS: { status: AllocationStatus; label: string }[] = [
    { status: "UNALLOCATED", label: "Unallocated" },
    { status: "ALLOCATED", label: "Allocated" },
];

export function WorkAllocationPage() {
    const { user } = useAuth();
    if (!canManageAllocations(user)) {
        return (
            <div className="mx-auto max-w-4xl p-6">
                <div role="alert" className="rounded border border-critical-border bg-critical-bg p-6 text-center text-critical">
                    <Icon name="lock" className="mx-auto mb-2 size-8 text-critical" />
                    <h1 className="text-headline-sm font-semibold">Access Restricted</h1>
                    <p className="mt-1 text-body-sm text-ink-muted">Only Managers and Admins can allocate candidates.</p>
                </div>
            </div>
        );
    }
    return <WorkAllocationView />;
}

function WorkAllocationView() {
    const { token } = useAuth();
    const [searchParams, setSearchParams] = useSearchParams();
    const status: AllocationStatus = searchParams.get("view") === "allocated" ? "ALLOCATED" : "UNALLOCATED";
    const analystFilter = status === "ALLOCATED" ? searchParams.get("analyst") || undefined : undefined;
    const search = searchParams.get("search") || undefined;
    const pageNumber = Number(searchParams.get("page"));
    const page = Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1;

    const list = useAdminResource(`work-allocation?${searchParams.toString()}`, (t, signal) => listAllocationCandidates(t, { status, analystId: analystFilter, search, page }, signal));
    const analysts = useAdminResource("work-allocation-analysts", (t, signal) => listAllocationAnalysts(t, signal));

    const [searchText, setSearchText] = useState(search ?? "");
    useEffect(() => setSearchText(search ?? ""), [search]);
    // Selected rows of the current page, in table order.
    const [selected, setSelected] = useState<Map<string, AllocationCandidate>>(new Map());
    const [counts, setCounts] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<"reassign" | "unassign" | null>(null);

    // A new page, view or search starts with nothing selected.
    const listKey = searchParams.toString();
    useEffect(() => {
        setSelected(new Map());
        setCounts({});
    }, [listKey]);

    const go = (changes: Record<string, string | null>) => {
        const next = new URLSearchParams(searchParams);
        for (const [key, value] of Object.entries(changes)) {
            if (value) next.set(key, value);
            else next.delete(key);
        }
        if (!("page" in changes)) next.delete("page");
        setSearchParams(next);
        setNotice(null);
        setActionError(null);
    };
    const submitSearch = (event: FormEvent) => {
        event.preventDefault();
        go({ search: searchText.trim() || null });
    };

    const items = list.status === "error" ? [] : list.data?.items ?? [];
    const allOnPage = items.length > 0 && items.every((item) => selected.has(item.passportId));
    const toggle = (item: AllocationCandidate) => setSelected((previous) => {
        const next = new Map(previous);
        if (next.has(item.passportId)) next.delete(item.passportId);
        else next.set(item.passportId, item);
        return next;
    });
    const toggleAll = () => setSelected(allOnPage ? new Map() : new Map(items.map((item) => [item.passportId, item])));
    const clearSelection = () => {
        setSelected(new Map());
        setCounts({});
    };

    const selection = [...selected.values()];
    const selectedCount = selection.length;
    const alreadyAllocated = selection.filter((item) => item.analyst);
    const activeAnalysts = analysts.data?.analysts ?? [];
    const parsedCounts = activeAnalysts.map((analyst) => {
        const raw = (counts[analyst.analystId] ?? "").trim();
        const value = raw === "" ? 0 : Number(raw);
        return { analyst, raw, value, valid: raw === "" || (/^\d+$/.test(raw) && Number.isInteger(value)) };
    });
    const total = parsedCounts.reduce((sum, entry) => sum + (entry.valid ? entry.value : 0), 0);
    const invalidCount = parsedCounts.some((entry) => !entry.valid);
    const validation = useMemo(() => {
        if (!selectedCount) return "Select candidates in the table to allocate them.";
        if (invalidCount) return "Counts must be whole numbers, 0 or more.";
        if (total !== selectedCount) return `The counts add up to ${formatNumber(total)}; they must add up to the ${formatNumber(selectedCount)} selected.`;
        return null;
    }, [selectedCount, invalidCount, total]);

    const giveAllTo = (analystId: string) => setCounts(Object.fromEntries(activeAnalysts.map((a) => [a.analystId, a.analystId === analystId ? String(selectedCount) : ""])));

    const reloadAll = () => {
        list.reload();
        analysts.reload();
    };
    const failed = (error: unknown) => {
        setActionError(error instanceof ApiError ? error.message : "Something went wrong. Please try again.");
        // A conflict means what is on screen is out of date (another manager
        // allocated the same candidates, an Analyst was deactivated, a
        // candidate went away): show the current state, drop the selection
        // made from the old one, and keep the message (it moves from the
        // dialog to the page banner).
        if (error instanceof ApiError && error.status === 409) {
            setConfirm(null);
            clearSelection();
            reloadAll();
        }
    };

    const runAssign = async () => {
        if (!token || validation || busy) return;
        setBusy(true);
        setActionError(null);
        setNotice(null);
        try {
            const result = await assignCandidates(token, {
                candidateIds: selection.map((item) => item.passportId),
                allocations: parsedCounts.filter((entry) => entry.value > 0).map((entry) => ({ analystId: entry.analyst.analystId, count: entry.value })),
                reassign: alreadyAllocated.length > 0,
            });
            const parts = result.byAnalyst.map((entry) => `${entry.name} ${formatNumber(entry.count)}`).join(", ");
            const moved = result.reassigned ? ` (${formatNumber(result.reassigned)} reassigned)` : "";
            setNotice(`Allocated ${formatNumber(result.assigned + result.reassigned + result.unchanged)} candidates${moved}: ${parts}.`);
            setConfirm(null);
            clearSelection();
            reloadAll();
        } catch (error) {
            failed(error);
        } finally {
            setBusy(false);
        }
    };
    const runUnassign = async () => {
        if (!token || busy) return;
        setBusy(true);
        setActionError(null);
        setNotice(null);
        try {
            const result = await unassignCandidates(token, alreadyAllocated.map((item) => item.passportId));
            setNotice(`${formatNumber(result.unassigned)} ${result.unassigned === 1 ? "candidate is" : "candidates are"} unallocated again.`);
            setConfirm(null);
            clearSelection();
            reloadAll();
        } catch (error) {
            failed(error);
        } finally {
            setBusy(false);
        }
    };
    const onAssign = () => (alreadyAllocated.length ? setConfirm("reassign") : runAssign());

    const data = list.status === "error" ? null : list.data;
    const changingPage = list.status === "loading" && Boolean(data);

    // The page can end up beyond the last one (candidates were unallocated, or
    // the URL was edited): the server answers an empty page, and the view moves
    // to the last page that exists (the first when there is none) instead of
    // showing an empty list as if nothing were allocated at all.
    const lastPage = data?.pagination.totalPages ?? 1;
    const pastLastPage = list.status === "success" && data !== null && data.items.length === 0 && page > lastPage;
    useEffect(() => {
        if (!pastLastPage) return;
        const next = new URLSearchParams(searchParams);
        if (lastPage > 1) next.set("page", String(lastPage));
        else next.delete("page");
        setSearchParams(next, { replace: true });
        // searchParams is read once per recovery; the list key changes with it.
    }, [pastLastPage, lastPage]);
    const emptyTitle = search
        ? "No candidates match this search."
        : page > 1
            ? "There are no candidates on this page."
            : status === "UNALLOCATED"
                ? "All candidates are currently allocated."
                : analystFilter
                    ? "No candidates are allocated to this Analyst."
                    : "No candidates are allocated yet.";
    const filterAnalysts = [...activeAnalysts, ...(analysts.data?.unavailableAnalysts ?? [])];

    return (
        <section aria-labelledby="page-title" className="space-y-4">
            <div>
                <h1 id="page-title" className="text-headline-lg text-ink">Work Allocation</h1>
                <p className="mt-1 text-body-sm text-ink-muted">Assign candidates to Analysts. An Analyst only sees and works on the candidates allocated to them.</p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
                <div role="group" aria-label="View" className="flex gap-1 rounded-md border border-border bg-surface p-1">
                    {VIEWS.map((view) => (
                        <button
                            key={view.status}
                            type="button"
                            aria-pressed={status === view.status}
                            onClick={() => go({ view: view.status === "ALLOCATED" ? "allocated" : null, analyst: null })}
                            className={`h-8 rounded px-3 text-label-md ${status === view.status ? "bg-primary text-on-primary" : "text-ink-soft hover:bg-canvas"}`}
                        >
                            {view.label}
                            {view.status === "UNALLOCATED" && analysts.data && <span className="ml-1.5 tabular-nums opacity-80">{formatNumber(analysts.data.unallocatedCount)}</span>}
                        </button>
                    ))}
                </div>
                <form role="search" onSubmit={submitSearch} className="flex w-full gap-2 sm:w-auto sm:min-w-[22rem]">
                    <label htmlFor="allocation-search" className="sr-only">Search candidates</label>
                    <input
                        id="allocation-search"
                        type="search"
                        value={searchText}
                        maxLength={100}
                        onChange={(event) => setSearchText(event.target.value)}
                        placeholder="Name, passport ID, contact or WhatsApp number…"
                        className="h-9 w-full rounded border border-border-strong bg-surface px-2 text-body-sm text-ink focus:border-primary focus:shadow-focus focus:outline-none"
                    />
                    <button type="submit" className="h-9 rounded bg-primary px-3 text-label-md text-on-primary hover:bg-primary-hover">Search</button>
                </form>
            </div>

            {notice && <div role="status" className="rounded-lg border border-verified-border bg-verified-bg px-3 py-2 text-body-sm text-verified">{notice}</div>}
            {actionError && !confirm && <p role="alert" className="rounded border border-critical-border bg-critical-bg px-3 py-2 text-body-sm text-critical">{actionError}</p>}

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
                <Card>
                    <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2">
                        <span className="text-label-md text-ink tabular-nums" aria-live="polite">{formatNumber(selectedCount)} selected</span>
                        {selectedCount > 0 && <button type="button" onClick={clearSelection} className="text-label-md text-primary hover:underline">Clear selection</button>}
                        {status === "ALLOCATED" && (
                            <label className="ml-auto flex items-center gap-2 text-label-md text-ink-soft">
                                Analyst
                                <select
                                    value={analystFilter ?? ""}
                                    onChange={(event) => go({ analyst: event.target.value || null })}
                                    className="h-8 rounded border border-border-strong bg-surface px-2 text-body-sm text-ink"
                                >
                                    <option value="">All Analysts</option>
                                    {filterAnalysts.map((analyst) => <option key={analyst.analystId} value={analyst.analystId}>{analyst.name}</option>)}
                                </select>
                            </label>
                        )}
                    </div>
                    {list.status === "error" && <ErrorState message={list.error.message} onRetry={list.reload} />}
                    {list.status === "loading" && !data && <LoadingState label="Loading candidates…" />}
                    {pastLastPage && <LoadingState label="Loading candidates…" />}
                    {data && data.items.length === 0 && !pastLastPage && (
                        <EmptyState
                            title={emptyTitle}
                            action={search
                                ? <button type="button" onClick={() => go({ search: null })} className="text-label-md text-primary hover:underline">Clear search</button>
                                : page > 1
                                    ? <button type="button" onClick={() => go({ page: null })} className="text-label-md text-primary hover:underline">Go to the first page</button>
                                    : undefined}
                        />
                    )}
                    {data && data.items.length > 0 && (
                        <>
                            {changingPage && <p role="status" className="px-3 pt-3 text-label-sm text-ink-muted">Loading page…</p>}
                            <div aria-busy={changingPage} className={`overflow-x-auto ${changingPage ? "opacity-60" : ""}`}>
                                <table className="w-full min-w-[56rem] border-separate border-spacing-0">
                                    <caption className="sr-only">Candidates to allocate</caption>
                                    <thead>
                                        <tr>
                                            <th scope="col" className={`${th} w-10`}>
                                                <input type="checkbox" aria-label="Select all on this page" checked={allOnPage} onChange={toggleAll} className="size-4 accent-primary" />
                                            </th>
                                            <th scope="col" className={th}>Passport number</th>
                                            <th scope="col" className={th}>Candidate</th>
                                            <th scope="col" className={th}>Contact / WhatsApp</th>
                                            <th scope="col" className={th}>Registered</th>
                                            <th scope="col" className={th}>Current stage</th>
                                            <th scope="col" className={th}>Analyst</th>
                                            <th scope="col" className={th}>Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.items.map((item) => {
                                            const checked = selected.has(item.passportId);
                                            return (
                                                <tr key={item.passportId} className={checked ? "bg-primary-soft" : "hover:bg-canvas"}>
                                                    <td className={td}>
                                                        <input type="checkbox" aria-label={`Select ${item.name ?? item.passportId}`} checked={checked} onChange={() => toggle(item)} className="size-4 accent-primary" />
                                                    </td>
                                                    <td className={`${td} whitespace-nowrap`}>
                                                        <Link to={`/candidates/${encodeURIComponent(item.passportId)}`} className="text-ink hover:text-primary hover:underline">{item.passportId}</Link>
                                                    </td>
                                                    <td className={`${td} text-ink`}>{item.name ?? "—"}</td>
                                                    <td className={`${td} whitespace-nowrap text-ink-muted`}>
                                                        <span className="block">{item.contactNumber ?? "—"}</span>
                                                        {item.whatsappNumber && <span className="block text-label-sm text-ink-subtle">WA {item.whatsappNumber}</span>}
                                                    </td>
                                                    <td className={`${td} whitespace-nowrap text-ink-muted`}>{formatDate(item.registeredDate)}</td>
                                                    <td className={`${td} text-ink-muted`}>
                                                        <span className="block">{item.currentStage ? STAGE_LABELS[item.currentStage] : "All stages completed"}</span>
                                                        <span className="block text-label-sm tabular-nums text-ink-subtle">{item.stagesCompleted}/{item.stagesTotal}</span>
                                                    </td>
                                                    <td className={`${td} text-ink-muted`}>
                                                        {item.analyst ? (
                                                            <>
                                                                {item.analyst.name}
                                                                {!item.analyst.active && <span className="ml-1 text-label-sm text-critical">(inactive)</span>}
                                                            </>
                                                        ) : "—"}
                                                    </td>
                                                    <td className={td}>
                                                        <span className={`rounded px-2 py-0.5 text-label-sm ${item.analyst ? "bg-verified-bg text-verified" : "bg-pending-bg text-pending"}`}>
                                                            {item.analyst ? "Allocated" : "Unallocated"}
                                                        </span>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                            <Pager pagination={data.pagination} noun={["candidate", "candidates"]} onPage={(next) => go({ page: String(next) })} />
                        </>
                    )}
                </Card>

                <Card className="h-fit p-4">
                    <h2 className="text-headline-sm text-ink">Allocate</h2>
                    <p className="mt-1 text-body-sm text-ink-muted tabular-nums">
                        {formatNumber(selectedCount)} selected
                        {alreadyAllocated.length > 0 && <span className="text-review"> · {formatNumber(alreadyAllocated.length)} already allocated</span>}
                    </p>
                    {analysts.status === "error" && <ErrorState message={analysts.error.message} onRetry={analysts.reload} />}
                    {analysts.status === "loading" && !analysts.data && <LoadingState label="Loading Analysts…" />}
                    {analysts.data && activeAnalysts.length === 0 && (
                        <p className="mt-3 rounded border border-border bg-canvas px-3 py-2 text-body-sm text-ink-muted">No active Analysts are available for allocation.</p>
                    )}
                    {activeAnalysts.length > 0 && (
                        <>
                            <ul aria-label="Analysts" className="mt-3 divide-y divide-border">
                                {parsedCounts.map(({ analyst, raw, value, valid }) => (
                                    <li key={analyst.analystId} className="flex items-center gap-2 py-2">
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-body-sm text-ink">{analyst.name}</p>
                                            <p className="text-label-sm text-ink-subtle tabular-nums">
                                                {formatNumber(analyst.assignedCount)} {analyst.assignedCount === 1 ? "candidate" : "candidates"}
                                                {valid && value > 0 && <span className="text-primary"> → {formatNumber(analyst.assignedCount + value)}</span>}
                                            </p>
                                        </div>
                                        <button type="button" onClick={() => giveAllTo(analyst.analystId)} disabled={!selectedCount || busy} className="text-label-sm text-primary hover:underline disabled:text-ink-subtle disabled:no-underline">All</button>
                                        <input
                                            type="text"
                                            inputMode="numeric"
                                            aria-label={`Candidates for ${analyst.name}`}
                                            aria-invalid={!valid}
                                            value={raw}
                                            placeholder="0"
                                            disabled={!selectedCount || busy}
                                            onChange={(event) => setCounts((previous) => ({ ...previous, [analyst.analystId]: event.target.value }))}
                                            className={`${countInput} ${valid ? "" : "border-critical"}`}
                                        />
                                    </li>
                                ))}
                            </ul>
                            <p className="mt-2 flex justify-between border-t border-border pt-2 text-label-md tabular-nums">
                                <span className="text-ink-soft">Total</span>
                                <span className={selectedCount && total === selectedCount ? "text-verified" : "text-ink"}>{formatNumber(total)} / {formatNumber(selectedCount)}</span>
                            </p>
                            {validation && selectedCount > 0 && <p className="mt-1 text-label-sm text-ink-muted">{validation}</p>}
                            <button type="button" onClick={onAssign} disabled={Boolean(validation) || busy} className={`${primaryButton} mt-3 w-full`}>
                                {busy && !confirm ? "Saving…" : alreadyAllocated.length ? `Reassign ${formatNumber(selectedCount)} candidates` : `Assign ${formatNumber(selectedCount)} candidates`}
                            </button>
                        </>
                    )}
                    {alreadyAllocated.length > 0 && (
                        <button type="button" onClick={() => setConfirm("unassign")} disabled={busy} className={`${secondaryButton} mt-2 w-full`}>
                            Unassign {formatNumber(alreadyAllocated.length)}
                        </button>
                    )}
                </Card>
            </div>

            {confirm === "reassign" && (
                <ActionDialog title="Reassign candidates?" busy={busy} onClose={() => setConfirm(null)}>
                    <p className="text-body-sm text-ink-soft">
                        {formatNumber(alreadyAllocated.length)} of the {formatNumber(selectedCount)} selected candidates already have an Analyst. They will move to the new Analysts, and their current Analysts lose access to them immediately.
                    </p>
                    <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto text-body-sm text-ink-muted">
                        {alreadyAllocated.map((item) => <li key={item.passportId}>{item.name ?? item.passportId} · now {item.analyst?.name}</li>)}
                    </ul>
                    <DialogError message={actionError} />
                    <div className="mt-4 flex justify-end gap-2">
                        <button type="button" onClick={() => setConfirm(null)} disabled={busy} className={secondaryButton}>Cancel</button>
                        <button type="button" onClick={runAssign} disabled={busy} className={primaryButton}>{busy ? "Saving…" : "Reassign"}</button>
                    </div>
                </ActionDialog>
            )}
            {confirm === "unassign" && (
                <ActionDialog title="Unassign candidates?" busy={busy} onClose={() => setConfirm(null)}>
                    <p className="text-body-sm text-ink-soft">
                        {formatNumber(alreadyAllocated.length)} {alreadyAllocated.length === 1 ? "candidate goes" : "candidates go"} back to Unallocated. Their Analysts lose access to them immediately.
                    </p>
                    <DialogError message={actionError} />
                    <div className="mt-4 flex justify-end gap-2">
                        <button type="button" onClick={() => setConfirm(null)} disabled={busy} className={secondaryButton}>Cancel</button>
                        <button type="button" onClick={runUnassign} disabled={busy} className={dangerSolidButton}>{busy ? "Saving…" : "Unassign"}</button>
                    </div>
                </ActionDialog>
            )}
        </section>
    );
}
