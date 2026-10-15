// Candidate Extra Details public form (candidate-form/, its own Vercel
// project): backend-only settings. Docs/CANDIDATE_EXTRA_DETAILS_FORM_SECURITY_RISKS.md.
//
//   CANDIDATE_FORM_ORIGIN        the form's exact origin (CORS allow-list of
//                                /api/public/candidate-details only). Unset:
//                                no browser origin is allowed.
//   CANDIDATE_FORM_TOKEN_SECRET  signs / encrypts the short-lived candidate
//                                token. At least 32 characters, random, never
//                                shared with any frontend. Unset: verification
//                                answers 503 (fails closed).
//
// Both are optional for the server as a whole: without them the public form
// simply does not work, and nothing else is affected.

export const MIN_TOKEN_SECRET_LENGTH = 32;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The configured origin, normalised ("https://form.example.com"), or null
// when it is missing or not a bare origin. https only, except a loopback
// address for local development.
export function parseCandidateFormOrigin(value) {
    if (typeof value !== "string" || value.trim() === "") return null;
    let url;
    try {
        url = new URL(value.trim());
    } catch {
        return null;
    }
    const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    // "https://x.com/" and "https://x.com" are the same origin; anything with a path is not.
    if (value.trim().replace(/\/$/, "") !== url.origin) return null;
    return url.origin;
}

export const isUsableTokenSecret = (value) => typeof value === "string" && value.length >= MIN_TOKEN_SECRET_LENGTH;

// Format problems for src/config/env.js (only for values that are set).
export function findCandidateFormEnvProblems(env = process.env) {
    const problems = [];
    const isSet = (value) => typeof value === "string" && value.trim() !== "";
    if (isSet(env.CANDIDATE_FORM_ORIGIN) && !parseCandidateFormOrigin(env.CANDIDATE_FORM_ORIGIN)) {
        problems.push("CANDIDATE_FORM_ORIGIN must be an origin such as https://form.example.com (no path; http only for localhost)");
    }
    if (isSet(env.CANDIDATE_FORM_TOKEN_SECRET) && !isUsableTokenSecret(env.CANDIDATE_FORM_TOKEN_SECRET)) {
        problems.push(`CANDIDATE_FORM_TOKEN_SECRET must be at least ${MIN_TOKEN_SECRET_LENGTH} characters`);
    }
    return problems;
}
