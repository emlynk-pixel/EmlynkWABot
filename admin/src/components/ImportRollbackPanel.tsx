import { useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../api/client";
import { getImportRollback, previewImportRollback, runImportRollback, type RollbackItem, type RollbackPreview, type RollbackReport } from "../api/candidateImport";
import { useAuth } from "../auth/AuthProvider";
import { DialogError, primaryButton, secondaryButton } from "./Dialog";
import { formatNumber } from "./format";

// Roll back a bulk candidate import: review what would be reversed, confirm explicitly, then watch it run.
//   1. review (GET .../rollback/preview): what can be reversed, what cannot and why, what is gone already.
//      Nothing is changed by looking.
//   2. confirm: a checkbox and a button that names the number of changes. The button is disabled while it runs and
//      cannot be pressed twice (the server also refuses a second caller).
//   3. run: the server works in short steps; this calls again until it reports done (a long import takes several calls).
//   4. report: what was reversed, what was kept and why, and that the Google Sheet follows.
// Counts, record kinds, sheet row numbers and reason codes only: no candidate's data is ever shown.

const ENTITY: Record<string, string> = {
    CANDIDATE: "Candidate", CANDIDATE_ADDITIONAL_DETAILS: "Additional details", CANDIDATE_STAGE: "Stage", CANDIDATE_ALLOCATION: "Allocation",
    CLIENT: "Client", AGENT: "Agent", AGENT_CLIENT: "Agent–Client link", JOB: "Job", IMPORT_JOB_GROUP: "Job group", JOB_CANDIDATE: "Job membership",
};

// Why something stays, in words. The part of a code after ":" (field names, tables) is not shown.
const REASON: Record<string, string> = {
    FIELD_CHANGED: "A value the import wrote was changed afterwards.",
    CHANGED_AFTER_IMPORT: "Something else was recorded about this candidate after the import.",
    HAS_DOCUMENTS: "Documents were added to this candidate.",
    HAS_OTHER_JOB_MEMBERSHIP: "The candidate was put on another Job.",
    HAS_OTHER_STAGES: "Other stages were added to this candidate.",
    HAS_OTHER_ALLOCATION: "The candidate was allocated by someone else.",
    HAS_OTHER_DETAILS: "Other additional details were entered.",
    HAS_OTHER_MEMBERS: "Other candidates were put on this Job.",
    HAS_OTHER_JOBS: "Another Job uses this record.",
    HAS_OTHER_AGENT_LINKS: "Another link uses this record.",
    HAS_DEPENDENT_RECORDS: "Other records depend on it.",
    JOB_STATUS_CHANGED: "The Job was closed or changed.",
    MEMBERSHIP_CHANGED: "The Job membership was changed.",
    KEY_UNAVAILABLE: "The key needed to verify personal data is not available on this server.",
    PREVIOUS_VALUE_NOT_RESTORABLE: "The value before the import cannot be restored exactly.",
    PARENT_NOT_REVERTED: "Kept together with the record it belongs to.",
    DEPENDENT_ENTRY_CONFLICT: "Something that belongs to it could not be reversed.",
    REVERT_FAILED: "An unexpected error stopped this change from being reversed.",
    UNSUPPORTED_ENTRY: "This kind of change cannot be reversed automatically.",
    NOT_REACHED: "It was not reached.",
    ALREADY_GONE: "It no longer exists.",
};
const reasonText = (code: string) => REASON[code.split(":")[0]] ?? "It cannot be reversed safely.";

const BLOCKED: Record<string, string> = {
    IMPORT_STILL_COMMITTING: "This import is still committing. Finish it or abort it first.",
    NOTHING_TO_ROLL_BACK: "This import has not written anything.",
    ALREADY_ROLLED_BACK: "This import has already been rolled back.",
    ROLLBACK_IN_PROGRESS: "This import is being rolled back right now. Wait for it to finish.",
    NOTHING_TO_REVERT: "Nothing can be reversed safely: every change was already reversed, is gone, or has a conflict.",
    NOT_ALLOWED: "This import cannot be rolled back.",
};

const plural = (count: number, one: string, many = `${one}s`) => `${formatNumber(count)} ${count === 1 ? one : many}`;

function Tile({ label, value, tone }: { label: string; value: number; tone?: "critical" | "review" }) {
    return (
        <div className="min-w-0 rounded-lg border border-border bg-canvas px-3 py-2">
            <dt className="text-label-sm text-ink-muted">{label}</dt>
            <dd className={`mt-0.5 text-body-md tabular-nums ${tone === "critical" && value ? "text-critical" : tone === "review" && value ? "text-review" : "text-ink"}`}>{formatNumber(value)}</dd>
        </div>
    );
}

function Reasons({ reasons }: { reasons: Record<string, number> }) {
    const entries = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return null;
    return (
        <ul aria-label="Why changes are kept" className="mt-2 list-disc space-y-0.5 rounded-lg border border-border py-2 pl-7 pr-3 text-body-sm text-ink">
            {entries.map(([code, count]) => <li key={code}>{reasonText(code)} ({plural(count, "change")})</li>)}
        </ul>
    );
}

function Items({ items, label }: { items: RollbackItem[]; label: string }) {
    if (!items.length) return null;
    return (
        <div className="mt-3 max-h-56 overflow-auto rounded-lg border border-border">
            <table aria-label={label} className="w-full text-left text-body-sm">
                <thead className="sticky top-0 bg-surface text-label-md text-ink">
                    <tr><th className="px-3 py-1.5">Sheet row</th><th className="px-3 py-1.5">Record</th><th className="px-3 py-1.5">Why it stays</th></tr>
                </thead>
                <tbody>
                    {items.map((item, index) => (
                        <tr key={index} className="border-t border-border align-top">
                            <td className="px-3 py-1.5 tabular-nums">{item.rowNumber ?? "–"}</td>
                            <td className="px-3 py-1.5">{ENTITY[item.entityType] ?? item.entityType}</td>
                            <td className="px-3 py-1.5">{[...new Set(item.reasons.map(reasonText))].join(" ")}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

type State =
    | { kind: "loading" }
    | { kind: "review"; preview: RollbackPreview; progress: RollbackReport | null; notice?: string }
    | { kind: "running"; report: RollbackReport | null }
    | { kind: "interrupted"; message: string; preview: RollbackPreview; report: RollbackReport | null }
    | { kind: "done"; report: RollbackReport }
    | { kind: "error"; message: string };

export function ImportRollbackPanel({ importId, onClose, onBusyChange }: { importId: string; onClose: () => void; onBusyChange: (busy: boolean) => void }) {
    const { token } = useAuth();
    const confirmId = useId();
    const [state, setState] = useState<State>({ kind: "loading" });
    const [confirmed, setConfirmed] = useState(false);
    // One run at a time, whatever the number of clicks.
    const running = useRef(false);

    async function review(notice?: string) {
        if (!token) return;
        setState({ kind: "loading" });
        try {
            const preview = await previewImportRollback(token, importId);
            // A rollback that was interrupted: show how far it got.
            const progress = preview.status === "ROLLING_BACK" ? await getImportRollback(token, importId).catch(() => null) : null;
            setConfirmed(false);
            setState({ kind: "review", preview, progress, notice });
        } catch (e) {
            setState({ kind: "error", message: e instanceof ApiError ? e.message : "The import could not be checked." });
        }
    }
    useEffect(() => { void review(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token, importId]);

    async function run(preview: RollbackPreview) {
        if (!token || running.current) return;
        running.current = true;
        onBusyChange(true);
        let latest: RollbackReport | null = null;
        setState({ kind: "running", report: null });
        try {
            // The first call is the confirmed one: the number the administrator saw is checked by the server.
            latest = await runImportRollback(token, importId, preview.status === "ROLLING_BACK" ? null : preview.summary.eligible);
            setState({ kind: "running", report: latest });
            while (!latest.done) {
                latest = await runImportRollback(token, importId, null);
                setState({ kind: "running", report: latest });
            }
            setState({ kind: "done", report: latest });
        } catch (e) {
            if (e instanceof ApiError && e.code === "ROLLBACK_PREVIEW_CHANGED") {
                running.current = false;
                onBusyChange(false);
                await review("The import changed after you reviewed it, so nothing was rolled back. Review the new numbers before confirming.");
                return;
            }
            const message = e instanceof ApiError ? e.message : "The rollback stopped.";
            setState({ kind: "interrupted", message, preview, report: latest });
        } finally {
            running.current = false;
            onBusyChange(false);
        }
    }

    if (state.kind === "loading") return <p role="status" className="text-body-sm text-ink-muted">Checking what a rollback would do…</p>;
    if (state.kind === "error") {
        return (
            <>
                <DialogError message={state.message} />
                <div className="mt-5 flex justify-end gap-2">
                    <button type="button" className={secondaryButton} onClick={() => void review()}>Try again</button>
                    <button type="button" className={primaryButton} onClick={onClose}>Close</button>
                </div>
            </>
        );
    }

    if (state.kind === "running") {
        const counts = state.report?.counts;
        const total = counts?.total ?? 0;
        const handled = counts ? total - counts.remaining : 0;
        return (
            <>
                <p role="status" className="text-body-sm text-ink">
                    Rolling back… {counts ? `${formatNumber(handled)} of ${formatNumber(total)} changes handled.` : "starting."}
                </p>
                <progress className="mt-3 w-full" max={Math.max(total, 1)} value={handled} aria-label="Rollback progress" />
                <p className="mt-2 text-body-sm text-ink-muted">Keep this window open until it finishes. If it is interrupted, open the import again to continue where it stopped.</p>
            </>
        );
    }

    if (state.kind === "done") return <Report report={state.report} onClose={onClose} />;

    if (state.kind === "interrupted") {
        return (
            <>
                <DialogError message={state.message} />
                <p className="mt-2 text-body-sm text-ink-muted">Nothing is left half done: what the interrupted step was doing was undone. Continue to carry on from where it stopped.</p>
                {state.report && <p className="mt-2 text-body-sm text-ink">{formatNumber(state.report.counts.reverted)} changes reversed so far.</p>}
                <div className="mt-5 flex justify-end gap-2">
                    <button type="button" className={secondaryButton} onClick={onClose}>Close</button>
                    <button type="button" className={primaryButton} onClick={() => void review()}>Review and continue</button>
                </div>
            </>
        );
    }

    const { preview, progress, notice } = state;
    const { summary } = preview;
    const resuming = preview.status === "ROLLING_BACK";
    const blocked = preview.blockedReason ? BLOCKED[preview.blockedReason] ?? BLOCKED.NOT_ALLOWED : null;
    const { candidates, jobs, clients, agents } = preview.willDelete;
    return (
        <>
            {notice && <p role="alert" className="mb-3 rounded-lg border border-review-border bg-review-bg px-3 py-2 text-body-sm text-review">{notice}</p>}
            <p className="text-body-sm text-ink">
                {resuming ? "A rollback of this import was interrupted. " : ""}
                Review what rolling back this import would do. Nothing has been changed yet.
            </p>
            <dl aria-label="Rollback preview" className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Tile label="Will be reversed" value={summary.eligible} />
                <Tile label="Cannot be reversed" value={summary.conflicts} tone="critical" />
                <Tile label="Already gone" value={summary.missing} tone="review" />
                <Tile label="Already reversed" value={summary.alreadyReverted} />
            </dl>
            {progress && <p className="mt-2 text-body-sm text-ink-muted">{formatNumber(progress.counts.reverted)} changes were already reversed before it was interrupted.</p>}
            {summary.eligible > 0 && (
                <p className="mt-3 text-body-sm text-ink">
                    This will delete {plural(candidates, "candidate")}, {plural(jobs, "Job")}, {plural(clients, "Client")} and {plural(agents, "Agent")} that this import created,
                    and put back the blank fields it filled in existing records. Nothing else is touched.
                </p>
            )}
            {!preview.keyAvailable && (
                <p role="alert" className="mt-3 rounded-lg border border-review-border bg-review-bg px-3 py-2 text-body-sm text-review">
                    The server cannot verify personal data right now (its change-ledger key is not configured), so records with personal data are kept.
                </p>
            )}
            {summary.conflicts > 0 && (
                <div className="mt-4">
                    <h3 className="text-label-sm text-ink-muted">These cannot be reversed safely and will stay as they are</h3>
                    <Reasons reasons={preview.reasons} />
                    <Items items={preview.conflicts} label="Changes that stay" />
                </div>
            )}
            {blocked && <p role="status" className="mt-4 text-body-sm text-ink">{blocked}</p>}
            {!blocked && (
                <label htmlFor={confirmId} className="mt-4 flex items-start gap-2 text-body-sm text-ink">
                    <input id={confirmId} type="checkbox" className="mt-0.5" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                    <span>
                        I understand that {plural(summary.eligible, "change")} will be reversed and cannot be restored afterwards
                        {summary.conflicts > 0 ? `, and that ${plural(summary.conflicts, "change")} will stay as they are` : ""}.
                    </span>
                </label>
            )}
            <div className="mt-5 flex justify-end gap-2">
                <button type="button" className={secondaryButton} onClick={onClose}>Close</button>
                {!blocked && (
                    <button type="button" className={primaryButton} disabled={!confirmed || summary.eligible === 0} onClick={() => void run(preview)}>
                        {resuming ? "Continue rollback" : `Roll back ${plural(summary.eligible, "change")}`}
                    </button>
                )}
            </div>
        </>
    );
}

function Report({ report, onClose }: { report: RollbackReport; onClose: () => void }) {
    const clean = report.status === "ROLLED_BACK";
    return (
        <>
            <p role="status" className="text-body-sm text-ink">
                {clean ? "The import was rolled back." : "The import was rolled back, except for the changes listed below."}
            </p>
            <dl aria-label="Rollback report" className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Tile label="Reversed" value={report.counts.reverted} />
                <Tile label="Kept (could not be reversed safely)" value={report.counts.conflicts} tone="critical" />
                <Tile label="Already gone" value={report.counts.skipped} tone="review" />
            </dl>
            {report.counts.conflicts > 0 && (
                <div className="mt-4">
                    <h3 className="text-label-sm text-ink-muted">Why they stayed</h3>
                    <Reasons reasons={report.reasons} />
                    <Items items={report.conflicts} label="Changes that stayed" />
                    <p className="mt-2 text-body-sm text-ink-muted">Once the cause is resolved, open this import and roll back again: the changes that stayed are tried again.</p>
                </div>
            )}
            <p className="mt-3 text-body-sm text-ink-muted">
                {report.sync?.requested
                    ? "A Google Sheet sync was requested: the Candidate Operational Mirror follows the database, and the rows of deleted candidates are marked inactive."
                    : "Nothing needed to be synchronised to the Google Sheet."}
            </p>
            <div className="mt-5 flex justify-end">
                <button type="button" className={primaryButton} onClick={onClose}>Close</button>
            </div>
        </>
    );
}
