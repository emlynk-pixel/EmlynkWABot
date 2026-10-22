import { ANSWER_FIELDS } from "./candidateFormDataService.js";
import { FORM_ACCESS_STATUS } from "./candidateFormShareService.js";
import { CONFIRMABLE_FIELDS, CONFIRM_SELECT, pendingChanges, submittedValueOf } from "./candidateFormFieldConfirmService.js";

// Admin view of what the candidate submitted through the Candidate Form
// (GET /api/admin/candidates/:passportId/form-submission). READ ONLY and
// Admin-only (the public router has no equivalent).
//
// The source is candidate_form_response: the candidate's answers, stored
// separately and never merged into the candidate's own record. Where it
// exists, candidate_form_prefill_snapshot (what the form was prefilled with at
// the first verified visit, i.e. the original values) comes with it so Admin can
// see what the candidate changed. Nothing here approves, merges or edits.
//
// Values are keyed by the form's own paths ("basic.fullName", "family.father.name",
// "guardian.nic", ...), exactly the fields in ANSWER_FIELDS, so a field added to
// the form shows up here with it. Dates are YYYY-MM-DD; an empty answer is null.

const isoDay = (date) => date.toISOString().slice(0, 10);
const cell = (value) => (value instanceof Date ? isoDay(value) : value ?? null);

function valuesOf(row) {
    if (!row) return null;
    const values = Object.fromEntries(ANSWER_FIELDS.map(([group, key, column]) => [`${group}.${key}`, cell(row[column])]));
    // The verified NIC stored with the submission (from the record, not typed).
    values.nic = row.nic ?? null;
    return values;
}

// Same value, ignoring case and surrounding spaces: the form capitalises English
// text, so a record's "12 galle road" and the submitted "12 GALLE ROAD" are not a change.
const normal = (value) => (value === null || value === undefined ? "" : String(value).trim().toUpperCase());

export async function getFormSubmission({ db, passportId }) {
    const [access, response, snapshot, candidate, details, reviews] = await Promise.all([
        db.candidateFormAccess.findUnique({ where: { passportId }, select: { status: true, submittedAt: true } }),
        db.candidateFormResponse.findUnique({ where: { passportId } }),
        db.candidateFormPrefillSnapshot.findUnique({ where: { passportId } }),
        db.candidate.findUnique({ where: { passportId }, select: CONFIRM_SELECT.candidate }),
        db.candidateAdditionalDetails.findUnique({ where: { passportId }, select: CONFIRM_SELECT.details }),
        db.candidateFormFieldReview.findMany({ where: { passportId }, select: { fieldKey: true, status: true } }),
    ]);
    const submitted = valuesOf(response);
    const original = valuesOf(snapshot);
    const changed = submitted && original
        ? Object.keys(submitted).filter((path) => path !== "nic" && normal(submitted[path]) !== normal(original[path]))
        : [];
    return {
        passportId,
        // LOCKED (no link yet or revoked), UNLOCKED (a link is open), SUBMITTED (final).
        formStatus: access?.status ?? FORM_ACCESS_STATUS.LOCKED,
        submittedAt: (response?.submittedAt ?? access?.submittedAt)?.toISOString() ?? null,
        submitted,
        original,
        changed,
        // Answers that differ from the record AND have a real home in it: each can be
        // confirmed on its own (candidateFormFieldConfirmService.js). Others are read only.
        // (a field with a decision, CONFIRMED or REJECTED, is no longer pending).
        pending: submitted ? pendingChanges({ candidate, details, submitted }, new Set(reviews.map((review) => review.fieldKey))) : [],
        // Staff decisions already taken on this submission: { field, status: CONFIRMED | REJECTED }.
        reviews: reviews.map((review) => ({ field: review.fieldKey, status: review.status })),
    };
}

// ---------------------------------------------------------------- unresolved conflicts (list indicator)
//
// For a page of candidates: Map(passportId -> the form field keys that still need review), with
// only the candidates that have at least one. It is EXACTLY the "pending" of getFormSubmission
// (pendingChanges of candidateFormFieldConfirmService.js), computed in a few batched queries
// instead of one request per candidate, so the list indicator and the candidate page always
// agree: a field counts only when the submitted value has a real home in Candidate Details /
// Additional Details (CONFIRMABLE_FIELDS), is valid, is not "N/A", differs from the current
// value after the field's own normalisation (case and surrounding spaces; phone numbers by
// digits), and has no CONFIRMED / REJECTED decision yet. Derived on every read: nothing about it
// is stored, so it disappears by itself once the last field is confirmed or rejected.
export async function pendingConflictsByCandidate(db, passportIds) {
    const ids = [...new Set(passportIds)];
    if (!ids.length) return new Map();
    const responses = await db.candidateFormResponse.findMany({ where: { passportId: { in: ids } } });
    if (!responses.length) return new Map();
    const submittedIds = responses.map((row) => row.passportId);
    const [candidates, details, reviews] = await Promise.all([
        db.candidate.findMany({ where: { passportId: { in: submittedIds } }, select: { passportId: true, ...CONFIRM_SELECT.candidate } }),
        db.candidateAdditionalDetails.findMany({ where: { passportId: { in: submittedIds } }, select: { passportId: true, ...CONFIRM_SELECT.details } }),
        db.candidateFormFieldReview.findMany({ where: { passportId: { in: submittedIds } }, select: { passportId: true, fieldKey: true } }),
    ]);
    const candidateOf = new Map(candidates.map((row) => [row.passportId, row]));
    const detailsOf = new Map(details.map((row) => [row.passportId, row]));
    const reviewedOf = new Map();
    for (const review of reviews) reviewedOf.set(review.passportId, (reviewedOf.get(review.passportId) ?? new Set()).add(review.fieldKey));
    const conflicts = new Map();
    for (const response of responses) {
        const submitted = Object.fromEntries(Object.keys(CONFIRMABLE_FIELDS).map((field) => [field, submittedValueOf(response, field)]));
        const pending = pendingChanges({ candidate: candidateOf.get(response.passportId), details: detailsOf.get(response.passportId), submitted }, reviewedOf.get(response.passportId) ?? new Set());
        if (pending.length) conflicts.set(response.passportId, pending.map((change) => change.field));
    }
    return conflicts;
}

