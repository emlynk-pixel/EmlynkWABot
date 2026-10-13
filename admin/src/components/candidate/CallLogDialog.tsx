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
import { NoAnswerBadge } from "./NoAnswerBadge";

const NOTE_MAX_LENGTH = 500;
// The server allows a few minutes of clock difference; so does this check.
const CLOCK_SKEW_MS = 5 * 60 * 1000;
// Matches the panel's slide transition (duration-200).
const CLOSE_ANIMATION_MS = 200;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type CallLogCandidate = { name: string | null; passportId: string; whatsappNumber: string | null; contactNumber: string | null };

// The drawer's denser controls: the shared field and button styles, one
// step shorter (36px fields, 32px buttons) so Candidate History keeps most
// of the height. Text sizes are unchanged.
const compactField = fieldControl.replace("h-10", "h-9");
const compactTextArea = textAreaControl.replace("py-2", "py-1.5");
const compactButton = (style: string) => style.replace("h-9", "h-8").replace("px-4", "px-3");

const prefersReducedMotion =() => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
    // Collapse hides the date/time/note fields; the action buttons are always visible.
    const [formCollapsed, setFormCollapsed] = useState(false);
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

    // Add call (a note is required) and No Answer (the candidate did not pick
    // up: no note) share this one path: one request, one call. The ref blocks
    // a second click or submit before `busy` has re-rendered.
    const save = async ({ noAnswer }: { noAnswer: boolean }) => {
        if (submitting.current || !token) return;
        if (!noAnswer && !note.trim()) return;
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
            setAdded(await addCallLog(token, passportId, {
                ...(noAnswer ? { outcome: "NO_ANSWER" as const } : { note: note.trim() }),
                calledAt,
                ...(needsAttention ? { needsAttention: true as const } : {}),
            }));
            // A note typed for the next call is kept when only a No Answer was recorded.
            if (!noAnswer) setNote("");
            setNeedsAttention(false);
            setWhen(nowInSriLanka());
        } catch (caught) {
            setError(caught instanceof ApiError ? caught.message : "The call could not be saved.");
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    };

    const submit = (event: FormEvent) => {
        event.preventDefault();
        void save({ noAnswer: false });
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
            {/* Full viewport height (dvh: the visible height on mobile browsers). Width:
                the whole screen on a phone, 92% of a small screen, at most 600px from a
                laptop up, 640px on a very wide monitor. Candidate History takes the height
                left between the header and the compact form, scrolling on its own; on a
                very short screen the whole drawer scrolls instead, so the form is never
                out of reach. */}
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={subtitleId}
                onKeyDown={trapFocus}
                className={`relative flex h-full max-h-dvh w-full flex-col overflow-x-hidden overflow-y-auto border-border bg-surface shadow-modal transition-transform duration-200 ease-out motion-reduce:transition-none sm:w-[min(92vw,600px)] sm:rounded-l-xl sm:border-l 2xl:w-[640px] ${shown ? "translate-x-0" : "translate-x-full"}`}
            >
                <header className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-3 sm:px-5">
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
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
                    <dl aria-label="Candidate" className="grid shrink-0 grid-cols-2 gap-x-5 gap-y-1.5 border-b border-border bg-canvas px-4 py-2.5 text-body-sm min-[480px]:grid-cols-3 sm:px-5">
                        <div className="col-span-2 min-w-0 min-[480px]:col-span-1">
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

                <section aria-labelledby={`${titleId}-history`} className="flex min-h-40 flex-1 flex-col">
                    <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-3 pb-2 sm:px-5">
                        <h3 id={`${titleId}-history`} className="text-body-lg font-semibold text-ink">Candidate History</h3>
                        {loaded && entries.length > 0 && (
                            <span className="rounded-full border border-border bg-canvas px-2.5 py-0.5 text-label-sm text-ink-muted tabular-nums">
                                {entries.length} {entries.length === 1 ? "call" : "calls"}
                            </span>
                        )}
                    </div>
                    <div data-testid="candidate-history-scroll" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 pb-3 sm:px-5">
                        {log.status === "loading" && !added && <LoadingState label="Loading history…" />}
                        {log.status === "error" && !added && <ErrorState message={log.error.message} onRetry={log.reload} />}
                        {loaded && (
                            timeline.length === 0
                                ? (
                                    <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border-strong px-4 py-8 text-center">
                                        <Icon name="history" className="size-7 text-ink-subtle" />
                                        <p className="text-headline-sm text-ink">No candidate history yet.</p>
                                        <p className="text-body-sm text-ink-muted">Add a call log or wait for candidate activity to appear.</p>
                                    </div>
                                )
                                : (
                                    <>
                                        <ul aria-label="Candidate history" className="space-y-2">
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
                        <form onSubmit={submit} noValidate aria-labelledby={`${titleId}-add`} className="shrink-0 space-y-2 border-t border-border bg-surface px-4 pt-2.5 pb-3 sm:px-5">
                            <div className="flex items-center justify-between gap-2">
                                <h3 id={`${titleId}-add`} className="text-body-lg font-semibold text-ink">Add New Call Log</h3>
                                <button
                                    type="button"
                                    aria-expanded={!formCollapsed}
                                    aria-label={formCollapsed ? "Expand call form" : "Collapse call form"}
                                    title={formCollapsed ? "Expand call form" : "Collapse call form"}
                                    onClick={() => setFormCollapsed((c) => !c)}
                                    disabled={busy}
                                    className="-mr-0.5 flex size-7 shrink-0 items-center justify-center rounded text-ink-subtle hover:bg-canvas hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    <Icon name={formCollapsed ? "keyboard_arrow_up" : "keyboard_arrow_down"} className="size-4" />
                                </button>
                            </div>
                            {!formCollapsed && (
                                <>
                                    {/* Date and time side by side; stacked only below 340px, where both inputs no longer fit. */}
                                    <div data-testid="call-log-when" className="grid grid-cols-1 gap-2 min-[340px]:grid-cols-2 sm:gap-3">
                                        <Field label="Date" required htmlFor="call-log-date">
                                            <input id="call-log-date" type="date" required max={today} value={when.date} disabled={busy} onChange={(event) => setWhen((w) => ({ ...w, date: event.target.value }))} className={compactField} />
                                        </Field>
                                        <Field label="Time" required htmlFor="call-log-time">
                                            <input id="call-log-time" type="time" required value={when.time} disabled={busy} onChange={(event) => setWhen((w) => ({ ...w, time: event.target.value }))} className={compactField} />
                                        </Field>
                                    </div>
                                    {/* Two lines by default, three on a tall screen; it can still be dragged taller. */}
                                    <Field label="What the candidate said" required htmlFor="call-log-note">
                                        <textarea id="call-log-note" rows={2} maxLength={NOTE_MAX_LENGTH} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} placeholder="Short note…" className={`${compactTextArea} block min-h-14 resize-y [@media(min-height:900px)]:min-h-20`} />
                                    </Field>
                                </>
                            )}
                            <DialogError message={error} />
                            <div className="flex flex-wrap justify-end gap-2 pt-0.5">
                                <button type="button" onClick={requestClose} disabled={busy} className={compactButton(secondaryButton)}>Close</button>
                                {/* The candidate did not pick up: records the attempt at the date and time above, with no note. */}
                                <button
                                    type="button"
                                    onClick={() => void save({ noAnswer: true })}
                                    disabled={busy}
                                    title="Record that the candidate did not answer (uses the date and time above)"
                                    className={`${compactButton(secondaryButton)} inline-flex items-center gap-1.5`}
                                >
                                    <Icon name="phone_missed" className="size-4" />
                                    No Answer
                                </button>
                                {/* Marks the NEW call for follow-up when it is added (one request: the call and its follow-up together). */}
                                <button
                                    type="button"
                                    aria-pressed={needsAttention}
                                    onClick={() => setNeedsAttention((on) => !on)}
                                    disabled={busy}
                                    title={needsAttention ? "This call will be marked as needs attention" : "Mark this call as needs attention"}
                                    className={`${compactButton(buttonBase)} inline-flex items-center gap-1.5 border ${needsAttention ? "border-review-border bg-review-bg text-review" : "border-border-strong bg-surface text-ink-soft hover:border-border-focus hover:bg-canvas"}`}
                                >
                                    <Icon name={needsAttention ? "flag_fill" : "flag"} className="size-4" />
                                    Need Attention
                                </button>
                                <button type="submit" disabled={busy || !note.trim()} className={compactButton(primaryButton)}>{busy ? "Saving…" : "Add call"}</button>
                            </div>
                        </form>
                    )
                    : (
                        <div className="flex shrink-0 justify-end border-t border-border px-4 py-2.5 sm:px-5">
                            <button type="button" onClick={requestClose} className={compactButton(secondaryButton)}>Close</button>
                        </div>
                    )}
            </div>
        </div>
    );
}

const kindLabel = "text-label-caps uppercase tracking-wide text-ink-muted";

// What kind of thing a Candidate History entry is, at a glance: a soft tint,
// a thin accent on the left and a small coloured icon, from the theme's
// semantic tokens (so light and dark each get their own soft or muted
// version). Text stays in the normal colours, and every entry also says what
// it is in words, so colour supports scanning and never carries the meaning.
//   No Answer (an unsuccessful attempt)  red    critical
//   Call log (a conversation, a note)    amber  review
//   Candidate activity (an update)       green  verified
// The flag is amber too (open) or muted (completed); it sits on its own
// shape, so it is never mistaken for the call's colour.
const TONE = {
    noAnswer: "border-border border-l-[3px] border-l-critical bg-critical-bg",
    call: "border-border border-l-[3px] border-l-review bg-review-bg",
    activity: "border-border border-l-[3px] border-l-verified bg-verified-bg",
} as const;

// A call: when, who called, the flag, then the note.
function CallItem({ entry, canEdit, busy, disabled, error, onMark }: {
    entry: CallLogEntry; canEdit: boolean; busy: boolean; disabled: boolean; error: string | null; onMark: () => void;
}) {
    const noAnswer = entry.outcome === "NO_ANSWER";
    return (
        <li data-kind="call-log" data-tone={noAnswer ? "no-answer" : "call"} className={`min-w-0 rounded-lg border px-3.5 py-2.5 ${noAnswer ? TONE.noAnswer : TONE.call}`}>
            <div className="flex items-center justify-between gap-3">
                <p className="flex min-w-min flex-1 flex-wrap items-baseline gap-x-2">
                    <span className="whitespace-nowrap text-label-md font-semibold text-ink tabular-nums">
                        {formatDate(entry.calledAt)} <span className="font-normal text-ink-subtle">·</span> {formatTime(entry.calledAt)}
                    </span>
                    <span className={`inline-flex items-center gap-1 whitespace-nowrap ${kindLabel}`}>
                        <Icon name="call" className="size-3 self-center text-review" />
                        Call log
                    </span>
                </p>
                {/* -my-1: the flag's 28px hit area doesn't make the row taller than its text. */}
                <div className="-my-1 flex min-w-0 max-w-[50%] items-center gap-1.5">
                    {entry.adminName && <span title={entry.adminName} className="min-w-0 max-w-40 truncate text-label-sm text-ink-muted">{entry.adminName}</span>}
                    <FollowUpFlag entry={entry} canEdit={canEdit} busy={busy} disabled={disabled} onMark={onMark} />
                </div>
            </div>
            {noAnswer
                // An outcome, not an error: the badge (icon and words), and no note body.
                ? <p className="mt-1.5"><NoAnswerBadge /></p>
                : <p className="mt-1 whitespace-pre-wrap break-words text-body-sm text-ink-soft [overflow-wrap:anywhere]">{entry.note}</p>}
            {error && <p role="alert" className="mt-1 text-right text-label-sm text-critical">{error}</p>}
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

// Something that happened to the candidate: one short line, in green.
function ActivityItem({ activity }: { activity: CandidateActivity }) {
    const { title, detail, byline } = describeActivity(activity);
    return (
        <li data-kind="candidate-activity" data-tone="activity" className={`flex min-w-0 items-start gap-2.5 rounded-lg border px-3.5 py-2 ${TONE.activity}`}>
            <Icon name={ACTIVITY_ICON[activity.kind] ?? "history"} className="mt-0.5 size-4 text-verified" />
            <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <span className="flex flex-wrap items-baseline gap-x-2 text-label-sm text-ink-muted tabular-nums">
                        <span className="whitespace-nowrap">{formatDate(activity.occurredAt)} <span className="text-ink-subtle">·</span> {formatTime(activity.occurredAt)}</span>
                        <span className={`whitespace-nowrap ${kindLabel}`}>Candidate activity</span>
                    </span>
                    {byline && <span className="min-w-0 truncate text-label-sm text-ink-muted">{byline}</span>}
                </p>
                <p className="mt-0.5 break-words text-body-sm text-ink-soft [overflow-wrap:anywhere]">{title}</p>
                {detail && <p className="mt-0.5 text-label-sm text-ink-muted">{detail}</p>}
            </div>
        </li>
    );
}
