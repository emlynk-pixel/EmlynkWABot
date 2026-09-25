// Clients directory and missing-document view (Phase 10). Read-only.
//
// A client is complete when every required document type
// (REQUIRED_DOCUMENT_TYPES, src/config/requiredDocuments.js) has a VERIFIED
// document in the client folder. Per required type the status is:
//   VERIFIED         a stored document of this type is VERIFIED
//   REVIEW_REQUIRED  stored, but only as REVIEW_REQUIRED
//   PENDING_REVIEW   nothing stored; a file of this type waits in pending/
//   MISSING          nothing received
// The same rule is used on the client page, the Clients list, the
// Missing Documents view, the Overview and the daily report.

import { loadRequiredDocumentTypes } from "../config/requiredDocuments.js";
import { VERIFICATION_STATUS } from "./clientDocumentService.js";
import { REVIEW_PENDING_WHERE } from "./adminReviewService.js";
import { clientName } from "../utils/clientName.js";

// Resolved once at startup (the startup check has already validated it).
export const REQUIRED_DOCUMENT_TYPES = loadRequiredDocumentTypes();

export const REQUIREMENT_STATUS = Object.freeze({
    VERIFIED: "VERIFIED",
    REVIEW_REQUIRED: "REVIEW_REQUIRED",
    PENDING_REVIEW: "PENDING_REVIEW",
    MISSING: "MISSING",
});

export const COMPLETION = Object.freeze({ COMPLETE: "COMPLETE", INCOMPLETE: "INCOMPLETE" });

// One required type from its counts: VERIFIED > REVIEW_REQUIRED > PENDING_REVIEW > MISSING.
export function requirementStatus({ verified = 0, stored = 0, pending = 0 }) {
    if (verified > 0) return REQUIREMENT_STATUS.VERIFIED;
    if (stored > 0) return REQUIREMENT_STATUS.REVIEW_REQUIRED;
    if (pending > 0) return REQUIREMENT_STATUS.PENDING_REVIEW;
    return REQUIREMENT_STATUS.MISSING;
}

// From one client's stored documents and waiting files.
export function requiredDocumentStatus({ documents, pendingItems, requiredTypes = REQUIRED_DOCUMENT_TYPES }) {
    return requiredTypes.map((documentType) => {
        const stored = documents.filter((d) => d.documentType === documentType);
        const pending = pendingItems.filter((p) => p.documentType === documentType);
        const verified = stored.filter((d) => d.verificationStatus === VERIFICATION_STATUS.VERIFIED).length;
        return {
            documentType,
            status: requirementStatus({ verified, stored: stored.length, pending: pending.length }),
            storedCount: stored.length,
            pendingCount: pending.length,
        };
    });
}

export const missingTypesOf = (requirements) =>
    requirements.filter((r) => r.status === REQUIREMENT_STATUS.MISSING).map((r) => r.documentType);
export const isComplete = (requirements) => requirements.every((r) => r.status === REQUIREMENT_STATUS.VERIFIED);

// ---------------------------------------------------------------- search

export const MAX_SEARCH_LENGTH = 100;
const MAX_SEARCH_WORDS = 5;
const PHONE_PATTERN = /^\+?[\d\s-]{4,}$/;

// Every word must match one of: passport ID, unique ID, first name, other
// name, WhatsApp number ("kamal perera" finds KAMAL NIMAL / PERERA). A
// number also matches in the other Sri Lankan format (07… and 947…),
// because stored numbers are kept as they were entered.
export function clientSearchWhere(search) {
    const words = search.trim().split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_WORDS);
    if (!words.length) return {};
    return {
        AND: words.map((word) => {
            const contains = (value) => ({ contains: value, mode: "insensitive" });
            const or = [
                { passportId: contains(word) },
                { uniqueId: contains(word) },
                { firstName: contains(word) },
                { otherName: contains(word) },
                { whatsappNumber: contains(word) },
            ];
            if (PHONE_PATTERN.test(word)) {
                const digits = word.replace(/\D/g, "");
                const variants = new Set([digits]);
                if (digits.startsWith("0")) variants.add(`94${digits.slice(1)}`);
                if (digits.startsWith("94")) variants.add(`0${digits.slice(2)}`);
                for (const variant of variants) if (variant !== word) or.push({ whatsappNumber: contains(variant) });
            }
            return { OR: or };
        }),
    };
}

// ---------------------------------------------------------------- loading

const clientSelect = { passportId: true, uniqueId: true, firstName: true, otherName: true, whatsappNumber: true };

// Every (matching) client with its required-document status, in three
// queries whatever the number of clients: the clients, the stored
// documents counted per client/type/status, the waiting files per client/type.
export async function loadClientCompleteness({ db, where = {}, requiredTypes = REQUIRED_DOCUMENT_TYPES }) {
    const [users, documentGroups, pendingGroups] = await Promise.all([
        db.user.findMany({ where, select: clientSelect, orderBy: [{ uniqueId: "asc" }, { passportId: "asc" }] }),
        db.document.groupBy({
            by: ["passportId", "documentType", "verificationStatus"],
            where: { documentType: { in: [...requiredTypes] } },
            _count: { _all: true },
        }),
        db.temporaryData.groupBy({
            by: ["passportId", "documentType"],
            where: { AND: [REVIEW_PENDING_WHERE, { passportId: { not: null } }, { documentType: { in: [...requiredTypes] } }] },
            _count: { _all: true },
        }),
    ]);

    const counts = new Map(); // passportId -> documentType -> { verified, stored, pending }
    const slot = (passportId, documentType) => {
        if (!counts.has(passportId)) counts.set(passportId, new Map());
        const byType = counts.get(passportId);
        if (!byType.has(documentType)) byType.set(documentType, { verified: 0, stored: 0, pending: 0 });
        return byType.get(documentType);
    };
    for (const group of documentGroups) {
        if (!group.passportId || !group.documentType) continue;
        const entry = slot(group.passportId, group.documentType);
        entry.stored += group._count._all;
        if (group.verificationStatus === VERIFICATION_STATUS.VERIFIED) entry.verified += group._count._all;
    }
    for (const group of pendingGroups) {
        if (!group.passportId || !group.documentType) continue;
        slot(group.passportId, group.documentType).pending += group._count._all;
    }

    return users.map((user) => {
        const byType = counts.get(user.passportId);
        const requirements = requiredTypes.map((documentType) => {
            const entry = byType?.get(documentType) ?? { verified: 0, stored: 0, pending: 0 };
            return { documentType, status: requirementStatus(entry), storedCount: entry.stored, pendingCount: entry.pending };
        });
        return {
            client: { passportId: user.passportId, uniqueId: user.uniqueId, name: clientName(user), whatsappNumber: user.whatsappNumber ?? null },
            completion: isComplete(requirements) ? COMPLETION.COMPLETE : COMPLETION.INCOMPLETE,
            requirements,
            missingDocumentTypes: missingTypesOf(requirements),
        };
    });
}

// Counts for a set of rows from loadClientCompleteness.
export function summarizeCompleteness(rows, requiredTypes = REQUIRED_DOCUMENT_TYPES) {
    const missingByType = Object.fromEntries(requiredTypes.map((type) => [type, 0]));
    let complete = 0;
    let withMissing = 0;
    let missingDocuments = 0;
    for (const row of rows) {
        if (row.completion === COMPLETION.COMPLETE) complete += 1;
        if (row.missingDocumentTypes.length) withMissing += 1;
        for (const type of row.missingDocumentTypes) {
            missingByType[type] += 1;
            missingDocuments += 1;
        }
    }
    return {
        total: rows.length,
        complete,
        incomplete: rows.length - complete,
        // Clients with at least one required type not received at all.
        withMissing,
        // Required documents not received, summed over the clients.
        missingDocuments,
        missingByType,
    };
}

// For the Overview and the daily report: every client, now.
export async function clientCompletenessCounts({ db, requiredTypes = REQUIRED_DOCUMENT_TYPES }) {
    return summarizeCompleteness(await loadClientCompleteness({ db, requiredTypes }), requiredTypes);
}

// ---------------------------------------------------------------- queries

export const CLIENT_LIST_DEFAULTS = Object.freeze({ page: 1, pageSize: 25 });
const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 10_000;

// Shared validation of GET /clients and GET /documents/missing.
// Returns { params } or { errors: [{ field, message }] }.
function parseListQuery(query, { allowCompletion, typeField }, requiredTypes) {
    const errors = [];
    const params = { ...CLIENT_LIST_DEFAULTS };
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

    params.page = integer("page", 1, MAX_PAGE) ?? params.page;
    params.pageSize = integer("pageSize", 1, MAX_PAGE_SIZE) ?? params.pageSize;
    if (allowCompletion) params.completion = oneOf("completion", Object.values(COMPLETION));
    params.missingType = oneOf(typeField, [...requiredTypes]);
    const search = single("search");
    if (search !== undefined) {
        const trimmed = search.trim();
        if (trimmed.length > MAX_SEARCH_LENGTH) errors.push({ field: "search", message: `must be at most ${MAX_SEARCH_LENGTH} characters` });
        else if (trimmed) params.search = trimmed;
    }
    return errors.length ? { errors } : { params };
}

// GET /api/admin/clients: page, pageSize, search, completion, missingType.
export function parseClientListQuery(query = {}, requiredTypes = REQUIRED_DOCUMENT_TYPES) {
    return parseListQuery(query, { allowCompletion: true, typeField: "missingType" }, requiredTypes);
}

// GET /api/admin/documents/missing: page, pageSize, search, documentType.
export function parseMissingDocumentsQuery(query = {}, requiredTypes = REQUIRED_DOCUMENT_TYPES) {
    return parseListQuery(query, { allowCompletion: false, typeField: "documentType" }, requiredTypes);
}

function page(rows, params) {
    const start = (params.page - 1) * params.pageSize;
    return {
        items: rows.slice(start, start + params.pageSize),
        pagination: {
            page: params.page,
            pageSize: params.pageSize,
            total: rows.length,
            totalPages: Math.max(1, Math.ceil(rows.length / params.pageSize)),
        },
    };
}

// Clients directory. The summary counts the clients matching the search,
// before the completion and missing-type filters.
export async function listClients({ db, params, requiredTypes = REQUIRED_DOCUMENT_TYPES }) {
    const where = params.search ? clientSearchWhere(params.search) : {};
    const rows = await loadClientCompleteness({ db, where, requiredTypes });
    const filtered = rows
        .filter((row) => !params.completion || row.completion === params.completion)
        .filter((row) => !params.missingType || row.missingDocumentTypes.includes(params.missingType));

    return {
        ...page(filtered, params),
        summary: summarizeCompleteness(rows, requiredTypes),
        requiredDocumentTypes: [...requiredTypes],
        filters: { search: params.search ?? null, completion: params.completion ?? null, missingType: params.missingType ?? null },
    };
}

// Missing-document view: incomplete clients, most documents missing first.
// With documentType, only clients that have not sent that type at all.
export async function listMissingDocuments({ db, params, requiredTypes = REQUIRED_DOCUMENT_TYPES }) {
    const where = params.search ? clientSearchWhere(params.search) : {};
    const rows = await loadClientCompleteness({ db, where, requiredTypes });
    const incomplete = rows
        .filter((row) => row.completion === COMPLETION.INCOMPLETE)
        .filter((row) => !params.missingType || row.missingDocumentTypes.includes(params.missingType))
        .sort((a, b) => b.missingDocumentTypes.length - a.missingDocumentTypes.length);

    return {
        ...page(incomplete, params),
        summary: summarizeCompleteness(rows, requiredTypes),
        requiredDocumentTypes: [...requiredTypes],
        filters: { search: params.search ?? null, documentType: params.missingType ?? null },
    };
}
