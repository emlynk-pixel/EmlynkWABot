import { useEffect, useId, useState, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { commitImportChunk, finishImport, getImportSourceColumns, previewImport, type ImportActions, type ImportChunkResult, type ImportCounts, type ImportFinish, type ImportPreview, type ImportRow } from "../api/candidateImport";
import { useAuth } from "../auth/AuthProvider";
import { DialogError, primaryButton, secondaryButton } from "./Dialog";
import { formatNumber, humanize } from "./format";
import { ToneBadge, type Tone } from "./StatusBadge";
import { readWorkbook, WorkbookError } from "./importWorkbook";
import { downloadValidationWorkbook } from "./validationWorkbook";

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
    if (actions.visa.VISA_APPROVED) lines.push(`VISA STATUS "Got Visa" → Visa approval stage completed (${plural(actions.visa.VISA_APPROVED, "candidate")})`);
    if (actions.visa.DEPARTED) lines.push(`VISA STATUS "Departed" → Departed (${plural(actions.visa.DEPARTED, "candidate")})`);
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

const errorText = (error: unknown, fallback: string) => (error instanceof WorkbookError || error instanceof ApiError ? error.message : fallback);
const sum = (a: ImportCounts, b: ImportCounts): ImportCounts => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, (a[k as keyof ImportCounts] ?? 0) + (b[k as keyof ImportCounts] ?? 0)]));

export function CandidateImportDialog({ onClose }: { onClose: () => void }) {
    const { token } = useAuth();
    const fileId = useId();
    const [step, setStep] = useState<Step>({ kind: "choose" });
    const [error, setError] = useState<string | null>(null);
    const [downloading, setDownloading] = useState(false);
    const busy = step.kind === "reading" || step.kind === "committing";

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
        setStep({ kind: "reading" });
        try {
            const columns = await getImportSourceColumns(token);
            const { headers, rows, missingRequired } = await readWorkbook(file, columns);
            if (missingRequired.length) throw new WorkbookError(`The sheet is missing required headings: ${missingRequired.join(", ")}.`);
            if (!rows.length) throw new WorkbookError("The sheet has no candidate rows.");
            const preview = await previewImport(token, { fileName: file.name, headers, rows });
            setStep({ kind: "preview", file, fileName: file.name, rows, preview });
        } catch (e) {
            setError(errorText(e, "The sheet could not be checked."));
            setStep({ kind: "choose" });
        }
    }

    async function confirm() {
        if (step.kind !== "preview" || !token) return;
        const { preview, rows } = step;
        setError(null);
        const failures: ImportChunkResult["failures"] = [];
        let counts: ImportCounts = {};
        setStep({ kind: "committing", done: 0, total: preview.chunkCount });
        try {
            // One chunk at a time: the server writes each in one short transaction.
            for (let index = 0; index < preview.chunkCount; index++) {
                const chunk = rows.slice(index * preview.chunkSize, (index + 1) * preview.chunkSize);
                const result = await commitImportChunk(token, preview.importId, index, chunk);
                failures.push(...result.failures);
                counts = sum(counts, result.counts);
                setStep({ kind: "committing", done: index + 1, total: preview.chunkCount });
            }
        } catch (e) {
            setError(`${errorText(e, "The import stopped.")} The rows already imported are kept.`);
        }
        try {
            const result = await finishImport(token, preview.importId);
            setStep({ kind: "done", result, failures });
        } catch (e) {
            setError(errorText(e, "The import result could not be recorded."));
            setStep({ kind: "done", result: { importId: preview.importId, status: "COMPLETED_WITH_ERRORS", totalRows: preview.summary.totalRows, counts, syncRunId: null }, failures });
        }
    }

    const title = "Upload: import candidates";

    if (step.kind === "choose" || step.kind === "reading") {
        return (
            <Shell title={title} busy={busy} onClose={onClose}>
                <p className="text-body-sm text-ink-muted">
                    Choose the existing candidate sheet (.xlsx). It is read on this computer; only the columns Emlynk uses are checked by the server.
                    Nothing is saved until you confirm the preview.
                </p>
                <label htmlFor={fileId} className="mt-4 block text-label-md text-ink-muted">Candidate sheet (.xlsx)</label>
                <input
                    id={fileId}
                    type="file"
                    accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    disabled={busy}
                    onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ""; }}
                    className="mt-1 block w-full text-body-sm text-ink file:mr-3 file:h-8 file:rounded-lg file:border file:border-border-strong file:bg-surface file:px-3 file:text-label-md file:text-ink-soft"
                />
                {step.kind === "reading" && <p role="status" className="mt-3 text-body-sm text-ink-muted">Reading and checking the sheet…</p>}
                <DialogError message={error} />
                <div className="mt-5 flex justify-end">
                    <button type="button" className={secondaryButton} disabled={busy} onClick={onClose}>Cancel</button>
                </div>
            </Shell>
        );
    }

    if (step.kind === "preview") {
        const { summary, problems, problemsTruncated, columns, rowIssues = [], actions } = step.preview;
        const importable = summary.new + summary.willFill;
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
                </dl>
                <p className="mt-3 text-body-sm text-ink-muted">
                    Existing candidates only get empty fields filled; nothing already recorded is overwritten
                    {summary.fieldsDiffering ? ` (${formatNumber(summary.fieldsDiffering)} recorded values differ from the sheet and are kept)` : ""}.
                    Documents are not imported; an assignment, test or visa stage already recorded is kept.
                    {columns.unresolved.length ? ` Not imported (meaning unconfirmed): ${columns.unresolved.join(", ")}.` : ""}
                </p>

                {actions && <AutomaticActions actions={actions} />}

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
                    <button type="button" className={primaryButton} disabled={!importable} onClick={() => void confirm()}>
                        Confirm import ({formatNumber(importable)} candidates)
                    </button>
                </div>
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
            <div className="mt-5 flex justify-end">
                <button type="button" className={primaryButton} onClick={onClose}>Close</button>
            </div>
        </Shell>
    );
}
