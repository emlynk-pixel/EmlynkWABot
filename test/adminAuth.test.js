// Authentication: a Supabase session (Authorization: Bearer <access token>)
// is the only credential. The backend verifies it with Supabase, then loads
// the application user by auth_user_id on every request. Sign-in itself is
// Supabase's (admin frontend); here Supabase is a stand-in
// (test/helpers/fakeSupabaseAuth.js).
import { describe, test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createAuthRouter } from "../src/routes/auth.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { createFakeAdminDb, noRateLimit } from "./helpers/fakeAdminDb.js";
import { authIdFor, createFakeVerifier, tokenFor, tokenForAuthId } from "./helpers/fakeSupabaseAuth.js";

const ACCOUNT_NOT_ACTIVE = { message: "Your account is not active. Contact an administrator.", code: "ACCOUNT_NOT_ACTIVE" };

let server;
let baseUrl;
let db;
let verifyAccessToken;
let verifierFailure = null;

before(async () => {
    db = createFakeAdminDb([
        { adminId: "user-active", name: "Active User", email: "active@example.invalid", role: "MANAGER", status: "ACTIVE" },
        { adminId: "user-inactive", name: "Inactive User", email: "inactive@example.invalid", role: "ADMIN", status: "INACTIVE" },
        { adminId: "user-invited", name: "Invited User", email: "invited@example.invalid", role: "ANALYST", status: "INVITED" },
        { adminId: "user-signout", name: "Signing Out", email: "signout@example.invalid", role: "ANALYST", status: "ACTIVE" },
    ]);
    const fake = createFakeVerifier();
    verifyAccessToken = async (token) => {
        if (verifierFailure) throw verifierFailure;
        return fake(token);
    };
    verifyAccessToken.revoke = fake.revoke;

    const app = express();
    app.use(express.json());
    app.use("/auth", createAuthRouter({ db, verifyAccessToken, apiLimiter: noRateLimit }));
    app.use(errorHandler);
    await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const me = async (token) => {
    const response = await fetch(`${baseUrl}/auth/me`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: response.status, headers: response.headers, text: await response.text() };
};

describe("GET /auth/me (Supabase session -> application user)", () => {
    let logged;
    let originalError;
    beforeEach(() => {
        logged = [];
        originalError = console.error;
        console.error = (...args) => logged.push(args);
    });
    afterEach(() => {
        console.error = originalError;
        verifierFailure = null;
    });

    test("valid session of an ACTIVE user -> the minimal profile; role from the database", async () => {
        const result = await me(tokenFor("user-active"));
        assert.equal(result.status, 200);
        assert.deepEqual(JSON.parse(result.text), { user: { userId: "user-active", email: "active@example.invalid", name: "Active User", role: "MANAGER", status: "ACTIVE" } });
        assert.equal(result.headers.get("cache-control"), "no-store");
        assert.doesNotMatch(result.text, /authUserId|password|token|secret/i, "no identity link, credential or token in the response");
    });

    test("missing session -> 401", async () => {
        const result = await me(null);
        assert.equal(result.status, 401);
        assert.deepEqual(JSON.parse(result.text), { message: "Authentication Token is required!" });
    });

    test("invalid, expired or forged token -> 401", async () => {
        for (const token of ["not-a-token", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiQURNSU4ifQ.forged", tokenForAuthId("unknown")]) {
            const result = await me(token);
            if (token.startsWith("test-access-token:")) continue; // valid session, no user: covered below
            assert.equal(result.status, 401, token);
            assert.deepEqual(JSON.parse(result.text), { message: "Invalid or Expired Token" });
        }
    });

    test("signed out (session revoked in Supabase) -> 401 on the very next request", async () => {
        const token = tokenFor("user-signout");
        assert.equal((await me(token)).status, 200);
        verifyAccessToken.revoke(token);
        assert.equal((await me(token)).status, 401);
    });

    test("valid session, no public.user row -> 403 (fails closed)", async () => {
        const result = await me(tokenForAuthId(authIdFor("someone-never-invited")));
        assert.equal(result.status, 403);
        assert.deepEqual(JSON.parse(result.text), ACCOUNT_NOT_ACTIVE);
    });

    test("INACTIVE and INVITED (setup not completed) users -> 403", async () => {
        for (const id of ["user-inactive", "user-invited"]) {
            const result = await me(tokenFor(id));
            assert.equal(result.status, 403, id);
            assert.deepEqual(JSON.parse(result.text), ACCOUNT_NOT_ACTIVE);
        }
    });

    test("deactivation and role changes apply to the next request (no stale token claims)", async () => {
        const row = db.rows.find((r) => r.adminId === "user-active");
        row.role = "ANALYST";
        assert.equal(JSON.parse((await me(tokenFor("user-active"))).text).user.role, "ANALYST");
        row.status = "INACTIVE";
        assert.equal((await me(tokenFor("user-active"))).status, 403);
        Object.assign(row, { role: "MANAGER", status: "ACTIVE" });
    });

    test("the identity comes only from the verified token, never the request", async () => {
        const response = await fetch(`${baseUrl}/auth/me?authUserId=${authIdFor("user-active")}`, {
            headers: { "X-Auth-User-Id": authIdFor("user-active"), "Content-Type": "application/json" },
        });
        assert.equal(response.status, 401);
    });

    test("Supabase unreachable -> generic 500; the token is never logged", async () => {
        verifierFailure = Object.assign(new Error("Supabase token verification failed"), { name: "AuthVerificationError" });
        const token = tokenFor("user-active");
        const result = await me(token);
        assert.equal(result.status, 500);
        assert.deepEqual(JSON.parse(result.text), { message: "Internal server error" });
        assert.ok(!JSON.stringify(logged).includes(token), "access token never logged");
    });

    test("database failure while loading the user -> generic 500, no details", async () => {
        const original = db.user.findUnique;
        db.user.findUnique = async () => { throw Object.assign(new Error("The table `public.user` does not exist"), { code: "P2021", meta: { table: "public.user" } }); };
        try {
            const result = await me(tokenFor("user-active"));
            assert.equal(result.status, 500);
            assert.ok(!result.text.includes("does not exist"));
        } finally {
            db.user.findUnique = original;
        }
    });
});

describe("POST /auth/complete-invite authentication", () => {
    test("needs a valid Supabase session", async () => {
        for (const headers of [{}, { Authorization: "Bearer not-a-token" }]) {
            const response = await fetch(`${baseUrl}/auth/complete-invite`, { method: "POST", headers });
            assert.equal(response.status, 401);
        }
    });
});
