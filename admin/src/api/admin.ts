import { apiRequest, apiRequestBlob } from "./client";

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

// ---------------------------------------------------------------- review (Checkpoint 3)

export type ReviewKind = "PENDING" | "DOCUMENT";
export type ReviewCategory = "IDENTITY" | "QUALITY" | "CONFLICT" | "OTHER";

export type ReviewQueueItem = {
    reviewId: string;
    kind: ReviewKind;
    documentType: string;
    processingStatus: string;
    verificationStatus: string | null;
    reviewReason: string | null; // null: processed before reasons were recorded
    reviewCategory: ReviewCategory | null;
    confidence: number | null;
    receivedDate: string;
    client: ClientRef | null;
};

export type ReviewQueueParams = {
    page?: number;
    pageSize?: number;
    kind?: "ALL" | ReviewKind;
    documentType?: string;
    reviewReason?: string;
    passportId?: string;
    order?: "asc" | "desc";
};

export type ReviewQueue = {
    items: ReviewQueueItem[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
    summary: {
        total: number;
        pending: number;
        documents: number;
        byReason: Record<string, number>;
        byCategory: Record<ReviewCategory, number>;
    };
};

// The PII-free processing summary saved by the pipeline (all fields optional:
// it grows over time and older submissions have none).
export type ProcessingSummary = {
    stage?: string;
    error?: string | null;
    processingStatus?: string;
    documentType?: string | null;
    typeSource?: string | null;
    extractionMethod?: string | null;
    ocrThresholding?: string | string[] | null;
    ocrRotateAuto?: boolean | boolean[] | null;
    ocrUpscaled?: boolean | null;
    confidence?: { extraction: number; classification: number; document: number; band: string; measuredBand?: string; flags: string[] } | null;
    passport?: { status: string; missingFields: string[]; mrzLinesFound: number; mrzCompositeCheckValid?: boolean | null; passportIdBand: string | null } | null;
    policeDate?: { status: string; kind: string | null } | null;
    passportAcceptance?: { accepted: boolean; failedConditions: string[] } | null;
    identity?: { status: string; reviewRequired: boolean; provisional: boolean; notes: string[] } | null;
    storage?: { checksum: string | null; placement: string; verificationStatus: string | null; documentStored: boolean; pendingCopy: boolean } | null;
    reconciliation?: { matched: string[]; filled: string[]; conflicts: string[]; skipped: string[] } | null;
};

export type ReviewItem = {
    reviewId: string;
    kind: ReviewKind;
    reviewReason: string | null;
    reviewCategory: ReviewCategory | null;
    document: {
        documentId: string | null;
        temporaryId: string | null;
        documentType: string;
        processingStatus: string;
        verificationStatus: string | null;
        receivedDate: string;
        confidence: number | null;
    };
    client: ClientRef | null;
    submission: { whatsappNumber: string; receivedDate: string } | null;
    processing: ProcessingSummary | null;
    file: { name: string; mimeType: string | null; size: number | null; location: "PENDING" | "CLIENT"; previewUrl: string | null };
    auditLog: AuditEntry[]; // newest first
    actions: ReviewActions | null;
};

// ---------------------------------------------------------------- review actions (Checkpoint 4)
// Only two actions exist: there is no reject.

export type ReviewAction = "APPROVE" | "KEEP_PENDING";

export type AuditEntry = {
    auditId: string;
    action: ReviewAction;
    adminId: string;
    adminName: string | null;
    reason: string | null;
    previousStatus: string;
    newStatus: string;
    createdDate: string;
};

type ActionAvailability = { available: boolean; code: string | null; message: string | null };
export type ReviewActions = { approve: ActionAvailability; keepPending: ActionAvailability };

export type ApproveResult = {
    action: "APPROVE";
    reviewId: string;
    document: { documentId: string; storedFilename: string | null; verificationStatus: "VERIFIED"; location: "CLIENT" };
    pendingCopyRemoved: boolean | null;
    audit: AuditEntry;
};

export type KeepPendingResult = { action: "KEEP_PENDING"; reviewId: string; audit: AuditEntry };

export function getReviewQueue(token: string, params: ReviewQueueParams, signal?: AbortSignal): Promise<ReviewQueue> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    }
    const suffix = query.toString();
    return apiRequest<ReviewQueue>(`/api/admin/review${suffix ? `?${suffix}` : ""}`, { token, signal });
}

export function getReviewItem(token: string, reviewId: string, signal?: AbortSignal): Promise<ReviewItem> {
    return apiRequest<ReviewItem>(`/api/admin/review/${encodeURIComponent(reviewId)}`, { token, signal });
}

export function approveReviewItem(token: string, reviewId: string, reason?: string): Promise<ApproveResult> {
    return apiRequest<ApproveResult>(`/api/admin/review/${encodeURIComponent(reviewId)}/approve`, { method: "POST", token, body: reason ? { reason } : {} });
}

export function keepReviewItemPending(token: string, reviewId: string, reason: string): Promise<KeepPendingResult> {
    return apiRequest<KeepPendingResult>(`/api/admin/review/${encodeURIComponent(reviewId)}/keep-pending`, { method: "POST", token, body: { reason } });
}

// The file comes through the backend with the admin's token; the page shows
// it from a local blob: URL, so no storage URL or credential is exposed.
export function getReviewFile(token: string, previewUrl: string, signal?: AbortSignal): Promise<Blob> {
    return apiRequestBlob(previewUrl, { token, signal });
}
