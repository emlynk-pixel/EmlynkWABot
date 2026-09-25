// Admin corrections (Phase 10). They resolve items that would otherwise stay
// stuck in the Review Queue, without approving, removing or rejecting them:
//
//   SET_DOCUMENT_TYPE  a waiting file gets the right document type
//   ASSIGN_CLIENT      a waiting file is linked to an existing client
//   SET_POLICE_DATE    a stored police slip gets (or corrects) its submitted date
//
// A corrected waiting file stays in pending/ and in the Review Queue; the
// admin approves it afterwards through the normal Approve action, with all
// its checks. Nothing here creates a client, changes a WhatsApp number,
// moves or deletes a file, or creates a document.
//
// Same rules as the review actions (adminReviewActionService.js): one
// transaction that locks the row, re-reads it and then changes it, the admin
// from the token, a required reason, and an append-only audit entry written
// in the same transaction with the value before and after.

import {
    EARLIEST_POLICE_DATE,
    MAX_REASON_LENGTH,
    REVIEW_ACTION,
    ReviewActionError,
    TRANSACTION_OPTIONS,
    alreadyResolved,
    createAudit,
    findPending,
    findReviewDocument,
    lockClientRow,
    lockDocumentRow,
    lockTemporaryRow,
    notFound,
    toAuditEntry,
} from "./adminReviewActionService.js";
import { REVIEW_KIND, parseReviewId, toReviewId } from "./adminReviewService.js";
import { DOCUMENT_TYPES } from "./documentClassificationService.js";
import { toYmd, ymdToDate } from "./policeCountdownService.js";
import { businessDateOf, isValidBusinessDate } from "../utils/businessDay.js";

// Types an admin can give a waiting file (UNKNOWN is not a decision).
export const SETTABLE_DOCUMENT_TYPES = Object.freeze([
    DOCUMENT_TYPES.PASSPORT,
    DOCUMENT_TYPES.POLICE_SLIP,
    DOCUMENT_TYPES.POLICE_REPORT,
    DOCUMENT_TYPES.MEDICAL,
]);

const PASSPORT_ID_PATTERN = /^[A-Za-z0-9]{1,20}$/;
const DOCUMENT_ID_PATTERN = /^[0-9a-fA-F-]{8,64}$/;

export const isValidDocumentIdParam = (value) => typeof value === "string" && DOCUMENT_ID_PATTERN.test(value);

const notCorrectable = () => new ReviewActionError(409, "NOT_CORRECTABLE", "Only files waiting in pending storage can be corrected here. A stored document is already in its client folder.");

// ---------------------------------------------------------------- request

// { reason } plus one required field. Returns the parsed values or { errors }.
function parseBody(body, field, parseField) {
    if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
        return { errors: [{ field: "body", message: "must be a JSON object" }] };
    }
    const errors = [];
    let reason = null;
    const value = body.reason;
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
        errors.push({ field: "reason", message: "is required" });
    } else if (typeof value !== "string") {
        errors.push({ field: "reason", message: "must be text" });
    } else if (value.trim().length > MAX_REASON_LENGTH) {
        errors.push({ field: "reason", message: `must be at most ${MAX_REASON_LENGTH} characters` });
    } else {
        reason = value.trim();
    }
    const parsed = parseField(body[field]);
    if (parsed.error) errors.push({ field, message: parsed.error });
    return errors.length ? { errors } : { reason, [field]: parsed.value };
}

// POST /review/:reviewId/document-type: { documentType, reason }
export function parseSetDocumentTypeBody(body) {
    return parseBody(body, "documentType", (value) => (SETTABLE_DOCUMENT_TYPES.includes(value)
        ? { value }
        : { error: `must be one of: ${SETTABLE_DOCUMENT_TYPES.join(", ")}` }));
}

// POST /review/:reviewId/assign-client: { passportId, reason }
export function parseAssignClientBody(body) {
    return parseBody(body, "passportId", (value) => (typeof value === "string" && PASSPORT_ID_PATTERN.test(value)
        ? { value: value.toUpperCase() }
        : { error: "must be letters and digits (at most 20)" }));
}

// POST /documents/:documentId/police-date: { policeSubmittedDate, reason }.
// A real date from 2000-01-01 up to today in Sri Lanka (never in the future).
export function parsePoliceDateBody(body, { now = new Date() } = {}) {
    return parseBody(body, "policeSubmittedDate", (value) => {
        if (!isValidBusinessDate(value)) return { error: "must be a date as YYYY-MM-DD" };
        if (value < EARLIEST_POLICE_DATE || value > businessDateOf(now)) return { error: `must be between ${EARLIEST_POLICE_DATE} and today` };
        return { value };
    });
}

// The pending item behind a review ID, or the right error. A stored
// document's ID is refused (409), an unknown one is 404.
async function pendingTarget(db, reviewId) {
    const parsed = parseReviewId(reviewId);
    if (!parsed) throw notFound();
    if (parsed.kind !== REVIEW_KIND.PENDING) {
        if (await findReviewDocument(db, parsed.id)) throw notCorrectable();
        throw notFound();
    }
    if (!(await findPending(db, parsed.id))) throw notFound();
    return parsed;
}

// ---------------------------------------------------------------- set document type

// The waiting file keeps its place in pending/ and in the Review Queue; its
// review reason stays as the record of why it was reviewed. Approve later
// files it under the new type (a police slip then needs its submitted date).
export async function setDocumentType({ db, admin, reviewId, reason, documentType }) {
    const parsed = await pendingTarget(db, reviewId);

    const audit = await db.$transaction(async (tx) => {
        await lockTemporaryRow(tx, parsed.id);
        const row = await findPending(tx, parsed.id);
        if (!row) throw alreadyResolved();
        if (row.documentType === documentType) {
            throw new ReviewActionError(409, "SAME_DOCUMENT_TYPE", "The file already has this document type. Nothing was changed.");
        }
        await tx.temporaryData.update({ where: { temporaryId: row.temporaryId }, data: { documentType } });
        return createAudit(tx, {
            admin,
            action: REVIEW_ACTION.SET_DOCUMENT_TYPE,
            temporaryId: row.temporaryId,
            passportId: row.passportId ?? null,
            previousStatus: row.processingStatus,
            newStatus: row.processingStatus,
            reason,
            documentType,
            previousValue: row.documentType,
            newValue: documentType,
        });
    }, TRANSACTION_OPTIONS);

    return {
        action: REVIEW_ACTION.SET_DOCUMENT_TYPE,
        reviewId: toReviewId(parsed.kind, parsed.id),
        documentType,
        audit: toAuditEntry(audit, admin.name ?? null),
    };
}

// ---------------------------------------------------------------- assign client

// Links a waiting file to an existing client (passport ID and that client's
// unique ID). The sender's WhatsApp number, the client record and the
// processing summary (the original identity result) are not changed; the
// previous link, if any, is kept in the audit entry.
export async function assignClient({ db, admin, reviewId, reason, passportId }) {
    const parsed = await pendingTarget(db, reviewId);

    const outcome = await db.$transaction(async (tx) => {
        await lockTemporaryRow(tx, parsed.id);
        const row = await findPending(tx, parsed.id);
        if (!row) throw alreadyResolved();
        if (row.passportId === passportId) {
            throw new ReviewActionError(409, "SAME_CLIENT", "The file is already linked to this client. Nothing was changed.");
        }
        if (!(await lockClientRow(tx, passportId))) {
            throw new ReviewActionError(409, "CLIENT_NOT_FOUND", "No client has this passport ID. Choose an existing client; nothing was changed.");
        }
        const client = await tx.user.findUnique({ where: { passportId }, select: { passportId: true, uniqueId: true } });
        await tx.temporaryData.update({
            where: { temporaryId: row.temporaryId },
            data: { passportId: client.passportId, uniqueId: client.uniqueId },
        });
        const audit = await createAudit(tx, {
            admin,
            action: REVIEW_ACTION.ASSIGN_CLIENT,
            temporaryId: row.temporaryId,
            passportId: client.passportId,
            previousStatus: row.processingStatus,
            newStatus: row.processingStatus,
            reason,
            documentType: row.documentType,
            previousValue: row.passportId ?? null,
            newValue: client.passportId,
        });
        return { audit, client };
    }, TRANSACTION_OPTIONS);

    return {
        action: REVIEW_ACTION.ASSIGN_CLIENT,
        reviewId: toReviewId(parsed.kind, parsed.id),
        client: { passportId: outcome.client.passportId, uniqueId: outcome.client.uniqueId },
        audit: toAuditEntry(outcome.audit, admin.name ?? null),
    };
}

// ---------------------------------------------------------------- police slip date

const slipSelect = { documentId: true, passportId: true, documentType: true, verificationStatus: true, temporaryId: true, policeSubmittedDate: true };

// Sets or corrects the submitted date of a police slip stored in a client
// folder (VERIFIED, or REVIEW_REQUIRED), e.g. an older verified slip stored
// before dates were kept. Only this slip's date changes: no document is
// created, so the one-verified-slip rule is untouched. The countdown is
// calculated from the stored date, so the client page and the Police
// Workflow show the new status on their next load.
export async function setPoliceSubmittedDate({ db, admin, documentId, reason, policeSubmittedDate }) {
    const before = await db.document.findFirst({ where: { documentId }, select: slipSelect });
    if (!before) throw new ReviewActionError(404, "NOT_FOUND", "Document not found");
    if (before.documentType !== DOCUMENT_TYPES.POLICE_SLIP) {
        throw new ReviewActionError(409, "NOT_A_POLICE_SLIP", "Only a police slip has a submitted date.");
    }

    const audit = await db.$transaction(async (tx) => {
        await lockDocumentRow(tx, documentId);
        const row = await tx.document.findFirst({ where: { documentId }, select: slipSelect });
        if (!row) throw alreadyResolved();
        const previous = toYmd(row.policeSubmittedDate);
        if (previous === policeSubmittedDate) {
            throw new ReviewActionError(409, "SAME_POLICE_DATE", "The slip already has this submitted date. Nothing was changed.");
        }
        await tx.document.update({ where: { documentId }, data: { policeSubmittedDate: ymdToDate(policeSubmittedDate) } });
        return createAudit(tx, {
            admin,
            action: REVIEW_ACTION.SET_POLICE_DATE,
            temporaryId: row.temporaryId ?? null,
            documentId,
            passportId: row.passportId,
            previousStatus: row.verificationStatus,
            newStatus: row.verificationStatus,
            reason,
            policeSubmittedDate,
            documentType: row.documentType,
            previousValue: previous,
            newValue: policeSubmittedDate,
        });
    }, TRANSACTION_OPTIONS);

    return {
        action: REVIEW_ACTION.SET_POLICE_DATE,
        documentId,
        policeSubmittedDate,
        audit: toAuditEntry(audit, admin.name ?? null),
    };
}
