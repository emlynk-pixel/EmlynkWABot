import { apiRequest, uploadToSignedUrl } from "./client";

// Admin > Candidates (src/routes/admin.js, /api/admin/candidates/*).
// Reads for every admin; changes need REVIEWER or above (checked on the server).

export const CANDIDATE_STAGES = [
    "TEST_DETAILS",
    "CANDIDATE_DETAILS",
    "DOCUMENT_SUBMISSION",
    "IVS_INTERVIEW",
    "VISA_APPROVAL",
    "FINALIZING_JOB",
] as const;
export type CandidateStageKey = (typeof CANDIDATE_STAGES)[number];

export const STAGE_LABELS: Record<CandidateStageKey, string> = {
    TEST_DETAILS: "Test details",
    CANDIDATE_DETAILS: "Candidate details",
    DOCUMENT_SUBMISSION: "Document submission",
    IVS_INTERVIEW: "IVS interview",
    VISA_APPROVAL: "Visa approval",
    FINALIZING_JOB: "Finalizing the job",
};

export type CandidateDocumentType = "PASSPORT" | "NIC" | "SKILL_VIDEO" | "MEDICAL" | "POLICE_REPORT" | "AGREEMENT" | "AFFIDAVIT";

export const POLICE_REPORT_VARIANTS = [
    { value: "SL_VERIFIED", label: "SL Verified" },
    { value: "ROMANIA", label: "Romania" },
    { value: "SL_NORMAL", label: "SL Normal" },
] as const;
export const AFFIDAVIT_VARIANTS = [
    { value: "ENGLISH", label: "English Affidavit" },
    { value: "SINHALA", label: "Sinhala Affidavit" },
] as const;

export function variantLabel(variant: string | null): string | null {
    if (!variant) return null;
    return [...POLICE_REPORT_VARIANTS, ...AFFIDAVIT_VARIANTS].find((v) => v.value === variant)?.label ?? variant;
}

export type StageProgress = { stage: CandidateStageKey; completed: boolean };
// automatic: completed by the record's data (Candidate details, Document
// submission), with what is still missing; otherwise completed by an admin.
export const TEST_RESULT_OPTIONS = [
    { value: "PASS", label: "Pass" },
    { value: "FAIL", label: "Fail" },
] as const;
export type TestResult = (typeof TEST_RESULT_OPTIONS)[number]["value"];

// jobId / testResult / testDate (YYYY-MM-DD): recorded on Test details only, null elsewhere.
export type StageState = StageProgress & {
    completedAt: string | null;
    notes: string | null;
    automatic: boolean;
    missing: string[];
    jobId: string | null;
    testResult: TestResult | null;
    testDate: string | null;
};

export type CandidateListItem = {
    passportId: string;
    uniqueId: string;
    name: string | null;
    nic: string | null;
    jobTypes: string[];
    stages: StageProgress[];
};

export type CandidateList = {
    items: CandidateListItem[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
    filters: { search: string | null };
};

export type CandidateDocument = {
    documentId: string;
    originalFilename: string;
    verificationStatus: string;
    variant: string | null;
    receivedDate: string;
};

export type CandidateDetails = {
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
    documents: Record<CandidateDocumentType, CandidateDocument | null>;
    requiredDocuments: { documentType: CandidateDocumentType; included: boolean }[];
};

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

export type CallLogEntry = { callLogId: string; note: string; createdDate: string; adminName: string | null };

const base = (passportId: string) => `/api/admin/candidates/${encodeURIComponent(passportId)}`;

export function listCandidates(token: string, params: { page: number; pageSize: number; search?: string }, signal?: AbortSignal): Promise<CandidateList> {
    const query = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) });
    if (params.search) query.set("search", params.search);
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

export function updateCandidateStage(
    token: string,
    passportId: string,
    stage: CandidateStageKey,
    body: { completed?: boolean; notes?: string | null; jobId?: string | null; testResult?: TestResult | null; testDate?: string | null },
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

export function listCallLogs(token: string, passportId: string, signal?: AbortSignal): Promise<{ items: CallLogEntry[] }> {
    return apiRequest(`${base(passportId)}/call-logs`, { token, signal });
}

export function addCallLog(token: string, passportId: string, note: string): Promise<{ items: CallLogEntry[] }> {
    return apiRequest(`${base(passportId)}/call-logs`, { method: "POST", token, body: { note } });
}
