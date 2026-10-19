import { apiRequest, uploadToSignedUrl } from "./client";
import type { CandidateJobAssignment } from "./jobs";

// Admin > Candidates (src/routes/admin.js, /api/admin/candidates/*).
// Reads for every admin; changes need ANALYST or above (checked on the server).

export const CANDIDATE_STAGES = [
    "TEST_DETAILS",
    "JOB_DETAILS",
    "CANDIDATE_DETAILS",
    "DOCUMENT_SUBMISSION",
    "IVS_INTERVIEW",
    "VISA_SUBMISSION",
    "VISA_APPROVAL",
    "FINALIZING_JOB",
] as const;
export type CandidateStageKey = (typeof CANDIDATE_STAGES)[number];

export const STAGE_LABELS: Record<CandidateStageKey, string> = {
    TEST_DETAILS: "Test details",
    JOB_DETAILS: "Job details",
    CANDIDATE_DETAILS: "Candidate details",
    DOCUMENT_SUBMISSION: "Document submission",
    IVS_INTERVIEW: "IVS interview",
    VISA_SUBMISSION: "Visa submission",
    VISA_APPROVAL: "Visa approval",
    FINALIZING_JOB: "Finalizing the job",
};

export type CandidateDocumentType = "PASSPORT" | "NIC" | "SKILL_VIDEO" | "MEDICAL" | "POLICE_SLIP" | "POLICE_REPORT" | "SCAN" | "VISA_SUBMISSION";

export const POLICE_REPORT_VARIANTS = [
    { value: "SL_VERIFIED", label: "SL Verified" },
    { value: "ROMANIA", label: "Romania" },
    { value: "SL_NORMAL", label: "SL Normal" },
] as const;

export function variantLabel(variant: string | null): string | null {
    if (!variant) return null;
    return [...POLICE_REPORT_VARIANTS].find((v) => v.value === variant)?.label ?? variant;
}

export type StageProgress = { stage: CandidateStageKey; completed: boolean };
// automatic: completed by the record's data (Candidate details, Document
// submission), with what is still missing; otherwise completed by an admin.
export const TEST_RESULT_OPTIONS = [
    { value: "PASS", label: "Pass" },
    { value: "FAIL", label: "Fail" },
] as const;
export type TestResult = (typeof TEST_RESULT_OPTIONS)[number]["value"];

// testAgentName / testId / testResult / testDate (YYYY-MM-DD): recorded on Test details only, null elsewhere.
// jobDate (YYYY-MM-DD) is saved on Job details; jobCode and clientName there are READ from the candidate's
// current Job assignment (never saved on the stage), null when the candidate has no current Job.
export type StageState = StageProgress & {
    completedAt: string | null;
    notes: string | null;
    automatic: boolean;
    missing: string[];
    testAgentName: string | null;
    testId: string | null;
    testResult: TestResult | null;
    testDate: string | null;
    jobDate: string | null;
    jobCode: string | null;
    clientName: string | null;
    // CURRENT: the candidate's current Job; HISTORICAL: their latest earlier Job (none is current); null: no Job ever.
    jobSource: "CURRENT" | "HISTORICAL" | null;
    jobStatus: "PROCESSING" | "COMPLETED" | "CANCELLED" | "REMOVED" | null;
};

// The derived workflow status of the candidate list (src/services/candidateWorkflowStatus.js): never edited, never stored.
export type WorkflowStatus = {
    code: "REGISTERED" | "STOPPED_WITH_TEST" | "JOB_ASSIGNED" | "FORM_SUBMITTED" | "DETAILS_VERIFIED" | "DOCUMENTS_VERIFIED" | "VISA_DOCUMENT_READY";
    label: string;
};

export type CandidateListItem = {
    passportId: string;
    uniqueId: string;
    name: string | null;
    nic: string | null;
    jobTypes: string[];
    workflowStatus: WorkflowStatus;
    stages: StageProgress[];
};

export type CandidateList = {
    items: CandidateListItem[];
    // Server-side paging (100 a page). total and totalItems are the same count.
    pagination: { page: number; pageSize: number; total: number; totalPages: number; totalItems?: number; hasNextPage?: boolean; hasPreviousPage?: boolean };
    filters: { search: string | null };
};

export type CandidateDocument = {
    documentId: string;
    originalFilename: string;
    verificationStatus: string;
    variant: string | null;
    receivedDate: string;
};

export type JobAssignments = { current: CandidateJobAssignment | null; history: CandidateJobAssignment[] };
export type VerificationState = { at: string; by: string | null } | null;

export type CandidateDetails = {
    // Manual verification (Verify details / Verify documents); null = not verified.
    verification: { details: VerificationState; documents: VerificationState };
    candidate: {
        passportId: string;
        uniqueId: string;
        name: string | null;
        nic: string | null;
        jobTypes: string[];
        surname: string | null;
        otherNames: string;
        dateOfBirth: string | null;
        placeOfBirth: string | null;
        passportExpiryDate: string | null;
        passportIssueDate: string | null;
        nationality: string | null;
        sex: CandidateSex | null;
        address: string | null;
        jobExperience: string | null;
        whatsappNumber: string | null;
        contactNumber: string | null;
    };
    stages: StageState[];
    // From the Job relation (job_candidate): the PROCESSING job the candidate is on, and the rest.
    jobAssignments: JobAssignments;
    // The current document of each type (for a type with variants: the newest of any variant).
    documents: Record<CandidateDocumentType, CandidateDocument | null>;
    // Police reports and affidavits: the current document of each variant (a
    // candidate can have all of them), and one with no known variant, if any.
    variantDocuments: Record<VariantDocumentType, VariantDocuments>;
    requiredDocuments: { documentType: CandidateDocumentType; included: boolean }[];
};

export type VariantDocumentType = "POLICE_REPORT";
export type VariantDocuments = { byVariant: Record<string, CandidateDocument | null>; untyped: CandidateDocument | null };

const isVariantType = (type: CandidateDocumentType): type is VariantDocumentType => type === "POLICE_REPORT";

// Every current document of a type: one for most types; for a police report
// or an affidavit, each stored variant (in their usual order), then an untyped one.
export function storedDocuments(details: CandidateDetails, type: CandidateDocumentType): CandidateDocument[] {
    if (!isVariantType(type)) return details.documents[type] ? [details.documents[type]] : [];
    const stored = details.variantDocuments[type];
    const order = POLICE_REPORT_VARIANTS;
    return [...order.map((v) => stored.byVariant[v.value] ?? null), stored.untyped].filter((d): d is CandidateDocument => d !== null);
}

// As printed on passports: male, female, unspecified.
export const SEX_OPTIONS = [
    { value: "M", label: "Male" },
    { value: "F", label: "Female" },
    { value: "X", label: "Unspecified" },
] as const;
export type CandidateSex = (typeof SEX_OPTIONS)[number]["value"];

// What the Candidate Details form sends (registration adds passportId and
// comment). Everything after jobExperience is optional ("" = not given).
// A WhatsApp number already on record is kept by the server.
export type CandidateDetailsInput = {
    surname: string;
    otherNames: string;
    nic: string;
    address: string;
    jobTypes: string[];
    jobExperience: string;
    nationality: string;
    sex: CandidateSex | "";
    dateOfBirth: string;
    placeOfBirth: string;
    passportIssueDate: string;
    passportExpiryDate: string;
    whatsappNumber: string;
    contactNumber: string;
};
export type CandidateRegistration = CandidateDetailsInput & { passportId: string; comment: string };

// A file registration couldn't upload, reported on the candidate's page
// (navigation state) until that document is on record.
export type FailedUpload = { documentType: CandidateDocumentType; message: string };

// One supported document type (and variant), as the candidate has it NOW:
// uploaded when there is a current document (the candidate page's rule:
// newest VERIFIED, otherwise the newest waiting for review; SUPERSEDED never
// counts). Read-only.
export type DocumentStatusEntry = {
    documentType: CandidateDocumentType;
    variant: string | null;
    uploaded: boolean;
    verificationStatus: string | null;
    receivedDate: string | null;
};

export type FollowUpStatus = "OPEN" | "COMPLETED";

// calledAt: when the call took place; note: what the candidate said.
// outcome: ANSWERED, or NO_ANSWER (the candidate did not pick up; no note).
// followUp: the call's newest Priority Follow-Up (OPEN = needs attention).
export type CallOutcome = "ANSWERED" | "NO_ANSWER";
export type CallLogEntry = {
    callLogId: string;
    note: string;
    outcome?: CallOutcome;
    calledAt: string;
    adminName: string | null;
    followUp?: { followUpId: string; status: FollowUpStatus; flaggedAt: string } | null;
};
// Something that happened to the candidate (Candidate History), from what is
// on record: documents, audited saves and stage completion dates. source
// (DOCUMENT_RECEIVED): STAFF (actorName uploaded it), WHATSAPP, or null when
// not known. fields (DETAILS_UPDATED): the changed fields' names, never values.
export type CandidateActivityKind =
    | "DOCUMENT_RECEIVED" | "DOCUMENT_VERIFIED" | "DOCUMENT_REMOVED"
    | "CANDIDATE_REGISTERED" | "DETAILS_UPDATED" | "ADDITIONAL_DETAILS_UPDATED"
    | "STAGE_COMPLETED" | "STAGE_REOPENED" | "STAGE_UPDATED";
export type CandidateActivity = {
    activityId: string;
    kind: CandidateActivityKind;
    occurredAt: string;
    actorName: string | null;
    source: "STAFF" | "WHATSAPP" | null;
    documentType: CandidateDocumentType | null;
    variant: string | null;
    stage: CandidateStageKey | null;
    fields: string[];
};

// documentStatus: the candidate's documents now, not when a call was made.
// activity: newest first, the latest 100 (activityTruncated: there is more).
export type CallLogList = { items: CallLogEntry[]; documentStatus?: DocumentStatusEntry[]; activity?: CandidateActivity[]; activityTruncated?: boolean };

const base = (passportId: string) => `/api/admin/candidates/${encodeURIComponent(passportId)}`;

export function listCandidates(token: string, params: { page: number; pageSize: number; search?: string; testResult?: "PASS" }, signal?: AbortSignal): Promise<CandidateList> {
    const query = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) });
    if (params.search) query.set("search", params.search);
    if (params.testResult) query.set("testResult", params.testResult);
    return apiRequest<CandidateList>(`/api/admin/candidates?${query.toString()}`, { token, signal });
}

export function getCandidate(token: string, passportId: string, signal?: AbortSignal): Promise<CandidateDetails> {
    return apiRequest<CandidateDetails>(base(passportId), { token, signal });
}

export function createCandidate(token: string, body: CandidateRegistration): Promise<{ passportId: string; uniqueId: string }> {
    return apiRequest(`/api/admin/candidates`, { method: "POST", token, body });
}

export function updateCandidate(token: string, passportId: string, body: CandidateDetailsInput): Promise<CandidateDetails> {
    return apiRequest<CandidateDetails>(base(passportId), { method: "PUT", token, body });
}

// Explicit manual verification of a candidate's details or documents (ADMIN and MANAGER; audited).
export function setCandidateVerification(token: string, passportId: string, kind: "DETAILS" | "DOCUMENTS", verified: boolean): Promise<CandidateDetails> {
    return apiRequest<CandidateDetails>(`${base(passportId)}/verification`, { method: "POST", token, body: { kind, verified } });
}

export function updateCandidateStage(
    token: string,
    passportId: string,
    stage: CandidateStageKey,
    body: { completed?: boolean; notes?: string | null; testAgentName?: string | null; testId?: string | null; testResult?: TestResult | null; testDate?: string | null; jobDate?: string | null },
): Promise<CandidateDetails> {
    return apiRequest<CandidateDetails>(`${base(passportId)}/stages/${stage}`, { method: "PUT", token, body });
}

// The file goes browser -> storage, never through the API: the API checks the
// description (type, variant, MIME type, size) and answers with a signed URL
// for one object; the file is PUT there; then the API checks the stored
// bytes and records the document.
export async function uploadCandidateDocument(token: string, passportId: string, documentType: CandidateDocumentType, file: File, variant?: string): Promise<CandidateDetails> {
    const described = { type: documentType, ...(variant ? { variant } : {}), mimeType: file.type, fileName: file.name };
    const target = await apiRequest<{ uploadId: string; uploadUrl: string }>(`${base(passportId)}/documents/upload-target`, {
        method: "POST", token, body: { ...described, fileSize: file.size },
    });
    await uploadToSignedUrl(target.uploadUrl, file);
    return apiRequest<CandidateDetails>(`${base(passportId)}/documents/finalize`, {
        method: "POST", token, body: { ...described, uploadId: target.uploadId },
    });
}

// Deletes the candidate's current document (record and file); the reason is
// required and kept in the audit log.
export function removeCandidateDocument(token: string, passportId: string, documentId: string, reason: string): Promise<CandidateDetails> {
    return apiRequest<CandidateDetails>(`${base(passportId)}/documents/${encodeURIComponent(documentId)}/remove`, { method: "POST", token, body: { reason } });
}

export function listCallLogs(token: string, passportId: string, signal?: AbortSignal): Promise<CallLogList> {
    return apiRequest(`${base(passportId)}/call-logs`, { token, signal });
}

// needsAttention: also mark the new call for follow-up, in the same request.
// outcome NO_ANSWER: record the attempt with no note.
export function addCallLog(token: string, passportId: string, call: { note?: string; calledAt: string; needsAttention?: true; outcome?: "NO_ANSWER" }): Promise<CallLogList> {
    return apiRequest(`${base(passportId)}/call-logs`, { method: "POST", token, body: call });
}

// Marks a call as needing attention (Priority Follow-Ups). The call log
// itself is not changed. 409 FOLLOW_UP_EXISTS: it already has an open one.
export function flagCallLog(token: string, passportId: string, callLogId: string): Promise<{ followUp: { followUpId: string; callLogId: string; status: FollowUpStatus; flaggedAt: string } }> {
    return apiRequest(`${base(passportId)}/call-logs/${encodeURIComponent(callLogId)}/follow-up`, { method: "POST", token });
}

// ---------------------------------------------------------------- additional details

// The same lists the server accepts (candidateAdditionalDetailsService.js).
export const TSHIRT_SIZES = ["XS", "S", "M", "L", "XL", "XXL"] as const;
export const PANT_SIZE_PRESETS = ["28", "30", "32", "34", "36", "38", "40", "42", "44", "46"] as const;
export const SHOE_SIZE_PRESETS = ["5", "6", "7", "8", "9", "10", "11", "12", "13"] as const;
export const MARITAL_STATUS_OPTIONS = [
    { value: "SINGLE", label: "Single" },
    { value: "MARRIED", label: "Married" },
    { value: "DIVORCED", label: "Divorced" },
    { value: "WIDOWED", label: "Widowed" },
    { value: "SEPARATED", label: "Separated" },
] as const;

// Dates as YYYY-MM-DD; every field may be null (collected over time).
export type AdditionalDetails = {
    nameAsInPassport: string | null;
    permanentAddress: string | null;
    birthday: string | null;
    tshirtSize: string | null;
    pantSize: string | null;
    shoeSize: string | null;
    fatherAlive: boolean | null;
    fatherFullName: string | null;
    fatherBirthday: string | null;
    motherAlive: boolean | null;
    motherFullName: string | null;
    motherBirthday: string | null;
    maritalStatus: string | null;
    wifeFullName: string | null;
    wifeBirthday: string | null;
    child1Name: string | null;
    child2Name: string | null;
    child3Name: string | null;
    otherJobSkills: string | null;
};

// details: null until saved. suggested: from the candidate's own record, to
// fill a new form (only stored when saved; the candidate is never changed).
export type AdditionalDetailsView = {
    passportId: string;
    details: AdditionalDetails | null;
    suggested: { nameAsInPassport: string | null; permanentAddress: string | null; birthday: string | null };
    updatedDate: string | null;
};

export function getAdditionalDetails(token: string, passportId: string, signal?: AbortSignal): Promise<AdditionalDetailsView> {
    return apiRequest<AdditionalDetailsView>(`${base(passportId)}/additional-details`, { token, signal });
}

// A full replacement: a field sent as null is cleared. expectedUpdatedDate:
// the updatedDate the form was loaded with (null: nothing saved yet); the
// server answers 409 if someone saved since, instead of overwriting them.
export function saveAdditionalDetails(token: string, passportId: string, body: AdditionalDetails, expectedUpdatedDate: string | null): Promise<AdditionalDetailsView> {
    return apiRequest<AdditionalDetailsView>(`${base(passportId)}/additional-details`, { method: "PUT", token, body: { ...body, expectedUpdatedDate } });
}

// Candidate Form share link (src/services/candidateFormShareService.js).
// state: LOCKED (no active link) | OPEN (an active link) | SUBMITTED.
export type FormShareState = "LOCKED" | "OPEN" | "SUBMITTED";
export type FormShareStatus = {
    passportId: string;
    state: FormShareState;
    submittedAt: string | null;
    link: { linkId: string; createdAt: string; createdByName: string | null; expiresAt: string; lockedUntil: string | null } | null;
};
// The URL carries the link secret: it is returned only here, once.
export type CreatedFormShareLink = { url: string; linkId: string; expiresAt: string; status: FormShareStatus };

export function getFormShareStatus(token: string, passportId: string, signal?: AbortSignal): Promise<FormShareStatus> {
    return apiRequest<FormShareStatus>(`${base(passportId)}/form-share`, { token, signal });
}

export function createFormShareLink(token: string, passportId: string): Promise<CreatedFormShareLink> {
    return apiRequest<CreatedFormShareLink>(`${base(passportId)}/form-share`, { method: "POST", token, body: {} });
}

export function revokeFormShareLink(token: string, passportId: string): Promise<FormShareStatus> {
    return apiRequest<FormShareStatus>(`${base(passportId)}/form-share/revoke`, { method: "POST", token, body: {} });
}

// What the candidate submitted through the Candidate Form, read only
// (src/services/candidateFormSubmissionService.js). Values are keyed by the form's
// own paths ("basic.fullName", "family.father.name", "guardian.nic", ...); dates
// are YYYY-MM-DD; an empty answer is null. `original` is what the form was
// prefilled with, `changed` the paths whose submitted value differs from it.
export type FormSubmissionState = "LOCKED" | "UNLOCKED" | "SUBMITTED";
export type FormSubmission = {
    passportId: string;
    formStatus: FormSubmissionState;
    submittedAt: string | null;
    submitted: Record<string, string | null> | null;
    original: Record<string, string | null> | null;
    changed: string[];
    // Differences from the record that can be confirmed one field at a time.
    pending: PendingChange[];
    // Staff decisions already taken on this submission (a field with one is no longer pending).
    reviews?: { field: string; status: "CONFIRMED" | "REJECTED" }[];
};

// A candidate-submitted value that differs from the record, for a field the record has a place for.
// current / submitted are in the form's representation (dates YYYY-MM-DD, sex MALE | FEMALE | OTHER).
export type PendingChange = { field: string; current: string | null; submitted: string | null };

export function getFormSubmission(token: string, passportId: string, signal?: AbortSignal): Promise<FormSubmission> {
    return apiRequest<FormSubmission>(`${base(passportId)}/form-submission`, { token, signal });
}

// Confirm ONE candidate-submitted field into the record (ADMIN, MANAGER). The server reads the new
// value from the stored submission; these values only detect a stale screen. Returns the refreshed state.
export function confirmFormField(
    token: string,
    passportId: string,
    body: { field: string; expectedCurrentValue: string | null; expectedSubmittedValue: string | null },
): Promise<FormSubmission> {
    return apiRequest<FormSubmission>(`${base(passportId)}/form-submission/confirm-field`, { method: "POST", token, body });
}

// Reject ("Revoke") ONE candidate-submitted field: the record is left as it is and the proposal is marked
// rejected for good (ADMIN, MANAGER). Same body as confirmFormField; returns the refreshed state.
export function rejectFormField(
    token: string,
    passportId: string,
    body: { field: string; expectedCurrentValue: string | null; expectedSubmittedValue: string | null },
): Promise<FormSubmission> {
    return apiRequest<FormSubmission>(`${base(passportId)}/form-submission/reject-field`, { method: "POST", token, body });
}
