import type { AgentJobRow, EntityStatus, Pagination } from "./agents";
import { apiRequest } from "./client";

// Client Management (src/services/clientService.js, /api/admin/client-management).
// A Client is the employer / customer organisation, with ONE responsible Agent
// and many Jobs. ADMIN and MANAGER only. Never deleted: ACTIVE or INACTIVE.
// (The legacy candidate "Clients" area is /api/admin/clients, api/admin.ts.)

export type ClientAgentRef = { agentId: string; name: string; countryCode: string; status: EntityStatus };

export type ClientRecord = {
    clientId: string;
    name: string;
    status: EntityStatus;
    // The responsible Agent's country (a Client has none of its own).
    countryCode: string | null;
    agent: ClientAgentRef | null;
    contactPerson: string | null;
    contactNumber: string | null;
    whatsappNumber: string | null;
    email: string | null;
    address: string | null;
    createdAt: string | null;
    updatedAt: string | null;
};

export type ClientCounts = { processingJobs: number; completedJobs: number; cancelledJobs: number };
export type ClientListItem = ClientRecord & ClientCounts;

export type ClientList = {
    items: ClientListItem[];
    pagination: Pagination;
    filters: { search: string | null; country: string | null; status: EntityStatus | null; agentId: string | null };
    countries: string[];
};

export type ClientJobRow = AgentJobRow & { activeCandidates: number };

export type ClientDetails = ClientListItem & {
    jobs: { processing: ClientJobRow[]; completed: ClientJobRow[]; cancelled: ClientJobRow[] };
    jobsShownLimit: number;
};

export type ClientInput = {
    name: string;
    agentId: string;
    contactPerson?: string | null;
    contactNumber?: string | null;
    whatsappNumber?: string | null;
    email?: string | null;
    address?: string | null;
};

export type ClientListParams = { search?: string; country?: string; status?: EntityStatus; agentId?: string; page: number };

const clientPath = (clientId: string) => `/api/admin/client-management/${encodeURIComponent(clientId)}`;

export function listClients(token: string, params: ClientListParams, signal?: AbortSignal): Promise<ClientList> {
    const query = new URLSearchParams({ page: String(params.page) });
    if (params.search) query.set("search", params.search);
    if (params.country) query.set("country", params.country);
    if (params.status) query.set("status", params.status);
    if (params.agentId) query.set("agentId", params.agentId);
    return apiRequest<ClientList>(`/api/admin/client-management?${query.toString()}`, { token, signal });
}

export const getClient = (token: string, clientId: string, signal?: AbortSignal) => apiRequest<ClientDetails>(clientPath(clientId), { token, signal });
export const createClient = (token: string, body: ClientInput) => apiRequest<ClientDetails>("/api/admin/client-management", { method: "POST", token, body });
export const updateClient = (token: string, clientId: string, body: Partial<Omit<ClientInput, "agentId">>) => apiRequest<ClientDetails>(clientPath(clientId), { method: "PATCH", token, body });
export const changeClientAgent = (token: string, clientId: string, agentId: string) => apiRequest<ClientDetails>(`${clientPath(clientId)}/agent`, { method: "PATCH", token, body: { agentId } });
export const setClientStatus = (token: string, clientId: string, status: EntityStatus) => apiRequest<ClientDetails>(`${clientPath(clientId)}/status`, { method: "PATCH", token, body: { status } });
