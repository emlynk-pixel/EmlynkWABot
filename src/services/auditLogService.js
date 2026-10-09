// Audit Logs (ADMIN only): GET /api/admin/audit-logs.
//
// Read-only. audit_logs is append-only in the database (a trigger rejects
// UPDATE and DELETE), and nothing here or anywhere in the API changes or
// removes an entry.
//
// An entry is shown with who did it (name and role of the application user,
// never their Supabase identity or anything of their session), the candidate
// it concerns (passport ID, unique ID and name, read in ONE query for the
// whole page) and, for candidate and stage changes, the changed fields as a
// list of { field, from, to }. Internal columns (the temporary record, the
// stored file's checksum) are not exposed.

import { businessDayRange, isValidBusinessDate } from "../utils/businessDay.js";
import { clientSearchWhere } from "./adminClientService.js";

// Each action belongs to a category (the page's "Category" filter). An action
// not listed here (written by an older version) shows under OTHER.
export const AUDIT_CATEGORIES = Object.freeze({
    CANDIDATE: ["CREATE_CANDIDATE", "UPDATE_CANDIDATE"],
    STAGE: ["UPDATE_STAGE"],
    DOCUMENT: ["UPLOAD_DOCUMENT", "REMOVE_DOCUMENT", "DELETE_TEMPORARY_DOCUMENT", "SET_DOCUMENT_TYPE", "ASSIGN_CLIENT", "SET_POLICE_DATE"],
    REVIEW: ["APPROVE", "KEEP_PENDING", "REMOVE_FROM_REVIEW", "RETRY_PROCESSING", "REPLACE_VERIFIED", "KEEP_AS_VERSION"],
    USER: ["INVITE_USER", "REACTIVATE_USER", "COMPLETE_INVITATION", "UPDATE_USER_ROLE", "DEACTIVATE_USER"],
});
export const OTHER_CATEGORY = "OTHER";
export const AUDIT_CATEGORY_NAMES = Object.freeze([...Object.keys(AUDIT_CATEGORIES), OTHER_CATEGORY]);
export const AUDIT_ACTIONS = Object.freeze(Object.values(AUDIT_CATEGORIES).flat());

const CATEGORY_OF = new Map(Object.entries(AUDIT_CATEGORIES).flatMap(([category, actions]) => actions.map((action) => [action, category])));
export const categoryOf = (action) => CATEGORY_OF.get(action) ?? OTHER_CATEGORY;

export const AUDIT_LOG_DEFAULTS = Object.freeze({ page: 1, pageSize: 25 });
export const MAX_AUDIT_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 100;
// A candidate name or ID search matches at most this many candidates.
const MAX_CANDIDATE_MATCHES = 200;

const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PASSPORT_ID_PATTERN = /^[A-Za-z0-9-]{1,20}$/;
const ACTION_PATTERN = /^[A-Z_]{1,40}$/;

// Keys never shown from a stored value, whatever wrote it.
const SENSITIVE_KEY = /pass(word)?|token|secret|session|credential|api[-_]?key|service[-_]?role|authorization|cookie/i;

// GET query: { params } or { errors }.
export function parseAuditLogQuery(query = {}) {
    const errors = [];
    const params = { ...AUDIT_LOG_DEFAULTS };
    const single = (field) => {
        const value = query[field];
        if (value === undefined || value === "") return undefined;
        if (typeof value !== "string") {
            errors.push({ field, message: "must be given once" });
            return undefined;
        }
        return value.trim() || undefined;
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
    const matching = (field, pattern, message) => {
        const value = single(field);
        if (value === undefined) return undefined;
        if (!pattern.test(value)) {
            errors.push({ field, message });
            return undefined;
        }
        return value;
    };
    const day = (field) => {
        const value = single(field);
        if (value === undefined) return undefined;
        if (!isValidBusinessDate(value)) {
            errors.push({ field, message: "must be a date as YYYY-MM-DD" });
            return undefined;
        }
        return value;
    };

    params.page = integer("page", 1, 100_000) ?? params.page;
    params.pageSize = integer("pageSize", 1, MAX_AUDIT_PAGE_SIZE) ?? params.pageSize;
    params.adminId = matching("adminId", USER_ID_PATTERN, "must be a user ID");
    params.passportId = matching("passportId", PASSPORT_ID_PATTERN, "must be a passport ID");
    params.action = matching("action", ACTION_PATTERN, "must be an action name");
    const category = single("category");
    if (category !== undefined) {
        if (AUDIT_CATEGORY_NAMES.includes(category)) params.category = category;
        else errors.push({ field: "category", message: `must be one of: ${AUDIT_CATEGORY_NAMES.join(", ")}` });
    }
    params.startDate = day("startDate");
    params.endDate = day("endDate");
    if (params.startDate && params.endDate && params.startDate > params.endDate) {
        errors.push({ field: "endDate", message: "must not be before the start date" });
    }
    for (const field of ["candidate", "search"]) {
        const value = single(field);
        if (value === undefined) continue;
        if (value.length > MAX_SEARCH_LENGTH) errors.push({ field, message: `must be at most ${MAX_SEARCH_LENGTH} characters` });
        else params[field] = value;
    }
    for (const key of Object.keys(params)) if (params[key] === undefined) delete params[key];
    return errors.length ? { errors } : { params };
}

const contains = (value) => ({ contains: value, mode: "insensitive" });

// The Prisma where for the filters. `candidatePassportIds`: the candidates
// a name / unique ID search matched (null when there was no such search).
function auditWhere(params, candidatePassportIds) {
    const and = [];
    if (params.adminId) and.push({ adminId: params.adminId });
    if (params.passportId) and.push({ passportId: { equals: params.passportId, mode: "insensitive" } });
    if (candidatePassportIds) and.push({ passportId: { in: candidatePassportIds } });
    if (params.action) and.push({ action: params.action });
    if (params.category) {
        and.push(params.category === OTHER_CATEGORY
            ? { action: { notIn: AUDIT_ACTIONS } }
            : { action: { in: AUDIT_CATEGORIES[params.category] } });
    }
    if (params.startDate) and.push({ createdDate: { gte: businessDayRange(params.startDate).start } });
    if (params.endDate) and.push({ createdDate: { lt: businessDayRange(params.endDate).end } });
    if (params.search) {
        and.push({
            OR: [
                { action: contains(params.search.toUpperCase().replace(/\s+/g, "_")) },
                { passportId: contains(params.search) },
                { reason: contains(params.search) },
                { documentType: contains(params.search) },
                { previousStatus: contains(params.search) },
                { newStatus: contains(params.search) },
                { previousValue: contains(params.search) },
                { newValue: contains(params.search) },
                { admin: { name: contains(params.search) } },
            ],
        });
    }
    return and.length ? { AND: and } : {};
}

function parseJsonObject(value) {
    if (typeof value !== "string" || !value.startsWith("{")) return null;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

const withoutSensitive = (object) => Object.fromEntries(Object.entries(object).filter(([key]) => !SENSITIVE_KEY.test(key)));

// A stored plain value, unless it looks like a secret (defence in depth: no
// audit writer stores one).
const safeText = (value) => (typeof value === "string" && /^(Bearer\s|eyJ[\w-]+\.)/.test(value) ? "[hidden]" : value ?? null);

// The entry as the page shows it.
function toItem(row, candidates) {
    const before = parseJsonObject(row.previousValue);
    const after = parseJsonObject(row.newValue);
    let changes = null;
    let stage = null;
    let details = null;
    if (row.action === "UPDATE_CANDIDATE" || row.action === "UPDATE_STAGE") {
        const from = withoutSensitive(before ?? {});
        const to = withoutSensitive(after ?? {});
        stage = to.stage ?? from.stage ?? null;
        delete from.stage;
        delete to.stage;
        changes = [...new Set([...Object.keys(from), ...Object.keys(to)])].map((field) => ({ field, from: from[field] ?? null, to: to[field] ?? null }));
    } else if (after) {
        details = withoutSensitive(after);
    }
    const candidate = row.passportId ? candidates.get(row.passportId) : null;
    return {
        auditId: row.auditId,
        createdDate: row.createdDate,
        action: row.action,
        category: categoryOf(row.action),
        actor: row.admin ? { userId: row.admin.adminId, name: row.admin.name, role: row.admin.role } : { userId: row.adminId, name: null, role: null },
        candidate: row.passportId
            ? { passportId: row.passportId, uniqueId: candidate?.uniqueId ?? null, name: candidate ? candidateName(candidate) : null }
            : null,
        documentType: row.documentType ?? null,
        stage,
        previousStatus: row.previousStatus,
        newStatus: row.newStatus,
        previousValue: before ? null : safeText(row.previousValue),
        newValue: after ? null : safeText(row.newValue),
        changes,
        details,
        policeSubmittedDate: row.policeSubmittedDate ? row.policeSubmittedDate.toISOString().slice(0, 10) : null,
        reason: row.reason ?? null,
    };
}

const candidateName = (candidate) => [candidate.firstName, candidate.otherName].filter((part) => part && part.trim()).join(" ") || null;

// { items, pagination, filters }. Four queries per page whatever its size:
// the entries with their user, the count, the page's candidates, and the
// users for the "Performed by" filter (plus one candidate lookup when a
// candidate name / ID search is given).
export async function listAuditLogs({ db, params }) {
    let candidatePassportIds = null;
    if (params.candidate) {
        const matches = await db.candidate.findMany({
            where: clientSearchWhere(params.candidate),
            select: { passportId: true },
            take: MAX_CANDIDATE_MATCHES,
        });
        candidatePassportIds = matches.map((m) => m.passportId);
    }
    const where = auditWhere(params, candidatePassportIds);
    const skip = (params.page - 1) * params.pageSize;

    const [rows, total, users] = await Promise.all([
        db.auditLog.findMany({
            where,
            orderBy: [{ createdDate: "desc" }, { auditId: "desc" }],
            skip,
            take: params.pageSize,
            select: {
                auditId: true, adminId: true, action: true, passportId: true, previousStatus: true, newStatus: true,
                reason: true, policeSubmittedDate: true, documentType: true, previousValue: true, newValue: true, createdDate: true,
                admin: { select: { adminId: true, name: true, role: true } },
            },
        }),
        db.auditLog.count({ where }),
        db.user.findMany({ select: { adminId: true, name: true, role: true, status: true }, orderBy: { name: "asc" } }),
    ]);

    const passportIds = [...new Set(rows.map((r) => r.passportId).filter(Boolean))];
    const candidateRows = passportIds.length
        ? await db.candidate.findMany({
            where: { passportId: { in: passportIds } },
            select: { passportId: true, uniqueId: true, firstName: true, otherName: true },
        })
        : [];
    const candidates = new Map(candidateRows.map((c) => [c.passportId, c]));

    return {
        items: rows.map((row) => toItem(row, candidates)),
        pagination: {
            page: params.page,
            pageSize: params.pageSize,
            total,
            totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
        },
        filters: {
            users: users.map((u) => ({ userId: u.adminId, name: u.name, role: u.role, status: u.status })),
            categories: Object.entries(AUDIT_CATEGORIES).map(([category, actions]) => ({ category, actions })).concat({ category: OTHER_CATEGORY, actions: [] }),
            actions: AUDIT_ACTIONS,
        },
    };
}
