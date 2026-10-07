import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { ApiError } from "../../api/client";
import { useAdminResource } from "../../api/useAdminResource";
import { addCallLog, listCallLogs, type CallLogEntry } from "../../api/candidates";
import { DialogError, primaryButton, secondaryButton } from "../Dialog";
import { formatDate, formatTime, nowInSriLanka, sriLankaDateTime } from "../format";
import { Icon } from "../Icon";
import { ErrorState, LoadingState } from "../States";
import { Field, fieldControl, textAreaControl } from "./CandidateFields";

const NOTE_MAX_LENGTH = 500;
// The server allows a few minutes of clock difference; so does this check.
const CLOCK_SKEW_MS = 5 * 60 * 1000;
// Matches the panel's slide transition (duration-200).
const CLOSE_ANIMATION_MS = 200;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type CallLogCandidate = { name: string | null; passportId: string; whatsappNumber: string | null; contactNumber: string | null };

const prefersReducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Calls made to the candidate, newest first: the date and time of the call
// and a short note of what the candidate said. A new call defaults to now.
// Opens as a drawer from the right over the candidate page; Escape or Close
// closes it, except while a call is being saved.
export function CallLogDialog({ passportId, candidate, canEdit, onClose }: { passportId: string; candidate?: CallLogCandidate; canEdit: boolean; onClose: () => void }) {
    const { token } = useAuth();
    const log = useAdminResource(`call-logs:${passportId}`, (t, signal) => listCallLogs(t, passportId, signal));
    const [added, setAdded] = useState<CallLogEntry[] | null>(null);
    const [when, setWhen] = useState(() => nowInSriLanka());
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [shown, setShown] = useState(false);
    // Guards against a second submit before `busy` has re-rendered.
    const submitting = useRef(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const closeRef = useRef<HTMLButtonElement>(null);
    const titleId = useId();
    const subtitleId = useId();
    const entries = added ?? log.data?.items ?? [];
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
            setAdded((await addCallLog(token, passportId, { note: note.trim(), calledAt })).items);
            setNote("");
            setWhen(nowInSriLanka());
        } catch (caught) {
            setError(caught instanceof ApiError ? caught.message : "The call could not be saved.");
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    };

    const phone = candidate?.whatsappNumber ?? candidate?.contactNumber ?? null;

    return (
        <div className="fixed inset-0 z-50 flex justify-end">
            <div aria-hidden="true" className={`absolute inset-0 bg-overlay transition-opacity duration-200 motion-reduce:transition-none ${shown ? "opacity-100" : "opacity-0"}`} />
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
                        <p id={subtitleId} className="mt-0.5 text-body-sm text-ink-muted">View and add call history for this candidate.</p>
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
                        <h3 id={`${titleId}-history`} className="text-headline-sm text-ink">Call History</h3>
                        {loaded && entries.length > 0 && (
                            <span className="rounded-full border border-border bg-canvas px-2.5 py-0.5 text-label-sm text-ink-muted tabular-nums">
                                {entries.length} {entries.length === 1 ? "call" : "calls"}
                            </span>
                        )}
                    </div>
                    <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 pb-5 sm:px-6">
                        {log.status === "loading" && !added && <LoadingState label="Loading calls…" />}
                        {log.status === "error" && !added && <ErrorState message={log.error.message} onRetry={log.reload} />}
                        {loaded && (
                            entries.length === 0
                                ? (
                                    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong px-4 py-10 text-center">
                                        <Icon name="call" className="size-7 text-ink-subtle" />
                                        <p className="text-headline-sm text-ink">No calls logged yet.</p>
                                        {canEdit && <p className="text-body-sm text-ink-muted">Calls added below will appear here.</p>}
                                    </div>
                                )
                                : (
                                    <ul aria-label="Calls" className="space-y-3">
                                        {entries.map((entry) => (
                                            <li key={entry.callLogId} className="min-w-0 rounded-lg border border-border bg-canvas px-4 py-3">
                                                <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                                                    <span className="text-label-md font-semibold text-ink tabular-nums">
                                                        {formatDate(entry.calledAt)} <span className="font-normal text-ink-subtle">·</span> {formatTime(entry.calledAt)}
                                                    </span>
                                                    {entry.adminName && <span className="min-w-0 truncate text-label-sm text-ink-subtle">{entry.adminName}</span>}
                                                </p>
                                                <p className="mt-1.5 whitespace-pre-wrap break-words text-body-sm text-ink-soft [overflow-wrap:anywhere]">{entry.note}</p>
                                            </li>
                                        ))}
                                    </ul>
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
                            <div className="flex justify-end gap-2">
                                <button type="button" onClick={requestClose} disabled={busy} className={secondaryButton}>Close</button>
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
