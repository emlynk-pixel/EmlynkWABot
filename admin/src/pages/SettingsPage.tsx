import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router";
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
// mirrors it.
//
// A row of tabs, one URL each (so reload, Back and Forward keep the tab):
//   /settings/roles       Change Roles  (AdminRolesPage, unchanged)
//   /settings/invite      Invite User   (InvitationsPage, unchanged)
//   /settings/sheet-sync  Google Sheet Sync
// /settings opens the first tab (App.tsx). Every tab is ADMIN only, like the
// pages it holds. The old /roles and /invitations URLs redirect here.
export const SETTINGS_TABS = [
    { to: "/settings/roles", label: "Change Roles" },
    { to: "/settings/invite", label: "Invite User" },
    { to: "/settings/sheet-sync", label: "Google Sheet Sync" },
] as const;

const tabClass = ({ isActive }: { isActive: boolean }) =>
    `-mb-px whitespace-nowrap border-b-2 px-1 pb-2.5 pt-1 text-label-md transition-colors ${isActive
        ? "border-primary font-medium text-ink"
        : "border-transparent text-ink-muted hover:border-border-strong hover:text-ink"}`;

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
            <nav aria-label="Settings sections" className="flex gap-6 overflow-x-auto border-b border-border">
                {SETTINGS_TABS.map((tab) => (
                    <NavLink key={tab.to} to={tab.to} className={tabClass}>
                        {tab.label}
                    </NavLink>
                ))}
            </nav>
            <Outlet />
        </section>
    );
}

// Google Sheet Sync tab: the sync status and actions.
export function SheetSyncSettings() {
    return <GoogleSheetSyncSection />;
}

const RUN_TONES: Record<string, Tone> = { QUEUED: "pending", RUNNING: "review", SUCCEEDED: "verified", FAILED: "critical", SKIPPED: "pending" };

function RunBadge({ run }: { run: SheetSyncRun }) {
    return <ToneBadge tone={RUN_TONES[run.status] ?? "pending"}>{humanize(run.status)}{run.dryRun ? " (dry run)" : ""}</ToneBadge>;
}

// Who started a run, from its stored trigger (never from its time): Cloud
// Scheduler = Scheduled; Sync Now or the operator command = Manual.
export function triggerLabel(trigger: SheetSyncRun["trigger"]): "Scheduled" | "Manual" {
    return trigger === "SCHEDULER" ? "Scheduled" : "Manual";
}

function SourceBadge({ run }: { run: SheetSyncRun }) {
    return (
        <span
            title={run.trigger === "OPERATOR" ? "Requested with the operator command" : run.trigger === "ADMIN" ? "Requested with Sync Now" : "Run by the automatic schedule"}
            className="inline-flex h-[22px] items-center whitespace-nowrap rounded-full border border-border-strong px-2 text-label-sm text-ink-muted"
        >
            {triggerLabel(run.trigger)}
        </span>
    );
}

// A titled group inside the card, separated by a hairline.
function Group({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
    return (
        <section className="border-t border-border pt-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 className="text-label-caps uppercase text-ink-subtle">{title}</h3>
                {aside}
            </div>
            {children}
        </section>
    );
}

// A label over its value, in a grid of facts.
function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="min-w-0">
            <dt className="text-label-md text-ink-muted">{label}</dt>
            <dd className="mt-1 break-words text-body-sm text-ink">{children}</dd>
        </div>
    );
}

// A small tile for the status summary.
function StatusTile({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="min-w-0 rounded-md border border-border bg-canvas px-4 py-3">
            <dt className="text-label-md text-ink-muted">{label}</dt>
            <dd className="mt-1.5">{children}</dd>
        </div>
    );
}

// When a successful reconciliation finished, with where it came from.
function SyncTime({ run }: { run: SheetSyncRun | null | undefined }) {
    if (!run) return <span className="text-ink-muted">Not yet run</span>;
    return (
        <span className="inline-flex flex-wrap items-center gap-2">
            <span className="tabular-nums">{formatDateTime(run.finishedAt)}</span>
            <SourceBadge run={run} />
            {run.dryRun && <span className="text-label-sm text-ink-muted">dry run</span>}
        </span>
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

// The configured automatic schedule (fixed; Cloud Scheduler runs it). The
// server reports it; these are its values if an older server does not.
const DEFAULT_SCHEDULE = { times: ["06:00", "12:00", "18:00"], timeZone: "Asia/Colombo" };

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

    const schedule = data?.schedule ?? DEFAULT_SCHEDULE;
    const connection = data ? connectionText(data) : null;
    const integration = data ? INTEGRATION[data.integration.state] : null;

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

            {data && connection && integration && (
                <div className="mt-4 space-y-5">
                    {status.status === "error" && (
                        <p role="alert" className="text-body-sm text-critical">The status could not be refreshed: {status.error.message}</p>
                    )}
                    {!data.worker.online && (
                        <div role="alert" className="rounded border border-review-border bg-review-bg px-4 py-3 text-body-sm text-review">
                            The sheet-sync worker is not reporting{data.worker.lastHeartbeatAt ? ` (last seen ${formatDateTime(data.worker.lastHeartbeatAt)})` : ""}. Requests stay queued until it runs.
                        </div>
                    )}

                    <dl aria-label="Status summary" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <StatusTile label="Connection"><ToneBadge tone={connection.tone}>{connection.label}</ToneBadge></StatusTile>
                        <StatusTile label="Integration state"><ToneBadge tone={integration.tone}>{integration.label}</ToneBadge></StatusTile>
                        <StatusTile label="Write sync">
                            <ToneBadge tone={data.writeGate === "ENABLED" ? "verified" : "pending"}>{data.writeGate === "ENABLED" ? "Enabled" : data.writeGate === "DISABLED" ? "Disabled" : "Unknown"}</ToneBadge>
                        </StatusTile>
                    </dl>
                    {data.writeGate === "DISABLED" && (
                        <p className="text-body-sm text-ink-muted">
                            Write sync is disabled: nothing is written to the Sheet. Sync Now runs a dry run that compares the Sheet with the database and reports what it would change.
                        </p>
                    )}

                    <Group
                        title="Sync activity"
                        aside={
                            <p className="text-label-sm text-ink-muted">
                                Automatic schedule <span className="tabular-nums text-ink-soft">{schedule.times.join(" · ")}</span> ({schedule.timeZone})
                            </p>
                        }
                    >
                        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                            <Fact label="Last automatic sync"><SyncTime run={data.lastAutomaticSync} /></Fact>
                            <Fact label="Last manual sync"><SyncTime run={data.lastManualSync} /></Fact>
                            <Fact label="Latest sync"><SyncTime run={data.lastSuccessfulReconciliation} /></Fact>
                            <Fact label="Last written to the Sheet"><span className="tabular-nums">{formatDateTime(data.lastSuccessfulSyncAt)}</span></Fact>
                            <Fact label="Pending / failed candidate syncs"><span className="tabular-nums">{formatNumber(data.queue.pending + data.queue.processing)} / {formatNumber(data.queue.failed)}</span></Fact>
                            {(data.activeRuns.reconcile || data.activeRuns.testConnection) && (
                                <Fact label="In progress">
                                    <span className="inline-flex flex-wrap items-center gap-2">
                                        {data.activeRuns.reconcile && <>Sync <RunBadge run={data.activeRuns.reconcile} /></>}
                                        {data.activeRuns.testConnection && <>Connection test <RunBadge run={data.activeRuns.testConnection} /></>}
                                    </span>
                                </Fact>
                            )}
                        </dl>
                    </Group>

                    <Group title="Target">
                        <dl>
                            <Fact label="Spreadsheet">{data.target ?? (data.configured === false ? "Not configured" : "—")}</Fact>
                        </dl>
                    </Group>

                    <Group title="Last reconciliation">
                        {data.lastReconciliation ? (
                            <div className="space-y-1.5 text-body-sm">
                                <p className="flex flex-wrap items-center gap-2">
                                    <RunBadge run={data.lastReconciliation} />
                                    <SourceBadge run={data.lastReconciliation} />
                                    <span className="tabular-nums text-ink-soft">{formatDateTime(data.lastReconciliation.finishedAt)}</span>
                                </p>
                                {reconciliationSummary(data.lastReconciliation) && <p className="text-ink-muted">{reconciliationSummary(data.lastReconciliation)}</p>}
                                {data.lastReconciliation.errorClass && <p className="text-critical">{failureText(data.lastReconciliation.errorClass, data.lastReconciliation.errorCode)}</p>}
                            </div>
                        ) : <p className="text-body-sm text-ink-muted">Not yet run</p>}
                    </Group>

                    <Group title="Last failure">
                        {data.integration.lastErrorClass
                            ? <p className="text-body-sm text-critical">{failureText(data.integration.lastErrorClass, data.integration.lastErrorCode)} · {formatDateTime(data.integration.lastErrorAt)}</p>
                            : <p className="text-body-sm text-ink-muted">No recent failures</p>}
                    </Group>
                </div>
            )}
        </Card>
    );
}
