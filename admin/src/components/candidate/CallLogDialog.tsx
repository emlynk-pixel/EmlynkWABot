import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { ApiError } from "../../api/client";
import { useAdminResource } from "../../api/useAdminResource";
import { addCallLog, flagCallLog, listCallLogs, type CallLogEntry, type CallLogList, type CandidateActivity } from "../../api/candidates";
import { DialogError, buttonBase, primaryButton, secondaryButton } from "../Dialog";
import { formatDate, formatTime, nowInSriLanka, sriLankaDateTime } from "../format";
import { Icon, type IconName } from "../Icon";
import { ErrorState, LoadingState } from "../States";
import { Field, fieldControl, textAreaControl } from "./CandidateFields";
import { describeActivity, historyTimeline } from "./candidateHistory";

const NOTE_MAX_LENGTH = 500;
// The server allows a few minutes of clock difference; so does this check.
const CLOCK_SKEW_MS = 5 * 60 * 1000;
// Matches the panel's slide transition (duration-200).
const CLOSE_ANIMATION_MS = 200;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type CallLogCandidate = { name: string | null; passportId: string; whatsappNumber: string | null; contactNumber: string | null };

const prefersReducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Candidate History: the calls made to the candidate (date and time, who
// called, a short note of what the candidate said) and what happened to the
// candidate (documents received, details and stages saved), as one timeline,
// newest first. A new call defaults to now. A call can be marked as needing
// attention (the flag beside the caller, or Need Attention when adding it):
// it then also appears in Priority Follow-Ups (the call itself stays here,
// unchanged).
// Opens as a drawer from the right over the candidate page; Escape, Close or
// a click on the page outside the drawer closes it, except while a call is
// being saved.
export function CallLogDialog({ passportId, candidate, canEdit, onClose }: { passportId: string; candidate?: CallLogCandidate; canEdit: boolean; onClose: () => void }) {
    const { token } = useAuth();
    const log = useAdminResource(`call-logs:${passportId}`, (t, signal) => listCallLogs(t, passportId, signal));
    const [added, setAdded] = useState<CallLogList | null>(null);
    const [when, setWhen] = useState(() => nowInSriLanka());
    const [note, setNote] = useState("");
    const [needsAttention, setNeedsAttention] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [shown, setShown] = useState(false);
    // Guards against a second submit before `busy` has re-rendered.
    const submitting = useRef(false);
    // The call being marked for follow-up (one at a time), and any error.
    const [flagging, setFlagging] = useState<string | null>(null);
    const [flagError, setFlagError] = useState<{ callLogId: string; message: string } | null>(null);
    const flaggingRef = useRef(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const closeRef = useRef<HTMLButtonElement>(null);
    // A backdrop click closes only when the press started on the backdrop
    // too (not a text selection dragged out of the drawer).
    const pressedOnBackdrop = useRef(false);
    const titleId = useId();
    const subtitleId = useId();
    const current = added ?? log.data ?? null;
    const entries = current?.items ?? [];
    const timeline = historyTimeline(entries, current?.activity ?? []);
    const today = nowInSriLanka().date;
    const loaded = log.status === "success" || added !== null;

    const requestClose = () => {
        if (busy) return;
        setShown(false);
        if (prefersReducedMotion()) onClose();
        else window.setTimeout(onClose, CLOSE_ANIMATION_MS);
    };

    // Slide in on mount; move focus into the drawer and give it back to
    // whatever opened it (the Call log button) on close.
    useEffect(() => {
        const opener = document.activeElement as HTMLElement | null;
        const frame = window.requestAnimationFrame(() => setShown(true));
        closeRef.current?.focus();
        const overflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            window.cancelAnimationFrame(frame);
            document.body.style.overflow = overflow;
            opener?.focus?.();
        };
    }, []);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") requestClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    });

    // Keep Tab inside the drawer while it is open.
    const trapFocus = (event: ReactKeyboardEvent) => {
        if (event.key !== "Tab" || !panelRef.current) return;
        const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (submitting.current || !note.trim() || !token) return;
        if (!when.date || !when.time) {
            setError("Enter the date and time of the call.");
            return;
        }
        const calledAt = sriLankaDateTime(when.date, when.time);
        if (new Date(calledAt).getTime() > Date.now() + CLOCK_SKEW_MS) {
            setError("The call can't be in the future.");
            return;
        }
        submitting.current = true;
        setBusy(true);
        setError(null);
        try {
            setAdded(await addCallLog(token, passportId, { note: note.trim(), calledAt, ...(needsAttention ? { needsAttention: true as const } : {}) }));
            setNote("");
            setNeedsAttention(false);
            setWhen(nowInSriLanka());
        } catch (caught) {
            setError(caught instanceof ApiError ? caught.message : "The call could not be saved.");
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    };

    const markForFollowUp = async (entry: CallLogEntry) => {
        if (flaggingRef.current || !token || entry.followUp?.status === "OPEN") return;
        flaggingRef.current = true;
        setFlagging(entry.callLogId);
        setFlagError(null);
        try {
            const { followUp } = await flagCallLog(token, passportId, entry.callLogId);
            setAdded({
                ...current,
                items: entries.map((e) => (e.callLogId === entry.callLogId ? { ...e, followUp: { followUpId: followUp.followUpId, status: followUp.status, flaggedAt: followUp.flaggedAt } } : e)),
            });
        } catch (caught) {
            if (caught instanceof ApiError && caught.status === 409) {
                // Marked already (another tab or user): show the calls as they are now.
                try {
                    setAdded(await listCallLogs(token, passportId));
                } catch {
                    setFlagError({ callLogId: entry.callLogId, message: caught.message });
                }
            } else {
                setFlagError({ callLogId: entry.callLogId, message: caught instanceof ApiError ? caught.message : "The call could not be marked for follow-up." });
            }
        } finally {
            flaggingRef.current = false;
            setFlagging(null);
        }
    };

    const phone = candidate?.whatsappNumber ?? candidate?.contactNumber ?? null;

    return (
        <div className="fixed inset-0 z-50 flex justify-end">
            {/* The page behind the drawer: a click on it closes the drawer (Escape and Close do too, for the keyboard). */}
            <div
                aria-hidden="true"
                data-testid="call-log-backdrop"
                onMouseDown={(event) => { pressedOnBackdrop.current = event.target === event.currentTarget; }}
                onClick={(event) => {
                    const started = pressedOnBackdrop.current;
                    pressedOnBackdrop.current = false;
                    if (started && event.target === event.currentTarget) requestClose();
                }}
                className={`absolute inset-0 bg-overlay transition-opacity duration-200 motion-reduce:transition-none ${shown ? "opacity-100" : "opacity-0"}`}
            />
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={subtitleId}
                onKeyDown={trapFocus}
                className={`relative flex h-full w-full flex-col overflow-x-hidden overflow-y-auto border-border bg-surface shadow-modal transition-transform duration-200 ease-out motion-reduce:transition-none sm:w-[min(640px,88vw)] sm:rounded-l-xl sm:border-l ${shown ? "translate-x-0" : "translate-x-full"}`}
            >
                <header className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-4 sm:px-6">
                    <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                        <Icon name="call" className="size-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                        <h2 id={titleId} className="text-headline-md text-ink">Call Logs</h2>
                        <p id={subtitleId} className="mt-0.5 text-body-sm text-ink-muted">Calls and candidate activity, newest first.</p>
                    </div>
                    <button
                        ref={closeRef}
                        type="button"
                        onClick={requestClose}
                        disabled={busy}
                        aria-label="Close call logs"
                        className="-mr-1 flex size-9 shrink-0 items-center justify-center rounded text-ink-subtle hover:bg-canvas hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        <Icon name="close" className="size-5" />
                    </button>
                </header>

                {candidate && (
                    <dl aria-label="Candidate" className="grid shrink-0 grid-cols-1 gap-x-6 gap-y-2 border-b border-border bg-canvas px-5 py-3 text-body-sm sm:grid-cols-3 sm:px-6">
                        <div className="min-w-0">
                            <dt className="text-label-caps uppercase text-ink-subtle">Candidate</dt>
                            <dd className="truncate font-medium text-ink">{candidate.name ?? "—"}</dd>
                        </div>
                        <div className="min-w-0">
                            <dt className="text-label-caps uppercase text-ink-subtle">Passport ID</dt>
                            <dd className="truncate text-ink-soft tabular-nums">{candidate.passportId}</dd>
                        </div>
                        <div className="min-w-0">
                            <dt className="text-label-caps uppercase text-ink-subtle">{candidate.whatsappNumber ? "WhatsApp" : "Contact"}</dt>
                            <dd className="truncate text-ink-soft tabular-nums">{phone ?? "—"}</dd>
                        </div>
                    </dl>
                )}

                <section aria-labelledby={`${titleId}-history`} className="flex min-h-48 flex-1 flex-col">
                    <div className="flex shrink-0 items-center justify-between gap-3 px-5 pt-5 pb-3 sm:px-6">
                        <h3 id={`${titleId}-history`} className="text-headline-sm text-ink">Candidate History</h3>
                        {loaded && entries.length > 0 && (
                            <span className="rounded-full border border-border bg-canvas px-2.5 py-0.5 text-label-sm text-ink-muted tabular-nums">
                                {entries.length} {entries.length === 1 ? "call" : "calls"}
                            </span>
                        )}
                    </div>
                    <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 pb-5 sm:px-6">
                        {log.status === "loading" && !added && <LoadingState label="Loading history…" />}
                        {log.status === "error" && !added && <ErrorState message={log.error.message} onRetry={log.reload} />}
                        {loaded && (
                            timeline.length === 0
                                ? (
                                    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong px-4 py-10 text-center">
                                        <Icon name="history" className="size-7 text-ink-subtle" />
                                        <p className="text-headline-sm text-ink">No candidate history yet.</p>
                                        <p className="text-body-sm text-ink-muted">Add a call log or wait for candidate activity to appear.</p>
                                    </div>
                                )
                                : (
                                    <>
                                        <ul aria-label="Candidate history" className="space-y-2.5">
                                            {timeline.map((item) => item.type === "CALL_LOG"
                                                ? (
                                                    <CallItem
                                                        key={item.id}
                                                        entry={item.call}
                                                        canEdit={canEdit}
                                                        busy={flagging === item.call.callLogId}
                                                        disabled={flagging !== null}
                                                        error={flagError?.callLogId === item.call.callLogId ? flagError.message : null}
                                                        onMark={() => markForFollowUp(item.call)}
                                                    />
                                                )
                                                : <ActivityItem key={item.id} activity={item.activity} />)}
                                        </ul>
                                        {current?.activityTruncated && (
                                            <p className="mt-3 text-center text-label-sm text-ink-subtle">Showing the latest candidate activity only.</p>
                                        )}
                                    </>
                                )
                        )}
                    </div>
                </section>

                {canEdit
                    ? (
                        <form onSubmit={submit} noValidate aria-labelledby={`${titleId}-add`} className="shrink-0 space-y-3 border-t border-border bg-surface px-5 py-4 sm:px-6">
                            <h3 id={`${titleId}-add`} className="text-headline-sm text-ink">Add New Call Log</h3>
                            <div className="grid grid-cols-2 gap-3">
                                <Field label="Date" required htmlFor="call-log-date">
                                    <input id="call-log-date" type="date" required max={today} value={when.date} disabled={busy} onChange={(event) => setWhen((w) => ({ ...w, date: event.target.value }))} className={fieldControl} />
                                </Field>
                                <Field label="Time" required htmlFor="call-log-time">
                                    <input id="call-log-time" type="time" required value={when.time} disabled={busy} onChange={(event) => setWhen((w) => ({ ...w, time: event.target.value }))} className={fieldControl} />
                                </Field>
                            </div>
                            <Field label="What the candidate said" required htmlFor="call-log-note">
                                <textarea id="call-log-note" rows={3} maxLength={NOTE_MAX_LENGTH} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} placeholder="Short note…" className={`${textAreaControl} resize-y`} />
                            </Field>
                            <DialogError message={error} />
                            <div className="flex flex-wrap justify-end gap-2">
                                <button type="button" onClick={requestClose} disabled={busy} className={secondaryButton}>Close</button>
                                {/* Marks the NEW call for follow-up when it is added (one request: the call and its follow-up together). */}
                                <button
                                    type="button"
                                    aria-pressed={needsAttention}
                                    onClick={() => setNeedsAttention((on) => !on)}
                                    disabled={busy}
                                    title={needsAttention ? "This call will be marked as needs attention" : "Mark this call as needs attention"}
                                    className={`${buttonBase} inline-flex items-center gap-1.5 border ${needsAttention ? "border-review-border bg-review-bg text-review" : "border-border-strong bg-surface text-ink-soft hover:border-border-focus hover:bg-canvas"}`}
                                >
                                    <Icon name={needsAttention ? "flag_fill" : "flag"} className="size-4" />
                                    Need Attention
                                </button>
                                <button type="submit" disabled={busy || !note.trim()} className={primaryButton}>{busy ? "Saving…" : "Add call"}</button>
                            </div>
                        </form>
                    )
                    : (
                        <div className="flex shrink-0 justify-end border-t border-border px-5 py-4 sm:px-6">
                            <button type="button" onClick={requestClose} className={secondaryButton}>Close</button>
                        </div>
                    )}
            </div>
        </div>
    );
}

const kindLabel = "text-label-caps uppercase tracking-wide text-ink-subtle";

// A call: when, who called, the flag, then the note.
function CallItem({ entry, canEdit, busy, disabled, error, onMark }: {
    entry: CallLogEntry; canEdit: boolean; busy: boolean; disabled: boolean; error: string | null; onMark: () => void;
}) {
    return (
        <li data-kind="call-log" className="min-w-0 rounded-lg border border-border bg-surface px-4 py-3">
            <div className="flex items-start justify-between gap-3">
                <p className="min-w-0">
                    <span className="text-label-md font-semibold text-ink tabular-nums">
                        {formatDate(entry.calledAt)} <span className="font-normal text-ink-subtle">·</span> {formatTime(entry.calledAt)}
                    </span>
                    <span className={`ml-2 ${kindLabel}`}>Call log</span>
                </p>
                <div className="flex min-w-0 shrink-0 items-center gap-1.5">
                    {entry.adminName && <span className="max-w-40 truncate text-label-sm text-ink-subtle">{entry.adminName}</span>}
                    <FollowUpFlag entry={entry} canEdit={canEdit} busy={busy} disabled={disabled} onMark={onMark} />
                </div>
            </div>
            <p className="mt-1.5 whitespace-pre-wrap break-words text-body-sm text-ink-soft [overflow-wrap:anywhere]">{entry.note}</p>
            {error && <p role="alert" className="mt-1.5 text-right text-label-sm text-critical">{error}</p>}
        </li>
    );
}

// The call's follow-up, as one compact flag beside the caller:
//   open       filled flag, "Needs attention" (no second follow-up)
//   none       outline flag button: marks it (the existing Priority Follow-Up)
//   completed  muted flag, "Follow-up completed"; can be marked again
// A role without call log access sees the state only.
function FollowUpFlag({ entry, canEdit, busy, disabled, onMark }: {
    entry: CallLogEntry; canEdit: boolean; busy: boolean; disabled: boolean; onMark: () => void;
}) {
    const status = entry.followUp?.status ?? null;
    const box = "flex size-7 shrink-0 items-center justify-center rounded";
    if (status === "OPEN") {
        return (
            <span role="img" aria-label="Needs attention" title="Needs attention" className={`${box} text-review`}>
                <Icon name="flag_fill" className="size-4" />
            </span>
        );
    }
    const completed = status === "COMPLETED";
    if (!canEdit) {
        return completed
            ? <span role="img" aria-label="Follow-up completed" title="Follow-up completed" className={`${box} text-ink-subtle`}><Icon name="task_alt" className="size-4" /></span>
            : null;
    }
    const label = busy ? "Marking as needs attention…" : completed ? "Follow-up completed. Mark as needs attention again" : "Mark as needs attention";
    return (
        <button
            type="button"
            onClick={onMark}
            disabled={disabled}
            aria-label={label}
            aria-busy={busy || undefined}
            title={completed ? "Follow-up completed (mark again)" : "Mark as needs attention"}
            className={`${box} text-ink-subtle hover:bg-canvas hover:text-review disabled:cursor-not-allowed disabled:opacity-60`}
        >
            <Icon name={busy ? "progress_activity" : completed ? "task_alt" : "flag"} className={`size-4 ${busy ? "animate-spin" : ""}`} />
        </button>
    );
}

const ACTIVITY_ICON: Record<CandidateActivity["kind"], IconName> = {
    DOCUMENT_RECEIVED: "upload_file",
    DOCUMENT_VERIFIED: "upload_file",
    DOCUMENT_REMOVED: "upload_file",
    CANDIDATE_REGISTERED: "edit_note",
    DETAILS_UPDATED: "edit_note",
    ADDITIONAL_DETAILS_UPDATED: "edit_note",
    STAGE_COMPLETED: "task_alt",
    STAGE_REOPENED: "task_alt",
    STAGE_UPDATED: "task_alt",
};

// Something that happened to the candidate: muted, one short line.
function ActivityItem({ activity }: { activity: CandidateActivity }) {
    const { title, detail, byline } = describeActivity(activity);
    return (
        <li data-kind="candidate-activity" className="flex min-w-0 items-start gap-2.5 rounded-lg bg-canvas px-4 py-2.5">
            <Icon name={ACTIVITY_ICON[activity.kind] ?? "history"} className="mt-0.5 size-4 text-ink-subtle" />
            <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <span className="text-label-sm text-ink-muted tabular-nums">
                        {formatDate(activity.occurredAt)} <span className="text-ink-subtle">·</span> {formatTime(activity.occurredAt)}
                        <span className={`ml-2 ${kindLabel}`}>Candidate activity</span>
                    </span>
                    {byline && <span className="min-w-0 truncate text-label-sm text-ink-subtle">{byline}</span>}
                </p>
                <p className="mt-0.5 break-words text-body-sm text-ink-soft [overflow-wrap:anywhere]">{title}</p>
                {detail && <p className="mt-0.5 text-label-sm text-ink-subtle">{detail}</p>}
            </div>
        </li>
    );
}
