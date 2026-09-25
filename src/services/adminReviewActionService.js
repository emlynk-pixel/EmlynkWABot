// Admin review actions (Phase 10, Checkpoint 4): APPROVE and KEEP_PENDING.
// There is no reject action: an unclear document stays pending until a
// person approves it, and nothing here deletes a document.
//
// Every action runs in one database transaction that first locks the
// reviewed row (SELECT … FOR UPDATE), re-reads its state and only then
// changes it, so two admins (or a double click) can't act on the same item
// at once. The audit entry is written in the same transaction: it exists
// exactly when the action took effect.

import crypto from "node:crypto";
import path from "node:path";

import { REVIEW_PENDING_WHERE, REVIEW_KIND, getReviewItem, mimeTypeForPath, parseReviewId, toReviewId } from "./adminReviewService.js";
import { DOCUMENT_PROCESSING_STATUS_STORED, VERIFICATION_STATUS } from "./clientDocumentService.js";
import { PROCESSING_STATUS } from "./documentProcessingService.js";
import { copyToFreeName, removeObject } from "./permanentStorageService.js";
import { clientFolderPath, DOCUMENT_STORAGE_TYPES, standardFileName, extensionForMimeType } from "../utils/storageNaming.js";
import { sha256Hex } from "../utils/fileChecksum.js";
import { safeErrorText } from "../utils/safeLog.js";

export const REVIEW_ACTION = Object.freeze({
    APPROVE: "APPROVE",
    KEEP_PENDING: "KEEP_PENDING",
});

export const MAX_REASON_LENGTH = 500;

// A second identical Keep Pending (same admin, item and reason) this soon
// after the first is treated as a repeated submit, not a new decision.
export const DUPLICATE_ACTION_WINDOW_MS = 60_000;

// Interactive transaction limits. Approve copies one file inside it.
const TRANSACTION_OPTIONS = Object.freeze({ maxWait: 10_000, timeout: 30_000 });

export class ReviewActionError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = "ReviewActionError";
        this.status = status;
        this.code = code;
    }
}

const notFound = () => new ReviewActionError(404, "NOT_FOUND", "Review item not found");
const alreadyResolved = () => new ReviewActionError(409, "ALREADY_RESOLVED", "This item is no longer waiting for review. Reload the page to see its current state.");
const typeName = (documentType) => documentType.toLowerCase().replace(/_/g, " ");

// ---------------------------------------------------------------- request

// Body of POST …/approve and …/keep-pending: { reason }. Required (1-500
// characters after trimming) for Keep Pending, optional for Approve.
// Returns { reason } or { errors }.
export function parseReviewActionBody(body, { reasonRequired }) {
    if (body !== undefined && (body === null || typeof body !== "object" || Array.isArray(body))) {
        return { errors: [{ field: "body", message: "must be a JSON object" }] };
    }
    const value = body?.reason;
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
        return reasonRequired ? { errors: [{ field: "reason", message: "is required" }] } : { reason: null };
    }
    if (typeof value !== "string") {
        return { errors: [{ field: "reason", message: "must be text" }] };
    }
    const reason = value.trim();
    if (reason.length > MAX_REASON_LENGTH) {
        return { errors: [{ field: "reason", message: `must be at most ${MAX_REASON_LENGTH} characters` }] };
    }
    return { reason };
}

// ---------------------------------------------------------------- locks

// Row locks, held until the transaction ends. Lock order is always
// reviewed row first, then the client's users row.
async function lockTemporaryRow(tx, temporaryId) {
    await tx.$queryRaw`SELECT "temporary_id" FROM "temporary_data" WHERE "temporary_id" = ${temporaryId} FOR UPDATE`;
}

async function lockDocumentRow(tx, documentId) {
    await tx.$queryRaw`SELECT "document_id" FROM "documents" WHERE "document_id" = ${documentId} FOR UPDATE`;
}

// Serializes approvals for one client, so two items of the same type can't
// both become the client's verified document.
async function lockClientRow(tx, passportId) {
    const rows = await tx.$queryRaw`SELECT "passport_id" FROM "users" WHERE "passport_id" = ${passportId} FOR UPDATE`;
    return rows.length > 0;
}

// ---------------------------------------------------------------- reads

const pendingSelect = {
    temporaryId: true, passportId: true, documentType: true, processingStatus: true, pendingStoragePath: true,
    fileSha256: true, processingSummary: true, createdDate: true,
};
const documentSelect = { documentId: true, passportId: true, documentType: true, verificationStatus: true, temporaryId: true };

const findPending = (db, temporaryId) =>
    db.temporaryData.findFirst({ where: { AND: [{ temporaryId }, REVIEW_PENDING_WHERE] }, select: pendingSelect });

const findReviewDocument = (db, documentId) =>
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
async function approvalBlocker(db, { passportId, documentType, exceptDocumentId }) {
    if (!passportId) {
        return new ReviewActionError(409, "CLIENT_NOT_IDENTIFIED", "This file is not linked to a client, so it can't be stored in a client folder. It stays pending.");
    }
    if (!DOCUMENT_STORAGE_TYPES[documentType]) {
        return new ReviewActionError(409, "NO_CLIENT_FOLDER", `A document of type "${typeName(documentType)}" has no client folder. It stays pending.`);
    }
    if (await findVerifiedOfType(db, { passportId, documentType, exceptDocumentId })) {
        return new ReviewActionError(409, "VERIFIED_DOCUMENT_EXISTS", `This client already has a verified ${typeName(documentType)}. It was not changed, and this item stays pending.`);
    }
    return null;
}

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
    });
    return {
        approve: blocker ? { available: false, code: blocker.code, message: blocker.message } : { available: true, code: null, message: null },
        keepPending: { available: true, code: null, message: null },
    };
}

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
        createdDate: row.createdDate instanceof Date ? row.createdDate.toISOString() : row.createdDate,
    };
}

function createAudit(tx, { admin, action, temporaryId = null, documentId = null, passportId = null, previousStatus, newStatus, reason }) {
    return tx.auditLog.create({
        data: { auditId: crypto.randomUUID(), adminId: admin.adminId, action, temporaryId, documentId, passportId, previousStatus, newStatus, reason },
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
async function approvePending({ db, bucket, admin, temporaryId, reason }) {
    const before = await findPending(db, temporaryId);
    if (!before) throw notFound();
    const blocker = await approvalBlocker(db, { passportId: before.passportId, documentType: before.documentType });
    if (blocker) throw blocker;

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
async function approveDocument({ db, admin, documentId, reason }) {
    const before = await findReviewDocument(db, documentId);
    if (!before) throw notFound();

    const outcome = await db.$transaction(async (tx) => {
        await lockDocumentRow(tx, documentId);
        const row = await findReviewDocument(tx, documentId);
        if (!row) throw alreadyResolved();
        await lockClientRow(tx, row.passportId);
        const blocker = await approvalBlocker(tx, { passportId: row.passportId, documentType: row.documentType, exceptDocumentId: row.documentId });
        if (blocker) throw blocker;

        await tx.document.update({ where: { documentId }, data: { verificationStatus: VERIFICATION_STATUS.VERIFIED } });
        const audit = await createAudit(tx, {
            admin,
            action: REVIEW_ACTION.APPROVE,
            temporaryId: row.temporaryId ?? null,
            documentId,
            passportId: row.passportId,
            previousStatus: VERIFICATION_STATUS.REVIEW_REQUIRED,
            newStatus: VERIFICATION_STATUS.VERIFIED,
            reason,
        });
        return { audit };
    }, TRANSACTION_OPTIONS);

    return { documentId, storedFilename: null, location: "CLIENT", pendingCopyRemoved: null, audit: outcome.audit };
}

export async function approveReviewItem({ db, bucket, admin, reviewId, reason = null }) {
    const parsed = parseReviewId(reviewId);
    if (!parsed) throw notFound();
    const result = parsed.kind === REVIEW_KIND.PENDING
        ? await approvePending({ db, bucket, admin, temporaryId: parsed.id, reason })
        : await approveDocument({ db, admin, documentId: parsed.id, reason });

    return {
        action: REVIEW_ACTION.APPROVE,
        reviewId: toReviewId(parsed.kind, parsed.id),
        document: {
            documentId: result.documentId,
            storedFilename: result.storedFilename,
            verificationStatus: VERIFICATION_STATUS.VERIFIED,
            location: result.location,
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
        return createAudit(tx, {
            admin,
            action: REVIEW_ACTION.KEEP_PENDING,
            temporaryId: isPending ? row.temporaryId : row.temporaryId ?? null,
            documentId: isPending ? null : row.documentId,
            passportId: row.passportId ?? null,
            previousStatus: status,
            newStatus: status,
            reason,
        });
    }, TRANSACTION_OPTIONS);

    return { action: REVIEW_ACTION.KEEP_PENDING, reviewId: toReviewId(parsed.kind, parsed.id), audit: toAuditEntry(audit, admin.name ?? null) };
}
