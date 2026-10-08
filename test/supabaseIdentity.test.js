// Supabase token verification (src/auth/supabaseIdentity.js) and the Auth
// Admin wrapper (src/auth/supabaseAuthAdmin.js), against stand-ins for the
// Supabase client: nothing here contacts Supabase.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { bearerToken, createAccessTokenVerifier, looksLikeAccessToken } from "../src/auth/supabaseIdentity.js";
import { AuthAdminError, createSupabaseAuthAdmin } from "../src/auth/supabaseAuthAdmin.js";

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
const USER_ID = "7d0c2f0e-1111-4222-8333-444455556666";

function fakeClient(answer) {
    const calls = [];
    return {
        calls,
        auth: {
            async getUser(token) {
                calls.push(token);
                return typeof answer === "function" ? answer(token) : answer;
            },
        },
    };
}

describe("bearerToken", () => {
    test("reads only Authorization: Bearer <token>", () => {
        assert.equal(bearerToken({ headers: { authorization: `Bearer ${TOKEN}` } }), TOKEN);
        assert.equal(bearerToken({ headers: { authorization: TOKEN } }), null);
        assert.equal(bearerToken({ headers: { authorization: "Basic abc" } }), null);
        assert.equal(bearerToken({ headers: { authorization: "Bearer   " } }), null);
        assert.equal(bearerToken({ headers: {} }), null);
    });

    test("a cookie is never a credential", () => {
        assert.equal(bearerToken({ headers: { cookie: `emlynk_admin_token=${TOKEN}` }, cookies: { emlynk_admin_token: TOKEN } }), null);
    });
});

describe("createAccessTokenVerifier", () => {
    test("a current session -> the Supabase user ID and email; never a role", async () => {
        const client = fakeClient({ data: { user: { id: USER_ID, email: "Person@Example.invalid", app_metadata: { role: "ADMIN" }, user_metadata: { role: "ADMIN" } } }, error: null });
        const identity = await createAccessTokenVerifier({ client })(TOKEN);
        assert.deepEqual(identity, { authUserId: USER_ID, email: "person@example.invalid" });
        assert.deepEqual(client.calls, [TOKEN], "verified by Supabase itself");
    });

    test("expired, forged or signed-out sessions -> null", async () => {
        for (const error of [{ status: 401, name: "AuthApiError" }, { status: 403, name: "AuthApiError", code: "session_not_found" }, { status: 400 }, { status: 404 }, { name: "AuthSessionMissingError" }]) {
            const verify = createAccessTokenVerifier({ client: fakeClient({ data: { user: null }, error }) });
            assert.equal(await verify(TOKEN), null, JSON.stringify(error));
        }
        assert.equal(await createAccessTokenVerifier({ client: fakeClient({ data: { user: null }, error: null }) })(TOKEN), null);
    });

    test("anything not shaped like a token is refused without asking Supabase", async () => {
        const client = fakeClient(() => assert.fail("must not be called"));
        const verify = createAccessTokenVerifier({ client });
        for (const token of ["", "not-a-jwt", "a.b", "a.b.c.d", `${"a".repeat(9000)}.b.c`, null, 42]) {
            assert.equal(await verify(token), null);
        }
        assert.equal(looksLikeAccessToken(TOKEN), true);
    });

    test("Supabase unreachable or failing -> throws (fails closed, never anonymous or authenticated)", async () => {
        const verify = createAccessTokenVerifier({ client: fakeClient({ data: { user: null }, error: { status: 500, message: `upstream failure for ${TOKEN}` } }) });
        await assert.rejects(verify(TOKEN), (error) => error.name === "AuthVerificationError" && !error.message.includes(TOKEN));
        const network = createAccessTokenVerifier({ client: fakeClient(() => Promise.reject(new TypeError("fetch failed"))) });
        await assert.rejects(network(TOKEN), /fetch failed/);
    });
});

describe("createSupabaseAuthAdmin", () => {
    function fakeAdminClient(handlers) {
        const calls = [];
        const admin = new Proxy({}, {
            get: (target, method) => async (...args) => {
                calls.push({ method, args });
                return handlers[method]?.(...args) ?? { data: null, error: { status: 500 } };
            },
        });
        return { calls, client: { auth: { admin } } };
    }

    test("invite: email and redirect only; no role or metadata is sent to Supabase", async () => {
        const { calls, client } = fakeAdminClient({ inviteUserByEmail: () => ({ data: { user: { id: USER_ID } }, error: null }) });
        const result = await createSupabaseAuthAdmin({ client }).inviteUserByEmail("a@example.invalid", { redirectTo: "https://app.example/admin/setup-password" });
        assert.deepEqual(result, { authUserId: USER_ID });
        assert.deepEqual(calls[0].args, ["a@example.invalid", { redirectTo: "https://app.example/admin/setup-password" }]);
    });

    test("Supabase errors are mapped to codes; messages never carry the email or password", async () => {
        const cases = [
            [{ code: "email_exists", status: 422 }, "EMAIL_EXISTS"],
            [{ status: 422, message: "A user with this email address has already been registered" }, "EMAIL_EXISTS"],
            [{ code: "weak_password", status: 422 }, "WEAK_PASSWORD"],
            [{ code: "over_email_send_rate_limit", status: 429 }, "RATE_LIMITED"],
            [{ status: 500, message: "boom a@example.invalid" }, "FAILED"],
        ];
        for (const [error, code] of cases) {
            const { client } = fakeAdminClient({ createUser: () => ({ data: null, error }) });
            await assert.rejects(
                createSupabaseAuthAdmin({ client }).createUser({ email: "a@example.invalid", password: "Secret-Password-1" }),
                (thrown) => thrown instanceof AuthAdminError && thrown.code === code && !/a@example|Secret-Password/.test(thrown.message)
            );
        }
    });

    test("createUser confirms the email (no confirmation mail for a bootstrap account)", async () => {
        const { calls, client } = fakeAdminClient({ createUser: () => ({ data: { user: { id: USER_ID } }, error: null }) });
        await createSupabaseAuthAdmin({ client }).createUser({ email: "a@example.invalid", password: "Secret-Password-1" });
        assert.deepEqual(calls[0].args[0], { email: "a@example.invalid", password: "Secret-Password-1", email_confirm: true });
    });

    test("findUserByEmail pages through users, case-insensitively, and stops at the last page", async () => {
        const page = (n, count) => Array.from({ length: count }, (_, i) => ({ id: `id-${n}-${i}`, email: `user${n}-${i}@example.invalid` }));
        const { calls, client } = fakeAdminClient({
            listUsers: ({ page: n }) => ({ data: { users: n === 1 ? page(1, 200) : [{ id: USER_ID, email: "Target@Example.invalid" }] }, error: null }),
        });
        const authAdmin = createSupabaseAuthAdmin({ client });
        assert.deepEqual(await authAdmin.findUserByEmail("target@example.invalid"), { authUserId: USER_ID, email: "target@example.invalid" });
        assert.equal(calls.length, 2);
        assert.equal(await authAdmin.findUserByEmail("nobody@example.invalid"), null);
    });

    test("requires the service-role client's admin API", () => {
        assert.throws(() => createSupabaseAuthAdmin({ client: { auth: {} } }), /service-role/);
    });
});
