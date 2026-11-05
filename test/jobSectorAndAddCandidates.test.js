// Y26S01: the Add to Job candidate list (shown before any search, newest registered first, paged
// and searched on the server, PASS only, job managers only) and the optional Job Sector of a new
// job. On a REAL PostgreSQL (PGlite, every migration applied) through the real Prisma client,
// services and admin router. Synthetic data only.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

const user = (adminId, role, n) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const USERS = {
    OWNER: user("u-owner", "OWNER", 1), ADMIN: user("u-admin", "ADMIN", 2), TEAM_LEAD: user("u-lead", "TEAM_LEAD", 3), JOB_HANDLER: user("u-jh", "JOB_HANDLER", 4),
    ANALYST: user("u-ann", "ANALYST", 5), DESK: user("u-desk", "REGISTRATION_DESK", 6),
};

let database;
let prisma;
let pg;
let ids;

// Registered oldest to newest: N1 (Nimal Perera Silva) … N4; F1 failed the test; X1 has no test row.
const day = (n) => new Date(Date.UTC(2026, 10, n, 4, 0, 0));
const CANDIDATES = [
    { passportId: "N1000001", firstName: "Nimal Perera", otherName: "Silva", nic: "199011111111", createdDate: day(1), result: "PASS" },
    { passportId: "N1000002", firstName: "Kamal", otherName: "Fernando", nic: "199022222222", createdDate: day(2), result: "PASS" },
    { passportId: "N1000003", firstName: "Sunil", otherName: "Perera", nic: "199033333333", createdDate: day(3), result: "PASS" },
    { passportId: "N1000004", firstName: "Ruwan", otherName: "Jayasuriya", nic: null, createdDate: day(4), result: "PASS" },
    { passportId: "F1000001", firstName: "Failed", otherName: "Perera", nic: "199044444444", createdDate: day(5), result: "FAIL" },
    { passportId: "X1000001", firstName: "Untested", otherName: "Perera", nic: null, createdDate: day(6), result: null },
];

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const u of Object.values(USERS)) await prisma.user.create({ data: u });
});
after(async () => database?.close());
beforeEach(async () => {
    await pg.exec(`
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "rate_limits"; DELETE FROM "job_candidate"; DELETE FROM "job_job_type"; DELETE FROM "job"; DELETE FROM "job_code_counter";
        DELETE FROM "job_type"; DELETE FROM "agent_client"; DELETE FROM "client"; DELETE FROM "agent";
        DELETE FROM "candidate_allocation"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
    `);
    await prisma.candidate.createMany({
        data: CANDIDATES.map(({ result: _result, ...row }, i) => ({ ...row, uniqueId: `80${i}`, whatsappNumber: `9477100000${i}`, contactNumber: `07110000${i}` })),
    });
    await prisma.candidateStage.createMany({
        data: CANDIDATES.filter((c) => c.result).map((c) => ({ passportId: c.passportId, stage: "TEST_DETAILS", testResult: c.result })),
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
const options = (who, query = "") => api(who, "GET", `/job-candidate-options${query}`);
const passports = (response) => response.body.items.map((item) => item.passportId);

describe("Add to Job: the candidate list", () => {
    test("with no search, every candidate who passed the test, newest registered first (FAIL and untested left out)", async () => {
        const response = await options(USERS.OWNER, "?page=1&pageSize=20");
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.deepEqual(passports(response), ["N1000004", "N1000003", "N1000002", "N1000001"]);
        assert.equal(response.body.pagination.total, 4);
    });

    test("paged on the server, the order kept across pages", async () => {
        const first = await options(USERS.OWNER, "?page=1&pageSize=3");
        const second = await options(USERS.OWNER, "?page=2&pageSize=3");
        assert.deepEqual(passports(first), ["N1000004", "N1000003", "N1000002"]);
        assert.deepEqual(passports(second), ["N1000001"]);
        assert.deepEqual([first.body.pagination.total, first.body.pagination.totalPages], [4, 2]);
    });

    test("same registration time: a stable order (passport ID) on every request", async () => {
        await prisma.candidate.updateMany({ data: { createdDate: day(9) } });
        const a = passports(await options(USERS.OWNER, "?pageSize=20"));
        const b = passports(await options(USERS.OWNER, "?pageSize=20"));
        assert.deepEqual(a, ["N1000001", "N1000002", "N1000003", "N1000004"]);
        assert.deepEqual(b, a);
    });

    test("search by name: case-insensitive, extra spaces ignored, several words in any order, across first and surname", async () => {
        for (const search of ["nimal", "  NIMAL   silva ", "silva nimal", "perera"]) {
            const found = passports(await options(USERS.OWNER, `?search=${encodeURIComponent(search)}`));
            assert.ok(found.includes("N1000001"), search);
            assert.ok(!found.includes("F1000001") && !found.includes("X1000001"), `${search}: only PASS candidates`);
        }
        assert.deepEqual(passports(await options(USERS.OWNER, "?search=perera")), ["N1000003", "N1000001"], "newest first within the search too");
        assert.deepEqual(passports(await options(USERS.OWNER, "?search=nobody")), []);
    });

    test("search by passport number and by NIC", async () => {
        assert.deepEqual(passports(await options(USERS.OWNER, "?search=n1000002")), ["N1000002"]);
        assert.deepEqual(passports(await options(USERS.OWNER, "?search=199033333333")), ["N1000003"]);
        assert.deepEqual(passports(await options(USERS.OWNER, "?search=F1000001")), [], "a candidate who failed is not offered, even by passport");
    });

    test("only what the list shows: no contact numbers, documents or stages", async () => {
        const [item] = (await options(USERS.OWNER, "?search=N1000001")).body.items;
        assert.deepEqual(Object.keys(item).sort(), ["name", "nic", "passportId", "uniqueId", "workflowStatus"]);
        assert.equal(item.name, "Nimal Perera Silva");
    });

    test("RBAC: job managers (OWNER, ADMIN, TEAM_LEAD, JOB_HANDLER) see the same list; ANALYST and REGISTRATION_DESK are refused", async () => {
        for (const who of [USERS.OWNER, USERS.ADMIN, USERS.TEAM_LEAD, USERS.JOB_HANDLER]) {
            const response = await options(who);
            assert.equal(response.status, 200, who.role);
            assert.equal(response.body.pagination.total, 4, who.role);
        }
        for (const who of [USERS.ANALYST, USERS.DESK]) assert.equal((await options(who)).status, 403, who.role);
    });

    test("a candidate already on the job stays listed, and adding them again is still refused (nothing doubled)", async () => {
        const job = (await api(USERS.OWNER, "POST", "/jobs", { jobTypeId: ids.jobType, clientId: ids.acme, candidateIds: ["N1000002"] })).body;
        assert.ok(passports(await options(USERS.OWNER)).includes("N1000002"));
        const again = await api(USERS.OWNER, "POST", `/jobs/${job.jobId}/candidates`, { passportId: "N1000002" });
        assert.equal(again.status, 409);
        assert.equal(again.body.code, "CANDIDATE_ALREADY_IN_JOB");
        assert.equal(await prisma.jobCandidate.count({ where: { jobId: job.jobId } }), 1);
    });
});

describe("Job Sector (optional)", () => {
    const create = (body) => api(USERS.OWNER, "POST", "/jobs", { jobTypeId: ids.jobType, clientId: ids.acme, ...body });

    test("saved and returned for CONSTRUCTION and INDUSTRIAL (any case)", async () => {
        for (const [sent, stored] of [["CONSTRUCTION", "CONSTRUCTION"], ["industrial", "INDUSTRIAL"]]) {
            const response = await create({ jobSector: sent });
            assert.equal(response.status, 201, JSON.stringify(response.body));
            assert.equal(response.body.jobSector, stored);
            assert.equal((await prisma.job.findUnique({ where: { id: response.body.jobId }, select: { jobSector: true } })).jobSector, stored);
            assert.equal((await api(USERS.OWNER, "GET", `/jobs/${response.body.jobId}`)).body.jobSector, stored);
        }
    });

    test("optional: left out, null or empty is no sector (null)", async () => {
        for (const body of [{}, { jobSector: null }, { jobSector: "" }]) {
            const response = await create(body);
            assert.equal(response.status, 201, JSON.stringify(response.body));
            assert.equal(response.body.jobSector, null, JSON.stringify(body));
        }
    });

    test("anything else is refused with 400 and nothing is created", async () => {
        for (const jobSector of ["Constructions", "Mining", 5, true]) {
            const response = await create({ jobSector });
            assert.equal(response.status, 400, String(jobSector));
            assert.ok(response.body.errors.some((e) => e.field === "jobSector"), String(jobSector));
        }
        assert.equal(await prisma.job.count(), 0);
    });

    test("the database CHECK refuses an unknown sector too", async () => {
        const job = (await create({})).body;
        await assert.rejects(pg.exec(`UPDATE "job" SET "job_sector" = 'MINING' WHERE "id" = '${job.jobId}'`), /job_job_sector_check/);
    });

    test("the job list shows each job's sector (null for one without)", async () => {
        await create({ jobSector: "CONSTRUCTION" });
        await create({});
        const list = await api(USERS.OWNER, "GET", "/jobs");
        assert.equal(list.status, 200);
        assert.deepEqual(list.body.items.map((j) => j.jobSector).sort(), ["CONSTRUCTION", null].sort());
    });
});
