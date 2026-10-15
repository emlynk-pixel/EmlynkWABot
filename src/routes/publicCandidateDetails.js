import express from "express";
import { rateLimit } from "express-rate-limit";

import { isUsableTokenSecret, parseCandidateFormOrigin } from "../config/candidateForm.js";
import { createPostgresRateLimitStore } from "../middleware/postgresRateLimitStore.js";
import { issueCandidateFormToken, passportReference } from "../services/candidateFormTokenService.js";
import { parseVerifyBody, VERIFY_FAILED_MESSAGE, verifyCandidateDetailsAccess } from "../services/candidateFormVerificationService.js";
import { resolveDb } from "../utils/resolveClients.js";

// Public API of the Candidate Extra Details form, mounted at
// /api/public/candidate-details (src/createApp.js) BEFORE the app's global
// JSON parser, and completely separate from /api/admin and /auth: no staff
// middleware, no Supabase session, no req.user.
//
// Task 1: POST /verify only (Passport + WhatsApp -> short-lived candidate
// token). Reading and saving the details come in Task 2 and will take the
// candidate only from the token (middleware/requireCandidateFormToken.js).
//
// Controls (Docs/CANDIDATE_EXTRA_DETAILS_FORM_SECURITY_RISKS.md):
//   - CORS for exactly CANDIDATE_FORM_ORIGIN; any other Origin gets 403 and
//     no CORS grant. CORS is not authorization: requests without an Origin
//     (curl, servers) are still subject to every check below.
//   - 16 KB JSON body limit; only passportNumber and whatsappNumber accepted.
//   - Strict input patterns before any lookup (no wildcard / SQL text reaches
//     the database).
//   - Its own rate limits in PostgreSQL (not the staff 1000 / 15 min limit):
//     failed attempts per client IP, and failed attempts per passport (keyed
//     by an HMAC of the passport, never the raw value).
//   - One generic 401 for every verification failure; fixed messages for
//     every other error; no candidate data in any response; never cached.
//   - No raw passport or WhatsApp number in logs.

export const PUBLIC_CANDIDATE_DETAILS_PATH = "/api/public/candidate-details";

export const PUBLIC_VERIFY_LIMITS = Object.freeze({
    // Failed (4xx) verify requests per client IP.
    perIp: { windowMs: 15 * 60 * 1000, limit: 10 },
    // Failed verify requests per passport number, whatever the IP.
    perPassport: { windowMs: 60 * 60 * 1000, limit: 5 },
});

const RATE_LIMITED = Object.freeze({ message: "Too many attempts. Please wait a while and try again." });
const NOT_AVAILABLE = Object.freeze({ message: "Verification is not available right now." });
const INVALID_INPUT_MESSAGE = "Please enter a valid Passport Number and WhatsApp Number.";

function failedAttemptLimiter({ db, prefix, windowMs, limit, keyGenerator }) {
    return rateLimit({
        windowMs,
        limit,
        store: createPostgresRateLimitStore({ prefix, db }),
        // Only failures count: a successful verification is taken off again.
        skipSuccessfulRequests: true,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        identifier: prefix,
        ...(keyGenerator ? { keyGenerator } : {}),
        handler: (req, res) => res.status(429).json(RATE_LIMITED),
    });
}

// CORS for the public router only. Unset origin: no browser origin is allowed.
export function createPublicCors(allowedOrigin) {
    const origin = parseCandidateFormOrigin(allowedOrigin);
    return (req, res, next) => {
        res.vary("Origin");
        const requestOrigin = req.headers.origin;
        if (requestOrigin === undefined) return next();
        if (!origin || requestOrigin !== origin) {
            return res.status(403).json({ message: "This request is not allowed." });
        }
        res.set({
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "600",
        });
        if (req.method === "OPTIONS") return res.sendStatus(204);
        return next();
    };
}

export function createPublicCandidateDetailsRouter({
    db,
    tokenSecret = process.env.CANDIDATE_FORM_TOKEN_SECRET,
    allowedOrigin = process.env.CANDIDATE_FORM_ORIGIN,
    limits = PUBLIC_VERIFY_LIMITS,
    // Tests may replace the limiters (e.g. with a pass-through).
    verifyIpLimiter = failedAttemptLimiter({ db, prefix: "public-verify-ip:", ...limits.perIp }),
    verifyPassportLimiter = failedAttemptLimiter({
        db,
        prefix: "public-verify-passport:",
        ...limits.perPassport,
        keyGenerator: (req) => req.candidateFormVerify.passportRef,
    }),
    log = console,
    now = () => new Date(),
} = {}) {
    const router = express.Router();
    const configured = isUsableTokenSecret(tokenSecret);

    router.use((req, res, next) => {
        res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
        next();
    });
    router.use(createPublicCors(allowedOrigin));
    router.use(express.json({ limit: "16kb" }));

    router.post(
        "/verify",
        // A missing secret fails closed before anything is counted or read.
        (req, res, next) => (configured ? next() : res.status(503).json(NOT_AVAILABLE)),
        verifyIpLimiter,
        (req, res, next) => {
            const parsed = parseVerifyBody(req.body);
            if (parsed.errors) {
                return res.status(400).json({ message: INVALID_INPUT_MESSAGE, errors: parsed.errors });
            }
            req.candidateFormVerify = { ...parsed.values, passportRef: passportReference(tokenSecret, parsed.values.passportId) };
            return next();
        },
        verifyPassportLimiter,
        async (req, res) => {
            const { passportId, whatsappDigits, passportRef } = req.candidateFormVerify;
            const client = await resolveDb(db);
            const match = await verifyCandidateDetailsAccess({ db: client, passportId, whatsappDigits });
            if (!match) {
                // A keyed reference only: never the passport or the number.
                log.warn("Candidate form verification failed", { ref: passportRef.slice(0, 12) });
                return res.status(401).json({ message: VERIFY_FAILED_MESSAGE, code: "VERIFICATION_FAILED" });
            }
            const { token, expiresAt } = issueCandidateFormToken({ secret: tokenSecret, passportId: match.passportId, whatsappDigits: match.whatsappDigits, now: now() });
            return res.json({ token, expiresAt });
        },
    );

    router.use((req, res) => res.status(404).json({ message: "Not found" }));

    // Fixed messages only: no stack, Prisma detail, SQL or input echo. Express
    // recognises an error handler by its four parameters, so `next` stays.
    router.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
        if (error?.type === "entity.too.large") return res.status(413).json({ message: "Request payload too large" });
        if (typeof error?.type === "string" && error.status >= 400 && error.status < 500) {
            return res.status(400).json({ message: INVALID_INPUT_MESSAGE });
        }
        log.error("Candidate form request failed", { path: `${req.baseUrl}${req.path}`, type: error?.name ?? "Error", code: typeof error?.code === "string" ? error.code : undefined });
        return res.status(500).json({ message: "Something went wrong. Please try again later." });
    });

    return router;
}
