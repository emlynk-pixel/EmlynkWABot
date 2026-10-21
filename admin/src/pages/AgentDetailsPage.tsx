import { useState } from "react";
import { Link, useParams } from "react-router";
import { getAgent, setAgentStatus, type AgentJobRow } from "../api/agents";
import { useAdminResource } from "../api/useAdminResource";
import { canManageMasterData, useAuth } from "../auth/AuthProvider";
import { formatDate } from "../components/format";
import { Detail, JobStatusBadge } from "../components/job/JobParts";
import { EntityStatusBadge, PageTabs, RestrictedPage, StatusDialog, countryName } from "../components/master/MasterParts";
import { Card, ErrorState, LoadingState } from "../components/States";
import { primaryButton, secondaryButton } from "../components/Dialog";
import { tableCell, tableHead, tableRow } from "../components/ui";
import { AgentFormDialog } from "./AgentsPage";

// Agent details, in horizontal tabs: Jobs (the default: the jobs whose responsible agent is
// this agent, by status, each listed once), Agent Details (its own data) and Clients (every
// client it works with). The tab is page state only; Edit (details and clients) and the
// status action sit above the tabs. Jobs link to the Job record; this page does not repeat
// Job Management.

type JobTab = "processing" | "completed" | "cancelled";
const JOB_TABS: { key: JobTab; label: string }[] = [
    { key: "processing", label: "Processing" },
    { key: "completed", label: "Completed" },
    { key: "cancelled", label: "Cancelled" },
];
type Section = "jobs" | "details" | "clients";

export function AgentDetailsPage() {
    const { user } = useAuth();
    if (!canManageMasterData(user)) return <RestrictedPage what="agents" />;
    return <AgentDetailsView />;
}

function AgentDetailsView() {
    const { agentId = "" } = useParams();
    const { token } = useAuth();
    const detail = useAdminResource(`agent:${agentId}`, (t, signal) => getAgent(t, agentId, signal));
    const [section, setSection] = useState<Section>("jobs");
    const [tab, setTab] = useState<JobTab>("processing");
    const [dialog, setDialog] = useState<"edit" | "status" | null>(null);

    if (detail.status === "loading" && !detail.data) return <LoadingState label="Loading agent…" />;
    if (detail.status === "error" && !detail.data) return <ErrorState message={detail.error.status === 404 ? "Agent not found." : detail.error.message} onRetry={detail.reload} />;
    const agent = detail.data;
    if (!agent || !token) return null;
    const done = () => {
        setDialog(null);
        detail.reload();
    };
    const counts: Record<JobTab, number> = { processing: agent.processingJobs, completed: agent.completedJobs, cancelled: agent.cancelledJobs };
    const rows: AgentJobRow[] = agent.jobs[tab];
    const totalJobs = counts.processing + counts.completed + counts.cancelled;

    return (
        <section aria-labelledby="page-title" className="mx-auto max-w-6xl space-y-4">
            <nav aria-label="Breadcrumb" className="text-body-sm text-ink-muted"><Link to="/agents" className="text-primary hover:underline">Agents</Link> / {agent.name}</nav>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                    <h1 id="page-title" className="text-headline-lg text-ink">{agent.name}</h1>
                    <EntityStatusBadge status={agent.status} />
                </div>
                <div className="flex gap-2">
                    <button type="button" onClick={() => setDialog("edit")} className={secondaryButton}>Edit</button>
                    <button type="button" onClick={() => setDialog("status")} className={primaryButton}>{agent.status === "ACTIVE" ? "Make inactive" : "Activate"}</button>
                </div>
            </div>

            <PageTabs
                label="Agent sections" idPrefix="agent" value={section} onChange={setSection}
                tabs={[
                    { key: "jobs", label: `Jobs (${totalJobs})` },
                    { key: "details", label: "Agent Details" },
                    { key: "clients", label: `Clients (${agent.clients.length})` },
                ]}
            />

            {section === "jobs" && (
                <div role="tabpanel" id="agent-panel-jobs" aria-labelledby="agent-tab-jobs">
                    <Card>
                        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                            <h2 className="text-title-sm text-ink">Jobs</h2>
                            <div role="tablist" aria-label="Job status" className="flex flex-wrap gap-1">
                                {JOB_TABS.map((t) => (
                                    <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
                                        className={`h-8 rounded px-3 text-label-md ${tab === t.key ? "bg-primary text-on-primary" : "text-ink-soft hover:bg-canvas"}`}>
                                        {t.label} ({counts[t.key]})
                                    </button>
                                ))}
                            </div>
                        </div>
                        {rows.length === 0 ? (
                            <p className="px-4 py-6 text-body-sm text-ink-muted">No {tab} jobs.</p>
                        ) : (
                            <div className="relative overflow-x-auto">
                                <table aria-label="Jobs of this agent" className="w-full border-collapse">
                                    <thead>
                                        <tr>
                                            <th className={tableHead}>Job</th>
                                            <th className={tableHead}>Client</th>
                                            <th className={tableHead}>Job type</th>
                                            <th className={tableHead}>Status</th>
                                            <th className={tableHead}>Date</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rows.map((job) => (
                                            <tr key={job.jobId} className={tableRow}>
                                                <td className={tableCell}><Link to={`/jobs/${job.jobId}`} className="font-medium text-primary hover:underline">{job.jobCode}</Link></td>
                                                <td className={tableCell}>{job.client.name}</td>
                                                <td className={tableCell}>{job.jobType.name}</td>
                                                <td className={tableCell}><JobStatusBadge status={job.status} /></td>
                                                <td className={tableCell}>{formatDate(job.completedAt ?? job.cancelledAt ?? job.createdAt)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                        {counts[tab] > rows.length && <p className="px-4 py-3 text-label-sm text-ink-muted">Showing the newest {rows.length} of {counts[tab]}. Open Jobs for the full list.</p>}
                    </Card>
                </div>
            )}

            {section === "details" && (
                <div role="tabpanel" id="agent-panel-details" aria-labelledby="agent-tab-details">
                    <Card className="p-4">
                        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            <Detail label="Country">{countryName(agent.countryCode)}</Detail>
                            <Detail label="Contact number">{agent.contactNumber ?? "—"}</Detail>
                            <Detail label="WhatsApp number">{agent.whatsappNumber ?? "—"}</Detail>
                            <Detail label="Email">{agent.email ?? "—"}</Detail>
                            <Detail label="Address">{agent.address ?? "—"}</Detail>
                            <Detail label="Created">{formatDate(agent.createdAt)}</Detail>
                            {agent.notes && <Detail label="Notes">{agent.notes}</Detail>}
                        </dl>
                    </Card>
                </div>
            )}

            {section === "clients" && (
                <div role="tabpanel" id="agent-panel-clients" aria-labelledby="agent-tab-clients">
                    <Card>
                        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                            <h2 className="text-title-sm text-ink">Clients ({agent.clients.length})</h2>
                            <button type="button" onClick={() => setDialog("edit")} className="text-label-md text-primary hover:underline">Edit clients</button>
                        </div>
                        {agent.clients.length === 0 ? (
                            <p className="px-4 py-6 text-body-sm text-ink-muted">This agent has no clients yet.</p>
                        ) : (
                            <div className="relative overflow-x-auto">
                                <table aria-label="Clients of this agent" className="w-full border-collapse">
                                    <thead>
                                        <tr>
                                            <th className={tableHead}>Client</th>
                                            <th className={tableHead}>Status</th>
                                            <th className={`${tableHead} text-right`}>Processing jobs</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {agent.clients.map((client) => (
                                            <tr key={client.clientId} className={tableRow}>
                                                <td className={tableCell}><Link to={`/client-management/${client.clientId}`} className="font-medium text-primary hover:underline">{client.name}</Link></td>
                                                <td className={tableCell}><EntityStatusBadge status={client.status} /></td>
                                                <td className={`${tableCell} text-right tabular-nums`}>{client.processingJobs}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </Card>
                </div>
            )}

            {dialog === "edit" && <AgentFormDialog token={token} agent={agent} onClose={() => setDialog(null)} onSaved={done} />}
            {dialog === "status" && (
                <StatusDialog
                    title={agent.status === "ACTIVE" ? "Make agent inactive" : "Activate agent"}
                    target={agent.status === "ACTIVE" ? "INACTIVE" : "ACTIVE"}
                    summary={agent.status === "ACTIVE"
                        ? `${agent.name} keeps its history, but can no longer be given new clients or jobs. This is refused while the agent has PROCESSING jobs.`
                        : `${agent.name} can be given new clients and jobs again.`}
                    onConfirm={async () => {
                        await setAgentStatus(token, agent.agentId, agent.status === "ACTIVE" ? "INACTIVE" : "ACTIVE");
                        done();
                    }}
                    onClose={() => setDialog(null)}
                />
            )}
        </section>
    );
}
