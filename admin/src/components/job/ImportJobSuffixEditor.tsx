import { useEffect, useId, useState } from "react";
import { ApiError } from "../../api/client";
import { updateImportJobSuffix, type ImportJobGroup } from "../../api/jobs";
import { useAuth } from "../../auth/AuthProvider";
import { canEditImportJobSuffix } from "../../auth/roles";
import { DialogError, primaryButton } from "../dialogParts";
import { formatDate } from "../format";

export const isValidSuffix = (value: string) => /^[0-9]{2}$/.test(value) && value !== "00";

// A Job created by the Google Sheet upload (JOB-YYYY-MMDDNN): where it comes from (the Interview Date
// and the Unique Number range), and, for ADMIN / OWNER / JOB_HANDLER / ANALYST, the last two digits as
// the only editable part. The prefix (date part) never changes here. The server checks the role, the
// two digits and that the new code is unused.
export function ImportJobSuffixEditor({ jobId, group, onSaved }: { jobId: string; group: ImportJobGroup; onSaved: (jobCode: string) => void }) {
    const { user, token } = useAuth();
    const inputId = useId();
    const [suffix, setSuffix] = useState(group.suffix);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => setSuffix(group.suffix), [group.suffix]);

    const origin = `Sheet upload · Interview date ${group.interviewDate ? formatDate(group.interviewDate) : "—"} · Unique Numbers ${group.from}–${group.to}`;
    if (!canEditImportJobSuffix(user)) return <p className="text-label-sm text-ink-muted">{origin}</p>;

    const valid = isValidSuffix(suffix);
    const save = async () => {
        if (!token || !valid) return;
        setBusy(true);
        setError(null);
        try {
            onSaved((await updateImportJobSuffix(token, jobId, suffix)).jobCode);
        } catch (caught) {
            setError(caught instanceof ApiError ? caught.message : "The Job ID could not be changed.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div data-testid="import-job-suffix" className="space-y-1.5">
            <p className="text-label-sm text-ink-muted">{origin}</p>
            <div className="flex flex-wrap items-center gap-2">
                <label htmlFor={inputId} className="text-label-md text-ink-soft">Last two digits</label>
                <span className="font-mono text-body-sm text-ink" aria-hidden="true">{group.prefix}</span>
                <input
                    id={inputId}
                    value={suffix}
                    inputMode="numeric"
                    maxLength={2}
                    disabled={busy}
                    aria-invalid={!valid}
                    aria-describedby={`${inputId}-help`}
                    onChange={(event) => setSuffix(event.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
                    className="h-8 w-12 rounded-lg border border-border-strong bg-surface px-2 text-center font-mono text-body-sm text-ink focus:border-border-focus focus:outline-none aria-[invalid=true]:border-critical"
                />
                <button type="button" onClick={save} disabled={busy || !valid || suffix === group.suffix} className={primaryButton}>{busy ? "Saving…" : "Save"}</button>
            </div>
            <p id={`${inputId}-help`} className="text-label-sm text-ink-muted">
                {valid ? <>New Job ID: <span className="font-mono text-ink">{group.prefix}{suffix}</span></> : "Enter exactly two digits, 01 to 99."} Only the last two digits can change.
            </p>
            <DialogError message={error} />
        </div>
    );
}
