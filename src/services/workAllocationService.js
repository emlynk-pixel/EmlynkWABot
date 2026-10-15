import crypto from "node:crypto";

import { ROLES } from "../middleware/requireRole.js";
import { USER_STATUS } from "../middleware/requireActiveUser.js";
import {
    automaticStageMissing,
    CandidateError,
    candidateSearchWhere,
    candidateSummary,
    CANDIDATE_LIST_PAGE_SIZE,
    listPagination,
    REQUIRED_SUBMISSION_DOCUMENTS,
    stageList,
} from "./candidateService.js";

// Work Allocation (Admin > Work Allocation; ADMIN and MANAGER only, checked
// by the routes). Which Analyst each candidate is assigned to:
// public.candidate_allocation, one row per allocated candidate (no row:
// unallocated). Every change is in audit_logs:
//   ASSIGN_CANDIDATE     unallocated -> Analyst
//   REASSIGN_CANDIDATE   Analyst A -> Analyst B
//   UNASSIGN_CANDIDATE   Analyst -> unallocated
// The Analyst's access follows the row on every request (candidateAccess.js).

export const ALLOCATION_AUDIT_ACTION = Object.freeze({
    ASSIGN: "ASSIGN_CANDIDATE",
    REASSIGN: "REASSIGN_CANDIDATE",
    UNASSIGN: "UNASSIGN_CANDIDATE",
});

export const ALLOCATION_STATUS = Object.freeze({ UNALLOCATED: "UNALLOCATED", ALLOCATED: "ALLOCATED" });

// One request moves at most this many candidates (five pages of the list):
// enough for any page-level selection, and a mistake can't touch thousands.
export const MAX_ALLOCATION_CANDIDATES = 500;
const MAX_ALLOCATION_ANALYSTS = 50;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PASSPORT_ID_PATTERN = /^[A-Za-z0-9]{1,20}$/;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// ---------------------------------------------------------------- list

// GET /api/admin/work-allocation/candidates?status=&analystId=&search=&page=
//   status     UNALLOCATED (default) | ALLOCATED
//   analystId  with ALLOCATED: only that Analyst's candidates
//   search     the Candidates list's search (candidateSearchWhere)
export function parseAllocationListQuery(query = {}) {
    const errors = [];
    const params = { status: ALLOCATION_STATUS.UNALLOCATED, page: 1, pageSize: CANDIDATE_LIST_PAGE_SIZE };
    const single = (field) => {
        const value = query[field];
        if (value === undefined || value === "") return undefined;
        if (typeof value !== "string") {
            errors.push({ field, message: "must be given once" });
            return undefined;
        }
        return value;
    };
    const status = single("status");
    if (status !== undefined) {
        if (Object.values(ALLOCATION_STATUS).includes(status)) params.status = status;
        else errors.push({ field: "status", message: `must be one of: ${Object.values(ALLOCATION_STATUS).join(", ")}` });
    }
    const analystId = single("analystId");
    if (analystId !== undefined) {
        if (ID_PATTERN.test(analystId)) params.analystId = analystId;
        else errors.push({ field: "analystId", message: "must be a user ID" });
    }
    const page = single("page");
    if (page !== undefined) {
        if (/^\d{1,5}$/.test(page) && Number(page) >= 1 && Number(page) <= 10_000) params.page = Number(page);
        else errors.push({ field: "page", message: "must be a whole number from 1 to 10000" });
    }
    const search = single("search");
    if (search !== undefined) {
        const trimmed = search.trim();
        if (trimmed.length > 100) errors.push({ field: "search", message: "must be at most 100 characters" });
        else if (trimmed) params.search = trimmed;
    }
    return errors.length ? { errors } : { params };
}

function allocationWhere(params) {
    const parts = [];
    if (params.search) parts.push(candidateSearchWhere(params.search));
    if (params.status === ALLOCATION_STATUS.UNALLOCATED) parts.push({ allocation: { is: null } });
    else parts.push({ allocation: params.analystId ? { is: { analystId: params.analystId } } : { isNot: null } });
    return parts.length > 1 ? { AND: parts } : parts[0];
}

const analystView = (user) => (user ? { analystId: user.adminId, name: user.name, active: user.status === USER_STATUS.ACTIVE && user.role === ROLES.ANALYST } : null);

// Same order and paging as the Candidates list: newest registered first,
// passport ID for ties, 100 a page; one COUNT and one bounded query.
export async function listAllocationCandidates({ db, params }) {
    const where = allocationWhere(params);
    const [total, rows] = await Promise.all([
        db.candidate.count({ where }),
        db.candidate.findMany({
            where,
            select: {
                passportId: true, uniqueId: true, firstName: true, otherName: true, nic: true, job: true, jobExperience: true,
                whatsappNumber: true, contactNumber: true, passportIssueDate: true, passportExpiryDate: true, createdDate: true,
                stages: { select: { stage: true, completed: true } },
                documents: { where: { documentType: { in: REQUIRED_SUBMISSION_DOCUMENTS } }, select: { documentType: true, verificationStatus: true } },
                allocation: { select: { assignedDate: true, analyst: { select: { adminId: true, name: true, role: true, status: true } } } },
            },
            orderBy: [{ createdDate: "desc" }, { passportId: "asc" }],
            skip: (params.page - 1) * params.pageSize,
            take: params.pageSize,
        }),
    ]);
    return {
        items: rows.map((row) => {
            const stages = stageList(row.stages, automaticStageMissing(row, row.documents));
            return {
                ...candidateSummary(row),
                whatsappNumber: row.whatsappNumber ?? null,
                contactNumber: row.contactNumber ?? null,
                registeredDate: row.createdDate.toISOString(),
                stagesCompleted: stages.filter((stage) => stage.completed).length,
                stagesTotal: stages.length,
                currentStage: stages.find((stage) => !stage.completed)?.stage ?? null,
                analyst: analystView(row.allocation?.analyst),
                assignedDate: row.allocation?.assignedDate?.toISOString() ?? null,
            };
        }),
        pagination: listPagination(params, total),
        filters: { status: params.status, analystId: params.analystId ?? null, search: params.search ?? null },
    };
}

// ---------------------------------------------------------------- Analysts and workload

// GET /api/admin/work-allocation/analysts: every ACTIVE Analyst (the only
// assignable users) with how many candidates each has now, plus the count
// of unallocated candidates. Analysts who are no longer active (or no longer
// Analysts) but still hold candidates are listed separately, so those
// candidates can be found and moved. One grouped query for the counts.
export async function listAllocationAnalysts({ db }) {
    const [analysts, groups, unallocated] = await Promise.all([
        db.user.findMany({ where: { role: ROLES.ANALYST, status: USER_STATUS.ACTIVE }, select: { adminId: true, name: true, email: true }, orderBy: [{ name: "asc" }, { adminId: "asc" }] }),
        db.candidateAllocation.groupBy({ by: ["analystId"], _count: { _all: true } }),
        db.candidate.count({ where: { allocation: { is: null } } }),
    ]);
    const countOf = new Map(groups.map((group) => [group.analystId, group._count._all]));
    const activeIds = new Set(analysts.map((analyst) => analyst.adminId));
    const formerIds = groups.map((group) => group.analystId).filter((id) => !activeIds.has(id));
    const former = formerIds.length
        ? await db.user.findMany({ where: { adminId: { in: formerIds } }, select: { adminId: true, name: true }, orderBy: [{ name: "asc" }, { adminId: "asc" }] })
        : [];
    return {
        analysts: analysts.map((analyst) => ({ analystId: analyst.adminId, name: analyst.name, email: analyst.email, assignedCount: countOf.get(analyst.adminId) ?? 0 })),
        unavailableAnalysts: former.map((user) => ({ analystId: user.adminId, name: user.name, assignedCount: countOf.get(user.adminId) ?? 0 })),
        unallocatedCount: unallocated,
    };
}

// ---------------------------------------------------------------- assign / reassign / unassign

function parseCandidateIds(body, errors) {
    const ids = body.candidateIds;
    if (!Array.isArray(ids) || ids.length === 0) {
        errors.push({ field: "candidateIds", message: "must be a non-empty list of passport IDs" });
        return [];
    }
    if (ids.length > MAX_ALLOCATION_CANDIDATES) {
        errors.push({ field: "candidateIds", message: `must hold at most ${MAX_ALLOCATION_CANDIDATES} candidates` });
        return [];
    }
    if (!ids.every((id) => typeof id === "string" && PASSPORT_ID_PATTERN.test(id))) {
        errors.push({ field: "candidateIds", message: "must be passport IDs (letters and digits)" });
        return [];
    }
    if (new Set(ids).size !== ids.length) {
        errors.push({ field: "candidateIds", message: "must not repeat a candidate" });
        return [];
    }
    return ids;
}

// POST /api/admin/work-allocation/assign
//   { candidateIds: [passportId, ...],
//     allocations: [{ analystId, count }, ...],   counts add up to candidateIds.length
//     reassign: boolean }                          required to move allocated candidates
// One Analyst is simply one allocation with the full count.
export function parseAssignBody(body) {
    const errors = [];
    if (!isObject(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const candidateIds = parseCandidateIds(body, errors);
    const allocations = [];
    if (!Array.isArray(body.allocations) || body.allocations.length === 0) {
        errors.push({ field: "allocations", message: "must be a non-empty list of { analystId, count }" });
    } else if (body.allocations.length > MAX_ALLOCATION_ANALYSTS) {
        errors.push({ field: "allocations", message: `must name at most ${MAX_ALLOCATION_ANALYSTS} Analysts` });
    } else {
        const seen = new Set();
        for (const [index, entry] of body.allocations.entries()) {
            const field = `allocations[${index}]`;
            if (!isObject(entry) || typeof entry.analystId !== "string" || !ID_PATTERN.test(entry.analystId)) {
                errors.push({ field: `${field}.analystId`, message: "must be a user ID" });
                continue;
            }
            if (!Number.isInteger(entry.count) || entry.count < 0) {
                errors.push({ field: `${field}.count`, message: "must be a whole number, 0 or more" });
                continue;
            }
            if (seen.has(entry.analystId)) {
                errors.push({ field: `${field}.analystId`, message: "must not repeat an Analyst" });
                continue;
            }
            seen.add(entry.analystId);
            if (entry.count > 0) allocations.push({ analystId: entry.analystId, count: entry.count });
        }
        if (!errors.length && !allocations.length) errors.push({ field: "allocations", message: "must give at least one Analyst a count above 0" });
    }
    if (!errors.length) {
        const sum = allocations.reduce((total, entry) => total + entry.count, 0);
        if (sum !== candidateIds.length) {
            errors.push({ field: "allocations", message: `counts must add up to the ${candidateIds.length} selected candidates (they add up to ${sum})`, code: "COUNT_MISMATCH" });
        }
    }
    if (body.reassign !== undefined && typeof body.reassign !== "boolean") errors.push({ field: "reassign", message: "must be true or false" });
    return errors.length ? { errors } : { values: { candidateIds, allocations, reassign: body.reassign === true } };
}

// POST /api/admin/work-allocation/unassign  { candidateIds: [...], confirm: true }
export function parseUnassignBody(body) {
    const errors = [];
    if (!isObject(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const candidateIds = parseCandidateIds(body, errors);
    if (body.confirm !== true) errors.push({ field: "confirm", message: "must be true: unassigning is explicit" });
    return errors.length ? { errors } : { values: { candidateIds } };
}

const audit = (tx, rows) => (rows.length ? tx.auditLog.createMany({ data: rows }) : null);
const auditRow = ({ actor, action, passportId, from, to }) => ({
    auditId: crypto.randomUUID(),
    adminId: actor.adminId,
    action,
    passportId,
    previousStatus: from ? ALLOCATION_STATUS.ALLOCATED : ALLOCATION_STATUS.UNALLOCATED,
    newStatus: to ? ALLOCATION_STATUS.ALLOCATED : ALLOCATION_STATUS.UNALLOCATED,
    reason: action === ALLOCATION_AUDIT_ACTION.UNASSIGN ? `Unassigned from ${from.name}` : `Assigned to ${to.name}`,
    // The Analyst's ID and name at the time (names can change later).
    previousValue: from ? JSON.stringify({ analystId: from.adminId, name: from.name }) : null,
    newValue: to ? JSON.stringify({ analystId: to.adminId, name: to.name }) : null,
});

// Locks the candidates (FOR UPDATE) so two allocations of the same
// candidates run one after the other, and returns them in the list order
// (newest registered first, passport ID for ties) with their current
// Analyst. Throws when any candidate no longer exists.
async function lockCandidates(tx, candidateIds) {
    const rows = await tx.$queryRaw`
        SELECT c."passport_id" AS "passportId", a."analyst_id" AS "analystId"
        FROM "candidate" c
        LEFT JOIN "candidate_allocation" a ON a."passport_id" = c."passport_id"
        WHERE c."passport_id" = ANY(${candidateIds})
        ORDER BY c."created_date" DESC, c."passport_id" ASC
        FOR UPDATE OF c`;
    if (rows.length !== candidateIds.length) {
        const found = new Set(rows.map((row) => row.passportId));
        const missing = candidateIds.filter((id) => !found.has(id));
        throw new CandidateError(409, "CANDIDATE_NOT_AVAILABLE", `${missing.length} selected candidate${missing.length === 1 ? " is" : "s are"} no longer available. Nothing was changed; refresh and try again.`);
    }
    return rows;
}

// Every target must be an ACTIVE Analyst, checked inside the transaction
// (rows locked FOR SHARE so a role change or deactivation can't slip in
// between the check and the write).
async function lockAnalysts(tx, analystIds) {
    const rows = await tx.$queryRaw`
        SELECT "admin_id" AS "adminId", "name", "role", "status" FROM "user"
        WHERE "admin_id" = ANY(${analystIds}) FOR SHARE`;
    const byId = new Map(rows.map((row) => [row.adminId, row]));
    for (const id of analystIds) {
        const user = byId.get(id);
        if (!user) throw new CandidateError(409, "ANALYST_NOT_FOUND", "A selected Analyst no longer exists. Nothing was changed.");
        if (user.role !== ROLES.ANALYST) throw new CandidateError(409, "NOT_AN_ANALYST", `${user.name} is no longer an Analyst. Nothing was changed.`);
        if (user.status !== USER_STATUS.ACTIVE) throw new CandidateError(409, "ANALYST_INACTIVE", `${user.name} is not an active user. Nothing was changed.`);
    }
    return byId;
}

async function namesOf(tx, ids) {
    if (!ids.length) return new Map();
    const users = await tx.user.findMany({ where: { adminId: { in: ids } }, select: { adminId: true, name: true } });
    return new Map(users.map((user) => [user.adminId, user]));
}

// Assigns the candidates, all or nothing, in one transaction. Order: the
// candidates are taken newest registered first (passport ID for ties: the
// list order, independent of the order they were ticked) and handed out in
// the order of `allocations`: the first Analyst gets the first `count`, the
// next Analyst the next `count`, and so on. Candidates that are already
// allocated are only moved with `reassign: true` (else 409, nothing
// changed), so a second manager working from a stale page never silently
// overwrites the first one's allocation. A candidate that would stay with
// the same Analyst is left as it is and not audited.
export async function assignCandidates({ db, actor, candidateIds, allocations, reassign = false }) {
    return db.$transaction(async (tx) => {
        const rows = await lockCandidates(tx, candidateIds);
        const analysts = await lockAnalysts(tx, allocations.map((entry) => entry.analystId));
        const allocated = rows.filter((row) => row.analystId);
        if (allocated.length && !reassign) {
            throw new CandidateError(409, "ALREADY_ALLOCATED", `${allocated.length} selected candidate${allocated.length === 1 ? " is" : "s are"} already allocated. Nothing was changed; confirm a reassignment to move them.`);
        }
        const previous = await namesOf(tx, [...new Set(allocated.map((row) => row.analystId))]);

        const plan = [];
        let next = 0;
        for (const { analystId, count } of allocations) {
            for (const row of rows.slice(next, next + count)) plan.push({ passportId: row.passportId, from: row.analystId, to: analystId });
            next += count;
        }
        const changes = plan.filter((entry) => entry.from !== entry.to);

        const now = new Date();
        const fresh = changes.filter((entry) => !entry.from);
        if (fresh.length) {
            await tx.candidateAllocation.createMany({ data: fresh.map((entry) => ({ passportId: entry.passportId, analystId: entry.to, assignedDate: now })) });
        }
        // Moves: one statement per target Analyst, never one per candidate.
        for (const { analystId } of allocations) {
            const moved = changes.filter((entry) => entry.from && entry.to === analystId).map((entry) => entry.passportId);
            if (moved.length) await tx.candidateAllocation.updateMany({ where: { passportId: { in: moved } }, data: { analystId, assignedDate: now } });
        }
        await audit(tx, changes.map((entry) => auditRow({
            actor,
            action: entry.from ? ALLOCATION_AUDIT_ACTION.REASSIGN : ALLOCATION_AUDIT_ACTION.ASSIGN,
            passportId: entry.passportId,
            from: entry.from ? previous.get(entry.from) ?? { adminId: entry.from, name: entry.from } : null,
            to: analysts.get(entry.to),
        })));

        return {
            assigned: fresh.length,
            reassigned: changes.length - fresh.length,
            unchanged: plan.length - changes.length,
            byAnalyst: allocations.map(({ analystId, count }) => ({ analystId, name: analysts.get(analystId).name, count })),
        };
    });
}

// Returns the candidates to Unallocated, all or nothing. Candidates that are
// already unallocated are left as they are. The Analyst loses access on
// their next request.
export async function unassignCandidates({ db, actor, candidateIds }) {
    return db.$transaction(async (tx) => {
        const rows = await lockCandidates(tx, candidateIds);
        const allocated = rows.filter((row) => row.analystId);
        const previous = await namesOf(tx, [...new Set(allocated.map((row) => row.analystId))]);
        if (allocated.length) await tx.candidateAllocation.deleteMany({ where: { passportId: { in: allocated.map((row) => row.passportId) } } });
        await audit(tx, allocated.map((row) => auditRow({
            actor,
            action: ALLOCATION_AUDIT_ACTION.UNASSIGN,
            passportId: row.passportId,
            from: previous.get(row.analystId) ?? { adminId: row.analystId, name: row.analystId },
            to: null,
        })));
        return { unassigned: allocated.length, alreadyUnallocated: rows.length - allocated.length };
    });
}
