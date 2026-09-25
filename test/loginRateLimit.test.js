import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createAuthRouter } from "../src/routes/auth.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import {
    LOGIN_RATE_LIMIT_WINDOW_MS,
    LOGIN_RATE_LIMIT_MAX_FAILURES,
    LOGIN_RATE_LIMIT_MESSAGE,
} from "../src/middleware/loginRateLimiter.js";
import { hashPassword } from "../src/utils/password.js";
import { createFakeAdminDb } from "./helpers/fakeAdminDb.js";

// Synthetic account and secret only.
process.env.JWT_SECRET = "test-jwt-secret-placeholder";
const EMAIL = "admin@example.invalid";
const PASSWORD = "Correct-Horse-7";
const WRONG_PASSWORD = "wrong-password";
const PASSWORD_HASH = await hashPassword(PASSWORD);

// Every test gets a new app and therefore a new limiter with a clean count.
// It's the real default limiter (createAuthRouter's default), not a stub.
async function startApp() {
    const db = createFakeAdminDb([
        { adminId: "admin-1", name: "Test Admin", email: EMAIL, passwordHash: PASSWORD_HASH, role: "ADMIN", status: "ACTIVE" },
    ]);

    const app = express();
    app.use(express.json());
    app.use("/auth", createAuthRouter({ db }));
    app.get("/health", (req, res) => res.json({ status: "OK" }));
    app.use(errorHandler);

    const server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const login = async (password) => {
        const response = await fetch(`${baseUrl}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: EMAIL, password }),
        });
        return { status: response.status, headers: response.headers, text: await response.text() };
    };

    return { server, baseUrl, login };
}

let app;
let logs;
let realError;
let realWarn;

beforeEach(async () => {
    app = await startApp();
    // Record anything the limiter (or anything else) logs.
    logs = [];
    realError = console.error;
    realWarn = console.warn;
    console.error = (...args) => logs.push(args);
    console.warn = (...args) => logs.push(args);
});

afterEach(() => {
    console.error = realError;
    console.warn = realWarn;
    app.server.close();
});

async function failLogins(count) {
    const statuses = [];
    for (let i = 0; i < count; i++) {
        statuses.push((await app.login(WRONG_PASSWORD)).status);
    }
    return statuses;
}

describe("login rate limit configuration", () => {
    test("9. 5 failed attempts per 15-minute window", () => {
        assert.equal(LOGIN_RATE_LIMIT_MAX_FAILURES, 5);
        assert.equal(LOGIN_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000);
    });

    test("9b. the running limiter advertises the same policy in standard headers", async () => {
        const result = await app.login(WRONG_PASSWORD);
        const policy = result.headers.get("ratelimit-policy");

        assert.match(policy, /q=5\b/, `policy header: ${policy}`);
        assert.match(policy, /w=900\b/, `policy header: ${policy}`);
        assert.ok(result.headers.get("ratelimit"), "standard RateLimit header present");
        assert.equal(result.headers.get("x-ratelimit-limit"), null, "legacy X-RateLimit-* headers are off");
    });
});

describe("POST /auth/login is rate limited", () => {
    test("1. a normal login before any failures is not limited", async () => {
        const result = await app.login(PASSWORD);

        assert.equal(result.status, 200);
        assert.ok(JSON.parse(result.text).token);
    });

    test("3. exactly 5 failed attempts are allowed (each a normal 401)", async () => {
        assert.deepEqual(await failLogins(LOGIN_RATE_LIMIT_MAX_FAILURES), [401, 401, 401, 401, 401]);
    });

    test("2 + 4. the attempt after the 5th failure gets 429, and so do the next ones", async () => {
        await failLogins(LOGIN_RATE_LIMIT_MAX_FAILURES);

        assert.deepEqual(await failLogins(3), [429, 429, 429]);
    });

    test("once limited, even the correct password is refused until the window ends", async () => {
        await failLogins(LOGIN_RATE_LIMIT_MAX_FAILURES);
        const result = await app.login(PASSWORD);

        assert.equal(result.status, 429);
        assert.doesNotMatch(result.text, /eyJ/, "no token issued while limited");
    });

    test("successful logins don't count towards the limit", async () => {
        await failLogins(4);
        assert.equal((await app.login(PASSWORD)).status, 200);

        assert.deepEqual(await failLogins(2), [401, 429]); // 5th failure allowed, 6th limited
    });

    test("5. the 429 body is only the generic message", async () => {
        await failLogins(LOGIN_RATE_LIMIT_MAX_FAILURES);
        const result = await app.login(WRONG_PASSWORD);

        assert.equal(result.status, 429);
        assert.match(result.headers.get("content-type"), /application\/json/);
        assert.deepEqual(JSON.parse(result.text), { message: LOGIN_RATE_LIMIT_MESSAGE });
        assert.equal(LOGIN_RATE_LIMIT_MESSAGE, "Too many login attempts. Please try again later.");
    });

    test("6. the 429 response reveals no password, token, email, status or limiter internals", async () => {
        await failLogins(LOGIN_RATE_LIMIT_MAX_FAILURES);
        const { text } = await app.login(PASSWORD);

        for (const secret of [PASSWORD, EMAIL, "ACTIVE", "admin-1", "$2b$", "eyJ", "127.0.0.1", "windowMs", "remaining"]) {
            assert.ok(!text.includes(secret), `429 body leaks ${secret}`);
        }
    });

    test("nothing is logged while limiting (no emails, passwords or IPs)", async () => {
        await failLogins(LOGIN_RATE_LIMIT_MAX_FAILURES + 2);
        assert.deepEqual(logs, []);
    });
});

describe("other routes are not affected by the login limiter", () => {
    test("7. /auth/me keeps working after login is limited", async () => {
        const { text } = await app.login(PASSWORD);
        const { token } = JSON.parse(text);
        await failLogins(LOGIN_RATE_LIMIT_MAX_FAILURES + 1);

        for (let i = 0; i < 10; i++) {
            const bad = await fetch(`${app.baseUrl}/auth/me`, { headers: { Authorization: "Bearer not-a-jwt" } });
            assert.equal(bad.status, 401, "invalid tokens get 401, never 429");
        }

        const good = await fetch(`${app.baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(good.status, 200);
        assert.equal(good.headers.get("ratelimit-policy"), null, "no rate-limit headers on /auth/me");
    });

    test("8. /health is unaffected", async () => {
        await failLogins(LOGIN_RATE_LIMIT_MAX_FAILURES + 1);

        const response = await fetch(`${app.baseUrl}/health`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("ratelimit-policy"), null);
    });
});
