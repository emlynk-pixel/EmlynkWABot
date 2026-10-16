import { safeEqual } from "./candidateFormTokenService.js";
import { FORM_ACCESS_STATUS, FORM_LINK_LOCK_MS, FORM_LINK_MAX_FAILURES, hashLinkSecret, isLinkSecret } from "./candidateFormShareService.js";

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
// locked; the link's own candidate (a link opens the form for ONE
// candidate); that candidate's passport AND NIC, compared in constant time;
// and the form still UNLOCKED. Every other outcome is the same generic
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

// { outcome: "verified", passportId, linkId, version }
// | { outcome: "submitted" }   (link + passport + NIC matched; already submitted)
// | { outcome: "failed" }
export async function verifyFormLinkAccess({ db, linkSecret, passportId, nic, now = new Date() }) {
    const link = await db.candidateFormLink.findUnique({
        where: { tokenHash: hashLinkSecret(linkSecret) },
        select: {
            linkId: true, kind: true, passportId: true, expiresAt: true, revokedAt: true, lockedUntil: true, failedAttempts: true,
            candidate: { select: { passportId: true, nic: true, formAccess: { select: { status: true, version: true } } } },
        },
    });
    const candidate = link?.candidate ?? null;

    // Always both comparisons, whatever was found.
    const storedPassport = candidate ? candidate.passportId.toUpperCase() : NO_MATCH_PASSPORT;
    const storedNic = candidate?.nic ? canonicalNic(candidate.nic) : NO_MATCH_NIC;
    const passportMatches = safeEqual(storedPassport, passportId);
    const nicMatches = safeEqual(storedNic, nic);

    const usable = Boolean(link) && link.kind === "SINGLE" && !link.revokedAt && link.expiresAt > now && !(link.lockedUntil && link.lockedUntil > now) && Boolean(candidate);
    if (!usable) return { outcome: "failed" };

    if (!passportMatches || !nicMatches) {
        // A failed attempt on this link; too many lock it for a while.
        const failures = link.failedAttempts + 1;
        await db.candidateFormLink.update({
            where: { linkId: link.linkId },
            data: failures >= FORM_LINK_MAX_FAILURES
                ? { failedAttempts: 0, lockedUntil: new Date(now.getTime() + FORM_LINK_LOCK_MS) }
                : { failedAttempts: failures },
        });
        return { outcome: "failed" };
    }

    const access = candidate.formAccess;
    if (access?.status === FORM_ACCESS_STATUS.SUBMITTED) return { outcome: "submitted" };
    if (access?.status !== FORM_ACCESS_STATUS.UNLOCKED) return { outcome: "failed" };

    await db.candidateFormLink.update({ where: { linkId: link.linkId }, data: { failedAttempts: 0, lastVerifiedAt: now } });
    return { outcome: "verified", passportId: candidate.passportId, linkId: link.linkId, version: access.version };
}
