import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { abortImport, commitImportChunk, finishImport, getActiveImport, getImportSourceColumns, previewImport, sendImportHeartbeat, updateImportJobGroups, type ActiveImport, type ImportActions, type ImportJobGroup, type ImportChunkResult, type ImportCounts, type ImportFinish, type ImportPreview, type ImportRow, type ResumableImport } from "../api/candidateImport";
import { useAuth } from "../auth/AuthProvider";
import { DialogError, primaryButton, secondaryButton } from "./Dialog";
import { formatDate, formatNumber, humanize } from "./format";
import { ToneBadge, type Tone } from "./StatusBadge";
import { readWorkbook, WorkbookError } from "./importWorkbook";
import { downloadValidationWorkbook } from "./validationWorkbook";
import { ImportRollbackPanel } from "./ImportRollbackPanel";

// Settings -> Google Sheet Sync -> Upload: upload a legacy candidate sheet, preview, confirm.
//   1. choose a .xlsx: read HERE (the file never leaves the browser)
//   2. preview: the server validates and classifies the allow-listed columns; nothing is written.
//      With errors or warnings, a validation sheet (the same workbook + ERRORS / WARNINGS columns)
//      can be downloaded, built here from the chosen file (validationWorkbook.ts), fixed and uploaded again.
//   3. confirm: the rows are committed chunk by chunk, one request at a time
//   4. result: counts; the existing Google Sheet sync is requested and updates the mirror
// Only masked passport numbers and readable reasons are shown, never a candidate's details.

type Step =
    | { kind: "choose" }
    | { kind: "reading" }
    | { kind: "preview"; file: File; fileName: string; rows: ImportRow[]; preview: ImportPreview }
    // The chosen file is the one an earlier import of yours was still committing: continue that import.
    | { kind: "resume"; fileName: string; rows: ImportRow[]; details: ResumableImport; totalRows: number }
    // Review and run the rollback of a finished, aborted or interrupted-rollback import (ImportRollbackPanel.tsx).
    | { kind: "rollback"; importId: string }
    | { kind: "committing"; done: number; total: number }
    | { kind: "done"; result: ImportFinish; failures: ImportChunkResult["failures"] };

const STATUS_TONE: Record<string, Tone> = { VALID: "verified", WARNING: "review", INVALID: "critical", CONFLICT: "critical", DUPLICATE: "duplicate" };

function Tile({ label, value, tone }: { label: string; value: number; tone?: "critical" | "review" }) {
    return (
        <div className="min-w-0 rounded-lg border border-border bg-canvas px-3 py-2">
            <dt className="text-label-sm text-ink-muted">{label}</dt>
            <dd className={`mt-0.5 text-body-md tabular-nums ${tone === "critical" && value ? "text-critical" : tone === "review" && value ? "text-review" : "text-ink"}`}>{formatNumber(value)}</dd>
        </div>
    );
}

function Shell({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: ReactNode }) {
    const titleId = useId();
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [busy, onClose]);
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-xs">
            <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-border bg-surface p-5 shadow-modal">
                <h2 id={titleId} className="text-headline-sm text-ink">{title}</h2>
                <div className="mt-3">{children}</div>
            </div>
        </div>
    );
}

const plural = (count: number, one: string, many = `${one}s`) => `${formatNumber(count)} ${count === 1 ? one : many}`;

// What the import will do on its own (preview): assignments, Clients / Agents, visa stages, tests.
function AutomaticActions({ actions }: { actions: ImportActions }) {
    const lines: string[] = [];
    for (const o of actions.officers) lines.push(`Officer "${o.sheetName}" → ${o.userName} (${plural(o.rows, "row")})`);
    for (const a of actions.officerAssignments) lines.push(`${plural(a.rows, "candidate")} will be assigned to ${a.userName}`);
    for (const c of actions.clients) lines.push(`Company "${c.name}" → ${c.action === "CREATE" ? "new Client will be created" : "existing Client"}`);
    for (const a of actions.agents) lines.push(`Agent "${a.name}" → ${a.action === "CREATE" ? "new Agent will be created (country not set)" : "existing Agent matched"}`);
    if (actions.visa.VISA_SUBMITTED) lines.push(`VISA STATUS "Submit" → Visa Submitted (${plural(actions.visa.VISA_SUBMITTED, "candidate")})`);
    if (actions.visa.VISA_APPROVED) lines.push(`VISA STATUS "Got Visa" → Visa Approved (${plural(actions.visa.VISA_APPROVED, "candidate")})`);
    if (actions.visa.DEPARTED) lines.push(`VISA STATUS "Departed" → Departed (${plural(actions.visa.DEPARTED, "candidate")})`);
    if (actions.visa.VISA_NOT_GOING) lines.push(`VISA STATUS "Got Visa Not Going" → Visa Not Going (${plural(actions.visa.VISA_NOT_GOING, "candidate")})`);
    if (actions.visa.CANCELLED) lines.push(`VISA STATUS "Cancelled" → Cancelled (${plural(actions.visa.CANCELLED, "candidate")})`);
    if (actions.visa.REJECTED) lines.push(`VISA STATUS "Reject" → Rejected (${plural(actions.visa.REJECTED, "candidate")})`);
    if (actions.tests) lines.push(`Interview → Test details for ${plural(actions.tests, "candidate")} (Interview Date → Test date, Test ID from the date)`);
    if (actions.testsBlankResultAsPass) lines.push(`Interview result blank → PASS (${plural(actions.testsBlankResultAsPass, "candidate")})`);
    if (!lines.length) return null;
    return (
        <div className="mt-4">
            <h3 className="text-label-sm text-ink-muted">Automatic actions</h3>
            <ul aria-label="Automatic actions" className="mt-2 max-h-48 list-disc overflow-auto rounded-lg border border-border py-2 pl-7 pr-3 text-body-sm text-ink">
                {lines.map((line) => <li key={line}>{line}</li>)}
            </ul>
        </div>
    );
}

const GROUP_LABEL: Record<ImportJobGroup["state"], { label: string; tone: Tone }> = {
    NEW: { label: "New Job", tone: "verified" },
    EXISTING: { label: "Existing Job", tone: "pending" },
    SKIPPED: { label: "No Job yet", tone: "review" },
    ERROR: { label: "No Job", tone: "critical" },
};
const validSuffix = (value: string) => /^[0-9]{2}$/.test(value) && value !== "00";

// The Jobs this upload creates or reuses: one per Interview Date and UNIQUE NUMBER hundreds block, ID
// JOB-YYYY-MMDDNN. A NEW Job's last two digits can be changed here (the date part never); every
// candidate of the group follows. "Save Job IDs" has the server check them (unique, two digits) before
// the import; an existing Job keeps its ID. edits: the unsaved changes, owned by the dialog.
function JobGroupsTable({ groups, edits, onEdit, onSave, saving }: {
    groups: ImportJobGroup[];
    edits: Record<string, string>;
    onEdit: (key: string, value: string) => void;
    onSave: () => void;
    saving: boolean;
}) {
    if (!groups.length) return null;
    const dirty = Object.keys(edits).length > 0;
    const invalid = Object.values(edits).some((value) => !validSuffix(value));
    return (
        <div className="mt-4">
            <h3 className="text-label-sm text-ink-muted">Jobs from this upload (Interview date + Unique number, 100 per Job)</h3>
            <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-border">
                <table aria-label="Jobs from this upload" className="w-full text-left text-body-sm">
                    <thead className="sticky top-0 bg-surface text-label-md text-ink">
                        <tr><th className="px-3 py-1.5">Interview date</th><th className="px-3 py-1.5">Unique numbers</th><th className="px-3 py-1.5">Job ID</th><th className="px-3 py-1.5">Candidates</th><th className="px-3 py-1.5">Result</th></tr>
                    </thead>
                    <tbody>
                        {groups.map((g) => {
                            const value = edits[g.key] ?? g.suffix ?? "";
                            const editable = g.state === "NEW";
                            return (
                                <tr key={g.key} data-testid="job-group" className="border-t border-border align-top">
                                    <td className="px-3 py-1.5 tabular-nums">{formatDate(g.interviewDate)}</td>
                                    <td className="px-3 py-1.5 tabular-nums">{g.from}–{g.to}</td>
                                    <td className="px-3 py-1.5">
                                        {editable ? (
                                            <span className="inline-flex items-center gap-0.5 font-mono">
                                                <span aria-hidden="true">{g.prefix}</span>
                                                <input
                                                    aria-label={`Last two digits of the Job for ${g.from}–${g.to} on ${formatDate(g.interviewDate)}`}
                                                    value={value}
                                                    inputMode="numeric"
                                                    maxLength={2}
                                                    aria-invalid={!validSuffix(value)}
                                                    onChange={(event) => onEdit(g.key, event.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
                                                    className="h-7 w-10 rounded-md border border-border-strong bg-surface px-1 text-center text-body-sm text-ink focus:border-border-focus focus:outline-none aria-[invalid=true]:border-critical"
                                                />
                                            </span>
                                        ) : <span className="font-mono">{g.jobCode ?? "—"}</span>}
                                        {editable && validSuffix(value) && <p className="mt-0.5 text-label-sm text-ink-muted">Final: <span className="font-mono text-ink">{g.prefix}{value}</span>{g.edited && !edits[g.key] ? " (changed)" : ""}</p>}
                                    </td>
                                    <td className="px-3 py-1.5 tabular-nums">{g.passed} of {g.candidates} passed</td>
                                    <td className="px-3 py-1.5">
                                        <ToneBadge tone={GROUP_LABEL[g.state].tone}>{GROUP_LABEL[g.state].label}</ToneBadge>
                                        {(g.messages ?? []).map((m) => <p key={m} className="mt-0.5 text-label-sm text-ink-muted">{m}</p>)}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-end gap-3">
                <p className="min-w-0 flex-1 text-label-sm text-ink-muted">Only a new Job's last two digits can be changed; each must be 01–99 and unused. Only candidates who passed the test are put on a Job.</p>
                {dirty && <button type="button" className={secondaryButton} disabled={saving || invalid} onClick={onSave}>{saving ? "Saving…" : "Save Job IDs"}</button>}
            </div>
        </div>
    );
}

const errorText = (error: unknown, fallback: string) => (error instanceof WorkbookError || error instanceof ApiError ? error.message : fallback);
// One key per file choice: a repeated or retried preview request is the same import on the server.
// The committing dialog's heartbeat (POST .../heartbeat): well inside the server's grace period.
const HEARTBEAT_MS = 20_000;
const newRequestKey = () => globalThis.crypto?.randomUUID?.() ?? `k${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
const asResumable = (error: unknown): ResumableImport | null => {
    if (!(error instanceof ApiError) || error.code !== "IMPORT_ALREADY_ACTIVE") return null;
    const d = error.details as Partial<ResumableImport> | undefined;
    return d && typeof d.importId === "string" && Number.isInteger(d.chunkSize) && Number.isInteger(d.chunkCount) && Array.isArray(d.committedChunks)
        ? { importId: d.importId, chunkSize: d.chunkSize as number, chunkCount: d.chunkCount as number, committedChunks: d.committedChunks, stale: d.stale }
        : null;
};
const sum = (a: ImportCounts, b: ImportCounts): ImportCounts => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, (a[k as keyof ImportCounts] ?? 0) + (b[k as keyof ImportCounts] ?? 0)]));

export function CandidateImportDialog({ onClose }: { onClose: () => void }) {
    const { token } = useAuth();
    const fileId = useId();
    const [step, setStep] = useState<Step>({ kind: "choose" });
    const [error, setError] = useState<string | null>(null);
    const [downloading, setDownloading] = useState(false);
    // Unsaved last-two-digit edits of NEW Jobs (group key -> digits), and their save.
    const [suffixEdits, setSuffixEdits] = useState<Record<string, string>>({});
    const [savingSuffixes, setSavingSuffixes] = useState(false);
    // Only the commit blocks Cancel and Esc. Reading can be cancelled: the answer of an abandoned
    // read, check or preview is ignored (readSeq), so a stalled reader can never trap the dialog.
    const [rollbackBusy, setRollbackBusy] = useState(false); // a rollback is running: Esc and Close wait
    const busy = step.kind === "committing" || (step.kind === "rollback" && rollbackBusy);
    const reading = step.kind === "reading";
    const readSeq = useRef(0);
    const closeReading = () => { readSeq.current += 1; onClose(); };
    // The import committing now (one at most, anybody's): shown before a file is chosen so an Upload
    // that cannot start is explained, and a stopped one can be aborted.
    const [activeImport, setActiveImport] = useState<ActiveImport | null>(null);
    const [aborting, setAborting] = useState(false);
    // An import just aborted from here: its rows were kept, and it can be rolled back.
    const [aborted, setAborted] = useState<{ importId: string; fileName: string } | null>(null);
    useEffect(() => {
        if (!token) return;
        const controller = new AbortController();
        getActiveImport(token, controller.signal).then((r) => setActiveImport(r.active), () => {});
        return () => controller.abort();
    }, [token]);

    async function abortActive() {
        if (!activeImport || !token) return;
        setError(null);
        setAborting(true);
        try {
            await abortImport(token, activeImport.importId);
            setAborted({ importId: activeImport.importId, fileName: activeImport.fileName });
            setActiveImport(null);
        } catch (e) {
            setError(errorText(e, "The import could not be aborted."));
        } finally {
            setAborting(false);
        }
    }

    async function downloadValidationSheet() {
        if (step.kind !== "preview") return;
        setError(null);
        setDownloading(true);
        try {
            await downloadValidationWorkbook(step.file, step.preview.rowIssues ?? []);
        } catch {
            setError("The validation sheet could not be created from this workbook.");
        } finally {
            setDownloading(false);
        }
    }

    async function choose(file: File | undefined) {
        if (!file || !token) return;
        setError(null);
        const seq = ++readSeq.current;
        setStep({ kind: "reading" });
        let sheetRows: ImportRow[] = [];
        try {
            const columns = await getImportSourceColumns(token);
            if (seq !== readSeq.current) return;
            const { headers, rows, missingRequired } = await readWorkbook(file, columns);
            if (seq !== readSeq.current) return;
            sheetRows = rows;
            if (missingRequired.length) throw new WorkbookError(`The sheet is missing required headings: ${missingRequired.join(", ")}.`);
            if (!rows.length) throw new WorkbookError("The sheet has no candidate rows.");
            const preview = await previewImport(token, { fileName: file.name, headers, rows }, newRequestKey());
            if (seq !== readSeq.current) return;
            setStep({ kind: "preview", file, fileName: file.name, rows, preview });
        } catch (e) {
            if (seq !== readSeq.current) return;
            const resumable = asResumable(e);
            if (resumable) {
                setStep({ kind: "resume", fileName: file.name, rows: sheetRows, details: resumable, totalRows: sheetRows.length });
                return;
            }
            setError(errorText(e, "The sheet could not be checked."));
            setStep({ kind: "choose" });
        }
    }

    async function saveSuffixes() {
        if (step.kind !== "preview" || !token) return;
        setError(null);
        setSavingSuffixes(true);
        try {
            const { jobGroups } = await updateImportJobGroups(token, step.preview.importId, suffixEdits);
            setStep({ ...step, preview: { ...step.preview, jobGroups } });
            setSuffixEdits({});
        } catch (e) {
            setError(errorText(e, "The Job IDs could not be saved."));
        } finally {
            setSavingSuffixes(false);
        }
    }

    // Commits the chunks one at a time (the server writes each in one short transaction), skipping the
    // ones already committed (a resumed import), then finishes. `back` is the screen to return to when
    // the import could not even start.
    async function runCommit({ importId, chunkSize, chunkCount, rows, totalRows, skip = [], back }: {
        importId: string; chunkSize: number; chunkCount: number; rows: ImportRow[]; totalRows: number; skip?: number[]; back: Step;
    }) {
        if (!token) return;
        setError(null);
        const failures: ImportChunkResult["failures"] = [];
        let counts: ImportCounts = {};
        const skipped = new Set(skip);
        let done = skipped.size;
        setStep({ kind: "committing", done, total: chunkCount });
        // "Still here" while this window commits: if it closes, the server undoes the import after a few minutes.
        const heartbeat = setInterval(() => { void sendImportHeartbeat(token, importId).catch(() => {}); }, HEARTBEAT_MS);
        try {
            for (let index = 0; index < chunkCount; index++) {
                if (skipped.has(index)) continue;
                const chunk = rows.slice(index * chunkSize, (index + 1) * chunkSize);
                const result = await commitImportChunk(token, importId, index, chunk);
                failures.push(...result.failures);
                counts = sum(counts, result.counts);
                done += 1;
                setStep({ kind: "committing", done, total: chunkCount });
            }
        } catch (e) {
            // Refused before anything was written (another import is committing, or this one was
            // aborted from elsewhere): nothing to finish, go back and say why.
            if (e instanceof ApiError && (e.code === "IMPORT_IN_PROGRESS" || e.code === "IMPORT_FINISHED") && done === skipped.size) {
                setError(e.message);
                setStep(back);
                return;
            }
            // An import is all or nothing: one that stopped part way is NOT finished from here (that would keep half
            // of it). It stays open to be continued with the same file; if it is not, the server undoes it.
            setError(e instanceof ApiError && e.code === "IMPORT_RECOVERY_STARTED"
                ? e.message
                : `${errorText(e, "The import stopped.")} Nothing is final until the import finishes: choose the same file again within a few minutes to continue it, otherwise everything it imported is undone automatically.`);
            setStep({ kind: "choose" });
            getActiveImport(token).then((r) => setActiveImport(r.active), () => {});
            return;
        } finally {
            clearInterval(heartbeat);
        }
        try {
            const result = await finishImport(token, importId);
            setStep({ kind: "done", result, failures });
        } catch (e) {
            setError(errorText(e, "The import result could not be recorded."));
            setStep({ kind: "done", result: { importId, status: "COMPLETED_WITH_ERRORS", totalRows, counts, syncRunId: null }, failures });
        }
    }

    async function confirm() {
        if (step.kind !== "preview") return;
        const { preview, rows } = step;
        await runCommit({ importId: preview.importId, chunkSize: preview.chunkSize, chunkCount: preview.chunkCount, rows, totalRows: preview.summary.totalRows, back: step });
    }

    async function resume() {
        if (step.kind !== "resume") return;
        const { details, rows, totalRows } = step;
        await runCommit({ importId: details.importId, chunkSize: details.chunkSize, chunkCount: details.chunkCount, rows, totalRows, skip: details.committedChunks, back: { kind: "choose" } });
    }

    async function abortResumable() {
        if (step.kind !== "resume" || !token) return;
        setError(null);
        try {
            await abortImport(token, step.details.importId);
            setAborted({ importId: step.details.importId, fileName: step.fileName });
            setActiveImport(null);
            setStep({ kind: "choose" });
        } catch (e) {
            setError(errorText(e, "The import could not be aborted."));
        }
    }

    const title = "Upload: import candidates";

    if (step.kind === "choose" || step.kind === "reading") {
        return (
            <Shell title={title} busy={busy} onClose={closeReading}>
                <p className="text-body-sm text-ink-muted">
                    Choose the existing candidate sheet (.xlsx). It is read on this computer; only the columns Emlynk uses are checked by the server.
                    Nothing is saved until you confirm the preview.
                </p>
                {activeImport?.status === "ROLLING_BACK" && (
                    <div role="alert" aria-label="Rollback in progress" className="mt-3 rounded-lg border border-review-border bg-review-bg px-4 py-3 text-body-sm text-review">
                        {activeImport.recovery ? (
                            <p>Your import {activeImport.fileName} stopped before it finished, so it is being undone automatically. Nothing from it is kept.</p>
                        ) : (
                            <p>A rollback of your import {activeImport.fileName} was interrupted. Nothing is half done: continue it to finish.</p>
                        )}
                        <button type="button" className={`${secondaryButton} mt-2`} onClick={() => setStep({ kind: "rollback", importId: activeImport.importId })}>{activeImport.recovery ? "View progress" : "Continue rollback"}</button>
                    </div>
                )}
                {aborted && (
                    <div role="status" aria-label="Import aborted" className="mt-3 rounded-lg border border-border bg-canvas px-4 py-3 text-body-sm text-ink">
                        <p>The import {aborted.fileName} was aborted. The rows already imported were kept.</p>
                        <button type="button" className={`${secondaryButton} mt-2`} onClick={() => setStep({ kind: "rollback", importId: aborted.importId })}>Review rollback…</button>
                    </div>
                )}
                {activeImport && activeImport.status !== "ROLLING_BACK" && (
                    <div role="alert" aria-label="Import in progress" className="mt-3 rounded-lg border border-review-border bg-review-bg px-4 py-3 text-body-sm text-review">
                        <p>
                            You have an import in progress: {activeImport.fileName},{" "}
                            {formatNumber(activeImport.committedChunks.length)} of {formatNumber(activeImport.chunkCount)} parts saved{activeImport.stale ? ", and it has stopped." : "."}
                        </p>
                        <p className="mt-1">Choose the same file again to continue it, or abort it (the rows already imported are kept).</p>
                        <button type="button" className={`${secondaryButton} mt-2`} disabled={aborting} onClick={() => void abortActive()}>{aborting ? "Aborting…" : "Abort that import"}</button>
                    </div>
                )}
                <label htmlFor={fileId} className="mt-4 block text-label-md text-ink-muted">Candidate sheet (.xlsx)</label>
                <input
                    id={fileId}
                    type="file"
                    accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    disabled={reading}
                    onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ""; }}
                    className="mt-1 block w-full text-body-sm text-ink file:mr-3 file:h-8 file:rounded-lg file:border file:border-border-strong file:bg-surface file:px-3 file:text-label-md file:text-ink-soft"
                />
                {step.kind === "reading" && <p role="status" className="mt-3 text-body-sm text-ink-muted">Reading and checking the sheet…</p>}
                <DialogError message={error} />
                <div className="mt-5 flex justify-end">
                    <button type="button" className={secondaryButton} onClick={closeReading}>Cancel</button>
                </div>
            </Shell>
        );
    }

    if (step.kind === "preview") {
        const { summary, problems, problemsTruncated, columns, rowIssues = [], actions, jobGroups = [] } = step.preview;
        const importable = summary.new + summary.willFill;
        // Existing candidates who only join a Job are worth an import too.
        const jobMembers = summary.jobMembers ?? 0;
        const unsavedSuffixes = Object.keys(suffixEdits).length > 0;
        const reasons = (p: (typeof problems)[number]) => (p.errors || p.warnings ? [...(p.errors ?? []), ...(p.warnings ?? [])] : p.codes.map(humanize));
        return (
            <Shell title={title} busy={false} onClose={onClose}>
                <p className="text-body-sm text-ink-muted">Preview of <span className="text-ink">{step.fileName}</span>. Nothing has been saved yet.</p>
                <dl aria-label="Import preview" className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Tile label="Total rows" value={summary.totalRows} />
                    <Tile label="New candidates" value={summary.new} />
                    <Tile label="Existing candidates" value={summary.existing} />
                    <Tile label="Existing: blanks to fill" value={summary.willFill} />
                    <Tile label="Valid" value={summary.valid} />
                    <Tile label="Warnings" value={summary.warnings} tone="review" />
                    <Tile label="Invalid" value={summary.invalid} tone="critical" />
                    <Tile label="Duplicate rows in file" value={summary.duplicates} tone="critical" />
                    <Tile label="Conflicts" value={summary.conflicts} tone="critical" />
                    <Tile label="Skipped (details verified)" value={summary.skippedVerified} tone="review" />
                    <Tile label="Unknown job roles" value={summary.unknownJobRoles} tone="review" />
                    <Tile label="Ignored source columns" value={summary.ignoredSourceColumns} />
                    {jobGroups.length > 0 && <Tile label="Jobs to create" value={summary.jobsToCreate ?? 0} />}
                    {jobGroups.length > 0 && <Tile label="Existing Jobs reused" value={summary.jobsReused ?? 0} />}
                </dl>
                <p className="mt-3 text-body-sm text-ink-muted">
                    Existing candidates only get empty fields filled; nothing already recorded is overwritten
                    {summary.fieldsDiffering ? ` (${formatNumber(summary.fieldsDiffering)} recorded values differ from the sheet and are kept)` : ""}.
                    Documents are not imported; an assignment, test or visa stage already recorded is kept.
                    {columns.unresolved.length ? ` Not imported (meaning unconfirmed): ${columns.unresolved.join(", ")}.` : ""}
                </p>

                {actions && <AutomaticActions actions={actions} />}

                <JobGroupsTable
                    groups={jobGroups}
                    edits={suffixEdits}
                    onEdit={(key, value) => setSuffixEdits((current) => {
                        const original = jobGroups.find((g) => g.key === key)?.suffix ?? "";
                        const { [key]: _previous, ...rest } = current; // eslint-disable-line @typescript-eslint/no-unused-vars
                        return value === original ? rest : { ...rest, [key]: value };
                    })}
                    onSave={() => void saveSuffixes()}
                    saving={savingSuffixes}
                />

                {rowIssues.length > 0 && (
                    <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-canvas px-3 py-2">
                        <p className="min-w-0 flex-1 text-body-sm text-ink-muted">
                            {formatNumber(rowIssues.length)} {rowIssues.length === 1 ? "row has" : "rows have"} errors or warnings. Download the sheet with
                            ERRORS and WARNINGS columns, correct it, and upload it again.
                        </p>
                        <button type="button" className={secondaryButton} disabled={downloading} onClick={() => void downloadValidationSheet()}>
                            {downloading ? "Preparing…" : "Download validation sheet"}
                        </button>
                    </div>
                )}

                {problems.length > 0 && (
                    <div className="mt-4">
                        <h3 className="text-label-sm text-ink-muted">Rows to review{problemsTruncated ? ` (first ${formatNumber(problems.length)})` : ""}</h3>
                        <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-border">
                            <table className="w-full text-left text-body-sm">
                                <thead className="sticky top-0 bg-surface text-label-md text-ink">
                                    <tr><th className="px-3 py-1.5">Row</th><th className="px-3 py-1.5">Passport</th><th className="px-3 py-1.5">Status</th><th className="px-3 py-1.5">Reasons</th></tr>
                                </thead>
                                <tbody>
                                    {problems.map((p) => (
                                        <tr key={p.rowNumber} className="border-t border-border">
                                            <td className="px-3 py-1.5 tabular-nums">{p.rowNumber}</td>
                                            <td className="px-3 py-1.5 tabular-nums">{p.passport}</td>
                                            <td className="px-3 py-1.5"><ToneBadge tone={STATUS_TONE[p.status] ?? "pending"}>{humanize(p.status)}</ToneBadge></td>
                                            <td className="px-3 py-1.5 text-ink-muted">{reasons(p).join("; ")}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                <DialogError message={error} />
                <div className="mt-5 flex flex-wrap justify-end gap-2">
                    <button type="button" className={secondaryButton} onClick={onClose}>Cancel</button>
                    <button type="button" className={primaryButton} disabled={(!importable && !jobMembers) || unsavedSuffixes} title={unsavedSuffixes ? "Save the Job IDs first" : undefined} onClick={() => void confirm()}>
                        Confirm import ({formatNumber(importable)} candidates{jobMembers ? `, ${plural(jobMembers, "Job assignment")}` : ""})
                    </button>
                </div>
            </Shell>
        );
    }

    if (step.kind === "resume") {
        const { details } = step;
        return (
            <Shell title={title} busy={false} onClose={onClose}>
                <p role="status" className="text-body-sm text-ink">
                    This file is already being imported: {formatNumber(details.committedChunks.length)} of {formatNumber(details.chunkCount)} parts are saved.
                </p>
                <p className="mt-2 text-body-sm text-ink-muted">
                    Continue to import the remaining parts. Or abort that import: the rows already imported are kept, and you can upload the file again.
                </p>
                <DialogError message={error} />
                <div className="mt-5 flex flex-wrap justify-end gap-2">
                    <button type="button" className={secondaryButton} onClick={onClose}>Cancel</button>
                    <button type="button" className={secondaryButton} onClick={() => void abortResumable()}>Abort that import</button>
                    <button type="button" className={primaryButton} onClick={() => void resume()}>Continue import</button>
                </div>
            </Shell>
        );
    }

    if (step.kind === "rollback") {
        return (
            <Shell title="Roll back an import" busy={busy} onClose={onClose}>
                <ImportRollbackPanel importId={step.importId} onClose={onClose} onBusyChange={setRollbackBusy} />
            </Shell>
        );
    }

    if (step.kind === "committing") {
        return (
            <Shell title={title} busy onClose={onClose}>
                <p role="status" className="text-body-sm text-ink">Importing… {formatNumber(step.done)} of {formatNumber(step.total)} parts saved.</p>
                <progress className="mt-3 w-full" max={step.total} value={step.done} />
                <p className="mt-2 text-body-sm text-ink-muted">Keep this window open until the import finishes.</p>
            </Shell>
        );
    }

    const { result, failures } = step;
    const c = result.counts;
    return (
        <Shell title={title} busy={false} onClose={onClose}>
            <p role="status" className="text-body-sm text-ink">
                {result.status === "COMPLETED" ? "Import completed." : result.status === "FAILED" ? "The import failed: nothing was saved." : "Import completed with errors: the rows listed below were not saved."}
            </p>
            <dl aria-label="Import result" className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Tile label="Total rows" value={result.totalRows} />
                <Tile label="Created" value={c.created ?? 0} />
                <Tile label="Updated (blanks filled)" value={c.filled ?? 0} />
                <Tile label="Unchanged" value={c.noChange ?? 0} />
                <Tile label="Skipped" value={(c.invalid ?? 0) + (c.duplicates ?? 0) + (c.conflicts ?? 0) + (c.skippedVerified ?? 0)} tone="review" />
                <Tile label="Warnings" value={c.warnings ?? 0} tone="review" />
                <Tile label="Failed" value={(c.failed ?? 0) + (c.uncommittedRows ?? 0)} tone="critical" />
                <Tile label="Assignments created" value={c.allocated ?? 0} />
                <Tile label="Tests set" value={c.testsSet ?? 0} />
                <Tile label="Visa stages completed" value={c.stagesCompleted ?? 0} />
                <Tile label="Departed" value={c.departed ?? 0} />
                <Tile label="Not going / cancelled / rejected" value={c.outcomes ?? 0} />
                <Tile label="Jobs created" value={c.jobsCreated ?? 0} />
                <Tile label="Added to Jobs" value={c.jobAssignments ?? 0} />
                <Tile label="Clients created" value={c.clientsCreated ?? 0} />
                <Tile label="Agents created" value={c.agentsCreated ?? 0} />
            </dl>
            <p className="mt-3 text-body-sm text-ink-muted">
                {result.sync?.requested
                    ? "A Google Sheet sync was requested: the Candidate Operational Mirror is updated from the database in the background."
                    : result.syncRunId ? "The Google Sheet sync was requested." : "Nothing was saved, so no Google Sheet sync was needed."}
            </p>
            {failures.length > 0 && (
                <ul className="mt-3 max-h-40 overflow-auto rounded-lg border border-border px-3 py-2 text-body-sm">
                    {failures.map((f) => <li key={f.rowNumber}>Row {f.rowNumber} ({f.passport}): {(f.errors?.length ? f.errors : f.codes.map(humanize)).join("; ")}</li>)}
                </ul>
            )}
            <DialogError message={error} />
            <div className="mt-5 flex justify-end gap-2">
                {(c.created ?? 0) + (c.filled ?? 0) + (c.jobAssignments ?? 0) > 0 && (
                    <button type="button" className={secondaryButton} onClick={() => setStep({ kind: "rollback", importId: result.importId })}>Roll back this import…</button>
                )}
                <button type="button" className={primaryButton} onClick={onClose}>Close</button>
            </div>
        </Shell>
    );
}
