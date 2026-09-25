import { apiRequest } from "./client";

// Read-only admin dashboard API (src/routes/admin.js, /api/admin/*).
// Every call needs the signed-in admin's token.

export type DocumentType = "PASSPORT" | "POLICE_SLIP" | "POLICE_REPORT" | "MEDICAL" | "UNKNOWN";
export type VerificationStatus = "VERIFIED" | "REVIEW_REQUIRED";
export type RequirementStatus = "VERIFIED" | "REVIEW_REQUIRED" | "PENDING_REVIEW" | "MISSING";

export type ClientRef = { passportId: string; uniqueId: string; name: string | null };

// A file stored in a client folder (documents table).
export type DocumentItem = {
    documentId: string;
    documentType: string;
    processingStatus: string;
    verificationStatus: string;
    ocrConfidence: number | null;
    receivedDate: string;
    storedFilename: string;
    mimeType: string | null;
    fileSize: number | null;
    client: ClientRef | null;
};

// A received file waiting in pending/ for review (temporary_data).
export type PendingItem = {
    temporaryId: string;
    documentType: string;
    processingStatus: string;
    receivedDate: string;
    client: ClientRef | null;
};

export type Overview = {
    businessDate: string;
    kpis: { totalClients: number; totalDocuments: number; pendingReview: number; receivedToday: number };
    submissionsByStatus: Record<string, number>;
    submissionsByType: Record<string, number>;
    recentDocuments: DocumentItem[];
    reviewQueue: {
        total: number;
        pendingFiles: number;
        reviewRequiredDocuments: number;
        pendingByStatus: Record<string, number>;
        items: PendingItem[];
    };
};

export type DocumentListParams = {
    page?: number;
    pageSize?: number;
    documentType?: string;
    verificationStatus?: string;
    processingStatus?: string;
    passportId?: string;
    search?: string;
    receivedFrom?: string;
    receivedTo?: string;
    sort?: "receivedDate" | "ocrConfidence" | "documentType";
    order?: "asc" | "desc";
};

export type DocumentList = {
    items: DocumentItem[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
    summary: { total: number; byVerificationStatus: Record<string, number> };
};

export type ClientDetails = {
    client: {
        passportId: string;
        uniqueId: string;
        name: string | null;
        firstName: string;
        otherName: string | null;
        dateOfBirth: string | null;
        placeOfBirth: string | null;
        passportExpiryDate: string | null;
        whatsappNumber: string | null;
        contactNumber: string | null;
        address: string | null;
        job: string | null;
        createdDate: string;
        updatedDate: string;
    };
    documents: DocumentItem[];
    pendingItems: PendingItem[];
    requiredDocuments: { documentType: string; status: RequirementStatus; storedCount: number; pendingCount: number }[];
    missingDocumentTypes: string[];
    police: {
        latestSlip: { documentId: string; receivedDate: string; verificationStatus: string } | null;
        latestReport: { documentId: string; receivedDate: string; verificationStatus: string } | null;
    };
};

export function getOverview(token: string, signal?: AbortSignal): Promise<Overview> {
    return apiRequest<Overview>("/api/admin/overview", { token, signal });
}

export function listDocuments(token: string, params: DocumentListParams, signal?: AbortSignal): Promise<DocumentList> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    }
    const suffix = query.toString();
    return apiRequest<DocumentList>(`/api/admin/documents${suffix ? `?${suffix}` : ""}`, { token, signal });
}

export function getClientDetails(token: string, passportId: string, signal?: AbortSignal): Promise<ClientDetails> {
    return apiRequest<ClientDetails>(`/api/admin/clients/${encodeURIComponent(passportId)}`, { token, signal });
}
