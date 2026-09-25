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

describe("POST /auth/login: input validation (SEC-013)", () => {
    const postRaw = async (body, contentType = "application/json") => {
        const response = await fetch(`${baseUrl}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": contentType },
            body,
        });
        const text = await response.text();
        return { status: response.status, text };
    };

    test("non-string email or password -> 400, never reaches the database", async () => {
        const bodies = [
            { email: { $ne: null }, password: PASSWORD },
            { email: ["active@example.invalid"], password: PASSWORD },
            { email: "active@example.invalid", password: { $gt: "" } },
            { email: 12345, password: PASSWORD },
            { email: "active@example.invalid", password: true },
        ];
        for (const body of bodies) {
            const result = await postRaw(JSON.stringify(body));
            assert.equal(result.status, 400, JSON.stringify(body));
            assert.deepEqual(JSON.parse(result.text), { message: "Invalid login request" });
        }
    });

    test("over-long email or password -> 400, input not echoed", async () => {
        const longEmail = `${"a".repeat(260)}@example.invalid`;
        const longPassword = "p".repeat(10_000);

        for (const body of [{ email: longEmail, password: PASSWORD }, { email: "active@example.invalid", password: longPassword }]) {
            const result = await postRaw(JSON.stringify(body));
            assert.equal(result.status, 400);
            assert.ok(!result.text.includes("aaaa") && !result.text.includes("pppp"));
        }
    });

    test("the longest allowed values are still accepted for checking", async () => {
        const result = await login("active@example.invalid", "p".repeat(128));
        assert.equal(result.status, 401);
    });

    test("empty strings and a body that isn't JSON -> 400", async () => {
        assert.equal((await postRaw(JSON.stringify({ email: "", password: "" }))).status, 400);
        assert.equal((await postRaw("email=a&password=b", "text/plain")).status, 400);
    });

    test("the password is never echoed in any response", async () => {
        const secret = "Unique-Secret-4821";
        for (const email of ["active@example.invalid", "nobody@example.invalid"]) {
            const result = await login(email, secret);
            assert.ok(!result.text.includes(secret));
            assert.ok(!result.text.includes(email));
        }
    });
});

describe("POST /auth/login: timing (SEC-012)", () => {
    const timeLogin = async (email, password) => {
        const start = process.hrtime.bigint();
        await login(email, password);
        return Number(process.hrtime.bigint() - start) / 1e6;
    };
    const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];

    test("an unknown email takes about as long as a wrong password (a bcrypt comparison runs)", async () => {
        await timeLogin("nobody@example.invalid", WRONG_PASSWORD); // creates the dummy hash once

        const unknown = [];
        const wrong = [];
        for (let i = 0; i < 5; i++) {
            unknown.push(await timeLogin("nobody@example.invalid", WRONG_PASSWORD));
            wrong.push(await timeLogin("active@example.invalid", WRONG_PASSWORD));
        }

        // Without the dummy comparison an unknown email returns in ~1 ms while
        // bcrypt takes tens of ms; with it both are bcrypt-bound.
        const ratio = median(unknown) / median(wrong);
        assert.ok(ratio > 0.5, `unknown-email login is too fast (ratio ${ratio.toFixed(2)})`);
    });

    test("an admin without a password hash is refused like any other failure", async () => {
        db.rows.push({ adminId: "admin-nohash", name: "No Hash", email: "nohash@example.invalid", passwordHash: null, role: "ADMIN", status: ACTIVE_ADMIN_STATUS });
        try {
            const result = await login("nohash@example.invalid", PASSWORD);
            assert.equal(result.status, 401);
            assert.deepEqual(result.body, GENERIC_LOGIN_FAILURE);
        } finally {
            db.rows.pop();
        }
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

describe("POST /auth/login: email case", () => {
    test("the email is matched case-insensitively (stored lowercased)", async () => {
        const result = await login("  Active@Example.INVALID ", PASSWORD);
        assert.equal(result.status, 200);
    });
});

describe("admin token checks (SEC-022)", () => {
    const payload = { adminId: "admin-active", email: "active@example.invalid", role: "ADMIN" };
    const base64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

    test("login tokens are HS256 and expire after one hour", async () => {
        const { body } = await login("active@example.invalid", PASSWORD);
        const decoded = jwt.decode(body.token, { complete: true });
        assert.equal(decoded.header.alg, "HS256");
        assert.equal(decoded.payload.exp - decoded.payload.iat, 3600);
    });

    test("expired token -> 401", async () => {
        const token = jwt.sign({ ...payload, exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET);
        assert.equal((await getProfile(token)).status, 401);
    });

    test("unsigned (alg: none) token -> 401", async () => {
        const token = `${base64url({ alg: "none", typ: "JWT" })}.${base64url(payload)}.`;
        assert.equal((await getProfile(token)).status, 401);
    });

    test("token signed with another secret or another algorithm -> 401", async () => {
        assert.equal((await getProfile(jwt.sign(payload, "some-other-secret-value-0123456789"))).status, 401);
        assert.equal((await getProfile(jwt.sign(payload, process.env.JWT_SECRET, { algorithm: "HS512" }))).status, 401);
    });

    test("payload changed after signing -> 401", async () => {
        const [header, , signature] = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "1h" }).split(".");
        const forged = `${header}.${base64url({ ...payload, adminId: "admin-other" })}.${signature}`;
        assert.equal((await getProfile(forged)).status, 401);
    });

    test("malformed Authorization headers -> 401", async () => {
        const valid = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "1h" });
        for (const header of [valid, `Basic ${valid}`, `bearer ${valid}`, "Bearer", "Bearer ", `Token ${valid}`]) {
            const response = await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: header } });
            assert.equal(response.status, 401, header.slice(0, 12));
        }
    });

    test("token responses never say why a token was refused", async () => {
        const expired = jwt.sign({ ...payload, exp: 1 }, process.env.JWT_SECRET);
        const bad = await getProfile(expired);
        assert.deepEqual(bad.body, { message: "Invalid or Expired Token" });
        assert.doesNotMatch(bad.text, /jwt|expired at|signature|malformed/i);
    });
});
