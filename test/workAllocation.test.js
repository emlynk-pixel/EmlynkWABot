// Work Allocation and Analyst candidate access. On a REAL PostgreSQL (PGlite,
// every migration applied) through the real Prisma client and the real admin
// router. No Supabase: the signed-in user is set by a stand-in for
// requireActiveUser, read from the database on every request like the real one.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { candidateScope, isCandidateScoped } from "../src/services/candidateAccess.js";
import { MAX_ALLOCATION_CANDIDATES } from "../src/services/workAllocationService.js";

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
    GONE: user("u-gone", "ANALYST", "Gus Gone", "INACTIVE", 7),
};
const TOTAL = 30;
// Candidate i: passport P00000ii, registered i minutes after 2026-01-01, so
// P0000030 is the newest (first in the list order).
const pid = (i) => `P${String(i).padStart(7, "0")}`;
const NEWEST_FIRST = Array.from({ length: TOTAL }, (_, k) => pid(TOTAL - k));

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
        -- The active job types this suite's candidates use (Settings > Job Types).
        INSERT INTO "job_type" ("code", "name") VALUES ('CAREGIVER_SEED', 'Caregiver'), ('DRIVER_SEED', 'Driver') ON CONFLICT DO NOTHING;
        DELETE FROM "sheet_sync_queue";
        UPDATE "user" SET "role" = 'ANALYST', "status" = 'ACTIVE' WHERE "admin_id" IN ('u-ann', 'u-ben', 'u-cal');
        INSERT INTO "candidate" ("passport_id", "unique_id", "first_name", "other_name", "job", "whatsapp_number", "contact_number", "created_date", "updated_date")
        SELECT 'P' || lpad(i::text, 7, '0'), lpad(i::text, 4, '0'), 'Given' || i, 'Surname', 'Driver',
               '9477' || lpad(i::text, 7, '0'), '071' || lpad(i::text, 7, '0'),
               timestamp '2026-01-01 00:00:00' + i * interval '1 minute', now()
        FROM generate_series(1, ${TOTAL}) AS i;
    `);
});

// Ann: P1, P2, P3. Ben: P4, P5. Everyone else unallocated.
async function seedAllocations() {
    await prisma.candidateAllocation.createMany({
        data: [[1, USERS.ANN], [2, USERS.ANN], [3, USERS.ANN], [4, USERS.BEN], [5, USERS.BEN]].map(([i, u]) => ({ passportId: pid(i), analystId: u.adminId })),
    });
}

// One request as `who`. The user row is read from the database each time,
// like requireActiveUser, so a role change applies to the next request.
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
const listIds = async (who, query = "") => {
    const { status, body } = await api(who, "GET", `/candidates${query}`);
    assert.equal(status, 200);
    return { ids: body.items.map((item) => item.passportId), pagination: body.pagination };
};
const allocations = async () => Object.fromEntries((await prisma.candidateAllocation.findMany()).map((row) => [row.passportId, row.analystId]));
const allocationAudit = async () => (await prisma.auditLog.findMany({ where: { action: { in: ["ASSIGN_CANDIDATE", "REASSIGN_CANDIDATE", "UNASSIGN_CANDIDATE"] } }, orderBy: [{ createdDate: "asc" }, { passportId: "asc" }] }));
const assign = (who, candidateIds, allocs, extra = {}) => api(who, "POST", "/work-allocation/assign", { candidateIds, allocations: allocs, ...extra });

describe("the access rule (candidateAccess.js)", () => {
    test("ADMIN, MANAGER, REGISTRATION_DESK: every candidate; ANALYST: their allocations; anything else: none", () => {
        for (const role of ["ADMIN", "MANAGER", "REGISTRATION_DESK"]) {
            assert.equal(isCandidateScoped({ role }), false, role);
            assert.deepEqual(candidateScope({ role, adminId: "x" }), {});
        }
        assert.deepEqual(candidateScope({ role: "ANALYST", adminId: "u-ann" }), { allocation: { is: { analystId: "u-ann" } } });
        assert.deepEqual(candidateScope({ role: "VIEWER", adminId: "x" }), { passportId: { in: [] } }, "fails closed");
        assert.deepEqual(candidateScope(undefined), { passportId: { in: [] } });
    });
});

describe("RBAC: candidate lists", () => {
    test("1, 4, 7, 30, 31. ADMIN, MANAGER and REGISTRATION_DESK see every candidate; totals stay global", async () => {
        await seedAllocations();
        for (const who of [USERS.ADMIN, USERS.MANAGER, USERS.DESK]) {
            const { ids, pagination } = await listIds(who);
            assert.equal(pagination.totalItems, TOTAL, who.role);
            assert.deepEqual(ids, NEWEST_FIRST);
        }
    });

    test("10-12, 29. an ANALYST sees only their own candidates: not unallocated ones, not another Analyst's; totals are theirs", async () => {
        await seedAllocations();
        const ann = await listIds(USERS.ANN);
        assert.deepEqual(ann.ids, [pid(3), pid(2), pid(1)]);
        assert.deepEqual([ann.pagination.totalItems, ann.pagination.totalPages], [3, 1]);
        assert.deepEqual((await listIds(USERS.BEN)).ids, [pid(5), pid(4)]);
        assert.deepEqual((await listIds(USERS.CAL)).ids, [], "no allocations: an empty list, not everyone");
    });

    test("26-28. an ANALYST's search is scoped in the database: another candidate's passport or contact number finds nothing", async () => {
        await seedAllocations();
        assert.deepEqual((await listIds(USERS.ANN, `?search=${pid(20)}`)).ids, [], "unallocated candidate by passport");
        assert.deepEqual((await listIds(USERS.ANN, `?search=${pid(4)}`)).ids, [], "Ben's candidate by passport");
        assert.deepEqual((await listIds(USERS.ANN, "?search=0710000004")).ids, [], "Ben's candidate by contact number");
        assert.deepEqual((await listIds(USERS.ANN, "?search=94770000004")).ids, [], "Ben's candidate by WhatsApp number");
        const own = await listIds(USERS.ANN, "?search=0710000002");
        assert.deepEqual([own.ids, own.pagination.totalItems], [[pid(2)], 1], "their own candidate is found");
        assert.deepEqual((await listIds(USERS.ADMIN, "?search=0710000004")).ids, [pid(4)], "ADMIN searches everyone");
    });
});

describe("RBAC: editing", () => {
    test("2, 5, 8. ADMIN, MANAGER and REGISTRATION_DESK can edit any candidate, allocated or not", async () => {
        await seedAllocations();
        for (const [who, i] of [[USERS.ADMIN, 1], [USERS.MANAGER, 4], [USERS.DESK, 20]]) {
            assert.equal((await api(who, "PUT", `/candidates/${pid(i)}/stages/VISA_APPROVAL`, { completed: true })).status, 200, who.role);
            assert.equal((await api(who, "GET", `/candidates/${pid(i)}`)).status, 200, who.role);
        }
    });

    test("13-14. an ANALYST edits their own candidate; another Analyst's or an unallocated one is 404, and nothing changes", async () => {
        await seedAllocations();
        assert.equal((await api(USERS.ANN, "PUT", `/candidates/${pid(1)}/stages/VISA_APPROVAL`, { completed: true })).status, 200);
        for (const i of [4, 20]) {
            const { status, body } = await api(USERS.ANN, "PUT", `/candidates/${pid(i)}/stages/VISA_APPROVAL`, { completed: true });
            assert.deepEqual([status, body.message], [404, "Candidate not found"]);
        }
        const stages = await prisma.candidateStage.findMany({ where: { stage: "VISA_APPROVAL" }, select: { passportId: true } });
        assert.deepEqual(stages.map((s) => s.passportId), [pid(1)]);
    });

    test("17 (registration). a new candidate is unallocated; an ANALYST cannot register one (403)", async () => {
        const body = {
            passportId: "N1023757", surname: "De Soysa", otherNames: "Anusha", nic: "965404378V", address: "Negombo", dateOfBirth: "1996-02-23",
            whatsappNumber: "+94771234567", jobTypes: ["Caregiver"], jobExperience: "2 years", passportIssueDate: "2020-01-15", passportExpiryDate: "2030-01-14",
        };
        assert.equal((await api(USERS.ANN, "POST", "/candidates", body)).status, 403);
        assert.equal((await api(USERS.DESK, "POST", "/candidates", body)).status, 201);
        assert.equal(await prisma.candidateAllocation.count({ where: { passportId: "N1023757" } }), 0);
        const { body: list } = await api(USERS.MANAGER, "GET", "/work-allocation/candidates?search=N1023757");
        assert.deepEqual(list.items.map((item) => [item.passportId, item.analyst]), [["N1023757", null]]);
    });
});

describe("41. every candidate-specific route refuses another Analyst's candidate", () => {
    test("detail, update, stages, documents, call logs, Candidate History, follow-ups, additional details, client details: all 404", async () => {
        await seedAllocations();
        const other = pid(4); // Ben's
        const routes = [
            ["GET", `/candidates/${other}`],
            ["GET", `/candidates/${other.toLowerCase()}`],
            ["PUT", `/candidates/${other}`, { surname: "X", otherNames: "Y", nic: "965404378V", jobTypes: ["Driver"], jobExperience: "1", passportIssueDate: "2020-01-01", passportExpiryDate: "2030-01-01" }],
            ["PUT", `/candidates/${other}/stages/TEST_DETAILS`, { completed: true, testResult: "PASS", testDate: "2026-01-02" }],
            ["POST", `/candidates/${other}/documents/upload-target`, { type: "MEDICAL", mimeType: "application/pdf", fileSize: 1000, fileName: "m.pdf" }],
            ["POST", `/candidates/${other}/documents/finalize`, { uploadId: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", type: "MEDICAL", mimeType: "application/pdf", fileName: "m.pdf" }],
            ["POST", `/candidates/${other}/documents/00000000-0000-4000-8000-000000000001/remove`, { reason: "wrong file" }],
            ["GET", `/candidates/${other}/call-logs`],
            ["POST", `/candidates/${other}/call-logs`, { note: "Called", calledAt: "2026-01-02T10:00:00.000Z" }],
            ["POST", `/candidates/${other}/call-logs/00000000-0000-4000-8000-000000000001/follow-up`],
            ["GET", `/candidates/${other}/additional-details`],
            ["PUT", `/candidates/${other}/additional-details`, { tshirtSize: "M" }],
            ["GET", `/clients/${other}`],
        ];
        for (const [method, path, body] of routes) {
            const response = await api(USERS.ANN, method, path, body);
            assert.equal(response.status, 404, `${method} ${path}: ${JSON.stringify(response.body)}`);
        }
        assert.equal(await prisma.candidateCallLog.count(), 0, "no call log was added");
        assert.equal(await prisma.candidateAdditionalDetails.count(), 0);
        // The same routes work for the Analyst's own candidate.
        assert.equal((await api(USERS.ANN, "GET", `/candidates/${pid(1)}`)).status, 200);
        assert.equal((await api(USERS.ANN, "GET", `/candidates/${pid(1)}/call-logs`)).status, 200);
        assert.equal((await api(USERS.ANN, "POST", `/candidates/${pid(1)}/call-logs`, { note: "Called", calledAt: "2026-01-02T10:00:00.000Z" })).status, 201);
        assert.equal((await api(USERS.ANN, "GET", `/clients/${pid(1)}`)).status, 200);
    });

    test("Need Attention: an ANALYST lists and completes only their own candidates' follow-ups", async () => {
        await seedAllocations();
        const followUps = {};
        for (const i of [1, 4, 20]) {
            assert.equal((await api(USERS.ADMIN, "POST", `/candidates/${pid(i)}/call-logs`, { note: `Call ${i}`, calledAt: "2026-01-02T10:00:00.000Z", needsAttention: true })).status, 201);
            followUps[i] = (await prisma.callLogFollowUp.findFirstOrThrow({ where: { callLog: { passportId: pid(i) } } })).followUpId;
        }
        const groups = (who) => api(who, "GET", "/follow-ups").then(({ body }) => body.groups.map((g) => g.candidate.passportId).sort());
        assert.deepEqual(await groups(USERS.ANN), [pid(1)]);
        assert.deepEqual(await groups(USERS.ADMIN), [pid(1), pid(4), pid(20)]);
        assert.deepEqual(await groups(USERS.DESK), [pid(1), pid(4), pid(20)]);
        assert.equal((await api(USERS.ANN, "POST", `/follow-ups/${followUps[4]}/complete`)).status, 404, "Ben's");
        assert.equal((await api(USERS.ANN, "POST", `/follow-ups/${followUps[20]}/complete`)).status, 404, "unallocated");
        assert.equal((await api(USERS.ANN, "POST", `/follow-ups/${followUps[1]}/complete`)).status, 200, "their own");
        assert.equal(await prisma.callLogFollowUp.count({ where: { status: "COMPLETED" } }), 1);
    });

    test("candidate lists on other pages are scoped for an ANALYST: Clients, Documents, Missing Documents, Police Workflow", async () => {
        await seedAllocations();
        await prisma.document.createMany({
            data: [1, 4, 20].map((i) => ({
                documentId: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`, passportId: pid(i), documentType: "POLICE_SLIP",
                originalFilename: "slip.pdf", storedFilename: "slip.pdf", storagePath: `clients/${pid(i)}/slip.pdf`, receivedDate: new Date("2026-01-03T00:00:00Z"),
                processingStatus: "PROCESSED", verificationStatus: "VERIFIED",
            })),
        });
        const ann = new Set([pid(1), pid(2), pid(3)]);
        const clients = (await api(USERS.ANN, "GET", "/clients?pageSize=100")).body;
        assert.deepEqual(new Set(clients.items.map((c) => c.client.passportId)), ann);
        const documents = (await api(USERS.ANN, "GET", "/documents")).body;
        assert.deepEqual(documents.items.map((d) => d.client.passportId), [pid(1)]);
        assert.equal(documents.pagination.total, 1);
        const missing = (await api(USERS.ANN, "GET", "/documents/missing?pageSize=100")).body;
        assert.ok(missing.items.length > 0 && missing.items.every((c) => ann.has(c.client.passportId)), "missing documents: own candidates only");
        const police = (await api(USERS.ANN, "GET", "/police?pageSize=100")).body;
        assert.ok(police.items.length > 0 && police.items.every((row) => ann.has(row.client.passportId)), "police: own candidates only");
        const adminPolice = (await api(USERS.ADMIN, "GET", "/police?pageSize=100")).body;
        assert.ok(adminPolice.items.some((row) => row.client.passportId === pid(20)), "ADMIN still sees everyone");
    });

    test("Review Queue: an ANALYST can only link a waiting file to one of their own candidates; another one reads as not existing", async () => {
        await seedAllocations();
        const temporaryId = "7a1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
        await prisma.temporaryData.create({ data: {
            temporaryId, whatsappNumber: "94770000099", documentType: "MEDICAL", temporaryStoragePath: `temporary/${temporaryId}.pdf`,
            pendingStoragePath: `pending/${temporaryId}.pdf`, processingStatus: "PROCESSED",
        } });
        const link = (who, passportId) => api(who, "POST", `/review/pending-${temporaryId}/assign-client`, { passportId, reason: "Matched by phone" });
        for (const target of [pid(4), pid(20)]) {
            const refused = await link(USERS.ANN, target);
            assert.deepEqual([refused.status, refused.body.code], [409, "CLIENT_NOT_FOUND"], target);
        }
        assert.equal((await prisma.temporaryData.findUnique({ where: { temporaryId } })).passportId, null, "nothing was linked");
        assert.equal((await link(USERS.ANN, pid(1))).status, 200, "their own candidate");
        assert.equal((await link(USERS.ADMIN, pid(20))).status, 200, "ADMIN: any candidate");
    });

    test("Review Queue: an ANALYST cannot open, act on or delete another candidate's item; unlinked and own items stay open", async () => {
        await seedAllocations();
        const documentId = (i) => `00000000-0000-4000-8000-00000000d${String(i).padStart(3, "0")}`;
        await prisma.document.createMany({
            data: [1, 4, 20].map((i) => ({
                documentId: documentId(i), passportId: pid(i), documentType: "MEDICAL", originalFilename: "m.pdf", storedFilename: "m.pdf",
                storagePath: `clients/${pid(i)}/m.pdf`, receivedDate: new Date("2026-01-03T00:00:00Z"), processingStatus: "PROCESSED", verificationStatus: "REVIEW_REQUIRED",
            })),
        });
        const temporaryId = (n) => `7a1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a${String(n).padStart(2, "0")}`;
        await prisma.temporaryData.createMany({
            data: [[1, pid(4)], [2, pid(20)], [3, null]].map(([n, passportId]) => ({
                temporaryId: temporaryId(n), passportId, whatsappNumber: "94770000099", documentType: "MEDICAL",
                temporaryStoragePath: `temporary/${temporaryId(n)}.pdf`, pendingStoragePath: `pending/${temporaryId(n)}.pdf`, processingStatus: "PROCESSED",
            })),
        });

        // Another Analyst's candidate (pid 4) and an unallocated one (pid 20): 404 on every route naming the item.
        for (const reviewId of [`document-${documentId(4)}`, `document-${documentId(20)}`, `pending-${temporaryId(1)}`, `pending-${temporaryId(2)}`]) {
            for (const [method, path, body] of [
                ["GET", `/review/${reviewId}`], ["GET", `/review/${reviewId}/file`],
                ["POST", `/review/${reviewId}/approve`, {}], ["POST", `/review/${reviewId}/keep-pending`, { reason: "later" }],
                ["POST", `/review/${reviewId}/remove`, { reason: "bad file" }],
            ]) {
                const refused = await api(USERS.ANN, method, path, body);
                assert.deepEqual([refused.status, refused.body?.message], [404, "Review item not found"], `${method} ${path}`);
            }
        }
        for (const n of [1, 2]) {
            const refused = await api(USERS.ANN, "DELETE", `/temporary-documents/${temporaryId(n)}`);
            assert.equal(refused.status, 404, `delete submission ${n}`);
        }
        assert.equal(await prisma.temporaryData.count({ where: { temporaryId: { in: [1, 2, 3].map(temporaryId) } } }), 3, "nothing was deleted");
        assert.equal((await prisma.document.findUnique({ where: { documentId: documentId(4) } })).verificationStatus, "REVIEW_REQUIRED", "nothing was changed");
        assert.equal(await prisma.auditLog.count({ where: { action: { in: ["APPROVE", "KEEP_PENDING", "REMOVE_FROM_REVIEW", "DELETE_TEMPORARY_DOCUMENT"] } } }), 0, "nothing was audited");

        // Their own candidate's item and a file not linked to anyone: open, as before.
        assert.equal((await api(USERS.ANN, "GET", `/review/document-${documentId(1)}`)).status, 200);
        assert.equal((await api(USERS.ANN, "GET", `/review/pending-${temporaryId(3)}`)).status, 200);
        assert.equal((await api(USERS.ANN, "POST", `/review/document-${documentId(1)}/keep-pending`, { reason: "later" })).status, 200);
        // ADMIN, MANAGER and Ben (the owner) reach it.
        for (const who of [USERS.ADMIN, USERS.MANAGER, USERS.BEN]) {
            assert.equal((await api(who, "GET", `/review/document-${documentId(4)}`)).status, 200, who.name);
        }
    });

    test("Review Queue list, Overview and Daily Report: an ANALYST only gets their own candidates (and unlinked files); ADMIN and MANAGER stay global; reassignment applies next request", async () => {
        await seedAllocations();
        const DAY = "2026-01-01"; // every seeded candidate registers on this Colombo day
        const at = new Date("2026-01-01T04:00:00Z");
        const documentId = (i) => `00000000-0000-4000-8000-00000000e${String(i).padStart(3, "0")}`;
        await prisma.document.createMany({
            data: [1, 4, 20].map((i) => ({
                documentId: documentId(i), passportId: pid(i), documentType: "MEDICAL", originalFilename: "m.pdf", storedFilename: "m.pdf",
                storagePath: `clients/${pid(i)}/m.pdf`, receivedDate: at, processingStatus: "PROCESSED", verificationStatus: "REVIEW_REQUIRED",
            })),
        });
        const temporaryId = (n) => `7a1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3b${String(n).padStart(2, "0")}`;
        await prisma.temporaryData.createMany({
            // T1: Ben's candidate; T2: Ann's candidate; T3: not linked to anyone yet.
            data: [[1, pid(4)], [2, pid(1)], [3, null]].map(([n, passportId]) => ({
                temporaryId: temporaryId(n), passportId, whatsappNumber: "94770000099", documentType: "MEDICAL", createdDate: at,
                temporaryStoragePath: `temporary/${temporaryId(n)}.pdf`, pendingStoragePath: `pending/${temporaryId(n)}.pdf`, processingStatus: "PROCESSED",
            })),
        });
        for (const [n, i] of [[1, 1], [2, 4]]) {
            await prisma.candidateCallLog.create({ data: { callLogId: `00000000-0000-4000-8000-00000000c${String(n).padStart(3, "0")}`, passportId: pid(i), adminId: USERS.ADMIN.adminId, note: "called", createdDate: at } });
            await prisma.candidateStage.create({ data: { passportId: pid(i), stage: "FINALIZING_JOB", completed: true, completedAt: at } });
        }
        const others = [pid(4), pid(5), pid(20)];
        const leaks = (body) => others.filter((id) => JSON.stringify(body).includes(id));
        const get = async (who, path) => {
            const response = await api(who, "GET", path);
            assert.equal(response.status, 200, `${who.name} GET ${path}`);
            return response.body;
        };

        // ANALYST (Ann: P1-P3): own items plus the unlinked file.
        const review = await get(USERS.ANN, "/review?pageSize=100");
        assert.deepEqual(review.items.map((item) => item.reviewId).sort(), [`document-${documentId(1)}`, `pending-${temporaryId(2)}`, `pending-${temporaryId(3)}`].sort());
        assert.equal(review.pagination.total, 3);
        assert.equal(review.summary.total, 3, "the summary counts follow the same scope");
        assert.equal((await get(USERS.ANN, `/review?passportId=${pid(4)}`)).items.length, 0, "filtering by another candidate finds nothing");
        assert.deepEqual(leaks(review), []);

        const overview = await get(USERS.ANN, "/overview");
        assert.equal(overview.kpis.totalClients, 3);
        assert.equal(overview.kpis.totalDocuments, 1);
        assert.equal(overview.reviewQueue.pendingFiles, 2);
        assert.equal(overview.reviewQueue.reviewRequiredDocuments, 1);
        assert.deepEqual(leaks(overview), []);

        const summary = await get(USERS.ANN, `/reports/daily/summary?date=${DAY}`);
        assert.deepEqual([summary.summary.candidatesRegistered, summary.summary.callsTaken, summary.summary.candidatesCompleted], [3, 1, 1]);
        assert.equal(summary.whatsappProcessing.received, 2);
        assert.equal(summary.current.incomplete.totalCandidates, 3);
        assert.deepEqual(leaks(summary), []);
        const incomplete = await get(USERS.ANN, "/reports/daily/incomplete?stage=TEST_DETAILS&page=1");
        assert.ok(incomplete.items.length > 0 && incomplete.items.every((row) => [pid(1), pid(2), pid(3)].includes(row.passportId)));
        assert.equal(incomplete.pagination.total, 3);
        const daily = await get(USERS.ANN, `/reports/daily?date=${DAY}`);
        assert.equal(daily.daily.totalReceived, 2);
        assert.equal(daily.current.clients.total, 3);
        const monthly = await get(USERS.ANN, "/reports/monthly?month=2026-01");
        assert.equal(monthly.candidatesRegistered, 3);
        assert.equal(monthly.sources.whatsappSubmissions, 2);

        // ADMIN and MANAGER: global, as before.
        for (const who of [USERS.ADMIN, USERS.MANAGER]) {
            assert.equal((await get(who, "/review?pageSize=100")).pagination.total, 6, who.name);
            assert.equal((await get(who, "/overview")).kpis.totalClients, TOTAL, who.name);
            const all = await get(who, `/reports/daily/summary?date=${DAY}`);
            assert.deepEqual([all.summary.candidatesRegistered, all.summary.callsTaken, all.whatsappProcessing.received], [TOTAL, 2, 3], who.name);
            assert.equal((await get(who, `/reports/daily?date=${DAY}`)).daily.totalReceived, 3, who.name);
            assert.equal((await get(who, "/reports/monthly?month=2026-01")).candidatesRegistered, TOTAL, who.name);
        }
        // REGISTRATION_DESK: still outside these pages.
        for (const path of ["/review", "/overview", `/reports/daily/summary?date=${DAY}`]) assert.equal((await api(USERS.DESK, "GET", path)).status, 403, path);

        // Reassignment applies on the next request: P1 moves from Ann to Ben.
        assert.equal((await assign(USERS.MANAGER, [pid(1)], [{ analystId: USERS.BEN.adminId, count: 1 }], { reassign: true })).status, 200);
        const after = await get(USERS.ANN, "/review?pageSize=100");
        assert.deepEqual(after.items.map((item) => item.reviewId), [`pending-${temporaryId(3)}`], "only the unlinked file is left");
        assert.equal((await get(USERS.ANN, "/overview")).kpis.totalClients, 2);
        assert.equal((await get(USERS.ANN, `/reports/daily/summary?date=${DAY}`)).summary.candidatesRegistered, 2);
        const annOverview = JSON.stringify(await get(USERS.ANN, "/overview"));
        assert.ok(![pid(1), ...others].some((id) => annOverview.includes(id)), "the moved candidate is gone from the old Analyst's Overview");
        const ben = await get(USERS.BEN, "/review?pageSize=100");
        assert.ok(ben.items.some((item) => item.reviewId === `document-${documentId(1)}`), "the new Analyst gains the item");
    });

    test("26. reassignment applies on the next request: the old Analyst loses access, the new one gains it", async () => {
        await seedAllocations();
        assert.equal((await api(USERS.ANN, "GET", `/candidates/${pid(1)}`)).status, 200);
        assert.equal((await assign(USERS.MANAGER, [pid(1)], [{ analystId: USERS.BEN.adminId, count: 1 }], { reassign: true })).status, 200);
        assert.equal((await api(USERS.ANN, "GET", `/candidates/${pid(1)}`)).status, 404);
        assert.equal((await api(USERS.BEN, "GET", `/candidates/${pid(1)}`)).status, 200);
        // and a role change applies too: Ben as a MANAGER sees everyone.
        await prisma.user.update({ where: { adminId: USERS.BEN.adminId }, data: { role: "MANAGER" } });
        assert.equal((await listIds(USERS.BEN)).pagination.totalItems, TOTAL);
    });
});

describe("Work Allocation API: who may use it", () => {
    test("3, 6, 9, 15. ADMIN and MANAGER may; REGISTRATION_DESK and ANALYST get 403 on every route", async () => {
        for (const who of [USERS.DESK, USERS.ANN]) {
            for (const [method, path, body] of [
                ["GET", "/work-allocation/candidates"],
                ["GET", "/work-allocation/analysts"],
                ["POST", "/work-allocation/assign", { candidateIds: [pid(1)], allocations: [{ analystId: USERS.ANN.adminId, count: 1 }] }],
                ["POST", "/work-allocation/unassign", { candidateIds: [pid(1)], confirm: true }],
            ]) {
                const response = await api(who, method, path, body);
                assert.deepEqual([response.status, response.body], [403, { message: "Insufficient permissions" }], `${who.role} ${method} ${path}`);
            }
        }
        assert.equal(await prisma.candidateAllocation.count(), 0);
        for (const who of [USERS.ADMIN, USERS.MANAGER]) {
            assert.equal((await api(who, "GET", "/work-allocation/candidates")).status, 200, who.role);
            assert.equal((await api(who, "GET", "/work-allocation/analysts")).status, 200, who.role);
        }
    });
});

describe("Work Allocation API: assigning", () => {
    test("16. one candidate to one Analyst, audited with the candidate, both Analysts and the acting manager", async () => {
        const { status, body } = await assign(USERS.MANAGER, [pid(7)], [{ analystId: USERS.ANN.adminId, count: 1 }]);
        assert.equal(status, 200);
        assert.deepEqual([body.assigned, body.reassigned, body.unchanged], [1, 0, 0]);
        assert.deepEqual(await allocations(), { [pid(7)]: USERS.ANN.adminId });
        const [row] = await allocationAudit();
        assert.deepEqual(
            [row.action, row.passportId, row.adminId, row.previousStatus, row.newStatus, row.previousValue, JSON.parse(row.newValue)],
            ["ASSIGN_CANDIDATE", pid(7), USERS.MANAGER.adminId, "UNALLOCATED", "ALLOCATED", null, { analystId: USERS.ANN.adminId, name: "Ann Analyst" }],
        );
    });

    test("17. many candidates to one Analyst in one request", async () => {
        const ids = [pid(1), pid(2), pid(3), pid(4)];
        assert.equal((await assign(USERS.ADMIN, ids, [{ analystId: USERS.BEN.adminId, count: 4 }])).status, 200);
        assert.deepEqual(await allocations(), Object.fromEntries(ids.map((id) => [id, USERS.BEN.adminId])));
        assert.equal((await allocationAudit()).length, 4);
    });

    test("18. across several Analysts: newest registered first, handed out in the order of the allocations, whatever the selection order", async () => {
        const ids = [pid(1), pid(9), pid(5), pid(3), pid(7), pid(2)]; // newest first: 9, 7, 5, 3, 2, 1
        const { status, body } = await assign(USERS.MANAGER, ids, [
            { analystId: USERS.BEN.adminId, count: 2 },
            { analystId: USERS.ANN.adminId, count: 3 },
            { analystId: USERS.CAL.adminId, count: 1 },
        ]);
        assert.equal(status, 200);
        assert.deepEqual(body.byAnalyst.map((a) => [a.name, a.count]), [["Ben Analyst", 2], ["Ann Analyst", 3], ["Cal Analyst", 1]]);
        assert.deepEqual(await allocations(), {
            [pid(9)]: USERS.BEN.adminId, [pid(7)]: USERS.BEN.adminId,
            [pid(5)]: USERS.ANN.adminId, [pid(3)]: USERS.ANN.adminId, [pid(2)]: USERS.ANN.adminId,
            [pid(1)]: USERS.CAL.adminId,
        });
    });

    test("19, 36. the request is checked: counts must add up, whole numbers, no repeated Analyst or candidate, not empty", async () => {
        const one = [{ analystId: USERS.ANN.adminId, count: 1 }];
        for (const [body, field] of [
            [{ candidateIds: [pid(1), pid(2)], allocations: one }, "allocations"],
            [{ candidateIds: [pid(1)], allocations: [{ analystId: USERS.ANN.adminId, count: 2 }] }, "allocations"],
            [{ candidateIds: [pid(1)], allocations: [{ analystId: USERS.ANN.adminId, count: 1.5 }] }, "allocations[0].count"],
            [{ candidateIds: [pid(1)], allocations: [{ analystId: USERS.ANN.adminId, count: -1 }] }, "allocations[0].count"],
            [{ candidateIds: [pid(1), pid(2)], allocations: [{ analystId: USERS.ANN.adminId, count: 1 }, { analystId: USERS.ANN.adminId, count: 1 }] }, "allocations[1].analystId"],
            [{ candidateIds: [pid(1), pid(1)], allocations: [{ analystId: USERS.ANN.adminId, count: 2 }] }, "candidateIds"],
            [{ candidateIds: [], allocations: one }, "candidateIds"],
            [{ candidateIds: [pid(1)], allocations: [] }, "allocations"],
            [{ candidateIds: [pid(1)], allocations: [{ analystId: USERS.ANN.adminId, count: 0 }] }, "allocations"],
            [{ candidateIds: Array.from({ length: MAX_ALLOCATION_CANDIDATES + 1 }, (_, i) => `X${i}`), allocations: one }, "candidateIds"],
        ]) {
            const response = await api(USERS.ADMIN, "POST", "/work-allocation/assign", body);
            assert.equal(response.status, 400, JSON.stringify(body).slice(0, 120));
            assert.ok(response.body.errors.some((e) => e.field === field), `${field}: ${JSON.stringify(response.body.errors)}`);
        }
        const mismatch = await api(USERS.ADMIN, "POST", "/work-allocation/assign", { candidateIds: [pid(1), pid(2)], allocations: one });
        assert.equal(mismatch.body.errors[0].code, "COUNT_MISMATCH");
        assert.equal(await prisma.candidateAllocation.count(), 0);
    });

    test("20-21. only an ACTIVE Analyst can be a target: inactive, ADMIN, MANAGER, REGISTRATION_DESK and unknown users are refused", async () => {
        for (const [target, code] of [[USERS.GONE, "ANALYST_INACTIVE"], [USERS.ADMIN, "NOT_AN_ANALYST"], [USERS.MANAGER, "NOT_AN_ANALYST"], [USERS.DESK, "NOT_AN_ANALYST"], [{ adminId: "u-nobody" }, "ANALYST_NOT_FOUND"]]) {
            const response = await assign(USERS.ADMIN, [pid(1)], [{ analystId: target.adminId, count: 1 }]);
            assert.deepEqual([response.status, response.body.code], [409, code], target.adminId);
        }
        assert.equal(await prisma.candidateAllocation.count(), 0);
    });

    test("25. all or nothing: a missing candidate or one bad Analyst means nobody is assigned and nothing is audited", async () => {
        const missing = await assign(USERS.ADMIN, [pid(1), "N9999999"], [{ analystId: USERS.ANN.adminId, count: 2 }]);
        assert.deepEqual([missing.status, missing.body.code], [409, "CANDIDATE_NOT_AVAILABLE"]);
        const badSecond = await assign(USERS.ADMIN, [pid(1), pid(2)], [{ analystId: USERS.ANN.adminId, count: 1 }, { analystId: USERS.GONE.adminId, count: 1 }]);
        assert.deepEqual([badSecond.status, badSecond.body.code], [409, "ANALYST_INACTIVE"]);
        assert.equal(await prisma.candidateAllocation.count(), 0);
        assert.equal((await allocationAudit()).length, 0);
    });

    test("22, 24. reassignment needs reassign: true (else 409, nothing changed), then moves the candidate and is audited with both Analysts", async () => {
        await seedAllocations();
        const refused = await assign(USERS.MANAGER, [pid(1), pid(20)], [{ analystId: USERS.BEN.adminId, count: 2 }]);
        assert.deepEqual([refused.status, refused.body.code], [409, "ALREADY_ALLOCATED"]);
        assert.equal((await allocations())[pid(20)], undefined, "the unallocated one was not assigned either");

        const { status, body } = await assign(USERS.MANAGER, [pid(1), pid(20)], [{ analystId: USERS.BEN.adminId, count: 2 }], { reassign: true });
        assert.equal(status, 200);
        assert.deepEqual([body.assigned, body.reassigned], [1, 1]);
        assert.equal((await allocations())[pid(1)], USERS.BEN.adminId);
        const rows = await allocationAudit();
        const moved = rows.find((r) => r.action === "REASSIGN_CANDIDATE");
        assert.deepEqual(
            [moved.passportId, JSON.parse(moved.previousValue).name, JSON.parse(moved.newValue).name, moved.adminId],
            [pid(1), "Ann Analyst", "Ben Analyst", USERS.MANAGER.adminId],
        );
        assert.deepEqual(rows.map((r) => r.action).sort(), ["ASSIGN_CANDIDATE", "REASSIGN_CANDIDATE"]);
    });

    test("a candidate given to the Analyst it already has is left alone and not audited", async () => {
        await seedAllocations();
        const { body } = await assign(USERS.ADMIN, [pid(1)], [{ analystId: USERS.ANN.adminId, count: 1 }], { reassign: true });
        assert.deepEqual([body.assigned, body.reassigned, body.unchanged], [0, 0, 1]);
        assert.equal((await allocationAudit()).length, 0);
    });

    test("24. two managers allocating the same candidates at the same moment: one wins, the other gets 409; never both", async () => {
        const ids = [pid(10), pid(11), pid(12)];
        const results = await Promise.all([
            assign(USERS.ADMIN, ids, [{ analystId: USERS.ANN.adminId, count: 3 }]),
            assign(USERS.MANAGER, ids, [{ analystId: USERS.BEN.adminId, count: 3 }]),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        const owners = new Set(Object.values(await allocations()));
        assert.equal(owners.size, 1, "all three went to the same Analyst");
        assert.equal((await allocationAudit()).length, 3);
    });
});

describe("Work Allocation API: unassigning", () => {
    test("23, 25. needs confirm: true; returns the candidates to Unallocated, audited; the Analyst loses access", async () => {
        await seedAllocations();
        assert.equal((await api(USERS.ADMIN, "POST", "/work-allocation/unassign", { candidateIds: [pid(1)] })).status, 400);
        const { status, body } = await api(USERS.ADMIN, "POST", "/work-allocation/unassign", { candidateIds: [pid(1), pid(20)], confirm: true });
        assert.equal(status, 200);
        assert.deepEqual(body, { unassigned: 1, alreadyUnallocated: 1 });
        assert.equal((await allocations())[pid(1)], undefined);
        const [row] = await allocationAudit();
        assert.deepEqual([row.action, row.passportId, JSON.parse(row.previousValue).name, row.newValue], ["UNASSIGN_CANDIDATE", pid(1), "Ann Analyst", null]);
        assert.equal((await api(USERS.ANN, "GET", `/candidates/${pid(1)}`)).status, 404);
    });
});

describe("Work Allocation API: lists and workload", () => {
    test("Unallocated (default) and Allocated views, server-side search and paging, with the current Analyst", async () => {
        await seedAllocations();
        const unallocated = (await api(USERS.MANAGER, "GET", "/work-allocation/candidates")).body;
        assert.equal(unallocated.pagination.totalItems, TOTAL - 5);
        assert.ok(unallocated.items.every((item) => item.analyst === null));
        assert.deepEqual(Object.keys(unallocated.items[0]).sort(), [
            "analyst", "assignedDate", "contactNumber", "currentStage", "jobTypes", "name", "nic", "passportId", "registeredDate",
            "stagesCompleted", "stagesTotal", "uniqueId", "whatsappNumber", "workflowStatus",
        ]);
        const allocated = (await api(USERS.MANAGER, "GET", "/work-allocation/candidates?status=ALLOCATED")).body;
        assert.deepEqual(allocated.items.map((item) => [item.passportId, item.analyst.name]), [
            [pid(5), "Ben Analyst"], [pid(4), "Ben Analyst"], [pid(3), "Ann Analyst"], [pid(2), "Ann Analyst"], [pid(1), "Ann Analyst"],
        ]);
        const bens = (await api(USERS.MANAGER, "GET", `/work-allocation/candidates?status=ALLOCATED&analystId=${USERS.BEN.adminId}`)).body;
        assert.deepEqual(bens.items.map((item) => item.passportId), [pid(5), pid(4)]);
        const search = (await api(USERS.MANAGER, "GET", "/work-allocation/candidates?search=0710000020")).body;
        assert.deepEqual(search.items.map((item) => item.passportId), [pid(20)]);
        assert.equal((await api(USERS.MANAGER, "GET", "/work-allocation/candidates?status=BOTH")).status, 400);
    });

    test("22. Analysts: only ACTIVE Analysts are assignable, with their current counts; inactive holders are listed apart", async () => {
        await seedAllocations();
        await prisma.candidateAllocation.create({ data: { passportId: pid(6), analystId: USERS.GONE.adminId } });
        const { body } = await api(USERS.ADMIN, "GET", "/work-allocation/analysts");
        assert.deepEqual(body.analysts.map((a) => [a.name, a.assignedCount]), [["Ann Analyst", 3], ["Ben Analyst", 2], ["Cal Analyst", 0]]);
        assert.deepEqual(body.unavailableAnalysts.map((a) => [a.name, a.assignedCount]), [["Gus Gone", 1]]);
        assert.equal(body.unallocatedCount, TOTAL - 6);
    });
});
