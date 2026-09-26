// Admin review actions (Phase 10): APPROVE, KEEP_PENDING and
// REMOVE_FROM_REVIEW; the corrections (set document type, assign client,
// set police slip date) are in adminCorrectionService.js. There is no reject
// action: an unclear document stays pending until a person decides. Nothing
// is ever removed automatically; REMOVE_FROM_REVIEW is a manual admin
// decision that permanently deletes one review item — a waiting file with
// its submission record, or a stored REVIEW_REQUIRED document with its file
// (the audit entry is kept).
//
// Every action runs in one database transaction that first locks the
// reviewed row (SELECT … FOR UPDATE), re-reads its state and only then
// changes it, so two admins (or a double click) can't act on the same item
// at once. The audit entry is written in the same transaction: it exists
// exactly when the action took effect.

import crypto from "node:crypto";
import path from "node:path";

import { REVIEW_PENDING_WHERE, REVIEW_KIND, findDuplicateMatch, getReviewItem, mimeTypeForPath, parseReviewId, toReviewId } from "./adminReviewService.js";
import { DOCUMENT_PROCESSING_STATUS_STORED, VERIFICATION_STATUS } from "./clientDocumentService.js";
import { PROCESSING_STATUS } from "./documentProcessingService.js";
import { copyToFreeName, removeObject } from "./permanentStorageService.js";
import { clientFolderPath, DOCUMENT_STORAGE_TYPES, standardFileName, extensionForMimeType } from "../utils/storageNaming.js";
import { sha256Hex } from "../utils/fileChecksum.js";
import { safeErrorText } from "../utils/safeLog.js";
import { businessDateOf, isValidBusinessDate } from "../utils/businessDay.js";
import { DOCUMENT_TYPES } from "./documentClassificationService.js";
import { toYmd, ymdToDate } from "./policeCountdownService.js";

export const REVIEW_ACTION = Object.freeze({
    APPROVE: "APPROVE",
    KEEP_PENDING: "KEEP_PENDING",
    REMOVE_FROM_REVIEW: "REMOVE_FROM_REVIEW",
    // Corrections (adminCorrectionService.js)
    SET_DOCUMENT_TYPE: "SET_DOCUMENT_TYPE",
    ASSIGN_CLIENT: "ASSIGN_CLIENT",
    SET_POLICE_DATE: "SET_POLICE_DATE",
});

// new_status of a REMOVE_FROM_REVIEW entry (the record itself no longer exists).
export const REMOVED_STATUS = "REMOVED";

export const MAX_REASON_LENGTH = 500;

// A second identical Keep Pending (same admin, item and reason) this soon
// after the first is treated as a repeated submit, not a new decision.
export const DUPLICATE_ACTION_WINDOW_MS = 60_000;

// Interactive transaction limits. Approve copies one file inside it.
export const TRANSACTION_OPTIONS = Object.freeze({ maxWait: 10_000, timeout: 30_000 });

export class ReviewActionError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = "ReviewActionError";
        this.status = status;
        this.code = code;
    }
}

export const notFound = () => new ReviewActionError(404, "NOT_FOUND", "Review item not found");
export const alreadyResolved = () => new ReviewActionError(409, "ALREADY_RESOLVED", "This item is no longer waiting for review. Reload the page to see its current state.");
const typeName = (documentType) => documentType.toLowerCase().replace(/_/g, " ");

// ---------------------------------------------------------------- request

// Same bounds as the OCR date reader (policeReportDateService.js).
export const EARLIEST_POLICE_DATE = "2000-01-01";

// Body of POST …/approve and …/keep-pending: { reason }. Required (1-500
// characters after trimming) for Keep Pending, optional for Approve.
// Approve also takes { policeSubmittedDate: "YYYY-MM-DD" } for a police slip
// (a real date from 2000 up to today in Sri Lanka).
// Returns { reason, policeSubmittedDate } or { errors }.
export function parseReviewActionBody(body, { reasonRequired, acceptsPoliceDate = false, now = new Date() }) {
    if (body !== undefined && (body === null || typeof body !== "object" || Array.isArray(body))) {
        return { errors: [{ field: "body", message: "must be a JSON object" }] };
    }
    const errors = [];
    let reason = null;
    const value = body?.reason;
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
        if (reasonRequired) errors.push({ field: "reason", message: "is required" });
    } else if (typeof value !== "string") {
        errors.push({ field: "reason", message: "must be text" });
    } else if (value.trim().length > MAX_REASON_LENGTH) {
        errors.push({ field: "reason", message: `must be at most ${MAX_REASON_LENGTH} characters` });
    } else {
        reason = value.trim();
    }

    let policeSubmittedDate = null;
    const date = acceptsPoliceDate ? body?.policeSubmittedDate : undefined;
    if (date !== undefined && date !== null && date !== "") {
        if (!isValidBusinessDate(date)) {
            errors.push({ field: "policeSubmittedDate", message: "must be a date as YYYY-MM-DD" });
        } else if (date < EARLIEST_POLICE_DATE || date > businessDateOf(now)) {
            errors.push({ field: "policeSubmittedDate", message: "must be between 2000-01-01 and today" });
        } else {
            policeSubmittedDate = date;
        }
    }
    return errors.length ? { errors } : { reason, policeSubmittedDate };
}

// The submitted date an approval stores for a police slip, or an error.
//   storedDate: the slip's date already on record (read by OCR), if any.
//   givenDate:  the date the admin entered, if any.
// A slip without a date needs one; a slip whose date OCR read keeps it
// (the admin confirms it; a different date is refused). Other document
// types take no date.
function policeDateForApproval({ documentType, storedDate, givenDate }) {
    if (documentType !== DOCUMENT_TYPES.POLICE_SLIP) {
        if (givenDate) throw new ReviewActionError(400, "POLICE_DATE_NOT_APPLICABLE", "A submitted date is only taken when approving a police slip.");
        return null;
    }
    if (storedDate) {
        if (givenDate && givenDate !== storedDate) {
            throw new ReviewActionError(409, "POLICE_DATE_ALREADY_SET", `The submitted date ${storedDate} was read from the slip and can't be changed here.`);
        }
        return storedDate;
    }
    if (!givenDate) {
        throw new ReviewActionError(400, "POLICE_DATE_REQUIRED", "Enter the submitted date shown on the police slip to approve it.");
    }
    return givenDate;
}

// ---------------------------------------------------------------- locks

// Row locks, held until the transaction ends. Lock order is always
// reviewed row first, then the client's users row.
export async function lockTemporaryRow(tx, temporaryId) {
    await tx.$queryRaw`SELECT "temporary_id" FROM "temporary_data" WHERE "temporary_id" = ${temporaryId} FOR UPDATE`;
}

export async function lockDocumentRow(tx, documentId) {
    await tx.$queryRaw`SELECT "document_id" FROM "documents" WHERE "document_id" = ${documentId} FOR UPDATE`;
}

// Serializes approvals for one client, so two items of the same type can't
// both become the client's verified document.
export async function lockClientRow(tx, passportId) {
    const rows = await tx.$queryRaw`SELECT "passport_id" FROM "users" WHERE "passport_id" = ${passportId} FOR UPDATE`;
    return rows.length > 0;
}

// ---------------------------------------------------------------- reads

const pendingSelect = {
    temporaryId: true, passportId: true, documentType: true, processingStatus: true, pendingStoragePath: true,
    temporaryStoragePath: true, fileSha256: true, processingSummary: true, createdDate: true,
};
const documentSelect = { documentId: true, passportId: true, documentType: true, verificationStatus: true, temporaryId: true, policeSubmittedDate: true, storagePath: true, fileSha256: true };

export const findPending = (db, temporaryId) =>
    db.temporaryData.findFirst({ where: { AND: [{ temporaryId }, REVIEW_PENDING_WHERE] }, select: pendingSelect });

export const findReviewDocument = (db, documentId) =>
    db.document.findFirst({ where: { documentId, verificationStatus: VERIFICATION_STATUS.REVIEW_REQUIRED }, select: documentSelect });

// The client's existing verified document of this type, other than `exceptDocumentId`.
const findVerifiedOfType = (db, { passportId, documentType, exceptDocumentId }) =>
    db.document.findFirst({
        where: {
            passportId,
            documentType,
            verificationStatus: VERIFICATION_STATUS.VERIFIED,
            ...(exceptDocumentId ? { documentId: { not: exceptDocumentId } } : {}),
        },
        select: { documentId: true },
    });

// Why Approve is not possible for this item right now, or null. Checked
// again under the locks when the action runs; this read is for the page.
async function approvalBlocker(db, { passportId, documentType, exceptDocumentId, duplicateOf = null }) {
    if (!passportId) {
        return new ReviewActionError(409, "CLIENT_NOT_IDENTIFIED", "This file is not linked to a client, so it can't be stored in a client folder. It stays pending.");
    }
    // M4: the client already has this exact file. Nothing to store; keep it
    // pending or remove it from review. The existing document is not changed.
    if (duplicateOf) {
        return new ReviewActionError(409, "DUPLICATE_FILE", `This document is an exact duplicate of the client's existing ${duplicateOf.verificationStatus === VERIFICATION_STATUS.VERIFIED ? "verified " : ""}${typeName(duplicateOf.documentType)}. The existing document was not changed; keep this item pending or remove it from review.`);
    }
    if (!DOCUMENT_STORAGE_TYPES[documentType]) {
        return new ReviewActionError(409, "NO_CLIENT_FOLDER", `A document of type "${typeName(documentType)}" has no client folder. It stays pending.`);
    }
    if (await findVerifiedOfType(db, { passportId, documentType, exceptDocumentId })) {
        return new ReviewActionError(409, "VERIFIED_DOCUMENT_EXISTS", `This client already has a verified ${typeName(documentType)}. It was not changed, and this item stays pending.`);
    }
    return null;
}

const correctable = (kind) => (kind === REVIEW_KIND.PENDING
    ? { available: true, code: null, message: null }
    : { available: false, code: "NOT_CORRECTABLE", message: "Only files waiting in pending storage can be corrected here. A stored document is already in its client folder." });

// For GET /review/:reviewId: which actions the page may offer.
export async function reviewActionAvailability({ db, reviewId }) {
    const parsed = parseReviewId(reviewId);
    if (!parsed) return null;
    const row = parsed.kind === REVIEW_KIND.PENDING ? await findPending(db, parsed.id) : await findReviewDocument(db, parsed.id);
    if (!row) return null;
    const blocker = await approvalBlocker(db, {
        passportId: row.passportId,
        documentType: row.documentType,
        exceptDocumentId: parsed.kind === REVIEW_KIND.DOCUMENT ? row.documentId : null,
        duplicateOf: await duplicateMatchOf(db, row),
    });
    // A police slip without a stored date can only be approved with one.
    const needsPoliceDate = row.documentType === DOCUMENT_TYPES.POLICE_SLIP && !toYmd(row.policeSubmittedDate);
    return {
        approve: blocker
            ? { available: false, code: blocker.code, message: blocker.message, needsPoliceDate }
            : { available: true, code: null, message: null, needsPoliceDate },
        keepPending: { available: true, code: null, message: null },
        // Every review item can be removed: a waiting file, or a stored
        // REVIEW_REQUIRED document (never a VERIFIED one: it is not a review item).
        remove: { available: true, code: null, message: null },
        // Corrections of a waiting file (a stored document is already in a
        // client folder for its type).
        setDocumentType: correctable(parsed.kind),
        assignClient: correctable(parsed.kind),
    };
}

// M4: for a waiting DUPLICATE, the existing document it is an exact copy of.
const duplicateMatchOf = (db, row) => (row.processingStatus === PROCESSING_STATUS.DUPLICATE && row.temporaryId
    ? findDuplicateMatch(db, { passportId: row.passportId, fileSha256: row.fileSha256 })
    : null);

// ---------------------------------------------------------------- audit

export function toAuditEntry(row, adminName = row.admin?.name ?? null) {
    return {
        auditId: row.auditId,
        action: row.action,
        adminId: row.adminId,
        adminName,
        reason: row.reason ?? null,
        previousStatus: row.previousStatus,
        newStatus: row.newStatus,
        policeSubmittedDate: toYmd(row.policeSubmittedDate),
        // Kept for removed files (checksums are never returned).
        documentType: row.documentType ?? null,
        // Corrections: the value before and after (type, passport ID or date).
        previousValue: row.previousValue ?? null,
        newValue: row.newValue ?? null,
        createdDate: row.createdDate instanceof Date ? row.createdDate.toISOString() : row.createdDate,
    };
}

export function createAudit(tx, {
    admin, action, temporaryId = null, documentId = null, passportId = null, previousStatus, newStatus, reason,
    policeSubmittedDate = null, documentType = null, fileSha256 = null, previousValue = null, newValue = null,
}) {
    return tx.auditLog.create({
        data: {
            auditId: crypto.randomUUID(), adminId: admin.adminId, action, temporaryId, documentId, passportId, previousStatus, newStatus, reason,
            policeSubmittedDate: policeSubmittedDate ? ymdToDate(policeSubmittedDate) : null,
            documentType, fileSha256, previousValue, newValue,
        },
    });
}

// Review history of an item, newest first. A document stored from a
// submission also shows the entries made while it was pending.
export async function listAuditEntries({ db, temporaryId = null, documentId = null, limit = 50 }) {
    const or = [];
    if (temporaryId) or.push({ temporaryId });
    if (documentId) or.push({ documentId });
    if (!or.length) return [];
    const rows = await db.auditLog.findMany({
        where: { OR: or },
        include: { admin: { select: { name: true } } },
        orderBy: [{ createdDate: "desc" }, { auditId: "asc" }],
        take: limit,
    });
    return rows.map((row) => toAuditEntry(row));
}

// GET /review/:reviewId: the item, its review history and the actions the
// page may offer. null when it is not (or no longer) a review item.
export async function getReviewItemWithActions({ db, reviewId }) {
    const item = await getReviewItem({ db, reviewId });
    if (!item) return null;
    const [auditLog, actions] = await Promise.all([
        listAuditEntries({ db, temporaryId: item.document.temporaryId, documentId: item.document.documentId }),
        reviewActionAvailability({ db, reviewId }),
    ]);
    return { ...item, auditLog, actions };
}

// ---------------------------------------------------------------- approve

// PENDING item: copy the pending file into the client folder under the
// standard name (passport.pdf, passport_v2.pdf, … as the pipeline does),
// record it as a VERIFIED document, resolve the submission, write the
// audit entry. Storage can't join the database transaction, so the copy is
// removed again if the transaction fails; the pending file is only removed
// after the transaction has committed.
async function approvePending({ db, bucket, admin, temporaryId, reason, policeSubmittedDate: givenDate }) {
    const before = await findPending(db, temporaryId);
    if (!before) throw notFound();
    const blocker = await approvalBlocker(db, { passportId: before.passportId, documentType: before.documentType, duplicateOf: await duplicateMatchOf(db, before) });
    if (blocker) throw blocker;
    // A waiting slip has no stored date (only slips filed under a client keep theirs).
    const policeSubmittedDate = policeDateForApproval({ documentType: before.documentType, storedDate: null, givenDate });

    const mimeType = mimeTypeForPath(before.pendingStoragePath);
    if (!mimeType) {
        throw new ReviewActionError(409, "UNSUPPORTED_FILE", "The pending file has an unsupported type and can't be stored in a client folder. It stays pending.");
    }

    // Read the file once: its size is needed for the documents row, and its
    // checksum must still match the one recorded when it was received.
    const { data, error } = await bucket.download(before.pendingStoragePath);
    if (error || !data) {
        throw new ReviewActionError(502, "STORAGE_UNAVAILABLE", "The pending file could not be read from storage. Nothing was changed.");
    }
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(await data.arrayBuffer());
    const fileSha256 = sha256Hex(buffer);
    if (before.fileSha256 && before.fileSha256 !== fileSha256) {
        throw new ReviewActionError(409, "FILE_CHANGED", "The pending file no longer matches the file that was received. Nothing was changed.");
    }

    let copiedPath = null;
    try {
        const outcome = await db.$transaction(async (tx) => {
            await lockTemporaryRow(tx, temporaryId);
            const row = await findPending(tx, temporaryId);
            if (!row || row.pendingStoragePath !== before.pendingStoragePath) throw alreadyResolved();
            if (!(await lockClientRow(tx, row.passportId))) {
                throw new ReviewActionError(409, "CLIENT_NOT_IDENTIFIED", "The linked client no longer exists. The item stays pending.");
            }
            const lockedBlocker = await approvalBlocker(tx, { passportId: row.passportId, documentType: row.documentType });
            if (lockedBlocker) throw lockedBlocker;
            if (await tx.document.findFirst({ where: { passportId: row.passportId, fileSha256 }, select: { documentId: true } })) {
                throw new ReviewActionError(409, "DUPLICATE_FILE", "This client already has this exact file. The item stays pending.");
            }

            const existing = await tx.document.count({ where: { passportId: row.passportId, documentType: row.documentType } });
            const copy = await copyToFreeName(
                {
                    fromPath: row.pendingStoragePath,
                    folder: clientFolderPath(row.passportId, row.documentType),
                    nameForAttempt: (version) => standardFileName(row.documentType, version, extensionForMimeType(mimeType)),
                    firstAttempt: existing + 1,
                },
                { bucket }
            );
            copiedPath = copy.storagePath;

            const confidence = row.processingSummary?.confidence?.document;
            const documentId = crypto.randomUUID();
            await tx.document.create({
                data: {
                    documentId,
                    passportId: row.passportId,
                    documentType: row.documentType,
                    originalFilename: path.basename(row.pendingStoragePath),
                    storedFilename: copy.fileName,
                    storagePath: copy.storagePath,
                    mimeType,
                    fileSize: BigInt(buffer.length),
                    receivedDate: row.createdDate,
                    processingStatus: DOCUMENT_PROCESSING_STATUS_STORED,
                    verificationStatus: VERIFICATION_STATUS.VERIFIED,
                    ocrConfidence: typeof confidence === "number" ? Math.round(confidence * 100) / 100 : null,
                    fileSha256,
                    temporaryId: row.temporaryId,
                    policeSubmittedDate: policeSubmittedDate ? ymdToDate(policeSubmittedDate) : null,
                },
            });
            await tx.temporaryData.update({
                where: { temporaryId: row.temporaryId },
                data: { pendingStoragePath: null, processingStatus: PROCESSING_STATUS.VERIFIED },
            });
            const audit = await createAudit(tx, {
                admin,
                action: REVIEW_ACTION.APPROVE,
                temporaryId: row.temporaryId,
                documentId,
                passportId: row.passportId,
                previousStatus: row.processingStatus,
                newStatus: VERIFICATION_STATUS.VERIFIED,
                reason,
                policeSubmittedDate,
            });
            return { documentId, storedFilename: copy.fileName, audit, pendingPath: row.pendingStoragePath };
        }, TRANSACTION_OPTIONS);

        // Committed: the file now lives in the client folder. Removing the
        // pending original completes the move; if that fails the records
        // are still correct and only a stray object is left in pending/.
        const removal = await removeObject(outcome.pendingPath, { bucket });
        if (!removal.removed) {
            console.warn("Review approve: pending copy not removed", { temporaryId, error: removal.error });
        }
        return {
            documentId: outcome.documentId,
            storedFilename: outcome.storedFilename,
            location: "CLIENT",
            pendingCopyRemoved: removal.removed,
            audit: outcome.audit,
        };
    } catch (error) {
        if (copiedPath) {
            const cleanup = await removeObject(copiedPath, { bucket });
            if (!cleanup.removed) {
                console.error("Review approve: copy in client folder NOT removed after a failed approval", { temporaryId, error: cleanup.error });
            }
        }
        if (error instanceof ReviewActionError) throw error;
        if (error?.code === "P2002") {
            throw new ReviewActionError(409, "DUPLICATE_FILE", "This client already has this exact file. The item stays pending.");
        }
        if (error?.name === "StorageCopyError") {
            console.error("Review approve: storage copy failed", { temporaryId, error: safeErrorText(error) });
            throw new ReviewActionError(502, "STORAGE_UNAVAILABLE", "The file could not be stored in the client folder. Nothing was changed; the item stays pending.");
        }
        throw error;
    }
}

// DOCUMENT item: the file is already in the client folder (REVIEW_REQUIRED);
// approval marks it VERIFIED. No storage change.
async function approveDocument({ db, admin, documentId, reason, policeSubmittedDate: givenDate }) {
    const before = await findReviewDocument(db, documentId);
    if (!before) throw notFound();
    policeDateForApproval({ documentType: before.documentType, storedDate: toYmd(before.policeSubmittedDate), givenDate });

    const outcome = await db.$transaction(async (tx) => {
        await lockDocumentRow(tx, documentId);
        const row = await findReviewDocument(tx, documentId);
        if (!row) throw alreadyResolved();
        await lockClientRow(tx, row.passportId);
        const blocker = await approvalBlocker(tx, { passportId: row.passportId, documentType: row.documentType, exceptDocumentId: row.documentId });
        if (blocker) throw blocker;

        const storedDate = toYmd(row.policeSubmittedDate);
        const policeSubmittedDate = policeDateForApproval({ documentType: row.documentType, storedDate, givenDate });
        await tx.document.update({
            where: { documentId },
            data: {
                verificationStatus: VERIFICATION_STATUS.VERIFIED,
                // Only a slip that had no date gets the one the admin entered.
                ...(policeSubmittedDate && !storedDate ? { policeSubmittedDate: ymdToDate(policeSubmittedDate) } : {}),
            },
        });
        const audit = await createAudit(tx, {
            admin,
            action: REVIEW_ACTION.APPROVE,
            temporaryId: row.temporaryId ?? null,
            documentId,
            passportId: row.passportId,
            previousStatus: VERIFICATION_STATUS.REVIEW_REQUIRED,
            newStatus: VERIFICATION_STATUS.VERIFIED,
            reason,
            policeSubmittedDate,
        });
        return { audit };
    }, TRANSACTION_OPTIONS);

    return { documentId, storedFilename: null, location: "CLIENT", pendingCopyRemoved: null, audit: outcome.audit };
}

export async function approveReviewItem({ db, bucket, admin, reviewId, reason = null, policeSubmittedDate = null }) {
    const parsed = parseReviewId(reviewId);
    if (!parsed) throw notFound();
    const result = parsed.kind === REVIEW_KIND.PENDING
        ? await approvePending({ db, bucket, admin, temporaryId: parsed.id, reason, policeSubmittedDate })
        : await approveDocument({ db, admin, documentId: parsed.id, reason, policeSubmittedDate });

    return {
        action: REVIEW_ACTION.APPROVE,
        reviewId: toReviewId(parsed.kind, parsed.id),
        document: {
            documentId: result.documentId,
            storedFilename: result.storedFilename,
            verificationStatus: VERIFICATION_STATUS.VERIFIED,
            location: result.location,
            policeSubmittedDate: toYmd(result.audit.policeSubmittedDate),
        },
        pendingCopyRemoved: result.pendingCopyRemoved,
        audit: toAuditEntry(result.audit, admin.name ?? null),
    };
}

// ---------------------------------------------------------------- keep pending

// The item stays exactly where and as it is (file in pending/ or a
// REVIEW_REQUIRED document) and stays in the Review Queue; only the admin's
// decision and reason are recorded.
export async function keepReviewItemPending({ db, admin, reviewId, reason, now = () => new Date() }) {
    const parsed = parseReviewId(reviewId);
    if (!parsed) throw notFound();
    const isPending = parsed.kind === REVIEW_KIND.PENDING;

    const exists = isPending ? await findPending(db, parsed.id) : await findReviewDocument(db, parsed.id);
    if (!exists) throw notFound();

    const audit = await db.$transaction(async (tx) => {
        if (isPending) await lockTemporaryRow(tx, parsed.id);
        else await lockDocumentRow(tx, parsed.id);
        const row = isPending ? await findPending(tx, parsed.id) : await findReviewDocument(tx, parsed.id);
        if (!row) throw alreadyResolved();

        const subject = isPending ? { temporaryId: row.temporaryId } : { documentId: row.documentId };
        const latest = await tx.auditLog.findFirst({ where: subject, orderBy: [{ createdDate: "desc" }, { auditId: "asc" }] });
        const repeated = latest
            && latest.action === REVIEW_ACTION.KEEP_PENDING
            && latest.adminId === admin.adminId
            && latest.reason === reason
            && now().getTime() - new Date(latest.createdDate).getTime() < DUPLICATE_ACTION_WINDOW_MS;
        if (repeated) {
            throw new ReviewActionError(409, "DUPLICATE_ACTION", "You already kept this item pending with the same reason a moment ago.");
        }

        const status = isPending ? row.processingStatus : row.verificationStatus;
        // M4: a kept duplicate records the existing document it copies.
        const match = isPending ? await duplicateMatchOf(tx, row) : null;
        return createAudit(tx, {
            admin,
            action: REVIEW_ACTION.KEEP_PENDING,
            temporaryId: isPending ? row.temporaryId : row.temporaryId ?? null,
            documentId: isPending ? match?.documentId ?? null : row.documentId,
            ...(match ? { documentType: row.documentType, fileSha256: row.fileSha256 ?? null } : {}),
            passportId: row.passportId ?? null,
            previousStatus: status,
            newStatus: status,
            reason,
        });
    }, TRANSACTION_OPTIONS);

    return { action: REVIEW_ACTION.KEEP_PENDING, reviewId: toReviewId(parsed.kind, parsed.id), audit: toAuditEntry(audit, admin.name ?? null) };
}

// ---------------------------------------------------------------- remove from review

// A manual admin decision after inspecting a review item. There is no undo.
// - Waiting file (pending-<id>): the file in pending/, its original in
//   temporary/ and its temporary_data row are deleted permanently.
// - Stored document (document-<id>, REVIEW_REQUIRED only): its documents row
//   and its file in the client folder are deleted permanently. A VERIFIED
//   document is never a review item and can't be removed: the delete itself
//   only matches REVIEW_REQUIRED. The submission it came from (temporary_data
//   and the temporary/ original) stays as the record of what was received.
// Nothing else is touched, in particular not the client's other documents.
//
// The audit entry (admin, reason, previous status, document type, checksum)
// is written and the row deleted in one transaction; the files are deleted
// only after it has committed. If deleting a file fails, the item is still
// gone and only a stray object is left (logged).
export async function removeFromReview({ db, bucket, admin, reviewId, reason }) {
    const parsed = parseReviewId(reviewId);
    if (!parsed) throw notFound();
    if (parsed.kind !== REVIEW_KIND.PENDING) {
        return removeStoredDocument({ db, bucket, admin, documentId: parsed.id, reason });
    }
    if (!(await findPending(db, parsed.id))) throw notFound();

    const outcome = await db.$transaction(async (tx) => {
        await lockTemporaryRow(tx, parsed.id);
        const row = await findPending(tx, parsed.id);
        if (!row) throw alreadyResolved();
        // M4: a removed duplicate records the existing document it copied
        // (which is not touched: only this submission's files and row go).
        const match = await duplicateMatchOf(tx, row);

        const audit = await createAudit(tx, {
            admin,
            action: REVIEW_ACTION.REMOVE_FROM_REVIEW,
            temporaryId: row.temporaryId,
            documentId: match?.documentId ?? null,
            passportId: row.passportId ?? null,
            previousStatus: row.processingStatus,
            newStatus: REMOVED_STATUS,
            reason,
            documentType: row.documentType,
            fileSha256: row.fileSha256 ?? null,
        });
        await tx.temporaryData.delete({ where: { temporaryId: row.temporaryId } });
        return { audit, paths: [row.pendingStoragePath, row.temporaryStoragePath].filter(Boolean) };
    }, TRANSACTION_OPTIONS);

    // Committed: the record is gone. Now the files.
    const removals = await Promise.all(outcome.paths.map((storagePath) => removeObject(storagePath, { bucket })));
    const failed = removals.filter((result) => !result.removed);
    if (failed.length) {
        console.warn("Review remove: file(s) not deleted after the record was removed", { temporaryId: parsed.id, failed: failed.length, error: failed[0].error });
    }

    return {
        action: REVIEW_ACTION.REMOVE_FROM_REVIEW,
        reviewId: toReviewId(parsed.kind, parsed.id),
        filesDeleted: failed.length === 0,
        audit: toAuditEntry(outcome.audit, admin.name ?? null),
    };
}

async function removeStoredDocument({ db, bucket, admin, documentId, reason }) {
    if (!(await findReviewDocument(db, documentId))) throw notFound();

    const outcome = await db.$transaction(async (tx) => {
        await lockDocumentRow(tx, documentId);
        const row = await findReviewDocument(tx, documentId);
        if (!row) throw alreadyResolved();

        const audit = await createAudit(tx, {
            admin,
            action: REVIEW_ACTION.REMOVE_FROM_REVIEW,
            temporaryId: row.temporaryId ?? null,
            documentId: row.documentId,
            passportId: row.passportId,
            previousStatus: VERIFICATION_STATUS.REVIEW_REQUIRED,
            newStatus: REMOVED_STATUS,
            reason,
            documentType: row.documentType,
            fileSha256: row.fileSha256 ?? null,
        });
        // Only this REVIEW_REQUIRED row: a VERIFIED document can never match.
        const { count } = await tx.document.deleteMany({
            where: { documentId: row.documentId, verificationStatus: VERIFICATION_STATUS.REVIEW_REQUIRED },
        });
        if (count !== 1) throw alreadyResolved();
        // The file is deleted only if no other document points at it.
        const shared = row.storagePath
            ? await tx.document.count({ where: { storagePath: row.storagePath, documentId: { not: row.documentId } } })
            : 0;
        return { audit, path: shared === 0 ? row.storagePath : null };
    }, TRANSACTION_OPTIONS);

    // Committed: the record is gone. Now its file in the client folder.
    const removal = outcome.path ? await removeObject(outcome.path, { bucket }) : { removed: true };
    if (!removal.removed) {
        console.warn("Review remove: stored file not deleted after the record was removed", { documentId, error: removal.error });
    }

    return {
        action: REVIEW_ACTION.REMOVE_FROM_REVIEW,
        reviewId: toReviewId(REVIEW_KIND.DOCUMENT, documentId),
        filesDeleted: removal.removed,
        audit: toAuditEntry(outcome.audit, admin.name ?? null),
    };
}
