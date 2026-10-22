// Job Management: jobs, Job Codes, Candidate <-> Job assignment, complete /
// cancel, roles and the Analyst scope, and the legacy candidate_stages.job_id.
// On a REAL PostgreSQL (PGlite, every migration applied) through the real
// Prisma client, the real services and the real admin router. No Supabase.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import express from "express";

import { createTestDatabase, migrationNames } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { formatJobCode, jobCodeYear } from "../src/services/jobService.js";
import { getCandidate } from "../src/services/candidateService.js";

const user = (adminId, role, n) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const USERS = { ADMIN: user("u-admin", "ADMIN", 1), MANAGER: user("u-manager", "MANAGER", 2), DESK: user("u-desk", "REGISTRATION_DESK", 3), ANN: user("u-ann", "ANALYST", 4), BEN: user("u-ben", "ANALYST", 5) };
const pid = (i) => `P000000${i}`;
const candidate = (i) => ({ passportId: pid(i), uniqueId: `700${i}`, firstName: `Name${i}`, otherName: `Sur${i}`, nic: `90000000${i}V` });

let database;
let prisma;
let pg;
let ids; // { jobType, company, agent }

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const u of Object.values(USERS)) await prisma.user.create({ data: u });
});
after(async () => database?.close());
beforeEach(async () => {
    await pg.exec(`
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "rate_limits"; DELETE FROM "job_candidate"; DELETE FROM "job"; DELETE FROM "job_code_counter";
        DELETE FROM "job_type"; DELETE FROM "agent_client"; DELETE FROM "client"; DELETE FROM "agent";
        DELETE FROM "candidate_allocation"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
    `);
    await prisma.candidate.createMany({ data: [1, 2, 3, 4].map(candidate) });
    // Only a candidate who passed the test can be assigned to a job: these have PASS (the rule has its own tests, jobAssignmentTestPass.test.js).
    await prisma.candidateStage.createMany({ data: [1, 2, 3, 4].map((i) => ({ passportId: pid(i), stage: "TEST_DETAILS", testResult: "PASS" })) });
    await prisma.candidateAllocation.createMany({ data: [[1, USERS.ANN], [2, USERS.ANN], [3, USERS.BEN]].map(([i, u]) => ({ passportId: pid(i), analystId: u.adminId })) });
    const jobType = await prisma.jobType.create({ data: { code: "WELDER", name: "Welder" } });
    const agent = await prisma.agent.create({ data: { name: "Ion Popescu", countryCode: "RO" } });
    const client = await prisma.client.create({ data: { name: "Acme Construction", agentLinks: { create: { agentId: agent.id } } } });
    ids = { jobType: jobType.id, client: client.id, agent: agent.id };
});

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
const createJob = async (who = USERS.MANAGER, extra = {}) => {
    const response = await api(who, "POST", "/jobs", { jobTypeId: ids.jobType, clientId: ids.client, responsibleAgentId: ids.agent, vacancies: 5, ...extra });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
};
const add = (who, job, i) => api(who, "POST", `/jobs/${job.jobId}/candidates`, { passportId: pid(i) });
const rows = (jobId) => prisma.jobCandidate.findMany({ where: { jobId }, orderBy: { passportId: "asc" } });
const activeCount = (i) => prisma.jobCandidate.count({ where: { passportId: pid(i), isActive: true } });

describe("creating jobs (JOB-001 to JOB-003)", () => {
    test("JOB-001: a PROCESSING job with a generated code, the agent's country, a real Company / Type / Agent", async () => {
        const job = await createJob();
        assert.equal(job.status, "PROCESSING");
        assert.equal(job.jobCode, formatJobCode(jobCodeYear(), 1));
        assert.match(job.jobCode, /^JOB-\d{4}-000001$/);
        assert.equal(job.countryCode, "RO", "copied from the responsible Agent");
        assert.deepEqual([job.jobType.name, job.client.name, job.responsibleAgent.name, job.vacancies, job.candidateCount], ["Welder", "Acme Construction", "Ion Popescu", 5, 0]);
        const audit = await prisma.auditLog.findMany({ where: { action: "CREATE_JOB" } });
        assert.equal(audit.length, 1);
    });

    test("JOB-002: job codes are unique and sequential per year, also when requested at the same time", async () => {
        const created = await Promise.all([1, 2, 3, 4, 5].map(() => createJob()));
        const codes = created.map((job) => job.jobCode).sort();
        assert.deepEqual(codes, [1, 2, 3, 4, 5].map((n) => formatJobCode(jobCodeYear(), n)));
        assert.equal(new Set(codes).size, 5);
        // The database refuses a duplicate or malformed code outright.
        await assert.rejects(pg.exec(`UPDATE "job" SET "job_code" = '${codes[0]}' WHERE "job_code" = '${codes[1]}'`), /unique|duplicate/i);
        await assert.rejects(pg.exec(`UPDATE "job" SET "job_code" = 'JOB-1' WHERE "job_code" = '${codes[1]}'`), /check/i);
        // A new year starts again at 1 (formatted from the counter, not MAX()+1).
        assert.equal(formatJobCode(2027, 1), "JOB-2027-000001");
    });

    test("a failed creation does not use up a number", async () => {
        const bad = await api(USERS.MANAGER, "POST", "/jobs", { jobTypeId: ids.jobType, clientId: ids.client, responsibleAgentId: "11111111-1111-4111-8111-111111111111" });
        assert.equal(bad.status, 409);
        assert.equal(bad.body.code, "CLIENT_AGENT_MISMATCH");
        assert.equal((await createJob()).jobCode, formatJobCode(jobCodeYear(), 1));
    });

    test("JOB-003: Job Type and Client are required real references (the Agent follows the Client), never free text", async () => {
        for (const field of ["jobTypeId", "clientId"]) {
            const body = { jobTypeId: ids.jobType, clientId: ids.client, responsibleAgentId: ids.agent };
            delete body[field];
            const response = await api(USERS.MANAGER, "POST", "/jobs", body);
            assert.equal(response.status, 400, field);
            assert.deepEqual(response.body.errors.map((e) => e.field), [field]);
        }
        assert.equal((await api(USERS.MANAGER, "POST", "/jobs", { jobTypeId: "Welder", clientId: ids.client, responsibleAgentId: ids.agent })).status, 400, "free-text job type");
        assert.equal((await api(USERS.MANAGER, "POST", "/jobs", { jobTypeId: ids.jobType, clientId: ids.client, responsibleAgentId: ids.agent, vacancies: 0 })).status, 400);
        // An inactive reference cannot be used for a new job.
        await prisma.client.update({ where: { id: ids.client }, data: { isActive: false } });
        const inactive = await api(USERS.MANAGER, "POST", "/jobs", { jobTypeId: ids.jobType, clientId: ids.client, responsibleAgentId: ids.agent });
        assert.deepEqual([inactive.status, inactive.body.code], [409, "CLIENT_INACTIVE"]);
        // The foreign keys are real.
        await assert.rejects(pg.exec(`INSERT INTO "job" ("job_code","job_type_id","client_id","responsible_agent_id","country_code","created_by") VALUES ('JOB-2026-999999', gen_random_uuid(), '${ids.client}', '${ids.agent}', 'RO', 'u-admin')`), /foreign key/i);
    });

    test("reference data: created by ADMIN / MANAGER, unique by name, listed for the job form", async () => {
        const type = await api(USERS.MANAGER, "POST", "/job-types", { name: "  Tile   Fitter " });
        assert.equal(type.status, 201);
        assert.deepEqual([type.body.name, type.body.code], ["Tile Fitter", "TILE_FITTER"]);
        assert.equal((await api(USERS.MANAGER, "POST", "/job-types", { name: "tile fitter" })).status, 409);
        const options = await api(USERS.MANAGER, "GET", "/job-options");
        assert.deepEqual([options.body.jobTypes.length, options.body.clients.length, options.body.agents.length], [2, 1, 1]);
        assert.deepEqual(options.body.clients[0], { id: ids.client, name: "Acme Construction", agentIds: [ids.agent] }, "each client carries its active agents (the To Country is the chosen agent's)");
    });
});

describe("assigning candidates (JOB-004 to JOB-008)", () => {
    test("JOB-004: a candidate is assigned to a PROCESSING job", async () => {
        const job = await createJob();
        const response = await add(USERS.MANAGER, job, 1);
        assert.equal(response.status, 201);
        assert.deepEqual(response.body.candidates.map((c) => c.passportId), [pid(1)]);
        assert.equal(response.body.candidateCount, 1);
        const [row] = await rows(job.jobId);
        assert.deepEqual([row.isActive, row.assignedBy, row.releasedAt], [true, USERS.MANAGER.adminId, null]);
        assert.equal((await prisma.auditLog.findMany({ where: { action: "ADD_CANDIDATE_TO_JOB", passportId: pid(1) } })).length, 1);
        assert.equal((await add(USERS.MANAGER, job, 9)).status, 404, "unknown candidate");
        assert.equal((await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/candidates`, {})).status, 400);
        assert.equal((await api(USERS.MANAGER, "POST", `/jobs/11111111-1111-4111-8111-111111111111/candidates`, { passportId: pid(1) })).status, 404, "unknown job");
    });

    test("JOB-005: the same candidate cannot be added to the same job twice", async () => {
        const job = await createJob();
        await add(USERS.MANAGER, job, 1);
        const again = await add(USERS.MANAGER, job, 1);
        assert.equal(again.status, 409);
        assert.equal(again.body.code, "CANDIDATE_ALREADY_IN_JOB");
        assert.equal((await rows(job.jobId)).length, 1);
    });

    test("JOB-006 (multiple jobs): a candidate can be on two PROCESSING jobs; the same job twice is refused; the first job is untouched", async () => {
        const first = await createJob();
        const second = await createJob();
        await add(USERS.MANAGER, first, 1);
        assert.equal((await add(USERS.ADMIN, second, 1)).status, 201, "job B as well as job A");
        assert.equal((await rows(second.jobId)).length, 1);
        assert.equal((await rows(first.jobId)).length, 1);
        assert.equal(await activeCount(1), 2);
        const again = await add(USERS.ADMIN, first, 1);
        assert.deepEqual([again.status, again.body.code], [409, "CANDIDATE_ALREADY_IN_JOB"]);
        assert.equal(await activeCount(1), 2, "a refused duplicate changes nothing");
        // Other candidates are unaffected.
        assert.equal((await add(USERS.ADMIN, second, 2)).status, 201);
    });

    test("MULTI-JOB: removing the candidate from job A leaves job B; completing job B leaves job C; history stays", async () => {
        const [a, b, c] = [await createJob(), await createJob(), await createJob()];
        for (const job of [a, b, c]) assert.equal((await add(USERS.MANAGER, job, 1)).status, 201);
        assert.equal((await api(USERS.MANAGER, "DELETE", `/jobs/${a.jobId}/candidates/${pid(1)}`)).status, 200);
        assert.equal((await api(USERS.MANAGER, "POST", `/jobs/${b.jobId}/complete`)).status, 200);
        const memberships = await prisma.jobCandidate.findMany({ where: { passportId: pid(1) }, select: { jobId: true, isActive: true, releasedAt: true } });
        const byJob = Object.fromEntries(memberships.map((m) => [m.jobId, m]));
        assert.deepEqual([byJob[a.jobId].isActive, byJob[a.jobId].releasedAt !== null], [false, true], "A: removed, row kept");
        assert.deepEqual([byJob[b.jobId].isActive, byJob[b.jobId].releasedAt], [false, null], "B: completed, row kept");
        assert.equal(byJob[c.jobId].isActive, true, "C: still active");
        const details = await getCandidate({ db: prisma, passportId: pid(1) });
        assert.deepEqual(details.jobAssignments.active.map((j) => j.jobCode), [c.jobCode]);
        assert.deepEqual(details.jobAssignments.history.map((j) => j.jobCode).sort(), [a.jobCode, b.jobCode].sort());
        // Job Details of C still lists the candidate.
        assert.deepEqual((await api(USERS.MANAGER, "GET", `/jobs/${c.jobId}`)).body.candidates.map((x) => x.passportId), [pid(1)]);
    });

    test("JOB-007 / JOB-008: nothing can be assigned to a COMPLETED or CANCELLED job", async () => {
        const done = await createJob();
        const cancelled = await createJob();
        assert.equal((await api(USERS.MANAGER, "POST", `/jobs/${done.jobId}/complete`)).status, 200);
        assert.equal((await api(USERS.MANAGER, "POST", `/jobs/${cancelled.jobId}/cancel`, { reason: "Client withdrew" })).status, 200);
        for (const job of [done, cancelled]) {
            const response = await add(USERS.MANAGER, job, 1);
            assert.equal(response.status, 409, job.jobCode);
            assert.equal(response.body.code, "JOB_NOT_PROCESSING");
            assert.equal((await rows(job.jobId)).length, 0);
        }
    });

    test("a candidate removed from a job keeps the row (released) and can be put on another job, or back", async () => {
        const first = await createJob();
        const second = await createJob();
        await add(USERS.MANAGER, first, 1);
        const removed = await api(USERS.MANAGER, "DELETE", `/jobs/${first.jobId}/candidates/${pid(1)}`);
        assert.equal(removed.status, 200);
        assert.equal(removed.body.candidateCount, 0);
        const [row] = await rows(first.jobId);
        assert.deepEqual([row.isActive, row.releasedAt !== null], [false, true], "kept as history");
        assert.equal((await api(USERS.MANAGER, "DELETE", `/jobs/${first.jobId}/candidates/${pid(1)}`)).status, 404, "already removed");
        assert.equal((await add(USERS.MANAGER, second, 1)).status, 201);
        await api(USERS.MANAGER, "DELETE", `/jobs/${second.jobId}/candidates/${pid(1)}`);
        assert.equal((await add(USERS.MANAGER, first, 1)).status, 201, "back on the first job: the same membership row is reused");
        assert.equal((await rows(first.jobId)).length, 1);
        assert.equal(await activeCount(1), 1);
    });
});

describe("completing and cancelling (JOB-009 to JOB-013)", () => {
    test("JOB-009 / JOB-011: completing releases the candidates and keeps the history", async () => {
        const job = await createJob();
        await add(USERS.MANAGER, job, 1);
        await add(USERS.MANAGER, job, 2);
        const completed = await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/complete`);
        assert.equal(completed.status, 200);
        assert.equal(completed.body.status, "COMPLETED");
        assert.ok(completed.body.completedAt);
        assert.equal(completed.body.candidateCount, 2, "the assignment history stays visible");
        assert.deepEqual((await rows(job.jobId)).map((r) => [r.passportId, r.isActive]), [[pid(1), false], [pid(2), false]]);
        // Released: free for another PROCESSING job.
        const next = await createJob();
        assert.equal((await add(USERS.MANAGER, next, 1)).status, 201);
        // The candidate page: current job + history.
        const details = await getCandidate({ db: prisma, passportId: pid(1) });
        assert.equal(details.jobAssignments.current.jobCode, next.jobCode);
        assert.deepEqual(details.jobAssignments.history.map((h) => [h.jobCode, h.status]), [[job.jobCode, "COMPLETED"]]);
        assert.equal((await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/complete`)).status, 409, "completing twice");
    });

    test("JOB-010 / JOB-012: cancelling releases the candidates and keeps the history", async () => {
        const job = await createJob();
        await add(USERS.MANAGER, job, 3);
        const cancelled = await api(USERS.ADMIN, "POST", `/jobs/${job.jobId}/cancel`, { reason: "  Visa quota cancelled " });
        assert.equal(cancelled.status, 200);
        assert.deepEqual([cancelled.body.status, cancelled.body.cancelReason, cancelled.body.candidateCount], ["CANCELLED", "Visa quota cancelled", 1]);
        assert.ok(cancelled.body.cancelledAt);
        assert.deepEqual((await rows(job.jobId)).map((r) => r.isActive), [false]);
        assert.equal(await activeCount(3), 0);
        assert.equal((await add(USERS.MANAGER, await createJob(), 3)).status, 201);
        const details = await getCandidate({ db: prisma, passportId: pid(3) });
        assert.deepEqual(details.jobAssignments.history.map((h) => [h.jobCode, h.status, h.cancelReason]), [[job.jobCode, "CANCELLED", "Visa quota cancelled"]]);
        assert.equal((await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/cancel`, { reason: "again" })).status, 409);
    });

    test("JOB-013: cancelling needs a reason (API and database)", async () => {
        const job = await createJob();
        for (const body of [{}, { reason: "" }, { reason: "   " }, { reason: 5 }, { reason: "x".repeat(501) }]) {
            const response = await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/cancel`, body);
            assert.equal(response.status, 400, JSON.stringify(body).slice(0, 30));
        }
        assert.equal((await prisma.job.findUnique({ where: { id: job.jobId } })).status, "PROCESSING");
        await assert.rejects(pg.exec(`UPDATE "job" SET "status" = 'CANCELLED', "cancelled_at" = now() WHERE "id" = '${job.jobId}'`), /check/i, "no cancel without a reason, even directly");
    });

    test("a finished job cannot be reopened (database trigger), and a job with assignments cannot be deleted", async () => {
        const job = await createJob();
        await add(USERS.MANAGER, job, 1);
        await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/complete`);
        await assert.rejects(pg.exec(`UPDATE "job" SET "status" = 'PROCESSING', "completed_at" = NULL WHERE "id" = '${job.jobId}'`), /cannot change status/);
        await assert.rejects(pg.exec(`DELETE FROM "job" WHERE "id" = '${job.jobId}'`), /foreign key/i);
        await assert.rejects(pg.exec(`UPDATE "job_candidate" SET "is_active" = true WHERE "job_id" = '${job.jobId}'`), /not PROCESSING/);
    });

    test("a PROCESSING job can be updated (vacancies, type, company); a finished one cannot", async () => {
        const job = await createJob();
        const updated = await api(USERS.MANAGER, "PUT", `/jobs/${job.jobId}`, { vacancies: 12 });
        assert.equal(updated.status, 200);
        assert.equal(updated.body.vacancies, 12);
        assert.equal((await api(USERS.MANAGER, "PUT", `/jobs/${job.jobId}`, { vacancies: null })).body.vacancies, null);
        for (const body of [{}, { responsibleAgentId: ids.agent }, { countryCode: "US" }, { status: "COMPLETED" }, { vacancies: -1 }]) {
            assert.equal((await api(USERS.MANAGER, "PUT", `/jobs/${job.jobId}`, body)).status, 400, JSON.stringify(body));
        }
        await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/complete`);
        assert.equal((await api(USERS.MANAGER, "PUT", `/jobs/${job.jobId}`, { vacancies: 3 })).status, 409);
    });
});

describe("multiple jobs under concurrency and in the database (JOB-014)", () => {
    test("JOB-014: the same candidate assigned to three jobs at the same time -> all three succeed, one row each", async () => {
        const jobs = [await createJob(), await createJob(), await createJob()];
        const results = await Promise.all(jobs.map((job, n) => add(n % 2 ? USERS.ADMIN : USERS.MANAGER, job, 4)));
        assert.deepEqual(results.map((r) => r.status), [201, 201, 201]);
        assert.equal(await activeCount(4), 3);
        assert.equal(await prisma.jobCandidate.count({ where: { passportId: pid(4) } }), 3);
    });

    test("JOB-014b: the same candidate assigned to the SAME job twice at once -> exactly one succeeds, one row", async () => {
        const job = await createJob();
        const results = await Promise.all([add(USERS.ADMIN, job, 4), add(USERS.MANAGER, job, 4)]);
        assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
        assert.equal(results.find((r) => r.status === 409).body.code, "CANDIDATE_ALREADY_IN_JOB");
        assert.equal(await prisma.jobCandidate.count({ where: { passportId: pid(4) } }), 1);
    });

    test("the database allows several active memberships on different jobs, and refuses the same job twice, however it is written", async () => {
        const [a, b] = [await createJob(), await createJob()];
        await pg.exec(`INSERT INTO "job_candidate" ("job_id","passport_id","assigned_by") VALUES ('${a.jobId}','${pid(4)}','u-admin')`);
        await pg.exec(`INSERT INTO "job_candidate" ("job_id","passport_id","assigned_by") VALUES ('${b.jobId}','${pid(4)}','u-admin')`);
        await assert.rejects(pg.exec(`INSERT INTO "job_candidate" ("job_id","passport_id","assigned_by") VALUES ('${a.jobId}','${pid(4)}','u-admin')`), /job_candidate_pkey|duplicate|unique/i);
        assert.equal(await activeCount(4), 2);
        const indexes = (await pg.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'job_candidate'`)).rows.map((r) => r.indexname);
        assert.ok(!indexes.includes("job_candidate_one_active_per_candidate"), "the single-active index is gone");
        assert.ok(indexes.includes("job_candidate_pkey") && indexes.includes("job_candidate_passport_id_idx"));
    });
});

describe("roles and the Analyst scope (JOB-015, JOB-016)", () => {
    test("JOB-015: only ADMIN and MANAGER manage jobs; the REGISTRATION_DESK has no access", async () => {
        const job = await createJob();
        const writes = [
            ["POST", "/jobs", { jobTypeId: ids.jobType, clientId: ids.client, responsibleAgentId: ids.agent }],
            ["PUT", `/jobs/${job.jobId}`, { vacancies: 2 }],
            ["POST", `/jobs/${job.jobId}/candidates`, { passportId: pid(1) }],
            ["DELETE", `/jobs/${job.jobId}/candidates/${pid(1)}`],
            ["POST", `/jobs/${job.jobId}/complete`, {}],
            ["POST", `/jobs/${job.jobId}/cancel`, { reason: "x" }],
            ["POST", "/job-types", { name: "Cook" }], ["POST", "/agents", { name: "A", countryCode: "RO" }], ["POST", "/client-management", { name: "Co", agentId: ids.agent }],
            ["GET", "/job-options"],
        ];
        for (const who of [USERS.ANN, USERS.DESK]) {
            for (const [method, urlPath, body] of writes) assert.equal((await api(who, method, urlPath, body)).status, 403, `${who.role} ${method} ${urlPath}`);
        }
        for (const urlPath of ["/jobs", `/jobs/${job.jobId}`]) assert.equal((await api(USERS.DESK, "GET", urlPath)).status, 403, `DESK ${urlPath}`);
        assert.equal((await prisma.job.findUnique({ where: { id: job.jobId } })).status, "PROCESSING");
        assert.equal(await prisma.jobCandidate.count(), 0);
        for (const who of [USERS.ADMIN, USERS.MANAGER]) assert.equal((await api(who, "GET", "/jobs")).status, 200, who.role);
    });

    test("JOB-016: an Analyst sees only jobs holding their own candidates, and only those candidates", async () => {
        const [j1, j2, j3] = [await createJob(), await createJob(), await createJob()];
        await add(USERS.MANAGER, j1, 1); // Ann's
        await add(USERS.MANAGER, j1, 2); // Ann's
        await add(USERS.MANAGER, j1, 4); // unallocated
        await add(USERS.MANAGER, j2, 3); // Ben's only
        void j3; // no candidates
        const list = await api(USERS.ANN, "GET", "/jobs");
        assert.deepEqual(list.body.items.map((j) => [j.jobCode, j.candidateCount]), [[j1.jobCode, 2]], "the count is the Analyst's own candidates");
        assert.deepEqual(list.body.counts, { processing: 1, completed: 0, cancelled: 0 });
        const detail = await api(USERS.ANN, "GET", `/jobs/${j1.jobId}`);
        assert.equal(detail.status, 200);
        assert.deepEqual(detail.body.candidates.map((c) => c.passportId), [pid(1), pid(2)]);
        assert.equal((await api(USERS.ANN, "GET", `/jobs/${j2.jobId}`)).status, 404, "a job of other Analysts' candidates looks nonexistent");
        assert.equal((await api(USERS.ANN, "GET", `/jobs/${j3.jobId}`)).status, 404, "an empty job too");
        const manager = await api(USERS.MANAGER, "GET", `/jobs/${j1.jobId}`);
        assert.equal(manager.body.candidates.length, 3);
        assert.deepEqual((await api(USERS.BEN, "GET", "/jobs")).body.items.map((j) => j.jobCode), [j2.jobCode]);
    });
});

describe("lists, details and the candidate page (JOB-017)", () => {
    test("Processing / Completed / Cancelled views, counts and search", async () => {
        const [a, b, c] = [await createJob(), await createJob(), await createJob()];
        await api(USERS.MANAGER, "POST", `/jobs/${b.jobId}/complete`);
        await api(USERS.MANAGER, "POST", `/jobs/${c.jobId}/cancel`, { reason: "No demand" });
        await add(USERS.MANAGER, a, 1);
        const view = async (name, query = "") => (await api(USERS.MANAGER, "GET", `/jobs?view=${name}${query}`)).body;
        assert.deepEqual((await view("processing")).items.map((j) => [j.jobCode, j.candidateCount]), [[a.jobCode, 1]]);
        assert.deepEqual((await view("completed")).items.map((j) => j.jobCode), [b.jobCode]);
        assert.deepEqual((await view("cancelled")).items.map((j) => j.jobCode), [c.jobCode]);
        assert.deepEqual((await view("processing")).counts, { processing: 1, completed: 1, cancelled: 1 });
        assert.equal((await view("processing", "&search=acme")).items.length, 1);
        assert.equal((await view("processing", `&search=${a.jobCode.toLowerCase()}`)).items.length, 1);
        assert.equal((await view("processing", "&search=nobody")).items.length, 0);
        assert.equal((await api(USERS.MANAGER, "GET", "/jobs?view=other")).status, 400);
        // JOB-FILTER: All lists every status (newest first), with the same counts, search and pages.
        assert.deepEqual((await view("all")).items.map((j) => j.jobCode), [c.jobCode, b.jobCode, a.jobCode]);
        assert.deepEqual((await view("all")).counts, { processing: 1, completed: 1, cancelled: 1 });
        assert.deepEqual((await view("all")).filters, { view: "all", search: null });
        assert.deepEqual((await view("all", `&search=${b.jobCode.toLowerCase()}`)).items.map((j) => j.jobCode), [b.jobCode]);
        assert.equal((await view("all", "&page=2")).items.length, 0);
        const detail = (await api(USERS.MANAGER, "GET", `/jobs/${a.jobId}`)).body;
        assert.deepEqual([detail.jobCode, detail.jobType.name, detail.client.name, detail.countryCode, detail.responsibleAgent.name, detail.vacancies, detail.createdBy], [a.jobCode, "Welder", "Acme Construction", "RO", "Ion Popescu", 5, USERS.MANAGER.name]);
        assert.deepEqual(detail.candidates.map((x) => [x.passportId, x.name]), [[pid(1), "Name1 Sur1"]]);
        assert.equal((await api(USERS.MANAGER, "GET", "/jobs/not-a-uuid")).status, 404);
    });

    test("JOB-017: Candidate Details reads the job from the Job relation (current + history)", async () => {
        const job = await createJob();
        await add(USERS.MANAGER, job, 1);
        const details = await getCandidate({ db: prisma, passportId: pid(1) });
        assert.equal(details.jobAssignments.current.jobCode, job.jobCode);
        assert.deepEqual([details.jobAssignments.current.jobType.name, details.jobAssignments.current.client.name, details.jobAssignments.current.responsibleAgent.name], ["Welder", "Acme Construction", "Ion Popescu"]);
        assert.deepEqual(details.jobAssignments.history, []);
        const viaApi = await api(USERS.ANN, "GET", `/candidates/${pid(1)}`);
        assert.equal(viaApi.body.jobAssignments.current.jobCode, job.jobCode);
        assert.deepEqual(details.jobAssignments.active.map((j) => j.jobCode), [job.jobCode]);
        assert.deepEqual((await getCandidate({ db: prisma, passportId: pid(2) })).jobAssignments, { current: null, active: [], history: [] });
    });
});

describe("the legacy candidate_stages.job_id (migration)", () => {
    test("migration: existing candidate_stages.job_id values survive untouched, no job is invented, RLS is on", async () => {
        const names = migrationNames();
        const target = names.indexOf("20261018120000_job_management");
        assert.ok(target > 0, "the migration exists and is last-but-not-first");
        const old = await createTestDatabase({ upTo: names[target - 1] });
        try {
            await old.pg.exec(`INSERT INTO "candidate" ("passport_id","unique_id","first_name","updated_date") VALUES ('L0000001','9001','Legacy', now()), ('L0000002','9002','Legacy2', now());
                INSERT INTO "candidate_stages" ("passport_id","stage","job_id","updated_at") VALUES ('L0000001','TEST_DETAILS','Job12', now()), ('L0000002','TEST_DETAILS','  job12 ', now()), ('L0000002','FINALIZING_JOB', NULL, now())`);
            const before = (await old.pg.query(`SELECT "passport_id","stage","job_id" FROM "candidate_stages" ORDER BY 1,2`)).rows;
            await old.pg.exec(fs.readFileSync(path.join(import.meta.dirname, "..", "prisma", "migrations", names[target], "migration.sql"), "utf8"));
            const after = (await old.pg.query(`SELECT "passport_id","stage","job_id" FROM "candidate_stages" ORDER BY 1,2`)).rows;
            assert.deepEqual(after, before, "every legacy value, including the odd ones, is exactly as it was");
            assert.equal((await old.pg.query(`SELECT count(*)::int AS n FROM "job"`)).rows[0].n, 0, "no Job fabricated");
            assert.equal((await old.pg.query(`SELECT count(*)::int AS n FROM "job_candidate"`)).rows[0].n, 0, "no assignment fabricated");
            const rls = (await old.pg.query(`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('job','job_candidate','job_type','company','agent','job_code_counter') ORDER BY 1`)).rows;
            assert.equal(rls.length, 6);
            assert.ok(rls.every((r) => r.relrowsecurity), "RLS enabled on every new table");
            const grants = (await old.pg.query(`SELECT grantee, table_name FROM information_schema.role_table_grants WHERE grantee IN ('anon','authenticated') AND table_name IN ('job','job_candidate','job_type','company','agent','job_code_counter')`)).rows;
            assert.deepEqual(grants, [], "no privileges for the API roles");
            const policies = (await old.pg.query(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename IN ('job','job_candidate','job_type','company','agent','job_code_counter')`)).rows[0].n;
            assert.equal(policies, 0);
        } finally {
            await old.close();
        }
    });
});

describe("the Job tables are backend-only", () => {
    test("RLS enabled and no privileges for anon / authenticated on the current schema", async () => {
        const tables = "('job','job_candidate','job_type','client','agent','job_code_counter')";
        const rls = (await pg.query(`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ${tables}`)).rows;
        assert.equal(rls.length, 6);
        assert.ok(rls.every((r) => r.relrowsecurity));
        assert.deepEqual((await pg.query(`SELECT 1 FROM information_schema.role_table_grants WHERE grantee IN ('anon','authenticated') AND table_name IN ${tables}`)).rows, []);
    });
});
