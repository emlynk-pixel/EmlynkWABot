// Equal automatic Work Allocation tests (ALLOC-EQUAL-001 through ALLOC-EQUAL-017)
// Runs on a real PostgreSQL database (PGlite) through Prisma and the real admin router.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

const user = (adminId, role, name, status = "ACTIVE", n = 1) => ({
    adminId, role, name, status, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
});

const USERS = {
    ADMIN: user("u-admin", "ADMIN", "Ada Admin", "ACTIVE", 1),
    MANAGER: user("u-manager", "MANAGER", "Max Manager", "ACTIVE", 2),
    DESK: user("u-desk", "REGISTRATION_DESK", "Dee Desk", "ACTIVE", 3),
    ANN: user("u-ann", "ANALYST", "Ann Analyst", "ACTIVE", 4),
    BEN: user("u-ben", "ANALYST", "Ben Analyst", "ACTIVE", 5),
    CAL: user("u-cal", "ANALYST", "Cal Analyst", "ACTIVE", 6),
    DAN: user("u-dan", "ANALYST", "Dan Analyst", "ACTIVE", 7),
    GONE: user("u-gone", "ANALYST", "Gus Gone", "INACTIVE", 8),
};

const TOTAL = 120;
const pid = (i) => `P${String(i).padStart(7, "0")}`;

let database;
let prisma;
let pg;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const u of Object.values(USERS)) await prisma.user.create({ data: u });
});

after(async () => database?.close());

beforeEach(async () => {
    await pg.exec(`
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "call_log_follow_up"; DELETE FROM "candidate_call_logs"; DELETE FROM "candidate_allocation";
        DELETE FROM "candidate_additional_details"; DELETE FROM "documents"; DELETE FROM "temporary_data"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
        DELETE FROM "sheet_sync_queue";
        UPDATE "user" SET "role" = 'ANALYST', "status" = 'ACTIVE' WHERE "admin_id" IN ('u-ann', 'u-ben', 'u-cal', 'u-dan');
        INSERT INTO "candidate" ("passport_id", "unique_id", "first_name", "other_name", "job", "whatsapp_number", "contact_number", "created_date", "updated_date")
        SELECT 'P' || lpad(i::text, 7, '0'), lpad(i::text, 4, '0'), 'Given' || i, 'Surname', 'Driver',
               '9477' || lpad(i::text, 7, '0'), '071' || lpad(i::text, 7, '0'),
               timestamp '2026-01-01 00:00:00' + i * interval '1 minute', now()
        FROM generate_series(1, ${TOTAL}) AS i;
    `);
});

async function api(who, method, path, body) {
    const app = express();
    app.use(express.json());
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: who.adminId }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
        next();
    };
    app.use("/api/admin", createAdminRouter({ db: prisma, bucket: {}, requireAdmin, apiLimiter: noRateLimit }));
    app.use(errorHandler);
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin${path}`, {
            method,
            headers: body === undefined ? {} : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    } finally {
        server.close();
    }
}

const autoAllocate = (who, candidateIds, analystIds) => api(who, "POST", "/work-allocation/auto-allocate", { candidateIds, analystIds });
const allocations = async () => Object.fromEntries((await prisma.candidateAllocation.findMany()).map((row) => [row.passportId, row.analystId]));
const countAllocationsByAnalyst = async () => {
    const rows = await prisma.candidateAllocation.findMany();
    const counts = {};
    for (const r of rows) counts[r.analystId] = (counts[r.analystId] || 0) + 1;
    return counts;
};

describe("Equal Work Allocation: core rules and distribution", () => {
    test("ALLOC-EQUAL-001: 100 candidates + 4 analysts => exactly 25 each", async () => {
        const candidateIds = Array.from({ length: 100 }, (_, i) => pid(i + 1));
        const analystIds = [USERS.ANN.adminId, USERS.BEN.adminId, USERS.CAL.adminId, USERS.DAN.adminId];

        const { status, body } = await autoAllocate(USERS.ADMIN, candidateIds, analystIds);
        assert.equal(status, 200);
        assert.equal(body.selectedCount, 100);
        assert.equal(body.eligibleCount, 100);
        assert.equal(body.allocatedCount, 100);
        assert.equal(body.equalAllocationCount, 25);
        assert.equal(body.remainderCount, 0);
        assert.equal(body.analystCount, 4);

        for (const analyst of body.byAnalyst) {
            assert.equal(analyst.count, 25);
        }

        const counts = await countAllocationsByAnalyst();
        assert.equal(counts[USERS.ANN.adminId], 25);
        assert.equal(counts[USERS.BEN.adminId], 25);
        assert.equal(counts[USERS.CAL.adminId], 25);
        assert.equal(counts[USERS.DAN.adminId], 25);
    });

    test("ALLOC-EQUAL-002: 103 candidates + 4 analysts => exactly 25 each + 3 unallocated", async () => {
        const candidateIds = Array.from({ length: 103 }, (_, i) => pid(i + 1));
        const analystIds = [USERS.ANN.adminId, USERS.BEN.adminId, USERS.CAL.adminId, USERS.DAN.adminId];

        const { status, body } = await autoAllocate(USERS.MANAGER, candidateIds, analystIds);
        assert.equal(status, 200);
        assert.equal(body.selectedCount, 103);
        assert.equal(body.eligibleCount, 103);
        assert.equal(body.allocatedCount, 100);
        assert.equal(body.equalAllocationCount, 25);
        assert.equal(body.remainderCount, 3);
        assert.equal(body.unallocatedCandidateIds.length, 3);

        const counts = await countAllocationsByAnalyst();
        assert.equal(counts[USERS.ANN.adminId], 25);
        assert.equal(counts[USERS.BEN.adminId], 25);
        assert.equal(counts[USERS.CAL.adminId], 25);
        assert.equal(counts[USERS.DAN.adminId], 25);

        // Remainder candidates must NOT be in candidate_allocation table
        const allAlloc = await allocations();
        for (const remId of body.unallocatedCandidateIds) {
            assert.equal(allAlloc[remId], undefined);
        }
    });

    test("ALLOC-EQUAL-003: 1 candidate + 2 analysts => 0 allocated + 1 unallocated", async () => {
        const candidateIds = [pid(1)];
        const analystIds = [USERS.ANN.adminId, USERS.BEN.adminId];

        const { status, body } = await autoAllocate(USERS.ADMIN, candidateIds, analystIds);
        assert.equal(status, 200);
        assert.equal(body.selectedCount, 1);
        assert.equal(body.eligibleCount, 1);
        assert.equal(body.allocatedCount, 0);
        assert.equal(body.equalAllocationCount, 0);
        assert.equal(body.remainderCount, 1);
        assert.deepEqual(body.unallocatedCandidateIds, [pid(1)]);

        const allAlloc = await allocations();
        assert.equal(allAlloc[pid(1)], undefined);
        assert.equal(Object.keys(allAlloc).length, 0);
    });

    test("ALLOC-EQUAL-004: 4 candidates + 1 analyst => all 4 assigned", async () => {
        const candidateIds = [pid(1), pid(2), pid(3), pid(4)];
        const analystIds = [USERS.ANN.adminId];

        const { status, body } = await autoAllocate(USERS.MANAGER, candidateIds, analystIds);
        assert.equal(status, 200);
        assert.equal(body.selectedCount, 4);
        assert.equal(body.eligibleCount, 4);
        assert.equal(body.allocatedCount, 4);
        assert.equal(body.equalAllocationCount, 4);
        assert.equal(body.remainderCount, 0);

        const allAlloc = await allocations();
        for (const id of candidateIds) {
            assert.equal(allAlloc[id], USERS.ANN.adminId);
        }
    });

    test("ALLOC-EQUAL-005: No analysts selected => rejected", async () => {
        const { status, body } = await autoAllocate(USERS.ADMIN, [pid(1)], []);
        assert.equal(status, 400);
        assert.ok(body.errors.some((e) => e.field === "analystIds"));
        assert.equal(await prisma.candidateAllocation.count(), 0);
    });

    test("ALLOC-EQUAL-006: No candidates selected => rejected", async () => {
        const { status, body } = await autoAllocate(USERS.ADMIN, [], [USERS.ANN.adminId]);
        assert.equal(status, 400);
        assert.ok(body.errors.some((e) => e.field === "candidateIds"));
        assert.equal(await prisma.candidateAllocation.count(), 0);
    });

    test("ALLOC-EQUAL-007: Already allocated candidate => no duplicate/reassignment", async () => {
        // Pre-allocate P1 to Ann
        await prisma.candidateAllocation.create({ data: { passportId: pid(1), analystId: USERS.ANN.adminId } });

        // Request auto-allocation for P1, P2, P3 across Ben and Cal
        const { status, body } = await autoAllocate(USERS.ADMIN, [pid(1), pid(2), pid(3)], [USERS.BEN.adminId, USERS.CAL.adminId]);
        assert.equal(status, 200);
        assert.equal(body.selectedCount, 3);
        assert.equal(body.eligibleCount, 2); // P2, P3 are eligible
        assert.equal(body.conflictsCount, 1);
        assert.equal(body.skippedCount, 1);
        assert.deepEqual(body.skippedCandidateIds, [pid(1)]);
        assert.equal(body.equalAllocationCount, 1); // floor(2 / 2) = 1
        assert.equal(body.allocatedCount, 2);

        // P1 MUST STILL belong to Ann, not Ben or Cal!
        const allAlloc = await allocations();
        assert.equal(allAlloc[pid(1)], USERS.ANN.adminId, "already allocated candidate was NOT reassigned");
        assert.ok([USERS.BEN.adminId, USERS.CAL.adminId].includes(allAlloc[pid(2)]));
        assert.ok([USERS.BEN.adminId, USERS.CAL.adminId].includes(allAlloc[pid(3)]));
        // Verify exactly one allocation row exists for P1
        assert.equal(await prisma.candidateAllocation.count({ where: { passportId: pid(1) } }), 1);
    });

    test("ALLOC-EQUAL-008: Duplicate candidate IDs in request => cannot create duplicates", async () => {
        const { status, body } = await autoAllocate(USERS.ADMIN, [pid(1), pid(1)], [USERS.ANN.adminId]);
        assert.equal(status, 400);
        assert.ok(body.errors.some((e) => e.field === "candidateIds" && e.message.includes("must not repeat")));
        assert.equal(await prisma.candidateAllocation.count(), 0);
    });

    test("ALLOC-EQUAL-009: Duplicate analyst IDs => handled safely/rejected", async () => {
        const { status, body } = await autoAllocate(USERS.ADMIN, [pid(1), pid(2)], [USERS.ANN.adminId, USERS.ANN.adminId]);
        assert.equal(status, 400);
        assert.ok(body.errors.some((e) => e.field === "analystIds" && e.message.includes("must not repeat")));
        assert.equal(await prisma.candidateAllocation.count(), 0);
    });

    test("ALLOC-EQUAL-010: ANALYST role => 403", async () => {
        const { status } = await autoAllocate(USERS.ANN, [pid(1)], [USERS.ANN.adminId]);
        assert.equal(status, 403);
        assert.equal(await prisma.candidateAllocation.count(), 0);
    });

    test("ALLOC-EQUAL-011: REGISTRATION_DESK => 403", async () => {
        const { status } = await autoAllocate(USERS.DESK, [pid(1)], [USERS.ANN.adminId]);
        assert.equal(status, 403);
        assert.equal(await prisma.candidateAllocation.count(), 0);
    });

    test("ALLOC-EQUAL-012: ADMIN => allowed", async () => {
        const { status, body } = await autoAllocate(USERS.ADMIN, [pid(1)], [USERS.ANN.adminId]);
        assert.equal(status, 200);
        assert.equal(body.allocatedCount, 1);
    });

    test("ALLOC-EQUAL-013: MANAGER => allowed", async () => {
        const { status, body } = await autoAllocate(USERS.MANAGER, [pid(2)], [USERS.BEN.adminId]);
        assert.equal(status, 200);
        assert.equal(body.allocatedCount, 1);
    });

    test("ALLOC-EQUAL-014: Two concurrent allocation requests targeting the same candidates => a candidate cannot receive two active analyst assignments", async () => {
        const candidateIds = [pid(10), pid(11), pid(12)];
        const [res1, res2] = await Promise.all([
            autoAllocate(USERS.ADMIN, candidateIds, [USERS.ANN.adminId]),
            autoAllocate(USERS.MANAGER, candidateIds, [USERS.BEN.adminId]),
        ]);

        // Both return 200 (or one gets 200 with 3 allocated and the second gets 200 with 3 skipped/0 allocated)
        assert.equal(res1.status, 200);
        assert.equal(res2.status, 200);

        const totalAllocated = res1.body.allocatedCount + res2.body.allocatedCount;
        assert.equal(totalAllocated, 3, "Only 3 total allocations created for the 3 candidates");

        // Verify in DB: each candidate has at most ONE allocation row
        for (const id of candidateIds) {
            const count = await prisma.candidateAllocation.count({ where: { passportId: id } });
            assert.equal(count, 1, `Candidate ${id} has exactly one allocation row`);
        }
    });

    test("ALLOC-EQUAL-015: Transaction failure => no partial allocation", async () => {
        // Gus Gone is INACTIVE
        const { status, body } = await autoAllocate(USERS.ADMIN, [pid(1), pid(2)], [USERS.ANN.adminId, USERS.GONE.adminId]);
        assert.equal(status, 409);
        assert.equal(body.code, "ANALYST_INACTIVE");
        assert.equal(await prisma.candidateAllocation.count(), 0);
        assert.equal(await prisma.auditLog.count(), 0);
    });

    test("ALLOC-EQUAL-016: Distribution is deterministic", async () => {
        // In this system candidates are sorted newest first: pid(30), pid(29), pid(28), pid(27)...
        // When handed to [Ann, Ben], Ann gets the newest half and Ben gets the next half
        const candidateIds = [pid(1), pid(20), pid(10), pid(5)];
        // Candidate registration time: P20 > P10 > P5 > P1
        const { status, body } = await autoAllocate(USERS.ADMIN, candidateIds, [USERS.ANN.adminId, USERS.BEN.adminId]);
        assert.equal(status, 200);
        assert.equal(body.equalAllocationCount, 2);

        const allAlloc = await allocations();
        // Ann (first analyst) gets newest 2: P20 and P10
        assert.equal(allAlloc[pid(20)], USERS.ANN.adminId);
        assert.equal(allAlloc[pid(10)], USERS.ANN.adminId);
        // Ben (second analyst) gets next 2: P5 and P1
        assert.equal(allAlloc[pid(5)], USERS.BEN.adminId);
        assert.equal(allAlloc[pid(1)], USERS.BEN.adminId);
    });

    test("ALLOC-EQUAL-017: Remainder candidates remain truly unallocated in DB", async () => {
        const candidateIds = [pid(1), pid(2), pid(3), pid(4), pid(5)];
        // 5 candidates / 2 analysts => 2 each + 1 remainder
        const { status, body } = await autoAllocate(USERS.ADMIN, candidateIds, [USERS.ANN.adminId, USERS.BEN.adminId]);
        assert.equal(status, 200);
        assert.equal(body.allocatedCount, 4);
        assert.equal(body.remainderCount, 1);
        const remainderId = body.unallocatedCandidateIds[0];

        // Verify in DB that remainder candidate has NO row in candidate_allocation
        const row = await prisma.candidateAllocation.findUnique({ where: { passportId: remainderId } });
        assert.equal(row, null);

        // Candidate count with allocation null must include the remainder candidate
        const unallocated = await prisma.candidate.findFirst({
            where: { passportId: remainderId, allocation: { is: null } },
        });
        assert.ok(unallocated, "Candidate is truly unallocated in DB");
    });
});
