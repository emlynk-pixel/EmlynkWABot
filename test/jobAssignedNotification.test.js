// A5 Job Assigned (notificationEvents.js notifyJobAssigned, sent by jobService.js after the assignment
// commits), and the notification's candidateId / jobId (A1, A4, A5, C1, E1). On a REAL PostgreSQL
// (PGlite, every migration applied) through the real Prisma client, services and admin router.
// Synthetic data only.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import {
    jobAssignedMessage, NOTIFICATION_TYPE, notifyCandidateFormSubmitted, notifyCandidatesCancelled, notifyJobAssigned,
} from "../src/services/notificationEvents.js";
import { assignCandidates } from "../src/services/workAllocationService.js";

const user = (adminId, role, name, n, status = "ACTIVE") => ({
    adminId, role, name, status, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
});
const USERS = {
    OWNER: user("u-owner", "OWNER", "Olive Owner", 1),
    ADMIN: user("u-admin", "ADMIN", "Ada Admin", 2),
    LEAD: user("u-lead", "TEAM_LEAD", "Tia Lead", 3),
    ANN: user("u-ann", "ANALYST", "Ann Analyst", 4),
    BEN: user("u-ben", "ANALYST", "Ben Analyst", 5),
    JOBS: user("u-jobs", "JOB_HANDLER", "Jo Handler", 6),
};
// P1 and P4 allocated to Ann, P2 unallocated, P3 allocated to the Team Lead; every one passed the test.
const P = { ANN: "P0000001", NONE: "P0000002", LEAD: "P0000003", ANN2: "P0000004" };

let database;
let prisma;
let pg;
let ids;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const u of Object.values(USERS)) await prisma.user.create({ data: u });
});
after(async () => database?.close());
beforeEach(async () => {
    await pg.exec(`
        DROP TRIGGER IF EXISTS "notification_test_fail" ON "notification";
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "notification"; DELETE FROM "rate_limits"; DELETE FROM "job_candidate"; DELETE FROM "job_job_type"; DELETE FROM "job"; DELETE FROM "job_code_counter";
        DELETE FROM "agent_client"; DELETE FROM "client"; DELETE FROM "agent";
        DELETE FROM "candidate_allocation"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
        UPDATE "user" SET "status" = 'ACTIVE';
        UPDATE "user" SET "role" = 'ANALYST' WHERE "admin_id" IN ('u-ann', 'u-ben');
    `);
    await prisma.candidate.createMany({
        data: [
            { passportId: P.ANN, uniqueId: "7001", firstName: "Nimal", otherName: "Perera" },
            { passportId: P.NONE, uniqueId: "7002", firstName: "Sunil", otherName: "Silva" },
            { passportId: P.LEAD, uniqueId: "7003", firstName: "Kamal", otherName: "Fernando" },
            { passportId: P.ANN2, uniqueId: "7004", firstName: "", otherName: null },
        ],
    });
    await prisma.candidateStage.createMany({ data: Object.values(P).map((passportId) => ({ passportId, stage: "TEST_DETAILS", testResult: "PASS" })) });
    await prisma.candidateAllocation.createMany({
        data: [
            { passportId: P.ANN, analystId: USERS.ANN.adminId },
            { passportId: P.LEAD, analystId: USERS.LEAD.adminId },
            { passportId: P.ANN2, analystId: USERS.ANN.adminId },
        ],
    });
    const jobType = await prisma.jobType.findFirst({ where: { code: "PLASTER" }, select: { id: true } });
    const agent = await prisma.agent.create({ data: { name: "Ion Popescu", countryCode: "RO" } });
    const acme = await prisma.client.create({ data: { name: "Acme Builders", agentLinks: { create: { agentId: agent.id } } } });
    ids = { jobType: jobType.id, acme: acme.id };
});

const breakNotificationInserts = () => pg.exec(`
    CREATE OR REPLACE FUNCTION "notification_test_fail_fn"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'notification insert refused'; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER "notification_test_fail" BEFORE INSERT ON "notification" FOR EACH ROW EXECUTE FUNCTION "notification_test_fail_fn"();
`);

async function api(who, method, urlPath, body) {
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
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin${urlPath}`, {
            method,
            headers: body === undefined ? {} : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    } finally {
        server.close();
    }
}
const createJob = async (candidateIds) => {
    const response = await api(USERS.OWNER, "POST", "/jobs", { jobTypeId: ids.jobType, clientId: ids.acme, ...(candidateIds ? { candidateIds } : {}) });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
};
const add = (job, passportId, who = USERS.OWNER) => api(who, "POST", `/jobs/${job.jobId}/candidates`, { passportId });
const remove = (job, passportId) => api(USERS.OWNER, "DELETE", `/jobs/${job.jobId}/candidates/${passportId}`);
const a5 = (where = {}) => prisma.notification.findMany({ where: { type: NOTIFICATION_TYPE.A5, ...where }, orderBy: { createdAt: "asc" } });
const a5Of = (who) => a5({ recipientId: who.adminId });
const assignedAt = async (job, passportId) => (await prisma.jobCandidate.findUnique({ where: { jobId_passportId: { jobId: job.jobId, passportId } } })).assignedAt;

describe("A5 Job Assigned", () => {
    test("Analyst 1 (the candidate's Analyst) gets the exact text, with the candidate and the job; nobody else", async () => {
        const job = await createJob();
        const res = await add(job, P.ANN);
        assert.equal(res.status, 201, JSON.stringify(res.body));
        const ann = await a5Of(USERS.ANN);
        assert.equal(ann.length, 1);
        assert.deepEqual([ann[0].type, ann[0].title, ann[0].message], [NOTIFICATION_TYPE.A5, "Job Assigned", `Job ${job.jobCode} has been assigned to Nimal Perera.`]);
        assert.equal(ann[0].message, jobAssignedMessage(job.jobCode, "Nimal Perera"));
        assert.deepEqual([ann[0].candidateId, ann[0].jobId], [P.ANN, job.jobId]);
        assert.equal(ann[0].dedupeKey, `A5:${job.jobId}:${P.ANN}:${(await assignedAt(job, P.ANN)).toISOString()}`);
        assert.doesNotMatch(ann[0].message, new RegExp(`${P.ANN}|${job.jobId}`), "no identifier in the text");
        for (const other of [USERS.BEN, USERS.LEAD, USERS.ADMIN, USERS.OWNER, USERS.JOBS]) assert.equal((await a5Of(other)).length, 0, other.adminId);
        assert.equal((await a5()).length, 1);
    });

    test("an unallocated candidate, a candidate allocated to a Team Lead, and an Analyst who is no longer one or inactive: nothing, no error", async () => {
        const job = await createJob();
        assert.equal((await add(job, P.NONE)).status, 201);
        assert.equal((await add(job, P.LEAD)).status, 201);
        assert.equal((await a5()).length, 0);

        await prisma.user.update({ where: { adminId: USERS.ANN.adminId }, data: { role: "TEAM_LEAD" } });
        assert.equal((await add(job, P.ANN)).status, 201);
        await prisma.user.update({ where: { adminId: USERS.ANN.adminId }, data: { role: "ANALYST", status: "INACTIVE" } });
        assert.equal((await add(job, P.ANN2)).status, 201);
        assert.equal((await a5()).length, 0);
    });

    test("the same request twice: the second is refused (already on the job) and adds no notification", async () => {
        const job = await createJob();
        assert.equal((await add(job, P.ANN)).status, 201);
        const again = await add(job, P.ANN);
        assert.deepEqual([again.status, again.body.code], [409, "CANDIDATE_ALREADY_IN_JOB"]);
        assert.equal((await a5Of(USERS.ANN)).length, 1);
        // The same event sent again (a retry) is one row too.
        const [row] = await a5Of(USERS.ANN);
        await notifyJobAssigned(prisma, { jobId: job.jobId, jobCode: job.jobCode, passportId: P.ANN, assignedAt: await assignedAt(job, P.ANN) });
        assert.deepEqual((await a5Of(USERS.ANN)).map((n) => n.id), [row.id]);
    });

    test("a notification that cannot be written never breaks the assignment", async () => {
        const job = await createJob();
        await breakNotificationInserts();
        const res = await add(job, P.ANN);
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(await prisma.jobCandidate.count({ where: { jobId: job.jobId, passportId: P.ANN, isActive: true } }), 1);
        assert.equal(await prisma.auditLog.count({ where: { action: "ADD_CANDIDATE_TO_JOB" } }), 1);
        await pg.exec(`DROP TRIGGER IF EXISTS "notification_test_fail" ON "notification";`);
        assert.equal((await a5()).length, 0);
    });

    test("removed and added again, and added to a different job (a move): a new notification each time", async () => {
        const first = await createJob();
        const second = await createJob();
        assert.equal((await add(first, P.ANN)).status, 201);
        assert.equal((await remove(first, P.ANN)).status, 200);
        assert.equal((await a5Of(USERS.ANN)).length, 1, "a removal sends nothing");
        assert.equal((await add(first, P.ANN)).status, 201);
        assert.equal((await remove(first, P.ANN)).status, 200);
        assert.equal((await add(second, P.ANN)).status, 201);
        const rows = await a5Of(USERS.ANN);
        assert.equal(rows.length, 3);
        assert.equal(new Set(rows.map((n) => n.dedupeKey)).size, 3);
        assert.deepEqual(rows.map((n) => n.jobId), [first.jobId, first.jobId, second.jobId]);
        assert.equal(rows[2].message, `Job ${second.jobCode} has been assigned to Nimal Perera.`);
    });

    test("a new job with selected candidates: one per assigned candidate of the Analyst; a candidate without a name is 'a candidate', never the passport ID", async () => {
        const job = await createJob([P.ANN, P.NONE, P.LEAD, P.ANN2]);
        const rows = await a5Of(USERS.ANN);
        assert.deepEqual(rows.map((n) => [n.candidateId, n.jobId, n.message]).sort(), [
            [P.ANN, job.jobId, `Job ${job.jobCode} has been assigned to Nimal Perera.`],
            [P.ANN2, job.jobId, `Job ${job.jobCode} has been assigned to a candidate.`],
        ]);
        for (const row of rows) assert.doesNotMatch(`${row.title} ${row.message}`, new RegExp(`${P.ANN}|${P.ANN2}`), "no passport ID in the text");
        assert.equal(jobAssignedMessage("J-1", null), "Job J-1 has been assigned to a candidate.");
        assert.equal((await a5()).length, 2);
    });

    test("a job creation that fails (one candidate refused) sends nothing", async () => {
        await prisma.candidateStage.updateMany({ where: { passportId: P.NONE }, data: { testResult: "FAIL" } });
        const res = await api(USERS.OWNER, "POST", "/jobs", { jobTypeId: ids.jobType, clientId: ids.acme, candidateIds: [P.ANN, P.NONE] });
        assert.equal(res.status, 409);
        assert.equal((await a5()).length, 0);
    });
});

describe("candidateId / jobId on the other notifications", () => {
    test("A1: the candidate when an Analyst received exactly one, otherwise null", async () => {
        await prisma.candidateAllocation.deleteMany({});
        await assignCandidates({ db: prisma, actor: USERS.ADMIN, candidateIds: [P.ANN], allocations: [{ analystId: USERS.ANN.adminId, count: 1 }] });
        await assignCandidates({ db: prisma, actor: USERS.ADMIN, candidateIds: [P.NONE, P.LEAD], allocations: [{ analystId: USERS.BEN.adminId, count: 2 }] });
        const [ann] = await prisma.notification.findMany({ where: { type: NOTIFICATION_TYPE.A1, recipientId: USERS.ANN.adminId } });
        const [ben] = await prisma.notification.findMany({ where: { type: NOTIFICATION_TYPE.A1, recipientId: USERS.BEN.adminId } });
        assert.deepEqual([ann.candidateId, ann.jobId, ann.message], [P.ANN, null, "You have received 1 new candidate."]);
        assert.deepEqual([ben.candidateId, ben.jobId, ben.message], [null, null, "You have received 2 new candidates."]);
    });

    test("A4 and E1: the candidate; C1: the job; the text is unchanged", async () => {
        await notifyCandidateFormSubmitted(prisma, { passportId: P.ANN, submittedAt: new Date("2026-11-01T10:00:00Z") });
        const [a4] = await prisma.notification.findMany({ where: { type: NOTIFICATION_TYPE.A4 } });
        assert.deepEqual([a4.candidateId, a4.jobId, a4.message], [P.ANN, null, "Nimal Perera has submitted the candidate form."]);

        await notifyCandidatesCancelled(prisma, { actorId: USERS.OWNER.adminId, actorName: "Olive Owner", passportIds: [P.NONE], at: new Date("2026-11-01T10:00:00Z") });
        const e1 = await prisma.notification.findMany({ where: { type: NOTIFICATION_TYPE.E1 } });
        assert.ok(e1.length > 0);
        for (const row of e1) assert.deepEqual([row.candidateId, row.jobId, row.message], [P.NONE, null, "Olive Owner marked Sunil Silva as Cancelled."]);

        const job = await createJob(); // P.* passed and are on no job: C1 is sent
        const c1 = await prisma.notification.findMany({ where: { type: NOTIFICATION_TYPE.C1 } });
        assert.equal(c1.length, 1);
        assert.deepEqual([c1[0].recipientId, c1[0].candidateId, c1[0].jobId], [USERS.JOBS.adminId, null, job.jobId]);
        assert.equal(c1[0].message, `A new job has been added. Job ID: ${job.jobCode}. Please review the details.`);
    });

    test("GET /notifications returns candidateId and jobId (null when absent)", async () => {
        const job = await createJob();
        await add(job, P.ANN);
        await prisma.notification.create({ data: { recipientId: USERS.ANN.adminId, type: "B2_ROLE_UPDATED", title: "Role Updated", message: "Your role has been changed to Analyst.", dedupeKey: "B2:x" } });
        const list = await api(USERS.ANN, "GET", "/notifications");
        assert.equal(list.status, 200);
        const byType = Object.fromEntries(list.body.items.map((n) => [n.type, n]));
        assert.deepEqual([byType[NOTIFICATION_TYPE.A5].candidateId, byType[NOTIFICATION_TYPE.A5].jobId], [P.ANN, job.jobId]);
        assert.deepEqual([byType.B2_ROLE_UPDATED.candidateId, byType.B2_ROLE_UPDATED.jobId], [null, null]);
    });
});
