// Candidate scope and the narrowed operational roles, end to end (Docs/ROLES_AND_PERMISSIONS.md):
//   ANALYST            only the candidates allocated to them: list, search, paging, filters, the
//                      candidate page and everything under it, Need Attention, jobs and counts.
//   TEAM_LEAD          every candidate; Need Attention is its notification source (never the review queue).
//   JOB_HANDLER        views candidates (the list, the candidate's page and what it reads), changes none.
//   REGISTRATION_DESK  the registration workflow (lookup, register, registration details and documents)
//                      and Need Attention read only.
// On a REAL PostgreSQL (PGlite, every migration applied) through the real Prisma client, the real
// services and the real admin router.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createFakeAuthAdmin } from "./helpers/fakeSupabaseAuth.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { ALL_ROLES } from "../src/middleware/requireRole.js";

const user = (role, n, adminId = `u-${role.toLowerCase()}`) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, status: "ACTIVE" });
const USERS = {
    ...Object.fromEntries(ALL_ROLES.map((role, n) => [role, user(role, n + 1)])),
    ANALYST_B: user("ANALYST", 40, "u-analyst-b"),
    MANAGER: user("MANAGER", 50),
};
const A = USERS.ANALYST;
const B = USERS.ANALYST_B;
// Candidate 1 and 2: Analyst A. Candidate 3: Analyst B. Candidate 4: nobody. Candidate 5: test not passed.
const C1 = "RS0000001";
const C2 = "RS0000002";
const C3 = "RS0000003";
const C4 = "RS0000004";
const C5 = "RS0000005";
const CANDIDATES = [
    [C1, "9201", "Nimal", "Perera", "199012340001", A],
    [C2, "9202", "Sunil", "Perera", "199012340002", A],
    [C3, "9203", "Kamal", "Perera", "199012340003", B],
    [C4, "9204", "Ruwan", "Perera", "199012340004", null],
    [C5, "9205", "Amal", "Perera", "199012340005", null],
];

let database;
let prisma;
let pg;
let server;
let baseUrl;
let ids;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const u of Object.values(USERS)) await prisma.user.create({ data: u });
    const app = express();
    app.use(express.json());
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: req.get("x-test-user") }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
        if (!req.user) return res.status(401).json({ message: "Invalid or Expired Token" });
        return next();
    };
    app.use("/api/admin", createAdminRouter({ db: prisma, bucket: {}, requireAdmin, authAdmin: createFakeAuthAdmin(), apiLimiter: noRateLimit }));
    app.use(errorHandler);
    await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/admin`;
});
after(async () => {
    server?.close();
    await database?.close();
});
beforeEach(async () => {
    await pg.exec(`
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "rate_limits"; DELETE FROM "job_candidate"; DELETE FROM "job"; DELETE FROM "job_code_counter";
        DELETE FROM "agent_client"; DELETE FROM "client"; DELETE FROM "agent";
        DELETE FROM "call_log_follow_up"; DELETE FROM "candidate_call_logs"; DELETE FROM "candidate_allocation";
        DELETE FROM "candidate_stages"; DELETE FROM "candidate";
    `);
    for (const [passportId, uniqueId, firstName, otherName, nic, analyst] of CANDIDATES) {
        await prisma.candidate.create({ data: { passportId, uniqueId, firstName, otherName, nic } });
        await prisma.candidateStage.create({ data: { passportId, stage: "TEST_DETAILS", testResult: passportId === C5 ? "FAIL" : "PASS" } });
        if (analyst) await prisma.candidateAllocation.create({ data: { passportId, analystId: analyst.adminId } });
    }
    const jobType = await prisma.jobType.upsert({ where: { code: "WELDER" }, update: { isActive: true }, create: { code: "WELDER", name: "Welder" } });
    const agent = await prisma.agent.create({ data: { name: "Ion Popescu", countryCode: "RO" } });
    const client = await prisma.client.create({ data: { name: "Acme Construction", agentLinks: { create: { agentId: agent.id } } } });
    ids = { jobType: jobType.id, client: client.id };
});

async function api(who, method, path, body) {
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { "x-test-user": who.adminId, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
}
const ok = (response, status = 200) => {
    assert.equal(response.status, status, JSON.stringify(response.body));
    return response.body;
};
const forbidden = (response, label) => assert.equal(response.status, 403, `${label}: ${response.status} ${JSON.stringify(response.body)}`);
const notFound = (response, label) => assert.equal(response.status, 404, `${label}: ${response.status} ${JSON.stringify(response.body)}`);
const passports = (list) => list.items.map((item) => item.passportId).sort();
// A follow-up on `passportId`, flagged by the ADMIN (with its call).
async function flag(passportId) {
    ok(await api(USERS.ADMIN, "POST", `/candidates/${passportId}/call-logs`, { note: `Call back ${passportId}`, needsAttention: true }), 201);
    return (await prisma.callLogFollowUp.findFirst({ where: { callLog: { passportId } } })).followUpId;
}
const followUpPassports = (list) => list.groups.map((group) => group.candidate.passportId).sort();

describe("ANALYST: only the candidates allocated to them", () => {
    test("the list shows Candidate 1 and 2 to Analyst A, Candidate 3 to Analyst B; nobody sees the unallocated one", async () => {
        const listA = ok(await api(A, "GET", "/candidates"));
        assert.deepEqual(passports(listA), [C1, C2]);
        assert.equal(listA.pagination.total, 2, "the total counts only Analyst A's candidates");
        assert.deepEqual(passports(ok(await api(B, "GET", "/candidates"))), [C3]);
    });

    test("search never finds Candidate 3 for Analyst A (passport ID, name, NIC, unique ID, a shared surname)", async () => {
        for (const search of [C3, C3.toLowerCase(), "Kamal", "199012340003", "9203"]) {
            const list = ok(await api(A, "GET", `/candidates?search=${encodeURIComponent(search)}`));
            assert.deepEqual(list.items, [], `search "${search}"`);
            assert.equal(list.pagination.total, 0, `search "${search}" total`);
        }
        assert.deepEqual(passports(ok(await api(A, "GET", "/candidates?search=Perera"))), [C1, C2], "a surname every candidate shares");
    });

    test("paging and filters are no loophole: totals and every page stay inside the allocation", async () => {
        const seen = [];
        for (let page = 1; page <= 4; page += 1) {
            const list = ok(await api(A, "GET", `/candidates?page=${page}&pageSize=1`));
            assert.equal(list.pagination.total, 2);
            seen.push(...passports(list));
        }
        assert.deepEqual(seen.sort(), [C1, C2], "no page holds another Analyst's candidate");
        assert.deepEqual(ok(await api(A, "GET", "/candidates?page=999&pageSize=100")).items, []);
        assert.deepEqual(passports(ok(await api(A, "GET", "/candidates?testResult=PASS&available=true&search=Perera"))), [C1, C2]);
    });

    test("Candidate 3 cannot be fetched directly, nor anything under it, nor changed (404, as if it did not exist)", async () => {
        notFound(await api(A, "GET", `/candidates/${C3}`), "candidate page");
        notFound(await api(A, "GET", `/candidates/${C3.toLowerCase()}`), "candidate page, other case");
        notFound(await api(A, "GET", `/candidates/${C4}`), "the unallocated candidate");
        for (const path of ["call-logs", "additional-details", "form-submission", "form-share"]) notFound(await api(A, "GET", `/candidates/${C3}/${path}`), path);
        const before = JSON.stringify(await prisma.candidate.findUnique({ where: { passportId: C3 }, include: { stages: true } }));
        notFound(await api(A, "PUT", `/candidates/${C3}`, { surname: "Perera", otherNames: "Changed", nic: "199012340003", jobExperience: "5 years", passportIssueDate: "2020-01-01", passportExpiryDate: "2030-01-01", jobTypes: ["Welder"] }), "edit");
        notFound(await api(A, "PUT", `/candidates/${C3}/stages/IVS_INTERVIEW`, { completed: true }), "stage");
        notFound(await api(A, "POST", `/candidates/${C3}/call-logs`, { note: "x" }), "call log");
        notFound(await api(A, "POST", `/candidates/${C3}/form-share`, {}), "form link");
        assert.equal(JSON.stringify(await prisma.candidate.findUnique({ where: { passportId: C3 }, include: { stages: true } })), before, "Candidate 3 is unchanged");
        assert.equal(await prisma.candidateCallLog.count({ where: { passportId: C3 } }), 0);
        // Their own candidate opens.
        assert.equal(ok(await api(A, "GET", `/candidates/${C1}`)).candidate.passportId, C1);
    });

    test("Need Attention names only their candidates; another Analyst's follow-up can't be completed", async () => {
        await flag(C1);
        const other = await flag(C3);
        assert.deepEqual(followUpPassports(ok(await api(A, "GET", "/follow-ups?status=OPEN"))), [C1]);
        assert.deepEqual(followUpPassports(ok(await api(B, "GET", "/follow-ups?status=OPEN"))), [C3]);
        notFound(await api(A, "POST", `/follow-ups/${other}/complete`, {}), "complete another Analyst's follow-up");
        assert.equal((await prisma.callLogFollowUp.findUnique({ where: { followUpId: other } })).status, "OPEN");
    });

    test("jobs show only their candidates, and a job holding none of them is not found", async () => {
        const shared = ok(await api(USERS.ADMIN, "POST", "/jobs", { jobTypeId: ids.jobType, clientId: ids.client, candidateIds: [C1, C3] }), 201);
        const foreign = ok(await api(USERS.ADMIN, "POST", "/jobs", { jobTypeId: ids.jobType, clientId: ids.client, candidateIds: [C3] }), 201);
        assert.deepEqual(ok(await api(A, "GET", `/jobs/${shared.jobId}`)).candidates.map((c) => c.passportId), [C1]);
        const jobs = ok(await api(A, "GET", "/jobs?view=all"));
        assert.deepEqual(jobs.items.map((j) => [j.jobId, j.candidateCount]), [[shared.jobId, 1]]);
        notFound(await api(A, "GET", `/jobs/${foreign.jobId}`), "a job holding only another Analyst's candidate");
    });

    test("candidate counts and shared selectors stay inside the allocation (or are refused)", async () => {
        // Every fixture candidate has Candidate Details open (no WhatsApp number, no passport dates).
        const incomplete = (who) => api(who, "GET", "/reports/daily/incomplete?stage=CANDIDATE_DETAILS");
        const own = ok(await incomplete(A));
        assert.deepEqual([passports(own), own.pagination.total], [[C1, C2], 2]);
        assert.equal(ok(await incomplete(USERS.ADMIN)).pagination.total, CANDIDATES.length);
        for (const path of ["/work-allocation/candidates", "/job-candidate-options"]) forbidden(await api(A, "GET", path), path);
    });
});

describe("TEAM_LEAD", () => {
    test("sees every candidate (allocated to anyone, or to nobody)", async () => {
        assert.deepEqual(passports(ok(await api(USERS.TEAM_LEAD, "GET", "/candidates"))), CANDIDATES.map(([id]) => id).sort());
        for (const [id] of CANDIDATES) ok(await api(USERS.TEAM_LEAD, "GET", `/candidates/${id}`));
    });

    test("its notifications come from Need Attention (every candidate), never from the review queue", async () => {
        await flag(C1);
        await flag(C3);
        assert.deepEqual(followUpPassports(ok(await api(USERS.TEAM_LEAD, "GET", "/follow-ups?status=OPEN"))), [C1, C3]);
        forbidden(await api(USERS.TEAM_LEAD, "GET", "/review?page=1&pageSize=100&order=desc"), "the review queue");
    });
});

describe("JOB_HANDLER: views candidates, changes none", () => {
    const JH = USERS.JOB_HANDLER;

    test("lists, searches and opens any candidate's workflow, with what the candidate page reads", async () => {
        assert.deepEqual(passports(ok(await api(JH, "GET", "/candidates"))), CANDIDATES.map(([id]) => id).sort());
        assert.deepEqual(passports(ok(await api(JH, "GET", "/candidates?search=Kamal"))), [C3]);
        assert.equal(ok(await api(JH, "GET", `/candidates/${C3}`)).candidate.passportId, C3);
        for (const path of ["call-logs", "additional-details", "form-submission"]) ok(await api(JH, "GET", `/candidates/${C3}/${path}`));
    });

    test("every candidate change is refused and nothing changes; no Need Attention", async () => {
        const before = JSON.stringify(await prisma.candidate.findUnique({ where: { passportId: C1 }, include: { stages: true } }));
        for (const [method, path, body] of [
            ["PUT", `/candidates/${C1}`, { surname: "Perera", otherNames: "Changed", nic: "199012340001", jobTypes: ["Welder"] }],
            ["PUT", `/candidates/${C1}/stages/CANDIDATE_DETAILS`, { notes: "x" }],
            ["PUT", `/candidates/${C1}/stages/IVS_INTERVIEW`, { completed: true }],
            ["POST", `/candidates/${C1}/documents/upload-target`, { type: "PASSPORT", mimeType: "application/pdf", fileSize: 1000 }],
            ["POST", `/candidates/${C1}/call-logs`, { note: "x" }],
            ["PUT", `/candidates/${C1}/additional-details`, {}],
            ["POST", `/candidates/${C1}/form-share`, {}],
            ["POST", "/candidates", {}],
            ["GET", "/follow-ups"],
        ]) forbidden(await api(JH, method, path, body), `${method} ${path}`);
        assert.equal(JSON.stringify(await prisma.candidate.findUnique({ where: { passportId: C1 }, include: { stages: true } })), before);
    });

    test("staffs jobs through the job candidate picker (test PASS only, only what the picker shows)", async () => {
        const options = ok(await api(JH, "GET", "/job-candidate-options"));
        assert.deepEqual(passports(options), [C1, C2, C3, C4], "Candidate 5 did not pass the test");
        for (const item of options.items) assert.deepEqual(Object.keys(item).sort(), ["name", "nic", "passportId", "uniqueId", "workflowStatus"]);
        const job = ok(await api(JH, "POST", "/jobs", { jobTypeId: ids.jobType, clientId: ids.client, candidateIds: [C1] }), 201);
        ok(await api(JH, "POST", `/jobs/${job.jobId}/candidates`, { passportId: C3 }), 201);
        assert.deepEqual(ok(await api(JH, "GET", `/jobs/${job.jobId}`)).candidates.map((c) => c.passportId).sort(), [C1, C3]);
    });

    test("ADMIN and TEAM_LEAD use the same picker; the other roles can't", async () => {
        for (const who of [USERS.OWNER, USERS.ADMIN, USERS.TEAM_LEAD]) assert.equal(ok(await api(who, "GET", "/job-candidate-options")).pagination.total, 4, who.role);
        for (const who of [A, USERS.REGISTRATION_DESK, USERS.MANAGER]) forbidden(await api(who, "GET", "/job-candidate-options"), who.role);
    });
});

describe("REGISTRATION_DESK: the registration workflow, and Need Attention read only", () => {
    const RD = USERS.REGISTRATION_DESK;
    const NEW = "N1234567";

    test("looks the passport ID up, registers, and saves the registration details and note", async () => {
        notFound(await api(RD, "GET", `/candidates/${NEW}`), "the lookup of a new passport ID");
        const created = ok(await api(RD, "POST", "/candidates", { passportId: NEW, surname: "Silva", otherNames: "Saman", nic: "199012349999", whatsappNumber: "0771234567", jobTypes: ["Welder"] }), 201);
        assert.equal(created.passportId, NEW);
        assert.equal(ok(await api(RD, "GET", `/candidates/${NEW}`)).candidate.passportId, NEW, "the lookup finds an existing candidate");
        ok(await api(RD, "PUT", `/candidates/${NEW}`, { surname: "Silva", otherNames: "Saman Kumara", nic: "199012349999", jobTypes: ["Welder"], jobExperience: "3 years", passportIssueDate: "2020-01-01", passportExpiryDate: "2030-01-01" }));
        ok(await api(RD, "PUT", `/candidates/${NEW}/stages/CANDIDATE_DETAILS`, { notes: "Walk-in" }));
    });

    test("uploads only the registration documents (passport, NIC, skill video)", async () => {
        const target = (type, mimeType = "application/pdf") => api(RD, "POST", `/candidates/${C1}/documents/upload-target`, { type, mimeType, fileSize: 1000 });
        for (const [type, mime] of [["PASSPORT"], ["NIC"], ["SKILL_VIDEO", "video/mp4"]]) assert.notEqual((await target(type, mime)).status, 403, type);
        for (const type of ["MEDICAL", "SCAN", "VISA_SUBMISSION"]) forbidden(await target(type), type);
        const finalize = await api(RD, "POST", `/candidates/${C1}/documents/finalize`, { uploadId: "11111111-1111-4111-8111-111111111111", type: "MEDICAL", mimeType: "application/pdf" });
        forbidden(finalize, "finalize a MEDICAL upload");
    });

    test("views Need Attention (every candidate) but cannot flag, complete or delete a follow-up", async () => {
        const followUpId = await flag(C1);
        await flag(C3);
        assert.deepEqual(followUpPassports(ok(await api(RD, "GET", "/follow-ups?status=OPEN"))), [C1, C3]);
        ok(await api(RD, "GET", "/follow-ups?status=COMPLETED"));
        const call = await prisma.candidateCallLog.findFirst({ where: { passportId: C1 } });
        for (const [method, path, body] of [
            ["POST", `/follow-ups/${followUpId}/complete`, {}], ["DELETE", `/follow-ups/${followUpId}`],
            ["POST", `/candidates/${C1}/call-logs/${call.callLogId}/follow-up`, {}], ["POST", `/candidates/${C2}/call-logs`, { note: "x", needsAttention: true }],
        ]) forbidden(await api(RD, method, path, body), `${method} ${path}`);
        assert.equal((await prisma.callLogFollowUp.findUnique({ where: { followUpId } })).status, "OPEN");
        assert.equal(await prisma.candidateCallLog.count({ where: { passportId: C2 } }), 0);
    });

    test("nothing else of a candidate: list, other stages, call logs, additional details, form links, removing documents", async () => {
        const followUpId = await flag(C1);
        for (const [method, path, body] of [
            ["GET", "/candidates"], ["GET", `/candidates?search=${C3}`],
            ["PUT", `/candidates/${C1}/stages/IVS_INTERVIEW`, { completed: true }], ["PUT", `/candidates/${C1}/stages/TEST_DETAILS`, { testResult: "PASS" }],
            ["GET", `/candidates/${C1}/call-logs`], ["POST", `/candidates/${C1}/call-logs`, { note: "x" }],
            ["GET", `/candidates/${C1}/additional-details`], ["PUT", `/candidates/${C1}/additional-details`, {}],
            ["GET", `/candidates/${C1}/form-submission`], ["GET", `/candidates/${C1}/form-share`], ["POST", `/candidates/${C1}/form-share`, {}],
            ["POST", `/candidates/${C1}/documents/11111111-1111-4111-8111-111111111111/remove`, { reason: "x" }],
        ]) forbidden(await api(RD, method, path, body), `${method} ${path}`);
        assert.equal((await prisma.callLogFollowUp.findUnique({ where: { followUpId } })).status, "OPEN");
    });

    test("no Work Allocation, Jobs, Agents, Clients, Settings, reports, review or audit logs", async () => {
        for (const path of ["/work-allocation/candidates", "/jobs", "/job-options", "/agents", "/client-management", "/settings/sheet-sync/status", "/reports/daily", "/reports/daily/summary", "/review", "/overview", "/audit-logs", "/users"]) {
            forbidden(await api(RD, "GET", path), path);
        }
    });
});
