import { useEffect, useId, useState, type ReactNode } from "react";
import { Navigate, NavLink, Outlet } from "react-router";
import { ApiError } from "../api/client";
import { getSheetSyncStatus, requestConnectionTest, requestSyncNow, setSyncDestination, type SheetSyncRun, type SheetSyncStatus } from "../api/sheetSync";
import { useAdminResource } from "../api/useAdminResource";
import { canImportCandidates, canOpenSheetSync, isAdmin, useAuth } from "../auth/AuthProvider";
import { hasRole, type Role } from "../auth/roles";
import { CandidateImportDialog } from "../components/CandidateImportDialog";
import { primaryButton, secondaryButton } from "../components/Dialog";
import { formatDateTime, formatNumber, humanize } from "../components/format";
import { inputClass } from "../components/ui";
import { Icon } from "../components/Icon";
import { Card, ErrorState, LoadingState, SectionHeading } from "../components/States";
import { ToneBadge, type Tone } from "../components/StatusBadge";
import { SETTINGS_TABS } from "../layout/navigation";

// While a run is queued or running, the status is refreshed this often.
export const ACTIVE_RUN_POLL_MS = 5_000;

// Settings (/admin/settings). ADMIN: every tab. MANAGER: the Google Sheet
// Sync tab only (its status and Update Sheet). Other roles see an "Access
// Restricted" card and no Settings data is requested. The backend enforces
// the same rules on every Settings API route (requireRole); this page only
// mirrors them.
//
// A row of tabs, one URL each (so reload, Back and Forward keep the tab):
//   /settings/roles       Change Roles  (AdminRolesPage, unchanged)        ADMIN
//   /settings/invite      Invite User   (InvitationsPage, unchanged)      ADMIN
//   /settings/sheet-sync  Google Sheet Sync                              ADMIN, MANAGER
//   /settings/job-types   Job Types     (JobTypesSettings)               ADMIN
// /settings opens the first tab the user may open (App.tsx, SettingsIndex).
// The old /roles and /invitations URLs redirect here.
// The tabs themselves are listed in layout/navigation.ts (the breadcrumb names them too).
export { SETTINGS_TABS };

const tabClass = ({ isActive }: { isActive: boolean }) =>
    `-mb-px whitespace-nowrap border-b-2 px-1 pb-2.5 pt-1 text-label-md transition-colors ${isActive
        ? "border-primary font-medium text-ink"
        : "border-transparent text-ink-muted hover:border-border-strong hover:text-ink"}`;

function AccessRestricted({ children }: { children: ReactNode }) {
    return (
        <div className="mx-auto max-w-4xl p-6">
            <div className="rounded border border-critical-border bg-critical-bg p-6 text-center text-critical">
                <Icon name="lock" className="mx-auto mb-2 size-8 text-critical" />
                <h2 className="text-headline-sm font-semibold">Access Restricted</h2>
                <p className="mt-1 text-body-sm text-ink-muted">{children}</p>
            </div>
        </div>
    );
}

export function SettingsPage() {
    const { user } = useAuth();
    if (!canOpenSheetSync(user)) {
        return <AccessRestricted>Only administrators with the <strong>ADMIN</strong> role can open Settings.</AccessRestricted>;
    }
    const tabs = SETTINGS_TABS.filter((tab) => hasRole(user, tab.roles));
    return (
        <section aria-labelledby="page-title" className="mx-auto max-w-6xl space-y-5">
            <div>
                <h1 id="page-title" className="text-headline-lg text-ink">Settings</h1>
                <p className="mt-1 text-body-sm text-ink-muted">System configuration and integrations.</p>
            </div>
            <nav aria-label="Settings sections" className="flex gap-6 overflow-x-auto border-b border-border">
                {tabs.map((tab) => (
                    <NavLink key={tab.to} to={tab.to} className={tabClass}>
                        {tab.label}
                    </NavLink>
                ))}
            </nav>
            <Outlet />
        </section>
    );
}

// /settings: the first tab this user may open.
export function SettingsIndex() {
    const { user } = useAuth();
    const first = SETTINGS_TABS.find((tab) => hasRole(user, tab.roles));
    return <Navigate to={first?.to ?? "/settings/roles"} replace />;
}

// A tab opened by URL by a role it is not for (a MANAGER on an ADMIN-only tab): nothing of it is rendered or requested.
export function SettingsTab({ roles, children }: { roles: readonly Role[]; children: ReactNode }) {
    const { user } = useAuth();
    if (!hasRole(user, roles)) return <AccessRestricted>Only administrators with the <strong>ADMIN</strong> role can open this section.</AccessRestricted>;
    return <>{children}</>;
}

// Sync Destination: which configured Google Sheet the mirror writes to. Only
// the Sheets configured on the sheet-sync worker are listed (never a full
// spreadsheet ID). Choosing another asks the worker to check its access and
// headers; it becomes the destination of every run (scheduled, Sync Now,
// Test Connection) only if that check passes, otherwise the current one
// stays. Switching is ADMIN only; a MANAGER sees the destination read-only.
function SyncDestinationSection({ status, onChanged }: { status: SheetSyncStatus; onChanged: () => void }) {
    const { token, user } = useAuth();
    const canSwitch = isAdmin(user);
    const [selected, setSelected] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
    const info = status.destination;
    const available = info?.available ?? [];

    // An older server, or nothing published yet: the target hint as before.
    if (!info || available.length === 0 || !canSwitch) {
        const current = info ? available.find((d) => d.key === info.activeKey) ?? null : null;
        if (current) {
            return (
                <Group title="Sync destination">
                    <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
                        <Fact label="Currently syncing to">{current.name}</Fact>
                        <Fact label="Spreadsheet ID"><span className="tabular-nums">{current.hint ?? "—"}</span></Fact>
                        <Fact label="Tab">{current.tabName ?? "—"}</Fact>
                    </dl>
                </Group>
            );
        }
        return (
            <Group title="Sync destination">
                <dl>
                    <Fact label="Spreadsheet">{status.target ?? (status.configured === false ? "Not configured" : "—")}</Fact>
                </dl>
            </Group>
        );
    }

    const nameOf = (key: string | null | undefined) => available.find((d) => d.key === key)?.name ?? key ?? "—";
    const active = available.find((d) => d.key === info.activeKey) ?? null;
    const pending = info.requestedKey;
    const choice = selected ?? info.activeKey ?? available[0].key;
    const testRunning = Boolean(status.activeRuns.testConnection);
    const lastSwitch = info.lastSwitch;
    const switchFailed = !pending && lastSwitch?.status === "FAILED";

    async function requestSwitch() {
        if (!token || busy || !choice) return;
        setBusy(true);
        setMessage(null);
        try {
            const result = await setSyncDestination(token, choice);
            setMessage(result.status === "PENDING"
                ? { tone: "ok", text: `Checking access and headers of ${nameOf(choice)}. It becomes the destination once the check passes.` }
                : { tone: "ok", text: `${nameOf(choice)} is already the destination.` });
            setSelected(null);
            onChanged();
        } catch (error) {
            setMessage({ tone: "error", text: error instanceof ApiError ? error.message : "The destination could not be changed." });
        } finally {
            setBusy(false);
        }
    }

    return (
        <Group title="Sync destination">
            <div className="space-y-4">
                <div className="flex flex-wrap items-end gap-3">
                    <label className="min-w-0 flex-1 sm:max-w-md">
                        <span className="text-label-md text-ink-muted">Google Sheet</span>
                        <select
                            aria-label="Google Sheet"
                            value={choice}
                            disabled={busy || Boolean(pending)}
                            onChange={(event) => { setSelected(event.target.value); setMessage(null); }}
                            className={inputClass(false, { extra: "mt-1 w-full" })}
                        >
                            {available.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
                        </select>
                    </label>
                    {choice !== info.activeKey && !pending && (
                        <button type="button" className={secondaryButton} disabled={busy || testRunning} onClick={requestSwitch}>
                            {busy ? "Requesting…" : "Use this destination"}
                        </button>
                    )}
                </div>

                {message && (
                    <p role={message.tone === "error" ? "alert" : "status"} className={`text-body-sm ${message.tone === "error" ? "text-critical" : "text-ink-muted"}`}>{message.text}</p>
                )}
                {pending && (
                    <p role="status" className="rounded border border-review-border bg-review-bg px-3 py-2 text-body-sm text-review">
                        Checking access and headers of {nameOf(pending)}… {active ? `${active.name} stays the destination until the check passes.` : ""}
                    </p>
                )}
                {switchFailed && lastSwitch && (
                    <p role="alert" className="text-body-sm text-critical">
                        Could not switch to {nameOf(lastSwitch.destinationKey)}: {failureText(lastSwitch.errorClass, lastSwitch.errorCode)}{lastSwitch.finishedAt ? ` (${formatDateTime(lastSwitch.finishedAt)})` : ""}. {active ? `Still syncing to ${active.name}.` : ""}
                    </p>
                )}

                <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
                    <Fact label="Currently syncing to">{active?.name ?? "Not configured"}</Fact>
                    <Fact label="Spreadsheet ID"><span className="tabular-nums">{active?.hint ?? "—"}</span></Fact>
                    <Fact label="Tab">{active?.tabName ?? "—"}</Fact>
                </dl>
            </div>
        </Group>
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

export const UPDATE_SHEET_HINT = "Upload an existing candidate sheet to validate and import candidate records into Emlynk, then sync them to the Candidate Operational Mirror.";

// "Update Sheet" with its hint on hover and keyboard focus (the hint is the button's description).
function UpdateSheetButton({ onClick }: { onClick: () => void }) {
    const hintId = useId();
    const [open, setOpen] = useState(false);
    return (
        <span className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
            <button type="button" className={secondaryButton} aria-describedby={hintId} onClick={onClick} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
                Update Sheet
            </button>
            <span
                role="tooltip"
                id={hintId}
                className={`${open ? "" : "sr-only"} absolute right-0 top-full z-30 mt-1.5 w-72 max-w-[calc(100vw-3rem)] rounded-md border border-border bg-surface px-3 py-2 text-body-sm font-normal text-ink shadow-popover`}
            >
                {UPDATE_SHEET_HINT}
            </span>
        </span>
    );
}

function GoogleSheetSyncSection() {
    const { token, user } = useAuth();
    const status = useAdminResource<SheetSyncStatus>("sheet-sync-status", (t, signal) => getSheetSyncStatus(t, signal));
    const [pending, setPending] = useState<"test" | "run" | null>(null);
    const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
    const [importing, setImporting] = useState(false);
    const admin = isAdmin(user);

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
                        {canImportCandidates(user) && <UpdateSheetButton onClick={() => setImporting(true)} />}
                        {admin && (
                            <>
                                <button type="button" className={secondaryButton} disabled={pending !== null || Boolean(data?.activeRuns.testConnection)} onClick={() => act("test")}>
                                    {pending === "test" ? "Requesting…" : "Test Connection"}
                                </button>
                                <button type="button" className={primaryButton} disabled={pending !== null || Boolean(data?.activeRuns.reconcile)} onClick={() => act("run")}>
                                    {pending === "run" ? "Requesting…" : "Sync Now"}
                                </button>
                            </>
                        )}
                    </div>
                }
            />
            {importing && <CandidateImportDialog onClose={() => { setImporting(false); reload(); }} />}

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

                    <SyncDestinationSection status={data} onChanged={reload} />

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
