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
// rule, clientDocumentService.js). Each upload is written to the audit log.

import crypto from "node:crypto";

import { validateDocumentFile, MAX_FILE_SIZE } from "../utils/fileValidation.js";
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
export const AFFIDAVIT_VARIANTS = Object.freeze(["ENGLISH", "SINHALA"]);

// Documents an admin can upload for a candidate. `variants`: the variant is
// required and must be one of these; otherwise none is accepted.
export const CANDIDATE_DOCUMENT_TYPES = Object.freeze({
    PASSPORT: {},
    NIC: {},
    SKILL_VIDEO: { video: true },
    MEDICAL: {},
    POLICE_REPORT: { variants: POLICE_REPORT_VARIANTS },
    AGREEMENT: {},
    AFFIDAVIT: { variants: AFFIDAVIT_VARIANTS },
});

// The five documents a candidate's submission must include (Document
// Submission stage): the passport (Candidate Details) and the four collected
// in Document Submission.
export const REQUIRED_SUBMISSION_DOCUMENTS = Object.freeze(["PASSPORT", "MEDICAL", "POLICE_REPORT", "AGREEMENT", "AFFIDAVIT"]);

// Skill videos only. Same size limit as every other document: the private
// bucket refuses larger objects.
export const VIDEO_MIME_TYPES = Object.freeze(["video/mp4", "video/quicktime", "video/webm"]);

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
function phone(body, field, errors) {
    const value = text(body, field, errors, { max: 30 });
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
    values.address = text(body, "address", errors, { required: true, max: MAX_ADDRESS_LENGTH });
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
    values.whatsappNumber = phone(body, "whatsappNumber", errors);
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

// Stage update: { completed?: boolean, notes?: string | null }.
export function parseStageBody(body) {
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
    if (!errors.length && values.completed === undefined && body.notes === undefined) {
        errors.push({ field: "body", message: "must contain completed or notes" });
    }
    return errors.length ? { errors } : { values };
}

export function parseCallLogBody(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { errors: [{ field: "body", message: "must be a JSON object" }] };
    }
    const errors = [];
    const note = text(body, "note", errors, { required: true });
    return errors.length ? { errors } : { values: { note } };
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
function automaticStageMissing(user, documents) {
    const has = (type) => documents.some((d) => d.documentType === type && d.verificationStatus !== VERIFICATION_STATUS.SUPERSEDED);
    const details = [];
    if (isBlank(user.otherName)) details.push("surname");
    if (isBlank(user.firstName)) details.push("other names");
    if (isBlank(user.address)) details.push("address");
    if (isBlank(user.nic)) details.push("NIC");
    if (!parseJobTypes(user.job).length) details.push("job type");
    if (isBlank(user.jobExperience)) details.push("job experience");
    if (!has("PASSPORT")) details.push("passport document");
    return {
        CANDIDATE_DETAILS: details,
        DOCUMENT_SUBMISSION: REQUIRED_SUBMISSION_DOCUMENTS.filter((type) => !has(type)).map((type) => type.toLowerCase().replace(/_/g, " ")),
    };
}

// Every stage in order: saved notes, and completion (automatic stages from
// their data, with what is still missing; the others as an admin saved it).
function stageList(rows, missingByStage) {
    const byStage = new Map(rows.map((row) => [row.stage, row]));
    return CANDIDATE_STAGES.map((stage) => {
        const row = byStage.get(stage);
        const missing = missingByStage[stage];
        return missing
            ? { stage, automatic: true, completed: missing.length === 0, completedAt: null, notes: row?.notes ?? null, missing }
            : { stage, automatic: false, completed: Boolean(row?.completed), completedAt: row?.completedAt ?? null, notes: row?.notes ?? null, missing: [] };
    });
}

// The candidate's current document of each type: the newest VERIFIED one,
// otherwise the newest one waiting for review. SUPERSEDED never counts.
function currentDocuments(documents) {
    const current = {};
    for (const type of Object.keys(CANDIDATE_DOCUMENT_TYPES)) {
        const ofType = documents
            .filter((d) => d.documentType === type && d.verificationStatus !== VERIFICATION_STATUS.SUPERSEDED)
            .sort((a, b) => b.receivedDate - a.receivedDate || b.createdDate - a.createdDate);
        const chosen = ofType.find((d) => d.verificationStatus === VERIFICATION_STATUS.VERIFIED) ?? ofType[0];
        current[type] = chosen
            ? {
                documentId: chosen.documentId,
                originalFilename: chosen.originalFilename,
                verificationStatus: chosen.verificationStatus,
                variant: chosen.documentVariant ?? null,
                receivedDate: chosen.receivedDate,
            }
            : null;
    }
    return current;
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
        db.user.count({ where }),
        db.user.findMany({
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
    const exact = await db.user.findUnique({ where: { passportId }, select: { passportId: true } });
    if (exact) return exact.passportId;
    const rows = await db.user.findMany({
        where: { passportId: { equals: passportId, mode: "insensitive" } },
        select: { passportId: true },
        take: 2,
    });
    return rows.length === 1 ? rows[0].passportId : null;
}

// GET /api/admin/candidates/:passportId — null when there is no such candidate.
export async function getCandidate({ db, passportId }) {
    const user = await db.user.findUnique({
        where: { passportId },
        select: {
            ...userSelect,
            stages: { select: { stage: true, completed: true, completedAt: true, notes: true } },
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
        requiredDocuments: REQUIRED_SUBMISSION_DOCUMENTS.map((documentType) => ({
            documentType,
            included: Boolean(documents[documentType]),
        })),
    };
}

// ---------------------------------------------------------------- writing

const isUniqueViolation = (error) => error?.code === "P2002";
const uniqueTarget = (error) => [].concat(error?.meta?.target ?? []).join(",");

// Next free business reference: one more than the highest numeric unique ID,
// four digits at least (0001, 0002, …), like the existing records.
async function nextUniqueId(db) {
    const rows = await db.user.findMany({ select: { uniqueId: true } });
    const highest = rows.reduce((max, { uniqueId }) => (/^\d+$/.test(uniqueId) ? Math.max(max, Number(uniqueId)) : max), 0);
    return String(highest + 1).padStart(4, "0");
}

async function assertNicFree(db, nic, exceptPassportId) {
    const holder = await db.user.findUnique({ where: { nic }, select: { passportId: true } });
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
    const existing = await db.user.findFirst({
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
                await tx.user.create({ data: { ...details, uniqueId } });
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
    const user = await db.user.findUnique({ where: { passportId }, select: userSelect });
    if (!user) throw new CandidateError(404, "NOT_FOUND", "Candidate not found");
    return user;
}

// PUT /api/admin/candidates/:passportId (Candidate Details stage).
// A WhatsApp number already on record is never changed here: it is what
// documents sent on WhatsApp are matched by. One can only be added when the
// record has none.
export async function updateCandidateDetails({ db, passportId, values }) {
    const user = await requireCandidate(db, passportId);
    await assertNicFree(db, values.nic, passportId);
    const { whatsappNumber, ...data } = values;
    if (!user.whatsappNumber && whatsappNumber) {
        await assertWhatsappFree(db, whatsappNumber, passportId);
        data.whatsappNumber = whatsappNumber;
    }
    try {
        await db.user.update({ where: { passportId }, data });
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
        if (buffer.length > MAX_FILE_SIZE) return UPLOAD_REJECTION_MESSAGES.FILE_TOO_LARGE;
        return videoSignatureMatches(buffer, mimeType) ? null : UPLOAD_REJECTION_MESSAGES.FILE_SIGNATURE_MISMATCH;
    }
    const result = validateDocumentFile({ mimeType, fileSize: buffer?.length ?? 0, fileBuffer: buffer });
    if (result.valid) return null;
    return UPLOAD_REJECTION_MESSAGES[result.reason] ?? "The file was not accepted.";
}

// documentType and variant from the query: { values } or { errors }.
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

// The name the browser sent (header X-File-Name, URI-encoded): only kept as
// documents.original_filename, never used in a storage path.
export function originalFileNameFrom(header, fallback) {
    if (typeof header !== "string" || header === "") return fallback;
    let decoded;
    try {
        decoded = decodeURIComponent(header);
    } catch {
        return fallback;
    }
    const name = decoded.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_FILE_NAME_LENGTH);
    return name || fallback;
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

// POST /api/admin/candidates/:passportId/documents?type=…&variant=…
// Body: the file bytes, Content-Type its MIME type.
export async function uploadCandidateDocument({ db, bucket, admin, passportId, documentType, variant, mimeType, buffer, originalFileName, now = new Date() }) {
    await requireCandidate(db, passportId);

    const rejection = validateCandidateUpload({ documentType, mimeType, buffer });
    if (rejection) throw new CandidateError(422, "FILE_REJECTED", rejection);

    const fileSha256 = sha256Hex(buffer);
    const sameFile = await db.document.findFirst({ where: { passportId, fileSha256 }, select: { documentId: true } });
    if (sameFile) throw new CandidateError(409, "DUPLICATE_FILE", "This exact file is already stored for this candidate.");

    const extension = extensionForMimeType(mimeType);
    const existingCount = await db.document.count({ where: { passportId, documentType } });
    const { storagePath, fileName } = await uploadToFreeName({
        bucket,
        folder: clientFolderPath(passportId, documentType),
        documentType,
        extension,
        firstAttempt: existingCount + 1,
        buffer,
        mimeType,
    });

    const documentId = crypto.randomUUID();
    try {
        await db.$transaction(async (tx) => {
            const previous = await tx.document.findMany({
                where: { passportId, documentType, verificationStatus: VERIFICATION_STATUS.VERIFIED },
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

// ---------------------------------------------------------------- call log

export async function listCallLogs({ db, passportId }) {
    await requireCandidate(db, passportId);
    const rows = await db.candidateCallLog.findMany({
        where: { passportId },
        select: { callLogId: true, note: true, createdDate: true, admin: { select: { name: true } } },
        orderBy: { createdDate: "desc" },
    });
    return {
        items: rows.map((row) => ({ callLogId: row.callLogId, note: row.note, createdDate: row.createdDate, adminName: row.admin?.name ?? null })),
    };
}

export async function addCallLog({ db, admin, passportId, values }) {
    await requireCandidate(db, passportId);
    await db.candidateCallLog.create({
        data: { callLogId: crypto.randomUUID(), passportId, adminId: admin.adminId, note: values.note },
    });
    return listCallLogs({ db, passportId });
}
