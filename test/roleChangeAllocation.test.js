// A role change and the user's allocated candidates (workAllocationService.js unallocateForRoleChange).
// Only the NEW role decides: Registration Desk or Job Handler returns the user's active candidates to
// Unallocated, in the role change's own transaction; every other change keeps them. Completed
// placements (Departed, Cancelled, Rejected) keep their holder. On a REAL PostgreSQL (PGlite, every
// migration applied) through the real Prisma client. Synthetic data only.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { inviteUser, updateUserRole } from "../src/services/userAccountService.js";
import { convertRetiredRole } from "../src/services/retiredRoleService.js";
import { listAllocationCandidates } from "../src/services/workAllocationService.js";
import { listCandidateFilterOptions } from "../src/services/candidateListFilters.js";

const user = (adminId, role, name, n, status = "ACTIVE") => ({
    adminId, role, name, status, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
});
const OWNER = user("u-owner", "OWNER", "Olive Owner", 1);
const ADMIN = user("u-admin", "ADMIN", "Ada Admin", 2);
const TARGET = user("u-target", "ANALYST", "Tess Target", 3);
const OTHER = user("u-other", "ANALYST", "Oscar Other", 4);
const pid = (i) => `P${String(i).padStart(7, "0")}`;

let database;
let prisma;
let pg;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const u of [OWNER, ADMIN, TARGET, OTHER]) await prisma.user.create({ data: u });
});
after(async () => database?.close());

beforeEach(async () => {
    await pg.exec(`
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "candidate_allocation"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
        UPDATE "user" SET "role" = 'ANALYST', "status" = 'ACTIVE' WHERE "admin_id" IN ('u-target', 'u-other');
        INSERT INTO "candidate" ("passport_id", "unique_id", "first_name", "other_name", "job", "whatsapp_number", "contact_number", "created_date", "updated_date")
        SELECT 'P' || lpad(i::text, 7, '0'), lpad(i::text, 4, '0'), 'Given' || i, 'Surname', 'Driver',
               '9477' || lpad(i::text, 7, '0'), '071' || lpad(i::text, 7, '0'), now(), now()
        FROM generate_series(1, 8) AS i;
    `);
    // Target: P1, P2, P3 active; P4 Departed, P5 Cancelled, P6 Rejected (completed). Other: P7.
    await prisma.candidateAllocation.createMany({
        data: [1, 2, 3, 4, 5, 6].map((i) => ({ passportId: pid(i), analystId: TARGET.adminId })).concat({ passportId: pid(7), analystId: OTHER.adminId }),
    });
    const at = new Date();
    await prisma.candidate.update({ where: { passportId: pid(4) }, data: { departedAt: at } });
    await prisma.candidate.update({ where: { passportId: pid(5) }, data: { outcome: "CANCELLED", outcomeAt: at } });
    await prisma.candidate.update({ where: { passportId: pid(6) }, data: { outcome: "REJECTED", outcomeAt: at } });
});

const setRole = (adminId, role) => prisma.user.update({ where: { adminId }, data: { role } });
const allocations = async () => Object.fromEntries((await prisma.candidateAllocation.findMany({ orderBy: { passportId: "asc" } })).map((row) => [row.passportId, row.analystId]));
const ALL_KEPT = { [pid(1)]: TARGET.adminId, [pid(2)]: TARGET.adminId, [pid(3)]: TARGET.adminId, [pid(4)]: TARGET.adminId, [pid(5)]: TARGET.adminId, [pid(6)]: TARGET.adminId, [pid(7)]: OTHER.adminId };
// Active candidates unallocated; the completed placements (and the other user's candidate) untouched.
const ACTIVE_UNALLOCATED = { [pid(4)]: TARGET.adminId, [pid(5)]: TARGET.adminId, [pid(6)]: TARGET.adminId, [pid(7)]: OTHER.adminId };
const unassignAudits = () => prisma.auditLog.findMany({ where: { action: "UNASSIGN_CANDIDATE" }, orderBy: { passportId: "asc" } });

describe("role change keeps allocations unless the new role is Registration Desk or Job Handler", () => {
    for (const [from, to, actor] of [
        ["ANALYST", "TEAM_LEAD", ADMIN],
        ["ANALYST", "ADMIN", OWNER],
        ["TEAM_LEAD", "ANALYST", ADMIN],
        ["ADMIN", "TEAM_LEAD", OWNER],
    ]) {
        test(`${from} -> ${to}: every allocation stays with the same user`, async () => {
            await setRole(TARGET.adminId, from);
            const result = await updateUserRole({ db: prisma, actor, userId: TARGET.adminId, role: to });
            assert.equal(result.role, to);
            assert.deepEqual(await allocations(), ALL_KEPT);
            assert.equal((await unassignAudits()).length, 0);
        });
    }

    for (const [from, to] of [["TEAM_LEAD", "REGISTRATION_DESK"], ["ANALYST", "JOB_HANDLER"]]) {
        test(`${from} -> ${to}: active candidates go to Unallocated, completed ones keep their holder, each audited`, async () => {
            await setRole(TARGET.adminId, from);
            await updateUserRole({ db: prisma, actor: ADMIN, userId: TARGET.adminId, role: to });
            assert.equal((await prisma.user.findUnique({ where: { adminId: TARGET.adminId } })).role, to);
            assert.deepEqual(await allocations(), ACTIVE_UNALLOCATED);
            const audits = await unassignAudits();
            assert.deepEqual(audits.map((row) => row.passportId), [pid(1), pid(2), pid(3)]);
            for (const row of audits) {
                assert.equal(row.adminId, ADMIN.adminId);
                assert.equal(row.previousStatus, "ALLOCATED");
                assert.equal(row.newStatus, "UNALLOCATED");
                assert.equal(row.reason, `Unassigned from ${TARGET.name}: role changed to ${to}`);
                assert.deepEqual(JSON.parse(row.previousValue), { analystId: TARGET.adminId, name: TARGET.name });
            }
        });
    }

    test("a user with no allocated candidates: any role change works without errors", async () => {
        await prisma.candidateAllocation.deleteMany({ where: { analystId: TARGET.adminId } });
        for (const role of ["TEAM_LEAD", "REGISTRATION_DESK", "JOB_HANDLER", "ANALYST"]) {
            assert.equal((await updateUserRole({ db: prisma, actor: ADMIN, userId: TARGET.adminId, role })).role, role);
        }
        assert.deepEqual(await allocations(), { [pid(7)]: OTHER.adminId });
        assert.equal((await unassignAudits()).length, 0);
    });

    test("only completed candidates -> Job Handler: they are unchanged", async () => {
        await prisma.candidateAllocation.deleteMany({ where: { passportId: { in: [pid(1), pid(2), pid(3)] } } });
        await updateUserRole({ db: prisma, actor: ADMIN, userId: TARGET.adminId, role: "JOB_HANDLER" });
        assert.deepEqual(await allocations(), ACTIVE_UNALLOCATED);
        assert.equal((await unassignAudits()).length, 0);
    });

    test("a failure during the change leaves the role and every allocation unchanged", async () => {
        // The unallocation's audit write fails, after the role update and the allocation delete ran.
        const failing = {
            $transaction: (fn) => prisma.$transaction((tx) => fn(new Proxy(tx, {
                get(target, prop) {
                    if (prop !== "auditLog") return target[prop];
                    return { ...target.auditLog, create: (args) => target.auditLog.create(args), createMany: async () => { throw new Error("audit write failed"); } };
                },
            }))),
        };
        await assert.rejects(updateUserRole({ db: failing, actor: ADMIN, userId: TARGET.adminId, role: "REGISTRATION_DESK" }), /audit write failed/);
        assert.equal((await prisma.user.findUnique({ where: { adminId: TARGET.adminId } })).role, "ANALYST");
        assert.deepEqual(await allocations(), ALL_KEPT);
        assert.equal(await prisma.auditLog.count(), 0);
    });
});

describe("a promoted or demoted holder is not shown as inactive", () => {
    const holderOf = async (passportId) => {
        const list = await listAllocationCandidates({ db: prisma, params: { page: 1, pageSize: 100, status: "ALLOCATED" } });
        return list.items.find((item) => item.passportId === passportId)?.analyst;
    };
    const officerOf = async (adminId) => (await listCandidateFilterOptions({ db: prisma, user: ADMIN })).officers.find((o) => o.id === adminId);

    for (const [from, to, actor] of [["ANALYST", "ADMIN", OWNER], ["ANALYST", "TEAM_LEAD", ADMIN], ["TEAM_LEAD", "ANALYST", ADMIN]]) {
        test(`${from} -> ${to}: Work Allocation and the Officer filter show the holder as active`, async () => {
            await setRole(TARGET.adminId, from);
            await updateUserRole({ db: prisma, actor, userId: TARGET.adminId, role: to });
            assert.deepEqual(await holderOf(pid(1)), { analystId: TARGET.adminId, name: TARGET.name, role: to, active: true });
            assert.equal((await officerOf(TARGET.adminId)).active, true);
        });
    }

    test("a deactivated holder is still shown as inactive", async () => {
        await prisma.user.update({ where: { adminId: TARGET.adminId }, data: { status: "INACTIVE" } });
        assert.equal((await holderOf(pid(1))).active, false);
        assert.equal((await officerOf(TARGET.adminId)).active, false);
    });
});

describe("the other role-change paths follow the same rule", () => {
    test("re-inviting an INACTIVE account as Registration Desk unallocates its active candidates", async () => {
        await prisma.user.update({ where: { adminId: TARGET.adminId }, data: { status: "INACTIVE" } });
        const authAdmin = { inviteUserByEmail: async () => ({ authUserId: TARGET.authUserId }) };
        await inviteUser({ db: prisma, authAdmin, actor: ADMIN, values: { email: TARGET.email, name: TARGET.name, role: "REGISTRATION_DESK" }, redirectTo: "https://example.invalid/admin/setup-password" });
        assert.deepEqual(await allocations(), ACTIVE_UNALLOCATED);
    });

    test("re-inviting as Analyst keeps them", async () => {
        await prisma.user.update({ where: { adminId: TARGET.adminId }, data: { status: "INACTIVE" } });
        const authAdmin = { inviteUserByEmail: async () => ({ authUserId: TARGET.authUserId }) };
        await inviteUser({ db: prisma, authAdmin, actor: ADMIN, values: { email: TARGET.email, name: TARGET.name, role: "ANALYST" }, redirectTo: "https://example.invalid/admin/setup-password" });
        assert.deepEqual(await allocations(), ALL_KEPT);
    });

    test("converting a retired role to Job Handler unallocates; to Team Lead keeps", async () => {
        await setRole(TARGET.adminId, "MANAGER");
        await convertRetiredRole({ db: prisma, retiredRole: "MANAGER", replacementRole: "TEAM_LEAD", actorId: OWNER.adminId });
        assert.deepEqual(await allocations(), ALL_KEPT);

        await setRole(TARGET.adminId, "MANAGER");
        const converted = await convertRetiredRole({ db: prisma, retiredRole: "MANAGER", replacementRole: "JOB_HANDLER", actorId: OWNER.adminId });
        assert.deepEqual(converted, [{ adminId: TARGET.adminId, status: "ACTIVE" }]);
        assert.deepEqual(await allocations(), ACTIVE_UNALLOCATED);
    });
});
