import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { createAgent, getAgent, listAgents, setAgentStatus, updateAgent, type AgentDetails, type AgentInput, type AgentListItem, type AgentRecord, type EntityStatus } from "../api/agents";
import { getClientOptions } from "../api/clientManagement";
import { useAdminResource } from "../api/useAdminResource";
import { canManageMasterData, useAuth } from "../auth/AuthProvider";
import { Pager } from "../components/ClientTable";
import { ActionDialog, DialogError, primaryButton, secondaryButton } from "../components/Dialog";
import { formatNumber } from "../components/format";
import { Icon } from "../components/Icon";
import { CountrySelect, EntityStatusBadge, MultiSelect, RestrictedPage, StatusDialog, TextField, countryName, errorMessage, fieldErrors } from "../components/master/MasterParts";
import { Card, EmptyState, ErrorState, LoadingState } from "../components/States";
import { filterControl, tableCell, tableHead, tableRow, textareaClass } from "../components/ui";

// Admin > Agents (ADMIN and MANAGER). An Agent is a business entity, not a
// login: a recruiting partner in one country that works with many Clients (and a
// Client with many Agents). Agents are never deleted; INACTIVE agents keep their
// history but take no new Client.
// Search, country, status and the page live in the URL; the server filters.

export function AgentsPage() {
    const { user } = useAuth();
    if (!canManageMasterData(user)) return <RestrictedPage what="agents" />;
    return <AgentsView />;
}

type Dialog = { kind: "create" } | { kind: "edit"; agent: AgentRecord } | { kind: "status"; agent: AgentRecord } | null;

function AgentsView() {
    const { token } = useAuth();
    const [searchParams, setSearchParams] = useSearchParams();
    const search = searchParams.get("search") || undefined;
    const country = searchParams.get("country") || undefined;
    const statusParam = searchParams.get("status");
    const status: EntityStatus | undefined = statusParam === "ACTIVE" || statusParam === "INACTIVE" ? statusParam : undefined;
    const pageNumber = Number(searchParams.get("page"));
    const page = Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1;
    const [searchText, setSearchText] = useState(search ?? "");
    useEffect(() => setSearchText(search ?? ""), [search]);
    const [dialog, setDialog] = useState<Dialog>(null);
    const list = useAdminResource(`agents?${searchParams.toString()}`, (t, signal) => listAgents(t, { search, country, status, page }, signal));

    const go = (changes: Record<string, string | null>) => {
        const next = new URLSearchParams(searchParams);
        for (const [key, value] of Object.entries(changes)) {
            if (value) next.set(key, value);
            else next.delete(key);
        }
        if (!("page" in changes)) next.delete("page");
        setSearchParams(next);
    };
    const submitSearch = (event: FormEvent) => {
        event.preventDefault();
        go({ search: searchText.trim() || null });
    };
    const done = () => {
        setDialog(null);
        list.reload();
    };

    const items = list.status === "error" ? [] : list.data?.items ?? [];
    const filtered = Boolean(search || country || status);

    return (
        <section aria-labelledby="page-title" className="mx-auto max-w-6xl space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 id="page-title" className="text-headline-lg text-ink">Agents</h1>
                    <p className="text-body-sm text-ink-muted">Recruiting partners, the country each works in, and the Clients they manage.</p>
                </div>
                <button type="button" onClick={() => setDialog({ kind: "create" })} className={`${primaryButton} inline-flex items-center gap-1.5`}>
                    <Icon name="support_agent" className="size-4" />Add agent
                </button>
            </div>

            <Card>
                <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
                    <form onSubmit={submitSearch} role="search" className="flex items-center gap-2">
                        <label htmlFor="agent-search" className="sr-only">Search agents</label>
                        <input id="agent-search" type="search" value={searchText} maxLength={100} placeholder="Agent name…" onChange={(event) => setSearchText(event.target.value)} className={`${filterControl} w-56`} />
                        <button type="submit" className={secondaryButton}>Search</button>
                    </form>
                    <label className="flex items-center gap-2 text-label-md text-ink-soft">
                        Country
                        <select value={country ?? ""} onChange={(event) => go({ country: event.target.value || null })} className={`${filterControl} w-44`}>
                            <option value="">All countries</option>
                            {(list.data?.countries ?? []).map((code) => <option key={code} value={code}>{countryName(code)}</option>)}
                        </select>
                    </label>
                    <label className="flex items-center gap-2 text-label-md text-ink-soft">
                        Status
                        <select value={status ?? ""} onChange={(event) => go({ status: event.target.value || null })} className={`${filterControl} w-36`}>
                            <option value="">All</option>
                            <option value="ACTIVE">Active</option>
                            <option value="INACTIVE">Inactive</option>
                        </select>
                    </label>
                    {filtered && <button type="button" onClick={() => { setSearchText(""); setSearchParams(new URLSearchParams()); }} className="text-label-md text-primary hover:underline">Clear filters</button>}
                </div>

                {list.status === "loading" && !list.data && <LoadingState label="Loading agents…" />}
                {list.status === "error" && <ErrorState message={list.error.message} onRetry={list.reload} />}
                {list.status !== "error" && list.data && items.length === 0 && (
                    <EmptyState title={filtered ? "No agents match your filters" : "No agents yet"} description={filtered ? undefined : "Add an agent, then add the clients it manages."} />
                )}
                {items.length > 0 && (
                    <div className="overflow-x-auto">
                        <table aria-label="Agents" className="w-full border-collapse">
                            <thead>
                                <tr>
                                    <th className={tableHead}>Agent</th>
                                    <th className={tableHead}>Country</th>
                                    <th className={`${tableHead} text-right`}>Active clients</th>
                                    <th className={`${tableHead} text-right`}>Processing jobs</th>
                                    <th className={`${tableHead} text-right`}>Completed jobs</th>
                                    <th className={tableHead}>Status</th>
                                    <th className={`${tableHead} text-right`}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {items.map((agent) => <AgentRow key={agent.agentId} agent={agent} onEdit={() => setDialog({ kind: "edit", agent })} onStatus={() => setDialog({ kind: "status", agent })} />)}
                            </tbody>
                        </table>
                    </div>
                )}
                {list.data && items.length > 0 && <Pager pagination={list.data.pagination} noun={["agent", "agents"]} onPage={(next) => go({ page: next > 1 ? String(next) : null })} />}
            </Card>

            {token && dialog?.kind === "create" && <AgentFormDialog token={token} onClose={() => setDialog(null)} onSaved={done} />}
            {token && dialog?.kind === "edit" && <AgentFormDialog token={token} agent={dialog.agent} onClose={() => setDialog(null)} onSaved={done} />}
            {token && dialog?.kind === "status" && (
                <StatusDialog
                    title={dialog.agent.status === "ACTIVE" ? "Make agent inactive" : "Activate agent"}
                    target={dialog.agent.status === "ACTIVE" ? "INACTIVE" : "ACTIVE"}
                    summary={dialog.agent.status === "ACTIVE"
                        ? `${dialog.agent.name} keeps its history, but can no longer be given new clients or jobs. This is refused while the agent has PROCESSING jobs.`
                        : `${dialog.agent.name} can be given new clients and jobs again.`}
                    onConfirm={async () => {
                        await setAgentStatus(token, dialog.agent.agentId, dialog.agent.status === "ACTIVE" ? "INACTIVE" : "ACTIVE");
                        done();
                    }}
                    onClose={() => setDialog(null)}
                />
            )}
        </section>
    );
}

function AgentRow({ agent, onEdit, onStatus }: { agent: AgentListItem; onEdit: () => void; onStatus: () => void }) {
    const link = "text-label-md text-primary hover:underline";
    return (
        <tr className={tableRow}>
            <td className={tableCell}>
                <Link to={`/agents/${agent.agentId}`} className="font-medium text-primary hover:underline">{agent.name}</Link>
            </td>
            <td className={tableCell}>{countryName(agent.countryCode)}</td>
            <td className={`${tableCell} text-right tabular-nums`}>{formatNumber(agent.activeClients)}</td>
            <td className={`${tableCell} text-right tabular-nums`}>{formatNumber(agent.processingJobs)}</td>
            <td className={`${tableCell} text-right tabular-nums`}>{formatNumber(agent.completedJobs)}</td>
            <td className={tableCell}><EntityStatusBadge status={agent.status} /></td>
            <td className={`${tableCell} text-right`}>
                <span className="inline-flex gap-3">
                    <Link to={`/agents/${agent.agentId}`} className={link} aria-label={`View ${agent.name}`}>View</Link>
                    <button type="button" onClick={onEdit} className={link} aria-label={`Edit ${agent.name}`}>Edit</button>
                    <button type="button" onClick={onStatus} className={link} aria-label={`${agent.status === "ACTIVE" ? "Make inactive" : "Activate"} ${agent.name}`}>
                        {agent.status === "ACTIVE" ? "Make inactive" : "Activate"}
                    </button>
                </span>
            </td>
        </tr>
    );
}

// Add and edit share one form. The id is system-generated and never shown as an input. The
// agent's Clients are chosen here too: on edit the list starts with every current client
// (loaded when the dialog is opened from the list) and is saved as the full list.
export function AgentFormDialog({ token, agent, onClose, onSaved }: { token: string; agent?: AgentRecord | AgentDetails; onClose: () => void; onSaved: () => void }) {
    const clientOptions = useAdminResource("client-options", (t, signal) => getClientOptions(t, signal));
    const known = agent && "clients" in agent ? agent.clients.map((client) => client.clientId) : null;
    const loadLinks = Boolean(agent) && !known;
    const links = useAdminResource(`agent-form:${loadLinks ? agent!.agentId : "none"}`, (t, signal) => (loadLinks ? getAgent(t, agent!.agentId, signal) : Promise.resolve(null)));
    const [clientIds, setClientIds] = useState<string[] | null>(() => known ?? (agent ? null : []));
    useEffect(() => {
        if (clientIds === null && links.data) setClientIds(links.data.clients.map((client) => client.clientId));
    }, [clientIds, links.data]);
    const [name, setName] = useState(agent?.name ?? "");
    const [countryCode, setCountryCode] = useState(agent?.countryCode ?? "");
    const [contactNumber, setContactNumber] = useState(agent?.contactNumber ?? "");
    const [whatsappNumber, setWhatsappNumber] = useState(agent?.whatsappNumber ?? "");
    const [email, setEmail] = useState(agent?.email ?? "");
    const [address, setAddress] = useState(agent?.address ?? "");
    const [notes, setNotes] = useState(agent?.notes ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [errors, setErrors] = useState<Record<string, string>>({});

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setErrors({});
        const body: AgentInput = {
            name: name.trim(), countryCode,
            contactNumber: contactNumber.trim() || null, whatsappNumber: whatsappNumber.trim() || null,
            email: email.trim() || null, address: address.trim() || null, notes: notes.trim() || null,
            clientIds: clientIds ?? [],
        };
        try {
            if (agent) await updateAgent(token, agent.agentId, body);
            else await createAgent(token, body);
            onSaved();
        } catch (caught) {
            const found = fieldErrors(caught);
            setErrors(found);
            setError(Object.keys(found).length ? null : errorMessage(caught));
            setBusy(false);
        }
    };

    return (
        <ActionDialog title={agent ? "Edit agent" : "Add agent"} busy={busy} onClose={onClose}>
            <form onSubmit={submit} className="space-y-3">
                <TextField label="Agent name" value={name} onChange={setName} disabled={busy} error={errors.name} required maxLength={120} />
                <CountrySelect value={countryCode} onChange={setCountryCode} disabled={busy} error={errors.countryCode} />
                {clientIds === null || !clientOptions.data ? (
                    clientOptions.status === "error" || links.status === "error"
                        ? <p className="text-body-sm text-critical">The clients could not be loaded. Close and try again.</p>
                        : <p className="text-body-sm text-ink-muted">Loading clients…</p>
                ) : (
                    <MultiSelect
                        label="Clients" selected={clientIds} onChange={setClientIds} disabled={busy} error={errors.clientIds}
                        options={clientOptions.data.clients.map((client) => ({ id: client.clientId, label: client.name, hint: client.status === "INACTIVE" ? "inactive" : undefined }))}
                        empty="No clients yet. Clients can be added later."
                        hint="A client can work with several agents. A client must keep at least one agent."
                    />
                )}
                <TextField label="Contact number" value={contactNumber} onChange={setContactNumber} disabled={busy} error={errors.contactNumber} maxLength={30} />
                <TextField label="WhatsApp number" value={whatsappNumber} onChange={setWhatsappNumber} disabled={busy} error={errors.whatsappNumber} maxLength={30} />
                <TextField label="Email" type="email" value={email} onChange={setEmail} disabled={busy} error={errors.email} maxLength={254} />
                <TextField label="Address" value={address} onChange={setAddress} disabled={busy} error={errors.address} />
                <div>
                    <label htmlFor="agent-notes" className="text-label-md text-ink">Notes <span className="text-ink-muted">(optional)</span></label>
                    <textarea id="agent-notes" value={notes} rows={3} maxLength={1000} disabled={busy} onChange={(event) => setNotes(event.target.value)} className={textareaClass(Boolean(errors.notes))} />
                    {errors.notes && <p className="mt-1 text-label-sm text-critical">{errors.notes}</p>}
                </div>
                <DialogError message={error} />
                <div className="flex justify-end gap-2 pt-1">
                    <button type="button" disabled={busy} onClick={onClose} className={secondaryButton}>Cancel</button>
                    <button type="submit" disabled={busy || !name.trim() || !countryCode || clientIds === null} className={primaryButton}>{busy ? "Saving…" : agent ? "Save changes" : "Add agent"}</button>
                </div>
            </form>
        </ActionDialog>
    );
}
