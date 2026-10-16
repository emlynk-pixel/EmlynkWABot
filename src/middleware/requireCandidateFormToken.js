import { isUsableTokenSecret } from "../config/candidateForm.js";
import { readCandidateFormToken } from "../services/candidateFormTokenService.js";
import { FORM_ACCESS_STATUS } from "../services/candidateFormShareService.js";
import { ALREADY_SUBMITTED_MESSAGE } from "../services/candidateFormVerificationService.js";
import { resolveDb } from "../utils/resolveClients.js";

// Candidate-session check for the public Candidate Form routes that read the
// form and submit it (POST /form, POST /submit).
//
// The candidate comes ONLY from the verified token: this middleware never
// reads a passport ID from the path, the query string or the body. The token
// travels only in the Authorization header. On EVERY request it checks the
// token (encryption tag, audience, expiry) and then the database:
//   - the share link the candidate verified through still belongs to them,
//     is not revoked and has not expired (a new link revokes the old one);
//   - the form is still UNLOCKED at the token's lock version (a new link, a
//     revoke or a submission all change the version).
// So revoking a link, replacing it, or submitting ends every session at once.
// A submitted form gets 409 with a neutral body (the holder already proved
// who they are); everything else is 401 "verify again".
// Sets req.candidateForm = { passportId, linkId, version, expiresAt, submitted }.
//
// allowSubmitted (POST /submit only): a session whose form was just submitted
// is passed on, marked submitted, so the submit handler can answer a safe
// retry of the SAME request (same idempotency key) with the same success.
// Any other request on a submitted form still gets 409 there.
//
// This is not a staff credential: it never sets req.user and it is never used
// on /api/admin or /auth (those verify Supabase sessions only).

export const SESSION_EXPIRED_MESSAGE = "Your verification has expired. Please verify your details again.";

export function createRequireCandidateFormToken({ db, secret = process.env.CANDIDATE_FORM_TOKEN_SECRET, now = () => new Date(), allowSubmitted = false } = {}) {
    return async (req, res, next) => {
        if (!isUsableTokenSecret(secret)) {
            return res.status(503).json({ message: "Verification is not available right now." });
        }
        const header = req.headers.authorization;
        const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
        const current = now();
        const payload = token ? readCandidateFormToken(token, { secret, now: current }) : null;
        const expired = () => res.status(401).json({ message: SESSION_EXPIRED_MESSAGE, code: "VERIFICATION_REQUIRED" });
        if (!payload) return expired();

        const client = await resolveDb(db);
        const link = await client.candidateFormLink.findUnique({
            where: { linkId: payload.lnk },
            select: { passportId: true, revokedAt: true, expiresAt: true, candidate: { select: { formAccess: { select: { status: true, version: true } } } } },
        });
        const access = link?.candidate?.formAccess;
        if (!link || link.passportId !== payload.sub) return expired();
        if (access?.status === FORM_ACCESS_STATUS.SUBMITTED) {
            if (!allowSubmitted) return res.status(409).json({ message: ALREADY_SUBMITTED_MESSAGE, code: "ALREADY_SUBMITTED" });
            req.candidateForm = { passportId: payload.sub, linkId: payload.lnk, version: payload.ver, expiresAt: new Date(payload.exp * 1000).toISOString(), submitted: true };
            return next();
        }
        if (link.revokedAt || link.expiresAt <= current || access?.status !== FORM_ACCESS_STATUS.UNLOCKED || access.version !== payload.ver) {
            return expired();
        }
        req.candidateForm = {
            passportId: payload.sub,
            linkId: payload.lnk,
            version: payload.ver,
            expiresAt: new Date(payload.exp * 1000).toISOString(),
            submitted: false,
        };
        return next();
    };
}
