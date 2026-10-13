import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import { completeFollowUp, deleteFollowUp, listFollowUps, type FollowUpGroup, type FollowUpItem } from "../api/followUps";
import type { FollowUpStatus } from "../api/candidates";
import { useAdminResource } from "../api/useAdminResource";
import { useAuth } from "../auth/AuthProvider";
import { canDeleteFollowUps } from "../auth/roles";
import { ActionDialog, DialogError, dangerSolidButton, secondaryButton } from "../components/Dialog";
import { formatDate, formatDateTime, formatNumber, formatTime } from "../components/format";
import { NoAnswerBadge } from "../components/candidate/NoAnswerBadge";
import { Icon } from "../components/Icon";
import { Card, EmptyState, ErrorState, LoadingState } from "../components/States";

// Need Attention (internally still the Priority Follow-Ups feature: same
// route, API and audit names): call logs marked as needing attention, one
// card per candidate with their follow-ups (newest first). Open by default;
// Completed shows the history. Every Candidates role can mark one complete;
// ADMIN and MANAGER can delete one. Completing or deleting a follow-up never
// changes the call log: it stays in the candidate's Candidate History.

// Row actions, a size smaller than the dialog buttons.
const compactButton = "h-8 rounded px-3 text-label-md disabled:cursor-not-allowed disabled:opacity-60";
const compactSecondary = `${compactButton} border border-border-strong bg-surface text-ink-soft hover:border-border-focus hover:bg-canvas`;
const compactDanger = "flex h-8 items-center rounded border border-critical-border bg-surface px-2 text-critical hover:bg-critical-bg disabled:cursor-not-allowed disabled:opacity-60";

const FILTERS: { status: FollowUpStatus; label: string }[] = [
    { status: "OPEN", label: "Open" },
    { status: "COMPLETED", label: "Completed" },
];

export function PriorityFollowUpsPage() {
    const { token, user } = useAuth();
    const [searchParams, setSearchParams] = useSearchParams();
    const status: FollowUpStatus = searchParams.get("status") === "completed" ? "COMPLETED" : "OPEN";
    const list = useAdminResource(`follow-ups:${status}`, (t, signal) => listFollowUps(t, status, signal));
    const canDelete = canDeleteFollowUps(user);

    // Follow-ups completed or deleted here leave this view at once.
    const [removed, setRemoved] = useState<Set<string>>(() => new Set());
    const [working, setWorking] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [actionError, setActionError] = useState<{ followUpId: string; message: string } | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<FollowUpItem | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    const groups = (list.data?.groups ?? [])
        .map((group) => ({ ...group, followUps: group.followUps.filter((f) => !removed.has(f.followUpId)) }))
        .filter((group) => group.followUps.length > 0);
    const total = groups.reduce((sum, group) => sum + group.followUps.length, 0);

    const selectFilter = (next: FollowUpStatus) => {
        setNotice(null);
        setActionError(null);
        setSearchParams(next === "COMPLETED" ? { status: "completed" } : {});
    };

    const hide = (followUpId: string) => setRemoved((previous) => new Set(previous).add(followUpId));

    const markComplete = async (item: FollowUpItem) => {
        if (!token || working) return;
        setWorking(item.followUpId);
        setNotice(null);
        setActionError(null);
        try {
            await completeFollowUp(token, item.followUpId);
            hide(item.followUpId);
            setNotice("Follow-up marked complete. The call stays in the candidate's call log.");
        } catch (caught) {
            if (caught instanceof ApiError && caught.status === 409) {
                // Completed elsewhere already: it no longer belongs in Open.
                hide(item.followUpId);
                setNotice("This follow-up was already completed.");
            } else {
                setActionError({ followUpId: item.followUpId, message: caught instanceof ApiError ? caught.message : "The follow-up could not be completed." });
            }
        } finally {
            setWorking(null);
        }
    };

    const confirmAndDelete = async () => {
        if (!token || !confirmDelete || working) return;
        const item = confirmDelete;
        setWorking(item.followUpId);
        setDeleteError(null);
        try {
            await deleteFollowUp(token, item.followUpId);
            hide(item.followUpId);
            setConfirmDelete(null);
            setNotice("Follow-up deleted. The original call log is kept.");
        } catch (caught) {
            if (caught instanceof ApiError && caught.status === 404) {
                hide(item.followUpId);
                setConfirmDelete(null);
                setNotice("This follow-up was already deleted.");
            } else {
                setDeleteError(caught instanceof ApiError ? caught.message : "The follow-up could not be deleted.");
            }
        } finally {
            setWorking(null);
        }
    };

    return (
        <section aria-labelledby="page-title" className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 id="page-title" className="text-headline-lg text-ink">Need Attention</h1>
                    <p className="mt-1 text-body-sm text-ink-muted">Calls and candidate follow-ups that require action.</p>
                </div>
                <div role="group" aria-label="Follow-up status" className="inline-flex rounded border border-border-strong bg-surface p-0.5">
                    {FILTERS.map((filter) => (
                        <button
                            key={filter.status}
                            type="button"
                            aria-pressed={status === filter.status}
                            onClick={() => selectFilter(filter.status)}
                            className={`h-8 rounded-sm px-3 text-label-md ${status === filter.status ? "bg-primary text-on-primary" : "text-ink-soft hover:bg-canvas"}`}
                        >
                            {filter.label}
                        </button>
                    ))}
                </div>
            </div>

            {notice && <div role="status" className="rounded-lg border border-verified-border bg-verified-bg px-3 py-2 text-body-sm text-verified">{notice}</div>}

            {list.status === "loading" && !list.data && <Card><LoadingState label="Loading follow-ups…" /></Card>}
            {list.status === "error" && !list.data && <Card><ErrorState message={list.error.message} onRetry={list.reload} /></Card>}
            {list.data && (
                groups.length === 0
                    ? (
                        <Card>
                            <EmptyState
                                title={status === "OPEN" ? "No open follow-ups." : "No completed follow-ups."}
                                description={status === "OPEN" ? "Calls flagged as needing attention in a candidate's history appear here." : "Follow-ups marked complete appear here."}
                            />
                        </Card>
                    )
                    : (
                        <>
                            <p className="text-label-sm text-ink-muted tabular-nums">
                                {formatNumber(total)} {total === 1 ? "follow-up" : "follow-ups"} · {formatNumber(groups.length)} {groups.length === 1 ? "candidate" : "candidates"}
                                {list.data.truncated && " · showing the newest only"}
                            </p>
                            <ul aria-label="Candidates" className="space-y-3">
                                {groups.map((group) => (
                                    <CandidateGroup
                                        key={group.candidate.passportId}
                                        group={group}
                                        canDelete={canDelete}
                                        working={working}
                                        actionError={actionError}
                                        onComplete={markComplete}
                                        onDelete={(item) => { setDeleteError(null); setConfirmDelete(item); }}
                                    />
                                ))}
                            </ul>
                        </>
                    )
            )}

            {confirmDelete && (
                <ActionDialog title="Delete this follow-up?" busy={working !== null} onClose={() => setConfirmDelete(null)}>
                    <p className="text-body-sm text-ink-soft">
                        The follow-up is removed from Need Attention permanently. The original call log, the candidate and their documents are kept.
                    </p>
                    <blockquote className="mt-3 rounded border border-border bg-canvas px-3 py-2 text-body-sm text-ink-soft [overflow-wrap:anywhere]">
                        {confirmDelete.callLog.note}
                    </blockquote>
                    <DialogError message={deleteError} />
                    <div className="mt-4 flex justify-end gap-2">
                        <button type="button" onClick={() => setConfirmDelete(null)} disabled={working !== null} className={secondaryButton}>Cancel</button>
                        <button type="button" onClick={confirmAndDelete} disabled={working !== null} className={dangerSolidButton}>
                            {working ? "Deleting…" : "Delete follow-up"}
                        </button>
                    </div>
                </ActionDialog>
            )}
        </section>
    );
}

function CandidateGroup({ group, canDelete, working, actionError, onComplete, onDelete }: {
    group: FollowUpGroup;
    canDelete: boolean;
    working: string | null;
    actionError: { followUpId: string; message: string } | null;
    onComplete: (item: FollowUpItem) => void;
    onDelete: (item: FollowUpItem) => void;
}) {
    const { candidate } = group;
    const phone = candidate.whatsappNumber ?? candidate.contactNumber;
    const name = candidate.name ?? candidate.passportId;
    const count = group.followUps.length;
    return (
        <li aria-label={name}>
            <Card className="overflow-hidden">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 pt-3.5 sm:px-5">
                    <div className="min-w-0">
                        <h2 className="truncate text-headline-sm text-ink">
                            <Link to={`/candidates/${encodeURIComponent(candidate.passportId)}`} className="hover:underline">{name}</Link>
                        </h2>
                        <p className="mt-0.5 flex flex-wrap gap-x-3 text-body-sm text-ink-muted tabular-nums">
                            <span><span className="sr-only">Passport ID </span>{candidate.passportId}</span>
                            {phone && <span><span className="sr-only">{candidate.whatsappNumber ? "WhatsApp " : "Contact "}</span>{phone}</span>}
                        </p>
                    </div>
                    <span className="rounded-full border border-border bg-canvas px-2.5 py-0.5 text-label-sm text-ink-muted tabular-nums">
                        {count} {count === 1 ? "follow-up" : "follow-ups"}
                    </span>
                </div>
                <ul aria-label={`Follow-ups for ${name}`} className="mt-3 divide-y divide-border border-t border-border">
                    {group.followUps.map((item) => (
                        <FollowUpRow
                            key={item.followUpId}
                            item={item}
                            canDelete={canDelete}
                            busy={working === item.followUpId}
                            disabled={working !== null}
                            error={actionError?.followUpId === item.followUpId ? actionError.message : null}
                            onComplete={() => onComplete(item)}
                            onDelete={() => onDelete(item)}
                        />
                    ))}
                </ul>
            </Card>
        </li>
    );
}

// One follow-up, laid out like a call in Candidate History: when and who
// called, with the state as a compact flag at the top right; the note (or a
// No Answer badge); then who flagged it and the actions.
function FollowUpRow({ item, canDelete, busy, disabled, error, onComplete, onDelete }: {
    item: FollowUpItem; canDelete: boolean; busy: boolean; disabled: boolean; error: string | null; onComplete: () => void; onDelete: () => void;
}) {
    const open = item.status === "OPEN";
    return (
        // A completed follow-up reads as resolved: the same layout, one step quieter (muted note, muted check).
        <li data-state={open ? "open" : "completed"} className={`px-4 py-3 sm:px-5 ${open ? "" : "bg-canvas/50"}`}>
            <div className="flex items-center justify-between gap-3">
                <p className="flex min-w-min flex-1 flex-wrap items-baseline gap-x-2 text-label-md">
                    <span className="whitespace-nowrap font-semibold text-ink tabular-nums">
                        {formatDate(item.callLog.calledAt)} <span className="font-normal text-ink-subtle">·</span> {formatTime(item.callLog.calledAt)}
                    </span>
                    {item.callLog.adminName && <span className="text-label-sm text-ink-subtle">Called by {item.callLog.adminName}</span>}
                </p>
                <FollowUpFlag open={open} />
            </div>
            {item.callLog.outcome === "NO_ANSWER"
                ? <p className="mt-1.5"><NoAnswerBadge /></p>
                : <p className={`mt-1 whitespace-pre-wrap break-words text-body-sm [overflow-wrap:anywhere] ${open ? "text-ink-soft" : "text-ink-muted"}`}>{item.callLog.note}</p>}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <p className="min-w-0 text-label-sm text-ink-subtle">
                    Flagged {formatDateTime(item.flaggedAt)}{item.flaggedByName ? ` by ${item.flaggedByName}` : ""}
                    {item.completedAt && <> · Completed {formatDateTime(item.completedAt)}{item.completedByName ? ` by ${item.completedByName}` : ""}</>}
                </p>
                {(open || canDelete) && (
                    <div className="flex shrink-0 items-center gap-2">
                        {open && (
                            <button type="button" onClick={onComplete} disabled={disabled} className={compactSecondary}>
                                {busy ? "Saving…" : "Mark complete"}
                            </button>
                        )}
                        {canDelete && (
                            <button type="button" onClick={onDelete} disabled={disabled} aria-label="Delete follow-up" className={compactDanger}>
                                <Icon name="delete" className="size-4" />
                            </button>
                        )}
                    </div>
                )}
            </div>
            {error && <p role="alert" className="mt-2 text-label-sm text-critical">{error}</p>}
        </li>
    );
}

// The follow-up's state as one compact icon, not a text badge, the same as
// beside a call in Candidate History: a filled flag while it needs attention,
// a muted check once completed. The shape differs as well as the colour, and
// the name is spoken (aria-label), with a tooltip as a supplement. It is a
// status here: completing is the Mark complete button.
function FollowUpFlag({ open }: { open: boolean }) {
    const label = open ? "Needs attention" : "Follow-up completed";
    return (
        <span role="img" aria-label={label} title={label} className={`flex size-7 shrink-0 items-center justify-center rounded ${open ? "text-review" : "text-ink-subtle"}`}>
            <Icon name={open ? "flag_fill" : "task_alt"} className="size-4" />
        </span>
    );
}
