import { apiRequest } from "./client";
import type { CandidateStageKey, WorkflowStatus } from "./candidates";

// Work Allocation (src/services/workAllocationService.js): which Analyst each
// candidate is assigned to. ADMIN and MANAGER only; the server checks it.

export type AllocationStatus = "UNALLOCATED" | "ALLOCATED";

export type AllocationAnalystRef = { analystId: string; name: string; active: boolean };

export type AllocationCandidate = {
    passportId: string;
    uniqueId: string;
    name: string | null;
    nic: string | null;
    jobTypes: string[];
    whatsappNumber: string | null;
    contactNumber: string | null;
    registeredDate: string;
    stagesCompleted: number;
    stagesTotal: number;
    currentStage: CandidateStageKey | null;
    // The Candidates list's Status (absent from an older server).
    workflowStatus?: WorkflowStatus | null;
    analyst: AllocationAnalystRef | null;
    assignedDate: string | null;
};

export type AllocationCandidateList = {
    items: AllocationCandidate[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number; totalItems?: number; hasNextPage?: boolean; hasPreviousPage?: boolean };
    filters: AllocationFilters & { status: AllocationStatus; analystId: string | null; search: string | null };
};

// The list's filters, all applied on the server before paging (totals are those of the whole
// filtered list). stage: the current stage (first not completed) or COMPLETE.
export type AllocationFilters = {
    registeredFrom?: string | null;
    registeredTo?: string | null;
    jobType?: string | null;
    workflowStatus?: WorkflowStatus["code"] | null;
    stage?: CandidateStageKey | "COMPLETE" | null;
};

export type AllocationAnalyst = { analystId: string; name: string; email?: string; assignedCount: number };

export type AllocationAnalysts = {
    // Active Analysts: the only users candidates can be assigned to.
    analysts: AllocationAnalyst[];
    // No longer active (or no longer Analysts) but still holding candidates.
    unavailableAnalysts: AllocationAnalyst[];
    unallocatedCount: number;
};

export type AssignResult = { assigned: number; reassigned: number; unchanged: number; byAnalyst: { analystId: string; name: string; count: number }[] };

export function listAllocationCandidates(
    token: string,
    params: { status: AllocationStatus; analystId?: string; search?: string; page: number; filters?: AllocationFilters },
    signal?: AbortSignal,
): Promise<AllocationCandidateList> {
    const query = new URLSearchParams({ status: params.status, page: String(params.page) });
    if (params.analystId) query.set("analystId", params.analystId);
    if (params.search) query.set("search", params.search);
    for (const [key, value] of Object.entries(params.filters ?? {})) if (value) query.set(key, value);
    return apiRequest<AllocationCandidateList>(`/api/admin/work-allocation/candidates?${query.toString()}`, { token, signal });
}

export function listAllocationAnalysts(token: string, signal?: AbortSignal): Promise<AllocationAnalysts> {
    return apiRequest<AllocationAnalysts>("/api/admin/work-allocation/analysts", { token, signal });
}

// One request for the whole selection: all or nothing on the server.
export function assignCandidates(
    token: string,
    body: { candidateIds: string[]; allocations: { analystId: string; count: number }[]; reassign: boolean },
): Promise<AssignResult> {
    return apiRequest<AssignResult>("/api/admin/work-allocation/assign", { method: "POST", token, body });
}

export type AutoAllocateResult = {
    selectedCount: number;
    eligibleCount: number;
    allocatedCount: number;
    analystCount: number;
    equalAllocationCount: number;
    remainderCount: number;
    conflictsCount: number;
    skippedCount: number;
    unallocatedCandidateIds: string[];
    skippedCandidateIds: string[];
    byAnalyst: { analystId: string; name: string; count: number }[];
};

// Automatic equal distribution across selected analysts.
export function autoAllocateCandidates(
    token: string,
    body: { candidateIds: string[]; analystIds: string[] },
): Promise<AutoAllocateResult> {
    return apiRequest<AutoAllocateResult>("/api/admin/work-allocation/auto-allocate", { method: "POST", token, body });
}

export function unassignCandidates(token: string, candidateIds: string[]): Promise<{ unassigned: number; alreadyUnallocated: number }> {
    return apiRequest("/api/admin/work-allocation/unassign", { method: "POST", token, body: { candidateIds, confirm: true } });
}

