// Candidate additional details (Admin > Candidates > Additional Details):
// passport name, permanent address, birthday, clothing sizes, parents,
// marital and family details, other job skills. One optional row per
// candidate in candidate_additional_details (passport_id is its primary key
// and its foreign key to candidate).
//
// The candidate is always the existing record of the passport ID in the URL
// (resolved like every other candidate route, case-insensitively): saving
// never creates a candidate, and never changes the candidate's own record.
// Until details are saved, the form is offered the candidate's name, address
// and date of birth as suggestions; they are stored here only when saved.
//
// Every save is a full replacement of the details (a field left out is
// cleared). A save that changes nothing writes nothing, and every real
// change is written to audit_logs with only the changed fields.

import crypto from "node:crypto";

import { clientName } from "../utils/clientName.js";
import { CandidateError } from "./candidateService.js";

export const TSHIRT_SIZES = Object.freeze(["XS", "S", "M", "L", "XL", "XXL"]);
// Waist sizes in inches.
export const PANT_SIZE_PRESETS = Object.freeze(["28", "30", "32", "34", "36", "38", "40", "42", "44", "46"]);
// UK sizes.
export const SHOE_SIZE_PRESETS = Object.freeze(["5", "6", "7", "8", "9", "10", "11", "12", "13"]);
export const MARITAL_STATUSES = Object.freeze(["SINGLE", "MARRIED", "DIVORCED", "WIDOWED", "SEPARATED"]);

export const ADDITIONAL_DETAILS_AUDIT_ACTION = Object.freeze({
    CREATE: "CREATE_ADDITIONAL_DETAILS",
    UPDATE: "UPDATE_ADDITIONAL_DETAILS",
});

// Field -> kind, in form order. These are the only values ever read from a
// request, stored or written to the audit log.
const FIELDS = Object.freeze({
    nameAsInPassport: "name",
    permanentAddress: "address",
    birthday: "date",
    tshirtSize: "tshirt",
    pantSize: "pant",
    shoeSize: "shoe",
    fatherAlive: "boolean",
    fatherFullName: "name",
    fatherBirthday: "date",
    motherAlive: "boolean",
    motherFullName: "name",
    motherBirthday: "date",
    maritalStatus: "marital",
    wifeFullName: "name",
    wifeBirthday: "date",
    child1Name: "name",
    child2Name: "name",
    child3Name: "name",
    otherJobSkills: "skills",
});
export const ADDITIONAL_DETAILS_FIELDS = Object.freeze(Object.keys(FIELDS));

const MAX_LENGTH = { name: 150, address: 500, skills: 1000 };
// A custom pant or shoe size: short, letters, digits, spaces and . / -
const CUSTOM_SIZE = /^[A-Za-z0-9][A-Za-z0-9 ./-]{0,9}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EARLIEST_DATE = "1900-01-01";
const MAX_AUDIT_VALUE_LENGTH = 300;

const isoDate = (value) => (value ? value.toISOString().slice(0, 10) : null);
const todayUtc = (now) => now.toISOString().slice(0, 10);

// { values } (every field, null when not given) or { errors: [{ field, message }] }.
export function parseAdditionalDetailsBody(body, { now = new Date() } = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { errors: [{ field: "body", message: "must be a JSON object" }] };
    }
    const errors = [];
    const fail = (field, message) => {
        errors.push({ field, message });
        return null;
    };
    const values = {};
    for (const [field, kind] of Object.entries(FIELDS)) {
        const raw = body[field];
        const blank = raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
        if (blank) {
            values[field] = null;
            continue;
        }
        if (kind === "boolean") {
            values[field] = typeof raw === "boolean" ? raw : fail(field, "must be true or false");
            continue;
        }
        if (typeof raw !== "string") {
            values[field] = fail(field, "must be text");
            continue;
        }
        const value = raw.trim();
        switch (kind) {
            case "date": {
                if (!DATE_PATTERN.test(value)) { values[field] = fail(field, "must be a date (YYYY-MM-DD)"); break; }
                const parsed = new Date(`${value}T00:00:00.000Z`);
                if (Number.isNaN(parsed.getTime()) || isoDate(parsed) !== value) { values[field] = fail(field, "must be a real date"); break; }
                if (value < EARLIEST_DATE) { values[field] = fail(field, "must not be before 1900"); break; }
                if (value > todayUtc(now)) { values[field] = fail(field, "must not be in the future"); break; }
                values[field] = parsed;
                break;
            }
            case "tshirt":
                values[field] = TSHIRT_SIZES.includes(value.toUpperCase()) ? value.toUpperCase() : fail(field, `must be one of: ${TSHIRT_SIZES.join(", ")}`);
                break;
            case "marital":
                values[field] = MARITAL_STATUSES.includes(value.toUpperCase()) ? value.toUpperCase() : fail(field, `must be one of: ${MARITAL_STATUSES.join(", ")}`);
                break;
            case "pant":
            case "shoe":
                // A preset, or a short custom value (e.g. "31", "9.5", "EU 43").
                values[field] = CUSTOM_SIZE.test(value) ? value : fail(field, "must be a size of at most 10 letters, digits, spaces, dots, slashes or dashes");
                break;
            default: {
                const max = MAX_LENGTH[kind];
                values[field] = value.length > max ? fail(field, `must be at most ${max} characters`) : value;
            }
        }
    }

    // Parent and spouse details only go with their answer.
    const conditional = [
        ["fatherAlive", ["fatherFullName", "fatherBirthday"], "the father is alive"],
        ["motherAlive", ["motherFullName", "motherBirthday"], "the mother is alive"],
    ];
    for (const [flag, [nameField, birthdayField], condition] of conditional) {
        if (values[flag] === true) {
            if (values[nameField] === null && !errors.some((e) => e.field === nameField)) errors.push({ field: nameField, message: `is required when ${condition}` });
        } else {
            for (const field of [nameField, birthdayField]) {
                if (values[field] !== null) errors.push({ field, message: `is only recorded when ${condition}` });
            }
        }
    }
    if (values.maritalStatus === "MARRIED") {
        if (values.wifeFullName === null && !errors.some((e) => e.field === "wifeFullName")) errors.push({ field: "wifeFullName", message: "is required when married" });
    } else {
        for (const field of ["wifeFullName", "wifeBirthday"]) {
            if (values[field] !== null) errors.push({ field, message: "is only recorded when married" });
        }
    }
    // Children in order: no 2nd without a 1st, no 3rd without a 2nd.
    if (values.child2Name !== null && values.child1Name === null) errors.push({ field: "child2Name", message: "needs the 1st child's name first" });
    if (values.child3Name !== null && values.child2Name === null) errors.push({ field: "child3Name", message: "needs the 2nd child's name first" });

    return errors.length ? { errors } : { values };
}

// As the API returns it: dates as YYYY-MM-DD.
function toResponse(row) {
    if (!row) return null;
    const details = {};
    for (const [field, kind] of Object.entries(FIELDS)) details[field] = kind === "date" ? isoDate(row[field]) : row[field] ?? null;
    return details;
}

// Comparable and storable in the audit log.
function auditValue(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return isoDate(value);
    if (typeof value === "boolean") return value;
    const text = String(value);
    return text.length > MAX_AUDIT_VALUE_LENGTH ? `${text.slice(0, MAX_AUDIT_VALUE_LENGTH)}…` : text;
}

function changedFields(previous, next) {
    const before = {};
    const after = {};
    for (const field of ADDITIONAL_DETAILS_FIELDS) {
        const from = auditValue(previous?.[field] ?? null);
        const to = auditValue(next[field]);
        if (from === to) continue;
        before[field] = from;
        after[field] = to;
    }
    return Object.keys(after).length ? { before, after } : null;
}

async function requireCandidate(db, passportId) {
    const candidate = await db.candidate.findUnique({
        where: { passportId },
        select: { passportId: true, firstName: true, otherName: true, address: true, dateOfBirth: true },
    });
    if (!candidate) throw new CandidateError(404, "NOT_FOUND", "Candidate not found");
    return candidate;
}

function view(candidate, row) {
    return {
        passportId: candidate.passportId,
        details: toResponse(row),
        // Offered on a form with nothing saved yet; never stored unless saved.
        suggested: {
            nameAsInPassport: clientName(candidate),
            permanentAddress: candidate.address ?? null,
            birthday: isoDate(candidate.dateOfBirth),
        },
        updatedDate: row?.updatedDate ?? null,
    };
}

const selectAll = Object.fromEntries([...ADDITIONAL_DETAILS_FIELDS, "updatedDate"].map((field) => [field, true]));

// GET /api/admin/candidates/:passportId/additional-details
export async function getAdditionalDetails({ db, passportId }) {
    const candidate = await requireCandidate(db, passportId);
    const row = await db.candidateAdditionalDetails.findUnique({ where: { passportId }, select: selectAll });
    return view(candidate, row);
}

// PUT /api/admin/candidates/:passportId/additional-details. values: from
// parseAdditionalDetailsBody. actor: the signed-in user (req.user).
export async function saveAdditionalDetails({ db, passportId, values, actor }) {
    const candidate = await requireCandidate(db, passportId);
    const row = await db.$transaction(async (tx) => {
        const existing = await tx.candidateAdditionalDetails.findUnique({ where: { passportId }, select: selectAll });
        const changes = changedFields(existing, values);
        // Nothing changed (including an empty form with nothing saved): no write, no audit.
        if (!changes) return existing;

        const saved = await tx.candidateAdditionalDetails.upsert({
            where: { passportId },
            create: { passportId, ...values },
            update: values,
            select: selectAll,
        });
        if (actor) {
            await tx.auditLog.create({
                data: {
                    auditId: crypto.randomUUID(),
                    adminId: actor.adminId,
                    action: existing ? ADDITIONAL_DETAILS_AUDIT_ACTION.UPDATE : ADDITIONAL_DETAILS_AUDIT_ACTION.CREATE,
                    passportId,
                    previousStatus: existing ? "CREATED" : "NONE",
                    newStatus: existing ? "UPDATED" : "CREATED",
                    reason: `Additional details: ${Object.keys(changes.after).join(", ")}`,
                    previousValue: JSON.stringify(changes.before),
                    newValue: JSON.stringify(changes.after),
                },
            });
        }
        return saved;
    });
    return view(candidate, row);
}
