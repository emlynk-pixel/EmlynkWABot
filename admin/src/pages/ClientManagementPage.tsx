import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { getAgentOptions, type AgentOption, type EntityStatus } from "../api/agents";
import { createClient, listClients, setClientStatus, updateClient, type ClientListItem, type ClientRecord } from "../api/clientManagement";
import { useAdminResource } from "../api/useAdminResource";
import { canManageMasterData, useAuth } from "../auth/AuthProvider";
import { Pager } from "../components/ClientTable";
import { ActionDialog, DialogError, primaryButton, secondaryButton } from "../components/Dialog";
import { formatNumber } from "../components/format";
import { Icon } from "../components/Icon";
import { EntityStatusBadge, MultiSelect, RestrictedPage, StatusDialog, TextField, countryName, errorMessage, fieldErrors } from "../components/master/MasterParts";
import { Card, EmptyState, ErrorState, LoadingState } from "../components/States";
import { filterControl, tableCell, tableHead, tableRow } from "../components/ui";

// Admin > Client Management (ADMIN and MANAGER): the employer / customer
// organisations. A Client works with one or more Agents (and an Agent with many
// Clients) and has many Jobs. Clients are never deleted; INACTIVE clients keep
// their jobs but take no new job. The list does not show the agents (Client
// details does); the Agent filter still finds a client through any of its agents.
// (Technical route /client-management: /clients is the candidate-documents area.)

export function ClientManagementPage() {
    const { user } = useAuth();
    if (!canManageMasterData(user)) return <RestrictedPage what="clients" />;
    return <ClientsView />;
}

type Dialog = { kind: "create" } | { kind: "edit"; client: ClientRecord } | { kind: "status"; client: ClientRecord } | null;

function ClientsView() {
    const { token } = useAuth();
    const [searchParams, setSearchParams] = useSearchParams();
    const search = searchParams.get("search") || undefined;
    const country = searchParams.get("country") || undefined;
    const agentId = searchParams.get("agentId") || undefined;
    const statusParam = searchParams.get("status");
    const status: EntityStatus | undefined = statusParam === "ACTIVE" || statusParam === "INACTIVE" ? statusParam : undefined;
    const pageNumber = Number(searchParams.get("page"));
    const page = Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1;
    const [searchText, setSearchText] = useState(search ?? "");
    useEffect(() => setSearchText(search ?? ""), [search]);
    const [dialog, setDialog] = useState<Dialog>(null);
    const list = useAdminResource(`client-management?${searchParams.toString()}`, (t, signal) => listClients(t, { search, country, status, agentId, page }, signal));
    const agents = useAdminResource("agent-options", (t, signal) => getAgentOptions(t, signal));

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
    const filtered = Boolean(search || country || status || agentId);
    const agentOptions = agents.data?.agents ?? [];

    return (
        <section aria-labelledby="page-title" className="mx-auto max-w-6xl space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 id="page-title" className="text-headline-lg text-ink">Client Management</h1>
                    <p className="text-body-sm text-ink-muted">Employer clients, the agents they work with, and their jobs.</p>
                </div>
                <button type="button" onClick={() => setDialog({ kind: "create" })} className={`${primaryButton} inline-flex items-center gap-1.5`}>
                    <Icon name="apartment" className="size-4" />Add client
                </button>
            </div>

            <Card>
                <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
                    <form onSubmit={submitSearch} role="search" className="flex items-center gap-2">
                        <label htmlFor="client-search" className="sr-only">Search clients</label>
                        <input id="client-search" type="search" value={searchText} maxLength={100} placeholder="Client or contact person…" onChange={(event) => setSearchText(event.target.value)} className={`${filterControl} w-56`} />
                        <button type="submit" className={secondaryButton}>Search</button>
                    </form>
                    <label className="flex items-center gap-2 text-label-md text-ink-soft">
                        Agent
                        <select value={agentId ?? ""} onChange={(event) => go({ agentId: event.target.value || null })} className={`${filterControl} w-44`}>
                            <option value="">All agents</option>
                            {agentOptions.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.name}{agent.status === "INACTIVE" ? " (inactive)" : ""}</option>)}
                        </select>
                    </label>
                    <label className="flex items-center gap-2 text-label-md text-ink-soft">
                        Country
                        <select value={country ?? ""} onChange={(event) => go({ country: event.target.value || null })} className={`${filterControl} w-40`}>
                            <option value="">All countries</option>
                            {(list.data?.countries ?? []).map((code) => <option key={code} value={code}>{countryName(code)}</option>)}
                        </select>
                    </label>
                    <label className="flex items-center gap-2 text-label-md text-ink-soft">
                        Status
                        <select value={status ?? ""} onChange={(event) => go({ status: event.target.value || null })} className={`${filterControl} w-32`}>
                            <option value="">All</option>
                            <option value="ACTIVE">Active</option>
                            <option value="INACTIVE">Inactive</option>
                        </select>
                    </label>
                    {filtered && <button type="button" onClick={() => { setSearchText(""); setSearchParams(new URLSearchParams()); }} className="text-label-md text-primary hover:underline">Clear filters</button>}
                </div>

                {list.status === "loading" && !list.data && <LoadingState label="Loading clients…" />}
                {list.status === "error" && <ErrorState message={list.error.message} onRetry={list.reload} />}
                {list.status !== "error" && list.data && items.length === 0 && (
                    <EmptyState title={filtered ? "No clients match your filters" : "No clients yet"} description={filtered ? undefined : "Add an agent first, then add the clients it manages."} />
                )}
                {items.length > 0 && (
                    <div className="overflow-x-auto">
                        <table aria-label="Clients" className="w-full border-collapse">
                            <thead>
                                <tr>
                                    <th className={tableHead}>Client</th>
                                    <th className={tableHead}>Country</th>
                                    <th className={`${tableHead} text-right`}>Processing jobs</th>
                                    <th className={`${tableHead} text-right`}>Completed jobs</th>
                                    <th className={tableHead}>Status</th>
                                    <th className={`${tableHead} text-right`}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {items.map((client) => <ClientRow key={client.clientId} client={client} onEdit={() => setDialog({ kind: "edit", client })} onStatus={() => setDialog({ kind: "status", client })} />)}
                            </tbody>
                        </table>
                    </div>
                )}
                {list.data && items.length > 0 && <Pager pagination={list.data.pagination} noun={["client", "clients"]} onPage={(next) => go({ page: next > 1 ? String(next) : null })} />}
            </Card>

            {token && dialog?.kind === "create" && <ClientFormDialog token={token} agents={agentOptions} onClose={() => setDialog(null)} onSaved={done} />}
            {token && dialog?.kind === "edit" && <ClientFormDialog token={token} agents={agentOptions} client={dialog.client} onClose={() => setDialog(null)} onSaved={done} />}
            {token && dialog?.kind === "status" && <ClientStatusDialog token={token} client={dialog.client} onClose={() => setDialog(null)} onDone={done} />}
        </section>
    );
}

function ClientRow({ client, onEdit, onStatus }: { client: ClientListItem; onEdit: () => void; onStatus: () => void }) {
    const link = "text-label-md text-primary hover:underline";
    return (
        <tr className={tableRow}>
            <td className={tableCell}><Link to={`/client-management/${client.clientId}`} className="font-medium text-primary hover:underline">{client.name}</Link></td>
            <td className={tableCell}>{client.countryCodes.length ? client.countryCodes.map(countryName).join(", ") : <span className="text-ink-muted">—</span>}</td>
            <td className={`${tableCell} text-right tabular-nums`}>{formatNumber(client.processingJobs)}</td>
            <td className={`${tableCell} text-right tabular-nums`}>{formatNumber(client.completedJobs)}</td>
            <td className={tableCell}><EntityStatusBadge status={client.status} /></td>
            <td className={`${tableCell} text-right`}>
                <span className="inline-flex gap-3">
                    <Link to={`/client-management/${client.clientId}`} className={link} aria-label={`View ${client.name}`}>View</Link>
                    <button type="button" onClick={onEdit} className={link} aria-label={`Edit ${client.name}`}>Edit</button>
                    <button type="button" onClick={onStatus} className={link} aria-label={`${client.status === "ACTIVE" ? "Make inactive" : "Activate"} ${client.name}`}>
                        {client.status === "ACTIVE" ? "Make inactive" : "Activate"}
                    </button>
                </span>
            </td>
        </tr>
    );
}

export function ClientStatusDialog({ token, client, onClose, onDone }: { token: string; client: ClientRecord; onClose: () => void; onDone: () => void }) {
    const target: EntityStatus = client.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    return (
        <StatusDialog
            title={target === "INACTIVE" ? "Make client inactive" : "Activate client"}
            target={target}
            summary={target === "INACTIVE"
                ? `${client.name} keeps its jobs and its agents, but can no longer get a new job. This is refused while the client has PROCESSING jobs.`
                : `${client.name} can get new jobs again.`}
            onConfirm={async () => {
                await setClientStatus(token, client.clientId, target);
                onDone();
            }}
            onClose={onClose}
        />
    );
}

// Add and edit share one form. The client's agents (one or more) are chosen on both: on edit the
// list starts with every current agent and is saved as the full list (adds, keeps and removes).
// Only ACTIVE agents can be added; an inactive agent already linked stays listed and can be removed.
export function ClientFormDialog({ token, agents, client, onClose, onSaved }: { token: string; agents: AgentOption[]; client?: ClientRecord; onClose: () => void; onSaved: () => void }) {
    const [name, setName] = useState(client?.name ?? "");
    const [agentIds, setAgentIds] = useState<string[]>(() => client?.agents.map((agent) => agent.agentId) ?? []);
    const [contactPerson, setContactPerson] = useState(client?.contactPerson ?? "");
    const [contactNumber, setContactNumber] = useState(client?.contactNumber ?? "");
    const [whatsappNumber, setWhatsappNumber] = useState(client?.whatsappNumber ?? "");
    const [email, setEmail] = useState(client?.email ?? "");
    const [address, setAddress] = useState(client?.address ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [errors, setErrors] = useState<Record<string, string>>({});
    // Every agent the list knows, plus a linked one the options do not (yet) include.
    const known = [...agents, ...(client?.agents ?? []).filter((linked) => !agents.some((agent) => agent.agentId === linked.agentId))];
    const options = known.map((agent) => ({
        id: agent.agentId,
        label: agent.name,
        hint: `${countryName(agent.countryCode)}${agent.status === "INACTIVE" ? " · inactive" : ""}`,
        disabled: agent.status !== "ACTIVE",
    }));
    const countries = [...new Set(known.filter((agent) => agentIds.includes(agent.agentId)).map((agent) => agent.countryCode))].map(countryName);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setErrors({});
        const details = {
            name: name.trim(), agentIds, contactPerson: contactPerson.trim() || null, contactNumber: contactNumber.trim() || null,
            whatsappNumber: whatsappNumber.trim() || null, email: email.trim() || null, address: address.trim() || null,
        };
        try {
            if (client) await updateClient(token, client.clientId, details);
            else await createClient(token, details);
            onSaved();
        } catch (caught) {
            const found = fieldErrors(caught);
            setErrors(found);
            setError(Object.keys(found).length ? null : errorMessage(caught));
            setBusy(false);
        }
    };

    return (
        <ActionDialog title={client ? "Edit client" : "Add client"} busy={busy} onClose={onClose}>
            <form onSubmit={submit} className="space-y-3">
                <TextField label="Client name" value={name} onChange={setName} disabled={busy} error={errors.name} required maxLength={120} />
                <MultiSelect
                    label="Agents" options={options} selected={agentIds} onChange={setAgentIds} disabled={busy} required error={errors.agentIds}
                    empty="No agents yet. Add an agent first."
                    hint={`At least one. Only active agents can be added. Country: ${countries.length ? countries.join(", ") : "taken from the agents"}.`}
                />
                <TextField label="Contact person" value={contactPerson} onChange={setContactPerson} disabled={busy} error={errors.contactPerson} maxLength={120} />
                <TextField label="Contact number" value={contactNumber} onChange={setContactNumber} disabled={busy} error={errors.contactNumber} maxLength={30} />
                <TextField label="WhatsApp number" value={whatsappNumber} onChange={setWhatsappNumber} disabled={busy} error={errors.whatsappNumber} maxLength={30} />
                <TextField label="Email" type="email" value={email} onChange={setEmail} disabled={busy} error={errors.email} maxLength={254} />
                <TextField label="Address" value={address} onChange={setAddress} disabled={busy} error={errors.address} />
                {client && <p className="text-label-sm text-ink-muted">Existing jobs keep the agent they were created with; only new jobs use the agents chosen here.</p>}
                <DialogError message={error} />
                <div className="flex justify-end gap-2 pt-1">
                    <button type="button" disabled={busy} onClick={onClose} className={secondaryButton}>Cancel</button>
                    <button type="submit" disabled={busy || !name.trim() || agentIds.length === 0} className={primaryButton}>{busy ? "Saving…" : client ? "Save changes" : "Add client"}</button>
                </div>
            </form>
        </ActionDialog>
    );
}
