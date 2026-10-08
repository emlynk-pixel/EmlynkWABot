// Invite User and user management through Supabase Auth: the real admin and
// auth routers, an in-memory public."user", and a Supabase stand-in
// (test/helpers/fakeSupabaseAuth.js). Supabase sends the email; the backend
// validates the ADMIN caller and the role, and links public."user" by
// auth_user_id.
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createAdminRouter } from "../src/routes/admin.js";
import { createAuthRouter } from "../src/routes/auth.js";
import { inviteRedirectUrl } from "../src/routes/users.js";
import { inviteUser } from "../src/services/userAccountService.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { createFakeAdminDb, noRateLimit } from "./helpers/fakeAdminDb.js";
import { createFakeAuthAdmin, createFakeVerifier, tokenFor, tokenForAuthId } from "./helpers/fakeSupabaseAuth.js";

const ADMIN = { adminId: "admin-1", name: "Admin", email: "admin@example.invalid", role: "ADMIN", status: "ACTIVE" };
const MANAGER = { adminId: "manager-1", name: "Manager", email: "manager@example.invalid", role: "MANAGER", status: "ACTIVE" };
const REDIRECT = "https://app.example.invalid/admin/setup-password";

let server;
let baseUrl;
let db;
let authAdmin;
let verifyAccessToken;

async function start(users = [ADMIN, MANAGER], identities = {}) {
    db = createFakeAdminDb(users);
    authAdmin = createFakeAuthAdmin({ identities });
    verifyAccessToken = createFakeVerifier();
    const app = express();
    app.use(express.json());
    app.use("/auth", createAuthRouter({ db, verifyAccessToken, apiLimiter: noRateLimit }));
    app.use("/api/admin", createAdminRouter({ db, bucket: {}, verifyAccessToken, authAdmin, apiLimiter: noRateLimit }));
    app.use(errorHandler);
    await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
}

beforeEach(async () => {
    process.env.APP_BASE_URL = "https://app.example.invalid/";
    await start();
});
afterEach(() => {
    server?.close();
    delete process.env.APP_BASE_URL;
});

async function request(method, path, { token = tokenFor(ADMIN.adminId), body } = {}) {
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
}
const invite = (body, options) => request("POST", "/api/admin/users/invite", { body, ...options });
const rowOf = (email) => db.rows.find((r) => r.email === email);
const sessionOf = (email) => tokenForAuthId(rowOf(email).authUserId);

describe("POST /api/admin/users/invite", () => {
    test("ADMIN invites: Supabase sends the invite; the row is INVITED, linked, audited", async () => {
        const result = await invite({ email: "  New.Person@Example.invalid ", name: " New Person ", role: "analyst" });
        assert.equal(result.status, 201);
        assert.equal(result.body.outcome, "INVITED");
        assert.deepEqual(Object.keys(result.body.user).sort(), ["createdDate", "email", "name", "role", "status", "userId"]);
        assert.deepEqual([result.body.user.email, result.body.user.name, result.body.user.role, result.body.user.status], ["new.person@example.invalid", "New Person", "ANALYST", "INVITED"]);

        assert.deepEqual(authAdmin.calls, [{ method: "inviteUserByEmail", email: "new.person@example.invalid", options: { redirectTo: REDIRECT } }], "only email + redirect go to Supabase: no role");
        const row = rowOf("new.person@example.invalid");
        assert.equal(row.authUserId, authAdmin.users.get("new.person@example.invalid").authUserId);
        const [entry] = db.auditLogRows;
        assert.deepEqual([entry.action, entry.adminId, entry.newStatus, entry.newValue], ["INVITE_USER", ADMIN.adminId, "INVITED", "new.person@example.invalid"]);
    });

    test("every application role can be invited; anything else is refused before Supabase", async () => {
        for (const role of ["ADMIN", "MANAGER", "ANALYST", "REGISTRATION_DESK"]) {
            assert.equal((await invite({ email: `new-${role}@example.invalid`.toLowerCase(), name: role, role })).status, 201, role);
        }
        const calls = authAdmin.calls.length;
        for (const role of ["VIEWER", "REVIEWER", "SUPERADMIN", "", undefined]) {
            const result = await invite({ email: "x@example.invalid", name: "X", role });
            assert.equal(result.status, 400);
            assert.ok(result.body.errors.some((e) => e.field === "role"));
        }
        assert.equal(authAdmin.calls.length, calls);
    });

    test("invalid email or name -> 400 with field messages, nothing sent", async () => {
        const result = await invite({ email: "not-an-email", name: "", role: "ANALYST" });
        assert.equal(result.status, 400);
        assert.deepEqual(result.body.errors.map((e) => e.field).sort(), ["email", "name"]);
        assert.equal(authAdmin.calls.length, 0);
    });

    test("non-ADMIN or no session -> refused, Supabase never called", async () => {
        assert.equal((await invite({ email: "x@example.invalid", name: "X", role: "ANALYST" }, { token: tokenFor(MANAGER.adminId) })).status, 403);
        assert.equal((await invite({ email: "x@example.invalid", name: "X", role: "ANALYST" }, { token: null })).status, 401);
        assert.equal(authAdmin.calls.length, 0);
        assert.equal(rowOf("x@example.invalid"), undefined);
    });

    test("the service itself refuses a non-ADMIN actor (defence in depth)", async () => {
        await assert.rejects(inviteUser({ db, authAdmin, actor: MANAGER, values: { email: "x@example.invalid", name: "X", role: "ADMIN" } }), { code: "FORBIDDEN" });
    });

    test("an ACTIVE user's email -> 409, no second account, no email sent", async () => {
        const result = await invite({ email: MANAGER.email, name: "Again", role: "ADMIN" });
        assert.equal(result.status, 409);
        assert.equal(result.body.code, "USER_ALREADY_ACTIVE");
        assert.equal(authAdmin.calls.length, 0);
        assert.equal(rowOf(MANAGER.email).role, "MANAGER");
    });

    test("re-inviting a pending invitee re-sends the invite: one row, same identity, new role", async () => {
        await invite({ email: "p@example.invalid", name: "P", role: "ANALYST" });
        const first = rowOf("p@example.invalid");
        const again = await invite({ email: "p@example.invalid", name: "P", role: "MANAGER" });
        assert.equal(again.status, 201);
        assert.equal(db.rows.filter((r) => r.email === "p@example.invalid").length, 1);
        assert.equal(rowOf("p@example.invalid").authUserId, first.authUserId);
        assert.equal(rowOf("p@example.invalid").role, "MANAGER");
    });

    test("re-inviting a deactivated user who had set up their account reactivates them (no new identity)", async () => {
        await invite({ email: "r@example.invalid", name: "R", role: "ANALYST" });
        authAdmin.confirm("r@example.invalid");
        rowOf("r@example.invalid").status = "INACTIVE";
        const result = await invite({ email: "r@example.invalid", name: "R", role: "ANALYST" });
        assert.equal(result.status, 200);
        assert.equal(result.body.outcome, "REACTIVATED");
        assert.equal(rowOf("r@example.invalid").status, "ACTIVE");
        assert.equal(db.auditLogRows.at(-1).action, "REACTIVATE_USER");
    });

    test("an existing confirmed Supabase identity without an application row is linked, not duplicated", async () => {
        server.close();
        await start([ADMIN], { "linked@example.invalid": { authUserId: "11111111-2222-4333-8444-555555555555", confirmed: true } });
        const result = await invite({ email: "linked@example.invalid", name: "Linked", role: "REGISTRATION_DESK" });
        assert.equal(result.status, 200);
        assert.equal(rowOf("linked@example.invalid").authUserId, "11111111-2222-4333-8444-555555555555");
        assert.equal(rowOf("linked@example.invalid").status, "ACTIVE");
    });

    test("an email whose row is bound to another Supabase identity is refused", async () => {
        db.rows.push({ adminId: "u-x", authUserId: "99999999-0000-4000-8000-000000000000", email: "bound@example.invalid", name: "B", role: "ANALYST", status: "INACTIVE" });
        const result = await invite({ email: "bound@example.invalid", name: "B", role: "ANALYST" });
        assert.equal(result.status, 409);
        assert.equal(result.body.code, "IDENTITY_MISMATCH");
        assert.equal(rowOf("bound@example.invalid").authUserId, "99999999-0000-4000-8000-000000000000");
    });

    test("Supabase rate limit -> 429; Supabase failure -> 502; no row either way", async () => {
        authAdmin.failNext("RATE_LIMITED");
        assert.equal((await invite({ email: "a@example.invalid", name: "A", role: "ANALYST" })).status, 429);
        authAdmin.failNext("FAILED");
        assert.equal((await invite({ email: "a@example.invalid", name: "A", role: "ANALYST" })).status, 502);
        assert.equal(rowOf("a@example.invalid"), undefined);
    });

    test("concurrent invites of one person converge on one row", async () => {
        const results = await Promise.all([1, 2, 3].map(() => invite({ email: "race@example.invalid", name: "Race", role: "ANALYST" })));
        assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.status)));
        assert.equal(db.rows.filter((r) => r.email === "race@example.invalid").length, 1);
    });

    test("redirect URL: APP_BASE_URL/admin/setup-password, or Supabase's Site URL when unset", () => {
        assert.equal(inviteRedirectUrl({ APP_BASE_URL: "https://x.example/" }), "https://x.example/admin/setup-password");
        assert.equal(inviteRedirectUrl({}), undefined);
    });
});

describe("invited user setup: POST /auth/complete-invite", () => {
    test("the invitee's own session activates their account; then /auth/me works", async () => {
        await invite({ email: "n@example.invalid", name: "N", role: "MANAGER" });
        const token = sessionOf("n@example.invalid");
        assert.equal((await request("GET", "/auth/me", { token })).status, 403, "not usable before setup");

        const done = await request("POST", "/auth/complete-invite", { token });
        assert.equal(done.status, 200);
        assert.deepEqual(done.body.user, { userId: rowOf("n@example.invalid").adminId, email: "n@example.invalid", name: "N", role: "MANAGER", status: "ACTIVE" });
        assert.equal(db.auditLogRows.at(-1).action, "COMPLETE_INVITATION");

        const me = await request("GET", "/auth/me", { token });
        assert.equal(me.status, 200);
        assert.equal(me.body.user.role, "MANAGER", "role from public.user, set by the ADMIN");
        assert.equal((await request("POST", "/auth/complete-invite", { token })).status, 200, "idempotent");
    });

    test("a revoked (deactivated) invitation can't be completed", async () => {
        await invite({ email: "v@example.invalid", name: "V", role: "ANALYST" });
        const userId = rowOf("v@example.invalid").adminId;
        assert.equal((await request("POST", `/api/admin/users/${userId}/deactivate`)).status, 200);
        const result = await request("POST", "/auth/complete-invite", { token: sessionOf("v@example.invalid") });
        assert.equal(result.status, 403);
        assert.equal(rowOf("v@example.invalid").status, "INACTIVE");
    });

    test("a Supabase identity that was never invited gets nothing", async () => {
        const result = await request("POST", "/auth/complete-invite", { token: tokenForAuthId("00000000-1111-4222-8333-444444444444") });
        assert.equal(result.status, 403);
    });
});

describe("user management (ADMIN only)", () => {
    test("GET /users lists profiles without Supabase identities", async () => {
        const result = await request("GET", "/api/admin/users");
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.users.map((u) => u.userId).sort(), ["admin-1", "manager-1"]);
        assert.ok(!JSON.stringify(result.body).includes("authUserId"));
        assert.equal((await request("GET", "/api/admin/users", { token: tokenFor(MANAGER.adminId) })).status, 403);
    });

    test("role change: validated, audited, effective on the next request; never your own", async () => {
        assert.equal((await request("PUT", `/api/admin/users/${MANAGER.adminId}/role`, { body: { role: "VIEWER" } })).status, 400);
        assert.equal((await request("PUT", `/api/admin/users/${ADMIN.adminId}/role`, { body: { role: "ANALYST" } })).status, 400);
        assert.equal((await request("PUT", "/api/admin/users/nobody/role", { body: { role: "ANALYST" } })).status, 404);

        const result = await request("PUT", `/api/admin/users/${MANAGER.adminId}/role`, { body: { role: "ADMIN" } });
        assert.equal(result.status, 200);
        assert.equal(result.body.user.role, "ADMIN");
        assert.equal(db.auditLogRows.at(-1).action, "UPDATE_USER_ROLE");
        assert.equal((await request("GET", "/api/admin/users", { token: tokenFor(MANAGER.adminId) })).status, 200, "the new role applies at once");
    });

    test("deactivate: the user's session stops working at once; not yourself", async () => {
        assert.equal((await request("GET", "/auth/me", { token: tokenFor(MANAGER.adminId) })).status, 200);
        assert.equal((await request("POST", `/api/admin/users/${ADMIN.adminId}/deactivate`)).status, 400);
        const result = await request("POST", `/api/admin/users/${MANAGER.adminId}/deactivate`);
        assert.equal(result.status, 200);
        assert.equal(result.body.user.status, "INACTIVE");
        assert.equal((await request("GET", "/auth/me", { token: tokenFor(MANAGER.adminId) })).status, 403);
        assert.equal(db.auditLogRows.at(-1).action, "DEACTIVATE_USER");
    });

    test("invalid user IDs are refused", async () => {
        assert.equal((await request("POST", "/api/admin/users/bad%20id!/deactivate")).status, 400);
    });
});
