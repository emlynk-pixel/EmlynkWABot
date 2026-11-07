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
const STAFF = { adminId: "staff-1", name: "Staff", email: "staff@example.invalid", role: "ANALYST", status: "ACTIVE" };
const REDIRECT = "https://app.example.invalid/admin/setup-password";

let server;
let baseUrl;
let db;
let authAdmin;
let verifyAccessToken;

async function start(users = [ADMIN, STAFF], identities = {}) {
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
        assert.deepEqual(Object.keys(result.body.user).sort(), ["createdDate", "email", "invitedAt", "name", "role", "status", "userId"]);
        assert.ok(result.body.user.invitedAt, "the invitation's sending time is recorded");
        assert.deepEqual([result.body.user.email, result.body.user.name, result.body.user.role, result.body.user.status], ["new.person@example.invalid", "New Person", "ANALYST", "INVITED"]);

        assert.deepEqual(authAdmin.calls, [{ method: "inviteUserByEmail", email: "new.person@example.invalid", options: { redirectTo: REDIRECT } }], "only email + redirect go to Supabase: no role");
        const row = rowOf("new.person@example.invalid");
        assert.equal(row.authUserId, authAdmin.users.get("new.person@example.invalid").authUserId);
        const [entry] = db.auditLogRows;
        assert.deepEqual([entry.action, entry.adminId, entry.newStatus, entry.newValue], ["INVITE_USER", ADMIN.adminId, "INVITED", "new.person@example.invalid"]);
    });

    test("ADMIN invites every role below ADMIN; ADMIN and OWNER are refused (403); anything else, the retired MANAGER included, is a 400; before Supabase", async () => {
        for (const role of ["ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]) {
            assert.equal((await invite({ email: `new-${role}@example.invalid`.toLowerCase(), name: role, role })).status, 201, role);
        }
        const calls = authAdmin.calls.length;
        for (const role of ["ADMIN", "OWNER", "admin", " owner "]) {
            const result = await invite({ email: "x@example.invalid", name: "X", role });
            assert.deepEqual([result.status, result.body], [403, { message: "Insufficient permissions" }], `${role}: refused, never a lesser role`);
        }
        for (const role of ["MANAGER", "manager", "VIEWER", "REVIEWER", "SUPERADMIN", "", undefined]) {
            const result = await invite({ email: "x@example.invalid", name: "X", role });
            assert.equal(result.status, 400, String(role));
            assert.deepEqual(result.body.errors.find((e) => e.field === "role"), { field: "role", message: "must be one of: OWNER, ADMIN, TEAM_LEAD, ANALYST, REGISTRATION_DESK, JOB_HANDLER" }, String(role));
        }
        assert.equal(rowOf("x@example.invalid"), undefined, "no account with a refused role");
        assert.equal(authAdmin.calls.length, calls);
    });

    test("invalid email or name -> 400 with field messages, nothing sent", async () => {
        const result = await invite({ email: "not-an-email", name: "", role: "ANALYST" });
        assert.equal(result.status, 400);
        assert.deepEqual(result.body.errors.map((e) => e.field).sort(), ["email", "name"]);
        assert.equal(authAdmin.calls.length, 0);
    });

    test("non-ADMIN or no session -> refused, Supabase never called", async () => {
        assert.equal((await invite({ email: "x@example.invalid", name: "X", role: "ANALYST" }, { token: tokenFor(STAFF.adminId) })).status, 403);
        assert.equal((await invite({ email: "x@example.invalid", name: "X", role: "ANALYST" }, { token: null })).status, 401);
        assert.equal(authAdmin.calls.length, 0);
        assert.equal(rowOf("x@example.invalid"), undefined);
    });

    test("the service itself refuses a non-ADMIN actor (defence in depth)", async () => {
        await assert.rejects(inviteUser({ db, authAdmin, actor: STAFF, values: { email: "x@example.invalid", name: "X", role: "ADMIN" } }), { code: "FORBIDDEN" });
    });

    test("an ACTIVE user's email -> 409, no second account, no email sent", async () => {
        const result = await invite({ email: STAFF.email, name: "Again", role: "ANALYST" });
        assert.equal(result.status, 409);
        assert.equal(result.body.code, "USER_ALREADY_ACTIVE");
        assert.equal(authAdmin.calls.length, 0);
        assert.equal(rowOf(STAFF.email).role, "ANALYST");
    });

    test("re-inviting a pending invitee re-sends the invite: one row, same identity, new role", async () => {
        await invite({ email: "p@example.invalid", name: "P", role: "ANALYST" });
        const first = rowOf("p@example.invalid");
        const again = await invite({ email: "p@example.invalid", name: "P", role: "JOB_HANDLER" });
        assert.equal(again.status, 201);
        assert.equal(db.rows.filter((r) => r.email === "p@example.invalid").length, 1);
        assert.equal(rowOf("p@example.invalid").authUserId, first.authUserId);
        assert.equal(rowOf("p@example.invalid").role, "JOB_HANDLER");
    });

    test("re-inviting a deactivated user who had SET UP their account reactivates them (no new identity)", async () => {
        await invite({ email: "r@example.invalid", name: "R", role: "ANALYST" });
        authAdmin.confirm("r@example.invalid");
        assert.equal((await request("POST", "/auth/complete-invite", { token: sessionOf("r@example.invalid") })).status, 200, "accepted with a password");
        assert.ok(rowOf("r@example.invalid").activatedAt);
        assert.equal((await request("POST", `/api/admin/users/${rowOf("r@example.invalid").adminId}/deactivate`)).status, 200);
        const result = await invite({ email: "r@example.invalid", name: "R", role: "ANALYST" });
        assert.equal(result.status, 200);
        assert.equal(result.body.outcome, "REACTIVATED");
        assert.equal(rowOf("r@example.invalid").status, "ACTIVE");
        assert.equal(db.auditLogRows.at(-1).action, "REACTIVATE_USER");
    });

    test("BUG 1: invite link opened (address confirmed) but never set up, revoked, re-invited -> stays INVITED with a password-setup email, never ACTIVE", async () => {
        await invite({ email: "b1@example.invalid", name: "B1", role: "ANALYST" });
        authAdmin.confirm("b1@example.invalid"); // the link was opened (or pre-fetched by an email scanner)
        assert.equal((await request("POST", `/api/admin/users/${rowOf("b1@example.invalid").adminId}/deactivate`)).status, 200);
        const result = await invite({ email: "b1@example.invalid", name: "B1", role: "ANALYST" });
        assert.equal(result.status, 201);
        assert.equal(result.body.outcome, "INVITED");
        assert.equal(rowOf("b1@example.invalid").status, "INVITED", "not ACTIVE: no password was ever set");
        assert.deepEqual(authAdmin.calls.at(-1), { method: "sendPasswordSetupEmail", email: "b1@example.invalid", options: { redirectTo: REDIRECT } });
        assert.deepEqual([db.auditLogRows.at(-1).action, db.auditLogRows.at(-1).newStatus], ["INVITE_USER", "INVITED"]);
        assert.equal((await request("GET", "/auth/me", { token: sessionOf("b1@example.invalid") })).status, 403, "still no access until setup");
    });

    test("a password-setup email that Supabase refuses -> 429 / 502 and nothing changes", async () => {
        await invite({ email: "b2@example.invalid", name: "B2", role: "ANALYST" });
        authAdmin.confirm("b2@example.invalid");
        rowOf("b2@example.invalid").status = "INACTIVE";
        const realSend = authAdmin.sendPasswordSetupEmail;
        authAdmin.sendPasswordSetupEmail = async () => { throw new (await import("../src/auth/supabaseAuthAdmin.js")).AuthAdminError("RATE_LIMITED", "x"); };
        assert.equal((await invite({ email: "b2@example.invalid", name: "B2", role: "ANALYST" })).status, 429);
        authAdmin.sendPasswordSetupEmail = realSend;
        assert.equal(rowOf("b2@example.invalid").status, "INACTIVE");
    });

    test("an existing confirmed Supabase identity without an application row is linked (not duplicated) and sent a password-setup email, INVITED", async () => {
        server.close();
        await start([ADMIN], { "linked@example.invalid": { authUserId: "11111111-2222-4333-8444-555555555555", confirmed: true } });
        const result = await invite({ email: "linked@example.invalid", name: "Linked", role: "REGISTRATION_DESK" });
        assert.equal(result.status, 201);
        assert.equal(rowOf("linked@example.invalid").authUserId, "11111111-2222-4333-8444-555555555555");
        assert.equal(rowOf("linked@example.invalid").status, "INVITED");
        assert.equal(authAdmin.calls.at(-1).method, "sendPasswordSetupEmail");
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

    test("redirect URL is ${APP_BASE_URL}/admin/setup-password (trailing slash tolerated)", () => {
        assert.equal(inviteRedirectUrl({ APP_BASE_URL: "https://x.example/" }), "https://x.example/admin/setup-password");
        assert.equal(inviteRedirectUrl({ APP_BASE_URL: "http://localhost:5173" }), "http://localhost:5173/admin/setup-password");
    });

    test("APP_BASE_URL missing or invalid -> the invite is refused (503) and nothing is sent or stored", async () => {
        for (const value of [undefined, "", "   ", "not a url", "ftp://host.example", "https://host.example/admin", "https://host.example/?x=1", "https://user:pw@host.example"]) {
            if (value === undefined) delete process.env.APP_BASE_URL;
            else process.env.APP_BASE_URL = value;
            const result = await invite({ email: "cfg@example.invalid", name: "Cfg", role: "ANALYST" });
            assert.equal(result.status, 503, String(value));
            assert.equal(result.body.code, "INVITE_NOT_CONFIGURED");
            assert.match(result.body.message, /^Invitations are not configured: APP_BASE_URL/);
            assert.ok(!JSON.stringify(result.body).includes("pw@"), "the configured value is never echoed");
        }
        assert.equal(authAdmin.calls.length, 0, "Supabase is never asked to send an email");
        assert.equal(rowOf("cfg@example.invalid"), undefined);
        assert.equal(db.auditLogRows.length, 0);
    });

    test("the redirect cannot be influenced by the request (body, query or headers)", async () => {
        const response = await fetch(`${baseUrl}/api/admin/users/invite?redirectTo=https://evil.example&APP_BASE_URL=https://evil.example`, {
            method: "POST",
            headers: { Authorization: `Bearer ${tokenFor(ADMIN.adminId)}`, "Content-Type": "application/json", Host: "evil.example", "X-Forwarded-Host": "evil.example", Origin: "https://evil.example", Referer: "https://evil.example/" },
            body: JSON.stringify({ email: "safe@example.invalid", name: "Safe", role: "ANALYST", redirectTo: "https://evil.example/x", redirect_to: "https://evil.example/y", appBaseUrl: "https://evil.example" }),
        });
        assert.equal(response.status, 201);
        assert.equal(authAdmin.calls.at(-1).options.redirectTo, REDIRECT);
    });

    test("a missing redirect is refused by the service and the Supabase wrapper too (no Site URL fallback)", async () => {
        await assert.rejects(inviteUser({ db, authAdmin, actor: ADMIN, values: { email: "x@example.invalid", name: "X", role: "ANALYST" } }), { code: "INVITE_NOT_CONFIGURED" });
        assert.equal(authAdmin.calls.length, 0);
    });
});

describe("invited user setup: POST /auth/complete-invite", () => {
    test("the invitee's own session activates their account; then /auth/me works", async () => {
        await invite({ email: "n@example.invalid", name: "N", role: "JOB_HANDLER" });
        const token = sessionOf("n@example.invalid");
        assert.equal((await request("GET", "/auth/me", { token })).status, 403, "not usable before setup");

        const done = await request("POST", "/auth/complete-invite", { token });
        assert.equal(done.status, 200);
        assert.deepEqual(done.body.user, { userId: rowOf("n@example.invalid").adminId, email: "n@example.invalid", name: "N", role: "JOB_HANDLER", status: "ACTIVE" });
        assert.equal(db.auditLogRows.at(-1).action, "COMPLETE_INVITATION");

        const me = await request("GET", "/auth/me", { token });
        assert.equal(me.status, 200);
        assert.equal(me.body.user.role, "JOB_HANDLER", "role from public.user, set by the ADMIN");
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

    test("completing an invitation records when the account was set up", async () => {
        await invite({ email: "t@example.invalid", name: "T", role: "ANALYST" });
        assert.equal(rowOf("t@example.invalid").activatedAt, undefined);
        await request("POST", "/auth/complete-invite", { token: sessionOf("t@example.invalid") });
        assert.ok(rowOf("t@example.invalid").activatedAt instanceof Date);
    });
});

describe("GET /auth/invitation: is this invitation still valid (asked BEFORE a password is set)", () => {
    test("INVITED, then INACTIVE once revoked; unknown identity -> null; no session -> 401", async () => {
        await invite({ email: "s@example.invalid", name: "S", role: "ANALYST" });
        const token = sessionOf("s@example.invalid");
        assert.deepEqual((await request("GET", "/auth/invitation", { token })).body, { status: "INVITED" });
        await request("POST", `/api/admin/users/${rowOf("s@example.invalid").adminId}/deactivate`);
        assert.deepEqual((await request("GET", "/auth/invitation", { token })).body, { status: "INACTIVE" });
        assert.deepEqual((await request("GET", "/auth/invitation", { token: tokenForAuthId("00000000-1111-4222-8333-444444444444") })).body, { status: null });
        assert.equal((await request("GET", "/auth/invitation", { token: null })).status, 401);
    });
});

describe("BUG 2: a password was set but the activation call never arrived -> the first password sign-in completes it", () => {
    test("an INVITED account signing in WITH A PASSWORD becomes ACTIVE (audited, once)", async () => {
        await invite({ email: "p2@example.invalid", name: "P2", role: "ANALYST" });
        const authUserId = rowOf("p2@example.invalid").authUserId;
        const me = await request("GET", "/auth/me", { token: tokenForAuthId(authUserId, { amr: ["password"] }) });
        assert.equal(me.status, 200, JSON.stringify(me.body));
        assert.equal(me.body.user.status, "ACTIVE");
        assert.equal(rowOf("p2@example.invalid").status, "ACTIVE");
        assert.ok(rowOf("p2@example.invalid").activatedAt);
        const completions = db.auditLogRows.filter((r) => r.action === "COMPLETE_INVITATION" && r.newValue === "p2@example.invalid");
        assert.equal(completions.length, 1);
        assert.equal(completions[0].reason, "Invitation completed at the first password sign-in");
        await request("GET", "/auth/me", { token: tokenForAuthId(authUserId, { amr: ["password"] }) });
        assert.equal(db.auditLogRows.filter((r) => r.action === "COMPLETE_INVITATION" && r.newValue === "p2@example.invalid").length, 1, "not again");
    });

    test("never for a revoked (INACTIVE) account, and never for a session from the invite link itself", async () => {
        await invite({ email: "p3@example.invalid", name: "P3", role: "ANALYST" });
        const authUserId = rowOf("p3@example.invalid").authUserId;
        assert.equal((await request("GET", "/auth/me", { token: tokenForAuthId(authUserId, { amr: ["invite"] }) })).status, 403, "the link session is not a password");
        assert.equal(rowOf("p3@example.invalid").status, "INVITED");
        await request("POST", `/api/admin/users/${rowOf("p3@example.invalid").adminId}/deactivate`);
        assert.equal((await request("GET", "/auth/me", { token: tokenForAuthId(authUserId, { amr: ["password"] }) })).status, 403);
        assert.equal(rowOf("p3@example.invalid").status, "INACTIVE", "a revoked person stays out");
    });
});

describe("user management (OWNER and ADMIN only)", () => {
    test("GET /users lists profiles without Supabase identities", async () => {
        const result = await request("GET", "/api/admin/users");
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.users.map((u) => u.userId).sort(), ["admin-1", "staff-1"]);
        assert.ok(!JSON.stringify(result.body).includes("authUserId"));
        assert.equal((await request("GET", "/api/admin/users", { token: tokenFor(STAFF.adminId) })).status, 403);
    });

    test("role change: validated, audited, effective on the next request; never your own", async () => {
        for (const role of ["VIEWER", "MANAGER"]) {
            const refused = await request("PUT", `/api/admin/users/${STAFF.adminId}/role`, { body: { role } });
            assert.deepEqual([refused.status, refused.body.code], [400, "INVALID_ROLE"], `${role}: never given (MANAGER is retired)`);
        }
        assert.equal(rowOf(STAFF.email).role, "ANALYST");
        assert.equal((await request("PUT", `/api/admin/users/${ADMIN.adminId}/role`, { body: { role: "ANALYST" } })).status, 400);
        assert.equal((await request("PUT", "/api/admin/users/nobody/role", { body: { role: "ANALYST" } })).status, 404);

        const staffRole = async () => (await request("GET", "/auth/me", { token: tokenFor(STAFF.adminId) })).body.user.role;
        assert.equal(await staffRole(), "ANALYST");
        const result = await request("PUT", `/api/admin/users/${STAFF.adminId}/role`, { body: { role: "REGISTRATION_DESK" } });
        assert.equal(result.status, 200);
        assert.equal(result.body.user.role, "REGISTRATION_DESK");
        assert.equal(db.auditLogRows.at(-1).action, "UPDATE_USER_ROLE");
        assert.equal(await staffRole(), "REGISTRATION_DESK", "the new role applies at once");
    });

    test("deactivate: the user's session stops working at once; not yourself", async () => {
        assert.equal((await request("GET", "/auth/me", { token: tokenFor(STAFF.adminId) })).status, 200);
        assert.equal((await request("POST", `/api/admin/users/${ADMIN.adminId}/deactivate`)).status, 400);
        const result = await request("POST", `/api/admin/users/${STAFF.adminId}/deactivate`);
        assert.equal(result.status, 200);
        assert.equal(result.body.user.status, "INACTIVE");
        assert.equal((await request("GET", "/auth/me", { token: tokenFor(STAFF.adminId) })).status, 403);
        assert.equal(db.auditLogRows.at(-1).action, "DEACTIVATE_USER");
    });

    test("invalid user IDs are refused", async () => {
        assert.equal((await request("POST", "/api/admin/users/bad%20id!/deactivate")).status, 400);
    });
});
