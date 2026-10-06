// Candidate -> Google Sheet row (Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md,
// Sections 6.1-6.3). Pure: no database, no Google API, no clock, no logging.
// The same input always gives the same 40 strings, in Sheet order
// (sheetSchema.js), so incremental sync and reconciliation compare like with
// like.
//
// Input, the candidate aggregate (CANDIDATE_AGGREGATE_SELECT below):
//   user      - the users row
//   stages    - its candidate_stages rows
//   documents - its documents rows
// Stage completion and the "current" document of each type come from the
// same functions the Admin candidate page uses (candidateService.js), never
// from a second copy of those rules.
//
// Columns with no confirmed system data (TEST NUMBER, DRIVING LICIAN,
// POLICE REP FM) are always "". There is one SCAN column only.

import { SHEET_COLUMNS, SYSTEM_CANDIDATE_ID_FIELD, assertSheetRow } from "./sheetSchema.js";
import { CANDIDATE_DOCUMENT_TYPES, automaticStageMissing, currentOf, stageList } from "./candidateService.js";

export const DOCUMENT_STATUS_MISSING = "MISSING";

export const STAGE_STATUS = Object.freeze({ COMPLETED: "COMPLETED", INCOMPLETE: "INCOMPLETE" });

export const RECORD_STATUS = Object.freeze({
    ACTIVE: "ACTIVE",
    DELETED_INACTIVE: "DELETED / INACTIVE",
    DUPLICATE_ROW: "DUPLICATE ROW",
});

// What a future database read must select for one candidate (Prisma
// `select`), so the mapper always gets every field it reads. Not used to
// query anything here.
export const CANDIDATE_AGGREGATE_SELECT = Object.freeze({
    passportId: true, uniqueId: true, firstName: true, otherName: true, dateOfBirth: true, placeOfBirth: true,
    passportExpiryDate: true, passportIssueDate: true, address: true, job: true, nic: true, jobExperience: true,
    whatsappNumber: true, contactNumber: true, nationality: true, sex: true, createdDate: true,
    stages: { select: { stage: true, completed: true, completedAt: true, notes: true, jobId: true, testResult: true, testDate: true } },
    documents: {
        where: { documentType: { in: Object.keys(CANDIDATE_DOCUMENT_TYPES) } },
        select: {
            documentId: true, documentType: true, documentVariant: true, verificationStatus: true,
            receivedDate: true, createdDate: true, policeSubmittedDate: true,
        },
    },
});

export class SheetMappingError extends Error {
    constructor(message) {
        super(message);
        this.name = "SheetMappingError";
    }
}

// ---------------------------------------------------------------- cell formatting

const text = (value) => (value === null || value === undefined ? "" : String(value));

function toDate(value) {
    if (value === null || value === undefined || value === "") return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

// YYYY-MM-DD, as the application formats date-only values.
const dateOnly = (value) => toDate(value)?.toISOString().slice(0, 10) ?? "";

// YYYY-MM-DDTHH:mm:ssZ (UTC, whole seconds).
const utcTimestamp = (value) => toDate(value)?.toISOString().replace(/\.\d{3}Z$/, "Z") ?? "";

const stageStatus = (stage) => (stage?.completed ? STAGE_STATUS.COMPLETED : STAGE_STATUS.INCOMPLETE);

// ---------------------------------------------------------------- mapping

// The candidate's current document row of a type (and variant, for police
// reports), by the application's own rule; null when there is none.
function currentDocument(documents, documentType, variant) {
    const ofType = documents.filter((d) => d.documentType === documentType && (variant === undefined || d.documentVariant === variant));
    const current = currentOf(ofType);
    return current ? documents.find((d) => d.documentId === current.documentId) ?? null : null;
}

// VERIFIED / REVIEW_REQUIRED as stored; MISSING when there is no current document.
const documentStatus = (documents, documentType, variant) =>
    currentDocument(documents, documentType, variant)?.verificationStatus ?? DOCUMENT_STATUS_MISSING;

// The 40 cells for one candidate, in Sheet order.
// options.mirroredAt (required): the LAST MIRRORED AT time, passed in so
//   the result is deterministic.
// options.recordStatus: ACTIVE unless the caller marks the row otherwise.
export function mapCandidateToSheetRow(aggregate, { mirroredAt, recordStatus = RECORD_STATUS.ACTIVE } = {}) {
    const user = aggregate?.user;
    if (!user || typeof user !== "object") {
        throw new SheetMappingError("A candidate aggregate with a user record is required");
    }
    // The row identity is users.unique_id only; never fall back to the
    // passport number or NIC.
    if (typeof user.uniqueId !== "string" || user.uniqueId.trim() === "") {
        throw new SheetMappingError("The candidate has no unique ID; it can't be mapped to a Sheet row");
    }
    const mirrored = toDate(mirroredAt);
    if (!mirrored) {
        throw new SheetMappingError("mirroredAt must be a valid date");
    }
    if (!Object.values(RECORD_STATUS).includes(recordStatus)) {
        throw new SheetMappingError("Unknown record status");
    }

    const stageRows = Array.isArray(aggregate.stages) ? aggregate.stages : [];
    const documents = (Array.isArray(aggregate.documents) ? aggregate.documents : [])
        .filter((d) => Object.hasOwn(CANDIDATE_DOCUMENT_TYPES, d.documentType));

    const stages = new Map(stageList(stageRows, automaticStageMissing(user, documents)).map((s) => [s.stage, s]));
    const policeSlip = currentDocument(documents, "POLICE_SLIP");

    const values = {
        testNumber: "",
        passportNumber: text(user.passportId),
        firstName: text(user.firstName),
        otherName: text(user.otherName),
        testDate: text(stages.get("TEST_DETAILS")?.testDate),
        birthday: dateOnly(user.dateOfBirth),
        passportExpiryDate: dateOnly(user.passportExpiryDate),
        job: text(user.job),
        idNumber: text(user.nic),
        address: text(user.address),
        whatsappNumber: text(user.whatsappNumber),
        contactNumber: text(user.contactNumber),
        passportCopy: documentStatus(documents, "PASSPORT"),
        policeReportSriLankaVerified: documentStatus(documents, "POLICE_REPORT", "SL_VERIFIED"),
        policeReportRomania: documentStatus(documents, "POLICE_REPORT", "ROMANIA"),
        medical: documentStatus(documents, "MEDICAL"),
        scan: documentStatus(documents, "SCAN"),
        drivingLicence: "",
        nationalId: documentStatus(documents, "NIC"),
        policeReportApplied: documentStatus(documents, "POLICE_SLIP"),
        submitDate: dateOnly(policeSlip?.policeSubmittedDate),
        policeReportSriLankaNormal: documentStatus(documents, "POLICE_REPORT", "SL_NORMAL"),
        policeReportFm: "",
        videos: documentStatus(documents, "SKILL_VIDEO"),
        placeOfBirth: text(user.placeOfBirth),
        sex: text(user.sex),
        nationality: text(user.nationality),
        passportIssueDate: dateOnly(user.passportIssueDate),
        jobExperience: text(user.jobExperience),
        candidateDetailsNote: text(stages.get("CANDIDATE_DETAILS")?.notes),
        testDetailsStatus: stageStatus(stages.get("TEST_DETAILS")),
        candidateDetailsStatus: stageStatus(stages.get("CANDIDATE_DETAILS")),
        documentSubmissionStatus: stageStatus(stages.get("DOCUMENT_SUBMISSION")),
        ivsInterviewStatus: stageStatus(stages.get("IVS_INTERVIEW")),
        visaApprovalStatus: stageStatus(stages.get("VISA_APPROVAL")),
        finalizingJobStatus: stageStatus(stages.get("FINALIZING_JOB")),
        recordStatus,
        registeredAt: utcTimestamp(user.createdDate),
        lastMirroredAt: utcTimestamp(mirrored),
        [SYSTEM_CANDIDATE_ID_FIELD]: user.uniqueId,
    };

    // Emitted by schema position, so a missing value can never shift a column.
    return assertSheetRow(SHEET_COLUMNS.map((c) => {
        if (!Object.hasOwn(values, c.field)) throw new SheetMappingError(`No mapping for column ${c.column}`);
        return values[c.field];
    }));
}
