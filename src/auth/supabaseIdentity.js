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

// How the session was signed in: the access token's `amr` claim (Supabase: [{ method, timestamp }],
// e.g. "password", "otp", "invite", "recovery"). Read only AFTER Supabase verified the token, so the
// payload is genuine; never used to grant access, only to recognise a password sign-in and to
// end sessions older than MAX_SESSION_AGE_MS.
function tokenAmr(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
        return Array.isArray(payload?.amr) ? payload.amr : [];
    } catch {
        return [];
    }
}

export function amrMethods(token) {
    return tokenAmr(token).map((entry) => (typeof entry === "string" ? entry : entry?.method)).filter((method) => typeof method === "string");
}

// Longest a session is accepted after its sign-in, whatever Supabase allows.
export const MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// amr methods that are not a sign-in. Second factors (TOTP, phone, WebAuthn, "mfa/...")
// are added to an EXISTING session, and a refresh is not an authentication; counting
// them would let a session restart its 30 days without the user signing in again.
const NOT_A_SIGN_IN = new Set(["totp", "phone", "webauthn", "token_refresh"]);
const isSignInMethod = (method) => typeof method === "string" && !NOT_A_SIGN_IN.has(method) && !method.startsWith("mfa/");

// When the session signed in, in ms: the LATEST timestamp (Unix seconds) among the amr
// sign-in methods, so a re-authentication (e.g. a password recovery) starts a new period.
// Unlike `iat`, amr timestamps survive token refreshes. null when no sign-in method has a
// timestamp (the caller then fails closed).
export function signedInAt(token) {
    const seconds = tokenAmr(token)
        .filter((entry) => isSignInMethod(entry?.method))
        .map((entry) => entry.timestamp)
        .filter((t) => Number.isFinite(t) && t > 0);
    return seconds.length ? Math.max(...seconds) * 1000 : null;
}

// Returns verifyAccessToken(token) -> { authUserId, email, amr } | null.
// null: the token is not a valid, current Supabase session, or the session is
// older than maxSessionAgeMs. Any other failure (Supabase unreachable,
// misconfigured) throws, so the request fails closed with a 500 instead of
// being treated as anonymous or authenticated.
//
// Maximum session age: Supabase owns the session and the admin app signs in
// with Supabase directly, so the backend cannot record a lifetime per sign-in.
// This cap is the server-side lifetime behind the "Remember me" option: every
// session ends maxSessionAgeMs after its sign-in, however often it is
// refreshed. A token with no sign-in time is refused (fails closed).
export function createAccessTokenVerifier({ client, now = Date.now, maxSessionAgeMs = MAX_SESSION_AGE_MS }) {
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
        // Read only now that Supabase verified the token, so the payload is genuine.
        const signedIn = signedInAt(token);
        if (signedIn === null || now() - signedIn > maxSessionAgeMs) return null;
        return { authUserId: user.id, email: typeof user.email === "string" ? user.email.toLowerCase() : null, amr: amrMethods(token) };
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
