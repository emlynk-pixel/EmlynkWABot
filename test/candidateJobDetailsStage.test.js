// Candidate stage "Job Details" and the Test Details field meaning (STAGE-JOB-007 to 024), on a REAL
// PostgreSQL (PGlite, every migration applied) through the real Prisma client, services and admin router.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import express from "express";

import { createTestDatabase, migrationNames } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { CANDIDATE_STAGES } from "../src/services/candidateService.js";

const user = (adminId, role, n) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const USERS = { ADMIN: user("u-admin", "ADMIN", 1), MANAGER: user("u-manager", "MANAGER", 2), ANALYST: user("u-ann", "ANALYST", 4), OTHER_ANALYST: user("u-ben", "ANALYST", 5), DESK: user("u-desk", "REGISTRATION_DESK", 3) };
const P1 = "P0000001";
const P2 = "P0000002";

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
        DELETE FROM "job_type"; DELETE FROM "client"; DELETE FROM "agent";
        DELETE FROM "candidate_allocation"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
    `);
    await prisma.candidate.createMany({ data: [[P1, "7001", "Nimal", "Perera", "900000001V"], [P2, "7002", "Kamal", "Silva", "900000002V"]].map(([passportId, uniqueId, firstName, otherName, nic]) => ({ passportId, uniqueId, firstName, otherName, nic })) });
    // Both candidates passed the test (the only ones a job can take); the rule itself is in jobAssignmentTestPass.test.js.
    await prisma.candidateStage.createMany({ data: [P1, P2].map((passportId) => ({ passportId, stage: "TEST_DETAILS", testResult: "PASS" })) });
    await prisma.candidateAllocation.create({ data: { passportId: P1, analystId: USERS.ANALYST.adminId } });
    const jobType = await prisma.jobType.create({ data: { code: "WELDER", name: "Welder" } });
    const agent = await prisma.agent.create({ data: { name: "Ion Popescu", countryCode: "RO" } });
    const acme = await prisma.client.create({ data: { name: "Acme Builders", agentId: agent.id } });
    const beta = await prisma.client.create({ data: { name: "Beta Foods", agentId: agent.id } });
    ids = { jobType: jobType.id, agent: agent.id, acme: acme.id, beta: beta.id };
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
const createJob = async (clientId) => {
    const response = await api(USERS.MANAGER, "POST", "/jobs", { jobTypeId: ids.jobType, clientId });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
};
const assign = (job, passportId = P1) => api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/candidates`, { passportId });
const stage = async (passportId, key, who = USERS.ADMIN) => (await api(who, "GET", `/candidates/${passportId}`)).body.stages.find((s) => s.stage === key);
const save = (passportId, key, body, who = USERS.ADMIN) => api(who, "PUT", `/candidates/${passportId}/stages/${key}`, body);

describe("stage order (STAGE-JOB-001)", () => {
    test("Job details sits immediately after Test details; no other stage moved", async () => {
        assert.deepEqual([...CANDIDATE_STAGES], ["TEST_DETAILS", "JOB_DETAILS", "CANDIDATE_DETAILS", "DOCUMENT_SUBMISSION", "IVS_INTERVIEW", "VISA_SUBMISSION", "VISA_APPROVAL", "FINALIZING_JOB"]);
        const response = await api(USERS.ADMIN, "GET", `/candidates/${P1}`);
        assert.deepEqual(response.body.stages.map((s) => s.stage), [...CANDIDATE_STAGES]);
        const list = await api(USERS.ADMIN, "GET", "/candidates");
        assert.deepEqual(list.body.items[0].stages.map((s) => s.stage), [...CANDIDATE_STAGES]);
    });
});

describe("the Job and Client come from the Job assignment (STAGE-JOB-007, 008, 009, 022, 023)", () => {
    test("STAGE-JOB-009 / 021: with no Job, and no JOB_DETAILS row, the stage loads with safe defaults", async () => {
        const job = await stage(P1, "JOB_DETAILS");
        assert.deepEqual([job.automatic, job.completed, job.jobDate, job.notes, job.jobCode, job.clientName], [false, false, null, null, null, null]);
        assert.equal(await prisma.candidateStage.count({ where: { passportId: P1 } }), 1, "reading creates nothing (only the Test details row the test set up)");
    });

    test("STAGE-JOB-007 / 008: the assigned Job's human-readable code and its Client's name (never the UUID)", async () => {
        const job = await createJob(ids.acme);
        assert.equal((await assign(job)).status, 201);
        const shown = await stage(P1, "JOB_DETAILS");
        assert.deepEqual([shown.jobCode, shown.clientName], [job.jobCode, "Acme Builders"]);
        assert.match(shown.jobCode, /^JOB-\d{4}-\d{6}$/);
        assert.doesNotMatch(JSON.stringify(shown), new RegExp(job.jobId), "the Job UUID is not exposed on the stage");
        assert.equal(Object.hasOwn(shown, "jobId"), false);
        // Another candidate without a Job still shows nothing.
        assert.deepEqual([(await stage(P2, "JOB_DETAILS")).jobCode, (await stage(P2, "JOB_DETAILS")).clientName], [null, null]);
    });

    test("the Client name is read live: renaming the Client shows through, nothing was copied onto the stage", async () => {
        const job = await createJob(ids.acme);
        await assign(job);
        await save(P1, "JOB_DETAILS", { notes: "n" });
        await api(USERS.ADMIN, "PATCH", `/client-management/${ids.acme}`, { name: "Acme Group" });
        assert.equal((await stage(P1, "JOB_DETAILS")).clientName, "Acme Group");
        const row = await prisma.candidateStage.findUnique({ where: { passportId_stage: { passportId: P1, stage: "JOB_DETAILS" } } });
        assert.ok(!Object.values(row).some((value) => value === "Acme Group" || value === job.jobCode), "no Job or Client text is stored on the stage row");
    });

    test("STAGE-JOB-022: reassigning to another Job updates the displayed Job and Client, and the stage's own date and note are kept", async () => {
        const first = await createJob(ids.acme);
        const second = await createJob(ids.beta);
        await assign(first);
        await save(P1, "JOB_DETAILS", { jobDate: "2026-10-05", notes: "Interview booked" });
        assert.equal((await stage(P1, "JOB_DETAILS")).clientName, "Acme Builders");
        assert.equal((await api(USERS.MANAGER, "DELETE", `/jobs/${first.jobId}/candidates/${P1}`)).status, 200);
        let shown = await stage(P1, "JOB_DETAILS");
        assert.deepEqual([shown.jobCode, shown.clientName, shown.jobSource, shown.jobStatus], [first.jobCode, "Acme Builders", "HISTORICAL", "REMOVED"], "removed from the job: the latest earlier job, not current");
        assert.equal((await assign(second)).status, 201);
        shown = await stage(P1, "JOB_DETAILS");
        assert.deepEqual([shown.jobCode, shown.clientName, shown.jobDate, shown.notes], [second.jobCode, "Beta Foods", "2026-10-05", "Interview booked"]);
        // Job history stays in Job Management.
        assert.equal(await prisma.jobCandidate.count({ where: { passportId: P1 } }), 2);
    });

    test("a completed Job is no longer the current Job, but is still shown as the latest historical one", async () => {
        const job = await createJob(ids.acme);
        await assign(job);
        await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/complete`, {});
        const shown = await stage(P1, "JOB_DETAILS");
        assert.deepEqual([shown.jobCode, shown.clientName, shown.jobSource, shown.jobStatus], [job.jobCode, "Acme Builders", "HISTORICAL", "COMPLETED"]);
    });

    test("STAGE-JOB-023: a legacy free-text job_id never overrides the relational assignment, and never becomes the Job", async () => {
        await prisma.candidateStage.update({ where: { passportId_stage: { passportId: P1, stage: "TEST_DETAILS" } }, data: { jobId: "Legacy-Job-12" } });
        await prisma.candidateStage.create({ data: { passportId: P1, stage: "JOB_DETAILS", jobId: "Legacy-Job-12" } });
        let job = await stage(P1, "JOB_DETAILS");
        assert.deepEqual([job.jobCode, job.clientName], [null, null], "legacy text is not an assignment");
        const real = await createJob(ids.acme);
        await assign(real);
        job = await stage(P1, "JOB_DETAILS");
        assert.deepEqual([job.jobCode, job.clientName], [real.jobCode, "Acme Builders"]);
        // On Test details the legacy value is read only as the Test ID, and a saved Test ID wins.
        assert.equal((await stage(P1, "TEST_DETAILS")).testId, "Legacy-Job-12");
        await save(P1, "TEST_DETAILS", { testId: "T-100" });
        assert.equal((await stage(P1, "TEST_DETAILS")).testId, "T-100");
        assert.equal((await prisma.candidateStage.findUnique({ where: { passportId_stage: { passportId: P1, stage: "TEST_DETAILS" } } })).jobId, "Legacy-Job-12", "the legacy column is never written");
    });
});

describe("historical Job fallback on Job details (JOB-HISTORY-001 to 014)", () => {
    const shownOf = async (passportId = P1) => stage(passportId, "JOB_DETAILS");
    const quick = (s) => [s.jobCode, s.clientName, s.jobSource, s.jobStatus];
    const complete = (job) => api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/complete`, {});
    const cancel = (job) => api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/cancel`, { reason: "Employer withdrew" });
    // job_candidate.assigned_at decides "latest"; space the assignments out so the order is explicit.
    const setAssignedAt = (job, iso) => pg.exec(`UPDATE job_candidate SET assigned_at = '${iso}' WHERE job_id = '${job.jobId}' AND passport_id = '${P1}'`);

    test("JOB-HISTORY-001: no Job ever: Not assigned (nothing shown)", async () => {
        assert.deepEqual(quick(await shownOf()), [null, null, null, null]);
    });

    test("JOB-HISTORY-002: one PROCESSING Job: the current Job", async () => {
        const job = await createJob(ids.acme);
        await assign(job);
        assert.deepEqual(quick(await shownOf()), [job.jobCode, "Acme Builders", "CURRENT", "PROCESSING"]);
    });

    test("JOB-HISTORY-003 / 004: one COMPLETED or one CANCELLED Job and no current Job: that Job, marked historical", async () => {
        const done = await createJob(ids.acme);
        await assign(done);
        await complete(done);
        assert.deepEqual(quick(await shownOf()), [done.jobCode, "Acme Builders", "HISTORICAL", "COMPLETED"]);
        const other = await createJob(ids.beta);
        await assign(other, P2);
        await cancel(other);
        assert.deepEqual(quick(await shownOf(P2)), [other.jobCode, "Beta Foods", "HISTORICAL", "CANCELLED"]);
    });

    test("JOB-HISTORY-005: an old completed Job A and a newer completed Job B: Job B (latest assigned_at)", async () => {
        const a = await createJob(ids.acme);
        await assign(a);
        await complete(a);
        const b = await createJob(ids.beta);
        await assign(b);
        await complete(b);
        await setAssignedAt(a, "2026-01-01T00:00:00Z");
        await setAssignedAt(b, "2026-02-01T00:00:00Z");
        assert.deepEqual(quick(await shownOf()), [b.jobCode, "Beta Foods", "HISTORICAL", "COMPLETED"]);
        // The order follows assigned_at, not job creation or status: swap them.
        await setAssignedAt(a, "2026-03-01T00:00:00Z");
        assert.deepEqual(quick(await shownOf()), [a.jobCode, "Acme Builders", "HISTORICAL", "COMPLETED"]);
    });

    test("JOB-HISTORY-006 / 007: historical Job A then a current Job B shows B; when B completes B stays (never back to A)", async () => {
        const a = await createJob(ids.acme);
        await assign(a);
        await complete(a);
        await setAssignedAt(a, "2026-01-01T00:00:00Z");
        const b = await createJob(ids.beta);
        await assign(b);
        assert.deepEqual(quick(await shownOf()), [b.jobCode, "Beta Foods", "CURRENT", "PROCESSING"]);
        await complete(b);
        assert.deepEqual(quick(await shownOf()), [b.jobCode, "Beta Foods", "HISTORICAL", "COMPLETED"]);
    });

    test("JOB-HISTORY-008 / 009: the Client is the displayed Job's own Client, and the Job ID is job_code, never the UUID", async () => {
        const a = await createJob(ids.acme);
        await assign(a);
        await complete(a);
        await setAssignedAt(a, "2026-01-01T00:00:00Z");
        const b = await createJob(ids.beta);
        await assign(b);
        await complete(b);
        const shown = await shownOf();
        assert.equal(shown.clientName, "Beta Foods");
        assert.match(shown.jobCode, /^JOB-\d{4}-\d{6}$/);
        assert.doesNotMatch(JSON.stringify(shown), new RegExp(`${a.jobId}|${b.jobId}`));
    });

    test("removal keeps history: a candidate taken off a PROCESSING job still shows that job (REMOVED); the job_candidate row is kept", async () => {
        const a = await createJob(ids.acme);
        await assign(a);
        assert.equal((await api(USERS.MANAGER, "DELETE", `/jobs/${a.jobId}/candidates/${P1}`)).status, 200);
        assert.equal(await prisma.jobCandidate.count({ where: { passportId: P1 } }), 1, "removal never deletes the row");
        assert.deepEqual(quick(await shownOf()), [a.jobCode, "Acme Builders", "HISTORICAL", "REMOVED"]);
    });

    test("JOB-HISTORY-010: the fallback is display-only: no assignment, Job status or stage row changes, and no Job or Client text is stored on candidate_stages", async () => {
        const a = await createJob(ids.acme);
        await assign(a);
        await complete(a);
        const snapshot = async () => ({
            members: await prisma.jobCandidate.findMany({ where: { passportId: P1 } }),
            job: await prisma.job.findUnique({ where: { id: a.jobId } }),
            stages: await prisma.candidateStage.count(),
        });
        const before = await snapshot();
        for (let i = 0; i < 3; i += 1) await shownOf();
        const after = await snapshot();
        assert.deepEqual(after, before);
        assert.equal(after.members[0].isActive, false, "a historical job is never made current again");
        await save(P1, "JOB_DETAILS", { notes: "n", jobDate: "2026-10-05" });
        const row = await prisma.candidateStage.findUnique({ where: { passportId_stage: { passportId: P1, stage: "JOB_DETAILS" } } });
        assert.ok(!Object.values(row).some((v) => v === "Acme Builders" || v === a.jobCode), "no Job ID or Client name on the stage row");
    });

    test("JOB-HISTORY-011 / 012: the Date, Note and completion saved on Job details are unchanged while the displayed Job moves from current to historical", async () => {
        const a = await createJob(ids.acme);
        await assign(a);
        await save(P1, "JOB_DETAILS", { jobDate: "2026-10-05", notes: "Interview booked", completed: true });
        const keep = async () => { const s = await shownOf(); return [s.jobDate, s.notes, s.completed]; };
        assert.deepEqual(await keep(), ["2026-10-05", "Interview booked", true]);
        await complete(a);
        assert.deepEqual(await keep(), ["2026-10-05", "Interview booked", true]);
        assert.equal((await shownOf()).jobSource, "HISTORICAL");
    });

    test("JOB-HISTORY-013: Test details Agent name is still plain editable free text (no Agent lookup)", async () => {
        const response = await save(P1, "TEST_DETAILS", { testAgentName: "Someone Not In The Agent Module" });
        assert.equal(response.status, 200);
        assert.equal((await stage(P1, "TEST_DETAILS")).testAgentName, "Someone Not In The Agent Module");
        assert.equal(await prisma.agent.count({ where: { name: "Someone Not In The Agent Module" } }), 0);
    });

    test("JOB-HISTORY-014: RBAC is unchanged (the unallocated Analyst still cannot see or save; the allocated one can)", async () => {
        const a = await createJob(ids.acme);
        await assign(a);
        await complete(a);
        assert.deepEqual(quick(await shownOf()), [a.jobCode, "Acme Builders", "HISTORICAL", "COMPLETED"]);
        assert.equal((await api(USERS.ANALYST, "GET", `/candidates/${P1}`)).status, 200);
        assert.equal((await api(USERS.OTHER_ANALYST, "GET", `/candidates/${P1}`)).status, 404);
        assert.equal((await save(P1, "JOB_DETAILS", { notes: "x" }, USERS.OTHER_ANALYST)).status, 404);
        assert.equal((await save(P1, "JOB_DETAILS", { notes: "x" }, USERS.ANALYST)).status, 200);
        assert.equal((await save(P1, "JOB_DETAILS", { notes: "x" }, USERS.DESK)).status, 200);
    });
});

describe("what can be saved (STAGE-JOB-010 to 015)", () => {
    test("STAGE-JOB-010 / 011: the Job ID and Client name cannot be written, on any stage", async () => {
        const job = await createJob(ids.acme);
        await assign(job);
        for (const key of ["JOB_DETAILS", "TEST_DETAILS", "VISA_APPROVAL"]) {
            for (const body of [{ jobCode: "JOB-2026-999999", notes: "x" }, { clientName: "Fake Co", notes: "x" }, { jobId: job.jobId, notes: "x" }]) {
                const response = await save(P1, key, body);
                assert.equal(response.status, 400, `${key} ${JSON.stringify(body)}`);
            }
        }
        assert.equal(await prisma.candidateStage.count(), 2, "nothing was written (only the two Test details rows the test set up)");
        const shown = await stage(P1, "JOB_DETAILS");
        assert.deepEqual([shown.jobCode, shown.clientName], [job.jobCode, "Acme Builders"]);
    });

    test("STAGE-JOB-012 / 013 / 014: date, note and completion are saved and read back", async () => {
        const response = await save(P1, "JOB_DETAILS", { jobDate: "2026-10-05", notes: "Visa interview booked", completed: true });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const shown = await stage(P1, "JOB_DETAILS");
        assert.deepEqual([shown.jobDate, shown.notes, shown.completed], ["2026-10-05", "Visa interview booked", true]);
        assert.ok(shown.completedAt);
        // Saved in the new column; the DB date is a plain DATE.
        const row = (await pg.query(`SELECT job_details_date::text AS d, completed FROM candidate_stages WHERE passport_id='${P1}' AND stage='JOB_DETAILS'`)).rows[0];
        assert.deepEqual([row.d, row.completed], ["2026-10-05", true]);
        // Un-complete and clear the date.
        await save(P1, "JOB_DETAILS", { completed: false, jobDate: null });
        const cleared = await stage(P1, "JOB_DETAILS");
        assert.deepEqual([cleared.completed, cleared.completedAt, cleared.jobDate, cleared.notes], [false, null, null, "Visa interview booked"]);
        // A Job being assigned does not complete the stage by itself.
        await assign(await createJob(ids.acme));
        assert.equal((await stage(P1, "JOB_DETAILS")).completed, false);
    });

    test("an invalid date, and a date sent to the wrong stage, are refused", async () => {
        assert.equal((await save(P1, "JOB_DETAILS", { jobDate: "2026-02-30" })).status, 400);
        assert.equal((await save(P1, "JOB_DETAILS", { jobDate: "05/10/2026" })).status, 400);
        assert.equal((await save(P1, "TEST_DETAILS", { jobDate: "2026-10-05" })).status, 400);
        assert.equal((await save(P1, "JOB_DETAILS", { testId: "T-1" })).status, 400);
    });

    test("STAGE-JOB-015: Test details saves and reloads agent, test ID, result, date, notes and completion", async () => {
        const response = await save(P1, "TEST_DETAILS", { testAgentName: "Nimal Perera", testId: "T-2026-014", testResult: "PASS", testDate: "2026-09-28", notes: "Trade test", completed: true });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const shown = await stage(P1, "TEST_DETAILS");
        assert.deepEqual([shown.testAgentName, shown.testId, shown.testResult, shown.testDate, shown.notes, shown.completed], ["Nimal Perera", "T-2026-014", "PASS", "2026-09-28", "Trade test", true]);
        assert.equal(shown.jobCode, null, "Job fields exist only on Job details");
    });

    test("saves are audited with the stage's own fields only (no Job or Client text)", async () => {
        const job = await createJob(ids.acme);
        await assign(job);
        await save(P1, "JOB_DETAILS", { jobDate: "2026-10-05", notes: "n", completed: true });
        const entries = await prisma.auditLog.findMany({ where: { action: "UPDATE_STAGE" } });
        assert.equal(entries.length, 1);
        const written = JSON.parse(entries[0].newValue);
        assert.deepEqual(written, { stage: "JOB_DETAILS", completed: true, notes: "n", jobDate: "2026-10-05" });
        assert.doesNotMatch(JSON.stringify(entries), /Acme Builders/);
    });
});

describe("other stages are unchanged (STAGE-JOB-016 to 020)", () => {
    test("every other stage still saves notes and completion; Candidate details and Document submission stay automatic", async () => {
        for (const key of ["IVS_INTERVIEW", "VISA_SUBMISSION", "VISA_APPROVAL", "FINALIZING_JOB"]) {
            const response = await save(P1, key, { completed: true, notes: `${key} note` });
            assert.equal(response.status, 200, key);
            const shown = await stage(P1, key);
            assert.deepEqual([shown.completed, shown.notes], [true, `${key} note`], key);
        }
        for (const key of ["CANDIDATE_DETAILS", "DOCUMENT_SUBMISSION"]) {
            const refused = await save(P1, key, { completed: true });
            assert.equal(refused.status, 409, key);
            assert.equal(refused.body.code, "AUTOMATIC_STAGE");
            assert.equal((await save(P1, key, { notes: "just a note" })).status, 200, key);
        }
        assert.equal((await stage(P1, "JOB_DETAILS")).completed, false, "untouched");
    });
});

describe("RBAC is unchanged (STAGE-JOB-024)", () => {
    test("ADMIN, MANAGER and REGISTRATION_DESK can save a Job details stage; an ANALYST only for an allocated candidate", async () => {
        for (const who of [USERS.ADMIN, USERS.MANAGER, USERS.DESK]) {
            assert.equal((await save(P1, "JOB_DETAILS", { notes: `by ${who.role}` }, who)).status, 200, who.role);
        }
        assert.equal((await save(P1, "JOB_DETAILS", { notes: "by its analyst" }, USERS.ANALYST)).status, 200);
        const refused = await save(P1, "JOB_DETAILS", { notes: "other analyst" }, USERS.OTHER_ANALYST);
        assert.equal(refused.status, 404, "an unallocated analyst gets the same answer as for a missing candidate");
        assert.equal((await stage(P1, "JOB_DETAILS")).notes, "by its analyst");
        // The same holds for Test details.
        assert.equal((await save(P1, "TEST_DETAILS", { testId: "T-1" }, USERS.OTHER_ANALYST)).status, 404);
    });

    test("the Job and Client shown to an analyst are only those of a candidate allocated to them", async () => {
        const job = await createJob(ids.acme);
        await assign(job, P1);
        assert.equal((await api(USERS.ANALYST, "GET", `/candidates/${P1}`)).status, 200);
        assert.equal((await api(USERS.OTHER_ANALYST, "GET", `/candidates/${P1}`)).status, 404);
    });
});

describe("migration 20261020120000_candidate_stage_job_details", () => {
    test("is additive: existing stage rows, including a legacy job_id, are untouched; no row is invented; a repeat run is harmless", async () => {
        const names = migrationNames();
        const target = names.indexOf("20261020120000_candidate_stage_job_details");
        assert.ok(target > 0);
        const old = await createTestDatabase({ upTo: names[target - 1] });
        try {
            await old.pg.exec(`INSERT INTO "candidate" ("passport_id","unique_id","first_name","updated_date") VALUES ('L1','9001','Legacy', now());
                INSERT INTO "candidate_stages" ("passport_id","stage","completed","notes","job_id","test_result","updated_at") VALUES ('L1','TEST_DETAILS',true,'old note','Job12','PASS', now())`);
            const before = (await old.pg.query(`SELECT * FROM "candidate_stages"`)).rows[0];
            const sql = fs.readFileSync(path.join(import.meta.dirname, "..", "prisma", "migrations", names[target], "migration.sql"), "utf8");
            await old.pg.exec(sql);
            await old.pg.exec(sql);
            const rows = (await old.pg.query(`SELECT * FROM "candidate_stages"`)).rows;
            assert.equal(rows.length, 1, "no JOB_DETAILS row was invented");
            const { test_agent_name: agent, test_id: testId, job_details_date: jobDate, ...kept } = rows[0];
            assert.deepEqual([agent, testId, jobDate], [null, null, null]);
            assert.deepEqual(kept, before, "every existing value, job_id included, is exactly as it was");
            const columns = (await old.pg.query(`SELECT column_name FROM information_schema.columns WHERE table_name='candidate_stages' AND column_name IN ('test_agent_name','test_id','job_details_date','job_id') ORDER BY 1`)).rows.map((r) => r.column_name);
            assert.deepEqual(columns, ["job_details_date", "job_id", "test_agent_name", "test_id"]);
        } finally {
            await old.close();
        }
    });
});
