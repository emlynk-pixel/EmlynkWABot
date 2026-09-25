import { describe, test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";

import { createAuthRouter, ACTIVE_ADMIN_STATUS } from "../src/routes/auth.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { hashPassword } from "../src/utils/password.js";
import { createFakeAdminDb, noRateLimit } from "./helpers/fakeAdminDb.js";

// Synthetic accounts and secrets only.
process.env.JWT_SECRET = "test-jwt-secret-placeholder";
const PASSWORD = "Correct-Horse-7";
const WRONG_PASSWORD = "wrong-password";
const GENERIC_LOGIN_FAILURE = { message: "Invalid email or password" };

let server;
let baseUrl;
let db;

before(async () => {
    const passwordHash = await hashPassword(PASSWORD);
    db = createFakeAdminDb([
        { adminId: "admin-active", name: "Active Admin", email: "active@example.invalid", passwordHash, role: "ADMIN", status: ACTIVE_ADMIN_STATUS },
        { adminId: "admin-inactive", name: "Inactive Admin", email: "inactive@example.invalid", passwordHash, role: "ADMIN", status: "INACTIVE" },
        { adminId: "admin-disabled", name: "Disabled Admin", email: "disabled@example.invalid", passwordHash, role: "ADMIN", status: "DISABLED" },
    ]);

    const app = express();
    app.use(express.json());
    // Rate limiting has its own tests (loginRateLimit.test.js); here it would
    // block the many deliberate failures these login-logic tests make.
    app.use("/auth", createAuthRouter({ db, loginLimiter: noRateLimit }));
    app.use(errorHandler);

    await new Promise((resolve) => {
        server = app.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

// Nothing below should log account data; collect anything that is logged.
let logged;
let realConsoleError;
beforeEach(() => {
    logged = [];
    realConsoleError = console.error;
    console.error = (...args) => logged.push(args);
});
afterEach(() => {
    console.error = realConsoleError;
});

async function login(email, password) {
    const response = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
}

async function getProfile(token) {
    const response = await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
}

describe("POST /auth/login", () => {
    test("1. ACTIVE admin + correct password -> 200 with a JWT", async () => {
        const result = await login("active@example.invalid", PASSWORD);

        assert.equal(result.status, 200);
        assert.equal(result.body.message, "Login successful");
        const payload = jwt.verify(result.body.token, process.env.JWT_SECRET);
        assert.equal(payload.adminId, "admin-active");
        assert.ok(payload.exp - payload.iat === 3600, "token expires after 1 hour");
    });

    test("the response and token never contain the password or its hash", async () => {
        const result = await login("active@example.invalid", PASSWORD);
        const payload = jwt.decode(result.body.token);

        assert.ok(!result.text.includes(PASSWORD));
        assert.ok(!result.text.includes("$2b$"), "no bcrypt hash in the response");
        assert.equal(payload.passwordHash, undefined);
    });

    test("2. ACTIVE admin + wrong password -> 401 generic", async () => {
        const result = await login("active@example.invalid", WRONG_PASSWORD);

        assert.equal(result.status, 401);
        assert.deepEqual(result.body, GENERIC_LOGIN_FAILURE);
    });

    test("3. unknown email -> 401, same generic message", async () => {
        const result = await login("nobody@example.invalid", PASSWORD);

        assert.equal(result.status, 401);
        assert.deepEqual(result.body, GENERIC_LOGIN_FAILURE);
    });

    test("4. INACTIVE admin + correct password -> 401, same generic message", async () => {
        const result = await login("inactive@example.invalid", PASSWORD);

        assert.equal(result.status, 401);
        assert.deepEqual(result.body, GENERIC_LOGIN_FAILURE);
    });

    test("5. INACTIVE admin + wrong password -> 401, same generic message", async () => {
        const result = await login("inactive@example.invalid", WRONG_PASSWORD);

        assert.equal(result.status, 401);
        assert.deepEqual(result.body, GENERIC_LOGIN_FAILURE);
    });

    test("any status other than ACTIVE is refused (e.g. DISABLED)", async () => {
        const result = await login("disabled@example.invalid", PASSWORD);

        assert.equal(result.status, 401);
        assert.deepEqual(result.body, GENERIC_LOGIN_FAILURE);
    });

    test("6. no token is returned for an inactive admin", async () => {
        const result = await login("inactive@example.invalid", PASSWORD);

        assert.equal(result.body.token, undefined);
        assert.doesNotMatch(result.text, /eyJ/, "no JWT anywhere in the response");
    });

    test("7. failures are indistinguishable and never reveal status or existence", async () => {
        const failures = await Promise.all([
            login("active@example.invalid", WRONG_PASSWORD),
            login("nobody@example.invalid", PASSWORD),
            login("inactive@example.invalid", PASSWORD),
            login("inactive@example.invalid", WRONG_PASSWORD),
            login("disabled@example.invalid", PASSWORD),
        ]);

        const texts = new Set(failures.map((f) => `${f.status} ${f.text}`));
        assert.equal(texts.size, 1, "every failure must look exactly the same");

        for (const { text } of failures) {
            assert.doesNotMatch(text, /inactive|disabled|status|active|exist|not found/i);
        }
    });

    test("failed logins log nothing (no emails, passwords or hashes)", async () => {
        await login("inactive@example.invalid", PASSWORD);
        await login("active@example.invalid", WRONG_PASSWORD);

        assert.equal(logged.length, 0);
    });

    test("missing fields still get the existing 400", async () => {
        const response = await fetch(`${baseUrl}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "active@example.invalid" }),
        });
        assert.equal(response.status, 400);
    });
});

describe("GET /auth/me", () => {
    test("8. ACTIVE admin token -> profile, without the password hash", async () => {
        const { body: { token } } = await login("active@example.invalid", PASSWORD);
        const result = await getProfile(token);

        assert.equal(result.status, 200);
        assert.equal(result.body.admin.adminId, "admin-active");
        assert.equal(result.body.admin.passwordHash, undefined);
        assert.ok(!result.text.includes("$2b$"));
    });

    test("9. admin deactivated after the token was issued -> 401, status not revealed", async () => {
        const { body: { token } } = await login("active@example.invalid", PASSWORD);
        const row = db.rows.find((r) => r.adminId === "admin-active");

        row.status = "INACTIVE";
        try {
            const result = await getProfile(token);

            assert.equal(result.status, 401);
            assert.deepEqual(result.body, { message: "Invalid or Expired Token" });
            assert.doesNotMatch(result.text, /inactive|status/i);
        } finally {
            row.status = ACTIVE_ADMIN_STATUS;
        }
    });

    test("reactivated admin can use the same (unexpired) token again", async () => {
        const { body: { token } } = await login("active@example.invalid", PASSWORD);
        const result = await getProfile(token);

        assert.equal(result.status, 200);
    });

    test("missing or invalid token -> 401 (unchanged)", async () => {
        const missing = await fetch(`${baseUrl}/auth/me`);
        assert.equal(missing.status, 401);

        const invalid = await getProfile("not-a-jwt");
        assert.equal(invalid.status, 401);
    });
});
