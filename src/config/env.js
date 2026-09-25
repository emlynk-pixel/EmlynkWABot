// Startup check of the environment (SEC-019). The server refuses to start
// with a missing or malformed setting instead of failing later on the first
// request that needs it. Error messages name the variables, never values.

export const REQUIRED_ENV_VARS = Object.freeze([
    "DATABASE_URL",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_BUCKET",
    "JWT_SECRET",
    "META_APP_SECRET",
    "WHATSAPP_VERIFY_TOKEN",
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_API_VERSION",
]);

// HS256 key: shorter secrets can be brute-forced from a single token.
export const MIN_JWT_SECRET_LENGTH = 32;

// Number of reverse proxies in front of the app, from TRUST_PROXY_HOPS.
// Unset (the default) trusts none: req.ip is the direct peer, and a client
// can't choose its own IP for the login rate limit with X-Forwarded-For.
// Set it to the exact hop count only when deployed behind a known proxy
// (e.g. 1 behind a single load balancer). Never "true" (SEC-015).
export function trustProxyHops(value = process.env.TRUST_PROXY_HOPS) {
    if (value === undefined || value === "") return null;
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
export function findEnvProblems(env = process.env) {
    const problems = [];

    for (const name of REQUIRED_ENV_VARS) {
        if (!isSet(env[name])) {
            problems.push(`${name} is missing`);
        }
    }

    // Format checks only for values that are set; missing ones are reported above.
    if (isSet(env.JWT_SECRET) && env.JWT_SECRET.length < MIN_JWT_SECRET_LENGTH) {
        problems.push(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters`);
    }
    if (isSet(env.SUPABASE_URL) && !isUrl(env.SUPABASE_URL, ["https:", "http:"])) {
        problems.push("SUPABASE_URL is not a valid URL");
    }
    if (isSet(env.DATABASE_URL) && !isUrl(env.DATABASE_URL, ["postgresql:", "postgres:"])) {
        problems.push("DATABASE_URL is not a postgresql:// URL");
    }
    if (isSet(env.WHATSAPP_API_VERSION) && !/^v\d+\.\d+$/.test(env.WHATSAPP_API_VERSION)) {
        problems.push("WHATSAPP_API_VERSION must look like v21.0");
    }
    if (env.PORT !== undefined && env.PORT !== "" && !/^\d{1,5}$/.test(env.PORT)) {
        problems.push("PORT must be a number");
    }
    try {
        trustProxyHops(env.TRUST_PROXY_HOPS);
    } catch (error) {
        problems.push(error.message);
    }

    return problems;
}

export function assertValidEnv(env = process.env) {
    const problems = findEnvProblems(env);
    if (problems.length > 0) {
        throw new Error(`Invalid environment configuration:\n- ${problems.join("\n- ")}`);
    }
}
