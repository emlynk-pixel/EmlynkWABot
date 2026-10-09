// Startup check of the environment (SEC-019). The server refuses to start
// with a missing or malformed setting instead of failing later on the first
// request that needs it. Error messages name the variables, never values.

export const REQUIRED_ENV_VARS = Object.freeze([
    "DATABASE_URL",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_BUCKET",
    "META_APP_SECRET",
    "WHATSAPP_VERIFY_TOKEN",
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_API_VERSION",
    "OCR_SERVICE_URL",
    // This environment's public admin address; the only source of invitation
    // redirects (config/appBaseUrl.js). Environment-specific.
    "APP_BASE_URL",
]);

// The worker-only process (src/worker.js, Step 5B) reads only these: the
// database, storage and the OCR service. It needs no Meta or WhatsApp
// secret, so its deployment doesn't have to hold them.
export const WORKER_REQUIRED_ENV_VARS = Object.freeze([
    "DATABASE_URL",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_BUCKET",
    "OCR_SERVICE_URL",
]);

// The Google Sheet sync worker (src/sheetSyncWorker.js, Cloud Run
// emlynk-sheet-sync-worker): the database and the Sheet target only. No
// Supabase storage, WhatsApp or OCR secret; no Google key either (keyless
// ADC: GOOGLE_APPLICATION_CREDENTIALS must NOT be set, see config/sheetSync.js).
export const SHEET_SYNC_WORKER_REQUIRED_ENV_VARS = Object.freeze([
    "DATABASE_URL",
    "SHEET_SPREADSHEET_ID",
    "SHEET_TAB_NAME",
]);

import { parseRequiredDocumentTypes } from "./requiredDocuments.js";
import { parseAppBaseUrl } from "./appBaseUrl.js";
import { isLoopbackUrl } from "../services/ocrClient.js";

// Number of reverse proxies in front of the app, from TRUST_PROXY_HOPS.
// Unset (the default) trusts none: req.ip is the direct peer, and a client
// can't choose its own IP for the login rate limit with X-Forwarded-For.
// Set it to the exact hop count only when deployed behind a known proxy
// (e.g. 1 behind a single load balancer). Never "true" (SEC-015).
//
// On Vercel, "unset" is the wrong default: every request to a Vercel
// serverless function passes through exactly one hop of Vercel's own edge
// proxy, which always sets X-Forwarded-For to the real client IP (Vercel
// docs, "Request headers") - Express's default "trust proxy: false" then
// reads req.ip as Vercel's internal connecting address, the same for every
// request, so the login/API rate limiters key every client into one shared
// bucket. Vercel sets VERCEL=1 for every deployment (production, preview and
// dev), so that - not an app-level guess - is what selects this default; an
// explicit TRUST_PROXY_HOPS still always wins, and the value is a specific
// known hop count, never `true` (which would trust an attacker-supplied
// X-Forwarded-For from anywhere).
export function trustProxyHops(value = process.env.TRUST_PROXY_HOPS, isVercel = process.env.VERCEL === "1") {
    if (value === undefined || value === "") {
        return isVercel ? 1 : null;
    }
    const hops = Number(value);
    if (!Number.isInteger(hops) || hops < 0 || hops > 10) {
        throw new Error("TRUST_PROXY_HOPS must be a whole number from 0 to 10");
    }
    return hops;
}

const isUrl = (value, protocols) => {
    try {
        return protocols.includes(new URL(value).protocol);
    } catch {
        return false;
    }
};

const isSet = (value) => typeof value === "string" && value.trim() !== "";

// Returns the names of the problems found; empty when everything is fine.
// `required` is the list of variables that must be set (the server's by
// default); the format checks below apply to whichever are set.
export function findEnvProblems(env = process.env, { required: requiredVars = REQUIRED_ENV_VARS } = {}) {
    const problems = [];

    for (const name of requiredVars) {
        if (!isSet(env[name])) {
            problems.push(`${name} is missing`);
        }
    }

    // Format checks only for values that are set; missing ones are reported above.
    // Base of the invitation redirect (config/appBaseUrl.js): the site
    // address only, http(s), no path/query/credentials.
    if (isSet(env.APP_BASE_URL)) {
        const { problem } = parseAppBaseUrl(env.APP_BASE_URL);
        if (problem) problems.push(problem);
    }
    if (isSet(env.SUPABASE_URL) && !isUrl(env.SUPABASE_URL, ["https:", "http:"])) {
        problems.push("SUPABASE_URL is not a valid URL");
    }
    if (isSet(env.DATABASE_URL) && !isUrl(env.DATABASE_URL, ["postgresql:", "postgres:"])) {
        problems.push("DATABASE_URL is not a postgresql:// URL");
    }
    // Plain http only to this machine: anything else carries identity tokens and documents.
    if (isSet(env.OCR_SERVICE_URL)) {
        if (!isUrl(env.OCR_SERVICE_URL, ["https:", "http:"])) {
            problems.push("OCR_SERVICE_URL is not a valid URL");
        } else if (!isUrl(env.OCR_SERVICE_URL, ["https:"]) && !isLoopbackUrl(env.OCR_SERVICE_URL)) {
            problems.push("OCR_SERVICE_URL must use https:// unless it is a loopback address");
        }
    }
    if (isSet(env.WHATSAPP_API_VERSION) && !/^v\d+\.\d+$/.test(env.WHATSAPP_API_VERSION)) {
        problems.push("WHATSAPP_API_VERSION must look like v21.0");
    }
    if (env.PORT !== undefined && env.PORT !== "" && !/^\d{1,5}$/.test(env.PORT)) {
        problems.push("PORT must be a number");
    }
    try {
        trustProxyHops(env.TRUST_PROXY_HOPS, env.VERCEL === "1");
    } catch (error) {
        problems.push(error.message);
    }
    const required = parseRequiredDocumentTypes(env.REQUIRED_DOCUMENT_TYPES);
    if (required.error) {
        problems.push(required.error);
    }

    return problems;
}

export function assertValidEnv(env = process.env, options) {
    const problems = findEnvProblems(env, options);
    if (problems.length > 0) {
        throw new Error(`Invalid environment configuration:\n- ${problems.join("\n- ")}`);
    }
}
