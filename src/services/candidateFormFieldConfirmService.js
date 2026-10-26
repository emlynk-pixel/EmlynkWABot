import crypto from "node:crypto";

import { CandidateError } from "./candidateService.js";
import { ANSWER_FIELDS, answerValue, isNotApplicable } from "./candidateFormDataService.js";
import { normalizePhoneNumber } from "../utils/phoneNumber.js";

// Per-field "Confirm candidate change" (Admin > Candidate Details).
//
// A Candidate Form submission is stored on its own (candidate_form_response) and
// never changes the candidate's record. When an Admin or Manager sees that the
// candidate submitted a DIFFERENT value for a field that has a real home in the
// record, they can confirm that ONE field: only that column is updated, the
// submission is left exactly as it was, and the change is audited.
//
// The server decides everything. The browser sends only a stable form field key
// (an allowlist key below) plus the values it was looking at, which are used only
// to detect a stale screen; the new value is ALWAYS read from candidate_form_response
// and validated here. No table or column name ever comes from a request.
//
// What is confirmable (the audit, with the existing code's own semantics):
//   core candidate fields      surname (core other_name), other names (core first_name),
//                              sex, birth date and place, address, alternative contact
//                              (contact_number), passport issue / expiry date, job experience
//   candidate_additional_details  full name (name_as_in_passport: the form asks for the
//                              name "as written on your passport"), shirt / waist / shoe
//                              size, father's and mother's birth date, father / mother alive
// NOT confirmable (shown read-only, no canonical target or an ambiguous one):
//   email, city, district, DS / GN division, job category (the core field is a LIST of
//   job types; the form has one), English knowledge, other job category, other skills,
//   civil status / spouse / children (they depend on each other's rules), parents' names and
//   passport numbers (the form splits name and surname, the record holds one full name),
//   and every Guardian field (no Guardian storage exists); City in Romania, Blood Group, Other
//   Languages, Driving Licence, Can Read Drawings, Team Leading Skills, Height and Weight (the
//   record has no column for them: they are kept, and shown, as submitted).

export const CONFIRM_AUDIT_ACTION = "CANDIDATE_FORM_FIELD_CONFIRMED";
export const REJECT_AUDIT_ACTION = "CANDIDATE_FORM_FIELD_REJECTED";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SIZE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ./-]{0,9}$/;
const SHIRT_SIZES = ["XS", "S", "M", "L", "XL", "XXL"];
const SEX_TO_DB = Object.freeze({ MALE: "M", FEMALE: "F", OTHER: "X" });
const SEX_FROM_DB = Object.freeze({ M: "MALE", F: "FEMALE", X: "OTHER" });
const isoDay = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value ?? null);
const today = () => new Date().toISOString().slice(0, 10);

// Each kind: toDb(submitted) -> { value } | { error }; fromDb(stored) -> the form's representation.
const text = (max) => ({
    toDb: (value) => {
        const trimmed = String(value).trim();
        return trimmed && trimmed.length <= max ? { value: trimmed } : { error: `must be 1 to ${max} characters` };
    },
    fromDb: (stored) => (typeof stored === "string" && stored.trim() ? stored : null),
});
const date = ({ notFuture = false, min = "1900-01-01" } = {}) => ({
    toDb: (value) => {
        const day = String(value);
        const parsed = new Date(`${day}T00:00:00.000Z`);
        if (!DATE_PATTERN.test(day) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return { error: "must be a real date" };
        if (day < min) return { error: "is before 1900" };
        if (notFuture && day > today()) return { error: "must not be in the future" };
        return { value: parsed };
    },
    fromDb: (stored) => isoDay(stored),
});
const phone = {
    toDb: (value) => {
        const digits = normalizePhoneNumber(value);
        return digits ? { value: String(value).trim().slice(0, 30) } : { error: "must be a phone number" };
    },
    fromDb: (stored) => (typeof stored === "string" && stored.trim() ? stored : null),
    // 0771234567, +94771234567 and 94771234567 are the same number.
    same: (a, b) => normalizePhoneNumber(a) !== null && normalizePhoneNumber(a) === normalizePhoneNumber(b),
};
const sex = {
    toDb: (value) => (SEX_TO_DB[value] ? { value: SEX_TO_DB[value] } : { error: "must be MALE, FEMALE or OTHER" }),
    fromDb: (stored) => SEX_FROM_DB[stored] ?? null,
};
const shirt = {
    toDb: (value) => (SHIRT_SIZES.includes(value) ? { value } : { error: "must be a known size" }),
    fromDb: (stored) => (SHIRT_SIZES.includes(stored) ? stored : null),
};
const size = {
    toDb: (value) => (SIZE_PATTERN.test(String(value).trim()) ? { value: String(value).trim() } : { error: "must be up to 10 letters, digits, spaces, dots, slashes or dashes" }),
    fromDb: (stored) => (typeof stored === "string" && stored.trim() ? stored : null),
};
// The form's YES / NO and the record's boolean (candidate_additional_details.father_alive).
const yesNo = {
    toDb: (value) => (value === "YES" ? { value: true } : value === "NO" ? { value: false } : { error: "must be YES or NO" }),
    fromDb: (stored) => (typeof stored === "boolean" ? (stored ? "YES" : "NO") : null),
};

// field key -> where it lives. `table` is "candidate" or "details" (candidate_additional_details);
// `column` is the Prisma field name. This object is the ONLY source of targets.
export const CONFIRMABLE_FIELDS = Object.freeze({
    "basic.surname": { table: "candidate", column: "otherName", ...text(100) },
    "basic.otherNames": { table: "candidate", column: "firstName", ...text(100) },
    "basic.sex": { table: "candidate", column: "sex", ...sex },
    "basic.birthDate": { table: "candidate", column: "dateOfBirth", ...date({ notFuture: true }) },
    "basic.birthPlace": { table: "candidate", column: "placeOfBirth", ...text(100) },
    "contact.address": { table: "candidate", column: "address", ...text(500) },
    "contact.alternativePhone": { table: "candidate", column: "contactNumber", ...phone },
    "passport.issueDate": { table: "candidate", column: "passportIssueDate", ...date({ notFuture: true }) },
    "passport.expiryDate": { table: "candidate", column: "passportExpiryDate", ...date() },
    "qualifications.experience": { table: "candidate", column: "jobExperience", ...text(2000) },
    "basic.fullName": { table: "details", column: "nameAsInPassport", ...text(200) },
    "measurements.shirtSize": { table: "details", column: "tshirtSize", ...shirt },
    "measurements.waistSize": { table: "details", column: "pantSize", ...size },
    "measurements.shoeSize": { table: "details", column: "shoeSize", ...size },
    "family.father.birthDate": { table: "details", column: "fatherBirthday", ...date({ notFuture: true }) },
    "family.mother.birthDate": { table: "details", column: "motherBirthday", ...date({ notFuture: true }) },
    "family.fatherAlive": { table: "details", column: "fatherAlive", ...yesNo },
    "family.motherAlive": { table: "details", column: "motherAlive", ...yesNo },
});

export const isConfirmableField = (field) => typeof field === "string" && Object.hasOwn(CONFIRMABLE_FIELDS, field);

const same = (mapping, a, b) => {
    if (a === null || b === null) return a === b;
    if (mapping.same) return mapping.same(a, b);
    return String(a).trim().toUpperCase() === String(b).trim().toUpperCase();
};

// { current, submitted } in the form's representation for one field, or null when
// there is nothing to confirm: no submission, nothing submitted for it, an invalid
// submitted value (never offered), or the record already holds that value.
export function pendingChange(field, { candidate, details, submitted }) {
    const mapping = CONFIRMABLE_FIELDS[field];
    const raw = submitted?.[field];
    if (!mapping || raw === null || raw === undefined || String(raw).trim() === "") return null;
    // "N/A" means "does not apply": it is never offered as a value for the record (it
    // would otherwise be written into e.g. the candidate's other names or job experience).
    if (isNotApplicable(String(raw))) return null;
    const proposed = mapping.toDb(raw);
    if (proposed.error) return null;
    const stored = (mapping.table === "candidate" ? candidate : details)?.[mapping.column] ?? null;
    const current = mapping.fromDb(stored);
    const submittedForm = mapping.fromDb(proposed.value);
    if (same(mapping, current, submittedForm)) return null;
    return { field, current, submitted: submittedForm };
}

// Pending = differs from the record AND has not been reviewed yet. `reviewed` is the set of field keys that
// already have a decision (CONFIRMED or REJECTED): a decision is final for the submission.
export function pendingChanges(context, reviewed = new Set()) {
    return Object.keys(CONFIRMABLE_FIELDS).filter((field) => !reviewed.has(field)).map((field) => pendingChange(field, context)).filter(Boolean);
}

export const CONFIRM_SELECT = Object.freeze({
    candidate: { otherName: true, firstName: true, sex: true, dateOfBirth: true, placeOfBirth: true, address: true, contactNumber: true, passportIssueDate: true, passportExpiryDate: true, jobExperience: true },
    details: { nameAsInPassport: true, tshirtSize: true, pantSize: true, shoeSize: true, fatherBirthday: true, motherBirthday: true, fatherAlive: true, motherAlive: true },
});

// Both decisions share one flow and one review table (candidate_form_field_review):
//   Confirm  -> update ONE canonical column, mark CONFIRMED
//   Reject   -> change nothing in the record, mark REJECTED
// POST .../form-submission/confirm-field | reject-field { field, expectedCurrentValue, expectedSubmittedValue }.
// One transaction: lock the candidate row, re-read the submission, the current value and the review state,
// refuse a stale screen (409), apply the decision, record it, audit it. Neither action touches
// candidate_form_response.
async function reviewFormField({ db, actor, passportId, field, expectedCurrentValue, expectedSubmittedValue, decision }) {
    if (!isConfirmableField(field)) throw new CandidateError(400, "FIELD_NOT_CONFIRMABLE", "This field cannot be reviewed from the Candidate Form.");
    const mapping = CONFIRMABLE_FIELDS[field];
    return db.$transaction(async (tx) => {
        const locked = await tx.$queryRaw`SELECT "passport_id" FROM "candidate" WHERE "passport_id" = ${passportId} FOR UPDATE`;
        if (!locked.length) throw new CandidateError(404, "NOT_FOUND", "Candidate not found");
        const [candidate, details, response, review] = await Promise.all([
            tx.candidate.findUnique({ where: { passportId }, select: CONFIRM_SELECT.candidate }),
            tx.candidateAdditionalDetails.findUnique({ where: { passportId }, select: CONFIRM_SELECT.details }),
            tx.candidateFormResponse.findUnique({ where: { passportId } }),
            tx.candidateFormFieldReview.findUnique({ where: { passportId_fieldKey: { passportId, fieldKey: field } }, select: { status: true } }),
        ]);
        if (!response) throw new CandidateError(409, "NO_SUBMISSION", "This candidate has not submitted the Candidate Form.");
        const submitted = { [field]: submittedValueOf(response, field) };
        const pending = pendingChange(field, { candidate, details, submitted });
        if (!pending) throw new CandidateError(409, "FORM_FIELD_NOT_PENDING", "There is nothing to review for this field: the record already has the submitted value, or no valid value was submitted.");
        // Already decided (by someone else, or earlier): a decision is final.
        if (review) throw new CandidateError(409, "FORM_FIELD_REVIEW_STALE", `This change was already ${review.status === "REJECTED" ? "rejected" : "confirmed"}. Refresh and review again.`);
        // The screen the Admin looked at must still be current.
        if ((expectedCurrentValue ?? null) !== pending.current || (expectedSubmittedValue ?? null) !== pending.submitted) {
            throw new CandidateError(409, "FORM_FIELD_STALE", "This value changed since you opened the page. Refresh and review again.");
        }
        if (decision === "CONFIRMED") {
            const proposed = mapping.toDb(submitted[field]);
            if (mapping.table === "candidate") {
                await tx.candidate.update({ where: { passportId }, data: { [mapping.column]: proposed.value } });
            } else {
                await tx.candidateAdditionalDetails.upsert({
                    where: { passportId },
                    create: { passportId, [mapping.column]: proposed.value },
                    update: { [mapping.column]: proposed.value },
                });
            }
        }
        await tx.candidateFormFieldReview.create({
            data: { passportId, fieldKey: field, status: decision, submittedValue: pending.submitted, currentValue: pending.current, reviewedById: actor.adminId },
        });
        await tx.auditLog.create({
            data: decision === "CONFIRMED"
                ? {
                    auditId: crypto.randomUUID(), adminId: actor.adminId, action: CONFIRM_AUDIT_ACTION, passportId,
                    previousStatus: "PENDING_CONFIRMATION", newStatus: "CONFIRMED", reason: `Confirmed candidate-submitted value for ${field}`,
                    // The record's column name, like the other candidate audit entries (never a secret).
                    previousValue: JSON.stringify({ [mapping.column]: pending.current }),
                    newValue: JSON.stringify({ [mapping.column]: pending.submitted }),
                }
                : {
                    auditId: crypto.randomUUID(), adminId: actor.adminId, action: REJECT_AUDIT_ACTION, passportId,
                    previousStatus: "PENDING_CONFIRMATION", newStatus: "REJECTED", reason: `Rejected candidate-submitted value for ${field}`,
                    // The record is NOT changed: the current value and the value that was turned down.
                    newValue: JSON.stringify({ field, currentValue: pending.current, rejectedSubmittedValue: pending.submitted }),
                },
        });
        return { field, decision, current: pending.current, submitted: pending.submitted };
    });
}

export const confirmFormField = (args) => reviewFormField({ ...args, expectedCurrentValue: args.expectedCurrentValue ?? null, expectedSubmittedValue: args.expectedSubmittedValue ?? null, decision: "CONFIRMED" });
export const rejectFormField = (args) => reviewFormField({ ...args, expectedCurrentValue: args.expectedCurrentValue ?? null, expectedSubmittedValue: args.expectedSubmittedValue ?? null, decision: "REJECTED" });

// The submitted value of a form path from a candidate_form_response row (the columns
// come from the form's own field list, not a second table).
const FIELD_COLUMN = Object.freeze(Object.fromEntries(ANSWER_FIELDS.map(([group, key, column]) => [`${group}.${key}`, column])));
export function submittedValueOf(response, field) {
    const column = FIELD_COLUMN[field];
    return column ? answerValue(column, response?.[column] ?? null) : null;
}
