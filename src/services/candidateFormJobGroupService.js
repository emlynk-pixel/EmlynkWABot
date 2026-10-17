import crypto from "node:crypto";

import { CandidateError } from "./candidateService.js";
import { JOB_STATUS } from "./jobAssignmentReader.js";
import {
    FORM_ACCESS_STATUS,
    FORM_LINK_TTL_MS,
    hashLinkSecret,
    linkIsActive,
    newLinkSecret,
    shareUrl,
    writeAudit,
} from "./candidateFormShareService.js";

// Candidate Form JOB_GROUP share links (Admin > Candidate > Share Form > "Share
// link for the job group"). Docs/CANDIDATE_EXTRA_DETAILS_FORM_SHARE_LINKS_DESIGN.md.
//
// One link for everyone assigned to ONE job. It is bound to the immutable
// job.id (never the job code, never the company's Job ID, never the legacy
// candidate_stages.job_id). Who may use it is decided LIVE, at verification and
// on every protected request: the job is PROCESSING and the candidate has an
// active job_candidate row for that exact job. Membership is not copied into the
// link, so a candidate added later can use it and one removed cannot.
//
// Same secret rules as a personal link (256-bit CSPRNG, only a SHA-256 stored,
// shown once, URL fragment, 3 days). Each candidate keeps their OWN lock
// (candidate_form_access): creating the link unlocks the members who are LOCKED;
// members already UNLOCKED (e.g. by a personal link) keep their sessions;
// SUBMITTED members are never touched. One active group link per job: a new one
// revokes the previous one (a partial unique index enforces it).

export const JOB_GROUP_AUDIT_ACTION = Object.freeze({ CREATE: "CREATE_JOB_FORM_LINK", REVOKE: "REVOKE_JOB_FORM_LINK" });

// Wrong Passport + NIC attempts on one GROUP link before it is locked. A group
// link is held by many people, so the personal-link limit (10) would let a few
// typos lock the whole group; the per-IP and per-passport limits still apply.
export const GROUP_LINK_MAX_FAILURES = 100;

async function lockProcessingJob(tx, jobId) {
    const [job] = await tx.$queryRaw`SELECT "id", "job_code" AS "jobCode", "status" FROM "job" WHERE "id" = ${jobId}::uuid FOR SHARE`;
    if (!job) throw new CandidateError(404, "JOB_NOT_FOUND", "Job not found");
    if (job.status !== JOB_STATUS.PROCESSING) {
        throw new CandidateError(409, "JOB_NOT_PROCESSING", `Job ${job.jobCode} is ${job.status.toLowerCase()}; a job-group link works only for a PROCESSING job.`);
    }
    return job;
}

// GET /api/admin/jobs/:jobId/form-share
//   state: OPEN (an active link) | NONE. counts: members, submitted, remaining.
export async function getJobGroupShareStatus({ db, jobId, now = new Date() }) {
    const job = await db.job.findUnique({
        where: { id: jobId },
        select: { id: true, jobCode: true, companyJobId: true, status: true, company: { select: { name: true } }, jobType: { select: { name: true } } },
    });
    if (!job) throw new CandidateError(404, "JOB_NOT_FOUND", "Job not found");
    const [link, members] = await Promise.all([
        db.candidateFormLink.findFirst({
            where: { jobId, kind: "JOB_GROUP", revokedAt: null },
            orderBy: { createdAt: "desc" },
            select: { linkId: true, createdAt: true, expiresAt: true, lockedUntil: true, createdBy: { select: { name: true } } },
        }),
        db.jobCandidate.findMany({ where: { jobId, isActive: true }, select: { candidate: { select: { formAccess: { select: { status: true } } } } } }),
    ]);
    const processing = job.status === JOB_STATUS.PROCESSING;
    const active = processing && linkIsActive(link, now);
    const submitted = members.filter((m) => m.candidate.formAccess?.status === FORM_ACCESS_STATUS.SUBMITTED).length;
    return {
        jobId: job.id,
        jobCode: job.jobCode,
        companyJobId: job.companyJobId ?? null,
        company: job.company.name,
        jobType: job.jobType.name,
        jobStatus: job.status,
        state: active ? "OPEN" : "NONE",
        counts: { candidates: members.length, submitted, remaining: members.length - submitted },
        link: active
            ? {
                linkId: link.linkId,
                createdAt: link.createdAt.toISOString(),
                createdByName: link.createdBy?.name ?? null,
                expiresAt: link.expiresAt.toISOString(),
                lockedUntil: link.lockedUntil && link.lockedUntil > now ? link.lockedUntil.toISOString() : null,
            }
            : null,
    };
}

// POST /api/admin/jobs/:jobId/form-share. Returns the URL with the secret ONCE.
export async function createJobGroupShareLink({ db, actor, jobId, formOrigin, now = new Date() }) {
    if (!formOrigin) throw new CandidateError(503, "FORM_NOT_CONFIGURED", "The Candidate Form is not configured, so no link can be created.");
    const secret = newLinkSecret();
    const linkId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + FORM_LINK_TTL_MS);

    await db.$transaction(async (tx) => {
        const job = await lockProcessingJob(tx, jobId);
        const previous = await tx.candidateFormLink.updateMany({ where: { jobId, kind: "JOB_GROUP", revokedAt: null }, data: { revokedAt: now, revokedById: actor.adminId } });
        await tx.candidateFormLink.create({
            data: { linkId, kind: "JOB_GROUP", jobId, passportId: null, tokenHash: hashLinkSecret(secret), createdById: actor.adminId, createdAt: now, expiresAt },
        });
        // Unlock the members who are LOCKED (a missing row counts as LOCKED).
        // UNLOCKED stay as they are, SUBMITTED are final and never matched.
        await tx.$executeRaw`
            INSERT INTO "candidate_form_access" ("passport_id")
            SELECT "passport_id" FROM "job_candidate" WHERE "job_id" = ${jobId}::uuid AND "is_active"
            ON CONFLICT ("passport_id") DO NOTHING`;
        const unlocked = await tx.$executeRaw`
            UPDATE "candidate_form_access" SET "status" = 'UNLOCKED', "version" = "version" + 1, "unlocked_at" = ${now}, "unlocked_by" = ${actor.adminId},
                "unlocked_via_link_id" = ${linkId}, "updated_at" = ${now}
            WHERE "status" = 'LOCKED'
              AND "passport_id" IN (SELECT "passport_id" FROM "job_candidate" WHERE "job_id" = ${jobId}::uuid AND "is_active")`;
        await writeAudit(tx, {
            actor,
            action: JOB_GROUP_AUDIT_ACTION.CREATE,
            passportId: null,
            previousStatus: previous.count ? "OPEN" : "NONE",
            newStatus: "OPEN",
            reason: `Candidate Form job-group link created for ${job.jobCode}`,
            // Never the secret.
            newValue: JSON.stringify({ jobId, jobCode: job.jobCode, linkId, expiresAt: expiresAt.toISOString(), replacedLinks: previous.count, unlocked }),
        });
    });

    return { url: shareUrl(formOrigin, secret), linkId, expiresAt: expiresAt.toISOString(), status: await getJobGroupShareStatus({ db, jobId, now }) };
}

// POST /api/admin/jobs/:jobId/form-share/revoke. The link and every session
// from it stop at once. Members it unlocked are locked again; submitted
// answers, assignments and other links are untouched.
export async function revokeJobGroupShareLink({ db, actor, jobId, now = new Date() }) {
    await db.$transaction(async (tx) => {
        const [job] = await tx.$queryRaw`SELECT "job_code" AS "jobCode" FROM "job" WHERE "id" = ${jobId}::uuid FOR SHARE`;
        if (!job) throw new CandidateError(404, "JOB_NOT_FOUND", "Job not found");
        const links = await tx.candidateFormLink.findMany({ where: { jobId, kind: "JOB_GROUP", revokedAt: null }, select: { linkId: true } });
        if (!links.length) throw new CandidateError(404, "NO_ACTIVE_LINK", "This job has no group link to revoke.");
        const ids = links.map((link) => link.linkId);
        await tx.candidateFormLink.updateMany({ where: { linkId: { in: ids } }, data: { revokedAt: now, revokedById: actor.adminId } });
        const relocked = await tx.candidateFormAccess.updateMany({
            where: { status: FORM_ACCESS_STATUS.UNLOCKED, unlockedViaLinkId: { in: ids } },
            data: { status: FORM_ACCESS_STATUS.LOCKED, version: { increment: 1 }, updatedAt: now },
        });
        await writeAudit(tx, {
            actor,
            action: JOB_GROUP_AUDIT_ACTION.REVOKE,
            passportId: null,
            previousStatus: "OPEN",
            newStatus: "NONE",
            reason: `Candidate Form job-group link revoked for ${job.jobCode}`,
            newValue: JSON.stringify({ jobId, linkIds: ids, relocked: relocked.count }),
        });
    });
    return getJobGroupShareStatus({ db, jobId, now });
}
