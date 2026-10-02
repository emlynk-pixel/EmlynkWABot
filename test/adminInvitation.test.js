import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import crypto from "crypto";

import { createAuthRouter, ACTIVE_ADMIN_STATUS } from "../src/routes/auth.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createRequireActiveAdmin } from "../src/middleware/requireActiveAdmin.js";
import { JWT_ALGORITHM } from "../src/middleware/auth.js";
import { ADMIN_ROLES } from "../src/middleware/requireRole.js";
import { hashPassword, comparePassword } from "../src/utils/password.js";
import { createFakeAdminDb, noRateLimit } from "./helpers/fakeAdminDb.js";
import { clearSentEmails, getLastSentEmail, getSentEmails } from "../src/services/emailService.js";
import { hashInvitationToken } from "../src/services/adminInvitationService.js";

process.env.JWT_SECRET = "test-jwt-secret-placeholder-for-invitations-0123456789";
const ADMIN_PASSWORD = "Admin-Secret-Password-1";

let server;
let baseUrl;
let db;

function makeToken({ adminId, email, role, expiresIn = "1h" }) {
    return jwt.sign({ adminId, email, role }, process.env.JWT_SECRET, {
        algorithm: JWT_ALGORITHM,
        expiresIn,
    });
}

before(async () => {
    const adminPasswordHash = await hashPassword(ADMIN_PASSWORD);
    const admins = [
        { adminId: "admin-1", name: "Super Admin", email: "admin@example.invalid", passwordHash: adminPasswordHash, role: ADMIN_ROLES.ADMIN, status: ACTIVE_ADMIN_STATUS },
        { adminId: "analyst-1", name: "Analyst Admin", email: "analyst@example.invalid", passwordHash: adminPasswordHash, role: ADMIN_ROLES.ANALYST, status: ACTIVE_ADMIN_STATUS },
        { adminId: "viewer-1", name: "Viewer Admin", email: "viewer@example.invalid", passwordHash: adminPasswordHash, role: ADMIN_ROLES.VIEWER, status: ACTIVE_ADMIN_STATUS },
        { adminId: "inactive-1", name: "Inactive Admin", email: "inactive@example.invalid", passwordHash: adminPasswordHash, role: ADMIN_ROLES.ADMIN, status: "INACTIVE" },
        { adminId: "existing-active", name: "Already Active", email: "active@example.invalid", passwordHash: adminPasswordHash, role: ADMIN_ROLES.ANALYST, status: ACTIVE_ADMIN_STATUS },
    ];

    db = createFakeAdminDb(admins);

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/auth", createAuthRouter({ db, loginLimiter: noRateLimit, resetLimiter: noRateLimit }));
    app.use("/api/admin", createAdminRouter({ apiLimiter: (req, res, next) => next(),
        db,
        requireAdmin: createRequireActiveAdmin({ db }),
    }));

    await new Promise((resolve) => {
        server = app.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
    clearSentEmails();
});

describe("Admin Invitation System (Phase 12 Checkpoint 2)", () => {
    test("ADMIN can invite a new admin, analyst, or viewer", async () => {
        const token = makeToken({ adminId: "admin-1", email: "admin@example.invalid", role: ADMIN_ROLES.ADMIN });
        const res = await fetch(`${baseUrl}/api/admin/invitations`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                name: "John Doe",
                email: "john@example.invalid",
                role: "ANALYST",
            }),
        });

        assert.equal(res.status, 201);
        const data = await res.json();
        assert.equal(data.message, "Invitation sent successfully");
        assert.equal(data.invitation.name, "John Doe");
        assert.equal(data.invitation.email, "john@example.invalid");
        assert.equal(data.invitation.role, "ANALYST");
        assert.equal(data.invitation.status, "PENDING");
        assert.ok(data.invitation.expiresAt);

        // Security check: raw token and token hash are NEVER exposed in response body
        assert.equal(data.invitation.token, undefined);
        assert.equal(data.invitation.rawToken, undefined);
        assert.equal(data.invitation.tokenHash, undefined);

        // Email was dispatched
        const sentEmail = getLastSentEmail();
        assert.ok(sentEmail, "Invitation email should be sent");
        assert.equal(sentEmail.to, "john@example.invalid");
        assert.ok(sentEmail.setupUrl.includes("/setup-password?token="));
    });

    test("Token hashing: only the SHA-256 hash is stored in the database", async () => {
        const token = makeToken({ adminId: "admin-1", email: "admin@example.invalid", role: ADMIN_ROLES.ADMIN });
        await fetch(`${baseUrl}/api/admin/invitations`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                name: "Hash Test",
                email: "hashtest@example.invalid",
                role: "VIEWER",
            }),
        });

        const sentEmail = getLastSentEmail();
        const rawToken = new URL(sentEmail.setupUrl).searchParams.get("token");
        assert.ok(rawToken, "Setup URL must contain the raw token parameter");

        // Lookup in fake DB
        const storedInv = db.invitationRows.find((r) => r.email === "hashtest@example.invalid");
        assert.ok(storedInv, "Invitation row must exist");
        assert.notEqual(storedInv.tokenHash, rawToken, "Database must NOT store the raw token");
        assert.equal(storedInv.tokenHash, hashInvitationToken(rawToken), "Stored hash must match SHA-256 of raw token");
    });

    test("Role validation: rejects invalid or unauthorized roles with 400", async () => {
        const token = makeToken({ adminId: "admin-1", email: "admin@example.invalid", role: ADMIN_ROLES.ADMIN });
        for (const badRole of ["SUPER_ADMIN", "ROOT", "USER", ""]) {
            const res = await fetch(`${baseUrl}/api/admin/invitations`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                    name: "Bad Role User",
                    email: "badrole@example.invalid",
                    role: badRole,
                }),
            });
            assert.equal(res.status, 400);
            const data = await res.json();
            assert.ok(data.message.includes("Invalid role"));
        }
    });

    test("Prevent duplicate active accounts: returns 409 if active admin exists with that email", async () => {
        const token = makeToken({ adminId: "admin-1", email: "admin@example.invalid", role: ADMIN_ROLES.ADMIN });
        const res = await fetch(`${baseUrl}/api/admin/invitations`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                name: "Duplicate Active",
                email: "active@example.invalid",
                role: "ADMIN",
            }),
        });
        assert.equal(res.status, 409);
        const data = await res.json();
        assert.equal(data.message, "An active admin with this email already exists");
        assert.equal(data.code, "DUPLICATE_ACTIVE_ADMIN");
    });

    test("Unauthorized attempts: ANALYST or VIEWER cannot invite admins (403)", async () => {
        const analystToken = makeToken({ adminId: "analyst-1", email: "analyst@example.invalid", role: ADMIN_ROLES.ANALYST });
        const resAnalyst = await fetch(`${baseUrl}/api/admin/invitations`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${analystToken}`,
            },
            body: JSON.stringify({ name: "Bob", email: "bob@example.invalid", role: "VIEWER" }),
        });
        assert.equal(resAnalyst.status, 403);
        const revData = await resAnalyst.json();
        assert.equal(revData.message, "Insufficient permissions");

        const viewerToken = makeToken({ adminId: "viewer-1", email: "viewer@example.invalid", role: ADMIN_ROLES.VIEWER });
        const resViewer = await fetch(`${baseUrl}/api/admin/invitations`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${viewerToken}`,
            },
            body: JSON.stringify({ name: "Bob", email: "bob@example.invalid", role: "VIEWER" }),
        });
        assert.equal(resViewer.status, 403);
    });

    test("Inactive inviter cannot invite (401)", async () => {
        const inactiveToken = makeToken({ adminId: "inactive-1", email: "inactive@example.invalid", role: ADMIN_ROLES.ADMIN });
        const res = await fetch(`${baseUrl}/api/admin/invitations`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${inactiveToken}`,
            },
            body: JSON.stringify({ name: "Test", email: "test@example.invalid", role: "ANALYST" }),
        });
        assert.equal(res.status, 401);
    });

    test("Successful password setup: activates account, hashes password with bcrypt, enables login", async () => {
        const adminToken = makeToken({ adminId: "admin-1", email: "admin@example.invalid", role: ADMIN_ROLES.ADMIN });
        await fetch(`${baseUrl}/api/admin/invitations`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
                name: "Alice Smith",
                email: "alice@example.invalid",
                role: "ADMIN",
            }),
        });

        const sentEmail = getLastSentEmail();
        const rawToken = new URL(sentEmail.setupUrl).searchParams.get("token");

        // 1. Invitee opens setup link -> GET /auth/invitation?token=...
        const checkRes = await fetch(`${baseUrl}/auth/invitation?token=${rawToken}`);
        assert.equal(checkRes.status, 200);
        const checkData = await checkRes.json();
        assert.equal(checkData.invitation.name, "Alice Smith");
        assert.equal(checkData.invitation.email, "alice@example.invalid");
        assert.equal(checkData.invitation.role, "ADMIN");

        // 2. Invitee sets password -> POST /auth/setup-password
        const newPassword = "AliceSuperSecurePassword-2026!";
        const setupRes = await fetch(`${baseUrl}/auth/setup-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                token: rawToken,
                password: newPassword,
            }),
        });
        assert.equal(setupRes.status, 200);
        const setupData = await setupRes.json();
        assert.ok(setupData.message.includes("Password set successfully"));

        // 3. Verify admin row in database
        const createdAdmin = db.rows.find((a) => a.email === "alice@example.invalid");
        assert.ok(createdAdmin, "Admin row must exist after password setup");
        assert.equal(createdAdmin.status, ACTIVE_ADMIN_STATUS, "Admin status must be ACTIVE");
        assert.equal(createdAdmin.role, "ADMIN");

        // Verify password was hashed with bcrypt
        assert.ok(createdAdmin.passwordHash.startsWith("$2b$") || createdAdmin.passwordHash.startsWith("$2a$"));
        const matches = await comparePassword(newPassword, createdAdmin.passwordHash);
        assert.equal(matches, true, "Bcrypt hash must match the new password");

        // 4. Invitee can now log in with the new password
        const loginRes = await fetch(`${baseUrl}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                email: "alice@example.invalid",
                password: newPassword,
            }),
        });
        assert.equal(loginRes.status, 200);
        const loginData = await loginRes.json();
        assert.equal(loginData.message, "Login successful");
        assert.ok(loginData.token);
    });

    test("Reused token: token becomes unusable after first successful use (ALREADY_USED)", async () => {
        const adminToken = makeToken({ adminId: "admin-1", email: "admin@example.invalid", role: ADMIN_ROLES.ADMIN });
        await fetch(`${baseUrl}/api/admin/invitations`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
                name: "Reused Token Test",
                email: "reused@example.invalid",
                role: "ANALYST",
            }),
        });

        const rawToken = new URL(getLastSentEmail().setupUrl).searchParams.get("token");

        // First use
        const first = await fetch(`${baseUrl}/auth/setup-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: rawToken, password: "FirstPassword-123" }),
        });
        assert.equal(first.status, 200);

        // Second use attempt -> must be rejected
        const second = await fetch(`${baseUrl}/auth/setup-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: rawToken, password: "SecondPassword-456" }),
        });
        assert.equal(second.status, 400);
        const secondData = await second.json();
        assert.equal(secondData.code, "ALREADY_USED");

        // Check GET also fails
        const check = await fetch(`${baseUrl}/auth/invitation?token=${rawToken}`);
        assert.equal(check.status, 400);
        const checkData = await check.json();
        assert.equal(checkData.code, "ALREADY_USED");
    });

    test("Expired token: rejects setup when expiresAt is in the past (EXPIRED)", async () => {
        const adminToken = makeToken({ adminId: "admin-1", email: "admin@example.invalid", role: ADMIN_ROLES.ADMIN });
        await fetch(`${baseUrl}/api/admin/invitations`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
                name: "Expired Test",
                email: "expired@example.invalid",
                role: "VIEWER",
            }),
        });

        const rawToken = new URL(getLastSentEmail().setupUrl).searchParams.get("token");
        // Artificially expire the token in database
        const invRow = db.invitationRows.find((r) => r.email === "expired@example.invalid");
        invRow.expiresAt = new Date(Date.now() - 3600 * 1000); // 1 hour ago

        // Attempt GET validation
        const check = await fetch(`${baseUrl}/auth/invitation?token=${rawToken}`);
        assert.equal(check.status, 400);
        const checkData = await check.json();
        assert.equal(checkData.code, "EXPIRED");

        // Attempt password setup
        const setup = await fetch(`${baseUrl}/auth/setup-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: rawToken, password: "SomeNewPassword-123" }),
        });
        assert.equal(setup.status, 400);
        const setupData = await setup.json();
        assert.equal(setupData.code, "EXPIRED");
    });

    test("Invalid token: rejects non-existent tokens with 400", async () => {
        const fakeToken = crypto.randomBytes(32).toString("hex");
        const check = await fetch(`${baseUrl}/auth/invitation?token=${fakeToken}`);
        assert.equal(check.status, 400);
        const checkData = await check.json();
        assert.equal(checkData.code, "INVALID_TOKEN");

        const setup = await fetch(`${baseUrl}/auth/setup-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: fakeToken, password: "SomeNewPassword-123" }),
        });
        assert.equal(setup.status, 400);
        const setupData = await setup.json();
        assert.equal(setupData.code, "INVALID_TOKEN");
    });

    test("Revoked invitation: admin can revoke, and revoked token is rejected (REVOKED)", async () => {
        const adminToken = makeToken({ adminId: "admin-1", email: "admin@example.invalid", role: ADMIN_ROLES.ADMIN });
        const createRes = await fetch(`${baseUrl}/api/admin/invitations`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
                name: "Revoke Test",
                email: "revoketest@example.invalid",
                role: "ANALYST",
            }),
        });
        const createData = await createRes.json();
        const invitationId = createData.invitation.invitationId;
        const rawToken = new URL(getLastSentEmail().setupUrl).searchParams.get("token");

        // ADMIN revokes the invitation
        const revokeRes = await fetch(`${baseUrl}/api/admin/invitations/${invitationId}/revoke`, {
            method: "POST",
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        assert.equal(revokeRes.status, 200);
        const revokeData = await revokeRes.json();
        assert.equal(revokeData.message, "Invitation revoked");

        // Invitee attempting GET validation
        const check = await fetch(`${baseUrl}/auth/invitation?token=${rawToken}`);
        assert.equal(check.status, 400);
        const checkData = await check.json();
        assert.equal(checkData.code, "REVOKED");

        // Invitee attempting setup password
        const setup = await fetch(`${baseUrl}/auth/setup-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: rawToken, password: "SomeNewPassword-123" }),
        });
        assert.equal(setup.status, 400);
        const setupData = await setup.json();
        assert.equal(setupData.code, "REVOKED");
    });

    test("Audit entries: invitation creation, completion, and revocation are all audited", async () => {
        const adminToken = makeToken({ adminId: "admin-1", email: "admin@example.invalid", role: ADMIN_ROLES.ADMIN });

        // 1. Creation
        const createRes = await fetch(`${baseUrl}/api/admin/invitations`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
                name: "Audited Admin",
                email: "audited@example.invalid",
                role: "ANALYST",
            }),
        });
        const createData = await createRes.json();
        const rawToken = new URL(getLastSentEmail().setupUrl).searchParams.get("token");

        const inviteAudit = db.auditLogRows.find(
            (l) => l.action === "INVITE_ADMIN" && l.newValue === "audited@example.invalid"
        );
        assert.ok(inviteAudit, "INVITE_ADMIN audit log must be created");
        assert.equal(inviteAudit.adminId, "admin-1");
        assert.equal(inviteAudit.previousStatus, "NONE");
        assert.equal(inviteAudit.newStatus, "INVITED");

        // 2. Completion
        await fetch(`${baseUrl}/auth/setup-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: rawToken, password: "AuditedPassword-123!" }),
        });

        const completeAudit = db.auditLogRows.find(
            (l) => l.action === "COMPLETE_INVITATION" && l.newValue === "audited@example.invalid"
        );
        assert.ok(completeAudit, "COMPLETE_INVITATION audit log must be created");
        assert.equal(completeAudit.previousStatus, "INVITED");
        assert.equal(completeAudit.newStatus, ACTIVE_ADMIN_STATUS);

        // 3. Revocation audit
        const res2 = await fetch(`${baseUrl}/api/admin/invitations`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
                name: "Revoke Audit",
                email: "revokeaudit@example.invalid",
                role: "VIEWER",
            }),
        });
        const inv2 = (await res2.json()).invitation;

        await fetch(`${baseUrl}/api/admin/invitations/${inv2.invitationId}/revoke`, {
            method: "POST",
            headers: { Authorization: `Bearer ${adminToken}` },
        });

        const revokeAudit = db.auditLogRows.find(
            (l) => l.action === "REVOKE_INVITATION" && l.newValue === "revokeaudit@example.invalid"
        );
        assert.ok(revokeAudit, "REVOKE_INVITATION audit log must be created");
        assert.equal(revokeAudit.adminId, "admin-1");
        assert.equal(revokeAudit.newStatus, "REVOKED");
    });

    test("List invitations: ADMIN can list invitations with computed status", async () => {
        const adminToken = makeToken({ adminId: "admin-1", email: "admin@example.invalid", role: ADMIN_ROLES.ADMIN });
        const res = await fetch(`${baseUrl}/api/admin/invitations`, {
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.ok(Array.isArray(data.invitations));
        assert.ok(data.invitations.length > 0);

        // Check attributes of listed invitation
        const inv = data.invitations[0];
        assert.ok(inv.invitationId);
        assert.ok(inv.email);
        assert.ok(inv.role);
        assert.ok(inv.status);
        assert.ok(inv.expiresAt);
        // Sensitive data not leaked
        assert.equal(inv.tokenHash, undefined);
    });

    test("Delete invitation: ADMIN can permanently remove an invitation", async () => {
        const adminToken = makeToken({ adminId: "admin-1", email: "admin@example.invalid", role: ADMIN_ROLES.ADMIN });
        const createRes = await fetch(`${baseUrl}/api/admin/invitations`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
                name: "To Delete",
                email: "todelete@example.invalid",
                role: "VIEWER",
            }),
        });
        const inv = (await createRes.json()).invitation;

        const deleteRes = await fetch(`${baseUrl}/api/admin/invitations/${inv.invitationId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        assert.equal(deleteRes.status, 200);
        const deleteData = await deleteRes.json();
        assert.ok(deleteData.message.includes("permanently removed"));

        // Confirm it is gone from the database
        const found = db.invitationRows.find((r) => r.invitationId === inv.invitationId);
        assert.equal(found, undefined);

        // Confirm audit log created
        const audit = db.auditLogRows.find((l) => l.action === "DELETE_INVITATION" && l.newValue === "todelete@example.invalid");
        assert.ok(audit);
    });
});

