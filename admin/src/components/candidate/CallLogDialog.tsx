import { useState, type FormEvent } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { ApiError } from "../../api/client";
import { useAdminResource } from "../../api/useAdminResource";
import { addCallLog, listCallLogs, type CallLogEntry } from "../../api/candidates";
import { ActionDialog, DialogError, primaryButton, secondaryButton } from "../Dialog";
import { formatDateTime } from "../format";
import { textAreaControl } from "./CandidateFields";

// Calls made to the candidate, newest first, and a note for a new one.
export function CallLogDialog({ passportId, canEdit, onClose }: { passportId: string; canEdit: boolean; onClose: () => void }) {
    const { token } = useAuth();
    const log = useAdminResource(`call-logs:${passportId}`, (t, signal) => listCallLogs(t, passportId, signal));
    const [added, setAdded] = useState<CallLogEntry[] | null>(null);
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const entries = added ?? log.data?.items ?? [];

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (!note.trim() || !token) return;
        setBusy(true);
        setError(null);
        try {
            setAdded((await addCallLog(token, passportId, note.trim())).items);
            setNote("");
        } catch (caught) {
            setError(caught instanceof ApiError ? caught.message : "The note could not be saved.");
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
                        <ul className="max-h-64 space-y-3 overflow-y-auto">
                            {entries.map((entry) => (
                                <li key={entry.callLogId} className="border-b border-canvas-muted pb-2 last:border-0">
                                    <p className="whitespace-pre-wrap text-body-sm text-ink">{entry.note}</p>
                                    <p className="mt-0.5 text-label-sm text-ink-subtle">{formatDateTime(entry.createdDate)}{entry.adminName ? ` • ${entry.adminName}` : ""}</p>
                                </li>
                            ))}
                        </ul>
                    )
            )}
            {canEdit && (
                <form onSubmit={submit} className="mt-4">
                    <label htmlFor="call-log-note" className="sr-only">Call note</label>
                    <textarea id="call-log-note" rows={3} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="What was discussed…" className={textAreaControl} />
                    <DialogError message={error} />
                    <div className="mt-3 flex justify-end gap-2">
                        <button type="button" onClick={onClose} disabled={busy} className={secondaryButton}>Close</button>
                        <button type="submit" disabled={busy || !note.trim()} className={primaryButton}>{busy ? "Saving…" : "Add note"}</button>
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
