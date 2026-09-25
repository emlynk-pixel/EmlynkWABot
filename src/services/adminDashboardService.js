// Read-only data for the admin dashboard (Phase 10, Checkpoint 2).
//
// Two tables hold what the dashboard shows:
// - documents: files stored in a client folder (processing_status STORED,
//   verification_status VERIFIED or REVIEW_REQUIRED).
// - temporary_data: every received submission and its pipeline outcome
//   (VERIFIED … UNDEFINED, MANUAL_REVIEW, CONFLICT, DUPLICATE, FAILED). A
//   row with pending_storage_path has a file waiting in pending/ for review.
//
// Nothing here writes. Storage paths, checksums and sender numbers of
// submissions are never returned.

import { DOCUMENT_TYPES } from "./documentClassificationService.js";
import { VERIFICATION_STATUS } from "./clientDocumentService.js";
import { businessDateOf, businessDayRange } from "../utils/businessDay.js";
import { clientName } from "../utils/clientName.js";
import { REVIEW_PENDING_WHERE } from "./adminReviewService.js";

export { clientName };

// Proposal §22 (client view) and AC-22: a client needs a passport, a final
// police report and a medical. The police slip is an intermediate document
// (it starts the 21-day wait, Phase 9) and is not itself required.
export const REQUIRED_DOCUMENT_TYPES = Object.freeze([
    DOCUMENT_TYPES.PASSPORT,
    DOCUMENT_TYPES.POLICE_REPORT,
    DOCUMENT_TYPES.MEDICAL,
]);

export const REQUIREMENT_STATUS = Object.freeze({
    VERIFIED: "VERIFIED",               // a stored document of this type is VERIFIED
    REVIEW_REQUIRED: "REVIEW_REQUIRED", // stored, but only as REVIEW_REQUIRED
    PENDING_REVIEW: "PENDING_REVIEW",   // not stored; a file is waiting in pending/
    MISSING: "MISSING",                 // nothing received
});

export const RECENT_DOCUMENTS_LIMIT = 8;
export const REVIEW_QUEUE_PREVIEW_LIMIT = 5;
const CLIENT_PENDING_ITEMS_LIMIT = 50;

// Submissions waiting for a person: a file in pending/. Same definition as
// the Review Queue (adminReviewService.js); FAILED alone does not count.
const PENDING_FILE_WHERE = REVIEW_PENDING_WHERE;

const clientSelect = { passportId: true, uniqueId: true, firstName: true, otherName: true };

const toClient = (user) => (user ? { passportId: user.passportId, uniqueId: user.uniqueId, name: clientName(user) } : null);
const toNumber = (value) => (value === null || value === undefined ? null : Number(value));
const toIso = (date) => (date instanceof Date ? date.toISOString() : date ?? null);
const countsBy = (groups, key) => Object.fromEntries(groups.map((g) => [g[key], g._count._all]));

export function toDocumentItem(doc) {
    return {
        documentId: doc.documentId,
        documentType: doc.documentType,
        processingStatus: doc.processingStatus,
        verificationStatus: doc.verificationStatus,
        ocrConfidence: toNumber(doc.ocrConfidence),
        receivedDate: toIso(doc.receivedDate),
        storedFilename: doc.storedFilename,
        mimeType: doc.mimeType ?? null,
        fileSize: toNumber(doc.fileSize),
        client: toClient(doc.user),
    };
}

const documentSelect = {
    documentId: true,
    documentType: true,
    processingStatus: true,
    verificationStatus: true,
    ocrConfidence: true,
    receivedDate: true,
    storedFilename: true,
    mimeType: true,
    fileSize: true,
    user: { select: clientSelect },
};

function toPendingItem(row) {
    return {
        temporaryId: row.temporaryId,
        documentType: row.documentType,
        processingStatus: row.processingStatus,
        receivedDate: toIso(row.createdDate),
        client: toClient(row.user),
    };
}

// ---------------------------------------------------------------- overview

export async function getOverview({ db, now = new Date() }) {
    const today = businessDateOf(now);
    const { start: todayStart } = businessDayRange(today);

    const [
        totalClients,
        totalDocuments,
        receivedToday,
        pendingFiles,
        reviewRequiredDocuments,
        statusGroups,
        typeGroups,
        pendingGroups,
        recentDocuments,
        pendingPreview,
    ] = await Promise.all([
        db.user.count(),
        db.document.count(),
        db.temporaryData.count({ where: { createdDate: { gte: todayStart } } }),
        db.temporaryData.count({ where: PENDING_FILE_WHERE }),
        db.document.count({ where: { verificationStatus: VERIFICATION_STATUS.REVIEW_REQUIRED } }),
        db.temporaryData.groupBy({ by: ["processingStatus"], _count: { _all: true } }),
        db.temporaryData.groupBy({ by: ["documentType"], _count: { _all: true } }),
        db.temporaryData.groupBy({ by: ["processingStatus"], where: PENDING_FILE_WHERE, _count: { _all: true } }),
        db.document.findMany({ select: documentSelect, orderBy: [{ receivedDate: "desc" }, { documentId: "asc" }], take: RECENT_DOCUMENTS_LIMIT }),
        db.temporaryData.findMany({
            where: PENDING_FILE_WHERE,
            select: { temporaryId: true, documentType: true, processingStatus: true, createdDate: true, user: { select: clientSelect } },
            orderBy: [{ createdDate: "desc" }, { temporaryId: "asc" }],
            take: REVIEW_QUEUE_PREVIEW_LIMIT,
        }),
    ]);

    return {
        businessDate: today,
        kpis: {
            totalClients,
            totalDocuments,
            pendingReview: pendingFiles + reviewRequiredDocuments,
            receivedToday,
        },
        // All received submissions (temporary_data), by pipeline outcome and type.
        submissionsByStatus: countsBy(statusGroups, "processingStatus"),
        submissionsByType: countsBy(typeGroups, "documentType"),
        recentDocuments: recentDocuments.map(toDocumentItem),
        reviewQueue: {
            total: pendingFiles + reviewRequiredDocuments,
            pendingFiles,
            reviewRequiredDocuments,
            pendingByStatus: countsBy(pendingGroups, "processingStatus"),
            items: pendingPreview.map(toPendingItem),
        },
    };
}

// ---------------------------------------------------------------- documents list

export const DOCUMENT_LIST_DEFAULTS = Object.freeze({ page: 1, pageSize: 25, sort: "receivedDate", order: "desc" });
export const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 10_000;
const MAX_SEARCH_LENGTH = 100;
const FILTERABLE_DOCUMENT_TYPES = [DOCUMENT_TYPES.PASSPORT, DOCUMENT_TYPES.POLICE_SLIP, DOCUMENT_TYPES.POLICE_REPORT, DOCUMENT_TYPES.MEDICAL];
const VERIFICATION_VALUES = Object.values(VERIFICATION_STATUS);
const SORT_FIELDS = ["receivedDate", "ocrConfidence", "documentType"];
const STATUS_PATTERN = /^[A-Z_]{1,40}$/;
const PASSPORT_ID_PATTERN = /^[A-Za-z0-9]{1,20}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Validates the query string of GET /api/admin/documents. Unknown
// parameters are ignored; a known one given twice or malformed is an error.
// Returns { params } or { errors: [{ field, message }] }.
export function parseDocumentListQuery(query = {}) {
    const errors = [];
    const params = { ...DOCUMENT_LIST_DEFAULTS };
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
    const matching = (field, pattern, message) => {
        const value = single(field);
        if (value === undefined) return undefined;
        if (!pattern.test(value)) {
            errors.push({ field, message });
            return undefined;
        }
        return value;
    };

    params.page = integer("page", 1, MAX_PAGE) ?? params.page;
    params.pageSize = integer("pageSize", 1, MAX_PAGE_SIZE) ?? params.pageSize;
    params.documentType = oneOf("documentType", FILTERABLE_DOCUMENT_TYPES);
    params.verificationStatus = oneOf("verificationStatus", VERIFICATION_VALUES);
    params.processingStatus = matching("processingStatus", STATUS_PATTERN, "must be an upper-case status code");
    params.passportId = matching("passportId", PASSPORT_ID_PATTERN, "must be letters and digits (at most 20)");
    params.sort = oneOf("sort", SORT_FIELDS) ?? params.sort;
    params.order = oneOf("order", ["asc", "desc"]) ?? params.order;

    const search = single("search");
    if (search !== undefined) {
        const trimmed = search.trim();
        if (trimmed.length > MAX_SEARCH_LENGTH) errors.push({ field: "search", message: `must be at most ${MAX_SEARCH_LENGTH} characters` });
        else if (trimmed) params.search = trimmed;
    }

    for (const field of ["receivedFrom", "receivedTo"]) {
        const value = matching(field, DATE_PATTERN, "must be a date as YYYY-MM-DD");
        if (value === undefined) continue;
        try {
            businessDayRange(value);
            params[field] = value;
        } catch {
            errors.push({ field, message: "must be a real calendar date" });
        }
    }
    if (params.receivedFrom && params.receivedTo && params.receivedFrom > params.receivedTo) {
        errors.push({ field: "receivedTo", message: "must not be before receivedFrom" });
    }

    return errors.length ? { errors } : { params };
}

// Prisma arguments for a validated query. `where` without the verification
// filter is also returned, for the per-status counts shown as chips.
export function buildDocumentListArgs(params) {
    const base = {};
    if (params.documentType) base.documentType = params.documentType;
    if (params.processingStatus) base.processingStatus = params.processingStatus;
    if (params.passportId) base.passportId = params.passportId.toUpperCase();
    if (params.receivedFrom || params.receivedTo) {
        base.receivedDate = {};
        if (params.receivedFrom) base.receivedDate.gte = businessDayRange(params.receivedFrom).start;
        if (params.receivedTo) base.receivedDate.lt = businessDayRange(params.receivedTo).end;
    }
    if (params.search) {
        const contains = { contains: params.search, mode: "insensitive" };
        base.OR = [
            { documentId: contains },
            { passportId: contains },
            { storedFilename: contains },
            { user: { is: { firstName: contains } } },
            { user: { is: { otherName: contains } } },
            { user: { is: { uniqueId: contains } } },
        ];
    }

    const where = params.verificationStatus ? { ...base, verificationStatus: params.verificationStatus } : base;
    // documentId breaks ties so paging is stable; nulls (no OCR) sort last.
    const primary = params.sort === "ocrConfidence"
        ? { ocrConfidence: { sort: params.order, nulls: "last" } }
        : { [params.sort]: params.order };

    return {
        where,
        whereWithoutVerification: base,
        orderBy: [primary, { documentId: "asc" }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
    };
}

export async function listDocuments({ db, params }) {
    const args = buildDocumentListArgs(params);
    const [total, rows, verificationGroups] = await Promise.all([
        db.document.count({ where: args.where }),
        db.document.findMany({ where: args.where, select: documentSelect, orderBy: args.orderBy, skip: args.skip, take: args.take }),
        db.document.groupBy({ by: ["verificationStatus"], where: args.whereWithoutVerification, _count: { _all: true } }),
    ]);
    const byVerification = countsBy(verificationGroups, "verificationStatus");

    return {
        items: rows.map(toDocumentItem),
        pagination: {
            page: params.page,
            pageSize: params.pageSize,
            total,
            totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
        },
        // Counts for the status chips: current filters except verification.
        summary: {
            total: Object.values(byVerification).reduce((sum, n) => sum + n, 0),
            byVerificationStatus: byVerification,
        },
        filters: {
            documentType: params.documentType ?? null,
            verificationStatus: params.verificationStatus ?? null,
            processingStatus: params.processingStatus ?? null,
            passportId: params.passportId ?? null,
            search: params.search ?? null,
            receivedFrom: params.receivedFrom ?? null,
            receivedTo: params.receivedTo ?? null,
            sort: params.sort,
            order: params.order,
        },
    };
}

// ---------------------------------------------------------------- client details

export function isValidPassportIdParam(value) {
    return typeof value === "string" && PASSPORT_ID_PATTERN.test(value);
}

// Per required type: VERIFIED > REVIEW_REQUIRED > PENDING_REVIEW > MISSING.
export function requiredDocumentStatus({ documents, pendingItems }) {
    return REQUIRED_DOCUMENT_TYPES.map((documentType) => {
        const stored = documents.filter((d) => d.documentType === documentType);
        const pending = pendingItems.filter((p) => p.documentType === documentType);
        let status = REQUIREMENT_STATUS.MISSING;
        if (stored.some((d) => d.verificationStatus === VERIFICATION_STATUS.VERIFIED)) status = REQUIREMENT_STATUS.VERIFIED;
        else if (stored.length) status = REQUIREMENT_STATUS.REVIEW_REQUIRED;
        else if (pending.length) status = REQUIREMENT_STATUS.PENDING_REVIEW;
        return { documentType, status, storedCount: stored.length, pendingCount: pending.length };
    });
}

// Latest stored police slip and final police report, as they are. The
// 21-day countdown and workflow status come with Phase 9.
function latestOfType(documents, documentType) {
    const doc = documents.find((d) => d.documentType === documentType);
    return doc ? { documentId: doc.documentId, receivedDate: doc.receivedDate, verificationStatus: doc.verificationStatus } : null;
}

export async function getClientDetails({ db, passportId }) {
    const id = passportId.toUpperCase();
    const [user, pendingRows] = await Promise.all([
        db.user.findUnique({
            where: { passportId: id },
            select: {
                passportId: true,
                uniqueId: true,
                firstName: true,
                otherName: true,
                dateOfBirth: true,
                placeOfBirth: true,
                passportExpiryDate: true,
                whatsappNumber: true,
                contactNumber: true,
                address: true,
                job: true,
                createdDate: true,
                updatedDate: true,
                documents: {
                    select: documentSelect,
                    orderBy: [{ receivedDate: "desc" }, { documentId: "asc" }],
                },
            },
        }),
        db.temporaryData.findMany({
            where: { passportId: id, ...PENDING_FILE_WHERE },
            select: { temporaryId: true, documentType: true, processingStatus: true, createdDate: true },
            orderBy: [{ createdDate: "desc" }, { temporaryId: "asc" }],
            take: CLIENT_PENDING_ITEMS_LIMIT,
        }),
    ]);

    if (!user) return null;

    const documents = user.documents.map(toDocumentItem);
    const pendingItems = pendingRows.map((row) => toPendingItem({ ...row, user: null }));
    const requiredDocuments = requiredDocumentStatus({ documents, pendingItems });

    return {
        client: {
            passportId: user.passportId,
            uniqueId: user.uniqueId,
            name: clientName(user),
            firstName: user.firstName,
            otherName: user.otherName ?? null,
            dateOfBirth: toIso(user.dateOfBirth),
            placeOfBirth: user.placeOfBirth ?? null,
            passportExpiryDate: toIso(user.passportExpiryDate),
            whatsappNumber: user.whatsappNumber ?? null,
            contactNumber: user.contactNumber ?? null,
            address: user.address ?? null,
            job: user.job ?? null,
            createdDate: toIso(user.createdDate),
            updatedDate: toIso(user.updatedDate),
        },
        documents,
        pendingItems,
        requiredDocuments,
        missingDocumentTypes: requiredDocuments.filter((r) => r.status === REQUIREMENT_STATUS.MISSING).map((r) => r.documentType),
        police: {
            latestSlip: latestOfType(documents, DOCUMENT_TYPES.POLICE_SLIP),
            latestReport: latestOfType(documents, DOCUMENT_TYPES.POLICE_REPORT),
        },
    };
}
