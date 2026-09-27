// Read-only Review Queue and Review Detail data (Phase 10).
//
// A review item is one of:
// - PENDING: a submission (temporary_data) whose file waits in pending/;
// - DOCUMENT: a file stored in a client folder with verification_status
//   REVIEW_REQUIRED (UNCLEAR band, including accepted low-quality passports).
// H3: a FAILED submission without a pending copy is shown separately
// (kind FAILED, "failed-<temporary_id>"): only when asked for, never in the
// queue total or Pending review, read-only (there is no retry).
// Nothing here writes; the review actions (approve, keep pending, remove
// from review) are in adminReviewActionService.js and the corrections in
// adminCorrectionService.js.

import path from "node:path";
import { VERIFICATION_STATUS } from "./clientDocumentService.js";
import { DOCUMENT_TYPES } from "./documentClassificationService.js";
import { REVIEW_REASON, REVIEW_REASON_CATEGORY } from "./reviewReason.js";
import { clientName } from "../utils/clientName.js";
import { ALLOWED_MIME_TYPES } from "../utils/fileValidation.js";
import { toYmd } from "./policeCountdownService.js";
import { describeFailure } from "./failureReason.js";

// Submissions waiting for a person: a file in pending/ (shared with the
// Overview and client page). A FAILED submission is not a review item by
// itself (decision 2026-09-25); it is only listed if a pending copy exists.
export const REVIEW_PENDING_WHERE = Object.freeze({ pendingStoragePath: { not: null } });
export const REVIEW_DOCUMENT_WHERE = Object.freeze({ verificationStatus: VERIFICATION_STATUS.REVIEW_REQUIRED });
// H3: processing failed and no copy waits in pending/ (one with a copy is a PENDING item).
export const FAILED_SUBMISSION_WHERE = Object.freeze({ processingStatus: "FAILED", pendingStoragePath: null });

export const REVIEW_KIND = Object.freeze({ PENDING: "PENDING", DOCUMENT: "DOCUMENT", FAILED: "FAILED" });

// A stored REVIEW_REQUIRED document only ever comes from the UNCLEAR band
// (clientDocumentService), so its reason is known even without a link.
const DOCUMENT_DEFAULT_REASON = REVIEW_REASON.LOW_CONFIDENCE;

// Review IDs name the table: "pending-<temporary_id>" / "document-<document_id>"
// / "failed-<temporary_id>" (H3, read-only).
const ID_PATTERN = /^(pending|document|failed)-([0-9a-fA-F-]{8,64})$/;
const ID_PREFIX = { [REVIEW_KIND.PENDING]: "pending", [REVIEW_KIND.DOCUMENT]: "document", [REVIEW_KIND.FAILED]: "failed" };

export function toReviewId(kind, id) {
    return `${ID_PREFIX[kind]}-${id}`;
}

export function parseReviewId(reviewId) {
    const match = typeof reviewId === "string" ? reviewId.match(ID_PATTERN) : null;
    if (!match) return null;
    const kind = Object.keys(ID_PREFIX).find((k) => ID_PREFIX[k] === match[1]);
    return { kind, id: match[2] };
}

const clientSelect = { passportId: true, uniqueId: true, firstName: true, otherName: true };
const toClient = (user) => (user ? { passportId: user.passportId, uniqueId: user.uniqueId, name: clientName(user) } : null);
const toIso = (date) => (date instanceof Date ? date.toISOString() : date ?? null);
const toNumber = (value) => (value === null || value === undefined ? null : Number(value));
const categoryOf = (reason) => (reason ? REVIEW_REASON_CATEGORY[reason] ?? "OTHER" : null);

function summaryConfidence(summary) {
    const value = summary?.confidence?.document;
    return typeof value === "number" ? value : null;
}

// ---------------------------------------------------------------- queue

export const REVIEW_QUEUE_DEFAULTS = Object.freeze({ page: 1, pageSize: 25, kind: "ALL", order: "asc" });
const MAX_PAGE_SIZE = 100;
// The queue merges two tables in memory; this bounds how deep one can page.
export const REVIEW_QUEUE_WINDOW = 1000;
const QUEUE_DOCUMENT_TYPES = [DOCUMENT_TYPES.PASSPORT, DOCUMENT_TYPES.POLICE_SLIP, DOCUMENT_TYPES.POLICE_REPORT, DOCUMENT_TYPES.MEDICAL, DOCUMENT_TYPES.UNKNOWN];
const PASSPORT_ID_PATTERN = /^[A-Za-z0-9]{1,20}$/;

// Validates GET /api/admin/review. Returns { params } or { errors }.
export function parseReviewQueueQuery(query = {}) {
    const errors = [];
    const params = { ...REVIEW_QUEUE_DEFAULTS };
    const single = (field) => {
        const value = query[field];
        if (value === undefined || value === "") return undefined;
        if (typeof value !== "string") {
            errors.push({ field, message: "must be given once" });
            return undefined;
        }
        return value;
    };
    const integer = (field, min, max) => {
        const value = single(field);
        if (value === undefined) return undefined;
        if (!/^\d{1,6}$/.test(value) || Number(value) < min || Number(value) > max) {
            errors.push({ field, message: `must be a whole number from ${min} to ${max}` });
            return undefined;
        }
        return Number(value);
    };
    const oneOf = (field, allowed) => {
        const value = single(field);
        if (value === undefined) return undefined;
        if (!allowed.includes(value)) {
            errors.push({ field, message: `must be one of: ${allowed.join(", ")}` });
            return undefined;
        }
        return value;
    };

    params.page = integer("page", 1, REVIEW_QUEUE_WINDOW) ?? params.page;
    params.pageSize = integer("pageSize", 1, MAX_PAGE_SIZE) ?? params.pageSize;
    params.kind = oneOf("kind", ["ALL", REVIEW_KIND.PENDING, REVIEW_KIND.DOCUMENT, REVIEW_KIND.FAILED]) ?? params.kind;
    params.documentType = oneOf("documentType", QUEUE_DOCUMENT_TYPES);
    params.reviewReason = oneOf("reviewReason", Object.values(REVIEW_REASON));
    params.order = oneOf("order", ["asc", "desc"]) ?? params.order;
    const passportId = single("passportId");
    if (passportId !== undefined) {
        if (PASSPORT_ID_PATTERN.test(passportId)) params.passportId = passportId.toUpperCase();
        else errors.push({ field: "passportId", message: "must be letters and digits (at most 20)" });
    }
    if (!errors.length && params.page * params.pageSize > REVIEW_QUEUE_WINDOW) {
        errors.push({ field: "page", message: `the queue can be paged up to item ${REVIEW_QUEUE_WINDOW}; use filters to narrow it` });
    }

    return errors.length ? { errors } : { params };
}

// Prisma where clauses for the sources under the given filters.
export function buildReviewWhere(params) {
    const pending = { AND: [REVIEW_PENDING_WHERE] };
    const document = { AND: [REVIEW_DOCUMENT_WHERE] };
    const failed = { AND: [FAILED_SUBMISSION_WHERE] };
    if (params.documentType) {
        pending.AND.push({ documentType: params.documentType });
        document.AND.push({ documentType: params.documentType });
        failed.AND.push({ documentType: params.documentType });
    }
    if (params.passportId) {
        pending.AND.push({ passportId: params.passportId });
        document.AND.push({ passportId: params.passportId });
        failed.AND.push({ passportId: params.passportId });
    }
    if (params.reviewReason) {
        pending.AND.push({ reviewReason: params.reviewReason });
        failed.AND.push({ reviewReason: params.reviewReason });
        const linked = { temporaryData: { is: { reviewReason: params.reviewReason } } };
        // Unlinked (older) review documents count as LOW_CONFIDENCE.
        document.AND.push(params.reviewReason === DOCUMENT_DEFAULT_REASON ? { OR: [linked, { temporaryId: null }] } : linked);
    }
    return { pending, document, failed };
}

// H3: a FAILED submission in the list (read-only; its safe failure code, never the error text).
function toFailedQueueItem(row) {
    return {
        reviewId: toReviewId(REVIEW_KIND.FAILED, row.temporaryId),
        kind: REVIEW_KIND.FAILED,
        documentType: row.documentType,
        processingStatus: row.processingStatus,
        verificationStatus: null,
        reviewReason: row.reviewReason ?? null,
        reviewCategory: categoryOf(row.reviewReason),
        confidence: null,
        receivedDate: toIso(row.createdDate),
        client: toClient(row.user),
        failure: describeFailure(row.processingSummary),
    };
}

function toPendingQueueItem(row) {
    return {
        reviewId: toReviewId(REVIEW_KIND.PENDING, row.temporaryId),
        kind: REVIEW_KIND.PENDING,
        documentType: row.documentType,
        processingStatus: row.processingStatus,
        verificationStatus: null,
        // Null for submissions processed before review reasons were recorded.
        reviewReason: row.reviewReason ?? null,
        reviewCategory: categoryOf(row.reviewReason),
        confidence: summaryConfidence(row.processingSummary),
        receivedDate: toIso(row.createdDate),
        client: toClient(row.user),
    };
}

function toDocumentQueueItem(row) {
    const reason = row.temporaryData?.reviewReason ?? DOCUMENT_DEFAULT_REASON;
    return {
        reviewId: toReviewId(REVIEW_KIND.DOCUMENT, row.documentId),
        kind: REVIEW_KIND.DOCUMENT,
        documentType: row.documentType,
        processingStatus: row.processingStatus,
        verificationStatus: row.verificationStatus,
        reviewReason: reason,
        reviewCategory: categoryOf(reason),
        confidence: toNumber(row.ocrConfidence),
        receivedDate: toIso(row.receivedDate),
        client: toClient(row.user),
    };
}

// Oldest first by default (waiting time); ties by review ID for stable pages.
function compareItems(order) {
    const direction = order === "desc" ? -1 : 1;
    return (a, b) => (a.receivedDate === b.receivedDate
        ? a.reviewId.localeCompare(b.reviewId)
        : (a.receivedDate < b.receivedDate ? -1 : 1) * direction);
}

async function queueSummary(db) {
    const [pendingByReason, reviewDocuments, failed] = await Promise.all([
        db.temporaryData.groupBy({ by: ["reviewReason"], where: REVIEW_PENDING_WHERE, _count: { _all: true } }),
        db.document.findMany({ where: REVIEW_DOCUMENT_WHERE, select: { temporaryData: { select: { reviewReason: true } } } }),
        db.temporaryData.count({ where: FAILED_SUBMISSION_WHERE }),
    ]);

    const byReason = {};
    let pending = 0;
    for (const group of pendingByReason) {
        const key = group.reviewReason ?? "NOT_RECORDED";
        byReason[key] = (byReason[key] ?? 0) + group._count._all;
        pending += group._count._all;
    }
    for (const doc of reviewDocuments) {
        const key = doc.temporaryData?.reviewReason ?? DOCUMENT_DEFAULT_REASON;
        byReason[key] = (byReason[key] ?? 0) + 1;
    }
    const byCategory = { IDENTITY: 0, QUALITY: 0, CONFLICT: 0, OTHER: 0 };
    for (const [reason, count] of Object.entries(byReason)) {
        byCategory[REVIEW_REASON_CATEGORY[reason] ?? "OTHER"] += count;
    }
    // `failed` (H3) is shown on its own: not part of `total` (Pending review).
    return { total: pending + reviewDocuments.length, pending, documents: reviewDocuments.length, byReason, byCategory, failed };
}

// H3: kind=FAILED lists the failed submissions (newest first unless asked otherwise).
async function listFailedSubmissions({ db, params, where }) {
    const [total, rows, summary] = await Promise.all([
        db.temporaryData.count({ where: where.failed }),
        db.temporaryData.findMany({
            where: where.failed,
            select: { temporaryId: true, documentType: true, processingStatus: true, reviewReason: true, processingSummary: true, createdDate: true, user: { select: clientSelect } },
            orderBy: [{ createdDate: params.order }, { temporaryId: "asc" }],
            skip: (params.page - 1) * params.pageSize,
            take: params.pageSize,
        }),
        queueSummary(db),
    ]);
    return {
        items: rows.map(toFailedQueueItem),
        pagination: { page: params.page, pageSize: params.pageSize, total, totalPages: Math.max(1, Math.ceil(total / params.pageSize)) },
        summary,
        filters: { kind: params.kind, documentType: params.documentType ?? null, reviewReason: params.reviewReason ?? null, passportId: params.passportId ?? null, order: params.order },
    };
}

export async function listReviewQueue({ db, params }) {
    const where = buildReviewWhere(params);
    if (params.kind === REVIEW_KIND.FAILED) return listFailedSubmissions({ db, params, where });
    const includePending = params.kind === "ALL" || params.kind === REVIEW_KIND.PENDING;
    const includeDocuments = params.kind === "ALL" || params.kind === REVIEW_KIND.DOCUMENT;
    const window = params.page * params.pageSize;

    const [pendingTotal, documentTotal, pendingRows, documentRows, summary] = await Promise.all([
        includePending ? db.temporaryData.count({ where: where.pending }) : 0,
        includeDocuments ? db.document.count({ where: where.document }) : 0,
        includePending
            ? db.temporaryData.findMany({
                where: where.pending,
                select: {
                    temporaryId: true, documentType: true, processingStatus: true, reviewReason: true,
                    processingSummary: true, createdDate: true, user: { select: clientSelect },
                },
                orderBy: [{ createdDate: params.order }, { temporaryId: "asc" }],
                take: window,
            })
            : [],
        includeDocuments
            ? db.document.findMany({
                where: where.document,
                select: {
                    documentId: true, documentType: true, processingStatus: true, verificationStatus: true,
                    ocrConfidence: true, receivedDate: true, user: { select: clientSelect },
                    temporaryData: { select: { reviewReason: true } },
                },
                orderBy: [{ receivedDate: params.order }, { documentId: "asc" }],
                take: window,
            })
            : [],
        queueSummary(db),
    ]);

    const merged = [...pendingRows.map(toPendingQueueItem), ...documentRows.map(toDocumentQueueItem)].sort(compareItems(params.order));
    const total = pendingTotal + documentTotal;

    return {
        items: merged.slice((params.page - 1) * params.pageSize, window),
        pagination: {
            page: params.page,
            pageSize: params.pageSize,
            total,
            totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
        },
        summary,
        filters: {
            kind: params.kind,
            documentType: params.documentType ?? null,
            reviewReason: params.reviewReason ?? null,
            passportId: params.passportId ?? null,
            order: params.order,
        },
    };
}

// ---------------------------------------------------------------- detail

export function mimeTypeForPath(storagePath) {
    const extension = path.extname(storagePath ?? "").toLowerCase();
    return { ".pdf": "application/pdf", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png" }[extension] ?? null;
}

// Loads the review item and where its file is. `null` if the ID is unknown
// or the record is not (or no longer) a review item.
async function loadReviewRecord(db, reviewId) {
    const parsed = parseReviewId(reviewId);
    if (!parsed) return null;

    // H3: a FAILED submission; its file is the original kept in temporary/.
    if (parsed.kind === REVIEW_KIND.FAILED) {
        const row = await db.temporaryData.findFirst({
            where: { AND: [{ temporaryId: parsed.id }, FAILED_SUBMISSION_WHERE] },
            select: {
                temporaryId: true, documentType: true, processingStatus: true, reviewReason: true, processingSummary: true,
                whatsappNumber: true, createdDate: true, temporaryStoragePath: true,
                user: { select: clientSelect },
            },
        });
        if (!row) return null;
        return {
            kind: REVIEW_KIND.FAILED,
            row,
            storagePath: row.temporaryStoragePath,
            file: { name: path.basename(row.temporaryStoragePath), mimeType: mimeTypeForPath(row.temporaryStoragePath), size: null, location: "TEMPORARY" },
        };
    }

    if (parsed.kind === REVIEW_KIND.PENDING) {
        const row = await db.temporaryData.findFirst({
            where: { AND: [{ temporaryId: parsed.id }, REVIEW_PENDING_WHERE] },
            select: {
                temporaryId: true, documentType: true, processingStatus: true, reviewReason: true, processingSummary: true,
                whatsappNumber: true, createdDate: true, pendingStoragePath: true, passportId: true, fileSha256: true,
                user: { select: clientSelect },
            },
        });
        if (!row) return null;
        const storagePath = row.pendingStoragePath;
        return {
            kind: REVIEW_KIND.PENDING,
            row,
            storagePath,
            file: {
                name: path.basename(storagePath),
                mimeType: mimeTypeForPath(storagePath),
                size: null,
                location: "PENDING",
            },
        };
    }

    const row = await db.document.findFirst({
        where: { AND: [{ documentId: parsed.id }, REVIEW_DOCUMENT_WHERE] },
        select: {
            documentId: true, documentType: true, processingStatus: true, verificationStatus: true, ocrConfidence: true,
            receivedDate: true, storedFilename: true, storagePath: true, mimeType: true, fileSize: true, policeSubmittedDate: true,
            user: { select: clientSelect },
            temporaryData: { select: { temporaryId: true, reviewReason: true, processingSummary: true, whatsappNumber: true, createdDate: true } },
        },
    });
    if (!row) return null;
    return {
        kind: REVIEW_KIND.DOCUMENT,
        row,
        storagePath: row.storagePath,
        file: {
            name: row.storedFilename,
            mimeType: ALLOWED_MIME_TYPES.includes(row.mimeType) ? row.mimeType : mimeTypeForPath(row.storagePath),
            size: toNumber(row.fileSize),
            location: "CLIENT",
        },
    };
}

// M4: the client's stored document that a waiting DUPLICATE is an exact copy
// of (same client, same checksum; unique), or null. IDs, type and status
// only; never paths or checksums.
export async function findDuplicateMatch(db, { passportId, fileSha256 }) {
    if (!passportId || !fileSha256) return null;
    const match = await db.document.findFirst({
        where: { passportId, fileSha256 },
        select: { documentId: true, documentType: true, verificationStatus: true, receivedDate: true },
    });
    return match
        ? { documentId: match.documentId, documentType: match.documentType, verificationStatus: match.verificationStatus, receivedDate: toIso(match.receivedDate) }
        : null;
}

// M4 (Policy B): the client's current VERIFIED document of a type, other
// than `exceptDocumentId` — the one a waiting EXISTING_VERIFIED_DOCUMENT
// item would replace, or an admin explicitly names for adminCorrectionService
// to check under lock. Reused by adminReviewActionService.js so both the
// review-blocker check and the review display agree on the same document.
// IDs, type, name and status only; never a storage path or checksum.
export async function findVerifiedOfType(db, { passportId, documentType, exceptDocumentId = null }) {
    if (!passportId || !documentType) return null;
    const match = await db.document.findFirst({
        where: {
            passportId, documentType, verificationStatus: VERIFICATION_STATUS.VERIFIED,
            ...(exceptDocumentId ? { documentId: { not: exceptDocumentId } } : {}),
        },
        select: { documentId: true, documentType: true, storedFilename: true, verificationStatus: true, receivedDate: true },
    });
    return match
        ? { documentId: match.documentId, documentType: match.documentType, storedFilename: match.storedFilename, verificationStatus: match.verificationStatus, receivedDate: toIso(match.receivedDate) }
        : null;
}

export async function getReviewItem({ db, reviewId }) {
    const record = await loadReviewRecord(db, reviewId);
    if (!record) return null;
    const { kind, row, file } = record;
    const isSubmission = kind === REVIEW_KIND.PENDING || kind === REVIEW_KIND.FAILED;
    const submission = isSubmission ? row : row.temporaryData;
    const reason = isSubmission ? row.reviewReason ?? null : row.temporaryData?.reviewReason ?? DOCUMENT_DEFAULT_REASON;
    const summary = submission?.processingSummary ?? null;
    const reviewIdString = toReviewId(kind, isSubmission ? row.temporaryId : row.documentId);

    return {
        reviewId: reviewIdString,
        kind,
        reviewReason: reason,
        reviewCategory: categoryOf(reason),
        document: {
            documentId: kind === REVIEW_KIND.DOCUMENT ? row.documentId : null,
            temporaryId: submission?.temporaryId ?? null,
            documentType: row.documentType,
            processingStatus: row.processingStatus,
            verificationStatus: kind === REVIEW_KIND.DOCUMENT ? row.verificationStatus : null,
            receivedDate: toIso(kind === REVIEW_KIND.DOCUMENT ? row.receivedDate : row.createdDate),
            confidence: kind === REVIEW_KIND.DOCUMENT ? toNumber(row.ocrConfidence) : summaryConfidence(summary),
            // Stored police slips: the submitted date on record (null otherwise).
            policeSubmittedDate: kind === REVIEW_KIND.DOCUMENT ? toYmd(row.policeSubmittedDate) : null,
        },
        client: toClient(row.user),
        // Who sent it (admins compare this with the client record).
        submission: submission ? { whatsappNumber: submission.whatsappNumber, receivedDate: toIso(submission.createdDate) } : null,
        // The PII-free processing summary saved by the pipeline; null for
        // items processed before review data was recorded. Its error text is
        // withheld (H3): even redacted it can name infrastructure (e.g. a
        // database host); the safe failure code below says what went wrong.
        processing: summary ? { ...summary, error: null } : null,
        // H3: why processing failed (safe code and stage), FAILED items only.
        failure: kind === REVIEW_KIND.FAILED ? describeFailure(summary) : null,
        // M4: for a waiting DUPLICATE, the existing document it copies.
        duplicateOf: kind === REVIEW_KIND.PENDING && row.processingStatus === "DUPLICATE"
            ? await findDuplicateMatch(db, { passportId: row.passportId, fileSha256: row.fileSha256 })
            : null,
        // M4 Policy B: for a waiting file of a type already VERIFIED for this
        // client, the existing document a Replace action would supersede.
        existingVerified: kind === REVIEW_KIND.PENDING && reason === REVIEW_REASON.EXISTING_VERIFIED_DOCUMENT
            ? await findVerifiedOfType(db, { passportId: row.passportId, documentType: row.documentType })
            : null,
        file: { ...file, previewUrl: file.mimeType ? `/api/admin/review/${reviewIdString}/file` : null },
    };
}

// The file of a review item, from private storage, through the backend
// only. The path always comes from the database record, never the request.
export async function getReviewFile({ db, bucket, reviewId }) {
    const record = await loadReviewRecord(db, reviewId);
    if (!record || !record.file.mimeType) return null;

    const { data, error } = await bucket.download(record.storagePath);
    if (error || !data) {
        return { unavailable: true };
    }
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(await data.arrayBuffer());
    return { buffer, mimeType: record.file.mimeType, fileName: record.file.name };
}
