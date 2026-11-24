import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import { useAdminResource } from "../api/useAdminResource";
import {
    browseVisaStorage, downloadVisaStorageFile, downloadVisaStorageZip, extractBatch, getExtractionPreview, listExtractionJobs,
    type ExtractionBatchResult, type ExtractionJobSummary, type ExtractionPreview, type ExtractionSkip, type StorageEntry,
} from "../api/visaSubmissionExtraction";
import { useAuth } from "../auth/AuthProvider";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { primaryButton, secondaryButton } from "../components/Dialog";
import { formatDateTime, formatFileSize, formatNumber } from "../components/format";
import { Icon } from "../components/Icon";
import { Card, EmptyState, ErrorState, LoadingState, SectionHeading } from "../components/States";
import { tableCell, tableHead, tableRow } from "../components/ui";

// Visa Submission (roles.ts VISA_SUBMISSION_ROLES; the route guard and the server check the same list):
// Extract copies a Job's signed submissions into VISA SUBMISSION/{date}/Plan B/ with the Client's
// Excel files; Files browses VISA SUBMISSION/ and downloads from it through the API (no signed URLs).

// How long to wait before sending a batch again when the server answers 409 EXTRACTION_IN_PROGRESS,
// how many times to send it, and how many times one candidate may be deferred before it is left for
// the next run (a candidate the server never reaches must not loop forever). Tests shorten the wait.
export const EXTRACTION_RETRY = { delayMs: 3000, maxAttempts: 5, maxDeferrals: 3 };

const FAILED_REASONS: Record<string, string> = {
    PDF_COPY_FAILED: "The signed visa submission PDF could not be copied. Extract this job again later to retry.",
};
const failedReason = (reason: string) => FAILED_REASONS[reason] ?? reason;

export const ZIP_TOO_LARGE_MESSAGE = "This folder is too large to download as one ZIP (more than 300 files or 200 MB). Download the files individually.";
const STORAGE_UNAVAILABLE_MESSAGE = "File storage is unavailable right now. Try again in a moment.";

const jobLabel = (job: { jobCode: string; companyJobId: string | null }) => (job.companyJobId ? `${job.jobCode} / ${job.companyJobId}` : job.jobCode);
const candidateName = (c: { firstName: string | null; otherName: string | null }) => [c.firstName, c.otherName].filter(Boolean).join(" ") || "—";

function saveFile(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    try {
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
    } finally {
        URL.revokeObjectURL(url);
    }
}

const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });

export function VisaSubmissionPage() {
    // Bumped after an extraction so the Files section lists what was just written.
    const [filesVersion, setFilesVersion] = useState(0);
    return (
        <section aria-labelledby="page-title" className="space-y-4">
            <div>
                <h1 id="page-title" className="text-headline-lg text-ink">Visa Submission</h1>
                <p className="mt-1 text-body-sm text-ink-muted">
                    Extract the signed visa submissions of a job into today's VISA SUBMISSION folder, and download the extracted files.
                </p>
            </div>
            <ExtractSection onExtracted={() => setFilesVersion((n) => n + 1)} />
            <FilesSection version={filesVersion} />
        </section>
    );
}

// ---------------------------------------------------------------- Extract

type Totals = {
    extracted: ExtractionBatchResult["extracted"];
    skipped: ExtractionSkip[];
    failed: ExtractionBatchResult["failed"];
    // Deferred more than EXTRACTION_RETRY.maxDeferrals times: left for the next run.
    notReached: string[];
};
const emptyTotals = (): Totals => ({ extracted: [], skipped: [], failed: [], notReached: [] });
type Progress = { batch: number; batches: number; busyAttempt: number | null; extracted: number; skipped: number; failed: number };
type Stopped = { message: string; pending: string[]; retryable: boolean };

function stopMessage(caught: unknown, batch: number): { message: string; retryable: boolean } {
    if (caught instanceof ApiError) {
        if (caught.code === "EXCEL_UPDATE_FAILED") {
            return { message: `The Excel files could not be updated, so the extraction stopped at batch ${batch}. Retrying is safe: candidates already extracted are skipped.`, retryable: true };
        }
        if (caught.code === "EXTRACTION_IN_PROGRESS") {
            return { message: "Another extraction of this job is still running. Wait a minute, then retry.", retryable: true };
        }
        if (caught.code === "JOB_NOT_FOUND") return { message: "This job no longer exists. Nothing more was extracted.", retryable: false };
        return { message: caught.message, retryable: true };
    }
    return { message: "The extraction stopped unexpectedly. Please try again.", retryable: true };
}

function ExtractSection({ onExtracted }: { onExtracted: () => void }) {
    const { token, signOut } = useAuth();
    const jobs = useAdminResource("visa-extraction-jobs", (t, signal) => listExtractionJobs(t, signal));
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [loadingPreview, setLoadingPreview] = useState(false);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const [preview, setPreview] = useState<ExtractionPreview | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState<Progress | null>(null);
    const [stopped, setStopped] = useState<Stopped | null>(null);
    const [summary, setSummary] = useState<{ totals: Totals; complete: boolean } | null>(null);
    const runRef = useRef<AbortController | null>(null);

    // Leaving the page stops the loop (no batch is sent after that).
    useEffect(() => () => runRef.current?.abort(), []);

    // Warn before the tab is closed or reloaded, but only while batches are being sent: the loop runs in
    // this tab. The cleanup removes it on every exit: finished, stopped, or the page left.
    useEffect(() => {
        if (!running) return;
        const warn = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [running]);

    const list = jobs.data?.jobs ?? [];
    const selected = list.find((job) => job.jobId === selectedId) ?? null;
    const busy = loadingPreview || running;

    const loadPreview = async () => {
        if (!token || !selected || busy) return;
        setPreviewError(null);
        setPreview(null);
        setStopped(null);
        setSummary(null);
        setLoadingPreview(true);
        try {
            const loaded = await getExtractionPreview(token, selected.jobId);
            setPreview(loaded);
            if (loaded.candidates.length > 0) setConfirming(true);
        } catch (caught) {
            if (caught instanceof ApiError && caught.status === 401) return signOut();
            setPreviewError(caught instanceof ApiError && caught.code === "JOB_NOT_FOUND" ? "This job no longer exists." : caught instanceof ApiError ? caught.message : "The extraction preview could not be loaded.");
        } finally {
            setLoadingPreview(false);
        }
    };

    // The browser drives the batches, one request each, instead of one long request: a serverless
    // function (Vercel) is stopped after 60 s, and a whole Job can take longer than that.
    const run = async (source: ExtractionPreview, ids: string[], previous: Totals) => {
        if (!token || ids.length === 0) return;
        const controller = new AbortController();
        runRef.current = controller;
        const { signal } = controller;
        const size = Math.max(1, Math.min(source.batchSize, source.maxBatchSize));
        const totals: Totals = { extracted: [...previous.extracted], skipped: [...previous.skipped], failed: [...previous.failed], notReached: [...previous.notReached] };
        const deferrals = new Map<string, number>();
        let queue = [...ids];
        let batch = 0;
        const report = (busyAttempt: number | null) =>
            setProgress({ batch, batches: batch - 1 + Math.ceil(queue.length / size), busyAttempt, extracted: totals.extracted.length, skipped: totals.skipped.length, failed: totals.failed.length });

        setStopped(null);
        setSummary(null);
        setRunning(true);
        try {
            while (queue.length > 0) {
                const chunk = queue.slice(0, size);
                batch += 1;
                report(null);
                let result: ExtractionBatchResult | null = null;
                for (let attempt = 1; result === null; attempt += 1) {
                    try {
                        result = await extractBatch(token, source.job.jobId, chunk, signal);
                    } catch (caught) {
                        const busyServer = caught instanceof ApiError && caught.status === 409 && caught.code === "EXTRACTION_IN_PROGRESS";
                        if (!busyServer || attempt >= EXTRACTION_RETRY.maxAttempts || signal.aborted) throw caught;
                        report(attempt);
                        await sleep(EXTRACTION_RETRY.delayMs, signal);
                        if (signal.aborted) return;
                    }
                }
                if (signal.aborted) return;
                queue = queue.slice(chunk.length);
                totals.extracted.push(...result.extracted);
                totals.skipped.push(...result.skipped);
                // Failed candidates are reported, never sent again automatically.
                totals.failed.push(...result.failed);
                const again: string[] = [];
                for (const id of result.deferred) {
                    if (!chunk.includes(id) || again.includes(id)) continue;
                    const count = (deferrals.get(id) ?? 0) + 1;
                    deferrals.set(id, count);
                    if (count > EXTRACTION_RETRY.maxDeferrals) totals.notReached.push(id);
                    else again.push(id);
                }
                queue = [...again, ...queue];
            }
            setSummary({ totals, complete: true });
        } catch (caught) {
            if (signal.aborted || (caught as Error)?.name === "AbortError") return;
            if (caught instanceof ApiError && caught.status === 401) return signOut();
            setStopped({ ...stopMessage(caught, batch), pending: queue });
            setSummary({ totals, complete: false });
        } finally {
            if (!signal.aborted) {
                setRunning(false);
                setProgress(null);
                runRef.current = null;
                jobs.reload();
                onExtracted();
            }
        }
    };

    const confirm = () => {
        setConfirming(false);
        if (preview) void run(preview, preview.candidates.map((c) => c.passportId), emptyTotals());
    };

    return (
        <Card className="space-y-4 p-5">
            <SectionHeading title="Extract" description="Choose a job, review the candidates ready for extraction, then confirm." />

            {jobs.status === "error" && <ErrorState message={jobs.error.message} onRetry={jobs.reload} />}
            {jobs.status === "loading" && !jobs.data && <LoadingState label="Loading jobs…" />}
            {jobs.data && list.length === 0 && (
                <EmptyState title="No jobs to extract" description="Jobs with completed visa submissions will appear here." />
            )}
            {jobs.data && list.length > 0 && (
                <JobTable jobs={list} selectedId={selectedId} disabled={busy} onSelect={(id) => { setSelectedId(id); setPreview(null); setPreviewError(null); setSummary(null); setStopped(null); }} />
            )}

            {list.length > 0 && (
                <div className="flex flex-wrap items-center gap-3">
                    <button type="button" onClick={loadPreview} disabled={!selected || busy || selected.eligibleCount === 0} className={`${primaryButton} inline-flex items-center gap-1.5`}>
                        <Icon name="visa_submission" className="size-4" />
                        {loadingPreview ? "Loading…" : running ? "Extracting…" : "Extract Completed Candidates"}
                    </button>
                    {!selected && <span className="text-body-sm text-ink-muted">Choose a job first.</span>}
                    {selected && selected.eligibleCount === 0 && !running && (
                        <span className="text-body-sm text-ink-muted">Nothing eligible to extract for {jobLabel(selected)}.</span>
                    )}
                </div>
            )}

            {previewError && <p role="alert" className="text-body-sm text-critical">{previewError}</p>}

            {preview && preview.candidates.length === 0 && !running && !summary && (
                <div role="status" className="rounded-lg border border-border bg-canvas px-3 py-2 text-body-sm text-ink-soft">
                    <p className="font-medium text-ink">Nothing to extract for {jobLabel(preview.job)}.</p>
                    <SkipList title="Left out" items={preview.skipped} />
                </div>
            )}

            {running && progress && (
                <div role="status" className="rounded-lg border border-review-border bg-review-bg px-3 py-2 text-body-sm text-review">
                    <p className="font-medium">Batch {progress.batch} of {progress.batches}</p>
                    <p>Extracted {progress.extracted} · Skipped {progress.skipped} · Failed {progress.failed} so far</p>
                    {progress.busyAttempt !== null && (
                        <p>Another extraction is in progress. Retrying in a few seconds (attempt {progress.busyAttempt + 1} of {EXTRACTION_RETRY.maxAttempts})…</p>
                    )}
                    <p className="font-medium">Do not close this tab until the extraction finishes.</p>
                </div>
            )}

            {stopped && (
                <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-critical-border bg-critical-bg px-3 py-2 text-body-sm text-critical">
                    <p className="min-w-0 flex-1">{stopped.message}</p>
                    {stopped.retryable && preview && stopped.pending.length > 0 && (
                        <button type="button" disabled={running} onClick={() => void run(preview, stopped.pending, summary?.totals ?? emptyTotals())} className={secondaryButton}>
                            Retry
                        </button>
                    )}
                </div>
            )}

            {summary && !running && <ResultSummary totals={summary.totals} complete={summary.complete} warnings={preview?.skipped ?? []} />}

            {confirming && preview && (
                <ConfirmDialog
                    title={`Extract ${preview.candidates.length} ${preview.candidates.length === 1 ? "candidate" : "candidates"}?`}
                    confirmLabel="Extract"
                    onConfirm={confirm}
                    onCancel={() => setConfirming(false)}
                >
                    <PreviewDetails preview={preview} />
                </ConfirmDialog>
            )}
        </Card>
    );
}

function JobTable({ jobs, selectedId, disabled, onSelect }: { jobs: ExtractionJobSummary[]; selectedId: string | null; disabled: boolean; onSelect: (jobId: string) => void }) {
    return (
        <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0">
                <caption className="sr-only">Jobs</caption>
                <thead>
                    <tr>
                        <th scope="col" className={tableHead}><span className="sr-only">Select</span></th>
                        {["Job", "Client", "Primary trade", "Eligible"].map((h) => <th key={h} scope="col" className={tableHead}>{h}</th>)}
                    </tr>
                </thead>
                <tbody>
                    {jobs.map((job) => (
                        <tr key={job.jobId} className={tableRow} data-testid="extraction-job">
                            <td className={`${tableCell} w-10`}>
                                <input
                                    type="radio"
                                    name="visa-extraction-job"
                                    aria-label={`Select job ${jobLabel(job)}`}
                                    checked={selectedId === job.jobId}
                                    disabled={disabled}
                                    onChange={() => onSelect(job.jobId)}
                                />
                            </td>
                            <td className={`${tableCell} font-medium text-ink`}>{jobLabel(job)}</td>
                            <td className={tableCell}>{job.client?.name ?? "—"}</td>
                            <td className={tableCell}>{job.primaryTrade ?? "—"}</td>
                            <td className={`${tableCell} tabular-nums`}>{formatNumber(job.eligibleCount)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function SkipList({ title, items }: { title: string; items: ExtractionSkip[] }) {
    if (items.length === 0) return null;
    return (
        <div className="mt-2">
            <p className="text-label-md text-ink">{title} ({items.length})</p>
            <ul aria-label={title} className="mt-1 max-h-40 list-disc overflow-y-auto pl-5">
                {items.map((item) => <li key={`${item.passportId}:${item.reason}`}>{item.passportId}: {item.message}</li>)}
            </ul>
        </div>
    );
}

function PreviewDetails({ preview }: { preview: ExtractionPreview }) {
    return (
        <div className="space-y-2">
            <p>Job <strong>{jobLabel(preview.job)}</strong>{preview.job.client ? ` · ${preview.job.client.name}` : ""}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-ink-muted">Folder</dt><dd className="[overflow-wrap:anywhere]">{preview.folder}</dd>
                <dt className="text-ink-muted">Excel files</dt>
                <dd className="[overflow-wrap:anywhere]">{preview.files.candidateDetails}<br />{preview.files.extraDetails}</dd>
            </dl>
            <div>
                <p className="text-label-md text-ink">Candidates, in order ({preview.candidates.length})</p>
                <ol aria-label="Candidates to extract" className="mt-1 max-h-40 list-decimal overflow-y-auto pl-5">
                    {preview.candidates.map((c) => <li key={c.passportId}>{c.passportId} · {candidateName(c)}</li>)}
                </ol>
            </div>
            <SkipList title="Left out" items={preview.skipped} />
        </div>
    );
}

function ResultSummary({ totals, complete, warnings }: { totals: Totals; complete: boolean; warnings: ExtractionSkip[] }) {
    return (
        <div role="region" aria-label="Extraction result" className="space-y-2 rounded-lg border border-border bg-canvas px-3 py-3 text-body-sm text-ink-soft">
            <p className="font-medium text-ink">{complete ? "Extraction finished." : "Extraction stopped before the end."}</p>
            <p>Extracted {totals.extracted.length} · Skipped {totals.skipped.length} · Failed {totals.failed.length}</p>
            {totals.failed.length > 0 && (
                <div>
                    <p className="text-label-md text-critical">Failed ({totals.failed.length})</p>
                    <ul aria-label="Failed" className="mt-1 list-disc pl-5">
                        {totals.failed.map((item) => <li key={item.passportId}>{item.passportId}: {failedReason(item.reason)}</li>)}
                    </ul>
                </div>
            )}
            <SkipList title="Skipped" items={totals.skipped} />
            {totals.notReached.length > 0 && (
                <p>Not reached this time (extract this job again to include them): {totals.notReached.join(", ")}</p>
            )}
            <SkipList title="Warnings" items={warnings} />
        </div>
    );
}

// ---------------------------------------------------------------- Files

function browseError(error: ApiError): { message: string; back: boolean } {
    if (error.code === "FOLDER_NOT_FOUND") return { message: "This folder no longer exists.", back: true };
    if (error.code === "INVALID_PATH") return { message: "This folder can't be opened.", back: true };
    if (error.code === "STORAGE_UNAVAILABLE" || error.status === 502) return { message: STORAGE_UNAVAILABLE_MESSAGE, back: false };
    return { message: error.message, back: false };
}

function downloadError(caught: unknown, zip: boolean): string {
    if (!(caught instanceof ApiError)) return "The download failed. Please try again.";
    if (caught.code === "ZIP_TOO_LARGE" || caught.status === 413) return ZIP_TOO_LARGE_MESSAGE;
    if (caught.code === "FILE_NOT_FOUND") return "This file no longer exists.";
    if (caught.code === "FOLDER_NOT_FOUND") return "This folder no longer exists.";
    if (caught.code === "STORAGE_UNAVAILABLE" || caught.status === 502) return STORAGE_UNAVAILABLE_MESSAGE;
    return caught.message || (zip ? "The ZIP could not be downloaded." : "The file could not be downloaded.");
}

function FilesSection({ version }: { version: number }) {
    const { token, signOut } = useAuth();
    // Relative to VISA SUBMISSION/, "" for the root. Only ever set from what the server listed.
    const [path, setPath] = useState("");
    const folder = useAdminResource(`visa-storage:${version}:${path}`, (t, signal) => browseVisaStorage(t, path, signal));
    const [downloading, setDownloading] = useState<string | null>(null);
    const [downloadMessage, setDownloadMessage] = useState<{ error: boolean; text: string } | null>(null);

    const data = folder.status === "success" ? folder.data : null;
    const segments = path ? path.split("/") : [];
    const open = (next: string) => {
        setDownloadMessage(null);
        setPath(next);
    };

    const download = async (target: string, zip: boolean, fallbackName: string) => {
        if (!token || downloading) return;
        setDownloading(target);
        setDownloadMessage(null);
        try {
            const { blob, filename } = await (zip ? downloadVisaStorageZip(token, target) : downloadVisaStorageFile(token, target));
            const name = filename ?? fallbackName;
            saveFile(blob, name);
            setDownloadMessage({ error: false, text: `Downloaded ${name}` });
        } catch (caught) {
            if (caught instanceof ApiError && caught.status === 401) return signOut();
            setDownloadMessage({ error: true, text: downloadError(caught, zip) });
            if (caught instanceof ApiError && (caught.code === "FILE_NOT_FOUND" || caught.code === "FOLDER_NOT_FOUND")) folder.reload();
        } finally {
            setDownloading(null);
        }
    };

    // Folders first; otherwise the server's order.
    const entries: StorageEntry[] = data ? [...data.entries.filter((e) => e.type === "folder"), ...data.entries.filter((e) => e.type !== "folder")] : [];
    const childPath = (name: string) => (data && data.path ? `${data.path}/${name}` : name);

    return (
        <Card className="space-y-4 p-5">
            <SectionHeading
                title="Files"
                description="The extracted files, by date. Downloads go through the server and are recorded in the audit log."
                action={path ? (
                    <button
                        type="button"
                        onClick={() => void download(path, true, `${segments.join(" - ")}.zip`)}
                        disabled={downloading !== null || !data}
                        className={`${secondaryButton} inline-flex shrink-0 items-center gap-1.5`}
                    >
                        <Icon name="folder_zip" className="size-4" />{downloading === path ? "Preparing…" : "Download ZIP"}
                    </button>
                ) : undefined}
            />

            <nav aria-label="Folder path">
                <ol className="flex flex-wrap items-center gap-2 text-body-sm text-ink-subtle">
                    {["VISA SUBMISSION", ...segments].map((label, index) => {
                        const last = index === segments.length;
                        const target = segments.slice(0, index).join("/");
                        return (
                            <li key={`${index}:${label}`} className="flex items-center gap-2">
                                {index > 0 && <span aria-hidden="true">/</span>}
                                {last ? (
                                    <span className="font-medium text-ink" aria-current="page">{label}</span>
                                ) : (
                                    <button type="button" onClick={() => open(target)} className="text-primary hover:underline">{label}</button>
                                )}
                            </li>
                        );
                    })}
                </ol>
            </nav>

            {downloadMessage && (
                downloadMessage.error
                    ? <p role="alert" className="text-body-sm text-critical">{downloadMessage.text}</p>
                    : <p role="status" className="inline-flex items-center gap-1 text-body-sm text-verified"><Icon name="check" className="size-3.5" />{downloadMessage.text}</p>
            )}

            {folder.status === "loading" && <LoadingState label="Loading files…" />}
            {folder.status === "error" && (() => {
                const { message, back } = browseError(folder.error);
                return back && path
                    ? (
                        <div role="alert" className="flex flex-col items-center gap-3 py-8 text-center">
                            <p className="text-body-sm text-ink-soft">{message}</p>
                            <button type="button" onClick={() => open("")} className={secondaryButton}>Back to VISA SUBMISSION</button>
                        </div>
                    )
                    : <ErrorState message={message} onRetry={folder.reload} />;
            })()}
            {data && entries.length === 0 && (
                <EmptyState title={path ? "This folder is empty" : "No visa submissions yet"} description={path ? undefined : "Extracted files will appear here, in a folder for each day."} />
            )}
            {data && entries.length > 0 && (
                <div className="overflow-x-auto">
                    <table className="w-full border-separate border-spacing-0">
                        <caption className="sr-only">Files in {["VISA SUBMISSION", ...segments].join(" / ")}</caption>
                        <thead>
                            <tr>
                                {["Name", "Size", "Updated"].map((h) => <th key={h} scope="col" className={tableHead}>{h}</th>)}
                                <th scope="col" className={tableHead}><span className="sr-only">Actions</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            {entries.map((entry) => {
                                const target = childPath(entry.name);
                                return (
                                    <tr key={`${entry.type}:${entry.name}`} className={tableRow} data-testid="storage-entry">
                                        <td className={`${tableCell} text-ink`}>
                                            {entry.type === "folder" ? (
                                                <button type="button" onClick={() => open(target)} className="inline-flex items-center gap-2 font-medium text-primary hover:underline">
                                                    <Icon name="folder" className="size-4" />{entry.name}
                                                </button>
                                            ) : (
                                                <span className="inline-flex items-center gap-2"><Icon name="description" className="size-4 text-ink-muted" />{entry.name}</span>
                                            )}
                                        </td>
                                        <td className={`${tableCell} tabular-nums text-ink-soft`}>{entry.type === "file" ? formatFileSize(entry.size) : "—"}</td>
                                        <td className={`${tableCell} tabular-nums text-ink-soft`}>{entry.updatedAt ? formatDateTime(entry.updatedAt) : "—"}</td>
                                        <td className={`${tableCell} text-right`}>
                                            {entry.type === "file" && (
                                                <button
                                                    type="button"
                                                    aria-label={`Download ${entry.name}`}
                                                    onClick={() => void download(target, false, entry.name)}
                                                    disabled={downloading !== null}
                                                    className={`${secondaryButton} inline-flex items-center gap-1.5`}
                                                >
                                                    <Icon name="download" className="size-4" />{downloading === target ? "Downloading…" : "Download"}
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
            {data?.truncated && (
                <p role="note" className="text-body-sm text-ink-muted">Only the first {formatNumber(data.entries.length)} entries of this folder are shown.</p>
            )}
        </Card>
    );
}
