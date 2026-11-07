import crypto from "node:crypto";

import { CandidateError, getCandidate } from "./candidateService.js";
import { CANDIDATE_OUTCOME, WORKFLOW_STATUS_LABELS, isCandidateOutcome } from "./candidateWorkflowStatus.js";

// A candidate's FINAL status, recorded by an Admin on the candidate page (or by the bulk import's
// VISA STATUS column, candidateImportService.js): Departed, Visa Not Going, Cancelled or Rejected.
// It is a recorded fact, not a stage, and drives the derived Status (candidateWorkflowStatus.js):
//   DEPARTED                          candidate.departed_at
//   VISA_NOT_GOING | CANCELLED | REJECTED   candidate.outcome (+ outcome_at)
// A candidate has at most one of the two (database CHECK candidate_departed_or_outcome_check), so a
// new final status replaces the previous one, and `null` clears it. ADMIN only (the route), audited
// as SET_FINAL_STATUS in the same transaction. Repeating the current value changes nothing.

export const FINAL_STATUSES = Object.freeze(["DEPARTED", ...Object.values(CANDIDATE_OUTCOME)]);
export const FINAL_STATUS_AUDIT_ACTION = "SET_FINAL_STATUS";

// POST /api/admin/candidates/:passportId/final-status { status: one of FINAL_STATUSES, or null to clear }
export function parseFinalStatusBody(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    if (body.status !== null && !FINAL_STATUSES.includes(body.status)) {
        return { errors: [{ field: "status", message: `must be null or one of: ${FINAL_STATUSES.join(", ")}` }] };
    }
    return { values: { status: body.status } };
}

const currentOf = (row) => row.outcome ?? (row.departedAt ? "DEPARTED" : null);
const labelOf = (code) => (code ? WORKFLOW_STATUS_LABELS[code] : "None");

export async function setCandidateFinalStatus({ db, actor, passportId, status, now = new Date() }) {
    await db.$transaction(async (tx) => {
        const locked = await tx.$queryRaw`SELECT "passport_id" FROM "candidate" WHERE "passport_id" = ${passportId} FOR UPDATE`;
        if (!locked.length) throw new CandidateError(404, "NOT_FOUND", "Candidate not found");
        const row = await tx.candidate.findUnique({ where: { passportId }, select: { departedAt: true, outcome: true } });
        const previous = currentOf(row);
        if (previous === status) return;
        const data = status === "DEPARTED"
            ? { departedAt: now, outcome: null, outcomeAt: null }
            : isCandidateOutcome(status)
                ? { departedAt: null, outcome: status, outcomeAt: now }
                : { departedAt: null, outcome: null, outcomeAt: null };
        await tx.candidate.update({ where: { passportId }, data });
        await tx.auditLog.create({
            data: {
                auditId: crypto.randomUUID(), adminId: actor.adminId, action: FINAL_STATUS_AUDIT_ACTION, passportId,
                previousStatus: previous ?? "NONE", newStatus: status ?? "NONE",
                reason: `Final status: ${labelOf(previous)} → ${labelOf(status)}`,
            },
        });
    });
    return getCandidate({ db, passportId });
}
