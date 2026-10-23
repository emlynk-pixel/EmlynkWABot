// The JOB_HANDLER role: Jobs, Agents and Clients (manage), Candidates (read only), no Settings,
// Audit Logs, user management or other admin areas; ADMIN and MANAGER can invite one (MANAGER:
// a NEW Job Handler only). Plus a route-by-route sweep proving the four existing roles keep
// exactly the access they had (RBAC-REG). On a REAL PostgreSQL (PGlite, every migration
// applied) through the real Prisma client, the real services and the real admin router; the
// Supabase Auth admin is the test fake (no Supabase).
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createFakeAuthAdmin } from "./helpers/fakeSupabaseAuth.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { ALL_ROLES, INVITABLE_ROLES, ROLES, canInviteRole, isValidRole } from "../src/middleware/requireRole.js";
import { completeInvitation } from "../src/services/userAccountService.js";

const user = (role, n) => ({ adminId: `u-${role.toLowerCase()}`, role, name: `${role} user`, email: `${role.toLowerCase()}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, status: "ACTIVE" });
const USERS = Object.fromEntries(ALL_ROLES.map((role, n) => [role, user(role, n + 1)]));
const JH = USERS.JOB_HANDLER;
const PID = "JH0000001";
const NO_ID = "11111111-1111-4111-8111-111111111111";

let database;
let prisma;
let pg;
let authAdmin;
let server;
let baseUrl;
let ids;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const u of Object.values(USERS)) await prisma.user.create({ data: u });
    process.env.APP_BASE_URL = "https://app.example.invalid/";
    authAdmin = createFakeAuthAdmin();
    // One server; the caller is chosen per request (x-test-user), loaded from the database like requireActiveUser does.
    const app = express();
    app.use(express.json());
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: req.get("x-test-user") }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
        if (!req.user) return res.status(401).json({ message: "Invalid or Expired Token" });
        return next();
    };
    app.use("/api/admin", createAdminRouter({ db: prisma, bucket: {}, requireAdmin, authAdmin, apiLimiter: noRateLimit }));
    app.use(errorHandler);
    await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/admin`;
});
after(async () => {
    server?.close();
    delete process.env.APP_BASE_URL;
    await database?.close();
});
beforeEach(async () => {
    await pg.exec(`
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "rate_limits"; DELETE FROM "job_candidate"; DELETE FROM "job"; DELETE FROM "job_code_counter";
        DELETE FROM "agent_client"; DELETE FROM "client"; DELETE FROM "agent";
        DELETE FROM "candidate_stages"; DELETE FROM "candidate";
        DELETE FROM "user" WHERE "admin_id" NOT IN (${Object.values(USERS).map((u) => `'${u.adminId}'`).join(",")});
    `);
    await prisma.user.updateMany({ where: { adminId: { in: Object.values(USERS).map((u) => u.adminId) } }, data: { status: "ACTIVE" } });
    authAdmin.calls.length = 0;
    await prisma.candidate.create({ data: { passportId: PID, uniqueId: "9001", firstName: "Nimal", otherName: "Perera", nic: "199012345678" } });
    await prisma.candidateStage.create({ data: { passportId: PID, stage: "TEST_DETAILS", testResult: "PASS" } });
    const jobType = await prisma.jobType.upsert({ where: { code: "WELDER" }, update: { isActive: true }, create: { code: "WELDER", name: "Welder" } });
    const agent = await prisma.agent.create({ data: { name: "Ion Popescu", countryCode: "RO" } });
    const client = await prisma.client.create({ data: { name: "Acme Construction", agentLinks: { create: { agentId: agent.id } } } });
    ids = { jobType: jobType.id, agent: agent.id, client: client.id };
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

describe("the role (ROLE-001, ROLE-002)", () => {
    test("ROLE-001: JOB_HANDLER is a valid role, stored as plain text like the others", async () => {
        assert.equal(ROLES.JOB_HANDLER, "JOB_HANDLER");
        assert.ok(isValidRole("JOB_HANDLER"));
        assert.equal((await prisma.user.findUnique({ where: { adminId: JH.adminId } })).role, "JOB_HANDLER");
        // The Change Roles action accepts it too (ADMIN only, as before).
        const target = await prisma.user.create({ data: { ...user("ANALYST", 99), adminId: "u-target", email: "target@example.invalid" } });
        assert.equal(ok(await api(USERS.ADMIN, "PUT", `/users/${target.adminId}/role`, { role: "JOB_HANDLER" })).user.role, "JOB_HANDLER");
        forbidden(await api(USERS.MANAGER, "PUT", `/users/${target.adminId}/role`, { role: "JOB_HANDLER" }), "MANAGER role change");
    });

    test("ROLE-002: the four existing roles stay valid and unchanged; unknown roles stay invalid", () => {
        assert.deepEqual(ALL_ROLES, ["ADMIN", "MANAGER", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]);
        for (const role of ["ADMIN", "MANAGER", "ANALYST", "REGISTRATION_DESK"]) assert.ok(isValidRole(role));
        for (const role of ["VIEWER", "job_handler", "JOBHANDLER", ""]) assert.equal(isValidRole(role), false);
        assert.deepEqual(INVITABLE_ROLES.ADMIN, ALL_ROLES);
        assert.deepEqual(INVITABLE_ROLES.MANAGER, ["JOB_HANDLER"]);
    });
});

describe("invitations (INVITE-001 to INVITE-005)", () => {
    const invite = (who, body) => api(who, "POST", "/users/invite", { name: "New Person", email: "new.person@example.invalid", ...body });

    test("INVITE-001: ADMIN invites a Job Handler (audited with the ADMIN as actor)", async () => {
        const result = ok(await invite(USERS.ADMIN, { role: "JOB_HANDLER" }), 201);
        assert.deepEqual([result.user.role, result.user.status, result.outcome], ["JOB_HANDLER", "INVITED", "INVITED"]);
        const [entry] = await prisma.auditLog.findMany({ where: { action: "INVITE_USER" } });
        assert.deepEqual([entry.adminId, entry.reason], [USERS.ADMIN.adminId, "Invited as JOB_HANDLER"]);
    });

    test("INVITE-002: MANAGER invites a Job Handler (audited with the MANAGER as actor)", async () => {
        const result = ok(await invite(USERS.MANAGER, { role: "job_handler" }), 201);
        assert.equal(result.user.role, "JOB_HANDLER");
        assert.equal((await prisma.auditLog.findFirst({ where: { action: "INVITE_USER" } })).adminId, USERS.MANAGER.adminId);
        // Re-sending a still-pending Job Handler invitation is allowed to the MANAGER too.
        assert.equal(ok(await invite(USERS.MANAGER, { role: "JOB_HANDLER" }), 201).user.role, "JOB_HANDLER");
    });

    test("INVITE-003: ANALYST, REGISTRATION_DESK and JOB_HANDLER cannot invite a Job Handler (nothing sent)", async () => {
        for (const who of [USERS.ANALYST, USERS.REGISTRATION_DESK, JH]) forbidden(await invite(who, { role: "JOB_HANDLER" }), who.role);
        assert.equal(authAdmin.calls.length, 0);
        assert.equal(await prisma.user.count({ where: { email: "new.person@example.invalid" } }), 0);
    });

    test("INVITE-004: the MANAGER's other limits stay: no other role, no existing account, no other user management", async () => {
        for (const role of ["ADMIN", "MANAGER", "ANALYST", "REGISTRATION_DESK"]) forbidden(await invite(USERS.MANAGER, { role }), `MANAGER invites ${role}`);
        assert.equal(authAdmin.calls.length, 0, "no invitation e-mail for a refused request");
        // An existing account of another role: re-inviting it "as a Job Handler" would change its role.
        await prisma.user.create({ data: { adminId: "u-pending-analyst", authUserId: "00000000-0000-4000-8000-0000000000f1", name: "Pending", email: "pending@example.invalid", role: "ANALYST", status: "INVITED" } });
        authAdmin.users.set("pending@example.invalid", { authUserId: "00000000-0000-4000-8000-0000000000f1", confirmed: false });
        const relabel = await invite(USERS.MANAGER, { role: "JOB_HANDLER", email: "pending@example.invalid" });
        assert.deepEqual([relabel.status, relabel.body.code], [403, "ADMIN_REQUIRED"]);
        // A deactivated account (even a former Job Handler): reactivation stays an ADMIN's.
        await prisma.user.create({ data: { adminId: "u-gone", authUserId: "00000000-0000-4000-8000-0000000000f2", name: "Gone", email: "gone@example.invalid", role: "ADMIN", status: "INACTIVE" } });
        assert.equal((await invite(USERS.MANAGER, { role: "JOB_HANDLER", email: "gone@example.invalid" })).status, 403);
        assert.deepEqual((await prisma.user.findMany({ where: { email: { in: ["pending@example.invalid", "gone@example.invalid"] } }, orderBy: { email: "asc" } })).map((u) => [u.role, u.status]), [["ADMIN", "INACTIVE"], ["ANALYST", "INVITED"]], "untouched");
        for (const [method, path, body] of [["GET", "/users"], ["PUT", "/users/u-analyst/role", { role: "JOB_HANDLER" }], ["POST", "/users/u-analyst/deactivate", {}]]) {
            forbidden(await api(USERS.MANAGER, method, path, body), `MANAGER ${method} ${path}`);
        }
        assert.equal(canInviteRole("MANAGER", "ADMIN"), false);
        // The ADMIN still may do all of it.
        assert.equal(ok(await invite(USERS.ADMIN, { role: "JOB_HANDLER", email: "pending@example.invalid" }), 201).user.role, "JOB_HANDLER");
    });

    test("INVITE-005: accepting the invitation makes an ACTIVE JOB_HANDLER user, who then has Job Handler access", async () => {
        const invited = ok(await invite(USERS.MANAGER, { role: "JOB_HANDLER", email: "handler@example.invalid" }), 201);
        const row = await prisma.user.findUnique({ where: { adminId: invited.user.userId } });
        const accepted = await completeInvitation({ db: prisma, authUserId: row.authUserId });
        assert.deepEqual([accepted.role, accepted.status], ["JOB_HANDLER", "ACTIVE"]);
        const fresh = { adminId: invited.user.userId };
        ok(await api(fresh, "GET", "/jobs"));
        forbidden(await api(fresh, "GET", "/overview"), "overview");
    });
});

describe("Jobs (JOB-HANDLER-JOB-001 to 005)", () => {
    test("JOB-001 / 002 / 003 / 004: lists, views, creates and manages jobs; actions are audited as the Job Handler", async () => {
        const options = ok(await api(JH, "GET", "/job-options"));
        assert.deepEqual(options.clients.map((c) => c.name), ["Acme Construction"]);
        const job = ok(await api(JH, "POST", "/jobs", { jobTypeId: ids.jobType, clientId: ids.client, vacancies: 2 }), 201);
        assert.ok(ok(await api(JH, "GET", "/jobs")).items.some((j) => j.jobId === job.jobId), "JOB-001 list");
        assert.equal(ok(await api(JH, "GET", `/jobs/${job.jobId}`)).jobCode, job.jobCode, "JOB-002 view");
        assert.equal(ok(await api(JH, "PUT", `/jobs/${job.jobId}`, { vacancies: 5, fromCountryCode: "LK", companyJobId: "Y26S01" })).vacancies, 5, "JOB-004 edit");
        assert.equal(ok(await api(JH, "POST", `/jobs/${job.jobId}/complete`, {})).status, "COMPLETED");
        const other = ok(await api(JH, "POST", "/jobs", { jobTypeId: ids.jobType, clientId: ids.client }), 201);
        assert.equal(ok(await api(JH, "POST", `/jobs/${other.jobId}/cancel`, { reason: "Client withdrew" })).status, "CANCELLED");
        const actions = await prisma.auditLog.findMany({ where: { action: { in: ["CREATE_JOB", "UPDATE_JOB", "COMPLETE_JOB", "CANCEL_JOB"] } } });
        assert.equal(actions.length, 5);
        assert.ok(actions.every((a) => a.adminId === JH.adminId), "the real actor is recorded");
    });

    test("JOB-005: assigns and removes candidates through the Job workflow (every Job rule still applies)", async () => {
        const job = ok(await api(JH, "POST", "/jobs", { jobTypeId: ids.jobType, clientId: ids.client, vacancies: 1, candidateIds: [PID] }), 201);
        assert.equal(job.candidateCount, 1, "assigned at creation");
        ok(await api(JH, "DELETE", `/jobs/${job.jobId}/candidates/${PID}`));
        assert.equal(ok(await api(JH, "POST", `/jobs/${job.jobId}/candidates`, { passportId: PID }), 201).candidateCount, 1);
        const second = ok(await api(JH, "POST", "/jobs", { jobTypeId: ids.jobType, clientId: ids.client }), 201);
        assert.equal((await api(JH, "POST", `/jobs/${job.jobId}/candidates`, { passportId: PID })).body.code, "CANDIDATE_ALREADY_IN_JOB", "never twice on the same job");
        await prisma.candidateStage.updateMany({ where: { passportId: PID }, data: { testResult: "FAIL" } });
        assert.equal((await api(JH, "POST", `/jobs/${second.jobId}/candidates`, { passportId: PID })).body.code, "CANDIDATE_TEST_NOT_PASSED", "PASS still required (also for a second job)");
        await prisma.candidateStage.updateMany({ where: { passportId: PID }, data: { testResult: "PASS" } });
        assert.equal(ok(await api(JH, "POST", `/jobs/${second.jobId}/candidates`, { passportId: PID }), 201).candidateCount, 1, "a JOB_HANDLER can put the candidate on a second job");
        assert.equal(await prisma.jobCandidate.count({ where: { passportId: PID, isActive: true } }), 2);
        assert.equal((await prisma.auditLog.findFirst({ where: { action: "ADD_CANDIDATE_TO_JOB" } })).adminId, JH.adminId);
    });

    test("not job types, not the job-group Candidate Form link: those stay ADMIN / MANAGER", async () => {
        const job = ok(await api(JH, "POST", "/jobs", { jobTypeId: ids.jobType, clientId: ids.client }), 201);
        forbidden(await api(JH, "POST", "/job-types", { name: "Cook" }), "create job type");
        forbidden(await api(JH, "GET", "/job-types"), "Settings > Job Types");
        forbidden(await api(JH, "PATCH", `/job-types/${ids.jobType}`, { isActive: false }), "edit job type");
        for (const [method, path] of [["GET", "form-share"], ["POST", "form-share"], ["POST", "form-share/revoke"]]) forbidden(await api(JH, method, `/jobs/${job.jobId}/${path}`, method === "POST" ? {} : undefined), path);
    });
});

describe("Agents and Clients (JOB-HANDLER-AGENT-001 to 003, CLIENT-001 to 003)", () => {
    test("AGENT-001 / 002 / 003: lists, views, creates and edits agents (with their client links and status)", async () => {
        const created = ok(await api(JH, "POST", "/agents", { name: "Hans Weber", countryCode: "DE", clientIds: [ids.client] }), 201);
        assert.ok(ok(await api(JH, "GET", "/agents")).items.some((a) => a.agentId === created.agentId), "list");
        assert.deepEqual(ok(await api(JH, "GET", `/agents/${created.agentId}`)).clients.map((c) => c.name), ["Acme Construction"], "view");
        assert.equal(ok(await api(JH, "PATCH", `/agents/${created.agentId}`, { name: "Hans Weber GmbH", clientIds: [] })).name, "Hans Weber GmbH");
        assert.equal(ok(await api(JH, "PATCH", `/agents/${created.agentId}/status`, { status: "INACTIVE" })).status, "INACTIVE");
        ok(await api(JH, "GET", "/agent-options"));
        assert.ok((await prisma.auditLog.findMany({ where: { action: { startsWith: "AGENT_" } } })).every((a) => a.adminId === JH.adminId));
    });

    test("CLIENT-001 / 002 / 003: lists, views, creates and edits clients (with their agent links and status)", async () => {
        const created = ok(await api(JH, "POST", "/client-management", { name: "Berlin Bau", agentIds: [ids.agent] }), 201);
        assert.ok(ok(await api(JH, "GET", "/client-management")).items.some((c) => c.clientId === created.clientId), "list");
        assert.equal(ok(await api(JH, "GET", `/client-management/${created.clientId}`)).agents[0].agentId, ids.agent, "view");
        const second = ok(await api(JH, "POST", "/agents", { name: "Nimal Perera", countryCode: "LK" }), 201);
        assert.equal(ok(await api(JH, "PATCH", `/client-management/${created.clientId}`, { contactPerson: "Ms Silva", agentIds: [ids.agent, second.agentId] })).agents.length, 2);
        assert.equal(ok(await api(JH, "PATCH", `/client-management/${created.clientId}/status`, { status: "INACTIVE" })).status, "INACTIVE");
        ok(await api(JH, "GET", "/client-options"));
        assert.ok((await prisma.auditLog.findMany({ where: { action: { startsWith: "CLIENT_" } } })).every((a) => a.adminId === JH.adminId));
    });
});

describe("Candidates: read only (JOB-HANDLER-CANDIDATE-001 to 007)", () => {
    test("CANDIDATE-001 / 002: lists, searches and opens candidates (and what the details page reads)", async () => {
        const list = ok(await api(JH, "GET", "/candidates?search=nimal&testResult=PASS&available=true"));
        assert.deepEqual(list.items.map((c) => c.passportId), [PID]);
        assert.equal(ok(await api(JH, "GET", `/candidates/${PID}`)).candidate.passportId, PID);
        for (const path of ["call-logs", "additional-details", "form-submission"]) ok(await api(JH, "GET", `/candidates/${PID}/${path}`));
        ok(await api(JH, "GET", "/job-type-choices"));
    });

    test("CANDIDATE-003 to 007: every candidate write is refused and nothing changes", async () => {
        const before = JSON.stringify(await prisma.candidate.findUnique({ where: { passportId: PID }, include: { stages: true } }));
        const writes = [
            ["POST", "/candidates", { passportId: "JH0000002", firstName: "X" }, "CANDIDATE-003 register"],
            ["PUT", `/candidates/${PID}`, { firstName: "Changed" }, "CANDIDATE-004 edit"],
            ["PUT", `/candidates/${PID}/additional-details`, {}, "CANDIDATE-004 additional details"],
            ["POST", `/candidates/${PID}/documents/upload-target`, {}, "CANDIDATE-005 upload"],
            ["POST", `/candidates/${PID}/documents/finalize`, {}, "CANDIDATE-005 finalize"],
            ["POST", `/candidates/${PID}/documents/${NO_ID}/remove`, { reason: "x" }, "CANDIDATE-005 remove"],
            ["POST", `/candidates/${PID}/verification`, { kind: "DETAILS", verified: true }, "CANDIDATE-006 verification"],
            ["PUT", `/candidates/${PID}/stages/TEST_DETAILS`, { testResult: "FAIL" }, "CANDIDATE-007 test result"],
            ["PUT", `/candidates/${PID}/stages/JOB_DETAILS`, { completed: true }, "CANDIDATE-007 job details stage"],
            ["PUT", `/candidates/${PID}/stages/IVS_INTERVIEW`, { completed: true }, "CANDIDATE-007 stage"],
            ["POST", `/candidates/${PID}/call-logs`, { note: "x" }, "call log"],
            ["POST", `/candidates/${PID}/call-logs/${NO_ID}/follow-up`, {}, "follow-up"],
            ["POST", `/candidates/${PID}/form-share`, {}, "form share"],
            ["POST", `/candidates/${PID}/form-share/revoke`, {}, "form share revoke"],
            ["GET", `/candidates/${PID}/form-share`, undefined, "form share status"],
            ["POST", "/work-allocation/assign", {}, "work allocation"],
        ];
        for (const [method, path, body, label] of writes) forbidden(await api(JH, method, path, body), label);
        assert.equal(JSON.stringify(await prisma.candidate.findUnique({ where: { passportId: PID }, include: { stages: true } })), before, "the candidate record is unchanged");
        assert.equal(await prisma.candidate.count(), 1);
    });
});

describe("restricted areas (JOB-HANDLER-SETTINGS-001, JOB-HANDLER-ADMIN-001)", () => {
    test("SETTINGS-001: no Settings API (sheet sync, job types)", async () => {
        for (const [method, path] of [["GET", "/settings/sheet-sync/status"], ["GET", "/job-types"], ["PATCH", `/job-types/${NO_ID}`]]) forbidden(await api(JH, method, path, method === "PATCH" ? {} : undefined), path);
    });

    test("ADMIN-001: no user management, invitations, audit logs, dashboards, review, reports, police, allocation or need-attention", async () => {
        for (const [method, path, body] of [
            ["GET", "/users"], ["POST", "/users/invite", { name: "A", email: "a@example.invalid", role: "JOB_HANDLER" }], ["PUT", "/users/u-analyst/role", { role: "ADMIN" }],
            ["POST", "/users/u-analyst/deactivate", {}], ["GET", "/audit-logs"], ["GET", "/overview"], ["GET", "/documents"], ["GET", "/documents/missing"],
            ["GET", "/review"], ["GET", "/police"], ["GET", "/reports/daily"], ["GET", "/reports/monthly"], ["GET", "/clients"],
            ["GET", "/work-allocation/candidates"], ["GET", "/follow-ups"],
        ]) forbidden(await api(JH, method, path, body), `${method} ${path}`);
        assert.equal(authAdmin.calls.length, 0);
        assert.equal((await prisma.user.findUnique({ where: { adminId: "u-analyst" } })).role, "ANALYST");
    });
});

// Every /api/admin route with the tier it had BEFORE the Job Handler role. The four existing
// roles must get exactly this access; JOB_HANDLER gets its own column.
const T = {
    ALL_ACTIVE: ["ADMIN", "MANAGER", "ANALYST"],
    CANDIDATE_STAFF: ["ADMIN", "MANAGER", "ANALYST", "REGISTRATION_DESK"],
    ANALYSTS_UP: ["ADMIN", "MANAGER", "ANALYST"],
    MANAGERS_UP: ["ADMIN", "MANAGER"],
    ADMINS_ONLY: ["ADMIN"],
    REGISTRATION_STAFF: ["ADMIN", "MANAGER", "REGISTRATION_DESK"],
};
const P = "ZZ0000009"; // no such candidate: an allowed role gets 404 / 400, never 403
const REVIEW = "pending-11111111-1111-4111-8111-111111111111";
// [method, path, previous tier, JOB_HANDLER allowed?]
const ROUTES = [
    ["GET", "/overview", T.ALL_ACTIVE, false], ["GET", "/documents/missing", T.ALL_ACTIVE, false], ["GET", "/documents", T.ALL_ACTIVE, false],
    ["GET", "/clients", T.ALL_ACTIVE, false], ["GET", "/reports/daily", T.ALL_ACTIVE, false], ["GET", "/reports/daily/summary", T.ALL_ACTIVE, false],
    ["GET", "/reports/daily/incomplete", T.ALL_ACTIVE, false], ["GET", "/reports/daily/roles", T.MANAGERS_UP, false], ["GET", "/reports/monthly", T.ALL_ACTIVE, false],
    ["GET", `/clients/${P}`, T.ALL_ACTIVE, false], ["GET", "/review", T.ALL_ACTIVE, false], ["GET", "/police", T.ALL_ACTIVE, false],
    ["GET", `/review/${REVIEW}`, T.ALL_ACTIVE, false], ["GET", `/review/${REVIEW}/file`, T.ALL_ACTIVE, false],
    ["POST", `/review/${REVIEW}/approve`, T.ANALYSTS_UP, false], ["POST", `/review/${REVIEW}/keep-pending`, T.ANALYSTS_UP, false],
    ["POST", `/review/${REVIEW}/remove`, T.ANALYSTS_UP, false], ["POST", `/review/${REVIEW}/retry`, T.ANALYSTS_UP, false],
    ["POST", `/review/${REVIEW}/replace-verified`, T.ANALYSTS_UP, false], ["POST", `/review/${REVIEW}/keep-as-version`, T.ANALYSTS_UP, false],
    ["POST", `/review/${REVIEW}/document-type`, T.ANALYSTS_UP, false], ["POST", `/review/${REVIEW}/assign-client`, T.ANALYSTS_UP, false],
    ["DELETE", `/temporary-documents/${NO_ID}`, T.ANALYSTS_UP, false], ["POST", `/documents/${NO_ID}/police-date`, T.MANAGERS_UP, false],
    ["GET", "/candidates", T.CANDIDATE_STAFF, true], ["POST", "/candidates", T.REGISTRATION_STAFF, false],
    ["GET", `/candidates/${P}`, T.CANDIDATE_STAFF, true], ["PUT", `/candidates/${P}`, T.CANDIDATE_STAFF, false],
    ["PUT", `/candidates/${P}/stages/IVS_INTERVIEW`, T.CANDIDATE_STAFF, false], ["POST", `/candidates/${P}/verification`, T.MANAGERS_UP, false],
    ["POST", `/candidates/${P}/documents/upload-target`, T.CANDIDATE_STAFF, false], ["POST", `/candidates/${P}/documents/finalize`, T.CANDIDATE_STAFF, false],
    ["POST", `/candidates/${P}/documents/${NO_ID}/remove`, T.CANDIDATE_STAFF, false], ["GET", `/candidates/${P}/call-logs`, T.CANDIDATE_STAFF, true],
    ["POST", `/candidates/${P}/call-logs`, T.CANDIDATE_STAFF, false], ["POST", `/candidates/${P}/call-logs/${NO_ID}/follow-up`, T.CANDIDATE_STAFF, false],
    ["GET", "/follow-ups", T.CANDIDATE_STAFF, false], ["POST", `/follow-ups/${NO_ID}/complete`, T.CANDIDATE_STAFF, false], ["DELETE", `/follow-ups/${NO_ID}`, T.MANAGERS_UP, false],
    ["GET", `/candidates/${P}/additional-details`, T.CANDIDATE_STAFF, true], ["PUT", `/candidates/${P}/additional-details`, T.CANDIDATE_STAFF, false],
    ["GET", `/candidates/${P}/form-submission`, T.CANDIDATE_STAFF, true], ["GET", `/candidates/${P}/form-share`, T.CANDIDATE_STAFF, false],
    ["POST", `/candidates/${P}/form-share`, T.CANDIDATE_STAFF, false], ["POST", `/candidates/${P}/form-share/revoke`, T.CANDIDATE_STAFF, false],
    ["GET", "/work-allocation/candidates?status=NOPE", T.MANAGERS_UP, false], ["GET", "/work-allocation/analysts", T.MANAGERS_UP, false],
    ["POST", "/work-allocation/assign", T.MANAGERS_UP, false], ["POST", "/work-allocation/auto-allocate", T.MANAGERS_UP, false],
    ["POST", "/work-allocation/allocate", T.MANAGERS_UP, false], ["POST", "/work-allocation/unassign", T.MANAGERS_UP, false],
    ["GET", "/job-options", T.MANAGERS_UP, true], ["GET", "/job-type-choices", T.CANDIDATE_STAFF, true], ["GET", "/job-types", T.ADMINS_ONLY, false],
    ["PATCH", `/job-types/${NO_ID}`, T.ADMINS_ONLY, false], ["POST", "/job-types", T.MANAGERS_UP, false],
    ["GET", "/jobs?view=nope", T.ALL_ACTIVE, true], ["POST", "/jobs", T.MANAGERS_UP, true], ["GET", `/jobs/${NO_ID}`, T.ALL_ACTIVE, true],
    ["PUT", `/jobs/${NO_ID}`, T.MANAGERS_UP, true], ["POST", `/jobs/${NO_ID}/candidates`, T.MANAGERS_UP, true],
    ["DELETE", `/jobs/${NO_ID}/candidates/${P}`, T.MANAGERS_UP, true], ["GET", `/jobs/${NO_ID}/form-share`, T.MANAGERS_UP, false],
    ["POST", `/jobs/${NO_ID}/form-share`, T.MANAGERS_UP, false], ["POST", `/jobs/${NO_ID}/form-share/revoke`, T.MANAGERS_UP, false],
    ["POST", `/jobs/${NO_ID}/complete`, T.MANAGERS_UP, true], ["POST", `/jobs/${NO_ID}/cancel`, T.MANAGERS_UP, true],
    ["GET", "/agents?status=NOPE", T.MANAGERS_UP, true], ["GET", "/agent-options", T.MANAGERS_UP, true], ["POST", "/agents", T.MANAGERS_UP, true],
    ["GET", `/agents/${NO_ID}`, T.MANAGERS_UP, true], ["PATCH", `/agents/${NO_ID}`, T.MANAGERS_UP, true], ["PATCH", `/agents/${NO_ID}/status`, T.MANAGERS_UP, true],
    ["GET", "/client-management?status=NOPE", T.MANAGERS_UP, true], ["GET", "/client-options", T.MANAGERS_UP, true], ["POST", "/client-management", T.MANAGERS_UP, true],
    ["GET", `/client-management/${NO_ID}`, T.MANAGERS_UP, true], ["PATCH", `/client-management/${NO_ID}`, T.MANAGERS_UP, true],
    ["PATCH", `/client-management/${NO_ID}/agent`, T.MANAGERS_UP, true], ["PATCH", `/client-management/${NO_ID}/status`, T.MANAGERS_UP, true],
    ["GET", "/audit-logs", T.ADMINS_ONLY, false], ["GET", "/settings/sheet-sync/status", T.ADMINS_ONLY, false],
    ["GET", "/users", T.ADMINS_ONLY, false], ["PUT", "/users/nobody/role", T.ADMINS_ONLY, false], ["POST", "/users/nobody/deactivate", T.ADMINS_ONLY, false],
];

describe("every route, every role (RBAC-REG-001 to 004, and the Job Handler column)", () => {
    const sweep = async (role, allowedFor) => {
        const wrong = [];
        for (const [method, path, tier, jobHandler] of ROUTES) {
            const allowed = allowedFor(tier, jobHandler);
            const body = ["POST", "PUT", "PATCH"].includes(method) ? {} : undefined;
            const { status } = await api(USERS[role], method, path, body);
            if (allowed ? status === 403 || status === 401 : status !== 403) wrong.push(`${method} ${path}: ${status} (expected ${allowed ? "allowed" : "403"})`);
        }
        assert.deepEqual(wrong, [], `${role}:\n${wrong.join("\n")}`);
    };
    for (const [id, role] of [["RBAC-REG-001", "ADMIN"], ["RBAC-REG-002", "MANAGER"], ["RBAC-REG-003", "ANALYST"], ["RBAC-REG-004", "REGISTRATION_DESK"]]) {
        test(`${id}: ${role} has exactly the access it had before`, () => sweep(role, (tier) => tier.includes(role)));
    }
    test("JOB_HANDLER: exactly Jobs, Agents, Clients and candidate reads", () => sweep("JOB_HANDLER", (tier, jobHandler) => jobHandler));
    test("invitations: ADMIN any role, MANAGER Job Handler only (the one MANAGER change), others none", async () => {
        const decide = async (who, role) => (await api(who, "POST", "/users/invite", { role })).status; // no name / email: an allowed request is a 400
        for (const role of ALL_ROLES) assert.equal(await decide(USERS.ADMIN, role), 400, `ADMIN -> ${role}`);
        for (const role of ALL_ROLES) assert.equal(await decide(USERS.MANAGER, role), role === "JOB_HANDLER" ? 400 : 403, `MANAGER -> ${role}`);
        for (const who of [USERS.ANALYST, USERS.REGISTRATION_DESK, JH]) assert.equal(await decide(who, "JOB_HANDLER"), 403, who.role);
        assert.equal(authAdmin.calls.length, 0);
    });
});
