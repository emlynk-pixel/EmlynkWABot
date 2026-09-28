import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";

import { createAuthRouter, ACTIVE_ADMIN_STATUS } from "../src/routes/auth.js";
import { hashPassword, comparePassword } from "../src/utils/password.js";
import { createFakeAdminDb, noRateLimit } from "./helpers/fakeAdminDb.js";
import { clearSentEmails, getLastSentEmail, getSentEmails } from "../src/services/emailService.js";
import { hashResetToken } from "../src/services/passwordResetService.js";
import { createResetRateLimiter } from "../src/middleware/loginRateLimiter.js";

process.env.JWT_SECRET = "test-jwt-secret-placeholder-for-password-resets-987654";
const INITIAL_PASSWORD = "InitialPassword123!";
const NEW_PASSWORD = "NewBrandPassword2026!";

let server;
let baseUrl;
let db;

before(async () => {
    const passwordHash = await hashPassword(INITIAL_PASSWORD);
    const admins = [
        {
            adminId: "admin-active",
            name: "Active Admin",
            email: "active@example.invalid",
            passwordHash,
            role: "ADMIN",
            status: ACTIVE_ADMIN_STATUS,
        },
        {
            adminId: "admin-inactive",
            name: "Inactive Admin",
            email: "inactive@example.invalid",
            passwordHash,
            role: "REVIEWER",
            status: "INACTIVE",
        },
        {
            adminId: "admin-disabled",
            name: "Disabled Admin",
            email: "disabled@example.invalid",
            passwordHash,
            role: "VIEWER",
            status: "DISABLED",
        },
    ];

    db = createFakeAdminDb(admins);

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    // Attach router with bypass rate limiting for general functional tests
    app.use("/auth", createAuthRouter({ db, loginLimiter: noRateLimit, resetLimiter: noRateLimit }));

    await new Promise((resolve) => {
        server = app.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
    clearSentEmails();
});

describe("POST /auth/forgot-password", () => {
    test("forgot-password existing account generates token, hashes it, sends email, and returns generic response", async () => {
        const response = await fetch(`${baseUrl}/auth/forgot-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "active@example.invalid" }),
        });

        assert.equal(response.status, 200);
        const data = await response.json();
        assert.equal(data.message, "If the account exists, a password reset link has been sent.");
        // Raw token must never be present in the response
        assert.equal(data.token, undefined);

        // Verify email was dispatched
        const sentEmail = getLastSentEmail();
        assert.ok(sentEmail, "Email should be dispatched");
        assert.equal(sentEmail.to, "active@example.invalid");
        assert.ok(sentEmail.text.includes("Reset your Emlynk Admin password") || sentEmail.subject.includes("Reset your Emlynk Admin password"));
        assert.ok(sentEmail.resetUrl, "Reset URL must be included in email");

        // Verify database contains ONLY the SHA-256 hash
        const urlObj = new URL(sentEmail.resetUrl);
        const rawToken = urlObj.searchParams.get("token");
        assert.ok(rawToken, "Raw token must be query parameter in reset link");

        const computedHash = hashResetToken(rawToken);
        const storedReset = db.passwordResetRows.find((r) => r.tokenHash === computedHash);
        assert.ok(storedReset, "A password reset record matching the SHA-256 hash must exist in DB");
        assert.equal(storedReset.adminId, "admin-active");
        assert.equal(storedReset.usedAt, null);
        assert.ok(storedReset.expiresAt > new Date());
    });

    test("forgot-password unknown email returns the same generic response and sends no email", async () => {
        const response = await fetch(`${baseUrl}/auth/forgot-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "nonexistent@example.invalid" }),
        });

        assert.equal(response.status, 200);
        const data = await response.json();
        assert.equal(data.message, "If the account exists, a password reset link has been sent.");

        // No email sent
        assert.equal(getSentEmails().length, 0);
    });

    test("forgot-password for deactivated or disabled account returns generic response and sends no email", async () => {
        const responseInactive = await fetch(`${baseUrl}/auth/forgot-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "inactive@example.invalid" }),
        });
        assert.equal(responseInactive.status, 200);
        assert.equal((await responseInactive.json()).message, "If the account exists, a password reset link has been sent.");
        assert.equal(getSentEmails().length, 0);

        const responseDisabled = await fetch(`${baseUrl}/auth/forgot-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "disabled@example.invalid" }),
        });
        assert.equal(responseDisabled.status, 200);
        assert.equal((await responseDisabled.json()).message, "If the account exists, a password reset link has been sent.");
        assert.equal(getSentEmails().length, 0);
    });

    test("forgot-password missing email returns 400", async () => {
        const response = await fetch(`${baseUrl}/auth/forgot-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
        assert.equal(response.status, 400);
        const data = await response.json();
        assert.equal(data.message, "Email is required");
    });
});

describe("GET /auth/reset-password", () => {
    test("validates token successfully without consuming it", async () => {
        // Request a reset
        await fetch(`${baseUrl}/auth/forgot-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "active@example.invalid" }),
        });

        const sentEmail = getLastSentEmail();
        const rawToken = new URL(sentEmail.resetUrl).searchParams.get("token");

        const response = await fetch(`${baseUrl}/auth/reset-password?token=${encodeURIComponent(rawToken)}`);
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.equal(data.valid, true);

        // Confirm token is not consumed yet
        const computedHash = hashResetToken(rawToken);
        const record = db.passwordResetRows.find((r) => r.tokenHash === computedHash);
        assert.equal(record.usedAt, null);
    });

    test("missing token returns 400", async () => {
        const response = await fetch(`${baseUrl}/auth/reset-password`);
        assert.equal(response.status, 400);
        const data = await response.json();
        assert.equal(data.message, "Reset token is required");
    });

    test("invalid token returns 400 INVALID_TOKEN", async () => {
        const response = await fetch(`${baseUrl}/auth/reset-password?token=invalid-hex-token-12345`);
        assert.equal(response.status, 400);
        const data = await response.json();
        assert.equal(data.code, "INVALID_TOKEN");
    });

    test("expired token returns 400 EXPIRED", async () => {
        // Create an expired record
        const expiredToken = "expired-token-" + Math.random().toString(36).slice(2);
        const tokenHash = hashResetToken(expiredToken);
        await db.adminPasswordReset.create({
            data: {
                resetId: "expired-reset-id",
                adminId: "admin-active",
                tokenHash,
                expiresAt: new Date(Date.now() - 1000 * 60), // expired 1 min ago
            },
        });

        const response = await fetch(`${baseUrl}/auth/reset-password?token=${encodeURIComponent(expiredToken)}`);
        assert.equal(response.status, 400);
        const data = await response.json();
        assert.equal(data.code, "EXPIRED");
    });

    test("already used token returns 400 ALREADY_USED", async () => {
        const usedToken = "used-token-" + Math.random().toString(36).slice(2);
        const tokenHash = hashResetToken(usedToken);
        await db.adminPasswordReset.create({
            data: {
                resetId: "used-reset-id",
                adminId: "admin-active",
                tokenHash,
                expiresAt: new Date(Date.now() + 1000 * 60 * 60),
                usedAt: new Date(),
            },
        });

        const response = await fetch(`${baseUrl}/auth/reset-password?token=${encodeURIComponent(usedToken)}`);
        assert.equal(response.status, 400);
        const data = await response.json();
        assert.equal(data.code, "ALREADY_USED");
    });
});

describe("POST /auth/reset-password", () => {
    test("successfully resets password, updates DB, marks token used, writes audit log, and allows sign in", async () => {
        // 1. Request reset
        await fetch(`${baseUrl}/auth/forgot-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "active@example.invalid" }),
        });

        const sentEmail = getLastSentEmail();
        const rawToken = new URL(sentEmail.resetUrl).searchParams.get("token");

        // 2. Submit new password
        const resetResponse = await fetch(`${baseUrl}/auth/reset-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                token: rawToken,
                password: NEW_PASSWORD,
            }),
        });

        assert.equal(resetResponse.status, 200);
        const resetData = await resetResponse.json();
        assert.ok(resetData.message.includes("Password reset successful"));

        // 3. Verify token is marked as used
        const computedHash = hashResetToken(rawToken);
        const record = db.passwordResetRows.find((r) => r.tokenHash === computedHash);
        assert.ok(record.usedAt !== null, "usedAt must be set");

        // 4. Verify admin password hash is updated with bcrypt
        const admin = db.rows.find((a) => a.adminId === "admin-active");
        const passwordMatches = await comparePassword(NEW_PASSWORD, admin.passwordHash);
        assert.ok(passwordMatches, "New password must match stored bcrypt hash");

        // 5. Verify audit log entry
        const audit = db.auditLogRows.find((r) => r.action === "RESET_PASSWORD" && r.adminId === "admin-active");
        assert.ok(audit, "Audit log entry must be created");
        assert.equal(audit.previousStatus, ACTIVE_ADMIN_STATUS);
        assert.equal(audit.newStatus, ACTIVE_ADMIN_STATUS);

        // 6. Verify admin can sign in with new password
        const loginResponse = await fetch(`${baseUrl}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                email: "active@example.invalid",
                password: NEW_PASSWORD,
            }),
        });
        assert.equal(loginResponse.status, 200);
        const loginData = await loginResponse.json();
        assert.equal(loginData.message, "Login successful");

        // 7. Verify old password no longer works
        const oldLoginResponse = await fetch(`${baseUrl}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                email: "active@example.invalid",
                password: INITIAL_PASSWORD,
            }),
        });
        assert.equal(oldLoginResponse.status, 401);
    });

    test("reused token is rejected", async () => {
        // Request reset
        await fetch(`${baseUrl}/auth/forgot-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "active@example.invalid" }),
        });

        const sentEmail = getLastSentEmail();
        const rawToken = new URL(sentEmail.resetUrl).searchParams.get("token");

        // First use
        const res1 = await fetch(`${baseUrl}/auth/reset-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: rawToken, password: "SecondPassword99!" }),
        });
        assert.equal(res1.status, 200);

        // Second use attempt
        const res2 = await fetch(`${baseUrl}/auth/reset-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: rawToken, password: "ThirdPassword88!" }),
        });
        assert.equal(res2.status, 400);
        const data = await res2.json();
        assert.equal(data.code, "ALREADY_USED");
    });

    test("weak password (< 8 chars) is rejected", async () => {
        await fetch(`${baseUrl}/auth/forgot-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "active@example.invalid" }),
        });

        const sentEmail = getLastSentEmail();
        const rawToken = new URL(sentEmail.resetUrl).searchParams.get("token");

        const response = await fetch(`${baseUrl}/auth/reset-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: rawToken, password: "short" }),
        });

        assert.equal(response.status, 400);
        const data = await response.json();
        assert.equal(data.code, "INVALID_PASSWORD");
    });

    test("deactivated accounts are not automatically activated upon reset", async () => {
        // Manually place a reset token for the inactive account
        const testToken = "test-token-inactive-account";
        const tokenHash = hashResetToken(testToken);
        await db.adminPasswordReset.create({
            data: {
                resetId: "reset-for-inactive",
                adminId: "admin-inactive",
                tokenHash,
                expiresAt: new Date(Date.now() + 1000 * 60 * 60),
            },
        });

        const resetRes = await fetch(`${baseUrl}/auth/reset-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: testToken, password: "SomeNewPassword123!" }),
        });

        assert.equal(resetRes.status, 200);

        // Account status must remain INACTIVE!
        const admin = db.rows.find((a) => a.adminId === "admin-inactive");
        assert.equal(admin.status, "INACTIVE");

        // Login attempt must fail because account is INACTIVE
        const loginRes = await fetch(`${baseUrl}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "inactive@example.invalid", password: "SomeNewPassword123!" }),
        });
        assert.equal(loginRes.status, 401);
    });
});

describe("POST /auth/forgot-password rate limiting", () => {
    let rateLimitServer;
    let rateLimitBaseUrl;

    before(async () => {
        const rateLimitApp = express();
        rateLimitApp.use(express.json());
        rateLimitApp.use(
            "/auth",
            createAuthRouter({
                db,
                loginLimiter: noRateLimit,
                resetLimiter: createResetRateLimiter({ limit: 3, windowMs: 60 * 1000 }),
            })
        );

        await new Promise((resolve) => {
            rateLimitServer = rateLimitApp.listen(0, "127.0.0.1", resolve);
        });
        rateLimitBaseUrl = `http://127.0.0.1:${rateLimitServer.address().port}`;
    });

    after(() => rateLimitServer?.close());

    test("exceeding rate limit returns 429", async () => {
        for (let i = 0; i < 3; i++) {
            const res = await fetch(`${rateLimitBaseUrl}/auth/forgot-password`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: "active@example.invalid" }),
            });
            assert.equal(res.status, 200);
        }

        // 4th request must be blocked
        const blockedRes = await fetch(`${rateLimitBaseUrl}/auth/forgot-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "active@example.invalid" }),
        });
        assert.equal(blockedRes.status, 429);
        const data = await blockedRes.json();
        assert.ok(data.message.includes("Too many password reset requests"));
    });
});
