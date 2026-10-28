// Candidate -> Google Sheet row (Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md,
// Sections 6.1-6.3). Pure: no database, no Google API, no clock, no logging.
// The same input always gives the same SHEET_COLUMN_COUNT field-ordered strings
// (canonical order, sheetSchema.js; the adapter places them by header name), so
// incremental sync and reconciliation compare like with like.
//
// Input, the candidate aggregate (CANDIDATE_AGGREGATE_SELECT below):
//   user      - the users row
//   stages    - its candidate_stages rows
//   documents - its documents rows
//   details   - its candidate_additional_details row, or null
// The Candidate Form columns come from `details` ONLY: the canonical record,
// which holds a submitted answer only once an Admin / Manager confirmed it
// (candidateFormFieldConfirmService.js). candidate_form_response (the raw
// submission) is never read here. No details, or a value never confirmed: "".
// DISTANCE TO BUCHAREST (KM) is derived from the confirmed City in Romania
// (the same dataset as the form, romaniaCities.js), never stored.
// Stage completion and the "current" document of each type come from the
// same functions the Admin candidate page uses (candidateService.js), never
// from a second copy of those rules.
//
// TEST NUMBER has no confirmed system data and is always "". DRIVING LICENSE
// and POLICE REP FM are document columns with no document type in the
// application, so no candidate can have one: they are always "Not Submitted"
// (Sheet output only; nothing is stored). There is one SCAN column only.
//
// Document columns (PASSPORT, POLICE REP SRI LANKA (the SL_VERIFIED police
// report; SL_NORMAL reports have no mirror column), POLICE REP ROMANIA,
// MEDICAL, SCAN, NIC COPY, POLICE REPORT APPLIED, VIDEO) show the submission date of the candidate's
// current document of that type (and variant): its received_date, as the
// Sri Lanka calendar date YYYY-MM-DD. A replacement or re-upload is a new
// document row (the old one is kept as SUPERSEDED), so the current
// document's received_date is the latest submission. No current document:
// exactly "Not Submitted". These are display values only: nothing reads them
// back, and "Not Submitted" is never an instruction to delete anything.

import { SHEET_COLUMNS, SYSTEM_CANDIDATE_ID_FIELD, assertSheetRow } from "./sheetSchema.js";
import { CANDIDATE_DOCUMENT_TYPES, automaticStageMissing, currentOf, stageList } from "./candidateService.js";
import { businessDateOf } from "../utils/businessDay.js";
import { findRomanianCity } from "../utils/romaniaCities.js";
import { jobTypesLabel } from "./jobTypeCatalog.js";

export const DOCUMENT_NOT_SUBMITTED = "Not Submitted";

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
    stages: { select: { stage: true, completed: true, completedAt: true, notes: true, testResult: true, testDate: true } },
    documents: {
        where: { documentType: { in: Object.keys(CANDIDATE_DOCUMENT_TYPES) } },
        select: {
            documentId: true, documentType: true, documentVariant: true, verificationStatus: true,
            receivedDate: true, createdDate: true, policeSubmittedDate: true,
        },
    },
    additionalDetails: {
        select: {
            nameAsInPassport: true, maritalStatus: true, bloodGroup: true, height: true, weightKg: true, drivingLicence: true,
            canReadDrawings: true, teamLeadingSkills: true, otherLanguages: true, email: true, city: true, district: true,
            dsDivision: true, gnDivision: true, cityInRomania: true, otherJobCategory: true, otherJobSkills: true, otherJobSkills2: true,
            englishKnowledge: true, tshirtSize: true, pantSize: true, shoeSize: true, fatherFullName: true, fatherPassportNumber: true,
            fatherBirthday: true, fatherAlive: true, motherFullName: true, motherPassportNumber: true, motherBirthday: true,
            motherAlive: true, wifeFullName: true, spousePassportNumber: true, wifeBirthday: true, child1Name: true, child2Name: true,
            child3Name: true, guardianName: true, guardianRelationship: true, guardianNic: true, guardianBirthday: true,
            guardianPhone: true, guardianAddress: true,
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

// A stored Yes / No: "YES", "NO", or "" when not recorded.
const yesNo = (value) => (value === true ? "YES" : value === false ? "NO" : "");

// A DECIMAL as a plain number ("70.5"; Prisma reads it as a Decimal object).
const decimal = (value) => (value === null || value === undefined || value === "" ? "" : String(Number(value)));

// ---------------------------------------------------------------- mapping

// The candidate's current document row of a type (and variant, for police
// reports), by the application's own rule; null when there is none.
function currentDocument(documents, documentType, variant) {
    const ofType = documents.filter((d) => d.documentType === documentType && (variant === undefined || d.documentVariant === variant));
    const current = currentOf(ofType);
    return current ? documents.find((d) => d.documentId === current.documentId) ?? null : null;
}

// The current document's submission date (Sri Lanka calendar date,
// YYYY-MM-DD), or "Not Submitted" when there is no current document.
// received_date is required in the database; a current document without a
// usable one can't be shown truthfully, so the candidate isn't mapped.
function documentCell(documents, documentType, variant) {
    const current = currentDocument(documents, documentType, variant);
    if (!current) return DOCUMENT_NOT_SUBMITTED;
    const submittedAt = toDate(current.receivedDate);
    if (!submittedAt) throw new SheetMappingError("A current document has no submission date");
    return businessDateOf(submittedAt);
}

// The field-ordered cells for one candidate (canonical order).
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
    const details = aggregate.details && typeof aggregate.details === "object" ? aggregate.details : {};
    const romanianCity = findRomanianCity(details.cityInRomania);

    const values = {
        testNumber: "",
        passportNumber: text(user.passportId),
        // The stored meaning, not the column names: other_name holds the surname, first_name
        // the other (given) names (candidateService.js parseCandidateBody).
        surname: text(user.otherName),
        otherNames: text(user.firstName),
        testDate: text(stages.get("TEST_DETAILS")?.testDate),
        birthday: dateOnly(user.dateOfBirth),
        passportExpiryDate: dateOnly(user.passportExpiryDate),
        // "No Preferred Type" is stored as its code (NO_PREFERENCE); the Sheet shows the label.
        job: text(jobTypesLabel(user.job)),
        idNumber: text(user.nic),
        address: text(user.address),
        whatsappNumber: text(user.whatsappNumber),
        contactNumber: text(user.contactNumber),
        passportCopy: documentCell(documents, "PASSPORT"),
        policeReportSriLankaVerified: documentCell(documents, "POLICE_REPORT", "SL_VERIFIED"),
        policeReportRomania: documentCell(documents, "POLICE_REPORT", "ROMANIA"),
        medical: documentCell(documents, "MEDICAL"),
        scan: documentCell(documents, "SCAN"),
        drivingLicence: DOCUMENT_NOT_SUBMITTED,
        nationalId: documentCell(documents, "NIC"),
        policeReportApplied: documentCell(documents, "POLICE_SLIP"),
        submitDate: dateOnly(policeSlip?.policeSubmittedDate),
        policeReportFm: DOCUMENT_NOT_SUBMITTED,
        videos: documentCell(documents, "SKILL_VIDEO"),
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
        visaSubmissionStatus: stageStatus(stages.get("VISA_SUBMISSION")),
        visaApprovalStatus: stageStatus(stages.get("VISA_APPROVAL")),
        finalizingJobStatus: stageStatus(stages.get("FINALIZING_JOB")),
        recordStatus,
        registeredAt: utcTimestamp(user.createdDate),
        lastMirroredAt: utcTimestamp(mirrored),
        [SYSTEM_CANDIDATE_ID_FIELD]: user.uniqueId,
        nameAsInPassport: text(details.nameAsInPassport),
        civilStatus: text(details.maritalStatus),
        bloodGroup: text(details.bloodGroup),
        height: text(details.height),
        weightKg: decimal(details.weightKg),
        hasDrivingLicence: yesNo(details.drivingLicence),
        canReadDrawings: yesNo(details.canReadDrawings),
        teamLeadingSkills: yesNo(details.teamLeadingSkills),
        otherLanguages: text(details.otherLanguages),
        email: text(details.email),
        city: text(details.city),
        district: text(details.district),
        dsDivision: text(details.dsDivision),
        gnDivision: text(details.gnDivision),
        cityInRomania: text(details.cityInRomania),
        distanceToBucharestKm: romanianCity ? String(romanianCity.distanceKm) : "",
        otherJobCategory: text(details.otherJobCategory),
        otherSkills1: text(details.otherJobSkills),
        otherSkills2: text(details.otherJobSkills2),
        englishKnowledge: text(details.englishKnowledge),
        shirtSize: text(details.tshirtSize),
        waistSize: text(details.pantSize),
        shoeSize: text(details.shoeSize),
        fatherName: text(details.fatherFullName),
        fatherPassportNumber: text(details.fatherPassportNumber),
        fatherBirthday: dateOnly(details.fatherBirthday),
        fatherAlive: yesNo(details.fatherAlive),
        motherName: text(details.motherFullName),
        motherPassportNumber: text(details.motherPassportNumber),
        motherBirthday: dateOnly(details.motherBirthday),
        motherAlive: yesNo(details.motherAlive),
        spouseName: text(details.wifeFullName),
        spousePassportNumber: text(details.spousePassportNumber),
        spouseBirthday: dateOnly(details.wifeBirthday),
        child1Name: text(details.child1Name),
        child2Name: text(details.child2Name),
        child3Name: text(details.child3Name),
        guardianName: text(details.guardianName),
        guardianRelationship: text(details.guardianRelationship),
        guardianNic: text(details.guardianNic),
        guardianBirthday: dateOnly(details.guardianBirthday),
        guardianPhone: text(details.guardianPhone),
        guardianAddress: text(details.guardianAddress),
    };

    // Emitted by schema position, so a missing value can never shift a column.
    return assertSheetRow(SHEET_COLUMNS.map((c) => {
        if (!Object.hasOwn(values, c.field)) throw new SheetMappingError(`No mapping for column ${c.column}`);
        return values[c.field];
    }));
}
