import crypto from "node:crypto";

import { CandidateError } from "./candidateService.js";
import { ANSWER_FIELDS, BLOOD_GROUPS, CIVIL_STATUS_CODES, ENGLISH_LEVELS, OTHER_JOB_CATEGORY, answerValue, isNotApplicable } from "./candidateFormDataService.js";
import { NO_PREFERRED_JOB_TYPE, isNoPreference } from "./jobTypeCatalog.js";
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
// What is confirmable: EVERY answer of the Candidate Form, so that only confirmed values
// become canonical (and reach the Google Sheet operational mirror, which never reads
// candidate_form_response):
//   core candidate fields      surname (core other_name), other names (core first_name),
//                              sex, birth date and place, address, alternative contact
//                              (contact_number), passport issue / expiry date, job experience,
//                              job category (ADDED to the record's list of job types; "No
//                              Preferred Type" replaces the list, as it must stand alone)
//   candidate_additional_details  full name (name_as_in_passport: the form asks for the
//                              name "as written on your passport"), shirt / waist / shoe
//                              size, the parents' names (name + surname into the record's one
//                              full name), passport numbers, birth dates and alive answers,
//                              civil status, the spouse (into wife_*), the children, other
//                              skills 1 (other_job_skills) and 2, other job category, English
//                              knowledge, email, city, district, DS / GN division, City in
//                              Romania, Blood Group, Height, Weight, Driving Licence, Can Read
//                              Drawings, Team Leading Skills, Other Languages, every Guardian field
// The Additional Details form's own rules still hold after any Confirm, so the record stays
// savable from Admin: a spouse is recorded only when the record is MARRIED, no children when
// SINGLE, children in order. A Confirm that would break them is refused (409, nothing written);
// confirming MARRIED also records the submitted spouse name when the record has none (the
// record requires one when married). Revoke is never restricted.

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
const storedText = (stored) => (typeof stored === "string" && stored.trim() ? stored : null);
const code = (codes) => ({
    toDb: (value) => (codes.includes(value) ? { value } : { error: "is not one of the choices" }),
    fromDb: storedText,
});
const pattern = (regex, message, max) => ({
    toDb: (value) => {
        const trimmed = String(value).trim();
        return trimmed.length <= max && regex.test(trimmed) ? { value: trimmed } : { error: message };
    },
    fromDb: storedText,
});
// Letters and digits; the NIC as the form stores it (candidateFormDataService.js).
const passportNumber = pattern(/^[A-Z0-9]{1,20}$/, "must be letters and digits", 20);
const nic = pattern(/^(\d{9}[VX]|\d{12})$/, "must be a Sri Lankan NIC", 12);
const email = pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "must be an email address", 254);
// kg, as the form stores it ("70.5"); the record's DECIMAL(5,2) reads back the same way.
const weight = {
    toDb: (value) => {
        const kg = Number(value);
        return Number.isFinite(kg) && kg >= 20 && kg <= 300 ? { value: String(kg) } : { error: "must be a weight from 20 to 300 kg" };
    },
    fromDb: (stored) => (stored === null || stored === undefined ? null : String(Number(stored))),
};
// candidate.job is a LIST of job types ("PLUMBER, WELDER TIG"). The submitted one is pending only
// when the list does not have it yet; Confirm ADDS it (nothing on the list is lost). "No Preferred
// Type" means any type, so it is only ever alone: confirming it replaces the list, and a real type
// replaces it. OTHER is not a job type: its text is "Other Job Category".
const MAX_JOB_TYPES = 10;
const jobList = (stored) => (typeof stored === "string" ? stored.split(",").map((part) => part.trim()).filter(Boolean) : []);
const jobCategory = {
    toDb: (value) => {
        if (value === OTHER_JOB_CATEGORY) return { error: "is not a job type" };
        return { value: isNoPreference(value) ? NO_PREFERRED_JOB_TYPE.code : String(value).trim() };
    },
    fromDb: storedText,
    same: (current, submitted) => {
        const list = jobList(current);
        if (isNoPreference(submitted)) return list.length === 1 && isNoPreference(list[0]);
        return list.some((type) => type.toUpperCase() === submitted.toUpperCase());
    },
    write: (stored, value) => (isNoPreference(value) ? value : [...jobList(stored).filter((type) => !isNoPreference(type)), value].join(", ")),
    requires: ({ candidate, value }) => (!isNoPreference(value) && jobList(candidate?.job).filter((type) => !isNoPreference(type)).length >= MAX_JOB_TYPES
        ? `The record already has ${MAX_JOB_TYPES} job types. Remove one in Candidate details first.`
        : null),
};

// The rules of the Additional Details form (candidateAdditionalDetailsService.js) that a Confirm
// must not break. `details` is the record BEFORE the Confirm; each returns a message or null.
const MARRIED = "MARRIED";
const SINGLE = "SINGLE";
const hasSpouse = (details) => Boolean(details?.wifeFullName || details?.wifeBirthday || details?.spousePassportNumber);
const hasChildren = (details) => Boolean(details?.child1Name || details?.child2Name || details?.child3Name);
const whenMarried = ({ details }) => (details?.maritalStatus === MARRIED ? null : "A spouse is recorded only when the civil status is Married. Confirm the civil status first.");
const childRule = (previous) => ({ details }) => {
    if (details?.maritalStatus === SINGLE) return "Children are not recorded when the civil status is Single.";
    if (previous && !details?.[previous]) return "Children are recorded in order. Confirm the previous child first.";
    return null;
};

// The record keeps ONE full name for a parent / the spouse; the form asks for the name and the
// surname: the submitted value is the two joined ("SAMAN" + "SILVA" -> "SAMAN SILVA"). A name of
// "N/A" (the parent does not apply) is never offered.
const COMPOSITE_NAMES = Object.freeze({
    "family.father.fullName": ["fatherName", "fatherSurname"],
    "family.mother.fullName": ["motherName", "motherSurname"],
    "family.spouse.fullName": ["spouseName", "spouseSurname"],
});

// field key -> where it lives. `table` is "candidate" or "details" (candidate_additional_details);
// `column` is the Prisma field name. This object is the ONLY source of targets.
// Optional, per field: same (current, submitted) -> whether the record already has it;
// write (stored, value) -> the column's new value (default: value);
// requires ({ candidate, details, value }) -> a reason the Confirm is refused, or null;
// alsoWrite ({ details, value, response }) -> other columns of the same row written with it.
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
    "qualifications.jobCategory": { table: "candidate", column: "job", ...jobCategory },
    "basic.civilStatus": {
        table: "details", column: "maritalStatus", ...code(CIVIL_STATUS_CODES),
        requires: ({ details, value, response }) => {
            if (value !== MARRIED && hasSpouse(details)) return "The record has spouse details, which are kept only when Married. Remove them in Additional details first.";
            if (value === SINGLE && hasChildren(details)) return "The record has children, which are not kept when Single. Remove them in Additional details first.";
            if (value === MARRIED && !details?.wifeFullName && !spouseNameOf(response)) return "Married needs the spouse's name, and the submission has no valid one.";
            return null;
        },
        alsoWrite: ({ details, value, response }) => (value === MARRIED && !details?.wifeFullName ? { wifeFullName: spouseNameOf(response) } : {}),
    },
    "basic.bloodGroup": { table: "details", column: "bloodGroup", ...code(BLOOD_GROUPS) },
    "basic.height": { table: "details", column: "height", ...text(30) },
    "basic.weight": { table: "details", column: "weightKg", ...weight },
    "basic.drivingLicence": { table: "details", column: "drivingLicence", ...yesNo },
    "basic.canReadDrawings": { table: "details", column: "canReadDrawings", ...yesNo },
    "basic.teamLeadingSkills": { table: "details", column: "teamLeadingSkills", ...yesNo },
    "basic.otherLanguages": { table: "details", column: "otherLanguages", ...text(150) },
    "contact.city": { table: "details", column: "city", ...text(150) },
    "contact.district": { table: "details", column: "district", ...text(150) },
    "contact.dsDivision": { table: "details", column: "dsDivision", ...text(150) },
    "contact.gnDivision": { table: "details", column: "gnDivision", ...text(150) },
    "contact.email": { table: "details", column: "email", ...email },
    "contact.cityInRomania": { table: "details", column: "cityInRomania", ...text(100) },
    "qualifications.jobCategoryOther": { table: "details", column: "otherJobCategory", ...text(150) },
    "qualifications.otherSkills1": { table: "details", column: "otherJobSkills", ...text(1000) },
    "qualifications.otherSkills2": { table: "details", column: "otherJobSkills2", ...text(150) },
    "qualifications.englishKnowledge": { table: "details", column: "englishKnowledge", ...code(ENGLISH_LEVELS) },
    "family.father.fullName": { table: "details", column: "fatherFullName", ...text(150) },
    "family.father.passportNumber": { table: "details", column: "fatherPassportNumber", ...passportNumber },
    "family.mother.fullName": { table: "details", column: "motherFullName", ...text(150) },
    "family.mother.passportNumber": { table: "details", column: "motherPassportNumber", ...passportNumber },
    "family.spouse.fullName": { table: "details", column: "wifeFullName", ...text(150), requires: whenMarried },
    "family.spouse.passportNumber": { table: "details", column: "spousePassportNumber", ...passportNumber, requires: whenMarried },
    "family.spouse.birthDate": { table: "details", column: "wifeBirthday", ...date({ notFuture: true }), requires: whenMarried },
    "family.child1": { table: "details", column: "child1Name", ...text(150), requires: childRule(null) },
    "family.child2": { table: "details", column: "child2Name", ...text(150), requires: childRule("child1Name") },
    "family.child3": { table: "details", column: "child3Name", ...text(150), requires: childRule("child2Name") },
    "guardian.name": { table: "details", column: "guardianName", ...text(150) },
    "guardian.relationship": { table: "details", column: "guardianRelationship", ...text(150) },
    "guardian.nic": { table: "details", column: "guardianNic", ...nic },
    "guardian.birthDate": { table: "details", column: "guardianBirthday", ...date({ notFuture: true }) },
    "guardian.phone": { table: "details", column: "guardianPhone", ...phone },
    "guardian.address": { table: "details", column: "guardianAddress", ...text(500) },
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

// Every target column, plus the ones the `requires` rules read (they are targets too).
const selectOf = (table) => Object.fromEntries(Object.values(CONFIRMABLE_FIELDS).filter((m) => m.table === table).map((m) => [m.column, true]));
export const CONFIRM_SELECT = Object.freeze({ candidate: selectOf("candidate"), details: selectOf("details") });

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
        // The columns a Confirm writes: the field's own, and any its rules write with it.
        let written = {};
        if (decision === "CONFIRMED") {
            const { value } = mapping.toDb(submitted[field]);
            const refused = mapping.requires?.({ candidate, details, value, response });
            if (refused) throw new CandidateError(409, "FORM_FIELD_PREREQUISITE", refused);
            const stored = (mapping.table === "candidate" ? candidate : details)?.[mapping.column] ?? null;
            written = { [mapping.column]: mapping.write ? mapping.write(stored, value) : value, ...mapping.alsoWrite?.({ details, value, response }) };
            if (mapping.table === "candidate") {
                await tx.candidate.update({ where: { passportId }, data: written });
            } else {
                await tx.candidateAdditionalDetails.upsert({ where: { passportId }, create: { passportId, ...written }, update: written });
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
                    // The record's column name, like the other candidate audit entries (never a secret);
                    // a column written with it (a spouse name with Married) is listed too.
                    previousValue: JSON.stringify({ [mapping.column]: pending.current, ...Object.fromEntries(Object.keys(written).filter((c) => c !== mapping.column).map((c) => [c, null])) }),
                    newValue: JSON.stringify({ ...written, [mapping.column]: pending.submitted }),
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
    const names = COMPOSITE_NAMES[field];
    if (names) {
        const [name, surname] = names.map((column) => response?.[column] ?? null);
        if (!name || isNotApplicable(name)) return name;
        return [name, surname].filter((part) => part && !isNotApplicable(part)).join(" ");
    }
    const column = FIELD_COLUMN[field];
    return column ? answerValue(column, response?.[column] ?? null) : null;
}

// The submitted spouse name as the record would hold it, or null when it is not a valid one.
function spouseNameOf(response) {
    const name = submittedValueOf(response, "family.spouse.fullName");
    if (!name || isNotApplicable(name)) return null;
    return text(150).toDb(name).value ?? null;
}
