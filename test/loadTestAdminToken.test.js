// How the load tests obtain an ADMIN token (scripts/loadtest/adminToken.mjs). Fake fetch only:
// no network, no real project, synthetic keys.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { AdminTokenError, acquireAdminToken, keyRole } from "../scripts/loadtest/adminToken.mjs";

const jwt = (role) => `h.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.s`;
const ANON = jwt("anon");
const SERVICE = jwt("service_role");
const URL_ = "https://ref.supabase.co";

function fakeFetch(handlers) {
    const calls = [];
    const impl = async (url, init) => {
        const path = new URL(url).pathname;
        calls.push({ path, headers: init.headers, body: JSON.parse(init.body) });
        const { status = 200, body = {} } = handlers[path] ?? { status: 404 };
        return { status, json: async () => body };
    };
    impl.calls = calls;
    return impl;
}

describe("load-test ADMIN token", () => {
    test("key roles are read from the JWT claim only", () => {
        assert.equal(keyRole(ANON), "anon");
        assert.equal(keyRole(SERVICE), "service_role");
        assert.equal(keyRole("sb_secret_abc"), null);
        assert.equal(keyRole(undefined), null);
    });

    test("password sign-in uses the anon key (the .env.loadtest key when it is an anon key) and returns the token", async () => {
        const fetchImpl = fakeFetch({ "/auth/v1/token": { body: { access_token: "tok" } } });
        const result = await acquireAdminToken({ supabaseUrl: URL_, serviceKey: ANON, email: "a@example.invalid", password: "pw", fetchImpl });
        assert.deepEqual(result, { token: "tok", method: "password" });
        assert.equal(fetchImpl.calls[0].headers.apikey, ANON);
        assert.deepEqual(fetchImpl.calls[0].body, { email: "a@example.invalid", password: "pw" });
    });

    test("a refused password sign-in fails without echoing the password", async () => {
        const fetchImpl = fakeFetch({ "/auth/v1/token": { status: 400, body: { msg: "bad pw-secret" } } });
        await assert.rejects(
            acquireAdminToken({ supabaseUrl: URL_, serviceKey: ANON, email: "a@example.invalid", password: "pw-secret", fetchImpl }),
            (error) => error instanceof AdminTokenError && /HTTP 400/.test(error.message) && !/pw-secret/.test(error.message),
        );
    });

    test("a real service_role key mints a session through the admin API (no password)", async () => {
        const fetchImpl = fakeFetch({
            "/auth/v1/admin/generate_link": { body: { hashed_token: "hash" } },
            "/auth/v1/verify": { body: { access_token: "tok2" } },
        });
        const result = await acquireAdminToken({ supabaseUrl: URL_, serviceKey: SERVICE, email: "a@example.invalid", fetchImpl });
        assert.deepEqual(result, { token: "tok2", method: "service_role" });
        assert.deepEqual(fetchImpl.calls.map((c) => c.path), ["/auth/v1/admin/generate_link", "/auth/v1/verify"]);
        assert.equal(fetchImpl.calls[1].body.token_hash, "hash");
    });

    test("an anon key without a password is not enough, and the error says what to provide", async () => {
        await assert.rejects(
            acquireAdminToken({ supabaseUrl: URL_, serviceKey: ANON, email: "a@example.invalid", fetchImpl: fakeFetch({}) }),
            (error) => error instanceof AdminTokenError && /service_role key/.test(error.message) && /LOADTEST_ADMIN_PASSWORD/.test(error.message),
        );
    });

    test("password sign-in with no anon key available is refused up front", async () => {
        await assert.rejects(
            acquireAdminToken({ supabaseUrl: URL_, serviceKey: SERVICE, email: "a@example.invalid", password: "pw", fetchImpl: fakeFetch({}) }),
            /SUPABASE_ANON_KEY/,
        );
    });
});
