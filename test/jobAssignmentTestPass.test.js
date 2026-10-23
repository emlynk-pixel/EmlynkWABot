// Job assignment needs a PASSED test (JOB-PASS-001 to 012), on a REAL PostgreSQL (PGlite, every
// migration applied) through the real Prisma client, services and admin router.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { TEST_RESULTS, TEST_RESULT_PASS } from "../src/services/candidateService.js";

const user = (adminId, role, n) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const USERS = { ADMIN: user("u-admin", "ADMIN", 1), MANAGER: user("u-manager", "MANAGER", 2), DESK: user("u-desk", "REGISTRATION_DESK", 3), ANALYST: user("u-ann", "ANALYST", 4) };
// P1 PASS, P2 FAIL, P3 no test row at all, P4 completed Test details with no result, P5 completed + FAIL
const P = { PASS: "P0000001", FAIL: "P0000002", NONE: "P0000003", DONE_NO_RESULT: "P0000004", DONE_FAIL: "P0000005" };

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
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "rate_limits"; DELETE FROM "job_candidate"; DELETE FROM "job"; DELETE FROM "job_code_counter";
        DELETE FROM "job_type"; DELETE FROM "agent_client"; DELETE FROM "client"; DELETE FROM "agent";
        DELETE FROM "candidate_allocation"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
    `);
    const names = ["Passed", "Failed", "Untested", "DoneNoResult", "DoneFail"];
    await prisma.candidate.createMany({ data: Object.values(P).map((passportId, i) => ({ passportId, uniqueId: `700${i}`, firstName: names[i], otherName: "Candidate", nic: `90000000${i}V` })) });
    await prisma.candidateStage.createMany({
        data: [
            { passportId: P.PASS, stage: "TEST_DETAILS", testResult: "PASS" },
            { passportId: P.FAIL, stage: "TEST_DETAILS", testResult: "FAIL" },
            { passportId: P.DONE_NO_RESULT, stage: "TEST_DETAILS", completed: true, completedAt: new Date() },
            { passportId: P.DONE_FAIL, stage: "TEST_DETAILS", completed: true, completedAt: new Date(), testResult: "FAIL" },
        ],
    });
    const jobType = await prisma.jobType.create({ data: { code: "WELDER", name: "Welder" } });
    const agent = await prisma.agent.create({ data: { name: "Ion Popescu", countryCode: "RO" } });
    const acme = await prisma.client.create({ data: { name: "Acme Builders", agentLinks: { create: { agentId: agent.id } } } });
    ids = { jobType: jobType.id, acme: acme.id };
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
const createJob = async () => {
    const response = await api(USERS.MANAGER, "POST", "/jobs", { jobTypeId: ids.jobType, clientId: ids.acme });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
};
const add = (who, job, passportId) => api(who, "POST", `/jobs/${job.jobId}/candidates`, { passportId });
const setResult = (passportId, testResult) => api(USERS.ADMIN, "PUT", `/candidates/${passportId}/stages/TEST_DETAILS`, { testResult });
const memberCount = () => prisma.jobCandidate.count();
const NOT_PASSED = { status: 409, code: "CANDIDATE_TEST_NOT_PASSED", message: "Candidate must pass the test before being assigned to a job." };
const refusal = (response) => ({ status: response.status, code: response.body?.code, message: response.body?.message });

describe("the canonical PASS value", () => {
    test("Test result is the controlled text PASS or FAIL, and PASS is the only eligible value", () => {
        assert.deepEqual([...TEST_RESULTS], ["PASS", "FAIL"]);
        assert.equal(TEST_RESULT_PASS, "PASS");
    });
});

describe("assignment is allowed only after a PASS (JOB-PASS-001 to 004, 008)", () => {
    test("JOB-PASS-001: a PASS candidate is assigned", async () => {
        const job = await createJob();
        const response = await add(USERS.MANAGER, job, P.PASS);
        assert.equal(response.status, 201, JSON.stringify(response.body));
        assert.equal(await memberCount(), 1);
    });

    test("JOB-PASS-002 / 003 / 004: FAIL, no Test details at all, and completed Test details without PASS are refused with a controlled error, creating nothing", async () => {
        const job = await createJob();
        for (const [label, passportId] of [["FAIL", P.FAIL], ["no test row", P.NONE], ["completed, no result", P.DONE_NO_RESULT], ["completed, FAIL", P.DONE_FAIL]]) {
            const response = await add(USERS.MANAGER, job, passportId);
            assert.deepEqual(refusal(response), NOT_PASSED, label);
            assert.doesNotMatch(JSON.stringify(response.body), /prisma|constraint|SQL|stack/i, label);
        }
        assert.equal(await memberCount(), 0, "no assignment was created");
        assert.equal((await audit("ADD_CANDIDATE_TO_JOB")).length, 0, "and none was audited");
    });

    test("JOB-PASS-008: a direct request with any non-PASS candidate id is refused, whatever the case of the id, for ADMIN and MANAGER alike", async () => {
        const job = await createJob();
        for (const who of [USERS.ADMIN, USERS.MANAGER]) {
            assert.equal((await add(who, job, P.FAIL)).body.code, "CANDIDATE_TEST_NOT_PASSED");
            assert.equal((await add(who, job, P.FAIL.toLowerCase())).body.code, "CANDIDATE_TEST_NOT_PASSED");
        }
        assert.equal(await memberCount(), 0);
    });

    test("only the saved Test result counts: not stage completion, the Job details stage, the legacy job_id or candidate.job", async () => {
        const job = await createJob();
        await prisma.candidateStage.create({ data: { passportId: P.NONE, stage: "JOB_DETAILS", completed: true, completedAt: new Date(), jobId: "Legacy-Job-1" } });
        await prisma.candidate.update({ where: { passportId: P.NONE }, data: { job: "Welder" } });
        await prisma.candidateStage.update({ where: { passportId_stage: { passportId: P.DONE_NO_RESULT, stage: "TEST_DETAILS" } }, data: { jobId: "T-PASS" } });
        assert.equal((await add(USERS.MANAGER, job, P.NONE)).body.code, "CANDIDATE_TEST_NOT_PASSED");
        assert.equal((await add(USERS.MANAGER, job, P.DONE_NO_RESULT)).body.code, "CANDIDATE_TEST_NOT_PASSED");
        // An unrecognised stored value is not a pass either.
        await pg.exec(`UPDATE candidate_stages SET test_result = 'pass' WHERE passport_id = '${P.PASS}'`);
        assert.equal((await add(USERS.MANAGER, job, P.PASS)).body.code, "CANDIDATE_TEST_NOT_PASSED", "only the exact controlled value PASS");
        await pg.exec(`UPDATE candidate_stages SET test_result = 'PASS' WHERE passport_id = '${P.PASS}'`);
        assert.equal((await add(USERS.MANAGER, job, P.PASS)).status, 201);
    });

    test("becoming PASS makes the candidate assignable (the result is read at the moment of assigning)", async () => {
        const job = await createJob();
        assert.equal((await add(USERS.MANAGER, job, P.FAIL)).status, 409);
        assert.equal((await setResult(P.FAIL, "PASS")).status, 200);
        assert.equal((await add(USERS.MANAGER, job, P.FAIL)).status, 201);
        assert.equal((await setResult(P.NONE, "PASS")).status, 200, "a candidate with no Test details row yet");
        assert.equal((await add(USERS.MANAGER, job, P.NONE)).status, 201);
    });
});

const audit = (action) => prisma.auditLog.findMany({ where: { action } });

describe("existing assignments and moves (JOB-PASS-009, 010)", () => {
    test("JOB-PASS-009: an existing assignment is NOT removed when the result later changes away from PASS", async () => {
        const job = await createJob();
        assert.equal((await add(USERS.MANAGER, job, P.PASS)).status, 201);
        assert.equal((await setResult(P.PASS, "FAIL")).status, 200);
        const rows = await prisma.jobCandidate.findMany({ where: { passportId: P.PASS } });
        assert.deepEqual(rows.map((r) => [r.isActive, r.releasedAt]), [[true, null]]);
        const detail = (await api(USERS.MANAGER, "GET", `/jobs/${job.jobId}`)).body;
        assert.deepEqual(detail.candidates.map((c) => c.passportId), [P.PASS]);
        const stage = (await api(USERS.ADMIN, "GET", `/candidates/${P.PASS}`)).body.stages.find((s) => s.stage === "JOB_DETAILS");
        assert.equal(stage.jobCode, job.jobCode, "Job details still shows the assigned job");
        // Completing the job keeps the history too.
        await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/complete`, {});
        assert.equal(await prisma.jobCandidate.count({ where: { passportId: P.PASS } }), 1);
    });

    test("JOB-PASS-010: once no longer PASS, a candidate cannot be moved to another job, nor put back on the one they left", async () => {
        const first = await createJob();
        const second = await createJob();
        assert.equal((await add(USERS.MANAGER, first, P.PASS)).status, 201);
        await setResult(P.PASS, "FAIL");
        // Still on the first job: the "already on a PROCESSING job" rule answers first, and nothing changes.
        assert.equal((await add(USERS.MANAGER, second, P.PASS)).status, 409);
        // Take them off the first job, then try again.
        assert.equal((await api(USERS.MANAGER, "DELETE", `/jobs/${first.jobId}/candidates/${P.PASS}`)).status, 200);
        assert.deepEqual(refusal(await add(USERS.MANAGER, second, P.PASS)), NOT_PASSED);
        assert.deepEqual(refusal(await add(USERS.MANAGER, first, P.PASS)), NOT_PASSED, "putting them back is a new assignment too");
        const rows = await prisma.jobCandidate.findMany({ where: { passportId: P.PASS } });
        assert.deepEqual(rows.map((r) => [r.jobId, r.isActive, r.releasedAt !== null]), [[first.jobId, false, true]], "the released history row is untouched");
        // PASS again: allowed.
        await setResult(P.PASS, "PASS");
        assert.equal((await add(USERS.MANAGER, second, P.PASS)).status, 201);
    });
});

describe("the Add candidate search (JOB-PASS-007)", () => {
    const names = (response) => response.body.items.map((item) => item.passportId).sort();

    test("testResult=PASS lists only candidates whose saved Test result is PASS, on the server", async () => {
        const all = await api(USERS.MANAGER, "GET", "/candidates?pageSize=100");
        assert.deepEqual(names(all), Object.values(P).sort(), "without the filter every candidate is listed");
        const passed = await api(USERS.MANAGER, "GET", "/candidates?pageSize=100&testResult=PASS");
        assert.equal(passed.status, 200);
        assert.deepEqual(names(passed), [P.PASS]);
        assert.equal(passed.body.pagination.total, 1);
        assert.equal(passed.body.filters.testResult, "PASS");
        // Together with a text search; and the total counts only eligible candidates.
        assert.deepEqual(names(await api(USERS.MANAGER, "GET", "/candidates?testResult=PASS&search=Passed")), [P.PASS]);
        assert.deepEqual(names(await api(USERS.MANAGER, "GET", "/candidates?testResult=PASS&search=Failed")), []);
        // Becoming PASS puts the candidate in the list.
        await setResult(P.FAIL, "PASS");
        assert.deepEqual(names(await api(USERS.MANAGER, "GET", "/candidates?testResult=PASS")), [P.PASS, P.FAIL].sort());
    });

    test("only PASS is a valid value of the filter", async () => {
        for (const value of ["FAIL", "pass", "ANY"]) assert.equal((await api(USERS.MANAGER, "GET", `/candidates?testResult=${value}`)).status, 400, value);
    });

    test("the filter does not widen an Analyst's own scope", async () => {
        await prisma.candidateAllocation.create({ data: { passportId: P.PASS, analystId: USERS.ANALYST.adminId } });
        await prisma.candidateStage.update({ where: { passportId_stage: { passportId: P.FAIL, stage: "TEST_DETAILS" } }, data: { testResult: "PASS" } });
        assert.deepEqual(names(await api(USERS.ANALYST, "GET", "/candidates?testResult=PASS")), [P.PASS]);
    });
});

describe("Work Allocation is a different thing, and RBAC is unchanged (JOB-PASS-011, 012)", () => {
    test("JOB-PASS-011: an Analyst can still be allocated any candidate, passed or not", async () => {
        const response = await api(USERS.MANAGER, "POST", "/work-allocation/assign", { candidateIds: [P.FAIL, P.NONE], allocations: [{ analystId: USERS.ANALYST.adminId, count: 2 }] });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(await prisma.candidateAllocation.count(), 2);
    });

    test("JOB-PASS-012: only ADMIN and MANAGER assign; the others are refused before the test rule (403), PASS or not", async () => {
        const job = await createJob();
        for (const who of [USERS.ANALYST, USERS.DESK]) {
            assert.equal((await add(who, job, P.PASS)).status, 403, who.role);
            assert.equal((await add(who, job, P.FAIL)).status, 403, who.role);
        }
        assert.equal((await add(USERS.ADMIN, job, P.PASS)).status, 201);
        assert.equal((await add(USERS.ADMIN, job, P.FAIL)).status, 409);
        assert.equal(await memberCount(), 1);
    });
});

describe("concurrency", () => {
    test("a result changed to FAIL at the same moment as an assignment never leaves a FAIL candidate newly assigned after the change commits", async () => {
        for (let round = 0; round < 3; round += 1) {
            await pg.exec(`DELETE FROM job_candidate`);
            await pg.exec(`UPDATE candidate_stages SET test_result = 'PASS' WHERE passport_id = '${P.PASS}'`);
            const job = await createJob();
            const [added] = await Promise.all([add(USERS.MANAGER, job, P.PASS), setResult(P.PASS, "FAIL")]);
            const result = (await prisma.candidateStage.findUnique({ where: { passportId_stage: { passportId: P.PASS, stage: "TEST_DETAILS" } } })).testResult;
            assert.equal(result, "FAIL", `round ${round}: the change committed`);
            // Either the assignment won (it saw PASS and committed first) or it was refused; never an error.
            assert.ok([201, 409].includes(added.status), `round ${round}: ${added.status}`);
        }
    });
});
