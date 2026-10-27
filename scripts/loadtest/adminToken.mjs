// How a load test gets an ADMIN access token for the LOAD-TEST Supabase project. Nothing is hardcoded
// or stored; secrets come from the environment and are never printed or included in errors.
//
//   1. LOADTEST_ADMIN_PASSWORD (shell only): password sign-in of the load-test project's ACTIVE ADMIN
//      (its email is read from that database). The API key is SUPABASE_ANON_KEY, or the key in
//      .env.loadtest when that key is an anon key.
//   2. otherwise, when SUPABASE_SERVICE_ROLE_KEY really is a service_role key: a short-lived session
//      for that ADMIN through the admin API (magic link, no email is sent).
//   3. otherwise: a clear error saying which of the two to provide.

export class AdminTokenError extends Error {
    constructor(message) {
        super(message);
        this.name = "AdminTokenError";
    }
}

// The `role` claim of a Supabase JWT key ("anon" / "service_role"), or null (e.g. sb_secret_ keys).
export function keyRole(key) {
    try {
        return JSON.parse(Buffer.from(String(key).split(".")[1], "base64url").toString()).role ?? null;
    } catch {
        return null;
    }
}

async function post(fetchImpl, url, apikey, body) {
    const response = await fetchImpl(url, {
        method: "POST",
        headers: { apikey, Authorization: `Bearer ${apikey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
}

export async function acquireAdminToken({ supabaseUrl, serviceKey, anonKey, email, password, fetchImpl = fetch }) {
    if (password) {
        const apikey = anonKey || (keyRole(serviceKey) === "anon" ? serviceKey : null);
        if (!apikey) throw new AdminTokenError("Password sign-in needs the project's anon key: set SUPABASE_ANON_KEY.");
        const { status, data } = await post(fetchImpl, `${supabaseUrl}/auth/v1/token?grant_type=password`, apikey, { email, password });
        if (status !== 200 || !data.access_token) throw new AdminTokenError(`Password sign-in of the load-test ADMIN was refused (HTTP ${status}).`);
        return { token: data.access_token, method: "password" };
    }
    if (keyRole(serviceKey) === "service_role" || String(serviceKey).startsWith("sb_secret_")) {
        const link = await post(fetchImpl, `${supabaseUrl}/auth/v1/admin/generate_link`, serviceKey, { type: "magiclink", email });
        const tokenHash = link.data?.hashed_token ?? link.data?.properties?.hashed_token;
        if (link.status !== 200 || !tokenHash) throw new AdminTokenError(`Could not prepare an ADMIN session through the admin API (HTTP ${link.status}).`);
        const verified = await post(fetchImpl, `${supabaseUrl}/auth/v1/verify`, serviceKey, { type: "magiclink", token_hash: tokenHash });
        if (verified.status !== 200 || !verified.data.access_token) throw new AdminTokenError(`Could not open an ADMIN session through the admin API (HTTP ${verified.status}).`);
        return { token: verified.data.access_token, method: "service_role" };
    }
    throw new AdminTokenError(
        "No way to sign in the load-test ADMIN: SUPABASE_SERVICE_ROLE_KEY in .env.loadtest is not a service_role key. "
        + "Either put the real service_role key there, or set LOADTEST_ADMIN_PASSWORD (and SUPABASE_ANON_KEY if needed) in your shell.",
    );
}
