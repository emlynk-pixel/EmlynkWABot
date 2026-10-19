import { apiRequest } from "./client";
import type { JobStatus } from "./jobs";

// Agent Management (src/services/agentService.js). ADMIN and MANAGER only; the
// server enforces it. An Agent is a business entity (not a login) that belongs
// to one country and manages many Clients. Never deleted: ACTIVE or INACTIVE.

export type EntityStatus = "ACTIVE" | "INACTIVE";

export type AgentRecord = {
    agentId: string;
    name: string;
    countryCode: string;
    status: EntityStatus;
    contactNumber: string | null;
    whatsappNumber: string | null;
    email: string | null;
    address: string | null;
    notes: string | null;
    createdAt: string | null;
    updatedAt: string | null;
};

export type AgentCounts = { activeClients: number; processingJobs: number; completedJobs: number; cancelledJobs: number };

export type AgentListItem = AgentRecord & AgentCounts;

export type Pagination = { page: number; pageSize: number; total: number; totalPages: number; totalItems?: number; hasNextPage?: boolean; hasPreviousPage?: boolean };

export type AgentList = {
    items: AgentListItem[];
    pagination: Pagination;
    filters: { search: string | null; country: string | null; status: EntityStatus | null };
    countries: string[];
};

export type AgentJobRow = {
    jobId: string;
    jobCode: string;
    companyJobId: string | null;
    status: JobStatus;
    client: { id: string; name: string };
    jobType: { id: string; name: string };
    responsibleAgent: { id: string; name: string };
    createdAt: string | null;
    completedAt: string | null;
    cancelledAt: string | null;
};

export type AgentDetails = AgentListItem & {
    clients: { clientId: string; name: string; status: EntityStatus; processingJobs: number }[];
    jobs: { processing: AgentJobRow[]; completed: AgentJobRow[]; cancelled: AgentJobRow[] };
    jobsShownLimit: number;
};

export type AgentOption = { agentId: string; name: string; countryCode: string; status: EntityStatus };

export type AgentInput = {
    name: string;
    countryCode: string;
    contactNumber?: string | null;
    whatsappNumber?: string | null;
    email?: string | null;
    address?: string | null;
    notes?: string | null;
};

export type AgentListParams = { search?: string; country?: string; status?: EntityStatus; page: number };

const agentPath = (agentId: string) => `/api/admin/agents/${encodeURIComponent(agentId)}`;

export function listAgents(token: string, params: AgentListParams, signal?: AbortSignal): Promise<AgentList> {
    const query = new URLSearchParams({ page: String(params.page) });
    if (params.search) query.set("search", params.search);
    if (params.country) query.set("country", params.country);
    if (params.status) query.set("status", params.status);
    return apiRequest<AgentList>(`/api/admin/agents?${query.toString()}`, { token, signal });
}

export const getAgent = (token: string, agentId: string, signal?: AbortSignal) => apiRequest<AgentDetails>(agentPath(agentId), { token, signal });
export const getAgentOptions = (token: string, signal?: AbortSignal) => apiRequest<{ agents: AgentOption[] }>("/api/admin/agent-options", { token, signal });
export const createAgent = (token: string, body: AgentInput) => apiRequest<AgentDetails>("/api/admin/agents", { method: "POST", token, body });
export const updateAgent = (token: string, agentId: string, body: Partial<AgentInput>) => apiRequest<AgentDetails>(agentPath(agentId), { method: "PATCH", token, body });
export const setAgentStatus = (token: string, agentId: string, status: EntityStatus) => apiRequest<AgentDetails>(`${agentPath(agentId)}/status`, { method: "PATCH", token, body: { status } });
