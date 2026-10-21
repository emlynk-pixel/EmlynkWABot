import { useState } from "react";
import { Link, useParams } from "react-router";
import { getAgentOptions } from "../api/agents";
import { getClient, type ClientJobRow } from "../api/clientManagement";
import { useAdminResource } from "../api/useAdminResource";
import { canManageMasterData, useAuth } from "../auth/AuthProvider";
import { primaryButton, secondaryButton } from "../components/Dialog";
import { formatDate } from "../components/format";
import { Detail, JobStatusBadge } from "../components/job/JobParts";
import { EntityStatusBadge, PageTabs, RestrictedPage, countryName } from "../components/master/MasterParts";
import { Card, ErrorState, LoadingState } from "../components/States";
import { tableCell, tableHead, tableRow } from "../components/ui";
import { ClientFormDialog, ClientStatusDialog } from "./ClientManagementPage";

// Client details, in horizontal tabs: Job Details (the default: the client's Jobs by status),
// Client Details (its own data) and Agents (every agent it works with; none is primary). The
// tab is page state only; Edit (details and agents) and the status action sit above the tabs.
// Jobs link to the Job record; this page does not repeat Job Management.

type JobTab = "processing" | "completed" | "cancelled";
const JOB_TABS: { key: JobTab; label: string }[] = [
    { key: "processing", label: "Processing" },
    { key: "completed", label: "Completed" },
    { key: "cancelled", label: "Cancelled" },
];
type Section = "jobs" | "details" | "agents";

export function ClientManagementDetailsPage() {
    const { user } = useAuth();
    if (!canManageMasterData(user)) return <RestrictedPage what="clients" />;
    return <ClientDetailsView />;
}

function ClientDetailsView() {
    const { clientId = "" } = useParams();
    const { token } = useAuth();
    const detail = useAdminResource(`client-management:${clientId}`, (t, signal) => getClient(t, clientId, signal));
    const agents = useAdminResource("agent-options", (t, signal) => getAgentOptions(t, signal));
    const [section, setSection] = useState<Section>("jobs");
    const [tab, setTab] = useState<JobTab>("processing");
    const [dialog, setDialog] = useState<"edit" | "status" | null>(null);

    if (detail.status === "loading" && !detail.data) return <LoadingState label="Loading client…" />;
    if (detail.status === "error" && !detail.data) return <ErrorState message={detail.error.status === 404 ? "Client not found." : detail.error.message} onRetry={detail.reload} />;
    const client = detail.data;
    if (!client || !token) return null;
    const done = () => {
        setDialog(null);
        detail.reload();
    };
    const counts: Record<JobTab, number> = { processing: client.processingJobs, completed: client.completedJobs, cancelled: client.cancelledJobs };
    const rows: ClientJobRow[] = client.jobs[tab];
    const totalJobs = counts.processing + counts.completed + counts.cancelled;

    return (
        <section aria-labelledby="page-title" className="mx-auto max-w-6xl space-y-4">
            <nav aria-label="Breadcrumb" className="text-body-sm text-ink-muted"><Link to="/client-management" className="text-primary hover:underline">Client Management</Link> / {client.name}</nav>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                    <h1 id="page-title" className="text-headline-lg text-ink">{client.name}</h1>
                    <EntityStatusBadge status={client.status} />
                </div>
                <div className="flex gap-2">
                    <button type="button" onClick={() => setDialog("edit")} className={secondaryButton}>Edit</button>
                    <button type="button" onClick={() => setDialog("status")} className={primaryButton}>{client.status === "ACTIVE" ? "Make inactive" : "Activate"}</button>
                </div>
            </div>

            <PageTabs
                label="Client sections" idPrefix="client" value={section} onChange={setSection}
                tabs={[
                    { key: "jobs", label: `Job Details (${totalJobs})` },
                    { key: "details", label: "Client Details" },
                    { key: "agents", label: `Agents (${client.agents.length})` },
                ]}
            />

            {section === "jobs" && (
                <div role="tabpanel" id="client-panel-jobs" aria-labelledby="client-tab-jobs">
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
                                <table aria-label="Jobs of this client" className="w-full border-collapse">
                                    <thead>
                                        <tr>
                                            <th className={tableHead}>Job</th>
                                            <th className={tableHead}>Job type</th>
                                            <th className={tableHead}>Status</th>
                                            <th className={tableHead}>Responsible agent</th>
                                            <th className={`${tableHead} text-right`}>Candidates</th>
                                            <th className={tableHead}>Date</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rows.map((job) => (
                                            <tr key={job.jobId} className={tableRow}>
                                                <td className={tableCell}><Link to={`/jobs/${job.jobId}`} className="font-medium text-primary hover:underline">{job.jobCode}</Link></td>
                                                <td className={tableCell}>{job.jobType.name}</td>
                                                <td className={tableCell}><JobStatusBadge status={job.status} /></td>
                                                <td className={tableCell}>{job.responsibleAgent.name}</td>
                                                <td className={`${tableCell} text-right tabular-nums`}>{job.activeCandidates}</td>
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
                <div role="tabpanel" id="client-panel-details" aria-labelledby="client-tab-details">
                    <Card className="p-4">
                        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            <Detail label="Country">{client.countryCodes.length ? client.countryCodes.map(countryName).join(", ") : "—"}</Detail>
                            <Detail label="Contact person">{client.contactPerson ?? "—"}</Detail>
                            <Detail label="Contact number">{client.contactNumber ?? "—"}</Detail>
                            <Detail label="WhatsApp number">{client.whatsappNumber ?? "—"}</Detail>
                            <Detail label="Email">{client.email ?? "—"}</Detail>
                            <Detail label="Address">{client.address ?? "—"}</Detail>
                            <Detail label="Created">{formatDate(client.createdAt)}</Detail>
                        </dl>
                    </Card>
                </div>
            )}

            {section === "agents" && (
                <div role="tabpanel" id="client-panel-agents" aria-labelledby="client-tab-agents">
                    <Card>
                        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                            <h2 className="text-title-sm text-ink">Agents ({client.agents.length})</h2>
                            <button type="button" onClick={() => setDialog("edit")} className="text-label-md text-primary hover:underline">Edit agents</button>
                        </div>
                        {client.agents.length === 0 ? (
                            <p className="px-4 py-6 text-body-sm text-ink-muted">No agent is linked. Add one before creating jobs for this client.</p>
                        ) : (
                            <div className="relative overflow-x-auto">
                                <table aria-label="Agents of this client" className="w-full border-collapse">
                                    <thead>
                                        <tr>
                                            <th className={tableHead}>Agent</th>
                                            <th className={tableHead}>Country</th>
                                            <th className={tableHead}>Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {client.agents.map((agent) => (
                                            <tr key={agent.agentId} className={tableRow}>
                                                <td className={tableCell}><Link to={`/agents/${agent.agentId}`} className="font-medium text-primary hover:underline">{agent.name}</Link></td>
                                                <td className={tableCell}>{countryName(agent.countryCode)}</td>
                                                <td className={tableCell}><EntityStatusBadge status={agent.status} /></td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                        <p className="px-4 py-3 text-label-sm text-ink-muted">A job&apos;s To Country is the country of the agent chosen as its responsible agent.</p>
                    </Card>
                </div>
            )}

            {dialog === "edit" && <ClientFormDialog token={token} agents={agents.data?.agents ?? []} client={client} onClose={() => setDialog(null)} onSaved={done} />}
            {dialog === "status" && <ClientStatusDialog token={token} client={client} onClose={() => setDialog(null)} onDone={done} />}
        </section>
    );
}
