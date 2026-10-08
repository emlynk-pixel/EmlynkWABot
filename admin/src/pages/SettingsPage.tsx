import { useEffect, useState, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { getSheetSyncStatus, requestConnectionTest, requestSyncNow, type SheetSyncRun, type SheetSyncStatus } from "../api/sheetSync";
import { useAdminResource } from "../api/useAdminResource";
import { isAdmin, useAuth } from "../auth/AuthProvider";
import { primaryButton, secondaryButton } from "../components/Dialog";
import { formatDateTime, formatNumber, humanize } from "../components/format";
import { Icon } from "../components/Icon";
import { Card, ErrorState, LoadingState, SectionHeading } from "../components/States";
import { ToneBadge, type Tone } from "../components/StatusBadge";

// While a run is queued or running, the status is refreshed this often.
export const ACTIVE_RUN_POLL_MS = 5_000;

// Settings (/admin/settings). ADMIN only: other roles see an "Access
// Restricted" card and no Settings data is requested. The backend enforces
// the same rule on every Settings API route (requireRole); this page only
// mirrors it. Future system settings are added as further sections here.
export function SettingsPage() {
    const { user } = useAuth();
    if (!isAdmin(user)) {
        return (
            <div className="mx-auto max-w-4xl p-6">
                <div className="rounded border border-critical-border bg-critical-bg p-6 text-center text-critical">
                    <Icon name="lock" className="mx-auto mb-2 size-8 text-critical" />
                    <h2 className="text-headline-sm font-semibold">Access Restricted</h2>
                    <p className="mt-1 text-body-sm text-ink-muted">
                        Only administrators with the <strong>ADMIN</strong> role can open Settings.
                    </p>
                </div>
            </div>
        );
    }
    return (
        <section aria-labelledby="page-title" className="mx-auto max-w-6xl space-y-5">
            <div>
                <h1 id="page-title" className="text-headline-lg text-ink">Settings</h1>
                <p className="mt-1 text-body-sm text-ink-muted">System configuration and integrations.</p>
            </div>
            <GoogleSheetSyncSection />
        </section>
    );
}

const RUN_TONES: Record<string, Tone> = { QUEUED: "pending", RUNNING: "review", SUCCEEDED: "verified", FAILED: "critical", SKIPPED: "pending" };

function RunBadge({ run }: { run: SheetSyncRun }) {
    return <ToneBadge tone={RUN_TONES[run.status] ?? "pending"}>{humanize(run.status)}{run.dryRun ? " (dry run)" : ""}</ToneBadge>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-1 border-b border-border py-3 sm:flex-row sm:items-center sm:justify-between">
            <dt className="text-label-md text-ink-muted">{label}</dt>
            <dd className="text-body-sm text-ink sm:text-right">{children}</dd>
        </div>
    );
}

const count = (summary: SheetSyncRun["summary"], key: string) => (typeof summary?.[key] === "number" ? (summary[key] as number) : 0);

function reconciliationSummary(run: SheetSyncRun): string | null {
    if (!run.summary || run.status !== "SUCCEEDED") return null;
    const s = run.summary;
    const verb = run.dryRun ? "would be " : "";
    const parts = [
        `${formatNumber(count(s, "appended"))} ${verb}appended`,
        `${formatNumber(count(s, "updated"))} ${verb}updated`,
        `${formatNumber(count(s, "unchanged"))} unchanged`,
    ];
    if (count(s, "markedInactive")) parts.push(`${formatNumber(count(s, "markedInactive"))} ${verb}marked inactive`);
    if (s.deletionGuardTriggered) parts.push(`${formatNumber(count(s, "notInDatabase"))} not in database (deletion guard: left unchanged)`);
    return parts.join(" · ");
}

function failureText(errorClass: string | null, errorCode: string | null): string {
    if (!errorClass) return "—";
    return errorCode ? `${humanize(errorClass)} (${errorCode})` : humanize(errorClass);
}

function connectionText(status: SheetSyncStatus): { tone: Tone; label: string } {
    const test = status.lastConnectionTest;
    if (!test) return { tone: "pending", label: "Not tested yet" };
    const result = typeof test.summary?.status === "string" ? test.summary.status : null;
    const schema = typeof test.summary?.schema === "string" ? test.summary.schema : null;
    if (test.status === "SUCCEEDED") return { tone: "verified", label: "Connected · schema valid" };
    return { tone: "critical", label: [result && humanize(result), schema && humanize(schema)].filter(Boolean).join(" · ") || "Failed" };
}

const INTEGRATION: Record<SheetSyncStatus["integration"]["state"], { tone: Tone; label: string }> = {
    OK: { tone: "verified", label: "OK" },
    UNKNOWN: { tone: "pending", label: "Not checked yet" },
    CONFIG_ERROR: { tone: "critical", label: "Configuration error: sync halted" },
    DATA_INTEGRITY: { tone: "critical", label: "Duplicate candidate IDs in the Sheet: sync halted" },
};

function GoogleSheetSyncSection() {
    const { token } = useAuth();
    const status = useAdminResource<SheetSyncStatus>("sheet-sync-status", (t, signal) => getSheetSyncStatus(t, signal));
    const [pending, setPending] = useState<"test" | "run" | null>(null);
    const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

    const data = status.data;
    const active = Boolean(data?.activeRuns.reconcile || data?.activeRuns.testConnection);
    const { reload } = status;
    useEffect(() => {
        if (!active) return;
        const timer = setInterval(reload, ACTIVE_RUN_POLL_MS);
        return () => clearInterval(timer);
    }, [active, reload]);

    async function act(kind: "test" | "run") {
        if (!token) return;
        setPending(kind);
        setMessage(null);
        try {
            const { alreadyActive } = await (kind === "test" ? requestConnectionTest(token) : requestSyncNow(token));
            const what = kind === "test" ? "Connection test" : "Sync";
            setMessage({ tone: "ok", text: alreadyActive ? `${what} is already queued or running.` : `${what} requested. It runs in the background; you can leave this page.` });
            reload();
        } catch (error) {
            setMessage({ tone: "error", text: error instanceof ApiError ? error.message : "The request could not be sent." });
        } finally {
            setPending(null);
        }
    }

    return (
        <Card className="p-5">
            <SectionHeading
                title="Google Sheet Sync"
                description="One-way operational mirror of candidate data from the database to the Google Sheet. The database is the source of truth; edits in the Sheet are never read back."
                action={
                    <div className="flex shrink-0 flex-wrap gap-2">
                        <button type="button" className={secondaryButton} disabled={pending !== null || Boolean(data?.activeRuns.testConnection)} onClick={() => act("test")}>
                            {pending === "test" ? "Requesting…" : "Test Connection"}
                        </button>
                        <button type="button" className={primaryButton} disabled={pending !== null || Boolean(data?.activeRuns.reconcile)} onClick={() => act("run")}>
                            {pending === "run" ? "Requesting…" : "Sync Now"}
                        </button>
                    </div>
                }
            />

            {message && (
                <div role={message.tone === "error" ? "alert" : "status"} className={`mt-4 rounded border px-4 py-3 text-body-sm ${message.tone === "error" ? "border-critical-border bg-critical-bg text-critical" : "border-verified-border bg-verified-bg text-verified"}`}>
                    {message.text}
                </div>
            )}

            {status.status === "loading" && !data && <LoadingState label="Loading sync status…" />}
            {status.status === "error" && !data && <ErrorState message={status.error.message} onRetry={reload} />}

            {data && (
                <>
                    {status.status === "error" && (
                        <p role="alert" className="mt-4 text-body-sm text-critical">The status could not be refreshed: {status.error.message}</p>
                    )}
                    {!data.worker.online && (
                        <div role="alert" className="mt-4 rounded border border-review-border bg-review-bg px-4 py-3 text-body-sm text-review">
                            The sheet-sync worker is not reporting{data.worker.lastHeartbeatAt ? ` (last seen ${formatDateTime(data.worker.lastHeartbeatAt)})` : ""}. Requests stay queued until it runs.
                        </div>
                    )}
                    {data.writeGate === "DISABLED" && (
                        <p className="mt-4 text-body-sm text-ink-muted">
                            Write sync is disabled: nothing is written to the Sheet. Sync Now runs a dry run that compares the Sheet with the database and reports what it would change.
                        </p>
                    )}
                    <dl className="mt-2">
                        <Row label="Connection"><ToneBadge tone={connectionText(data).tone}>{connectionText(data).label}</ToneBadge></Row>
                        <Row label="Integration state"><ToneBadge tone={INTEGRATION[data.integration.state].tone}>{INTEGRATION[data.integration.state].label}</ToneBadge></Row>
                        <Row label="Write sync">
                            <ToneBadge tone={data.writeGate === "ENABLED" ? "verified" : "pending"}>{data.writeGate === "ENABLED" ? "Enabled" : data.writeGate === "DISABLED" ? "Disabled" : "Unknown"}</ToneBadge>
                        </Row>
                        <Row label="Target">{data.target ?? (data.configured === false ? "Not configured" : "—")}</Row>
                        <Row label="Last successful sync">{formatDateTime(data.lastSuccessfulSyncAt)}</Row>
                        <Row label="Last reconciliation">
                            {data.lastReconciliation ? (
                                <span className="inline-flex flex-col items-start gap-1 sm:items-end">
                                    <span className="inline-flex items-center gap-2"><RunBadge run={data.lastReconciliation} />{formatDateTime(data.lastReconciliation.finishedAt)}</span>
                                    {reconciliationSummary(data.lastReconciliation) && <span className="text-ink-muted">{reconciliationSummary(data.lastReconciliation)}</span>}
                                    {data.lastReconciliation.errorClass && <span className="text-critical">{failureText(data.lastReconciliation.errorClass, data.lastReconciliation.errorCode)}</span>}
                                </span>
                            ) : "—"}
                        </Row>
                        <Row label="Last successful reconciliation">{formatDateTime(data.lastSuccessfulReconciliationAt)}</Row>
                        {(data.activeRuns.reconcile || data.activeRuns.testConnection) && (
                            <Row label="In progress">
                                <span className="inline-flex flex-wrap items-center gap-2">
                                    {data.activeRuns.reconcile && <>Sync <RunBadge run={data.activeRuns.reconcile} /></>}
                                    {data.activeRuns.testConnection && <>Connection test <RunBadge run={data.activeRuns.testConnection} /></>}
                                </span>
                            </Row>
                        )}
                        <Row label="Pending / failed candidate syncs">{formatNumber(data.queue.pending + data.queue.processing)} / {formatNumber(data.queue.failed)}</Row>
                        <Row label="Last failure">
                            {data.integration.lastErrorClass ? `${failureText(data.integration.lastErrorClass, data.integration.lastErrorCode)} · ${formatDateTime(data.integration.lastErrorAt)}` : "—"}
                        </Row>
                    </dl>
                </>
            )}
        </Card>
    );
}
