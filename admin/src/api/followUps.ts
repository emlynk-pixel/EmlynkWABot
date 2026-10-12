import { apiRequest } from "./client";
import type { DocumentStatusEntry, FollowUpStatus } from "./candidates";

// Priority Follow-Ups (src/routes/admin.js, /api/admin/follow-ups): call
// logs marked as needing attention, grouped by candidate. Listing and
// completing: every Candidates role; deleting: ADMIN and MANAGER (checked on
// the server). Deleting removes the follow-up only, never the call log.

export type FollowUpItem = {
    followUpId: string;
    status: FollowUpStatus;
    flaggedAt: string;
    flaggedByName: string | null;
    completedAt: string | null;
    completedByName: string | null;
    // The original call log (the source of truth for the note and the call).
    callLog: { callLogId: string; note: string; calledAt: string; adminName: string | null };
};

export type FollowUpGroup = {
    candidate: { passportId: string; uniqueId: string | null; name: string | null; whatsappNumber: string | null; contactNumber: string | null };
    // The candidate's documents now.
    documentStatus: DocumentStatusEntry[];
    followUps: FollowUpItem[];
};

export type FollowUpList = { status: FollowUpStatus; total: number; truncated: boolean; groups: FollowUpGroup[] };

export function listFollowUps(token: string, status: FollowUpStatus, signal?: AbortSignal): Promise<FollowUpList> {
    return apiRequest(`/api/admin/follow-ups?status=${status}`, { token, signal });
}

export function completeFollowUp(token: string, followUpId: string): Promise<{ followUp: FollowUpItem }> {
    return apiRequest(`/api/admin/follow-ups/${encodeURIComponent(followUpId)}/complete`, { method: "POST", token });
}

export function deleteFollowUp(token: string, followUpId: string): Promise<{ deleted: true; followUpId: string }> {
    return apiRequest(`/api/admin/follow-ups/${encodeURIComponent(followUpId)}`, { method: "DELETE", token });
}
