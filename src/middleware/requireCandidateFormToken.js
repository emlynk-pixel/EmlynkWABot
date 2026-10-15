import { isUsableTokenSecret } from "../config/candidateForm.js";
import { readCandidateFormToken, safeEqual, whatsappBinding } from "../services/candidateFormTokenService.js";
import { normalizePhoneNumber } from "../utils/phoneNumber.js";
import { resolveDb } from "../utils/resolveClients.js";

// Candidate-token check for the public Candidate Extra Details routes that
// read or save details (added in Task 2; not mounted yet).
//
// The candidate comes ONLY from the verified token: this middleware never
// reads a passport ID from the path, the query string or the body. The token
// travels only in the Authorization header. On every request it checks the
// token (encryption tag, audience, expiry), that the candidate still exists,
// and that the stored WhatsApp number still matches the token's binding, so a
// changed number ends every older token. Sets req.candidateForm =
// { passportId, expiresAt }.
//
// This is not a staff credential: it never sets req.user and it is never used
// on /api/admin or /auth (those verify Supabase sessions only).

export const SESSION_EXPIRED_MESSAGE = "Your verification has expired. Please verify your details again.";

export function createRequireCandidateFormToken({ db, secret = process.env.CANDIDATE_FORM_TOKEN_SECRET, now = () => new Date() } = {}) {
    return async (req, res, next) => {
        if (!isUsableTokenSecret(secret)) {
            return res.status(503).json({ message: "Verification is not available right now." });
        }
        const header = req.headers.authorization;
        const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
        const payload = token ? readCandidateFormToken(token, { secret, now: now() }) : null;
        if (!payload) return res.status(401).json({ message: SESSION_EXPIRED_MESSAGE, code: "VERIFICATION_REQUIRED" });

        const client = await resolveDb(db);
        const candidate = await client.candidate.findUnique({
            where: { passportId: payload.sub },
            select: { passportId: true, whatsappNumber: true },
        });
        const digits = normalizePhoneNumber(candidate?.whatsappNumber);
        if (!candidate || !digits || !safeEqual(whatsappBinding(secret, digits), payload.wa)) {
            return res.status(401).json({ message: SESSION_EXPIRED_MESSAGE, code: "VERIFICATION_REQUIRED" });
        }
        req.candidateForm = { passportId: candidate.passportId, expiresAt: new Date(payload.exp * 1000).toISOString() };
        return next();
    };
}
