// Stand-ins for Supabase Auth in tests: nothing here contacts Supabase.
//
// A "session" is a token of the form test-access-token:<authUserId>; any
// other string is an invalid or expired token. authIdFor(adminId) gives the
// stable Supabase identity (a UUID) of a fixture user, so a fixture row and
// its token always match.
import crypto from "node:crypto";

import { AuthAdminError } from "../../src/auth/supabaseAuthAdmin.js";

const PREFIX = "test-access-token:";

export function authIdFor(adminId) {
    const hex = crypto.createHash("sha256").update(`auth:${adminId}`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const tokenForAuthId = (authUserId) => `${PREFIX}${authUserId}`;
export const tokenFor = (adminId) => tokenForAuthId(authIdFor(adminId));

// verifyAccessToken stand-in. revoke(token) simulates a signed-out session;
// calls records every token checked.
export function createFakeVerifier() {
    const revoked = new Set();
    const calls = [];
    async function verifyAccessToken(token) {
        calls.push(token);
        if (typeof token !== "string" || !token.startsWith(PREFIX) || revoked.has(token)) return null;
        return { authUserId: token.slice(PREFIX.length), email: null };
    }
    verifyAccessToken.revoke = (token) => revoked.add(token);
    verifyAccessToken.calls = calls;
    return verifyAccessToken;
}
export const fakeVerifyAccessToken = createFakeVerifier();

// The Supabase Auth Admin API (src/auth/supabaseAuthAdmin.js interface).
// identities: email -> { authUserId, confirmed }. failNext(code) makes the
// next call throw that AuthAdminError code.
export function createFakeAuthAdmin({ identities = {} } = {}) {
    const users = new Map(Object.entries(identities).map(([email, value]) => [email, { ...value }]));
    const calls = [];
    let failure = null;
    const takeFailure = () => {
        const f = failure;
        failure = null;
        if (f) throw new AuthAdminError(f, `fake ${f}`);
    };
    return {
        users,
        calls,
        failNext(code) { failure = code; },
        // Invited, not yet set up: not confirmed (Supabase re-sends the invite).
        // Already set up: confirmed (Supabase refuses with email_exists).
        confirm(email) { users.get(email).confirmed = true; },
        async inviteUserByEmail(email, options = {}) {
            calls.push({ method: "inviteUserByEmail", email, options });
            takeFailure();
            const existing = users.get(email);
            if (existing?.confirmed) throw new AuthAdminError("EMAIL_EXISTS", "exists");
            const authUserId = existing?.authUserId ?? crypto.randomUUID();
            users.set(email, { authUserId, confirmed: false });
            return { authUserId };
        },
        async createUser({ email, password }) {
            calls.push({ method: "createUser", email, hasPassword: typeof password === "string" });
            takeFailure();
            if (users.has(email)) throw new AuthAdminError("EMAIL_EXISTS", "exists");
            const authUserId = crypto.randomUUID();
            users.set(email, { authUserId, confirmed: true });
            return { authUserId };
        },
        async findUserByEmail(email) {
            calls.push({ method: "findUserByEmail", email });
            takeFailure();
            const found = users.get(email);
            return found ? { authUserId: found.authUserId, email } : null;
        },
        async deleteUser(authUserId) {
            calls.push({ method: "deleteUser", authUserId });
            for (const [email, value] of users) if (value.authUserId === authUserId) users.delete(email);
        },
    };
}

// The status a refused request gets: 401 without a valid Supabase session,
// 403 for a valid session whose application user is missing or not ACTIVE.
export const authFailureStatus = (token) => (typeof token === "string" && token.startsWith(PREFIX) ? 403 : 401);
