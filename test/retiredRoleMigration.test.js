// Converting the accounts that still hold the retired MANAGER role (src/services/retiredRoleService.js,
// scripts/migrateManagerRole.js). On a REAL PostgreSQL (PGlite, every migration applied) through the
// real Prisma client: every MANAGER account, whatever its status, becomes the replacement role in one
// transaction, as the ACTIVE OWNER, audited like Change Roles; nothing else changes; a second run
// changes nothing.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { RETIRED_ROLES, isValidRole } from "../src/middleware/requireRole.js";
import { DEFAULT_REPLACEMENT_ROLE, convertRetiredRole, findRetiredRoleAccounts } from "../src/services/retiredRoleService.js";

const user = (adminId, role, n, status = "ACTIVE") => ({ adminId, role, status, name: `${adminId} user`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const FIXTURES = [
    user("owner", "OWNER", 1),
    user("admin", "ADMIN", 2),
    user("analyst", "ANALYST", 3),
    user("m-active", "MANAGER", 4),
    user("m-invited", "MANAGER", 5, "INVITED"),
    user("m-inactive", "MANAGER", 6, "INACTIVE"),
];
const MANAGER = RETIRED_ROLES.MANAGER;

let database;
let prisma;
let pg;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
});
after(async () => database?.close());
beforeEach(async () => {
    await pg.exec(`ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER; DELETE FROM "user";`);
    for (const u of FIXTURES) await prisma.user.create({ data: u });
});

const roles = async () => Object.fromEntries((await prisma.user.findMany({ select: { adminId: true, role: true, status: true } })).map((u) => [u.adminId, `${u.role}/${u.status}`]));

describe("the retired MANAGER role", () => {
    test("is not a valid role, and its replacement is ADMIN (the business decision)", () => {
        assert.equal(isValidRole(MANAGER), false);
        assert.equal(DEFAULT_REPLACEMENT_ROLE.MANAGER, "ADMIN");
    });

    test("the dry run lists every MANAGER account (IDs and statuses only) and changes nothing", async () => {
        const before = await roles();
        const accounts = await findRetiredRoleAccounts({ db: prisma, retiredRole: MANAGER });
        assert.deepEqual(accounts, [{ adminId: "m-active", status: "ACTIVE" }, { adminId: "m-inactive", status: "INACTIVE" }, { adminId: "m-invited", status: "INVITED" }]);
        assert.deepEqual(await roles(), before);
        await assert.rejects(findRetiredRoleAccounts({ db: prisma, retiredRole: "ANALYST" }), { code: "NOT_RETIRED" });
    });

    test("converts every MANAGER account to ADMIN in one go, keeping each status; audited as the OWNER; nothing else changes", async () => {
        const converted = await convertRetiredRole({ db: prisma, retiredRole: MANAGER, replacementRole: "ADMIN", actorId: "owner" });
        assert.equal(converted.length, 3);
        assert.deepEqual(await roles(), {
            owner: "OWNER/ACTIVE", admin: "ADMIN/ACTIVE", analyst: "ANALYST/ACTIVE",
            "m-active": "ADMIN/ACTIVE", "m-invited": "ADMIN/INVITED", "m-inactive": "ADMIN/INACTIVE",
        });
        const entries = await prisma.auditLog.findMany({ where: { action: "UPDATE_USER_ROLE" }, orderBy: { reason: "asc" } });
        assert.deepEqual(entries.map((e) => [e.adminId, e.previousValue, e.newValue, e.previousStatus, e.newStatus]), Array(3).fill(["owner", "MANAGER", "ADMIN", "MANAGER", "ADMIN"]));
        assert.deepEqual(entries.map((e) => e.reason), ["m-active", "m-inactive", "m-invited"].map((id) => `Retired role MANAGER converted for user ${id}`));
        assert.equal(await prisma.user.count({ where: { role: MANAGER } }), 0, "no account is left with the retired role");
    });

    test("a second run changes nothing and writes no audit entry", async () => {
        await convertRetiredRole({ db: prisma, retiredRole: MANAGER, replacementRole: "ADMIN", actorId: "owner" });
        const after = await roles();
        assert.deepEqual(await convertRetiredRole({ db: prisma, retiredRole: MANAGER, replacementRole: "ADMIN", actorId: "owner" }), []);
        assert.deepEqual(await roles(), after);
        assert.equal(await prisma.auditLog.count(), 3);
    });

    test("another supported replacement may be chosen, never OWNER, MANAGER or an unknown role", async () => {
        for (const replacementRole of ["OWNER", "MANAGER", "VIEWER", "", undefined]) {
            await assert.rejects(convertRetiredRole({ db: prisma, retiredRole: MANAGER, replacementRole, actorId: "owner" }), { code: "INVALID_ROLE" }, String(replacementRole));
        }
        assert.equal(await prisma.user.count({ where: { role: MANAGER } }), 3);
        assert.equal((await convertRetiredRole({ db: prisma, retiredRole: MANAGER, replacementRole: "ANALYST", actorId: "owner" })).length, 3);
        assert.equal(await prisma.user.count({ where: { role: "ANALYST" } }), 4);
    });

    test("runs only as the ACTIVE OWNER: an ADMIN, an inactive OWNER, a MANAGER or nobody is refused and nothing changes", async () => {
        const before = await roles();
        await prisma.user.create({ data: user("owner-off", "OWNER", 7, "INACTIVE") });
        for (const actorId of ["admin", "owner-off", "m-active", "nobody", undefined]) {
            await assert.rejects(convertRetiredRole({ db: prisma, retiredRole: MANAGER, replacementRole: "ADMIN", actorId }), { code: "OWNER_REQUIRED" }, String(actorId));
        }
        await prisma.user.delete({ where: { adminId: "owner-off" } });
        assert.deepEqual(await roles(), before);
        assert.equal(await prisma.auditLog.count(), 0);
    });
});
