// Priority Follow-Ups: call logs marked as needing attention.
//
// A follow-up (call_log_follow_up) points at one call log and holds only its
// own state: OPEN (needs attention) or COMPLETED, who flagged it and when,
// who completed it and when. The call log stays the source of truth for the
// note, the call time, the caller and the candidate; nothing here copies,
// changes or deletes a call log.
//
//   flag      any Candidates-area role; at most one OPEN follow-up per call
//             (a partial unique index); a call can be flagged again once its
//             follow-up is completed
//   complete  any Candidates-area role; the row is kept (completed_by,
//             completed_date) and leaves the default (OPEN) list
//   delete    ADMIN and MANAGER only (enforced by the route); removes the
//             follow-up row and nothing else
//
// Each change is written to the audit log (CANDIDATE category), with the
// candidate's passport ID, in the same transaction.
//
// The list is grouped by candidate, each with the candidate's CURRENT
// document status (documentStatusOf, the candidate page's current-document
// rule). It reads a fixed number of queries whatever the number of
// follow-ups: the follow-ups (with their call logs, callers and completers),
// the candidates, and their documents.

import crypto from "node:crypto";

import { clientName } from "../utils/clientName.js";
import { CandidateError, documentStatusByCandidate } from "./candidateService.js";

export const FOLLOW_UP_STATUS = Object.freeze({ OPEN: "OPEN", COMPLETED: "COMPLETED" });
const STATUSES = Object.values(FOLLOW_UP_STATUS);

export const FOLLOW_UP_AUDIT_ACTION = Object.freeze({
    FLAG: "FLAG_FOLLOW_UP",
    COMPLETE: "COMPLETE_FOLLOW_UP",
    DELETE: "DELETE_FOLLOW_UP",
});

// The list returns at most this many follow-ups (newest first); `truncated`
// says when there are more.
export const MAX_LISTED_FOLLOW_UPS = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isValidFollowUpIdParam = (value) => typeof value === "string" && UUID_PATTERN.test(value);
export const isValidCallLogIdParam = isValidFollowUpIdParam;

const isUniqueViolation = (error) => error?.code === "P2002";
const notFound = () => new CandidateError(404, "FOLLOW_UP_NOT_FOUND", "Follow-up not found");

// GET query: { params: { status } } or { errors }. Default: OPEN.
export function parseFollowUpListQuery(query = {}) {
    const value = query.status;
    if (value === undefined || value === "") return { params: { status: FOLLOW_UP_STATUS.OPEN } };
    if (typeof value !== "string" || !STATUSES.includes(value.trim().toUpperCase())) {
        return { errors: [{ field: "status", message: `must be one of ${STATUSES.join(", ")}` }] };
    }
    return { params: { status: value.trim().toUpperCase() } };
}

function writeAudit(tx, { actor, action, passportId, previousStatus, newStatus, reason }) {
    return tx.auditLog.create({
        data: { auditId: crypto.randomUUID(), adminId: actor.adminId, action, passportId, previousStatus, newStatus, reason },
    });
}

// POST /api/admin/candidates/:passportId/call-logs/:callLogId/follow-up.
// The call log must be this candidate's. 409 FOLLOW_UP_EXISTS when the call
// already has an OPEN follow-up (checked first, and enforced by the index
// for two flags at the same moment).
export async function flagCallLog({ db, actor, passportId, callLogId }) {
    const callLog = await db.candidateCallLog.findFirst({ where: { callLogId, passportId }, select: { callLogId: true } });
    if (!callLog) throw new CandidateError(404, "CALL_LOG_NOT_FOUND", "Call log not found");
    const exists = () => new CandidateError(409, "FOLLOW_UP_EXISTS", "This call is already marked for follow-up.");
    try {
        return await db.$transaction(async (tx) => {
            const open = await tx.callLogFollowUp.findFirst({ where: { callLogId, status: FOLLOW_UP_STATUS.OPEN }, select: { followUpId: true } });
            if (open) throw exists();
            return { followUp: await openFollowUp(tx, { actor, passportId, callLogId }) };
        });
    } catch (error) {
        if (isUniqueViolation(error)) throw exists();
        throw error;
    }
}

// The OPEN follow-up row and its audit entry, inside the caller's
// transaction: flagging a call (above) and a new call added with Need
// Attention (candidateService.js addCallLog).
export async function openFollowUp(tx, { actor, passportId, callLogId }) {
    const followUp = await tx.callLogFollowUp.create({
        data: { followUpId: crypto.randomUUID(), callLogId, status: FOLLOW_UP_STATUS.OPEN, flaggedById: actor.adminId },
        select: { followUpId: true, status: true, flaggedDate: true },
    });
    await writeAudit(tx, {
        actor, action: FOLLOW_UP_AUDIT_ACTION.FLAG, passportId,
        previousStatus: "NONE", newStatus: FOLLOW_UP_STATUS.OPEN, reason: "Call log marked for follow-up",
    });
    return { followUpId: followUp.followUpId, callLogId, status: followUp.status, flaggedAt: followUp.flaggedDate };
}

const followUpSelect = {
    followUpId: true, status: true, flaggedDate: true, completedDate: true,
    flaggedBy: { select: { name: true } },
    completedBy: { select: { name: true } },
    callLog: { select: { callLogId: true, passportId: true, note: true, callOutcome: true, createdDate: true, admin: { select: { name: true } } } },
};

// GET /api/admin/follow-ups?status=OPEN|COMPLETED. Grouped by candidate:
// each candidate once, with its current document status and its follow-ups
// (newest first: flagged date for OPEN, completed date for COMPLETED).
// Candidates are ordered by their newest follow-up.
// scope: the signed-in user's candidates (candidateAccess.js); an Analyst
// only sees follow-ups of the candidates allocated to them, in the query.
export async function listFollowUps({ db, params, scope = {} }) {
    const completed = params.status === FOLLOW_UP_STATUS.COMPLETED;
    const rows = await db.callLogFollowUp.findMany({
        where: Object.keys(scope).length ? { status: params.status, callLog: { user: scope } } : { status: params.status },
        select: followUpSelect,
        orderBy: completed
            ? [{ completedDate: "desc" }, { flaggedDate: "desc" }, { followUpId: "asc" }]
            : [{ flaggedDate: "desc" }, { followUpId: "asc" }],
        take: MAX_LISTED_FOLLOW_UPS + 1,
    });
    const truncated = rows.length > MAX_LISTED_FOLLOW_UPS;
    const listed = rows.slice(0, MAX_LISTED_FOLLOW_UPS);

    const passportIds = [...new Set(listed.map((row) => row.callLog.passportId))];
    const [candidates, statuses] = await Promise.all([
        passportIds.length
            ? db.candidate.findMany({
                where: { passportId: { in: passportIds } },
                select: { passportId: true, uniqueId: true, firstName: true, otherName: true, whatsappNumber: true, contactNumber: true },
            })
            : [],
        documentStatusByCandidate(db, passportIds),
    ]);
    const candidateById = new Map(candidates.map((c) => [c.passportId, c]));

    const groups = new Map();
    for (const row of listed) {
        const passportId = row.callLog.passportId;
        if (!groups.has(passportId)) {
            const candidate = candidateById.get(passportId);
            groups.set(passportId, {
                candidate: {
                    passportId,
                    uniqueId: candidate?.uniqueId ?? null,
                    name: candidate ? clientName(candidate) : null,
                    whatsappNumber: candidate?.whatsappNumber ?? null,
                    contactNumber: candidate?.contactNumber ?? null,
                },
                documentStatus: statuses.get(passportId) ?? [],
                followUps: [],
            });
        }
        groups.get(passportId).followUps.push(followUpView(row));
    }
    return {
        status: params.status,
        total: listed.length,
        truncated,
        groups: [...groups.values()],
    };
}

function followUpView(row) {
    return {
        followUpId: row.followUpId,
        status: row.status,
        flaggedAt: row.flaggedDate,
        flaggedByName: row.flaggedBy?.name ?? null,
        completedAt: row.completedDate ?? null,
        completedByName: row.completedBy?.name ?? null,
        callLog: {
            callLogId: row.callLog.callLogId,
            note: row.callLog.note,
            outcome: row.callLog.callOutcome ?? "ANSWERED",
            calledAt: row.callLog.createdDate,
            adminName: row.callLog.admin?.name ?? null,
        },
    };
}

// POST /api/admin/follow-ups/:followUpId/complete. Only an OPEN follow-up is
// completed (409 FOLLOW_UP_COMPLETED otherwise); the row is kept.
// scope: as for the list; a follow-up of a candidate outside it is "not found".
export async function completeFollowUp({ db, actor, followUpId, scope = {}, now = new Date() }) {
    return db.$transaction(async (tx) => {
        const existing = await tx.callLogFollowUp.findUnique({ where: { followUpId }, select: { status: true, callLog: { select: { passportId: true } } } });
        if (!existing) throw notFound();
        if (Object.keys(scope).length) {
            const allowed = await tx.candidate.findFirst({ where: { AND: [{ passportId: existing.callLog.passportId }, scope] }, select: { passportId: true } });
            if (!allowed) throw notFound();
        }
        const { count } = await tx.callLogFollowUp.updateMany({
            where: { followUpId, status: FOLLOW_UP_STATUS.OPEN },
            data: { status: FOLLOW_UP_STATUS.COMPLETED, completedById: actor.adminId, completedDate: now },
        });
        if (count !== 1) throw new CandidateError(409, "FOLLOW_UP_COMPLETED", "This follow-up is already completed.");
        await writeAudit(tx, {
            actor, action: FOLLOW_UP_AUDIT_ACTION.COMPLETE, passportId: existing.callLog.passportId,
            previousStatus: FOLLOW_UP_STATUS.OPEN, newStatus: FOLLOW_UP_STATUS.COMPLETED, reason: "Follow-up completed",
        });
        const saved = await tx.callLogFollowUp.findUnique({ where: { followUpId }, select: followUpSelect });
        return { followUp: followUpView(saved) };
    });
}

// DELETE /api/admin/follow-ups/:followUpId (ADMIN and MANAGER; the route
// checks the role). Removes the follow-up row only: its call log, the
// candidate and the candidate's documents are not touched.
export async function deleteFollowUp({ db, actor, followUpId }) {
    return db.$transaction(async (tx) => {
        const existing = await tx.callLogFollowUp.findUnique({ where: { followUpId }, select: { status: true, callLog: { select: { passportId: true } } } });
        if (!existing) throw notFound();
        const { count } = await tx.callLogFollowUp.deleteMany({ where: { followUpId } });
        if (count !== 1) throw notFound();
        await writeAudit(tx, {
            actor, action: FOLLOW_UP_AUDIT_ACTION.DELETE, passportId: existing.callLog.passportId,
            previousStatus: existing.status, newStatus: "DELETED", reason: "Follow-up deleted (the call log is kept)",
        });
        return { deleted: true, followUpId };
    });
}
