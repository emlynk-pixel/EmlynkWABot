import crypto from "node:crypto";

import { CandidateError, REQUIRED_SUBMISSION_DOCUMENTS, getCandidate } from "./candidateService.js";
import { VERIFICATION_STATUS } from "./clientDocumentService.js";

// Explicit, manual verification of a candidate's details and documents
// (candidate_verification). These are the only persistent signals behind the Candidate list
// Status "Details Verified" and "Documents Verified" (candidateWorkflowStatus.js): completing or
// saving data, an OCR-accepted document, or an upload never verifies anything.
//
// Who: ADMIN and MANAGER (the route). What it needs, so there is something to verify: DETAILS needs
// the Candidate details stage complete; DOCUMENTS needs at least one current required document on
// record (the whole set is NOT required: complete Document submission is a later Status, Visa
// Document Ready, which outranks Documents Verified). Both are audited, in the same transaction.
//
// Reset: a verification is cleared AUTOMATICALLY, in the same transaction as the change, when the
// data it covered changes (database triggers, migration 20261022120000_candidate_verification_reset;
// audited as DETAILS_VERIFICATION_RESET / DOCUMENTS_VERIFICATION_RESET when a signed-in user made the
// change). A manager can also remove one here.

export const VERIFICATION_KIND = Object.freeze({ DETAILS: "DETAILS", DOCUMENTS: "DOCUMENTS" });

export const VERIFICATION_AUDIT_ACTION = Object.freeze({
    DETAILS_VERIFICATION_RESET: "DETAILS_VERIFICATION_RESET",
    DOCUMENTS_VERIFICATION_RESET: "DOCUMENTS_VERIFICATION_RESET",
    VERIFY_DETAILS: "VERIFY_DETAILS",
    UNVERIFY_DETAILS: "UNVERIFY_DETAILS",
    VERIFY_DOCUMENTS: "VERIFY_DOCUMENTS",
    UNVERIFY_DOCUMENTS: "UNVERIFY_DOCUMENTS",
});

const CONFIG = {
    DETAILS: { stage: "CANDIDATE_DETAILS", at: "detailsVerifiedAt", by: "detailsVerifiedById", verify: "VERIFY_DETAILS", unverify: "UNVERIFY_DETAILS", code: "DETAILS_INCOMPLETE", message: "Complete the candidate details before verifying them." },
    DOCUMENTS: { at: "documentsVerifiedAt", by: "documentsVerifiedById", verify: "VERIFY_DOCUMENTS", unverify: "UNVERIFY_DOCUMENTS", code: "DOCUMENTS_MISSING", message: "Add at least one required document before verifying the documents." },
};

// POST /api/admin/candidates/:passportId/verification { kind: "DETAILS" | "DOCUMENTS", verified: boolean }
export function parseVerificationBody(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const errors = [];
    if (!Object.hasOwn(VERIFICATION_KIND, body.kind)) errors.push({ field: "kind", message: "must be DETAILS or DOCUMENTS" });
    if (typeof body.verified !== "boolean") errors.push({ field: "verified", message: "must be true or false" });
    return errors.length ? { errors } : { values: { kind: body.kind, verified: body.verified } };
}

// Sets or removes one verification. Repeating the current state changes and audits nothing.
export async function setCandidateVerification({ db, actor, passportId, kind, verified, now = new Date() }) {
    const config = CONFIG[kind];
    await db.$transaction(async (tx) => {
        const locked = await tx.$queryRaw`SELECT "passport_id" FROM "candidate" WHERE "passport_id" = ${passportId} FOR UPDATE`;
        if (!locked.length) throw new CandidateError(404, "NOT_FOUND", "Candidate not found");
        const row = await tx.candidateVerification.findUnique({ where: { passportId }, select: { [config.at]: true } });
        const already = Boolean(row?.[config.at]);
        if (already === verified) return;
        if (verified) {
            const ready = kind === "DETAILS"
                ? (await getCandidate({ db: tx, passportId })).stages.find((s) => s.stage === config.stage)?.completed
                : (await tx.document.count({ where: { passportId, documentType: { in: REQUIRED_SUBMISSION_DOCUMENTS }, verificationStatus: { not: VERIFICATION_STATUS.SUPERSEDED } } })) > 0;
            if (!ready) throw new CandidateError(409, config.code, config.message);
        }
        const data = verified ? { [config.at]: now, [config.by]: actor.adminId } : { [config.at]: null, [config.by]: null };
        await tx.candidateVerification.upsert({ where: { passportId }, create: { passportId, ...data }, update: data });
        await tx.auditLog.create({
            data: {
                auditId: crypto.randomUUID(), adminId: actor.adminId, action: verified ? config.verify : config.unverify, passportId,
                previousStatus: verified ? "NOT_VERIFIED" : "VERIFIED", newStatus: verified ? "VERIFIED" : "NOT_VERIFIED",
                reason: `${kind === "DETAILS" ? "Candidate details" : "Documents"} ${verified ? "verified" : "verification removed"}`,
            },
        });
    });
    return getCandidate({ db, passportId });
}
