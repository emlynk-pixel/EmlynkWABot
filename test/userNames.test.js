// User names (userAccountService.js parseNameBody / updateOwnName / updateUserName):
//   every user changes their own name (PUT /auth/me/name);
//   OWNER and ADMIN change another user's (PUT /api/admin/users/:userId/name), any account but the Owner's
//   (an ADMIN may rename another ADMIN); only the name changes; audited UPDATE_USER_NAME.
// On a REAL PostgreSQL (PGlite, every migration applied) through the real routers and services; the
// Supabase session is the test fake (tokenFor). SYNTHETIC users only.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { authIdFor, createFakeAuthAdmin, fakeVerifyAccessToken, tokenFor } from "./helpers/fakeSupabaseAuth.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createAuthRouter } from "../src/routes/auth.js";
import { createRequireActiveUser } from "../src/middleware/requireActiveUser.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { parseNameBody } from "../src/services/userAccountService.js";

const user = (adminId, role, status = "ACTIVE") => ({
    adminId, role, status, name: `${adminId} name`, email: `${adminId}@example.invalid`, authUserId: authIdFor(adminId),
    ...(status === "INVITED" ? {} : { activatedAt: new Date("2026-10-01T00:00:00Z") }),
});
const FIXTURES = [user("owner", "OWNER"), user("admin", "ADMIN"), user("admin2", "ADMIN"), user("lead", "TEAM_LEAD"), user("analyst", "ANALYST"), user("desk", "REGISTRATION_DESK"), user("handler", "JOB_HANDLER"), user("invited", "ANALYST", "INVITED")];
const U = Object.fromEntries(FIXTURES.map((u) => [u.adminId, u]));

let database;
let prisma;
let pg;
let server;
let baseUrl;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    const app = express();
    app.use(express.json());
    app.use("/auth", createAuthRouter({ db: prisma, verifyAccessToken: fakeVerifyAccessToken, apiLimiter: noRateLimit }));
    app.use("/api/admin", createAdminRouter({ db: prisma, bucket: {}, authAdmin: createFakeAuthAdmin(), requireAdmin: createRequireActiveUser({ db: prisma, verifyAccessToken: fakeVerifyAccessToken }), apiLimiter: noRateLimit }));
    app.use(errorHandler);
    await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    server?.close();
    await database?.close();
});
beforeEach(async () => {
    await pg.exec(`ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER; DELETE FROM "rate_limits"; DELETE FROM "user";`);
    for (const u of FIXTURES) await prisma.user.create({ data: u });
});

async function call(who, method, path, body) {
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${tokenFor(who.adminId)}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
}
const renameSelf = (who, name) => call(who, "PUT", "/auth/me/name", { name });
const rename = (who, target, name) => call(who, "PUT", `/api/admin/users/${target.adminId}/name`, { name });
const row = (adminId) => prisma.user.findUnique({ where: { adminId } });
const nameAudits = () => prisma.auditLog.findMany({ where: { action: "UPDATE_USER_NAME" }, orderBy: { createdDate: "asc" } });

describe("own name (the profile menu)", () => {
    test("every role changes its own name; only the name changes; audited old -> new", async () => {
        for (const who of FIXTURES.filter((u) => u.status === "ACTIVE")) {
            const { status, body } = await renameSelf(who, `  New   ${who.adminId}  `);
            assert.equal(status, 200, who.adminId);
            assert.deepEqual(body.user, { userId: who.adminId, email: who.email, name: `New ${who.adminId}`, role: who.role, status: "ACTIVE" }, "the new profile, spaces tidied");
            const now = await row(who.adminId);
            assert.deepEqual([now.name, now.email, now.role, now.status], [`New ${who.adminId}`, who.email, who.role, who.status]);
        }
        const audits = await nameAudits();
        assert.equal(audits.length, 7);
        const ownerEntry = audits.find((a) => a.adminId === "owner");
        assert.deepEqual([ownerEntry.previousValue, ownerEntry.newValue, ownerEntry.reason], ["owner name", "New owner", "Name changed"]);
    });

    test("the same name again writes nothing; a blank or too long name is 400", async () => {
        assert.equal((await renameSelf(U.analyst, "analyst name")).status, 200);
        assert.equal((await nameAudits()).length, 0, "unchanged: no audit entry");
        for (const name of ["", "   ", "x".repeat(101)]) assert.equal((await renameSelf(U.analyst, name)).status, 400, JSON.stringify(name));
        assert.equal((await call(U.analyst, "PUT", "/auth/me/name", { name: 5 })).status, 400);
        assert.equal((await row("analyst")).name, "analyst name");
    });

    test("a user who is not active (an invitation not accepted) can't", async () => {
        assert.notEqual((await renameSelf(U.invited, "Someone")).status, 200);
        assert.equal((await row("invited")).name, "invited name");
    });
});

describe("another user's name (Settings > Change Roles)", () => {
    test("an Admin renames any account but the Owner's, another Admin included", async () => {
        for (const target of [U.admin2, U.lead, U.analyst, U.desk, U.handler, U.invited]) {
            const { status, body } = await rename(U.admin, target, `Renamed ${target.adminId}`);
            assert.equal(status, 200, target.adminId);
            assert.equal(body.user.name, `Renamed ${target.adminId}`);
            const now = await row(target.adminId);
            assert.deepEqual([now.email, now.role, now.status], [target.email, target.role, target.status], "only the name");
        }
        const refused = await rename(U.admin, U.owner, "Not allowed");
        assert.deepEqual([refused.status, refused.body.code], [403, "OWNER_LOCKED"]);
        assert.equal((await row("owner")).name, "owner name");
        const entry = (await nameAudits()).find((a) => a.newValue === "Renamed admin2");
        assert.deepEqual([entry.adminId, entry.previousValue, entry.reason], ["admin", "admin2 name", "Name changed for user admin2"]);
    });

    test("the Owner renames every other account", async () => {
        for (const target of [U.admin, U.admin2, U.analyst]) assert.equal((await rename(U.owner, target, `By owner ${target.adminId}`)).status, 200, target.adminId);
        assert.equal((await row("admin")).name, "By owner admin");
    });

    test("your own account goes through the profile (SELF_CHANGE here)", async () => {
        const self = await rename(U.admin, U.admin, "Me");
        assert.deepEqual([self.status, self.body.code], [400, "SELF_CHANGE"]);
    });

    test("the other roles can't rename anyone (403), and nothing changes", async () => {
        for (const who of [U.lead, U.analyst, U.desk, U.handler]) assert.equal((await rename(who, U.desk === who ? U.analyst : U.desk, "Hacked")).status, 403, who.adminId);
        assert.equal((await nameAudits()).length, 0);
        assert.equal((await row("desk")).name, "desk name");
    });

    test("an unknown user is 404; a bad name is 400", async () => {
        assert.equal((await call(U.admin, "PUT", "/api/admin/users/nobody/name", { name: "X" })).status, 404);
        assert.equal((await rename(U.admin, U.analyst, "")).status, 400);
    });
});

describe("parseNameBody", () => {
    test("trimmed, inner spaces collapsed, 1 to 100 characters", () => {
        assert.deepEqual(parseNameBody({ name: "  Ana   Perera " }), { values: { name: "Ana Perera" } });
        assert.ok(parseNameBody({ name: "x".repeat(100) }).values);
        for (const body of [{ name: "x".repeat(101) }, { name: "" }, {}, null, [], { name: 7 }]) assert.ok(parseNameBody(body).errors, JSON.stringify(body));
    });
});
