// Candidate deployment (Admin > Candidates).
//
// A candidate is a row in `users` (passport_id is the identity, as
// everywhere else); registration creates that row, it never makes a second
// record for the same person (passport ID and NIC are both unique).
//
// The deployment process has six stages. They are independent: any stage can
// be opened, edited and completed at any time, in any order. Two stages are
// completed by their data (CANDIDATE_DETAILS: the required details and a
// passport; DOCUMENT_SUBMISSION: the five required documents); the others by
// an admin, stored in candidate_stages.
//
// Documents uploaded here go into the same clients/{passport_id}/{type}/
// folders and `documents` rows as documents received on WhatsApp. An upload
// becomes the candidate's current (VERIFIED) document of its type; a previous
// VERIFIED one of that type is kept as SUPERSEDED (the existing replacement
// rule, clientDocumentService.js). Police reports and affidavits are kept per
// variant: each variant has its own current document, so a candidate can have
// all of them. Each upload is written to the audit log.
// The file itself goes from the admin's browser straight to storage, never
// through this API (see "direct uploads" below).

import crypto from "node:crypto";

import { validateDocumentFile, ALLOWED_MIME_TYPES, MAX_FILE_SIZE } from "../utils/fileValidation.js";
import { sha256Hex } from "../utils/fileChecksum.js";
import { clientName } from "../utils/clientName.js";
import { normalizePassportId } from "../utils/passportId.js";
import { normalizePhoneNumber } from "../utils/phoneNumber.js";
import { clientFolderPath, extensionForMimeType, standardFileName } from "../utils/storageNaming.js";
import { MAX_NAME_ATTEMPTS, removeObject } from "./permanentStorageService.js";
import { DOCUMENT_PROCESSING_STATUS_STORED, VERIFICATION_STATUS } from "./clientDocumentService.js";
import { clientSearchWhere } from "./adminClientService.js";
import { findUsersByWhatsappNumber } from "./userLookupService.js";

// ---------------------------------------------------------------- definitions

// In display order.
export const CANDIDATE_STAGES = Object.freeze([
    "TEST_DETAILS",
    "CANDIDATE_DETAILS",
    "DOCUMENT_SUBMISSION",
    "IVS_INTERVIEW",
    "VISA_APPROVAL",
    "FINALIZING_JOB",
]);

export const POLICE_REPORT_VARIANTS = Object.freeze(["SL_VERIFIED", "ROMANIA", "SL_NORMAL"]);


// Documents an admin can upload for a candidate. `variants`: the variant is
// required and must be one of these; otherwise none is accepted.
export const CANDIDATE_DOCUMENT_TYPES = Object.freeze({
    PASSPORT: {},
    NIC: {},
    SKILL_VIDEO: { video: true },
    MEDICAL: {},
    POLICE_SLIP: {},
    POLICE_REPORT: { variants: POLICE_REPORT_VARIANTS },
    SCAN: {},
});

// The five documents a candidate's submission must include (Document
// Submission stage): the passport (Candidate Details) and the four collected
// in Document Submission.
export const REQUIRED_SUBMISSION_DOCUMENTS = Object.freeze(["PASSPORT", "MEDICAL", "POLICE_REPORT", "SCAN"]);

// Skill videos only.
export const VIDEO_MIME_TYPES = Object.freeze(["video/mp4", "video/quicktime", "video/webm"]);

// A skill video may be up to 50 MB; every other candidate document keeps the
// 10 MB document limit (MAX_FILE_SIZE, shared with WhatsApp intake). The
// storage bucket's own file size limit must be at least the larger one.
export const MAX_VIDEO_FILE_SIZE = 50 * 1024 * 1024;
export const maxFileSizeFor = (documentType) => (CANDIDATE_DOCUMENT_TYPES[documentType]?.video ? MAX_VIDEO_FILE_SIZE : MAX_FILE_SIZE);
const tooLargeMessage = (limit) => `The file is larger than ${limit / (1024 * 1024)} MB.`;

const MAX_NAME_LENGTH = 100;
const MAX_ADDRESS_LENGTH = 500;
const MAX_TEXT_LENGTH = 2000;
const MAX_JOB_TYPES = 10;
const MAX_JOB_TYPE_LENGTH = 60;
const MAX_FILE_NAME_LENGTH = 200;
const MAX_NATIONALITY_LENGTH = 60;
// As printed on passports (ICAO 9303): male, female, unspecified.
export const SEX_VALUES = Object.freeze(["M", "F", "X"]);

// Sri Lankan NIC: old format 9 digits + V/X, new format 12 digits.
const NIC_PATTERN = /^(\d{9}[VX]|\d{12})$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Same rule as the client page's passport ID parameter.
const PASSPORT_ID_PARAM_PATTERN = /^[A-Za-z0-9]{1,20}$/;

export class CandidateError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = "CandidateError";
        this.status = status;
        this.code = code;
    }
}

export const isValidCandidateIdParam = (value) => typeof value === "string" && PASSPORT_ID_PARAM_PATTERN.test(value);
export const isCandidateStage = (value) => CANDIDATE_STAGES.includes(value);

// ---------------------------------------------------------------- job types

// "Construction Worker, Caregiver" <-> ["Construction Worker", "Caregiver"].
export function parseJobTypes(job) {
    if (typeof job !== "string") return [];
    return job.split(",").map((value) => value.trim()).filter(Boolean);
}

export function formatJobTypes(jobTypes) {
    return jobTypes.join(", ");
}

// ---------------------------------------------------------------- validation

const isBlank = (value) => typeof value !== "string" || value.trim() === "";

function text(body, field, errors, { required = false, max = MAX_TEXT_LENGTH } = {}) {
    const value = body[field];
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
        if (required) errors.push({ field, message: "is required" });
        return null;
    }
    if (typeof value !== "string") {
        errors.push({ field, message: "must be text" });
        return null;
    }
    const trimmed = value.trim();
    if (trimmed.length > max) {
        errors.push({ field, message: `must be at most ${max} characters` });
        return null;
    }
    return trimmed;
}

function date(body, field, errors) {
    const value = body[field];
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
        errors.push({ field, message: "must be a date (YYYY-MM-DD)" });
        return null;
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        errors.push({ field, message: "must be a real date" });
        return null;
    }
    return parsed;
}

// Stored in the same normalized form as WhatsApp sender numbers (94771234567),
// so the WhatsApp lookup compares like with like.
function phone(body, field, errors, options = {}) {
    const value = text(body, field, errors, { required: options.required, max: 30 });
    if (value === null) return null;
    const normalized = normalizePhoneNumber(value);
    if (!normalized) errors.push({ field, message: "must be a phone number (for example 0771234567 or +94771234567)" });
    return normalized;
}

function jobTypes(body, errors) {
    const value = body.jobTypes;
    if (!Array.isArray(value) || value.length === 0) {
        errors.push({ field: "jobTypes", message: "must list at least one job type" });
        return null;
    }
    if (value.length > MAX_JOB_TYPES) {
        errors.push({ field: "jobTypes", message: `must list at most ${MAX_JOB_TYPES} job types` });
        return null;
    }
    const cleaned = [];
    for (const item of value) {
        if (typeof item !== "string" || item.trim() === "" || item.includes(",") || item.trim().length > MAX_JOB_TYPE_LENGTH) {
            errors.push({ field: "jobTypes", message: `each job type must be text without commas, at most ${MAX_JOB_TYPE_LENGTH} characters` });
            return null;
        }
        const name = item.trim();
        if (!cleaned.some((existing) => existing.toLowerCase() === name.toLowerCase())) cleaned.push(name);
    }
    return cleaned;
}

// Registration (creating) and the Candidate Details stage (updating) take the
// same details; only registration takes the passport ID (it is the identity
// and is never changed afterwards) and the optional comment.
// Returns { values } or { errors: [{ field, message }] }.
export function parseCandidateBody(body, { creating }) {
    const errors = [];
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { errors: [{ field: "body", message: "must be a JSON object" }] };
    }

    const values = {};
    if (creating) {
        const raw = text(body, "passportId", errors, { required: true, max: 20 });
        if (raw !== null) {
            const passportId = normalizePassportId(raw);
            if (!passportId) errors.push({ field: "passportId", message: "must be a passport number (6 to 9 letters and digits)" });
            else values.passportId = passportId;
        }
        values.comment = text(body, "comment", errors);
    }

    values.otherName = text(body, "surname", errors, { required: true, max: MAX_NAME_LENGTH });
    values.firstName = text(body, "otherNames", errors, { required: true, max: MAX_NAME_LENGTH });
    // Optional here (registration and saving details); required to complete
    // Candidate Details (automaticStageMissing), like the passport document.
    values.address = text(body, "address", errors, { max: MAX_ADDRESS_LENGTH });
    values.jobExperience = text(body, "jobExperience", errors, { required: true });
    // Optional passport and contact details: empty is stored as NULL.
    values.placeOfBirth = text(body, "placeOfBirth", errors, { max: MAX_NAME_LENGTH });
    values.dateOfBirth = date(body, "dateOfBirth", errors);
    values.passportExpiryDate = date(body, "passportExpiryDate", errors);
    values.passportIssueDate = date(body, "passportIssueDate", errors);
    if (values.passportIssueDate && values.passportExpiryDate && values.passportIssueDate >= values.passportExpiryDate) {
        errors.push({ field: "passportIssueDate", message: "must be before the passport expiry date" });
    }
    values.nationality = text(body, "nationality", errors, { max: MAX_NATIONALITY_LENGTH });
    const sex = text(body, "sex", errors, { max: 1 });
    if (sex !== null && !SEX_VALUES.includes(sex.toUpperCase())) errors.push({ field: "sex", message: `must be one of: ${SEX_VALUES.join(", ")}` });
    values.sex = sex === null ? null : sex.toUpperCase();
    // Required to register. On an update it may be left out: a number on
    // record is locked (updateCandidateDetails keeps it), and Candidate
    // Details can't complete without one (automaticStageMissing).
    values.whatsappNumber = phone(body, "whatsappNumber", errors, { required: creating });
    values.contactNumber = phone(body, "contactNumber", errors);

    const nic = text(body, "nic", errors, { required: true, max: 12 });
    if (nic !== null) {
        const normalized = nic.toUpperCase().replace(/\s/g, "");
        if (!NIC_PATTERN.test(normalized)) errors.push({ field: "nic", message: "must be a Sri Lankan NIC (9 digits and V or X, or 12 digits)" });
        else values.nic = normalized;
    }

    const types = jobTypes(body, errors);
    if (types) values.job = formatJobTypes(types);

    return errors.length ? { errors } : { values };
}

export const TEST_RESULTS = Object.freeze(["PASS", "FAIL"]);

const MAX_JOB_ID_LENGTH = 50;

// Stage update: { completed?: boolean, notes?: string | null }, and for
// TEST_DETAILS also { jobId?: string | null, testResult?: "PASS" | "FAIL" |
// null, testDate?: "YYYY-MM-DD" | null }. A field left out is unchanged;
// null (or empty text) clears it.
export function parseStageBody(body, stage) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { errors: [{ field: "body", message: "must be a JSON object" }] };
    }
    const errors = [];
    const values = {};
    if (body.completed !== undefined) {
        if (typeof body.completed !== "boolean") errors.push({ field: "completed", message: "must be true or false" });
        else values.completed = body.completed;
    }
    if (body.notes !== undefined) {
        values.notes = text(body, "notes", errors);
    }
    for (const field of ["jobId", "testResult", "testDate"]) {
        if (body[field] !== undefined && stage !== "TEST_DETAILS") errors.push({ field, message: "is only recorded for the Test details stage" });
    }
    if (stage === "TEST_DETAILS") {
        if (body.jobId !== undefined) {
            values.jobId = text(body, "jobId", errors, { max: MAX_JOB_ID_LENGTH });
        }
        if (body.testResult !== undefined) {
            if (body.testResult === null) values.testResult = null;
            else if (TEST_RESULTS.includes(body.testResult)) values.testResult = body.testResult;
            else errors.push({ field: "testResult", message: `must be one of: ${TEST_RESULTS.join(", ")}` });
        }
        if (body.testDate !== undefined) {
            values.testDate = date(body, "testDate", errors);
        }
    }
    if (!errors.length && Object.keys(values).length === 0 && body.notes === undefined) {
        errors.push({ field: "body", message: "must contain completed, notes, or (Test details) jobId, testResult or testDate" });
    }
    return errors.length ? { errors } : { values };
}

// A call: when it took place (date and time with its offset, e.g.
// "2026-10-02T14:30:00+05:30"; omitted = now) and a short note of what the
// candidate said. A call can't be in the future (a few minutes of clock
// difference are allowed).
const CALL_NOTE_MAX_LENGTH = 500;
const CALL_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

// A real calendar date and time (JavaScript would turn 30 February into 2 March).
function parseCallTime(value) {
    if (typeof value !== "string" || !CALL_TIME_PATTERN.test(value)) return null;
    const [year, month, day, hour, minute] = value.slice(0, 16).split(/[-T:]/).map(Number);
    const check = new Date(Date.UTC(year, month - 1, day, hour, minute));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) {
        return null;
    }
    return new Date(value);
}

export function parseCallLogBody(body, { now = new Date() } = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { errors: [{ field: "body", message: "must be a JSON object" }] };
    }
    const errors = [];
    const note = text(body, "note", errors, { required: true, max: CALL_NOTE_MAX_LENGTH });
    let calledAt = null;
    if (body.calledAt !== undefined && body.calledAt !== null && body.calledAt !== "") {
        const parsed = parseCallTime(body.calledAt);
        if (!parsed || Number.isNaN(parsed.getTime())) errors.push({ field: "calledAt", message: "must be a date and time" });
        else if (parsed.getTime() > now.getTime() + CLOCK_SKEW_MS) errors.push({ field: "calledAt", message: "can't be in the future" });
        else calledAt = parsed;
    }
    return errors.length ? { errors } : { values: { note, calledAt } };
}

// ---------------------------------------------------------------- reading

const userSelect = {
    passportId: true, uniqueId: true, firstName: true, otherName: true, dateOfBirth: true, placeOfBirth: true,
    passportExpiryDate: true, address: true, job: true, nic: true, jobExperience: true, whatsappNumber: true,
    contactNumber: true, nationality: true, sex: true, passportIssueDate: true,
};

const isoDate = (value) => (value ? value.toISOString().slice(0, 10) : null);

// Stages completed by their data, not by an admin: Candidate Details when
// the required details and a passport are on record, Document Submission
// when the five required documents are. They follow the record (a document
// received on WhatsApp counts; a superseded one doesn't). The other stages
// have no data of their own and are completed by an admin.
export const AUTOMATIC_STAGES = Object.freeze(["CANDIDATE_DETAILS", "DOCUMENT_SUBMISSION"]);

// documents: rows with documentType and verificationStatus. Returns
// { CANDIDATE_DETAILS: [missing…], DOCUMENT_SUBMISSION: [missing…] }.
// Exported (with stageList and currentOf) for the Google Sheet mirror
// (candidateSheetMapper.js), so the Sheet shows exactly what this page shows.
export function automaticStageMissing(user, documents) {
    const has = (type) => documents.some((d) => d.documentType === type && d.verificationStatus !== VERIFICATION_STATUS.SUPERSEDED);
    const hasVariant = (type, variant) => documents.some((d) => d.documentType === type && d.documentVariant === variant && d.verificationStatus !== VERIFICATION_STATUS.SUPERSEDED);
    const details = [];
    if (isBlank(user.otherName)) details.push("surname");
    if (isBlank(user.firstName)) details.push("other names");
    if (isBlank(user.address)) details.push("address");
    if (isBlank(user.nic)) details.push("NIC");
    if (!parseJobTypes(user.job).length) details.push("job type");
    if (isBlank(user.jobExperience)) details.push("job experience");
    if (isBlank(user.whatsappNumber)) details.push("WhatsApp number");
    if (!has("PASSPORT")) details.push("passport document");

    const submissionMissing = [];
    if (!has("MEDICAL")) submissionMissing.push("medical");
    if (!hasVariant("POLICE_REPORT", "SL_VERIFIED")) submissionMissing.push("sl verified police report");
    if (!hasVariant("POLICE_REPORT", "ROMANIA")) submissionMissing.push("romania police report");
    if (!has("SCAN")) submissionMissing.push("scans");

    return {
        CANDIDATE_DETAILS: details,
        DOCUMENT_SUBMISSION: submissionMissing,
    };
}

// Every stage in order: saved notes, and completion (automatic stages from
// their data, with what is still missing; the others as an admin saved it).
export function stageList(rows, missingByStage) {
    const byStage = new Map(rows.map((row) => [row.stage, row]));
    return CANDIDATE_STAGES.map((stage) => {
        const row = byStage.get(stage);
        const missing = missingByStage[stage];
        // Recorded on TEST_DETAILS only; null on every other stage.
        const test = { jobId: row?.jobId ?? null, testResult: row?.testResult ?? null, testDate: isoDate(row?.testDate) };
        return missing
            ? { stage, automatic: true, completed: missing.length === 0, completedAt: null, notes: row?.notes ?? null, missing, ...test }
            : { stage, automatic: false, completed: Boolean(row?.completed), completedAt: row?.completedAt ?? null, notes: row?.notes ?? null, missing: [], ...test };
    });
}

// Of some documents, the current one: the newest VERIFIED, otherwise the
// newest waiting for review. SUPERSEDED never counts.
export function currentOf(documents) {
    const live = documents
        .filter((d) => d.verificationStatus !== VERIFICATION_STATUS.SUPERSEDED)
        .sort((a, b) => b.receivedDate - a.receivedDate || b.createdDate - a.createdDate);
    const chosen = live.find((d) => d.verificationStatus === VERIFICATION_STATUS.VERIFIED) ?? live[0];
    return chosen
        ? {
            documentId: chosen.documentId,
            originalFilename: chosen.originalFilename,
            verificationStatus: chosen.verificationStatus,
            variant: chosen.documentVariant ?? null,
            receivedDate: chosen.receivedDate,
        }
        : null;
}

// The candidate's current document of each type. For a type with variants
// this is the newest of any variant (enough to say the type is included).
function currentDocuments(documents) {
    const current = {};
    for (const type of Object.keys(CANDIDATE_DOCUMENT_TYPES)) {
        current[type] = currentOf(documents.filter((d) => d.documentType === type));
    }
    return current;
}

// Types with variants keep one current document per variant: a candidate
// can have all three police reports (SL Verified, Romania, SL Normal) and
// both affidavits. `untyped`: the current one with no known variant (a police
// report received on WhatsApp, or uploaded before variants were recorded).
function variantDocuments(documents) {
    const result = {};
    for (const [type, definition] of Object.entries(CANDIDATE_DOCUMENT_TYPES)) {
        if (!definition.variants) continue;
        const ofType = documents.filter((d) => d.documentType === type);
        result[type] = {
            byVariant: Object.fromEntries(definition.variants.map((variant) => [variant, currentOf(ofType.filter((d) => d.documentVariant === variant))])),
            untyped: currentOf(ofType.filter((d) => !definition.variants.includes(d.documentVariant))),
        };
    }
    return result;
}

function candidateSummary(user) {
    return {
        passportId: user.passportId,
        uniqueId: user.uniqueId,
        name: clientName(user),
        nic: user.nic ?? null,
        jobTypes: parseJobTypes(user.job),
    };
}

export const CANDIDATE_LIST_DEFAULTS = Object.freeze({ page: 1, pageSize: 25 });

export function parseCandidateListQuery(query = {}) {
    const errors = [];
    const params = { ...CANDIDATE_LIST_DEFAULTS };
    const single = (field) => {
        const value = query[field];
        if (value === undefined || value === "") return undefined;
        if (typeof value !== "string") {
            errors.push({ field, message: "must be given once" });
            return undefined;
        }
        return value;
    };
    for (const [field, max] of [["page", 10_000], ["pageSize", 100]]) {
        const value = single(field);
        if (value === undefined) continue;
        if (!/^\d{1,6}$/.test(value) || Number(value) < 1 || Number(value) > max) {
            errors.push({ field, message: `must be a whole number from 1 to ${max}` });
        } else {
            params[field] = Number(value);
        }
    }
    const search = single("search");
    if (search !== undefined) {
        const trimmed = search.trim();
        if (trimmed.length > 100) errors.push({ field: "search", message: "must be at most 100 characters" });
        else if (trimmed) params.search = trimmed;
    }
    return errors.length ? { errors } : { params };
}

// The clients search (passport ID, unique ID, names, WhatsApp number), plus NIC.
export function candidateSearchWhere(search) {
    const where = clientSearchWhere(search);
    if (!where.AND) return where;
    return {
        AND: where.AND.map((word, index) => {
            const term = search.trim().split(/\s+/).filter(Boolean)[index];
            return { OR: [...word.OR, { nic: { contains: term, mode: "insensitive" } }] };
        }),
    };
}

// GET /api/admin/candidates
export async function listCandidates({ db, params }) {
    const where = params.search ? candidateSearchWhere(params.search) : {};
    const [total, users] = await Promise.all([
        db.candidate.count({ where }),
        db.candidate.findMany({
            where,
            select: {
                ...userSelect,
                stages: { select: { stage: true, completed: true } },
                documents: {
                    where: { documentType: { in: REQUIRED_SUBMISSION_DOCUMENTS } },
                    select: { documentType: true, verificationStatus: true },
                },
            },
            orderBy: [{ createdDate: "desc" }, { passportId: "asc" }],
            skip: (params.page - 1) * params.pageSize,
            take: params.pageSize,
        }),
    ]);
    return {
        items: users.map((user) => ({
            ...candidateSummary(user),
            stages: stageList(user.stages, automaticStageMissing(user, user.documents)).map(({ stage, completed }) => ({ stage, completed })),
        })),
        pagination: {
            page: params.page,
            pageSize: params.pageSize,
            total,
            totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
        },
        filters: { search: params.search ?? null },
    };
}

// The stored passport ID for a requested one: the exact row, otherwise the
// one row that matches ignoring case (legacy rows may be lowercase; registration
// compares the same way). Null when there is none, or more than one.
export async function resolveCandidatePassportId({ db, passportId }) {
    const exact = await db.candidate.findUnique({ where: { passportId }, select: { passportId: true } });
    if (exact) return exact.passportId;
    const rows = await db.candidate.findMany({
        where: { passportId: { equals: passportId, mode: "insensitive" } },
        select: { passportId: true },
        take: 2,
    });
    return rows.length === 1 ? rows[0].passportId : null;
}

// GET /api/admin/candidates/:passportId — null when there is no such candidate.
export async function getCandidate({ db, passportId }) {
    const user = await db.candidate.findUnique({
        where: { passportId },
        select: {
            ...userSelect,
            stages: { select: { stage: true, completed: true, completedAt: true, notes: true, jobId: true, testResult: true, testDate: true } },
            documents: {
                where: { documentType: { in: Object.keys(CANDIDATE_DOCUMENT_TYPES) } },
                select: {
                    documentId: true, documentType: true, originalFilename: true, verificationStatus: true,
                    documentVariant: true, receivedDate: true, createdDate: true,
                },
            },
        },
    });
    if (!user) return null;

    const documents = currentDocuments(user.documents);
    return {
        candidate: {
            ...candidateSummary(user),
            surname: user.otherName ?? null,
            otherNames: user.firstName,
            dateOfBirth: isoDate(user.dateOfBirth),
            placeOfBirth: user.placeOfBirth ?? null,
            passportExpiryDate: isoDate(user.passportExpiryDate),
            passportIssueDate: isoDate(user.passportIssueDate),
            nationality: user.nationality ?? null,
            sex: user.sex ?? null,
            address: user.address ?? null,
            jobExperience: user.jobExperience ?? null,
            whatsappNumber: user.whatsappNumber ?? null,
            contactNumber: user.contactNumber ?? null,
        },
        stages: stageList(user.stages, automaticStageMissing(user, user.documents)),
        documents,
        variantDocuments: variantDocuments(user.documents),
        requiredDocuments: REQUIRED_SUBMISSION_DOCUMENTS.map((documentType) => {
            if (documentType === "POLICE_REPORT") {
                const hasSLVerified = user.documents.some((d) => d.documentType === "POLICE_REPORT" && d.documentVariant === "SL_VERIFIED" && d.verificationStatus !== VERIFICATION_STATUS.SUPERSEDED);
                const hasRomania = user.documents.some((d) => d.documentType === "POLICE_REPORT" && d.documentVariant === "ROMANIA" && d.verificationStatus !== VERIFICATION_STATUS.SUPERSEDED);
                return { documentType, included: hasSLVerified && hasRomania };
            }
            return {
                documentType,
                included: Boolean(documents[documentType]),
            };
        }),
    };
}

// ---------------------------------------------------------------- writing

const isUniqueViolation = (error) => error?.code === "P2002";
const uniqueTarget = (error) => [].concat(error?.meta?.target ?? []).join(",");

// Next free business reference: one more than the highest numeric unique ID,
// four digits at least (0001, 0002, …), like the existing records.
async function nextUniqueId(db) {
    const rows = await db.candidate.findMany({ select: { uniqueId: true } });
    const highest = rows.reduce((max, { uniqueId }) => (/^\d+$/.test(uniqueId) ? Math.max(max, Number(uniqueId)) : max), 0);
    return String(highest + 1).padStart(4, "0");
}

async function assertNicFree(db, nic, exceptPassportId) {
    const holder = await db.candidate.findUnique({ where: { nic }, select: { passportId: true } });
    if (holder && holder.passportId !== exceptPassportId) {
        throw new CandidateError(409, "NIC_EXISTS", "Another candidate is already registered with this NIC.");
    }
}

// A WhatsApp number identifies the sender of documents (identityVerificationService.js).
// One already on another record would make that person's matches ambiguous,
// so it is refused rather than shared.
async function assertWhatsappFree(db, whatsappNumber, exceptPassportId) {
    if (!whatsappNumber) return;
    const { users } = await findUsersByWhatsappNumber(whatsappNumber, { db });
    if (users.some((user) => user.passportId !== exceptPassportId)) {
        throw new CandidateError(409, "WHATSAPP_EXISTS", "Another candidate is already registered with this WhatsApp number.");
    }
}

// POST /api/admin/candidates. An existing passport ID is never registered
// again (409 with the existing record's passport ID, so the admin can open it).
export async function createCandidate({ db, values }) {
    // Case-insensitive, like the passport lookup (legacy rows may be lowercase).
    const existing = await db.candidate.findFirst({
        where: { passportId: { equals: values.passportId, mode: "insensitive" } },
        select: { passportId: true },
    });
    if (existing) {
        const error = new CandidateError(409, "CANDIDATE_EXISTS", "A candidate with this passport ID is already registered.");
        error.passportId = existing.passportId;
        throw error;
    }
    await assertNicFree(db, values.nic);
    await assertWhatsappFree(db, values.whatsappNumber);

    const { comment, ...details } = values;
    // A parallel registration can take the same unique ID: try the next one.
    for (let attempt = 0; attempt < 5; attempt++) {
        const uniqueId = await nextUniqueId(db);
        try {
            await db.$transaction(async (tx) => {
                await tx.candidate.create({ data: { ...details, uniqueId } });
                if (comment) {
                    await tx.candidateStage.create({ data: { passportId: values.passportId, stage: "CANDIDATE_DETAILS", notes: comment } });
                }
            });
            return { passportId: values.passportId, uniqueId };
        } catch (error) {
            if (!isUniqueViolation(error)) throw error;
            const target = uniqueTarget(error);
            if (/unique_id|uniqueId/.test(target)) continue;
            if (/nic/.test(target)) throw new CandidateError(409, "NIC_EXISTS", "Another candidate is already registered with this NIC.");
            if (/whatsapp/.test(target)) throw new CandidateError(409, "WHATSAPP_EXISTS", "Another candidate is already registered with this WhatsApp number.");
            throw new CandidateError(409, "CANDIDATE_EXISTS", "A candidate with this passport ID is already registered.");
        }
    }
    throw new CandidateError(503, "TRY_AGAIN", "The candidate could not be registered. Please try again.");
}

async function requireCandidate(db, passportId) {
    const user = await db.candidate.findUnique({ where: { passportId }, select: userSelect });
    if (!user) throw new CandidateError(404, "NOT_FOUND", "Candidate not found");
    return user;
}

// PUT /api/admin/candidates/:passportId (Candidate Details stage).
// A WhatsApp number already on record is never changed here: it is what
// documents sent on WhatsApp are matched by. One can only be added when the
// record has none. Resubmitting the same number (the admin's form always
// does, since the field is read-only once set) is not an attempted change —
// compared after normalizing the stored value, so an older unnormalized
// record doesn't falsely look different from itself. A genuinely different
// number is refused outright rather than silently kept.
export async function updateCandidateDetails({ db, passportId, values }) {
    const user = await requireCandidate(db, passportId);
    await assertNicFree(db, values.nic, passportId);
    const { whatsappNumber, ...data } = values;
    if (user.whatsappNumber) {
        if (whatsappNumber && whatsappNumber !== normalizePhoneNumber(user.whatsappNumber)) {
            throw new CandidateError(409, "WHATSAPP_LOCKED", "The WhatsApp number is already set for this candidate and cannot be changed here.");
        }
    } else if (whatsappNumber) {
        await assertWhatsappFree(db, whatsappNumber, passportId);
        data.whatsappNumber = whatsappNumber;
    }
    try {
        await db.candidate.update({ where: { passportId }, data });
    } catch (error) {
        if (isUniqueViolation(error)) {
            const target = uniqueTarget(error);
            if (/whatsapp/.test(target)) throw new CandidateError(409, "WHATSAPP_EXISTS", "Another candidate is already registered with this WhatsApp number.");
            throw new CandidateError(409, "NIC_EXISTS", "Another candidate is already registered with this NIC.");
        }
        throw error;
    }
    return getCandidate({ db, passportId });
}

// PUT /api/admin/candidates/:passportId/stages/:stage. Automatic stages take
// notes only; their completion follows their data.
export async function updateStage({ db, passportId, stage, values, now = new Date() }) {
    const candidate = await getCandidate({ db, passportId });
    if (!candidate) throw new CandidateError(404, "NOT_FOUND", "Candidate not found");

    const current = candidate.stages.find((s) => s.stage === stage);
    if (current.automatic && values.completed !== undefined) {
        throw new CandidateError(409, "AUTOMATIC_STAGE", "This stage is completed automatically when its details and documents are on record.");
    }

    const data = {};
    if (values.completed !== undefined) {
        data.completed = values.completed;
        data.completedAt = values.completed ? (current.completed ? current.completedAt : now) : null;
    }
    if (values.notes !== undefined) data.notes = values.notes;
    if (stage === "TEST_DETAILS") {
        if (values.jobId !== undefined) data.jobId = values.jobId;
        if (values.testResult !== undefined) data.testResult = values.testResult;
        if (values.testDate !== undefined) data.testDate = values.testDate;
    }

    await db.candidateStage.upsert({
        where: { passportId_stage: { passportId, stage } },
        create: { passportId, stage, completed: false, ...data },
        update: data,
    });
    return getCandidate({ db, passportId });
}

// ---------------------------------------------------------------- uploads

// Video containers: MP4/MOV carry "ftyp" at byte 4, WebM starts with the EBML header.
function videoSignatureMatches(buffer, mimeType) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
    if (mimeType === "video/webm") return buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    return buffer.subarray(4, 8).toString("latin1") === "ftyp";
}

const UPLOAD_REJECTION_MESSAGES = {
    MISSING_MIME_TYPE: "The file has no type.",
    UNSUPPORTED_FILE_TYPE: "This file type is not accepted. Use PDF, JPG or PNG.",
    INVALID_FILE_SIZE: "The file is empty.",
    FILE_TOO_LARGE: `The file is larger than ${MAX_FILE_SIZE / (1024 * 1024)} MB.`,
    FILE_SIGNATURE_MISMATCH: "The file's content does not match its type.",
};

// A video document type (the skill video) takes videos only: a PDF or an
// image is refused, never checked as a document. Every other type takes
// PDF, JPEG or PNG (validateDocumentFile).
export function validateCandidateUpload({ documentType, mimeType, buffer }) {
    const definition = CANDIDATE_DOCUMENT_TYPES[documentType];
    if (definition?.video) {
        if (!mimeType) return UPLOAD_REJECTION_MESSAGES.MISSING_MIME_TYPE;
        if (!VIDEO_MIME_TYPES.includes(mimeType)) return "This file type is not accepted. Use MP4, MOV or WebM.";
        if (!buffer?.length) return "The file is empty.";
        if (buffer.length > MAX_VIDEO_FILE_SIZE) return tooLargeMessage(MAX_VIDEO_FILE_SIZE);
        return videoSignatureMatches(buffer, mimeType) ? null : UPLOAD_REJECTION_MESSAGES.FILE_SIGNATURE_MISMATCH;
    }
    const result = validateDocumentFile({ mimeType, fileSize: buffer?.length ?? 0, fileBuffer: buffer });
    if (result.valid) return null;
    return UPLOAD_REJECTION_MESSAGES[result.reason] ?? "The file was not accepted.";
}

// documentType ("type") and variant: { values } or { errors }.
export function parseUploadQuery(query = {}) {
    const errors = [];
    const documentType = typeof query.type === "string" ? query.type : undefined;
    const definition = documentType ? CANDIDATE_DOCUMENT_TYPES[documentType] : undefined;
    if (!definition) {
        errors.push({ field: "type", message: `must be one of: ${Object.keys(CANDIDATE_DOCUMENT_TYPES).join(", ")}` });
        return { errors };
    }
    const variant = typeof query.variant === "string" && query.variant !== "" ? query.variant : null;
    if (definition.variants) {
        if (!variant || !definition.variants.includes(variant)) errors.push({ field: "variant", message: `must be one of: ${definition.variants.join(", ")}` });
    } else if (variant) {
        errors.push({ field: "variant", message: "is not used for this document type" });
    }
    return errors.length ? { errors } : { values: { documentType, variant } };
}

// The name the browser reported for the file: only kept as
// documents.original_filename, never used in a storage path.
export function cleanOriginalFileName(value, fallback) {
    if (typeof value !== "string") return fallback;
    const name = value.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_FILE_NAME_LENGTH);
    return name || fallback;
}

// The file the browser says it will upload, checked by the same rules its
// bytes are checked by at finalization (validateCandidateUpload): the MIME
// type the document type accepts and the size limit. fileSize is optional
// (finalization knows the real size). Returns a message, or null.
export function checkDeclaredFile({ documentType, mimeType, fileSize }) {
    if (!mimeType) return UPLOAD_REJECTION_MESSAGES.MISSING_MIME_TYPE;
    if (CANDIDATE_DOCUMENT_TYPES[documentType]?.video) {
        if (!VIDEO_MIME_TYPES.includes(mimeType)) return "This file type is not accepted. Use MP4, MOV or WebM.";
    } else if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
        return UPLOAD_REJECTION_MESSAGES.UNSUPPORTED_FILE_TYPE;
    }
    if (fileSize === undefined) return null;
    if (fileSize <= 0) return UPLOAD_REJECTION_MESSAGES.INVALID_FILE_SIZE;
    if (fileSize > maxFileSizeFor(documentType)) return tooLargeMessage(maxFileSizeFor(documentType));
    return null;
}

// crypto.randomUUID() (v4): the staged object's name, chosen by the server.
const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const mimeTypeFrom = (value) => (typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : "");

// POST …/documents/upload-target: { type, variant?, mimeType, fileSize, fileName? }.
export function parseUploadTargetBody(body) {
    if (!isObject(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const parsed = parseUploadQuery(body);
    const errors = [...(parsed.errors ?? [])];
    if (!Number.isSafeInteger(body.fileSize) || body.fileSize < 0) errors.push({ field: "fileSize", message: "must be the file size in bytes" });
    if (errors.length) return { errors };
    return {
        values: {
            ...parsed.values,
            mimeType: mimeTypeFrom(body.mimeType),
            fileSize: body.fileSize,
        },
    };
}

// POST …/documents/finalize: { uploadId, type, variant?, mimeType, fileName? }.
export function parseFinalizeUploadBody(body) {
    if (!isObject(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const parsed = parseUploadQuery(body);
    const errors = [...(parsed.errors ?? [])];
    if (typeof body.uploadId !== "string" || !UPLOAD_ID_PATTERN.test(body.uploadId)) errors.push({ field: "uploadId", message: "must be the upload ID from upload-target" });
    if (errors.length) return { errors };
    return {
        values: {
            ...parsed.values,
            uploadId: body.uploadId,
            mimeType: mimeTypeFrom(body.mimeType),
            originalFileName: cleanOriginalFileName(body.fileName, null),
        },
    };
}

const isCollision = (error) => {
    const status = String(error?.statusCode ?? error?.status ?? "");
    return status === "409" || /already exists|duplicate/i.test(error?.message ?? "");
};

// Upload under the first free standard name (nic.pdf, nic_v2.pdf, …). Never overwrites.
async function uploadToFreeName({ bucket, folder, documentType, extension, firstAttempt, buffer, mimeType }) {
    for (let version = firstAttempt; version < firstAttempt + MAX_NAME_ATTEMPTS; version++) {
        const fileName = standardFileName(documentType, version, extension);
        const storagePath = `${folder}/${fileName}`;
        const { error } = await bucket.upload(storagePath, buffer, { contentType: mimeType, upsert: false });
        if (!error) return { storagePath, fileName };
        if (isCollision(error)) continue;
        throw new Error(`Storage upload failed: ${error.message}`);
    }
    throw new Error(`No free file name after ${MAX_NAME_ATTEMPTS} attempts`);
}

// Move a staged upload to the first free standard name, like uploadToFreeName:
// a name already taken is skipped (checked first, and a move onto an
// existing object is refused by storage), so nothing is ever overwritten.
async function moveToFreeName({ bucket, from, folder, documentType, extension, firstAttempt }) {
    for (let version = firstAttempt; version < firstAttempt + MAX_NAME_ATTEMPTS; version++) {
        const fileName = standardFileName(documentType, version, extension);
        const storagePath = `${folder}/${fileName}`;
        const taken = await bucket.exists(storagePath);
        if (taken.data === true) continue;
        const { error } = await bucket.move(from, storagePath);
        if (!error) return { storagePath, fileName };
        if (isCollision(error)) continue;
        throw new Error(`Storage move failed: ${error.message}`);
    }
    throw new Error(`No free file name after ${MAX_NAME_ATTEMPTS} attempts`);
}

// The checks and the record every candidate document goes through, whoever
// moved its bytes: content, duplicate (SHA-256), the next standard name
// (place), then one transaction that supersedes the previous VERIFIED
// document of the type (of the type and variant, for a type with variants),
// creates the new one and audits it. A refused file is
// handed to discard (a staged upload is removed); a record that can't be
// written removes the placed object again.
async function storeCandidateDocument({ db, bucket, admin, passportId, documentType, variant, mimeType, buffer, originalFileName, now, place, discard }) {
    const refuse = async (error) => {
        await discard();
        throw error;
    };
    const rejection = validateCandidateUpload({ documentType, mimeType, buffer });
    if (rejection) await refuse(new CandidateError(422, "FILE_REJECTED", rejection));

    const fileSha256 = sha256Hex(buffer);
    const sameFile = await db.document.findFirst({ where: { passportId, fileSha256 }, select: { documentId: true } });
    if (sameFile) await refuse(new CandidateError(409, "DUPLICATE_FILE", "This exact file is already stored for this candidate."));

    const extension = extensionForMimeType(mimeType);
    const existingCount = await db.document.count({ where: { passportId, documentType } });
    let placed;
    try {
        placed = await place({ folder: clientFolderPath(passportId, documentType), documentType, extension, firstAttempt: existingCount + 1 });
    } catch (error) {
        await refuse(error);
    }
    const { storagePath, fileName } = placed;

    const documentId = crypto.randomUUID();
    // A type with variants is replaced per variant: a new Romania police
    // report supersedes the previous Romania one only, never SL Verified.
    const replaces = CANDIDATE_DOCUMENT_TYPES[documentType]?.variants ? { documentVariant: variant } : {};
    try {
        await db.$transaction(async (tx) => {
            const previous = await tx.document.findMany({
                where: { passportId, documentType, ...replaces, verificationStatus: VERIFICATION_STATUS.VERIFIED },
                select: { documentId: true },
            });
            if (previous.length) {
                await tx.document.updateMany({
                    where: { documentId: { in: previous.map((d) => d.documentId) } },
                    data: { verificationStatus: VERIFICATION_STATUS.SUPERSEDED },
                });
            }
            await tx.document.create({
                data: {
                    documentId,
                    passportId,
                    documentType,
                    originalFilename: originalFileName || `${documentType.toLowerCase()}${extension}`,
                    storedFilename: fileName,
                    storagePath,
                    mimeType,
                    fileSize: BigInt(buffer.length),
                    receivedDate: now,
                    processingStatus: DOCUMENT_PROCESSING_STATUS_STORED,
                    verificationStatus: VERIFICATION_STATUS.VERIFIED,
                    fileSha256,
                    documentVariant: variant,
                },
            });
            await tx.auditLog.create({
                data: {
                    auditId: crypto.randomUUID(),
                    adminId: admin.adminId,
                    action: "UPLOAD_DOCUMENT",
                    documentId,
                    passportId,
                    previousStatus: previous.length ? VERIFICATION_STATUS.VERIFIED : "NONE",
                    newStatus: VERIFICATION_STATUS.VERIFIED,
                    documentType,
                    fileSha256,
                    newValue: variant,
                },
            });
        });
    } catch (error) {
        // The object is not referenced by any row: remove it again.
        const cleanup = await removeObject(storagePath, { bucket });
        if (isUniqueViolation(error) && cleanup.removed) {
            throw new CandidateError(409, "DUPLICATE_FILE", "This exact file is already stored for this candidate.");
        }
        // Paths contain the passport number, so they stay out of the message.
        throw new Error(`Document record not written (${error.message}); ${cleanup.removed ? "upload removed" : `upload NOT removed (${cleanup.error})`}`);
    }

    return getCandidate({ db, passportId });
}

// A file whose bytes are already on the server, uploaded to its standard name.
// No HTTP route takes file bytes: an admin's upload goes browser -> storage
// directly (createUploadTarget, then finalizeUpload, below).
export async function uploadCandidateDocument({ db, bucket, admin, passportId, documentType, variant, mimeType, buffer, originalFileName, now = new Date() }) {
    await requireCandidate(db, passportId);
    return storeCandidateDocument({
        db, bucket, admin, passportId, documentType, variant, mimeType, buffer, originalFileName, now,
        place: (target) => uploadToFreeName({ bucket, buffer, mimeType, ...target }),
        discard: async () => {},
    });
}

// ---------------------------------------------------------------- direct uploads
//
// The file's bytes never pass through this API (on Vercel a request body is
// capped far below the file limits: 10 MB, 50 MB for a skill video). Instead:
//   1. createUploadTarget: the admin's browser describes the file (type,
//      variant, MIME type, size). Checked here as above; the answer is a
//      signed URL for ONE new object, upload_<uploadId><ext> in the
//      candidate's folder for that type. It expires (2 hours, set by
//      Supabase), can't overwrite anything, and names no other path.
//   2. The browser PUTs the file to that URL: browser -> storage.
//   3. finalizeUpload: the server reads the staged object back from storage
//      and gives its real bytes every check an upload had (content, size,
//      duplicate), then moves it to the standard name (medical_v2.pdf, …) and
//      writes the record, exactly as above. A staged file that fails is
//      removed. The object's path comes from the passport ID in the URL, the
//      type and the uploadId, so one candidate's upload can't be finalized
//      for another candidate or another type.
// An upload the browser never finalizes (tab closed between 2 and 3) stays
// staged; staged objects older than STAGED_UPLOAD_MAX_AGE_MS are removed the
// next time a target is requested for that candidate and type.

const STAGED_UPLOAD_PREFIX = "upload_";
export const STAGED_UPLOAD_MAX_AGE_MS = 60 * 60 * 1000;

const stagedUploadPath = (passportId, documentType, uploadId, extension) =>
    `${clientFolderPath(passportId, documentType)}/${STAGED_UPLOAD_PREFIX}${uploadId}${extension}`;

// Best effort: a failure here never blocks an upload.
async function removeStaleStagedUploads({ bucket, folder, now }) {
    try {
        const { data, error } = await bucket.list(folder, { search: STAGED_UPLOAD_PREFIX, limit: 100 });
        if (error || !Array.isArray(data)) return;
        const stale = data
            .filter((object) => object?.name?.startsWith(STAGED_UPLOAD_PREFIX))
            .filter((object) => Date.parse(object.created_at) < now.getTime() - STAGED_UPLOAD_MAX_AGE_MS)
            .map((object) => `${folder}/${object.name}`);
        if (stale.length) await bucket.remove(stale);
    } catch {
        // Left for the next request.
    }
}

// POST /api/admin/candidates/:passportId/documents/upload-target
export async function createUploadTarget({ db, bucket, passportId, documentType, mimeType, fileSize, now = new Date() }) {
    await requireCandidate(db, passportId);
    const rejection = checkDeclaredFile({ documentType, mimeType, fileSize });
    if (rejection) throw new CandidateError(422, "FILE_REJECTED", rejection);

    await removeStaleStagedUploads({ bucket, folder: clientFolderPath(passportId, documentType), now });
    const uploadId = crypto.randomUUID();
    const { data, error } = await bucket.createSignedUploadUrl(stagedUploadPath(passportId, documentType, uploadId, extensionForMimeType(mimeType)));
    // Paths contain the passport number, so they stay out of the message.
    if (error || !data?.signedUrl) throw new Error(`Signed upload URL not created: ${error?.message ?? "no URL returned"}`);
    return { uploadId, uploadUrl: data.signedUrl, maxFileSize: maxFileSizeFor(documentType) };
}

// POST /api/admin/candidates/:passportId/documents/finalize
export async function finalizeUpload({ db, bucket, admin, passportId, uploadId, documentType, variant, mimeType, originalFileName: providedFileName, now = new Date() }) {
    await requireCandidate(db, passportId);
    
    // Auto-rename original file name based on passport ID and document type
    const extension = extensionForMimeType(mimeType);
    const originalFileName = `${passportId} - ${documentType}${extension}`.toUpperCase();

    const declared = checkDeclaredFile({ documentType, mimeType });
    if (declared) throw new CandidateError(422, "FILE_REJECTED", declared);

    const stagedPath = stagedUploadPath(passportId, documentType, uploadId, extensionForMimeType(mimeType));
    const discard = () => removeObject(stagedPath, { bucket });
    const refuse = async (message) => {
        await discard();
        throw new CandidateError(422, "FILE_REJECTED", message);
    };

    const info = await bucket.info(stagedPath);
    if (info.error || !info.data) {
        const status = String(info.error?.statusCode ?? info.error?.status ?? "");
        if (status === "404" || status === "400" || /not.?found/i.test(info.error?.message ?? "")) {
            throw new CandidateError(404, "UPLOAD_NOT_FOUND", "The uploaded file was not found. Upload it again.");
        }
        throw new Error(`Staged upload not readable: ${info.error?.message ?? "no details"}`);
    }
    // Checked before reading it into memory: the signed URL itself can't cap the size.
    const size = Number(info.data.size);
    if (!(size > 0)) await refuse(UPLOAD_REJECTION_MESSAGES.INVALID_FILE_SIZE);
    if (size > maxFileSizeFor(documentType)) await refuse(tooLargeMessage(maxFileSizeFor(documentType)));
    // Stored with the type the browser sent while uploading: it must be the one checked here.
    const storedType = mimeTypeFrom(info.data.contentType);
    if (storedType && storedType !== mimeType) await refuse(UPLOAD_REJECTION_MESSAGES.FILE_SIGNATURE_MISMATCH);

    const downloaded = await bucket.download(stagedPath);
    if (downloaded.error || !downloaded.data) throw new Error(`Staged upload not readable: ${downloaded.error?.message ?? "no data"}`);
    const buffer = Buffer.isBuffer(downloaded.data) ? downloaded.data : Buffer.from(await downloaded.data.arrayBuffer());

    return storeCandidateDocument({
        db, bucket, admin, passportId, documentType, variant, mimeType, buffer, originalFileName, now,
        place: (target) => moveToFreeName({ bucket, from: stagedPath, ...target }),
        discard,
    });
}

// ---------------------------------------------------------------- removing a document
//
// Like Remove from Review (adminReviewActionService.js): an explicit reason,
// one audit entry (append-only, so it outlives the document), the record
// deleted in a transaction, then its file, unless another record still
// points at it. Only the candidate's current document of a candidate type
// can be removed: earlier versions (SUPERSEDED) stay as history, and the
// type's slot is left empty (not rolled back to the previous version).

export const REMOVED_STATUS = "REMOVED";
const MAX_REMOVE_REASON_LENGTH = 500;

// POST …/documents/:documentId/remove: { reason } (required).
export function parseRemoveDocumentBody(body) {
    if (!isObject(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const errors = [];
    const reason = text(body, "reason", errors, { required: true, max: MAX_REMOVE_REASON_LENGTH });
    return errors.length ? { errors } : { values: { reason } };
}

// POST /api/admin/candidates/:passportId/documents/:documentId/remove
export async function removeCandidateDocument({ db, bucket, admin, passportId, documentId, reason }) {
    await requireCandidate(db, passportId);
    const notFound = () => new CandidateError(404, "DOCUMENT_NOT_FOUND", "This document is no longer on record for this candidate. Refresh the page.");

    const outcome = await db.$transaction(async (tx) => {
        const row = await tx.document.findFirst({
            where: {
                documentId,
                passportId,
                documentType: { in: Object.keys(CANDIDATE_DOCUMENT_TYPES) },
                verificationStatus: { not: VERIFICATION_STATUS.SUPERSEDED },
            },
            select: { documentId: true, documentType: true, verificationStatus: true, storagePath: true, fileSha256: true, temporaryId: true },
        });
        if (!row) throw notFound();

        await tx.auditLog.create({
            data: {
                auditId: crypto.randomUUID(),
                adminId: admin.adminId,
                action: "REMOVE_DOCUMENT",
                temporaryId: row.temporaryId ?? null,
                documentId: row.documentId,
                passportId,
                previousStatus: row.verificationStatus,
                newStatus: REMOVED_STATUS,
                reason,
                documentType: row.documentType,
                fileSha256: row.fileSha256 ?? null,
            },
        });
        // Only if it is still the same record: a second, concurrent removal finds nothing.
        const { count } = await tx.document.deleteMany({ where: { documentId: row.documentId, passportId, verificationStatus: row.verificationStatus } });
        if (count !== 1) throw notFound();
        // The file goes only if no other record points at it.
        const shared = row.storagePath ? await tx.document.count({ where: { storagePath: row.storagePath } }) : 0;
        return { path: shared === 0 ? row.storagePath : null };
    });

    // Committed: the record is gone. Now its file.
    const removal = outcome.path ? await removeObject(outcome.path, { bucket }) : { removed: true };
    if (!removal.removed) {
        // The path holds the passport number, so only the document ID is logged.
        console.warn("Candidate document remove: file not deleted after the record was removed", { documentId, error: removal.error });
    }
    return getCandidate({ db, passportId });
}

// ---------------------------------------------------------------- call log

// candidate_call_logs.created_date holds when the call took place (the date
// and time the admin entered, or the moment it was noted). Newest call first.
export async function listCallLogs({ db, passportId }) {
    await requireCandidate(db, passportId);
    const rows = await db.candidateCallLog.findMany({
        where: { passportId },
        select: { callLogId: true, note: true, createdDate: true, admin: { select: { name: true } } },
        orderBy: [{ createdDate: "desc" }, { callLogId: "asc" }],
    });
    return {
        items: rows.map((row) => ({ callLogId: row.callLogId, note: row.note, calledAt: row.createdDate, adminName: row.admin?.name ?? null })),
    };
}

export async function addCallLog({ db, admin, passportId, values }) {
    await requireCandidate(db, passportId);
    // The user picks only HH:MM, so two calls in the same minute would get the
    // exact same createdDate and sort in random UUID order.  Preserve the user's
    // date/hour/minute but stamp the *current* seconds + milliseconds so that
    // entries within the same minute are still ordered by real insertion time.
    let storedDate = undefined;                       // let the DB default to now()
    if (values.calledAt) {
        const entered = new Date(values.calledAt);
        const now = new Date();
        entered.setSeconds(now.getSeconds(), now.getMilliseconds());
        storedDate = entered;
    }
    await db.candidateCallLog.create({
        data: {
            callLogId: crypto.randomUUID(),
            passportId,
            adminId: admin.adminId,
            note: values.note,
            ...(storedDate ? { createdDate: storedDate } : {}),
        },
    });
    return listCallLogs({ db, passportId });
}
