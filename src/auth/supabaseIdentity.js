// Verifies a Supabase access token server-side and returns the identity it
// belongs to. Supabase Auth is the only credential/session authority: the
// backend never issues or signs tokens of its own.
//
// auth.getUser(token) asks Supabase Auth itself, so it checks the signature,
// the expiry AND that the session still exists: a signed-out (or revoked)
// session is refused immediately, not only once its access token expires.
//
// Only the user ID and email are taken from Supabase. Role and status are
// never read from the token or user metadata; they come from public."user".

// Supabase access tokens are compact JWTs of a few hundred bytes to ~2 KB.
const MAX_TOKEN_LENGTH = 8192;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

// Supabase answers these for a token that is not (or no longer) valid.
const REJECTED_STATUSES = new Set([400, 401, 403, 404]);

export function bearerToken(req) {
    const header = req.headers?.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length).trim();
    return token || null;
}

export const looksLikeAccessToken = (token) =>
    typeof token === "string" && token.length <= MAX_TOKEN_LENGTH && JWT_SHAPE.test(token);

// Returns verifyAccessToken(token) -> { authUserId, email } | null.
// null: the token is not a valid, current Supabase session. Any other failure
// (Supabase unreachable, misconfigured) throws, so the request fails closed
// with a 500 instead of being treated as anonymous or authenticated.
export function createAccessTokenVerifier({ client }) {
    if (!client?.auth?.getUser) throw new Error("A Supabase client is required");

    return async function verifyAccessToken(token) {
        if (!looksLikeAccessToken(token)) return null;
        const { data, error } = await client.auth.getUser(token);
        if (error) {
            if (REJECTED_STATUSES.has(error.status) || error.name === "AuthSessionMissingError") return null;
            throw Object.assign(new Error("Supabase token verification failed"), { name: "AuthVerificationError", status: error.status });
        }
        const user = data?.user;
        if (!user?.id) return null;
        return { authUserId: user.id, email: typeof user.email === "string" ? user.email.toLowerCase() : null };
    };
}

// The production verifier, built on first use from the existing server
// Supabase client (config/supabase.js, service-role key, server only), so
// tests that inject their own verifier never construct it.
let defaultVerifier;
export async function verifyWithSupabase(token) {
    if (!defaultVerifier) {
        const { default: supabase } = await import("../config/supabase.js");
        defaultVerifier = createAccessTokenVerifier({ client: supabase });
    }
    return defaultVerifier(token);
}
