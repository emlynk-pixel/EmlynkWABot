import { apiRequest, apiRequestBlob } from "./client";

// Admin dashboard API (src/routes/admin.js, /api/admin/*). Reads, plus the
// review actions and corrections (all audited on the server). Every call
// needs the signed-in admin's token.

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
    // Police Workflow: final police reports by countdown status.
    police: { dueSoon: number; dueToday: number; overdue: number };
    // Required-document completeness of every client, now.
    clients: CompletenessSummary;
    requiredDocumentTypes: string[];
};

export type CompletenessSummary = {
    total: number;
    complete: number;
    incomplete: number;
    withMissing: number; // clients with at least one required type not received
    missingDocuments: number; // required documents not received, over all clients
    missingByType: Record<string, number>;
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
    complete: boolean;
    police: {
        latestSlip: { documentId: string; receivedDate: string; verificationStatus: string; policeSubmittedDate: string | null } | null;
        latestReport: { documentId: string; receivedDate: string; verificationStatus: string; policeSubmittedDate: string | null } | null;
        countdown: PoliceCountdown;
        // Police slip dates set or corrected by an admin (audit log), newest first.
        dateChanges: { auditId: string; documentId: string | null; adminName: string | null; previousDate: string | null; newDate: string | null; reason: string | null; createdDate: string }[];
    };
};

// ---------------------------------------------------------------- clients and missing documents

export type Completion = "COMPLETE" | "INCOMPLETE";
export type Requirement = { documentType: string; status: RequirementStatus; storedCount: number; pendingCount: number };

export type ClientListItem = {
    client: ClientRef & { whatsappNumber: string | null };
    completion: Completion;
    requirements: Requirement[];
    missingDocumentTypes: string[];
};

export type ClientList = {
    items: ClientListItem[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
    summary: CompletenessSummary;
    requiredDocumentTypes: string[];
};

export type ClientListParams = { page?: number; pageSize?: number; search?: string; completion?: Completion; missingType?: string };
export type MissingDocumentsParams = { page?: number; pageSize?: number; search?: string; documentType?: string };

function queryString(params: object): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    }
    const suffix = query.toString();
    return suffix ? `?${suffix}` : "";
}

export function listClients(token: string, params: ClientListParams, signal?: AbortSignal): Promise<ClientList> {
    return apiRequest<ClientList>(`/api/admin/clients${queryString(params)}`, { token, signal });
}

export function listMissingDocuments(token: string, params: MissingDocumentsParams, signal?: AbortSignal): Promise<ClientList> {
    return apiRequest<ClientList>(`/api/admin/documents/missing${queryString(params)}`, { token, signal });
}

// ---------------------------------------------------------------- daily report

export type DailyReport = {
    businessDate: string;
    today: string;
    isToday: boolean;
    timeZone: string;
    range: { start: string; end: string };
    // What happened on the selected business day.
    daily: {
        totalReceived: number;
        successfullyProcessed: number;
        failed: number;
        stillProcessing: number;
        storedInClientFolder: number;
        heldForReview: number;
        duplicates: number;
        unclear: number;
        temporary: number;
        byType: Record<string, number>;
        byStatus: Record<string, number>;
        adminActions: Record<string, number>;
    };
    // The state now (not historical).
    current: { asOf: string; clients: CompletenessSummary; police: { dueSoon: number; dueToday: number; overdue: number } };
};

export function getDailyReport(token: string, date: string | undefined, signal?: AbortSignal): Promise<DailyReport> {
    return apiRequest<DailyReport>(`/api/admin/reports/daily${queryString({ date })}`, { token, signal });
}

// ---------------------------------------------------------------- police workflow
// Calculated by the backend every time; dates are "YYYY-MM-DD" (Sri Lanka).

export type PoliceStatus = "OVERDUE" | "DUE_TODAY" | "DUE_SOON" | "PENDING" | "DATE_MISSING" | "NOT_UPLOADED" | "COMPLETED";

export type PoliceCountdown = {
    status: PoliceStatus;
    submittedDate: string | null;
    dueDate: string | null;
    daysRemaining: number | null; // negative when overdue; null when completed or no date
    slip: { documentId: string; verificationStatus: string; receivedDate: string | null } | null;
    report: { documentId: string; receivedDate: string | null } | null;
    slipAwaitingReview: boolean;
};

export type PoliceListItem = PoliceCountdown & { client: ClientRef };

export type PoliceList = {
    businessDate: string;
    items: PoliceListItem[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
    summary: { total: number; byStatus: Record<PoliceStatus, number> };
};

export type PoliceListParams = { page?: number; pageSize?: number; status?: PoliceStatus; search?: string };

export function getPoliceWorkflow(token: string, params: PoliceListParams, signal?: AbortSignal): Promise<PoliceList> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) query.set(key, String(value));
    }
    const suffix = query.toString();
    return apiRequest<PoliceList>(`/api/admin/police${suffix ? `?${suffix}` : ""}`, { token, signal });
}

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

// ---------------------------------------------------------------- review

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
        policeSubmittedDate: string | null; // stored police slips only
    };
    client: ClientRef | null;
    submission: { whatsappNumber: string; receivedDate: string } | null;
    processing: ProcessingSummary | null;
    file: { name: string; mimeType: string | null; size: number | null; location: "PENDING" | "CLIENT"; previewUrl: string | null };
    auditLog: AuditEntry[]; // newest first
    actions: ReviewActions | null;
};

// ---------------------------------------------------------------- review actions and corrections
// There is no reject. REMOVE_FROM_REVIEW is a manual admin decision that
// permanently deletes one waiting file and its record. The corrections
// (type, client, police slip date) keep the item where it is.
export type ReviewAction = "APPROVE" | "KEEP_PENDING" | "REMOVE_FROM_REVIEW" | "SET_DOCUMENT_TYPE" | "ASSIGN_CLIENT" | "SET_POLICE_DATE";

export type AuditEntry = {
    auditId: string;
    action: ReviewAction;
    adminId: string;
    adminName: string | null;
    reason: string | null;
    previousStatus: string;
    newStatus: string;
    policeSubmittedDate: string | null; // police slip approvals
    documentType: string | null; // kept for removed files
    previousValue: string | null; // corrections: value before
    newValue: string | null; // corrections: value after
    createdDate: string;
};

type ActionAvailability = { available: boolean; code: string | null; message: string | null };
// needsPoliceDate: a police slip without a stored submitted date is approved with one.
export type ReviewActions = {
    approve: ActionAvailability & { needsPoliceDate?: boolean };
    keepPending: ActionAvailability;
    remove?: ActionAvailability;
    setDocumentType?: ActionAvailability;
    assignClient?: ActionAvailability;
};

export type ApproveResult = {
    action: "APPROVE";
    reviewId: string;
    document: { documentId: string; storedFilename: string | null; verificationStatus: "VERIFIED"; location: "CLIENT"; policeSubmittedDate: string | null };
    pendingCopyRemoved: boolean | null;
    audit: AuditEntry;
};

export type KeepPendingResult = { action: "KEEP_PENDING"; reviewId: string; audit: AuditEntry };

export type RemoveResult = { action: "REMOVE_FROM_REVIEW"; reviewId: string; filesDeleted: boolean; audit: AuditEntry };
export type SetDocumentTypeResult = { action: "SET_DOCUMENT_TYPE"; reviewId: string; documentType: string; audit: AuditEntry };
export type AssignClientResult = { action: "ASSIGN_CLIENT"; reviewId: string; client: { passportId: string; uniqueId: string }; audit: AuditEntry };
export type SetPoliceDateResult = { action: "SET_POLICE_DATE"; documentId: string; policeSubmittedDate: string; audit: AuditEntry };

// Corrections of a waiting file; it stays pending and in the Review Queue.
export function setDocumentType(token: string, reviewId: string, documentType: string, reason: string): Promise<SetDocumentTypeResult> {
    return apiRequest<SetDocumentTypeResult>(`/api/admin/review/${encodeURIComponent(reviewId)}/document-type`, { method: "POST", token, body: { documentType, reason } });
}

export function assignClient(token: string, reviewId: string, passportId: string, reason: string): Promise<AssignClientResult> {
    return apiRequest<AssignClientResult>(`/api/admin/review/${encodeURIComponent(reviewId)}/assign-client`, { method: "POST", token, body: { passportId, reason } });
}

// Sets or corrects a stored police slip's submitted date.
export function setPoliceDate(token: string, documentId: string, policeSubmittedDate: string, reason: string): Promise<SetPoliceDateResult> {
    return apiRequest<SetPoliceDateResult>(`/api/admin/documents/${encodeURIComponent(documentId)}/police-date`, { method: "POST", token, body: { policeSubmittedDate, reason } });
}

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

export function approveReviewItem(token: string, reviewId: string, options: { reason?: string; policeSubmittedDate?: string } = {}): Promise<ApproveResult> {
    const body: Record<string, string> = {};
    if (options.reason) body.reason = options.reason;
    if (options.policeSubmittedDate) body.policeSubmittedDate = options.policeSubmittedDate;
    return apiRequest<ApproveResult>(`/api/admin/review/${encodeURIComponent(reviewId)}/approve`, { method: "POST", token, body });
}

// Permanently deletes the waiting file and its record; the reason is required.
export function removeFromReview(token: string, reviewId: string, reason: string): Promise<RemoveResult> {
    return apiRequest<RemoveResult>(`/api/admin/review/${encodeURIComponent(reviewId)}/remove`, { method: "POST", token, body: { reason } });
}

export function keepReviewItemPending(token: string, reviewId: string, reason: string): Promise<KeepPendingResult> {
    return apiRequest<KeepPendingResult>(`/api/admin/review/${encodeURIComponent(reviewId)}/keep-pending`, { method: "POST", token, body: { reason } });
}

// The file comes through the backend with the admin's token; the page shows
// it from a local blob: URL, so no storage URL or credential is exposed.
export function getReviewFile(token: string, previewUrl: string, signal?: AbortSignal): Promise<Blob> {
    return apiRequestBlob(previewUrl, { token, signal });
}
