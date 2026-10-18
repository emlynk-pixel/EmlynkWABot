// Manual QA Verification Test Script for Cases A through F
// Verifies on real PostgreSQL (PGlite) with Prisma, real admin routes, and direct database queries.
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
    ANN: user("u-ann", "ANALYST", "Ann Analyst", "ACTIVE", 3),
    BEN: user("u-ben", "ANALYST", "Ben Analyst", "ACTIVE", 4),
    CAL: user("u-cal", "ANALYST", "Cal Analyst", "ACTIVE", 5),
    DAN: user("u-dan", "ANALYST", "Dan Analyst", "ACTIVE", 6),
};

const pid = (i) => `P${String(i).padStart(7, "0")}`;
const TOTAL = 60;

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

describe("Manual QA Scenarios (Cases A through F)", () => {
    test("Case A: 20 candidates / 4 analysts => 5 each", async () => {
        const candidateIds = Array.from({ length: 20 }, (_, i) => pid(i + 1));
        const analystIds = [USERS.ANN.adminId, USERS.BEN.adminId, USERS.CAL.adminId, USERS.DAN.adminId];

        const { status, body } = await api(USERS.ADMIN, "POST", "/work-allocation/auto-allocate", { candidateIds, analystIds });
        assert.equal(status, 200);
        assert.equal(body.selectedCount, 20);
        assert.equal(body.eligibleCount, 20);
        assert.equal(body.allocatedCount, 20);
        assert.equal(body.equalAllocationCount, 5);
        assert.equal(body.remainderCount, 0);

        // Verify in database: exactly 20 rows in candidate_allocation, exactly 5 per analyst
        const rows = await prisma.candidateAllocation.findMany();
        assert.equal(rows.length, 20);
        for (const analystId of analystIds) {
            const count = rows.filter((r) => r.analystId === analystId).length;
            assert.equal(count, 5, `Analyst ${analystId} has exactly 5 allocated candidates in DB`);
        }
    });

    test("Case B: 23 candidates / 4 analysts => 5 each, 3 remain", async () => {
        const candidateIds = Array.from({ length: 23 }, (_, i) => pid(i + 1));
        const analystIds = [USERS.ANN.adminId, USERS.BEN.adminId, USERS.CAL.adminId, USERS.DAN.adminId];

        const { status, body } = await api(USERS.MANAGER, "POST", "/work-allocation/auto-allocate", { candidateIds, analystIds });
        assert.equal(status, 200);
        assert.equal(body.selectedCount, 23);
        assert.equal(body.eligibleCount, 23);
        assert.equal(body.allocatedCount, 20);
        assert.equal(body.equalAllocationCount, 5);
        assert.equal(body.remainderCount, 3);
        assert.equal(body.unallocatedCandidateIds.length, 3);

        // Verify in database: exactly 20 allocated, exactly 5 per analyst
        const rows = await prisma.candidateAllocation.findMany();
        assert.equal(rows.length, 20);
        for (const analystId of analystIds) {
            const count = rows.filter((r) => r.analystId === analystId).length;
            assert.equal(count, 5, `Analyst ${analystId} has exactly 5 allocated candidates in DB`);
        }

        // Verify in database: the 3 remainder candidates are NOT in candidate_allocation
        const allocatedSet = new Set(rows.map((r) => r.passportId));
        for (const remId of body.unallocatedCandidateIds) {
            assert.equal(allocatedSet.has(remId), false, `Remainder ${remId} is unallocated in DB`);
        }
    });

    test("Case C: candidate already allocated => no duplicate/reassignment", async () => {
        // Pre-allocate P1 to Ann
        await prisma.candidateAllocation.create({ data: { passportId: pid(1), analystId: USERS.ANN.adminId } });

        // Submit bulk allocation of 10 candidates (including P1) to Ben and Cal
        const candidateIds = Array.from({ length: 10 }, (_, i) => pid(i + 1));
        const { status, body } = await api(USERS.ADMIN, "POST", "/work-allocation/auto-allocate", {
            candidateIds,
            analystIds: [USERS.BEN.adminId, USERS.CAL.adminId],
        });
        assert.equal(status, 200);
        assert.equal(body.selectedCount, 10);
        assert.equal(body.eligibleCount, 9);
        assert.equal(body.conflictsCount, 1);
        assert.equal(body.skippedCount, 1);
        assert.deepEqual(body.skippedCandidateIds, [pid(1)]);
        assert.equal(body.equalAllocationCount, 4); // floor(9 / 2) = 4
        assert.equal(body.allocatedCount, 8);
        assert.equal(body.remainderCount, 1);

        // Verify in database: P1 still belongs to Ann!
        const p1 = await prisma.candidateAllocation.findUnique({ where: { passportId: pid(1) } });
        assert.equal(p1.analystId, USERS.ANN.adminId, "P1 remains with original analyst");

        // Verify no duplicate allocation rows
        const countP1 = await prisma.candidateAllocation.count({ where: { passportId: pid(1) } });
        assert.equal(countP1, 1);
    });

    test("Case D: double-click Allocate => one safe operation", async () => {
        const candidateIds = [pid(1), pid(2), pid(3), pid(4)];
        const analystIds = [USERS.ANN.adminId, USERS.BEN.adminId];

        // Simulate concurrent/immediate double-click of Allocate
        const [res1, res2] = await Promise.all([
            api(USERS.ADMIN, "POST", "/work-allocation/auto-allocate", { candidateIds, analystIds }),
            api(USERS.ADMIN, "POST", "/work-allocation/auto-allocate", { candidateIds, analystIds }),
        ]);

        assert.equal(res1.status, 200);
        assert.equal(res2.status, 200);

        const totalAllocated = res1.body.allocatedCount + res2.body.allocatedCount;
        assert.equal(totalAllocated, 4, "Only 4 total candidates allocated across both concurrent requests");

        // Exactly 4 rows in DB
        const totalRows = await prisma.candidateAllocation.count();
        assert.equal(totalRows, 4);
    });

    test("Case E: search/filter candidate selection => correct IDs allocated", async () => {
        // Query candidates by search (contact number 0710000015)
        const { body: searchList } = await api(USERS.ADMIN, "GET", "/work-allocation/candidates?search=0710000015");
        assert.equal(searchList.items.length, 1);
        assert.equal(searchList.items[0].passportId, pid(15));

        // Allocate the filtered candidate
        const { status, body } = await api(USERS.ADMIN, "POST", "/work-allocation/auto-allocate", {
            candidateIds: [searchList.items[0].passportId],
            analystIds: [USERS.ANN.adminId],
        });
        assert.equal(status, 200);
        assert.equal(body.allocatedCount, 1);

        // Verify DB record
        const record = await prisma.candidateAllocation.findUnique({ where: { passportId: pid(15) } });
        assert.equal(record.analystId, USERS.ANN.adminId);
    });

    test("Case F: pagination => selection/allocation remains correct according to existing selection semantics", async () => {
        // Query page 1 (pageSize default is 100, let's query candidates list)
        const { body: list } = await api(USERS.ADMIN, "GET", "/work-allocation/candidates?page=1");
        assert.ok(list.items.length > 0);

        // Candidates are ordered newest first: pid(60), pid(59), pid(58)...
        // Select first 4 on page
        const selectedIds = list.items.slice(0, 4).map((c) => c.passportId);
        assert.deepEqual(selectedIds, [pid(60), pid(59), pid(58), pid(57)]);

        const { status, body } = await api(USERS.ADMIN, "POST", "/work-allocation/auto-allocate", {
            candidateIds: selectedIds,
            analystIds: [USERS.ANN.adminId, USERS.BEN.adminId],
        });
        assert.equal(status, 200);
        assert.equal(body.allocatedCount, 4);
        assert.equal(body.equalAllocationCount, 2);

        // Check in DB
        const annAlloc = await prisma.candidateAllocation.findMany({ where: { analystId: USERS.ANN.adminId } });
        const benAlloc = await prisma.candidateAllocation.findMany({ where: { analystId: USERS.BEN.adminId } });
        assert.equal(annAlloc.length, 2);
        assert.equal(benAlloc.length, 2);
        const allocatedIds = [...annAlloc, ...benAlloc].map((r) => r.passportId).sort();
        assert.deepEqual(allocatedIds, selectedIds.sort());
    });
});
