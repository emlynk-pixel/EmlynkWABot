// Police Workflow data for the admin dashboard (Phase 10).
// Read-only: every client's police status is calculated from the stored
// documents and waiting files (policeCountdownService.js); nothing is saved.

import { REVIEW_PENDING_WHERE } from "./adminReviewService.js";
import { DOCUMENT_TYPES } from "./documentClassificationService.js";
import { POLICE_STATUS, POLICE_STATUS_ORDER, policeCountdown } from "./policeCountdownService.js";
import { businessDateOf } from "../utils/businessDay.js";
import { clientName } from "../utils/clientName.js";

export const POLICE_LIST_DEFAULTS = Object.freeze({ page: 1, pageSize: 25 });
const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 10_000;
const PASSPORT_ID_PATTERN = /^[A-Za-z0-9]{1,20}$/;
const MAX_SEARCH_LENGTH = 100;

const clientSelect = { passportId: true, uniqueId: true, firstName: true, otherName: true };
export const POLICE_DOCUMENT_SELECT = Object.freeze({
    documentId: true, passportId: true, documentType: true, verificationStatus: true, policeSubmittedDate: true, receivedDate: true,
});

// Police slips of a client still waiting in pending/ (same definition as the Review Queue).
const pendingSlipWhere = (passportId) => ({
    AND: [REVIEW_PENDING_WHERE, { documentType: DOCUMENT_TYPES.POLICE_SLIP }, passportId ? { passportId } : { passportId: { not: null } }],
});

// The countdown for one client from its documents (as loaded with
// POLICE_DOCUMENT_SELECT) and the number of its slips waiting in pending/.
export function countdownFromDocuments(documents, pendingSlips, today) {
    return policeCountdown({
        slips: documents.filter((d) => d.documentType === DOCUMENT_TYPES.POLICE_SLIP),
        reports: documents.filter((d) => d.documentType === DOCUMENT_TYPES.POLICE_REPORT),
        pendingSlips,
        today,
    });
}

// Every client's police status. Three queries whatever the number of clients.
export async function loadPoliceStatuses({ db, today }) {
    const [users, documents, pending] = await Promise.all([
        db.user.findMany({ select: clientSelect, orderBy: [{ passportId: "asc" }] }),
        db.document.findMany({
            where: { documentType: { in: [DOCUMENT_TYPES.POLICE_SLIP, DOCUMENT_TYPES.POLICE_REPORT] } },
            select: POLICE_DOCUMENT_SELECT,
        }),
        db.temporaryData.groupBy({ by: ["passportId"], where: pendingSlipWhere(null), _count: { _all: true } }),
    ]);

    const documentsByClient = new Map();
    for (const doc of documents) {
        if (!documentsByClient.has(doc.passportId)) documentsByClient.set(doc.passportId, []);
        documentsByClient.get(doc.passportId).push(doc);
    }
    const pendingByClient = new Map(pending.map((group) => [group.passportId, group._count._all]));

    return users.map((user) => ({
        client: { passportId: user.passportId, uniqueId: user.uniqueId, name: clientName(user) },
        ...countdownFromDocuments(documentsByClient.get(user.passportId) ?? [], pendingByClient.get(user.passportId) ?? 0, today),
    }));
}

export function summarizeStatuses(rows) {
    const byStatus = Object.fromEntries(POLICE_STATUS_ORDER.map((status) => [status, 0]));
    for (const row of rows) byStatus[row.status] += 1;
    return { total: rows.length, byStatus };
}

// For the Overview: how many police reports are due soon, due today, overdue.
export async function policeDueCounts({ db, today }) {
    const { byStatus } = summarizeStatuses(await loadPoliceStatuses({ db, today }));
    return {
        dueSoon: byStatus[POLICE_STATUS.DUE_SOON],
        dueToday: byStatus[POLICE_STATUS.DUE_TODAY],
        overdue: byStatus[POLICE_STATUS.OVERDUE],
    };
}

// Validates GET /api/admin/police. Unknown parameters are ignored.
export function parsePoliceListQuery(query = {}) {
    const errors = [];
    const params = { ...POLICE_LIST_DEFAULTS };
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

    params.page = integer("page", 1, MAX_PAGE) ?? params.page;
    params.pageSize = integer("pageSize", 1, MAX_PAGE_SIZE) ?? params.pageSize;
    const status = single("status");
    if (status !== undefined) {
        if (POLICE_STATUS_ORDER.includes(status)) params.status = status;
        else errors.push({ field: "status", message: `must be one of: ${POLICE_STATUS_ORDER.join(", ")}` });
    }
    const passportId = single("passportId");
    if (passportId !== undefined) {
        if (PASSPORT_ID_PATTERN.test(passportId)) params.passportId = passportId.toUpperCase();
        else errors.push({ field: "passportId", message: "must be letters and digits (at most 20)" });
    }
    const search = single("search");
    if (search !== undefined) {
        const trimmed = search.trim();
        if (trimmed.length > MAX_SEARCH_LENGTH) errors.push({ field: "search", message: `must be at most ${MAX_SEARCH_LENGTH} characters` });
        else if (trimmed) params.search = trimmed;
    }
    return errors.length ? { errors } : { params };
}

// Most urgent first: by status, then fewest days left, then passport ID.
function compareRows(a, b) {
    const byStatus = POLICE_STATUS_ORDER.indexOf(a.status) - POLICE_STATUS_ORDER.indexOf(b.status);
    if (byStatus) return byStatus;
    const aDays = a.daysRemaining ?? Number.POSITIVE_INFINITY;
    const bDays = b.daysRemaining ?? Number.POSITIVE_INFINITY;
    if (aDays !== bDays) return aDays - bDays;
    return a.client.passportId.localeCompare(b.client.passportId);
}

// Search: every word must appear in the passport ID, unique ID or name
// (case-insensitive). It only narrows the list; statuses are unchanged.
export function matchesPoliceSearch(row, search) {
    const text = `${row.client.passportId} ${row.client.uniqueId} ${row.client.name ?? ""}`.toUpperCase();
    return search.toUpperCase().split(/\s+/).filter(Boolean).every((word) => text.includes(word));
}

// GET /api/admin/police: every client's status, filtered, most urgent first.
// The summary counts the clients in scope (passport ID / search), before
// the status filter.
export async function listPoliceWorkflow({ db, params, now = new Date() }) {
    const today = businessDateOf(now);
    const all = await loadPoliceStatuses({ db, today });
    const scoped = all
        .filter((row) => !params.passportId || row.client.passportId === params.passportId)
        .filter((row) => !params.search || matchesPoliceSearch(row, params.search));
    const filtered = (params.status ? scoped.filter((row) => row.status === params.status) : scoped).sort(compareRows);
    const start = (params.page - 1) * params.pageSize;

    return {
        businessDate: today,
        items: filtered.slice(start, start + params.pageSize),
        pagination: {
            page: params.page,
            pageSize: params.pageSize,
            total: filtered.length,
            totalPages: Math.max(1, Math.ceil(filtered.length / params.pageSize)),
        },
        summary: summarizeStatuses(scoped),
        filters: { status: params.status ?? null, passportId: params.passportId ?? null, search: params.search ?? null },
    };
}
