import { useEffect, useState } from "react";
import { ApiError } from "../../api/client";
import { FINAL_STATUS_OPTIONS, setCandidateFinalStatus, type CandidateDetails, type FinalStatusCode } from "../../api/candidates";
import { useAuth } from "../../auth/AuthProvider";
import { canSetFinalStatus } from "../../auth/roles";
import { DialogError, primaryButton } from "../dialogParts";
import { formatDateTime } from "../format";
import { fieldControl } from "./CandidateFields";
import { WorkflowStatusBadge } from "./WorkflowStatusBadge";

// The candidate's Status on their page: the SAME derived Status every list shows
// (src/services/candidateWorkflowStatus.js). It follows the data, so completing a stage,
// verifying, the Candidate Form or an import changes it at once (the page holds the
// server's response of every save).
// An Admin can also record the FINAL status here: Departed, Visa Not Going, Cancelled or
// Rejected (or none). It is audited and can be changed or cleared again.
export function CandidateStatusPanel({ details, onChange }: { details: CandidateDetails; onChange: (details: CandidateDetails) => void }) {
    const { user, token } = useAuth();
    const recorded: FinalStatusCode | "" = details.finalStatus?.code ?? "";
    const [choice, setChoice] = useState<FinalStatusCode | "">(recorded);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => setChoice(recorded), [recorded]);

    const status = details.workflowStatus ?? null;
    const canSet = canSetFinalStatus(user);
    if (!status && !canSet) return null;

    const save = async () => {
        if (!token) return;
        setBusy(true);
        setError(null);
        try {
            onChange(await setCandidateFinalStatus(token, details.candidate.passportId, choice || null));
        } catch (caught) {
            setError(caught instanceof ApiError ? caught.message : "The final status could not be saved.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div data-testid="candidate-status" className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="flex items-center gap-2 text-body-sm text-ink-muted">
                <span>Status</span>
                {status ? <WorkflowStatusBadge status={status} /> : <span>—</span>}
                {details.finalStatus?.at && <span className="text-label-sm">since {formatDateTime(details.finalStatus.at)}</span>}
            </p>
            {canSet && (
                <div className="flex flex-wrap items-center gap-2">
                    <label htmlFor="final-status" className="text-label-md text-ink-soft">Final status</label>
                    <select
                        id="final-status"
                        value={choice}
                        disabled={busy}
                        onChange={(event) => setChoice(FINAL_STATUS_OPTIONS.find((o) => o.value === event.target.value)?.value ?? "")}
                        className={`${fieldControl} w-auto`}
                    >
                        <option value="">None</option>
                        {FINAL_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                    <button type="button" disabled={busy || choice === recorded} onClick={save} className={primaryButton}>
                        {busy ? "Saving…" : "Save"}
                    </button>
                </div>
            )}
            {error && <div className="w-full"><DialogError message={error} /></div>}
        </div>
    );
}
