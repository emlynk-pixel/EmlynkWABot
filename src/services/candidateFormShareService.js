import crypto from "node:crypto";

import { CandidateError } from "./candidateService.js";

// Candidate Form share links (Admin > Candidate > Additional details > Share
// Form). Docs/CANDIDATE_EXTRA_DETAILS_FORM_SHARE_LINKS_DESIGN.md.
//
// A link opens the public Candidate Form for ONE candidate. It carries a
// 256-bit random secret (crypto.randomBytes) in the URL fragment
// ("<form origin>/#k=<secret>"), which browsers never send to a server, so it
// stays out of server logs and the Referer. Only a SHA-256 hash of the secret
// is stored: the secret itself is shown to staff once, when the link is
// created, and can never be read back (a new link replaces it).
//
// Creating a link unlocks the candidate's form (candidate_form_access:
// LOCKED -> UNLOCKED) and replaces any earlier link; revoking it locks the
// form again. A SUBMITTED form stays submitted: no link can reopen it.
// Every change bumps the lock's version, which ends every session issued
// before it (the session token carries the version).

export const FORM_LINK_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
export const FORM_LINK_SECRET_BYTES = 32; // 256 bits
// Wrong Passport + NIC attempts on one link before it is locked for a while.
export const FORM_LINK_MAX_FAILURES = 10;
export const FORM_LINK_LOCK_MS = 60 * 60 * 1000;

export const FORM_ACCESS_STATUS = Object.freeze({ LOCKED: "LOCKED", UNLOCKED: "UNLOCKED", SUBMITTED: "SUBMITTED" });

export const FORM_LINK_AUDIT_ACTION = Object.freeze({ CREATE: "CREATE_FORM_LINK", REVOKE: "REVOKE_FORM_LINK" });

// base64url of 32 bytes: 43 characters.
const LINK_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const isLinkSecret = (value) => typeof value === "string" && LINK_SECRET_PATTERN.test(value);

// The stored form of a link secret. A plain SHA-256 is enough for a 256-bit
// random secret (it cannot be guessed or brute-forced from the hash).
export const hashLinkSecret = (secret) => crypto.createHash("sha256").update(secret, "utf8").digest("hex");

export const newLinkSecret = () => crypto.randomBytes(FORM_LINK_SECRET_BYTES).toString("base64url");

// The link staff share. The origin is the configured form origin, never a
// request header (OWASP: do not build such links from the Host header).
export const shareUrl = (formOrigin, secret) => `${formOrigin}/#k=${secret}`;

const linkIsActive = (link, now) => link && !link.revokedAt && link.expiresAt > now;

// GET /api/admin/candidates/:passportId/form-share
//   state: SUBMITTED | OPEN (an active link) | LOCKED (no active link)
export async function getFormShareStatus({ db, passportId, now = new Date() }) {
    const [access, link] = await Promise.all([
        db.candidateFormAccess.findUnique({ where: { passportId }, select: { status: true, submittedAt: true } }),
        db.candidateFormLink.findFirst({
            where: { passportId, revokedAt: null },
            orderBy: { createdAt: "desc" },
            select: { linkId: true, createdAt: true, expiresAt: true, lockedUntil: true, createdBy: { select: { name: true } } },
        }),
    ]);
    const submitted = access?.status === FORM_ACCESS_STATUS.SUBMITTED;
    const active = !submitted && linkIsActive(link, now);
    return {
        passportId,
        state: submitted ? FORM_ACCESS_STATUS.SUBMITTED : active ? "OPEN" : FORM_ACCESS_STATUS.LOCKED,
        submittedAt: access?.submittedAt?.toISOString() ?? null,
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

function writeAudit(tx, { actor, action, passportId, previousStatus, newStatus, reason, newValue = null }) {
    return tx.auditLog.create({
        data: { auditId: crypto.randomUUID(), adminId: actor.adminId, action, passportId, previousStatus, newStatus, reason, newValue },
    });
}

// Serialises link changes for one candidate (two staff clicking at once).
async function lockAccessRow(tx, passportId) {
    await tx.$executeRaw`INSERT INTO "candidate_form_access" ("passport_id") VALUES (${passportId}) ON CONFLICT ("passport_id") DO NOTHING`;
    const [row] = await tx.$queryRaw`SELECT "status", "version" FROM "candidate_form_access" WHERE "passport_id" = ${passportId} FOR UPDATE`;
    return row;
}

// POST /api/admin/candidates/:passportId/form-share. Returns the URL with the
// secret ONCE. Earlier links of the candidate are revoked in the same
// transaction, so only the newest link works.
export async function createFormShareLink({ db, actor, passportId, formOrigin, now = new Date() }) {
    if (!formOrigin) throw new CandidateError(503, "FORM_NOT_CONFIGURED", "The Candidate Form is not configured, so no link can be created.");
    const secret = newLinkSecret();
    const linkId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + FORM_LINK_TTL_MS);

    await db.$transaction(async (tx) => {
        const access = await lockAccessRow(tx, passportId);
        if (access.status === FORM_ACCESS_STATUS.SUBMITTED) {
            throw new CandidateError(409, "FORM_SUBMITTED", "This candidate has already submitted the form. It cannot be shared again.");
        }
        await tx.candidateFormLink.updateMany({ where: { passportId, revokedAt: null }, data: { revokedAt: now, revokedById: actor.adminId } });
        await tx.candidateFormLink.create({
            data: { linkId, kind: "SINGLE", passportId, tokenHash: hashLinkSecret(secret), createdById: actor.adminId, createdAt: now, expiresAt },
        });
        await tx.candidateFormAccess.update({
            where: { passportId },
            data: {
                status: FORM_ACCESS_STATUS.UNLOCKED,
                version: access.version + 1,
                unlockedAt: now,
                unlockedById: actor.adminId,
                unlockedViaLinkId: linkId,
                updatedAt: now,
            },
        });
        // Never the secret: only which link, and until when.
        await writeAudit(tx, {
            actor,
            action: FORM_LINK_AUDIT_ACTION.CREATE,
            passportId,
            previousStatus: access.status,
            newStatus: FORM_ACCESS_STATUS.UNLOCKED,
            reason: "Candidate Form share link created",
            newValue: JSON.stringify({ linkId, expiresAt: expiresAt.toISOString() }),
        });
    });

    return { url: shareUrl(formOrigin, secret), linkId, expiresAt: expiresAt.toISOString(), status: await getFormShareStatus({ db, passportId, now }) };
}

// POST /api/admin/candidates/:passportId/form-share/revoke. The link stops
// working at once (and every session from it), and the form is locked again.
export async function revokeFormShareLink({ db, actor, passportId, now = new Date() }) {
    await db.$transaction(async (tx) => {
        const access = await lockAccessRow(tx, passportId);
        const { count } = await tx.candidateFormLink.updateMany({ where: { passportId, revokedAt: null }, data: { revokedAt: now, revokedById: actor.adminId } });
        if (!count) throw new CandidateError(404, "NO_ACTIVE_LINK", "This candidate has no share link to revoke.");
        const relock = access.status === FORM_ACCESS_STATUS.UNLOCKED;
        if (relock) {
            await tx.candidateFormAccess.update({
                where: { passportId },
                data: { status: FORM_ACCESS_STATUS.LOCKED, version: access.version + 1, updatedAt: now },
            });
        }
        await writeAudit(tx, {
            actor,
            action: FORM_LINK_AUDIT_ACTION.REVOKE,
            passportId,
            previousStatus: access.status,
            newStatus: relock ? FORM_ACCESS_STATUS.LOCKED : access.status,
            reason: "Candidate Form share link revoked",
        });
    });
    return getFormShareStatus({ db, passportId, now });
}
