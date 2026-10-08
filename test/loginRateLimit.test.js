// Rate limiting after the Supabase Auth cutover. Sign-in, password recovery
// and invitation emails are Supabase Auth's, which applies its own per-IP and
// per-email limits (configured in the Supabase project); the backend has no
// login endpoint left to limit. The application's own session endpoints
// (/auth/me, /auth/complete-invite) stay behind the shared API limiter.
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { MemoryStore } from "express-rate-limit";

import { createAuthRouter } from "../src/routes/auth.js";
import { createApiRateLimiter, API_RATE_LIMIT_MESSAGE } from "../src/middleware/apiRateLimiter.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { createFakeAdminDb } from "./helpers/fakeAdminDb.js";
import { createFakeVerifier, tokenFor } from "./helpers/fakeSupabaseAuth.js";

let server;
let baseUrl;
let verifyAccessToken;

beforeEach(async () => {
    const db = createFakeAdminDb([{ adminId: "u1", name: "U", email: "u@example.invalid", role: "ADMIN", status: "ACTIVE" }]);
    verifyAccessToken = createFakeVerifier();
    const app = express();
    app.use(express.json());
    app.use("/auth", createAuthRouter({ db, verifyAccessToken, apiLimiter: createApiRateLimiter({ limit: 3, store: new MemoryStore() }) }));
    app.use((req, res) => res.status(404).json({ message: "Not found" }));
    app.use(errorHandler);
    await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => server?.close());

const me = (token) => fetch(`${baseUrl}/auth/me`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

describe("session endpoints are rate limited", () => {
    test("GET /auth/me: the limit applies before any Supabase verification", async () => {
        for (let i = 0; i < 3; i++) assert.equal((await me("forged.token.value")).status, 401);
        const limited = await me(tokenFor("u1"));
        assert.equal(limited.status, 429);
        assert.deepEqual(await limited.json(), { message: API_RATE_LIMIT_MESSAGE });
        assert.equal(verifyAccessToken.calls.length, 3, "the limited request never reached Supabase");
    });

    test("POST /auth/complete-invite is limited too", async () => {
        for (let i = 0; i < 3; i++) await fetch(`${baseUrl}/auth/complete-invite`, { method: "POST" });
        assert.equal((await fetch(`${baseUrl}/auth/complete-invite`, { method: "POST" })).status, 429);
    });

    test("the 429 reveals no token, email or limiter internals", async () => {
        for (let i = 0; i < 3; i++) await me(tokenFor("u1"));
        const text = await (await me(tokenFor("u1"))).text();
        assert.doesNotMatch(text, /u@example|test-access-token|generic-api|store/);
    });
});

describe("no backend login endpoint remains", () => {
    test("POST /auth/login -> 404 (sign-in is Supabase's)", async () => {
        const response = await fetch(`${baseUrl}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "u@example.invalid", password: "x" }) });
        assert.equal(response.status, 404);
    });
});
