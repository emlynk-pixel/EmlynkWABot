import express from "express";
import { rateLimit } from "express-rate-limit";

import { isUsableTokenSecret, parseCandidateFormOrigin } from "../config/candidateForm.js";
import { createPostgresRateLimitStore } from "../middleware/postgresRateLimitStore.js";
import { issueCandidateFormToken, passportReference } from "../services/candidateFormTokenService.js";
import { ALREADY_SUBMITTED_MESSAGE, parseVerifyBody, VERIFY_FAILED_MESSAGE, verifyFormLinkAccess } from "../services/candidateFormVerificationService.js";
import { loadCandidateForm, parseDraftBody, parseSubmission, saveCandidateFormDraft, submitCandidateForm } from "../services/candidateFormDataService.js";
import { CandidateError } from "../services/candidateService.js";
import { activeJobTypeNames } from "../services/jobTypeCatalog.js";
import { createRequireCandidateFormToken } from "../middleware/requireCandidateFormToken.js";
import { resolveDb } from "../utils/resolveClients.js";

// Public API of the Candidate Extra Details form, mounted at
// /api/public/candidate-details (src/createApp.js) BEFORE the app's global
// JSON parser, and completely separate from /api/admin and /auth: no staff
// middleware, no Supabase session, no req.user.
//
//   POST /verify   share-link secret + Passport + NIC -> short-lived candidate
//                  token (Docs/CANDIDATE_EXTRA_DETAILS_FORM_SHARE_LINKS_DESIGN.md)
//   POST /form     the candidate's identity (read-only) and the prefill
//   POST /draft    one step's answers, saved when the candidate clicks Next
//   POST /submit   the answers, once; then the form is locked for good
// /form and /submit take the candidate ONLY from the token
// (middleware/requireCandidateFormToken.js). Everything is POST, so CORS
// grants exactly POST and OPTIONS.
//
// Controls (Docs/CANDIDATE_EXTRA_DETAILS_FORM_SECURITY_RISKS.md):
//   - CORS for exactly CANDIDATE_FORM_ORIGIN; any other Origin gets 403 and
//     no CORS grant. CORS is not authorization: requests without an Origin
//     (curl, servers) are still subject to every check below.
//   - JSON body limits per route (16 KB; 64 KB for /submit, Sinhala text is
//     three bytes a character); only the documented fields are accepted.
//   - Strict input patterns before any lookup (no wildcard / SQL text reaches
//     the database).
//   - Its own rate limits in PostgreSQL (not the staff 1000 / 15 min limit):
//     failed attempts per client IP, and failed attempts per passport (keyed
//     by an HMAC of the passport, never the raw value).
//   - One generic 401 for every verification failure; fixed messages for
//     every other error; no candidate data in any response; never cached.
//   - No raw passport, NIC, link secret or answer in logs.

export const PUBLIC_CANDIDATE_DETAILS_PATH = "/api/public/candidate-details";

export const PUBLIC_VERIFY_LIMITS = Object.freeze({
    // Failed (4xx) verify requests per client IP.
    perIp: { windowMs: 15 * 60 * 1000, limit: 10 },
    // Failed verify requests per passport number, whatever the IP.
    perPassport: { windowMs: 60 * 60 * 1000, limit: 5 },
});

const RATE_LIMITED = Object.freeze({ message: "Too many attempts. Please wait a while and try again." });
const NOT_AVAILABLE = Object.freeze({ message: "Verification is not available right now." });
const INVALID_INPUT_MESSAGE = "Please enter a valid Passport Number and NIC Number.";
const INVALID_ANSWERS_MESSAGE = "Some answers are missing or not valid.";

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
    const smallJson = express.json({ limit: "16kb" });
    const answersJson = express.json({ limit: "64kb" });
    const requireSession = createRequireCandidateFormToken({ db, secret: tokenSecret, now });
    const requireSubmitSession = createRequireCandidateFormToken({ db, secret: tokenSecret, now, allowSubmitted: true });
    const notAvailable = (req, res, next) => (configured ? next() : res.status(503).json(NOT_AVAILABLE));
    // A CandidateError becomes its fixed { message, code }.
    const respond = (run) => async (req, res) => {
        try {
            return await run(req, res);
        } catch (error) {
            if (error instanceof CandidateError) return res.status(error.status).json({ message: error.message, code: error.code });
            throw error;
        }
    };

    router.post(
        "/verify",
        // A missing secret fails closed before anything is counted or read.
        notAvailable,
        smallJson,
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
            const { linkSecret, passportId, nic, passportRef } = req.candidateFormVerify;
            const client = await resolveDb(db);
            const result = await verifyFormLinkAccess({ db: client, linkSecret, passportId, nic, now: now() });
            if (result.outcome === "submitted") {
                return res.status(409).json({ message: ALREADY_SUBMITTED_MESSAGE, code: "ALREADY_SUBMITTED" });
            }
            if (result.outcome !== "verified") {
                // A keyed reference only: never the passport, the NIC or the link secret.
                log.warn("Candidate form verification failed", { ref: passportRef.slice(0, 12) });
                return res.status(401).json({ message: VERIFY_FAILED_MESSAGE, code: "VERIFICATION_FAILED" });
            }
            const { token, expiresAt } = issueCandidateFormToken({ secret: tokenSecret, passportId: result.passportId, linkId: result.linkId, version: result.version, kind: result.kind, jobId: result.jobId, now: now() });
            return res.json({ token, expiresAt });
        },
    );

    // The form for the verified candidate: identity (read-only) and prefill.
    router.post("/form", notAvailable, smallJson, requireSession, respond(async (req, res) => {
        const { passportId, linkId, expiresAt } = req.candidateForm;
        const client = await resolveDb(db);
        const form = await loadCandidateForm({ db: client, passportId, linkId, now: now() });
        return res.json({ ...form, expiresAt });
    }));

    // The answers, once. 409 after the form was submitted (by this request's
    // twin, another device, or earlier).
    // Saves the answers of one step (Next). The candidate and the lock version come only from the
    // token; a submitted form is refused (409) by requireSession. Validated with the submission's rules.
    router.post("/draft", notAvailable, answersJson, requireSession, respond(async (req, res) => {
        const client = await resolveDb(db);
        const parsed = parseDraftBody(req.body);
        if (parsed.errors) {
            return res.status(400).json({ message: INVALID_ANSWERS_MESSAGE, errors: parsed.errors.map(({ field, code }) => ({ field, code, message: code })) });
        }
        const { passportId, version } = req.candidateForm;
        const result = await saveCandidateFormDraft({
            db: client, passportId, version, step: parsed.step, groups: parsed.groups, answers: parsed.answers,
            jobCategories: await activeJobTypeNames(client), now: now(),
        });
        if (result.errors) {
            return res.status(400).json({ message: INVALID_ANSWERS_MESSAGE, errors: result.errors.map(({ field, code }) => ({ field, code, message: code })) });
        }
        return res.json({ savedSteps: result.savedSteps, savedAt: result.savedAt });
    }));

    router.post("/submit", notAvailable, answersJson, requireSubmitSession, respond(async (req, res) => {
        const client = await resolveDb(db);
        // The job category must be one of the job types active NOW (Settings > Job Types).
        const parsed = parseSubmission(req.body, { now: now(), jobCategories: await activeJobTypeNames(client) });
        if (parsed.errors) {
            // Field paths and codes only: never the submitted values.
            return res.status(400).json({ message: INVALID_ANSWERS_MESSAGE, errors: parsed.errors.map(({ field, code }) => ({ field, code, message: code })) });
        }
        const { passportId, linkId, version, kind, jobId } = req.candidateForm;
        const result = await submitCandidateForm({ db: client, passportId, linkId, version, kind, jobId, values: parsed.values, idempotencyKey: parsed.idempotencyKey, now: now() });
        return res.json(result);
    }));

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
