import { safeEqual } from "./candidateFormTokenService.js";
import { FORM_ACCESS_STATUS, FORM_LINK_LOCK_MS, FORM_LINK_MAX_FAILURES, hashLinkSecret, isLinkSecret, lockAccessRow } from "./candidateFormShareService.js";
import { GROUP_LINK_MAX_FAILURES } from "./candidateFormJobGroupService.js";
import { JOB_STATUS } from "./jobAssignmentReader.js";

// Share link + Passport + NIC verification for the public Candidate Form
// (POST /api/public/candidate-details/verify).
// Docs/CANDIDATE_EXTRA_DETAILS_FORM_SHARE_LINKS_DESIGN.md.
//
// Strict input rules come FIRST, before any database lookup:
//   - linkSecret: the 43-character base64url secret from the share link.
//   - passportNumber: trimmed, spaces and hyphens removed, then letters and
//     digits only, 1-20 characters (no % or _ can reach a query).
//   - nic: spaces removed, upper case, then 9 digits + V/X or 12 digits.
//
// A match needs: an existing share link that is not revoked, expired or
// locked; a candidate the link covers; that candidate's passport AND NIC,
// compared in constant time; and the form not yet submitted.
//   SINGLE     the link's own candidate (a link opens the form for ONE candidate);
//              the form must be UNLOCKED.
//   JOB_GROUP  any candidate with an active job_candidate row for the link's
//              job.id, while that job is PROCESSING (checked live, here and on
//              every request). A LOCKED member (added after the link was made)
//              is unlocked now; their own lock is theirs alone.
// A candidate outside the job, a finished job, a wrong passport or NIC and an
// unknown / revoked / expired link are all the same generic failure. Every other outcome is the same generic
// failure: the caller never learns which part was wrong, whether a passport
// exists or which candidate a link is for. The one exception is a form that
// was already submitted, which is said (neutrally) only after the link,
// passport and NIC all matched.
//
// Work on every path: one lookup by the secret's hash (an indexed unique
// key), then the same two constant-time comparisons, against placeholders
// when the link is unknown. A wrong Passport + NIC on a real link also
// counts a failure on that link (and locks it after FORM_LINK_MAX_FAILURES);
// the link secret is 256 bits, so the extra write only tells someone who
// already holds a valid link that it is valid.

export const VERIFY_FAILED_MESSAGE = "We couldn't verify your details. Please check your Passport Number and NIC Number and try again.";
export const ALREADY_SUBMITTED_MESSAGE = "This form has already been submitted. Thank you.";

const ALLOWED_FIELDS = new Set(["linkSecret", "passportNumber", "nic"]);
const PASSPORT_PATTERN = /^[A-Za-z0-9]{1,20}$/;
const NIC_PATTERN = /^(\d{9}[VX]|\d{12})$/;
const MAX_RAW_LENGTH = 64;

// Compared when no candidate matched, so every path does the same work. They
// can never equal a valid input (both fail their input patterns).
const NO_MATCH_PASSPORT = "#";
const NO_MATCH_NIC = "#";

export const canonicalPassport = (value) => value.trim().replace(/[\s-]/g, "").toUpperCase();
export const canonicalNic = (value) => value.trim().replace(/\s/g, "").toUpperCase();

// { values: { linkSecret, passportId, nic } } or { errors: [{ field, message }] }.
// Messages never echo the submitted values.
export function parseVerifyBody(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { errors: [{ field: "body", message: "must be a JSON object" }] };
    }
    const errors = [];
    if (Object.keys(body).some((key) => !ALLOWED_FIELDS.has(key))) {
        errors.push({ field: "body", message: "contains unsupported fields" });
    }
    const text = (field) => {
        const value = body[field];
        if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
            errors.push({ field, message: "is required" });
            return null;
        }
        if (typeof value !== "string" || value.length > MAX_RAW_LENGTH) {
            errors.push({ field, message: "is not valid" });
            return null;
        }
        return value;
    };

    const secret = text("linkSecret");
    const linkSecret = secret !== null && isLinkSecret(secret.trim()) ? secret.trim() : null;
    if (secret !== null && !linkSecret) errors.push({ field: "linkSecret", message: "is not valid" });

    const passport = text("passportNumber");
    const passportId = passport !== null && PASSPORT_PATTERN.test(canonicalPassport(passport)) ? canonicalPassport(passport) : null;
    if (passport !== null && !passportId) errors.push({ field: "passportNumber", message: "must contain only letters and digits (at most 20)" });

    const rawNic = text("nic");
    const nic = rawNic !== null && NIC_PATTERN.test(canonicalNic(rawNic)) ? canonicalNic(rawNic) : null;
    if (rawNic !== null && !nic) errors.push({ field: "nic", message: "must be 9 digits and V or X, or 12 digits" });

    return errors.length ? { errors } : { values: { linkSecret, passportId, nic } };
}

// { outcome: "verified", passportId, linkId, kind, jobId, version }
// | { outcome: "submitted" }   (link + passport + NIC matched; already submitted)
// | { outcome: "failed" }
export async function verifyFormLinkAccess({ db, linkSecret, passportId, nic, now = new Date() }) {
    const link = await db.candidateFormLink.findUnique({
        where: { tokenHash: hashLinkSecret(linkSecret) },
        select: {
            linkId: true, kind: true, passportId: true, jobId: true, expiresAt: true, revokedAt: true, lockedUntil: true, failedAttempts: true,
            job: { select: { status: true } },
            candidate: { select: { passportId: true, nic: true, formAccess: { select: { status: true, version: true } } } },
        },
    });
    const isGroup = link?.kind === "JOB_GROUP";
    let candidate = link?.candidate ?? null;
    let member = true;
    if (isGroup) {
        // The job comes ONLY from the stored link; the candidate is looked up among that
        // job's live members (job_candidate: this job_id, is_active), one indexed query.
        // A non-member, a member of another job and a removed member find nobody. It must
        // resolve to exactly one: if the typed passport matched two members (IDs differing
        // only in letter case), nobody is chosen and it fails like any other attempt.
        const rows = await db.jobCandidate.findMany({
            where: { jobId: link.jobId, isActive: true, candidate: { passportId: { equals: passportId, mode: "insensitive" } } },
            select: { candidate: { select: { passportId: true, nic: true, formAccess: { select: { status: true, version: true } } } } },
            take: 2,
        });
        candidate = rows.length === 1 ? rows[0].candidate : null;
        member = rows.length === 1;
    }

    // Always both comparisons, whatever was found. Both sides go through the same canonical form.
    const storedPassport = candidate ? canonicalPassport(candidate.passportId) : NO_MATCH_PASSPORT;
    const storedNic = candidate?.nic ? canonicalNic(candidate.nic) : NO_MATCH_NIC;
    const passportMatches = safeEqual(storedPassport, passportId);
    const nicMatches = safeEqual(storedNic, nic);

    const scopeOpen = isGroup ? link.job?.status === JOB_STATUS.PROCESSING : link?.kind === "SINGLE";
    // A group link with nobody matched is still a failed attempt ON that link (counted below).
    const usable = Boolean(link) && scopeOpen && !link.revokedAt && link.expiresAt > now && !(link.lockedUntil && link.lockedUntil > now) && (isGroup || Boolean(candidate));
    if (!usable) return { outcome: "failed" };

    if (!passportMatches || !nicMatches || !member) {
        // A failed attempt on this link; too many lock it for a while.
        const failures = link.failedAttempts + 1;
        await db.candidateFormLink.update({
            where: { linkId: link.linkId },
            data: failures >= (isGroup ? GROUP_LINK_MAX_FAILURES : FORM_LINK_MAX_FAILURES)
                ? { failedAttempts: 0, lockedUntil: new Date(now.getTime() + FORM_LINK_LOCK_MS) }
                : { failedAttempts: failures },
        });
        return { outcome: "failed" };
    }

    let access = candidate.formAccess;
    if (access?.status === FORM_ACCESS_STATUS.SUBMITTED) return { outcome: "submitted" };
    if (isGroup && access?.status !== FORM_ACCESS_STATUS.UNLOCKED) {
        // A member who was not there (or locked) when the link was created: unlock only their own form.
        access = await unlockMember({ db, passportId: candidate.passportId, linkId: link.linkId, now });
        if (access.status === FORM_ACCESS_STATUS.SUBMITTED) return { outcome: "submitted" };
    }
    if (access?.status !== FORM_ACCESS_STATUS.UNLOCKED) return { outcome: "failed" };

    await db.candidateFormLink.update({ where: { linkId: link.linkId }, data: { failedAttempts: 0, lastVerifiedAt: now } });
    return { outcome: "verified", passportId: candidate.passportId, linkId: link.linkId, kind: link.kind, jobId: isGroup ? link.jobId : null, version: access.version };
}

// LOCKED -> UNLOCKED for one verified member of a group link. SUBMITTED stays SUBMITTED.
async function unlockMember({ db, passportId, linkId, now }) {
    return db.$transaction(async (tx) => {
        const row = await lockAccessRow(tx, passportId);
        if (row.status !== FORM_ACCESS_STATUS.LOCKED) return row;
        await tx.candidateFormAccess.update({
            where: { passportId },
            data: { status: FORM_ACCESS_STATUS.UNLOCKED, version: row.version + 1, unlockedAt: now, unlockedViaLinkId: linkId, updatedAt: now },
        });
        return { status: FORM_ACCESS_STATUS.UNLOCKED, version: row.version + 1 };
    });
}
