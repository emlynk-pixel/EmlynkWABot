// Job Management enhancements: flexible vacancies (Filled, never a limit), New job with
// selected candidates in ONE transaction, the eligible-candidate list, To / From Country,
// the assigned candidates' workflow Status, and the roles.
// On a REAL PostgreSQL (PGlite, every migration applied) through the real Prisma client,
// the real services and the real admin router, like jobManagement.test.js.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { DEFAULT_FROM_COUNTRY, formatJobCode, isJobFilled, jobCodeYear, parseCreateJobBody } from "../src/services/jobService.js";

const user = (adminId, role, n) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const USERS = { ADMIN: user("u-admin", "ADMIN", 1), MANAGER: user("u-manager", "MANAGER", 2), DESK: user("u-desk", "REGISTRATION_DESK", 3), ANN: user("u-ann", "ANALYST", 4) };
const pid = (i) => `P${String(i).padStart(7, "0")}`;
// 1-30 PASS (job type preference Carpenter), 31 FAIL, 32 no test result, 33 PASS with No Preferred Type.
const PASSED = Array.from({ length: 30 }, (_, n) => n + 1);
const FAILED = 31;
const UNTESTED = 32;
const NO_PREFERENCE = 33;

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
    const all = [...PASSED, FAILED, UNTESTED, NO_PREFERENCE];
    await prisma.candidate.createMany({
        data: all.map((i) => ({ passportId: pid(i), uniqueId: `80${String(i).padStart(3, "0")}`, firstName: `Name${i}`, otherName: `Sur${i}`, nic: i === 2 ? null : `2000000000${String(i).padStart(2, "0")}`, job: i === NO_PREFERENCE ? "NO_PREFERENCE" : "Carpenter" })),
    });
    await prisma.candidateStage.createMany({
        data: [...PASSED, NO_PREFERENCE].map((i) => ({ passportId: pid(i), stage: "TEST_DETAILS", testResult: "PASS" }))
            .concat([{ passportId: pid(FAILED), stage: "TEST_DETAILS", testResult: "FAIL" }]),
    });
    await prisma.candidateAllocation.create({ data: { passportId: pid(1), analystId: USERS.ANN.adminId } });
    const welder = await prisma.jobType.create({ data: { code: "WELDER", name: "Welder" } });
    const ro = await prisma.agent.create({ data: { name: "Ion Popescu", countryCode: "RO" } });
    const de = await prisma.agent.create({ data: { name: "Hans Weber", countryCode: "DE" } });
    const acme = await prisma.client.create({ data: { name: "Acme Construction", agentLinks: { create: { agentId: ro.id } } } });
    const berlin = await prisma.client.create({ data: { name: "Berlin Bau", agentLinks: { create: { agentId: de.id } } } });
    const noCountry = await prisma.client.create({ data: { name: "Legacy Client" } });
    ids = { jobType: welder.id, acme: acme.id, berlin: berlin.id, noCountry: noCountry.id };
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
const jobBody = (extra = {}) => ({ jobTypeId: ids.jobType, clientId: ids.acme, vacancies: 20, ...extra });
const create = (extra = {}, who = USERS.MANAGER) => api(who, "POST", "/jobs", jobBody(extra));
const createOk = async (extra = {}) => {
    const response = await create(extra);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
};
const add = (job, i) => api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/candidates`, { passportId: pid(i) });
const jobCount = () => prisma.job.count();
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, n) => from + n);

describe("flexible vacancies (VACANCY-001 to VACANCY-005)", () => {
    test("VACANCY-001/002/003: candidate #20, #21 and up to 23 are all assigned to a job of 20 vacancies; the count stays 23 / 20", async () => {
        const job = await createOk();
        for (const i of range(1, 19)) assert.equal((await add(job, i)).status, 201);
        let details = (await api(USERS.MANAGER, "GET", `/jobs/${job.jobId}`)).body;
        assert.deepEqual([details.candidateCount, details.vacancies, details.filled], [19, 20, false], "19 / 20: not filled yet");

        const twentieth = await add(job, 20);
        assert.equal(twentieth.status, 201, "VACANCY-001: candidate #20");
        assert.deepEqual([twentieth.body.candidateCount, twentieth.body.filled], [20, true]);

        const twentyFirst = await add(job, 21);
        assert.equal(twentyFirst.status, 201, "VACANCY-002: candidate #21 is not blocked");
        for (const i of [22, 23]) assert.equal((await add(job, i)).status, 201);

        details = (await api(USERS.MANAGER, "GET", `/jobs/${job.jobId}`)).body;
        assert.equal(details.candidateCount, 23, "VACANCY-003: not clamped to the vacancies");
        assert.equal(details.candidates.length, 23);
        assert.equal(await prisma.jobCandidate.count({ where: { jobId: job.jobId, isActive: true } }), 23);
    });

    test("VACANCY-004/005: Filled from vacancies onward (also over it); the vacancies themselves never change; the status stays PROCESSING until Complete", async () => {
        const job = await createOk({ candidateIds: range(1, 23).map(pid) });
        assert.deepEqual([job.candidateCount, job.vacancies, job.filled, job.status], [23, 20, true, "PROCESSING"]);
        assert.equal((await prisma.job.findUnique({ where: { id: job.jobId } })).vacancies, 20, "VACANCY-005: the target is still 20");

        const list = (await api(USERS.MANAGER, "GET", "/jobs")).body.items.find((row) => row.jobId === job.jobId);
        assert.deepEqual([list.candidateCount, list.vacancies, list.filled], [23, 20, true]);

        // Removing down to 20 keeps it Filled; 19 is not.
        for (const i of [23, 22, 21]) assert.equal((await api(USERS.MANAGER, "DELETE", `/jobs/${job.jobId}/candidates/${pid(i)}`)).status, 200);
        assert.equal((await api(USERS.MANAGER, "GET", `/jobs/${job.jobId}`)).body.filled, true, "20 / 20");
        const nineteen = await api(USERS.MANAGER, "DELETE", `/jobs/${job.jobId}/candidates/${pid(20)}`);
        assert.equal(nineteen.body.filled, false, "19 / 20");

        // Completing the job keeps its count (history) and its Filled state.
        assert.equal((await add(job, 20)).status, 201);
        const completed = await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/complete`, {});
        assert.deepEqual([completed.body.status, completed.body.candidateCount, completed.body.filled], ["COMPLETED", 20, true]);
    });

    test("Filled is derived: no vacancies is never Filled", () => {
        assert.equal(isJobFilled(null, 50), false);
        assert.equal(isJobFilled(20, 19), false);
        assert.equal(isJobFilled(20, 20), true);
        assert.equal(isJobFilled(20, 23), true);
    });

    test("an Analyst's Filled counts every candidate of the job, not only their own", async () => {
        const job = await createOk({ vacancies: 2, candidateIds: [pid(1), pid(2)] });
        const asAnalyst = await api(USERS.ANN, "GET", `/jobs/${job.jobId}`);
        assert.equal(asAnalyst.status, 200);
        assert.deepEqual([asAnalyst.body.candidateCount, asAnalyst.body.filled], [1, true], "sees only their candidate, the job is still Filled");
        assert.equal((await api(USERS.ANN, "GET", "/jobs")).body.items[0].filled, true);
    });
});

describe("New job with selected candidates (JOB-CREATE-001 to JOB-CREATE-012)", () => {
    test("JOB-CREATE-001: the job details are validated without writing anything (invalid -> 400, no job)", async () => {
        assert.deepEqual(parseCreateJobBody({ jobTypeId: "x" }).errors.map((e) => e.field), ["jobTypeId", "clientId"]);
        assert.ok(parseCreateJobBody(jobBody()).values, "a valid Step 1 parses without the database");
        for (const bad of [{ vacancies: 0 }, { fromCountryCode: "XX" }, { candidateIds: "P0000001" }, { candidateIds: [123] }, { countryCode: "DE" }]) {
            const response = await create(bad);
            assert.equal(response.status, 400, JSON.stringify(bad));
        }
        assert.equal(await jobCount(), 0);
    });

    test("JOB-CREATE-002: zero candidates (no candidateIds, or an empty list)", async () => {
        assert.equal((await createOk()).candidateCount, 0);
        assert.equal((await createOk({ candidateIds: [] })).candidateCount, 0);
    });

    test("JOB-CREATE-003/004: one, or many, candidates are assigned with the job, each audited", async () => {
        const one = await createOk({ candidateIds: [pid(1)] });
        assert.deepEqual(one.candidates.map((c) => c.passportId), [pid(1)]);
        const many = await createOk({ candidateIds: [pid(2), pid(3), pid(4)] });
        assert.deepEqual(many.candidates.map((c) => c.passportId).sort(), [pid(2), pid(3), pid(4)]);
        assert.equal(await prisma.jobCandidate.count({ where: { jobId: many.jobId, isActive: true } }), 3);
        assert.equal(await prisma.auditLog.count({ where: { action: "ADD_CANDIDATE_TO_JOB" } }), 4);
        const created = await prisma.auditLog.findMany({ where: { action: "CREATE_JOB" } });
        assert.equal(created.length, 2);
        assert.ok(!created.some((row) => row.newValue.includes("candidateIds")), "the audit records how many, not the ID list");
    });

    test("JOB-CREATE-005: a FAIL or untested candidate is refused and nothing is created", async () => {
        for (const i of [FAILED, UNTESTED]) {
            const response = await create({ candidateIds: [pid(1), pid(i)] });
            assert.equal(response.status, 409);
            assert.equal(response.body.code, "CANDIDATE_TEST_NOT_PASSED");
            assert.match(response.body.message, new RegExp(`${pid(i)}.*Nothing was created`));
        }
        assert.equal(await jobCount(), 0);
        assert.equal(await prisma.jobCandidate.count(), 0, "candidate 1 was not left assigned");
        assert.equal((await createOk()).jobCode, formatJobCode(jobCodeYear(), 1), "the refused creations used no job code");
    });

    test("JOB-CREATE-006 (multiple jobs): a candidate already on a PROCESSING job can be put on a new job too; the first job is untouched", async () => {
        const first = await createOk({ candidateIds: [pid(1)] });
        const second = await createOk({ candidateIds: [pid(2), pid(1)] });
        assert.equal(await jobCount(), 2);
        assert.equal(await prisma.jobCandidate.count({ where: { passportId: pid(1), isActive: true } }), 2);
        assert.equal(await prisma.jobCandidate.count({ where: { jobId: first.jobId, isActive: true } }), 1);
        assert.equal(await prisma.jobCandidate.count({ where: { jobId: second.jobId, isActive: true } }), 2);
    });

    test("JOB-CREATE-007: repeated IDs (also in another letter case) are assigned once", async () => {
        const job = await createOk({ candidateIds: [pid(1), pid(1), pid(1).toLowerCase(), pid(2)] });
        assert.equal(job.candidateCount, 2);
        assert.equal(await prisma.jobCandidate.count({ where: { jobId: job.jobId } }), 2);
    });

    test("JOB-CREATE-008: more candidates than vacancies are assigned", async () => {
        const job = await createOk({ vacancies: 2, candidateIds: range(1, 5).map(pid) });
        assert.deepEqual([job.candidateCount, job.vacancies, job.filled], [5, 2, true]);
    });

    test("JOB-CREATE-009/010: the job type is never matched: a Carpenter and a No Preferred Type candidate join a Welder job", async () => {
        const job = await createOk({ candidateIds: [pid(1), pid(NO_PREFERENCE)] });
        assert.equal(job.jobType.name, "Welder");
        assert.equal(job.candidateCount, 2);
    });

    test("JOB-CREATE-011: every other assignment rule still holds (unknown candidate, inactive type, inactive client)", async () => {
        const unknown = await create({ candidateIds: ["NOPE0001"] });
        assert.deepEqual([unknown.status, unknown.body.code], [404, "CANDIDATE_NOT_FOUND"]);
        await prisma.client.update({ where: { id: ids.berlin }, data: { isActive: false } });
        assert.equal((await create({ clientId: ids.berlin, candidateIds: [pid(1)] })).body.code, "CLIENT_INACTIVE");
        await prisma.jobType.update({ where: { id: ids.jobType }, data: { isActive: false } });
        assert.equal((await create({ candidateIds: [pid(1)] })).body.code, "REFERENCE_NOT_FOUND");
        assert.equal(await jobCount(), 0);
        assert.equal(await prisma.jobCandidate.count(), 0);
    });

    test("two creations racing for the same candidate: both are created, the candidate is on both, one row per job", async () => {
        const results = await Promise.all([create({ candidateIds: [pid(1), pid(2)] }), create({ candidateIds: [pid(3), pid(1)] })]);
        assert.deepEqual(results.map((r) => r.status), [201, 201]);
        assert.equal(await jobCount(), 2);
        assert.equal(await prisma.jobCandidate.count({ where: { passportId: pid(1), isActive: true } }), 2);
    });

    test("JOB-CREATE-012: only ADMIN and MANAGER create jobs (with or without candidates)", async () => {
        for (const who of [USERS.ANN, USERS.DESK]) assert.equal((await create({ candidateIds: [pid(1)] }, who)).status, 403);
        assert.equal((await create({ candidateIds: [pid(1)] }, USERS.ADMIN)).status, 201);
        assert.equal(await jobCount(), 1);
    });
});

describe("the eligible candidates of Step 2 (GET /candidates?testResult=PASS&available=true)", () => {
    test("only PASS candidates not on a PROCESSING job; FAIL and untested are left out", async () => {
        await createOk({ candidateIds: [pid(1), pid(2)] });
        const response = await api(USERS.MANAGER, "GET", "/candidates?testResult=PASS&available=true&pageSize=100");
        assert.equal(response.status, 200);
        const listed = response.body.items.map((c) => c.passportId);
        for (const i of [1, 2, FAILED, UNTESTED]) assert.ok(!listed.includes(pid(i)), pid(i));
        for (const i of [3, 30, NO_PREFERENCE]) assert.ok(listed.includes(pid(i)), pid(i));
        assert.equal(response.body.pagination.total, 29);
        assert.deepEqual(response.body.items[0].workflowStatus, { code: "REGISTERED", label: "Registered" });
        assert.equal((await api(USERS.MANAGER, "GET", "/candidates?available=yes")).status, 400);
    });

    test("a candidate released from a job (completed, cancelled or removed) is eligible again", async () => {
        const job = await createOk({ candidateIds: [pid(1), pid(2)] });
        await api(USERS.MANAGER, "DELETE", `/jobs/${job.jobId}/candidates/${pid(1)}`);
        let listed = (await api(USERS.MANAGER, "GET", "/candidates?testResult=PASS&available=true&pageSize=100")).body.items.map((c) => c.passportId);
        assert.ok(listed.includes(pid(1)) && !listed.includes(pid(2)));
        await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/cancel`, { reason: "Client withdrew" });
        listed = (await api(USERS.MANAGER, "GET", "/candidates?testResult=PASS&available=true&pageSize=100")).body.items.map((c) => c.passportId);
        assert.ok(listed.includes(pid(2)));
    });
});

describe("To Country and From Country (COUNTRY-001 to COUNTRY-005)", () => {
    test("COUNTRY-001/002: the To Country is the responsible agent's country, for each client; it cannot be sent", async () => {
        const options = (await api(USERS.MANAGER, "GET", "/job-options")).body;
        const countryOf = (agentId) => options.agents.find((a) => a.id === agentId).countryCode;
        assert.deepEqual(options.clients.map((c) => [c.name, c.agentIds.map(countryOf)]), [["Acme Construction", ["RO"]], ["Berlin Bau", ["DE"]]], "a client without an agent is not offered");
        assert.equal((await createOk({ clientId: ids.acme })).countryCode, "RO");
        assert.equal((await createOk({ clientId: ids.berlin })).countryCode, "DE");
        assert.equal((await create({ clientId: ids.berlin, countryCode: "RO" })).status, 400);
        assert.equal((await create({ clientId: ids.noCountry })).body.code, "CLIENT_HAS_NO_AGENT", "a client without a country cannot get a job");
    });

    test("COUNTRY-003/004: From Country defaults to Romania and can be another country, on create and on edit", async () => {
        assert.equal(DEFAULT_FROM_COUNTRY, "RO");
        const job = await createOk();
        assert.equal(job.fromCountryCode, "RO");
        assert.equal((await createOk({ fromCountryCode: "lk" })).fromCountryCode, "LK");
        const edited = await api(USERS.MANAGER, "PUT", `/jobs/${job.jobId}`, { fromCountryCode: "IN" });
        assert.equal(edited.status, 200);
        assert.deepEqual([edited.body.fromCountryCode, edited.body.countryCode], ["IN", "RO"], "the To Country is untouched");
        assert.equal((await api(USERS.MANAGER, "PUT", `/jobs/${job.jobId}`, { fromCountryCode: "ZZ" })).status, 400);
        assert.equal((await api(USERS.MANAGER, "PUT", `/jobs/${job.jobId}`, { countryCode: "DE" })).status, 400, "the To Country is never edited");
        await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/complete`, {});
        assert.equal((await api(USERS.MANAGER, "PUT", `/jobs/${job.jobId}`, { fromCountryCode: "RO" })).body.code, "JOB_NOT_PROCESSING");
    });

    test("COUNTRY-005: a job from before From Country keeps its stored To Country and reads From Country as not recorded", async () => {
        const job = await createOk({ clientId: ids.berlin });
        await pg.exec(`UPDATE "job" SET "from_country_code" = NULL WHERE "id" = '${job.jobId}'`);
        const details = (await api(USERS.MANAGER, "GET", `/jobs/${job.jobId}`)).body;
        assert.deepEqual([details.countryCode, details.fromCountryCode], ["DE", null]);
        // Editing something else keeps it as it is.
        const edited = (await api(USERS.MANAGER, "PUT", `/jobs/${job.jobId}`, { vacancies: 7 })).body;
        assert.deepEqual([edited.vacancies, edited.fromCountryCode], [7, null]);
        await assert.rejects(pg.exec(`UPDATE "job" SET "from_country_code" = 'ro' WHERE "id" = '${job.jobId}'`), /check/i);
    });

    test("the migration is additive and safe to run again (rehearsal on the migrated database)", async () => {
        const job = await createOk({ fromCountryCode: "LK" });
        const sql = fs.readFileSync(path.join(import.meta.dirname, "..", "prisma", "migrations", "20261025120000_job_from_country", "migration.sql"), "utf8");
        await pg.exec(sql);
        assert.equal((await prisma.job.findUnique({ where: { id: job.jobId } })).fromCountryCode, "LK", "an existing value is never overwritten");
    });
});

describe("the assigned candidates' Status and identity", () => {
    test("each candidate carries the Candidates list's workflow Status; a missing NIC is null", async () => {
        const job = await createOk({ candidateIds: [pid(1), pid(2)] });
        const byId = Object.fromEntries(job.candidates.map((c) => [c.passportId, c]));
        assert.deepEqual(byId[pid(1)].workflowStatus, { code: "JOB_ASSIGNED", label: "Job Assigned" });
        assert.equal(byId[pid(1)].nic, "200000000001");
        assert.equal(byId[pid(2)].nic, null);
        const listed = (await api(USERS.MANAGER, "GET", "/candidates?search=P0000001")).body.items[0];
        assert.deepEqual(listed.workflowStatus, byId[pid(1)].workflowStatus, "one status source");
    });
});
