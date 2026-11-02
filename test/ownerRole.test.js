// The OWNER role: the system owner, above ADMIN. An OWNER manages every account but an OWNER's
// and gives every role but OWNER; an ADMIN keeps all its other permissions but manages, and
// gives, only the roles below ADMIN. The OWNER is set in the database only: nobody gives the
// OWNER role, or changes or deactivates an OWNER account, through the API (403 OWNER_LOCKED).
// An account still holding the retired MANAGER role is changed by the OWNER only, never given again.
// On a REAL PostgreSQL (PGlite, every migration applied) through the real Prisma client, the
// real user-management service (its SELECT ... FOR UPDATE included) and the real admin router;
// the Supabase Auth admin is the test fake. Requests are sent straight to the API, as a client
// bypassing the admin app would.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createFakeAuthAdmin } from "./helpers/fakeSupabaseAuth.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { ASSIGNABLE_ROLES, canAssignRole, canManageAccount, hasRole } from "../src/middleware/requireRole.js";
import { deactivateUser, updateUserRole } from "../src/services/userAccountService.js";

const user = (adminId, role, n, status = "ACTIVE") => ({ adminId, role, status, name: `${adminId} user`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const FIXTURES = [
    user("owner", "OWNER", 1),
    user("admin", "ADMIN", 2),
    user("admin2", "ADMIN", 3),
    // Still holding the retired MANAGER role (not converted yet: scripts/migrateManagerRole.js).
    user("legacy", "MANAGER", 4),
    user("analyst", "ANALYST", 5),
    user("desk", "REGISTRATION_DESK", 6),
    user("handler", "JOB_HANDLER", 7),
];
const U = Object.fromEntries(FIXTURES.map((u) => [u.adminId, u]));

let database;
let prisma;
let pg;
let authAdmin;
let server;
let baseUrl;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    process.env.APP_BASE_URL = "https://app.example.invalid/";
    authAdmin = createFakeAuthAdmin();
    // The caller is chosen per request (x-test-user) and loaded from the database, like requireActiveUser.
    const app = express();
    app.use(express.json());
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: req.get("x-test-user") }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
        if (!req.user) return res.status(401).json({ message: "Invalid or Expired Token" });
        if (req.user.status !== "ACTIVE") return res.status(403).json({ message: "Your account is not active. Contact an administrator.", code: "ACCOUNT_NOT_ACTIVE" });
        return next();
    };
    app.use("/api/admin", createAdminRouter({ db: prisma, bucket: {}, requireAdmin, authAdmin, apiLimiter: noRateLimit }));
    app.use(errorHandler);
    await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/admin`;
});
after(async () => {
    server?.close();
    delete process.env.APP_BASE_URL;
    await database?.close();
});
beforeEach(async () => {
    await pg.exec(`ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER; DELETE FROM "rate_limits"; DELETE FROM "user";`);
    for (const u of FIXTURES) await prisma.user.create({ data: u });
    authAdmin.calls.length = 0;
    authAdmin.users.clear?.();
});

async function api(who, method, path, body) {
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { "x-test-user": who.adminId, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
}
const setRole = (who, target, role) => api(who, "PUT", `/users/${target.adminId}/role`, { role });
const deactivate = (who, target) => api(who, "POST", `/users/${target.adminId}/deactivate`, {});
const invite = (who, role, email = "new.person@example.invalid") => api(who, "POST", "/users/invite", { name: "New Person", email, role });
const row = (adminId) => prisma.user.findUnique({ where: { adminId } });
const expectStatus = (response, status, label) => assert.equal(response.status, status, `${label}: ${response.status} ${JSON.stringify(response.body)}`);
// A refusal changes nothing: same role and status, no audit entry.
async function assertUnchanged(target, label) {
    const now = await row(target.adminId);
    assert.deepEqual([now.role, now.status], [target.role, target.status], `${label}: the account is unchanged`);
    assert.equal(await prisma.auditLog.count({ where: { action: { in: ["UPDATE_USER_ROLE", "DEACTIVATE_USER", "INVITE_USER", "REACTIVATE_USER"] } } }), 0, `${label}: nothing audited`);
}

describe("the policy (requireRole.js)", () => {
    test("OWNER inherits every ADMIN tier and nothing else", () => {
        assert.ok(hasRole("OWNER", ["ADMIN"]));
        assert.ok(hasRole("OWNER", ["ADMIN", "ANALYST"]));
        assert.equal(hasRole("OWNER", ["ANALYST"]), false);
        assert.equal(hasRole("ADMIN", ["OWNER"]), false, "ADMIN never inherits OWNER");
    });

    test("who manages, assigns and invites what", () => {
        assert.deepEqual(Object.keys(ASSIGNABLE_ROLES), ["OWNER", "ADMIN"]);
        assert.deepEqual(ASSIGNABLE_ROLES.ADMIN, ["TEAM_LEAD", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]);
        assert.deepEqual(ASSIGNABLE_ROLES.OWNER, ["ADMIN", "TEAM_LEAD", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]);
        // An account with a retired (MANAGER) or unknown role: the OWNER only.
        for (const role of ["ADMIN", "TEAM_LEAD", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER", "MANAGER", "VIEWER"]) assert.ok(canManageAccount("OWNER", role), `OWNER manages ${role}`);
        for (const role of ["OWNER", "ADMIN", "MANAGER", "VIEWER"]) assert.equal(canManageAccount("ADMIN", role), false, `ADMIN never manages ${role}`);
        for (const actor of ["OWNER", "ADMIN"]) {
            assert.equal(canManageAccount(actor, "OWNER"), false, `${actor} never manages an OWNER`);
            assert.equal(canAssignRole(actor, "OWNER"), false, `${actor} never gives (or invites) OWNER`);
            assert.equal(canAssignRole(actor, "MANAGER"), false, `${actor} never gives (or invites) the retired MANAGER`);
        }
        assert.equal(canAssignRole("ADMIN", "ADMIN"), false, "ADMIN never gives ADMIN");
        for (const role of ["MANAGER", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]) {
            assert.equal(canManageAccount(role, "JOB_HANDLER"), false);
            assert.equal(canAssignRole(role, "JOB_HANDLER"), false);
        }
    });
});

describe("OWNER manages every account but an OWNER's", () => {
    test("OWNER changes an ADMIN's role and promotes to ADMIN (audited)", async () => {
        assert.equal((await setRole(U.owner, U.admin, "JOB_HANDLER")).body.user.role, "JOB_HANDLER");
        assert.equal((await setRole(U.owner, U.desk, "ADMIN")).body.user.role, "ADMIN");
        const entries = await prisma.auditLog.findMany({ where: { action: "UPDATE_USER_ROLE" }, orderBy: { createdDate: "asc" } });
        assert.deepEqual(entries.map((e) => [e.adminId, e.previousValue, e.newValue]), [["owner", "ADMIN", "JOB_HANDLER"], ["owner", "REGISTRATION_DESK", "ADMIN"]]);
    });

    test("OWNER deactivates an ADMIN, whose session stops working at once", async () => {
        expectStatus(await api(U.admin, "GET", "/users"), 200, "ADMIN before");
        assert.equal((await deactivate(U.owner, U.admin)).body.user.status, "INACTIVE");
        expectStatus(await api(U.admin, "GET", "/users"), 403, "ADMIN after");
    });

    test("OWNER manages the lower roles", async () => {
        assert.equal((await setRole(U.owner, U.analyst, "REGISTRATION_DESK")).body.user.role, "REGISTRATION_DESK");
        assert.equal((await deactivate(U.owner, U.handler)).body.user.status, "INACTIVE");
        assert.equal((await deactivate(U.owner, U.desk)).body.user.status, "INACTIVE");
    });

    test("OWNER invites ADMIN and every lower role, never an OWNER (403) or the retired MANAGER (400); nothing sent", async () => {
        for (const role of ["ADMIN", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]) {
            const result = await invite(U.owner, role, `invited-${role.toLowerCase()}@example.invalid`);
            expectStatus(result, 201, role);
            assert.equal(result.body.user.role, role);
        }
        const sent = authAdmin.calls.length;
        expectStatus(await invite(U.owner, "OWNER"), 403, "OWNER invites OWNER");
        expectStatus(await invite(U.owner, "MANAGER"), 400, "OWNER invites MANAGER");
        assert.equal(authAdmin.calls.length, sent);
        assert.equal(await prisma.user.count({ where: { email: "new.person@example.invalid" } }), 0);
    });

    test("OWNER re-invites a deactivated ADMIN (the same account comes back)", async () => {
        await prisma.user.update({ where: { adminId: "admin2" }, data: { status: "INACTIVE" } });
        authAdmin.users.set(U.admin2.email, { authUserId: U.admin2.authUserId, confirmed: true });
        const result = await invite(U.owner, "ADMIN", U.admin2.email);
        expectStatus(result, 200, "reactivate");
        assert.deepEqual([result.body.outcome, (await row("admin2")).status], ["REACTIVATED", "ACTIVE"]);
    });
});

describe("the OWNER is set in the database only", () => {
    test("nobody gives the OWNER role, the OWNER included (403 OWNER_LOCKED, no lesser role instead)", async () => {
        for (const [who, target] of [[U.owner, U.admin], [U.owner, U.legacy], [U.admin, U.analyst], [U.admin, U.handler]]) {
            const result = await setRole(who, target, "OWNER");
            assert.deepEqual([result.status, result.body.code], [403, "OWNER_LOCKED"], `${who.adminId} -> ${target.adminId}`);
            await assertUnchanged(target, `${who.adminId} gives OWNER`);
        }
        assert.equal(await prisma.user.count({ where: { role: "OWNER" } }), 1);
    });

    test("another OWNER account can't be demoted or deactivated by an OWNER (403 OWNER_LOCKED)", async () => {
        const other = await prisma.user.create({ data: user("owner2", "OWNER", 21) });
        for (const role of ["ADMIN", "ANALYST"]) {
            const result = await setRole(U.owner, other, role);
            assert.deepEqual([result.status, result.body.code], [403, "OWNER_LOCKED"], role);
        }
        assert.deepEqual([(await deactivate(U.owner, other)).body.code], ["OWNER_LOCKED"]);
        await assertUnchanged(other, "owner2");
    });

    test("the OWNER can't change their own account (400 SELF_CHANGE)", async () => {
        for (const role of ["ADMIN", "ANALYST"]) assert.equal((await setRole(U.owner, U.owner, role)).body.code, "SELF_CHANGE");
        assert.equal((await deactivate(U.owner, U.owner)).body.code, "SELF_CHANGE");
        await assertUnchanged(U.owner, "self");
    });

    test("an OWNER's email can't be re-invited, active or not (403 OWNER_LOCKED)", async () => {
        const other = await prisma.user.create({ data: user("owner2", "OWNER", 21, "INACTIVE") });
        for (const role of ["ADMIN", "ANALYST"]) {
            const result = await invite(U.owner, role, other.email);
            assert.deepEqual([result.status, result.body.code], [403, "OWNER_LOCKED"], role);
        }
        assert.deepEqual([(await row("owner2")).role, (await row("owner2")).status], ["OWNER", "INACTIVE"]);
        assert.equal(authAdmin.calls.length, 0);
    });
});

describe("ADMIN never manages ADMIN or OWNER accounts", () => {
    test("ADMIN cannot change another ADMIN's role (403)", async () => {
        for (const role of ["JOB_HANDLER", "ANALYST", "ADMIN"]) {
            const result = await setRole(U.admin, U.admin2, role);
            assert.deepEqual([result.status, result.body.code], [403, "OWNER_REQUIRED"], role);
        }
        assert.deepEqual([(await setRole(U.admin, U.admin2, "OWNER")).body.code], ["OWNER_LOCKED"]);
        await assertUnchanged(U.admin2, "ADMIN -> ADMIN role");
    });

    test("ADMIN cannot deactivate another ADMIN, or revoke a pending ADMIN invitation", async () => {
        expectStatus(await deactivate(U.admin, U.admin2), 403, "deactivate ADMIN");
        await assertUnchanged(U.admin2, "deactivate ADMIN");
        const pending = await prisma.user.create({ data: user("pending-admin", "ADMIN", 20, "INVITED") });
        expectStatus(await deactivate(U.admin, pending), 403, "revoke ADMIN invitation");
        assert.equal((await row("pending-admin")).status, "INVITED");
    });

    test("ADMIN cannot change or deactivate the OWNER", async () => {
        for (const role of ["ADMIN", "ANALYST", "JOB_HANDLER"]) expectStatus(await setRole(U.admin, U.owner, role), 403, `demote OWNER to ${role}`);
        expectStatus(await deactivate(U.admin, U.owner), 403, "deactivate OWNER");
        await assertUnchanged(U.owner, "OWNER");
    });

    test("ADMIN cannot give the ADMIN role, and gets no lesser role instead", async () => {
        const result = await setRole(U.admin, U.analyst, "ADMIN");
        assert.deepEqual([result.status, result.body.code], [403, "OWNER_REQUIRED"]);
        await assertUnchanged(U.analyst, "promotion");
    });

    test("ADMIN cannot invite an OWNER or an ADMIN (403 before Supabase)", async () => {
        for (const role of ["OWNER", "ADMIN", "owner", "Admin"]) expectStatus(await invite(U.admin, role), 403, role);
        assert.equal(authAdmin.calls.length, 0, "no invitation e-mail");
        assert.equal(await prisma.user.count({ where: { email: "new.person@example.invalid" } }), 0);
    });

    test("ADMIN cannot re-invite (reactivate, relabel) an ADMIN's or the OWNER's account", async () => {
        await prisma.user.update({ where: { adminId: "admin2" }, data: { status: "INACTIVE" } });
        await prisma.user.update({ where: { adminId: "owner" }, data: { status: "INACTIVE" } });
        for (const [target, code] of [[U.admin2, "OWNER_REQUIRED"], [U.owner, "OWNER_LOCKED"]]) {
            const result = await invite(U.admin, "ANALYST", target.email);
            assert.deepEqual([result.status, result.body.code], [403, code], target.adminId);
            assert.deepEqual([(await row(target.adminId)).role, (await row(target.adminId)).status], [target.role, "INACTIVE"]);
        }
        assert.equal(authAdmin.calls.length, 0);
    });

    test("a request body naming another actor or role changes nothing (the server reads the rows)", async () => {
        const result = await api(U.admin, "PUT", `/users/${U.admin2.adminId}/role`, { role: "ANALYST", actor: { role: "OWNER" }, user: { role: "OWNER" }, targetRole: "JOB_HANDLER" });
        expectStatus(result, 403, "spoofed actor");
        await assertUnchanged(U.admin2, "spoofed actor");
    });
});

describe("ADMIN keeps managing the roles below ADMIN", () => {
    test("role changes among ANALYST, REGISTRATION_DESK and JOB_HANDLER; never to the retired MANAGER (400)", async () => {
        assert.equal((await setRole(U.admin, U.analyst, "REGISTRATION_DESK")).body.user.role, "REGISTRATION_DESK");
        const retired = await setRole(U.admin, U.analyst, "MANAGER");
        assert.deepEqual([retired.status, retired.body.code], [400, "INVALID_ROLE"]);
        assert.equal((await row("analyst")).role, "REGISTRATION_DESK");
        assert.equal((await setRole(U.admin, U.desk, "JOB_HANDLER")).body.user.role, "JOB_HANDLER");
        assert.equal((await setRole(U.admin, U.handler, "REGISTRATION_DESK")).body.user.role, "REGISTRATION_DESK");
    });

    test("deactivating, inviting and re-inviting the lower roles", async () => {
        assert.equal((await deactivate(U.admin, U.analyst)).body.user.status, "INACTIVE");
        for (const role of ["ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]) expectStatus(await invite(U.admin, role, `${role.toLowerCase()}-new@example.invalid`), 201, role);
        expectStatus(await invite(U.admin, "MANAGER", "manager-new@example.invalid"), 400, "MANAGER (retired)");
        authAdmin.users.set(U.analyst.email, { authUserId: U.analyst.authUserId, confirmed: true });
        expectStatus(await invite(U.admin, "ANALYST", U.analyst.email), 200, "reactivate an ANALYST");
        assert.equal((await row("analyst")).status, "ACTIVE");
    });

    test("ADMIN still lists every user, the OWNER included", async () => {
        const { body } = await api(U.admin, "GET", "/users");
        assert.deepEqual(body.users.map((u) => u.userId).sort(), FIXTURES.map((u) => u.adminId).sort());
        assert.equal(body.users.find((u) => u.userId === "owner").role, "OWNER");
    });
});

describe("the other roles keep their access", () => {
    test("ANALYST, REGISTRATION_DESK, JOB_HANDLER and a retired MANAGER: no user management", async () => {
        for (const who of [U.legacy, U.analyst, U.desk, U.handler]) {
            expectStatus(await api(who, "GET", "/users"), 403, `${who.role} list`);
            expectStatus(await setRole(who, U.desk, "ANALYST"), 403, `${who.role} role change`);
            expectStatus(await deactivate(who, U.desk), 403, `${who.role} deactivate`);
            for (const role of ["OWNER", "ADMIN"]) expectStatus(await invite(who, role), 403, `${who.role} invites ${role}`);
        }
        assert.equal(authAdmin.calls.length, 0);
    });

    test("a retired MANAGER invites nobody, a Job Handler included", async () => {
        for (const role of ["JOB_HANDLER", "ANALYST"]) expectStatus(await invite(U.legacy, role), 403, `retired MANAGER invites ${role}`);
        assert.equal(authAdmin.calls.length, 0);
    });
});

describe("an account still holding the retired MANAGER role", () => {
    test("the OWNER converts it in Change Roles (to ADMIN: everything a MANAGER did), audited; it never goes back to MANAGER", async () => {
        const result = await setRole(U.owner, U.legacy, "ADMIN");
        expectStatus(result, 200, "convert");
        assert.equal(result.body.user.role, "ADMIN");
        const [entry] = await prisma.auditLog.findMany({ where: { action: "UPDATE_USER_ROLE" } });
        assert.deepEqual([entry.adminId, entry.previousValue, entry.newValue], ["owner", "MANAGER", "ADMIN"]);
        const back = await setRole(U.owner, U.legacy, "MANAGER");
        assert.deepEqual([back.status, back.body.code], [400, "INVALID_ROLE"]);
        assert.equal((await row("legacy")).role, "ADMIN");
    });

    test("an ADMIN can't change, deactivate or re-invite it (403 OWNER_REQUIRED): the OWNER decides", async () => {
        for (const role of ["ANALYST", "JOB_HANDLER"]) {
            const result = await setRole(U.admin, U.legacy, role);
            assert.deepEqual([result.status, result.body.code], [403, "OWNER_REQUIRED"], role);
        }
        assert.deepEqual([(await deactivate(U.admin, U.legacy)).body.code], ["OWNER_REQUIRED"]);
        const reinvite = await invite(U.admin, "ANALYST", U.legacy.email);
        assert.deepEqual([reinvite.status, reinvite.body.code], [403, "OWNER_REQUIRED"]);
        await assertUnchanged(U.legacy, "ADMIN -> retired MANAGER");
        assert.equal(authAdmin.calls.length, 0);
    });
});

describe("the actor is judged on the database rows", () => {
    test("an OWNER whose role was changed in the database loses the OWNER's reach at once", async () => {
        const stale = await row("owner");
        await prisma.user.update({ where: { adminId: "owner" }, data: { role: "ADMIN" } });
        await assert.rejects(updateUserRole({ db: prisma, actor: stale, userId: "admin2", role: "ANALYST" }), { status: 403, code: "OWNER_REQUIRED" });
        assert.equal((await row("admin2")).role, "ADMIN");
    });

    test("an actor whose role changed after the request was loaded is judged on the current row", async () => {
        const stale = await row("admin");
        await prisma.user.update({ where: { adminId: "admin" }, data: { role: "ANALYST" } });
        await assert.rejects(updateUserRole({ db: prisma, actor: stale, userId: "desk", role: "ANALYST" }), { status: 403, code: "FORBIDDEN" });
        await assert.rejects(deactivateUser({ db: prisma, actor: stale, userId: "desk" }), { status: 403, code: "FORBIDDEN" });
        assert.deepEqual([(await row("desk")).role, (await row("desk")).status], ["REGISTRATION_DESK", "ACTIVE"]);
    });

});
