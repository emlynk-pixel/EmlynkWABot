import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";

import { createAuthRouter, ACTIVE_ADMIN_STATUS } from "../src/routes/auth.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createRequireActiveAdmin } from "../src/middleware/requireActiveAdmin.js";
import { AUTH_COOKIE_NAME, JWT_ALGORITHM } from "../src/middleware/auth.js";
import { ADMIN_ROLES } from "../src/middleware/requireRole.js";
import { hashPassword } from "../src/utils/password.js";
import { createFakeReviewDb } from "./helpers/fakeReviewDb.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";

process.env.JWT_SECRET = "test-jwt-secret-placeholder-for-rbac-0123456789";
const PASSWORD = "Secret-Password-1";

let server;
let baseUrl;
let db;

before(async () => {
    const passwordHash = await hashPassword(PASSWORD);
    const admins = [
        { adminId: "admin-super", name: "Admin User", email: "admin@example.invalid", passwordHash, role: ADMIN_ROLES.ADMIN, status: ACTIVE_ADMIN_STATUS },
        { adminId: "admin-analyst", name: "Analyst User", email: "analyst@example.invalid", passwordHash, role: ADMIN_ROLES.ANALYST, status: ACTIVE_ADMIN_STATUS },
        { adminId: "admin-viewer", name: "Viewer User", email: "viewer@example.invalid", passwordHash, role: ADMIN_ROLES.VIEWER, status: ACTIVE_ADMIN_STATUS },
        { adminId: "admin-unknown-role", name: "Unknown Role", email: "unknown@example.invalid", passwordHash, role: "STRANGER", status: ACTIVE_ADMIN_STATUS },
        { adminId: "admin-inactive", name: "Inactive User", email: "inactive@example.invalid", passwordHash, role: ADMIN_ROLES.ADMIN, status: "INACTIVE" },
    ];

    const users = [{ passportId: "N1234567", uniqueId: "0001", firstName: "Kamal", otherName: "Perera" }];
    const documents = [
        {
            documentId: "3f2b8c1e-0000-4000-8000-000000000001",
            passportId: "N1234567",
            documentType: "POLICE_SLIP",
            verificationStatus: "VERIFIED",
            processingStatus: "STORED",
            receivedDate: new Date("2026-09-20T00:00:00Z"),
            policeSubmittedDate: "2026-09-18",
            storagePath: "client_folders/N1234567/police_slip.pdf",
            fileSha256: "hash-slip-1",
        },
    ];
    const temporaryData = [
        {
            temporaryId: "11111111-2222-3333-4444-555555555555",
            passportId: "N1234567",
            documentType: "PASSPORT",
            processingStatus: "MANUAL_REVIEW",
            createdDate: new Date("2026-09-25T10:00:00Z"),
            pendingStoragePath: "pending/item-1.pdf",
            ocrResult: {},
            documentCategory: "IDENTITY",
            storagePath: "pending/item-1.pdf",
        },
    ];

    db = createFakeReviewDb({ admins, users, documents, temporaryData });

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/auth", createAuthRouter({ db: db.client, loginLimiter: noRateLimit }));
    app.use("/api/admin", createAdminRouter({ apiLimiter: (req, res, next) => next(),
        db: db.client,
        requireAdmin: createRequireActiveAdmin({ db: db.client }),
        storage: {
            async deletePendingFile() { return true; },
            async movePendingToClientFolder() { return "client_folders/N1234567/passport.pdf"; },
        },
    }));

    await new Promise((resolve) => {
        server = app.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function makeToken({ adminId, email, role, expiresIn = "1h" }) {
    return jwt.sign({ adminId, email, role }, process.env.JWT_SECRET, {
        algorithm: JWT_ALGORITHM,
        expiresIn,
    });
}

describe("Cookie-based Admin Authentication", () => {
    test("login sets httpOnly, sameSite=strict cookie", async () => {
        const res = await fetch(`${baseUrl}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "admin@example.invalid", password: PASSWORD }),
        });
        assert.equal(res.status, 200);

        const cookieHeader = res.headers.get("set-cookie") || "";
        assert.ok(cookieHeader.includes(AUTH_COOKIE_NAME), "cookie name is present");
        assert.ok(/httponly/i.test(cookieHeader), "cookie has HttpOnly flag");
        assert.ok(/samesite=strict/i.test(cookieHeader), "cookie has SameSite=Strict flag");
    });

    test("GET /auth/me succeeds with cookie authentication", async () => {
        const token = makeToken({ adminId: "admin-super", email: "admin@example.invalid", role: ADMIN_ROLES.ADMIN });
        const res = await fetch(`${baseUrl}/auth/me`, {
            headers: { Cookie: `${AUTH_COOKIE_NAME}=${token}` },
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.admin.adminId, "admin-super");
        assert.equal(data.admin.role, ADMIN_ROLES.ADMIN);
    });

    test("POST /auth/logout clears cookie and requires auth", async () => {
        // Without auth -> 401
        const unauth = await fetch(`${baseUrl}/auth/logout`, { method: "POST" });
        assert.equal(unauth.status, 401);

        // With auth -> 200 and cleared cookie
        const token = makeToken({ adminId: "admin-super", email: "admin@example.invalid", role: ADMIN_ROLES.ADMIN });
        const res = await fetch(`${baseUrl}/auth/logout`, {
            method: "POST",
            headers: { Cookie: `${AUTH_COOKIE_NAME}=${token}` },
        });
        assert.equal(res.status, 200);
        const cookieHeader = res.headers.get("set-cookie") || "";
        assert.ok(cookieHeader.includes(AUTH_COOKIE_NAME));
        assert.ok(/expires=|max-age=0/i.test(cookieHeader), "cookie is expired/cleared");
    });

    test("missing cookie/token returns 401", async () => {
        const res = await fetch(`${baseUrl}/auth/me`);
        assert.equal(res.status, 401);
        const data = await res.json();
        assert.equal(data.message, "Authentication Token is required!");
    });

    test("expired token in cookie returns 401", async () => {
        const expired = makeToken({ adminId: "admin-super", email: "admin@example.invalid", role: ADMIN_ROLES.ADMIN, expiresIn: "-1s" });
        const res = await fetch(`${baseUrl}/auth/me`, {
            headers: { Cookie: `${AUTH_COOKIE_NAME}=${expired}` },
        });
        assert.equal(res.status, 401);
        const data = await res.json();
        assert.equal(data.message, "Invalid or Expired Token");
    });

    test("invalid signature in cookie returns 401", async () => {
        const res = await fetch(`${baseUrl}/auth/me`, {
            headers: { Cookie: `${AUTH_COOKIE_NAME}=bad.invalid.signature` },
        });
        assert.equal(res.status, 401);
        const data = await res.json();
        assert.equal(data.message, "Invalid or Expired Token");
    });

    test("deactivated admin returns 401", async () => {
        const token = makeToken({ adminId: "admin-inactive", email: "inactive@example.invalid", role: ADMIN_ROLES.ADMIN });
        const res = await fetch(`${baseUrl}/auth/me`, {
            headers: { Cookie: `${AUTH_COOKIE_NAME}=${token}` },
        });
        assert.equal(res.status, 401);
        const data = await res.json();
        assert.equal(data.message, "Invalid or Expired Token");
    });
});

describe("Role-Based Authorization (RBAC)", () => {
    const adminToken = makeToken({ adminId: "admin-super", email: "admin@example.invalid", role: ADMIN_ROLES.ADMIN });
    const analystToken = makeToken({ adminId: "admin-analyst", email: "analyst@example.invalid", role: ADMIN_ROLES.ANALYST });
    const viewerToken = makeToken({ adminId: "admin-viewer", email: "viewer@example.invalid", role: ADMIN_ROLES.VIEWER });
    const unknownToken = makeToken({ adminId: "admin-unknown-role", email: "unknown@example.invalid", role: "STRANGER" });

    describe("Read endpoints (allowed for ADMIN, ANALYST, VIEWER)", () => {
        for (const [roleName, token] of [["ADMIN", adminToken], ["ANALYST", analystToken], ["VIEWER", viewerToken]]) {
            test(`${roleName} can access GET /api/admin/overview`, async () => {
                const res = await fetch(`${baseUrl}/api/admin/overview`, {
                    headers: { Cookie: `${AUTH_COOKIE_NAME}=${token}` },
                });
                assert.equal(res.status, 200);
            });

            test(`${roleName} can access GET /api/admin/documents`, async () => {
                const res = await fetch(`${baseUrl}/api/admin/documents`, {
                    headers: { Cookie: `${AUTH_COOKIE_NAME}=${token}` },
                });
                assert.equal(res.status, 200);
            });

            test(`${roleName} can access GET /api/admin/clients`, async () => {
                const res = await fetch(`${baseUrl}/api/admin/clients`, {
                    headers: { Cookie: `${AUTH_COOKIE_NAME}=${token}` },
                });
                assert.equal(res.status, 200);
            });

            test(`${roleName} can access GET /api/admin/police`, async () => {
                const res = await fetch(`${baseUrl}/api/admin/police`, {
                    headers: { Cookie: `${AUTH_COOKIE_NAME}=${token}` },
                });
                assert.equal(res.status, 200);
            });

            test(`${roleName} can access GET /api/admin/reports/daily`, async () => {
                const res = await fetch(`${baseUrl}/api/admin/reports/daily`, {
                    headers: { Cookie: `${AUTH_COOKIE_NAME}=${token}` },
                });
                assert.equal(res.status, 200);
            });
        }

        test("Unknown role cannot access read endpoints -> 403 Insufficient permissions", async () => {
            const res = await fetch(`${baseUrl}/api/admin/overview`, {
                headers: { Cookie: `${AUTH_COOKIE_NAME}=${unknownToken}` },
            });
            assert.equal(res.status, 403);
            const data = await res.json();
            assert.deepEqual(data, { message: "Insufficient permissions" });
        });
    });

    describe("Review action endpoints (allowed for ADMIN and ANALYST, refused for VIEWER)", () => {
        test("ADMIN can execute review action (keep-pending)", async () => {
            const res = await fetch(`${baseUrl}/api/admin/review/pending-11111111-2222-3333-4444-555555555555/keep-pending`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Cookie: `${AUTH_COOKIE_NAME}=${adminToken}` },
                body: JSON.stringify({ reason: "Needs further check" }),
            });
            assert.equal(res.status, 200);
        });

        test("ANALYST can execute review action (keep-pending)", async () => {
            const res = await fetch(`${baseUrl}/api/admin/review/pending-11111111-2222-3333-4444-555555555555/keep-pending`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Cookie: `${AUTH_COOKIE_NAME}=${analystToken}` },
                body: JSON.stringify({ reason: "Analyst checking" }),
            });
            assert.equal(res.status, 200);
        });

        test("VIEWER is refused on review actions -> 403 Insufficient permissions", async () => {
            const res = await fetch(`${baseUrl}/api/admin/review/pending-11111111-2222-3333-4444-555555555555/keep-pending`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Cookie: `${AUTH_COOKIE_NAME}=${viewerToken}` },
                body: JSON.stringify({ reason: "Viewer trying" }),
            });
            assert.equal(res.status, 403);
            const data = await res.json();
            assert.deepEqual(data, { message: "Insufficient permissions" });
        });

        test("VIEWER is refused on approve -> 403 Insufficient permissions", async () => {
            const res = await fetch(`${baseUrl}/api/admin/review/pending-11111111-2222-3333-4444-555555555555/approve`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Cookie: `${AUTH_COOKIE_NAME}=${viewerToken}` },
                body: JSON.stringify({}),
            });
            assert.equal(res.status, 403);
            const data = await res.json();
            assert.deepEqual(data, { message: "Insufficient permissions" });
        });

        test("VIEWER is refused on remove -> 403 Insufficient permissions", async () => {
            const res = await fetch(`${baseUrl}/api/admin/review/pending-11111111-2222-3333-4444-555555555555/remove`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Cookie: `${AUTH_COOKIE_NAME}=${viewerToken}` },
                body: JSON.stringify({ reason: "Try delete" }),
            });
            assert.equal(res.status, 403);
            const data = await res.json();
            assert.deepEqual(data, { message: "Insufficient permissions" });
        });
    });

    describe("Document correction endpoint (POST /documents/:id/police-date: ADMIN only)", () => {
        test("ADMIN can correct police slip date on stored document", async () => {
            const res = await fetch(`${baseUrl}/api/admin/documents/3f2b8c1e-0000-4000-8000-000000000001/police-date`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Cookie: `${AUTH_COOKIE_NAME}=${adminToken}` },
                body: JSON.stringify({ policeSubmittedDate: "2026-09-19", reason: "Corrected per paper receipt" }),
            });
            assert.equal(res.status, 200);
            const data = await res.json();
            assert.equal(data.action, "SET_POLICE_DATE");
            assert.equal(data.policeSubmittedDate, "2026-09-19");
        });

        test("ANALYST cannot correct police slip date on stored document -> 403 Insufficient permissions", async () => {
            const res = await fetch(`${baseUrl}/api/admin/documents/3f2b8c1e-0000-4000-8000-000000000001/police-date`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Cookie: `${AUTH_COOKIE_NAME}=${analystToken}` },
                body: JSON.stringify({ policeSubmittedDate: "2026-09-19", reason: "Analyst try" }),
            });
            assert.equal(res.status, 403);
            const data = await res.json();
            assert.deepEqual(data, { message: "Insufficient permissions" });
        });

        test("VIEWER cannot correct police slip date on stored document -> 403 Insufficient permissions", async () => {
            const res = await fetch(`${baseUrl}/api/admin/documents/3f2b8c1e-0000-4000-8000-000000000001/police-date`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Cookie: `${AUTH_COOKIE_NAME}=${viewerToken}` },
                body: JSON.stringify({ policeSubmittedDate: "2026-09-19", reason: "Viewer try" }),
            });
            assert.equal(res.status, 403);
            const data = await res.json();
            assert.deepEqual(data, { message: "Insufficient permissions" });
        });
    });
});
