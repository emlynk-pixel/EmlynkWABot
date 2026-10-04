import { useState, type FormEvent } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { ApiError } from "../../api/client";
import { useAdminResource } from "../../api/useAdminResource";
import { addCallLog, listCallLogs, type CallLogEntry } from "../../api/candidates";
import { ActionDialog, DialogError, primaryButton, secondaryButton } from "../Dialog";
import { formatDate, formatTime, nowInSriLanka, sriLankaDateTime } from "../format";
import { Field, fieldControl, textAreaControl } from "./CandidateFields";

const NOTE_MAX_LENGTH = 500;
// The server allows a few minutes of clock difference; so does this check.
const CLOCK_SKEW_MS = 5 * 60 * 1000;

// Calls made to the candidate, newest first: the date and time of the call
// and a short note of what the candidate said. A new call defaults to now.
export function CallLogDialog({ passportId, canEdit, onClose }: { passportId: string; canEdit: boolean; onClose: () => void }) {
    const { token } = useAuth();
    const log = useAdminResource(`call-logs:${passportId}`, (t, signal) => listCallLogs(t, passportId, signal));
    const [added, setAdded] = useState<CallLogEntry[] | null>(null);
    const [when, setWhen] = useState(() => nowInSriLanka());
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const entries = added ?? log.data?.items ?? [];
    const today = nowInSriLanka().date;

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (!note.trim() || !token) return;
        if (!when.date || !when.time) {
            setError("Enter the date and time of the call.");
            return;
        }
        const calledAt = sriLankaDateTime(when.date, when.time);
        if (new Date(calledAt).getTime() > Date.now() + CLOCK_SKEW_MS) {
            setError("The call can't be in the future.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            setAdded((await addCallLog(token, passportId, { note: note.trim(), calledAt })).items);
            setNote("");
            setWhen(nowInSriLanka());
        } catch (caught) {
            setError(caught instanceof ApiError ? caught.message : "The call could not be saved.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <ActionDialog title="Call log" busy={busy} onClose={onClose}>
            {log.status === "loading" && !added && <p className="text-body-sm text-ink-muted">Loading…</p>}
            {log.status === "error" && !added && <p className="text-body-sm text-critical">{log.error.message}</p>}
            {(log.status === "success" || added) && (
                entries.length === 0
                    ? <p className="text-body-sm text-ink-muted">No calls logged yet.</p>
                    : (
                        <ul aria-label="Calls" className="max-h-64 space-y-3 overflow-y-auto">
                            {entries.map((entry) => (
                                <li key={entry.callLogId} className="border-b border-canvas-muted pb-2 last:border-0">
                                    <p className="flex items-baseline justify-between gap-3 text-label-sm">
                                        <span className="font-medium text-ink tabular-nums">
                                            {formatDate(entry.calledAt)} <span className="text-ink-subtle">·</span> {formatTime(entry.calledAt)}
                                        </span>
                                        {entry.adminName && <span className="truncate text-ink-subtle">{entry.adminName}</span>}
                                    </p>
                                    <p className="mt-0.5 whitespace-pre-wrap text-body-sm text-ink-soft">{entry.note}</p>
                                </li>
                            ))}
                        </ul>
                    )
            )}
            {canEdit && (
                <form onSubmit={submit} noValidate className="mt-4 space-y-3 border-t border-border pt-4">
                    <div className="grid grid-cols-2 gap-3">
                        <Field label="Date" required htmlFor="call-log-date">
                            <input id="call-log-date" type="date" required max={today} value={when.date} disabled={busy} onChange={(event) => setWhen((w) => ({ ...w, date: event.target.value }))} className={fieldControl} />
                        </Field>
                        <Field label="Time" required htmlFor="call-log-time">
                            <input id="call-log-time" type="time" required value={when.time} disabled={busy} onChange={(event) => setWhen((w) => ({ ...w, time: event.target.value }))} className={fieldControl} />
                        </Field>
                    </div>
                    <Field label="What the candidate said" required htmlFor="call-log-note">
                        <textarea id="call-log-note" rows={3} maxLength={NOTE_MAX_LENGTH} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} placeholder="Short note…" className={textAreaControl} />
                    </Field>
                    <DialogError message={error} />
                    <div className="flex justify-end gap-2">
                        <button type="button" onClick={onClose} disabled={busy} className={secondaryButton}>Close</button>
                        <button type="submit" disabled={busy || !note.trim()} className={primaryButton}>{busy ? "Saving…" : "Add call"}</button>
                    </div>
                </form>
            )}
            {!canEdit && (
                <div className="mt-4 flex justify-end">
                    <button type="button" onClick={onClose} className={secondaryButton}>Close</button>
                </div>
            )}
        </ActionDialog>
    );
}
