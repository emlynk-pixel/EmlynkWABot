import { useState } from "react";
import { Link, useParams } from "react-router";
import { getAgentOptions } from "../api/agents";
import { getClient, type ClientJobRow } from "../api/clientManagement";
import { useAdminResource } from "../api/useAdminResource";
import { canManageMasterData, useAuth } from "../auth/AuthProvider";
import { primaryButton, secondaryButton } from "../components/Dialog";
import { formatDate } from "../components/format";
import { Detail, JobStatusBadge } from "../components/job/JobParts";
import { EntityStatusBadge, RestrictedPage, countryName } from "../components/master/MasterParts";
import { Card, ErrorState, LoadingState } from "../components/States";
import { tableCell, tableHead, tableRow } from "../components/ui";
import { ChangeAgentDialog, ClientFormDialog, ClientStatusDialog } from "./ClientManagementPage";

// Client details: the client's own data, its responsible Agent and its Jobs by
// status. Jobs link to the Job record; this page does not repeat Job Management.

type JobTab = "processing" | "completed" | "cancelled";
const TABS: { key: JobTab; label: string }[] = [
    { key: "processing", label: "Processing" },
    { key: "completed", label: "Completed" },
    { key: "cancelled", label: "Cancelled" },
];

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
    const [tab, setTab] = useState<JobTab>("processing");
    const [dialog, setDialog] = useState<"edit" | "agent" | "status" | null>(null);

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
    const agent = client.agent;

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

            <Card className="p-4">
                <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <Detail label="Country">{countryName(client.countryCode)}</Detail>
                    <Detail label="Contact person">{client.contactPerson ?? "—"}</Detail>
                    <Detail label="Contact number">{client.contactNumber ?? "—"}</Detail>
                    <Detail label="WhatsApp number">{client.whatsappNumber ?? "—"}</Detail>
                    <Detail label="Email">{client.email ?? "—"}</Detail>
                    <Detail label="Address">{client.address ?? "—"}</Detail>
                    <Detail label="Created">{formatDate(client.createdAt)}</Detail>
                </dl>
            </Card>

            <Card className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-title-sm text-ink">Responsible agent</h2>
                    <button type="button" onClick={() => setDialog("agent")} className="text-label-md text-primary hover:underline">Change agent</button>
                </div>
                {agent ? (
                    <dl className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <Detail label="Agent"><Link to={`/agents/${agent.agentId}`} className="font-medium text-primary hover:underline">{agent.name}</Link></Detail>
                        <Detail label="Country">{countryName(agent.countryCode)}</Detail>
                        <Detail label="Status"><EntityStatusBadge status={agent.status} /></Detail>
                    </dl>
                ) : (
                    <p className="mt-2 text-body-sm text-ink-muted">No agent is assigned. Assign one before creating jobs for this client.</p>
                )}
            </Card>

            <Card>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                    <h2 className="text-title-sm text-ink">Jobs</h2>
                    <div role="tablist" aria-label="Job status" className="flex gap-1">
                        {TABS.map((t) => (
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
                    <div className="overflow-x-auto">
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

            {dialog === "edit" && <ClientFormDialog token={token} agents={agents.data?.agents ?? []} client={client} onClose={() => setDialog(null)} onSaved={done} />}
            {dialog === "agent" && <ChangeAgentDialog token={token} client={client} agents={agents.data?.agents ?? []} onClose={() => setDialog(null)} onDone={done} />}
            {dialog === "status" && <ClientStatusDialog token={token} client={client} onClose={() => setDialog(null)} onDone={done} />}
        </section>
    );
}
