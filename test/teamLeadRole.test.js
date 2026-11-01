// The TEAM_LEAD role: exactly seven areas, nothing inferred from them. The Candidates area for
// EVERY candidate, Need Attention (list, flag, complete), Work Allocation, Jobs, Agents, Clients and
// the standard Daily Report. Every ADMIN-only action inside those areas stays ADMIN only
// (verification, Candidate Form confirm / reject, follow-up delete, the job-group form link, Summary
// by Roles, Job Types), and there are no Settings, user management, Audit Logs, dashboards, review or
// police-date corrections. OWNER and ADMIN
// may give the role; TEAM_LEAD manages no account. Plus a route-by-route sweep of the TEAM_LEAD
// column, and regressions for the Analyst scope and the retired MANAGER. On a REAL PostgreSQL
// (PGlite, every migration applied) through the real Prisma client, the real services and the real
// admin router; the Supabase Auth admin is the test fake (no Supabase).
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createFakeAuthAdmin } from "./helpers/fakeSupabaseAuth.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { ALL_ROLES, ASSIGNABLE_ROLES, ROLES, USER_MANAGER_ROLES, canAssignRole, canManageAccount, hasRole, isValidRole } from "../src/middleware/requireRole.js";
import { candidateScope, isCandidateScoped } from "../src/services/candidateAccess.js";

const user = (role, n) => ({ adminId: `u-${role.toLowerCase()}`, role, name: `${role} user`, email: `${role.toLowerCase()}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, status: "ACTIVE" });
// MANAGER: an account still holding the retired role (never a valid role, in no tier).
const USERS = { ...Object.fromEntries(ALL_ROLES.map((role, n) => [role, user(role, n + 1)])), MANAGER: user("MANAGER", 50) };
const TL = USERS.TEAM_LEAD;
const ALLOCATED = "TL0000001";   // allocated to the ANALYST
const FREE = "TL0000002";        // unallocated
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
        DELETE FROM "call_log_follow_up"; DELETE FROM "candidate_call_logs"; DELETE FROM "candidate_allocation";
        DELETE FROM "candidate_stages"; DELETE FROM "candidate";
        DELETE FROM "user" WHERE "admin_id" NOT IN (${Object.values(USERS).map((u) => `'${u.adminId}'`).join(",")});
    `);
    for (const u of Object.values(USERS)) await prisma.user.update({ where: { adminId: u.adminId }, data: { status: "ACTIVE", role: u.role } });
    authAdmin.calls.length = 0;
    for (const [passportId, uniqueId, nic] of [[ALLOCATED, "9101", "199012345678"], [FREE, "9102", "199012345679"]]) {
        await prisma.candidate.create({ data: { passportId, uniqueId, firstName: "Nimal", otherName: "Perera", nic } });
        await prisma.candidateStage.create({ data: { passportId, stage: "TEST_DETAILS", testResult: "PASS" } });
    }
    await prisma.candidateAllocation.create({ data: { passportId: ALLOCATED, analystId: USERS.ANALYST.adminId } });
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
const notForbidden = (response, label) => assert.ok(![401, 403].includes(response.status), `${label}: ${response.status} ${JSON.stringify(response.body)}`);

describe("the role", () => {
    test("TEAM_LEAD is a valid role, stored as plain text, between ADMIN and the operational roles", async () => {
        assert.equal(ROLES.TEAM_LEAD, "TEAM_LEAD");
        assert.ok(isValidRole("TEAM_LEAD"));
        assert.deepEqual(ALL_ROLES, ["OWNER", "ADMIN", "TEAM_LEAD", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]);
        assert.equal((await prisma.user.findUnique({ where: { adminId: TL.adminId } })).role, "TEAM_LEAD");
        for (const role of ["team_lead", "TEAMLEAD", "MANAGER", ""]) assert.equal(isValidRole(role), false, role);
    });

    test("it inherits nothing: a tier admits TEAM_LEAD only where it names it", () => {
        assert.equal(hasRole("TEAM_LEAD", ["ADMIN"]), false);
        assert.equal(hasRole("TEAM_LEAD", ["ADMIN", "TEAM_LEAD"]), true);
        assert.equal(hasRole("OWNER", ["ADMIN"]), true, "OWNER still inherits ADMIN");
    });

    test("it sees every candidate (not the Analyst scope)", () => {
        assert.equal(isCandidateScoped(TL), false);
        assert.deepEqual(candidateScope(TL), {});
        assert.equal(isCandidateScoped(USERS.ANALYST), true, "the Analyst scope is unchanged");
    });
});

describe("role assignment", () => {
    const invite = (who, body) => api(who, "POST", "/users/invite", { name: "New Lead", email: "new.lead@example.invalid", ...body });

    test("OWNER gives ADMIN and TEAM_LEAD and below; ADMIN gives TEAM_LEAD and below; TEAM_LEAD gives nothing", () => {
        assert.deepEqual(ASSIGNABLE_ROLES.OWNER, ["ADMIN", "TEAM_LEAD", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]);
        assert.deepEqual(ASSIGNABLE_ROLES.ADMIN, ["TEAM_LEAD", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]);
        assert.deepEqual(USER_MANAGER_ROLES, ["OWNER", "ADMIN"]);
        for (const role of ALL_ROLES) assert.equal(canAssignRole("TEAM_LEAD", role), false, `TEAM_LEAD gives ${role}`);
        for (const role of ALL_ROLES) assert.equal(canManageAccount("TEAM_LEAD", role), false, `TEAM_LEAD manages ${role}`);
        assert.equal(canManageAccount("ADMIN", "TEAM_LEAD"), true);
        assert.equal(canManageAccount("OWNER", "TEAM_LEAD"), true);
        for (const role of ["OWNER", "ADMIN"]) assert.equal(canAssignRole("ADMIN", role), false, `ADMIN gives ${role}`);
    });

    test("ADMIN and OWNER invite a Team Lead; ADMIN changes a role to and from TEAM_LEAD (audited)", async () => {
        assert.equal(ok(await invite(USERS.ADMIN, { role: "TEAM_LEAD" }), 201).user.role, "TEAM_LEAD");
        assert.equal(ok(await invite(USERS.OWNER, { role: "team_lead", email: "owner.lead@example.invalid" }), 201).user.role, "TEAM_LEAD");
        const target = await prisma.user.create({ data: { ...user("ANALYST", 99), adminId: "u-target", email: "target@example.invalid" } });
        assert.equal(ok(await api(USERS.ADMIN, "PUT", `/users/${target.adminId}/role`, { role: "TEAM_LEAD" })).user.role, "TEAM_LEAD");
        assert.equal(ok(await api(USERS.ADMIN, "PUT", `/users/${target.adminId}/role`, { role: "ANALYST" })).user.role, "ANALYST");
        assert.ok(await prisma.auditLog.findFirst({ where: { action: "UPDATE_USER_ROLE", newValue: "TEAM_LEAD", adminId: USERS.ADMIN.adminId } }));
    });

    test("ADMIN still cannot give OWNER or ADMIN, nor touch an OWNER account", async () => {
        const target = await prisma.user.create({ data: { ...user("TEAM_LEAD", 98), adminId: "u-lead-2", email: "lead2@example.invalid" } });
        for (const role of ["OWNER", "ADMIN"]) forbidden(await api(USERS.ADMIN, "PUT", `/users/${target.adminId}/role`, { role }), `ADMIN -> ${role}`);
        forbidden(await api(USERS.ADMIN, "PUT", `/users/${USERS.OWNER.adminId}/role`, { role: "TEAM_LEAD" }), "ADMIN changes the OWNER");
        assert.equal((await prisma.user.findUnique({ where: { adminId: target.adminId } })).role, "TEAM_LEAD");
    });

    test("TEAM_LEAD cannot list, invite, change, promote or deactivate users (nothing sent or changed)", async () => {
        for (const role of ["OWNER", "ADMIN", "TEAM_LEAD", "ANALYST"]) forbidden(await invite(TL, { role }), `TEAM_LEAD invites ${role}`);
        forbidden(await api(TL, "GET", "/users"), "list users");
        for (const role of ["OWNER", "ADMIN", "TEAM_LEAD", "JOB_HANDLER"]) forbidden(await api(TL, "PUT", `/users/${USERS.ANALYST.adminId}/role`, { role }), `role -> ${role}`);
        forbidden(await api(TL, "PUT", `/users/${TL.adminId}/role`, { role: "ADMIN" }), "promote self");
        for (const who of [USERS.OWNER, USERS.ADMIN, USERS.ANALYST]) forbidden(await api(TL, "POST", `/users/${who.adminId}/deactivate`, {}), `deactivate ${who.role}`);
        assert.equal(authAdmin.calls.length, 0);
        assert.deepEqual((await prisma.user.findMany({ where: { adminId: { in: Object.values(USERS).map((u) => u.adminId) } }, orderBy: { adminId: "asc" } })).map((u) => [u.role, u.status]),
            Object.values(USERS).sort((a, b) => a.adminId.localeCompare(b.adminId)).map((u) => [u.role, "ACTIVE"]));
    });
});

describe("Candidates: full operational access to every candidate", () => {
    test("lists and opens every candidate, the allocated one and the unallocated one", async () => {
        assert.deepEqual(ok(await api(TL, "GET", "/candidates")).items.map((c) => c.passportId).sort(), [ALLOCATED, FREE]);
        for (const pid of [ALLOCATED, FREE]) {
            assert.equal(ok(await api(TL, "GET", `/candidates/${pid}`)).candidate.passportId, pid);
            for (const path of ["call-logs", "additional-details", "form-submission", "form-share"]) ok(await api(TL, "GET", `/candidates/${pid}/${path}`));
        }
        // Regression: the Analyst still sees only the allocated candidate.
        assert.deepEqual(ok(await api(USERS.ANALYST, "GET", "/candidates")).items.map((c) => c.passportId), [ALLOCATED]);
        assert.equal((await api(USERS.ANALYST, "GET", `/candidates/${FREE}`)).status, 404);
    });

    test("edits stages and records calls on an unallocated candidate (audited as the Team Lead)", async () => {
        ok(await api(TL, "PUT", `/candidates/${FREE}/stages/IVS_INTERVIEW`, { completed: true }));
        assert.equal((await prisma.candidateStage.findUnique({ where: { passportId_stage: { passportId: FREE, stage: "IVS_INTERVIEW" } } })).completed, true);
        ok(await api(TL, "POST", `/candidates/${FREE}/call-logs`, { note: "Called about the test" }), 201);
        assert.ok(await prisma.auditLog.findFirst({ where: { adminId: TL.adminId, passportId: FREE } }));
    });

    test("registration and document upload are open to the Team Lead (validation, not 403)", async () => {
        notForbidden(await api(TL, "POST", "/candidates", {}), "register");
        notForbidden(await api(TL, "POST", `/candidates/${FREE}/documents/upload-target`, {}), "upload target");
        notForbidden(await api(TL, "POST", `/candidates/${FREE}/form-share`, {}), "share the candidate's form link");
    });

    test("verification and Candidate Form confirm / reject stay ADMIN only (nothing changes)", async () => {
        forbidden(await api(TL, "POST", `/candidates/${FREE}/verification`, { kind: "DETAILS", verified: true }), "verification");
        for (const action of ["confirm-field", "reject-field"]) forbidden(await api(TL, "POST", `/candidates/${FREE}/form-submission/${action}`, {}), action);
        assert.equal(await prisma.candidateVerification.count(), 0);
        notForbidden(await api(USERS.ADMIN, "POST", `/candidates/${FREE}/verification`, { kind: "DETAILS", verified: true }), "ADMIN still verifies");
    });
});

describe("Need Attention", () => {
    test("lists, flags and completes follow-ups for any candidate; deleting one stays ADMIN only", async () => {
        const call = ok(await api(USERS.ANALYST, "POST", `/candidates/${ALLOCATED}/call-logs`, { note: "Needs a call back", needsAttention: true }), 201);
        const list = ok(await api(TL, "GET", "/follow-ups"));
        assert.equal(JSON.stringify(list).includes(ALLOCATED), true, "the Analyst's follow-up is on the Team Lead's Need Attention page");
        const followUp = await prisma.callLogFollowUp.findFirst({ where: { callLogId: call.callLog?.callLogId ?? call.callLogId ?? undefined } }) ?? await prisma.callLogFollowUp.findFirst();
        ok(await api(TL, "POST", `/follow-ups/${followUp.followUpId}/complete`, {}));
        forbidden(await api(TL, "DELETE", `/follow-ups/${followUp.followUpId}`), "delete a follow-up");
        assert.equal(await prisma.callLogFollowUp.count(), 1, "the Team Lead deleted nothing");
        ok(await api(USERS.ADMIN, "DELETE", `/follow-ups/${followUp.followUpId}`));
        assert.equal(await prisma.callLogFollowUp.count(), 0);
        assert.equal(await prisma.candidateCallLog.count(), 1, "the call log stays");
    });
});

describe("Work Allocation", () => {
    test("views the queue and the Analysts, allocates, reallocates and unassigns (audited as the Team Lead)", async () => {
        ok(await api(TL, "GET", "/work-allocation/candidates"));
        assert.deepEqual(ok(await api(TL, "GET", "/work-allocation/analysts")).analysts.map((a) => a.analystId), [USERS.ANALYST.adminId]);
        ok(await api(TL, "POST", "/work-allocation/assign", { candidateIds: [FREE], allocations: [{ analystId: USERS.ANALYST.adminId, count: 1 }] }));
        assert.equal((await prisma.candidateAllocation.findUnique({ where: { passportId: FREE } })).analystId, USERS.ANALYST.adminId);
        ok(await api(TL, "POST", "/work-allocation/unassign", { candidateIds: [FREE, ALLOCATED], confirm: true }));
        assert.equal(await prisma.candidateAllocation.count(), 0);
        ok(await api(TL, "POST", "/work-allocation/assign", { candidateIds: [FREE, ALLOCATED], allocations: [{ analystId: USERS.ANALYST.adminId, count: 2 }] }));
        assert.equal(await prisma.candidateAllocation.count(), 2);
        assert.ok(await prisma.auditLog.findFirst({ where: { adminId: TL.adminId } }), "audited as the Team Lead");
    });

    test("never allocates work to an OWNER, ADMIN or another Team Lead (only Analysts)", async () => {
        for (const who of [USERS.OWNER, USERS.ADMIN, TL]) {
            const refused = await api(TL, "POST", "/work-allocation/assign", { candidateIds: [FREE], allocations: [{ analystId: who.adminId, count: 1 }] });
            assert.ok(refused.status >= 400 && refused.status < 500 && refused.status !== 403, `allocate to ${who.role}: ${refused.status}`);
        }
        assert.equal(await prisma.candidateAllocation.count({ where: { passportId: FREE } }), 0);
    });
});

describe("Jobs, Agents and Clients", () => {
    test("lists, creates and manages jobs and assigns candidates; the job-group form link stays ADMIN only", async () => {
        const job = ok(await api(TL, "POST", "/jobs", { jobTypeId: ids.jobType, clientId: ids.client, vacancies: 2, candidateIds: [FREE] }), 201);
        assert.ok(ok(await api(TL, "GET", "/jobs")).items.some((j) => j.jobId === job.jobId));
        assert.equal(ok(await api(TL, "GET", `/jobs/${job.jobId}`)).jobCode, job.jobCode);
        assert.equal(ok(await api(TL, "POST", `/jobs/${job.jobId}/candidates`, { passportId: ALLOCATED }), 201).candidateCount, 2);
        ok(await api(TL, "DELETE", `/jobs/${job.jobId}/candidates/${ALLOCATED}`));
        for (const [method, path] of [["GET", "form-share"], ["POST", "form-share"], ["POST", "form-share/revoke"]]) forbidden(await api(TL, method, `/jobs/${job.jobId}/${path}`, method === "POST" ? {} : undefined), `job-group ${path}`);
        ok(await api(TL, "GET", "/job-options"));
        ok(await api(TL, "GET", "/job-type-choices"));
    });

    test("not Job Types (Settings): those stay ADMIN only", async () => {
        forbidden(await api(TL, "GET", "/job-types"), "Settings > Job Types");
        forbidden(await api(TL, "POST", "/job-types", { name: "Cook" }), "create job type");
        forbidden(await api(TL, "PATCH", `/job-types/${ids.jobType}`, { isActive: false }), "edit job type");
    });

    test("manages Agents and Clients", async () => {
        const agent = ok(await api(TL, "POST", "/agents", { name: "Hans Weber", countryCode: "DE", clientIds: [ids.client] }), 201);
        ok(await api(TL, "GET", `/agents/${agent.agentId}`));
        ok(await api(TL, "PATCH", `/agents/${agent.agentId}/status`, { status: "INACTIVE" }));
        const client = ok(await api(TL, "POST", "/client-management", { name: "Berlin Bau", agentIds: [ids.agent] }), 201);
        ok(await api(TL, "GET", `/client-management/${client.clientId}`));
        ok(await api(TL, "GET", "/agents"));
        ok(await api(TL, "GET", "/client-management"));
    });
});

describe("Daily Report", () => {
    test("opens the daily report, the summary and the incomplete lists", async () => {
        ok(await api(TL, "GET", "/reports/daily"));
        ok(await api(TL, "GET", "/reports/daily/summary"));
        notForbidden(await api(TL, "GET", "/reports/daily/incomplete?stage=TEST_DETAILS"), "incomplete");
    });

    test("Summary by Roles stays ADMIN only (for every role); ADMIN still sees every role", async () => {
        for (const role of ALL_ROLES) forbidden(await api(TL, "GET", `/reports/daily/roles?role=${role}`), `Team Lead -> ${role} staff`);
        for (const role of ALL_ROLES) ok(await api(USERS.ADMIN, "GET", `/reports/daily/roles?role=${role}`));
        forbidden(await api(USERS.ANALYST, "GET", "/reports/daily/roles?role=ANALYST"), "Analyst (unchanged)");
    });
});

describe("forbidden areas (backend enforced)", () => {
    test("no Settings, Sheet Sync, import, Audit Logs, dashboards, review, police or monthly report", async () => {
        for (const [method, path, body] of [
            ["GET", "/settings/sheet-sync/status"], ["POST", "/settings/sheet-sync/run", {}], ["POST", "/settings/sheet-sync/test", {}],
            ["POST", "/settings/sheet-sync/import/preview", {}], ["GET", "/audit-logs"],
            ["GET", "/overview"], ["GET", "/documents"], ["GET", "/documents/missing"], ["GET", "/clients"], ["GET", `/clients/${FREE}`],
            ["GET", "/review"], ["POST", "/review/pending-x/approve", {}], ["GET", "/police"], ["GET", "/reports/monthly"],
            ["POST", `/documents/${NO_ID}/police-date`, {}], ["DELETE", `/temporary-documents/${NO_ID}`],
        ]) forbidden(await api(TL, method, path, body), `${method} ${path}`);
    });
});

// The TEAM_LEAD column of every /api/admin route (routes/admin.js tiers). P: no such candidate,
// so an allowed request gets 404 / 400, never 403.
const P = "ZZ0000009";
const REVIEW = "pending-11111111-1111-4111-8111-111111111111";
const TEAM_LEAD_ROUTES = [
    // [method, path, TEAM_LEAD allowed?]
    ["GET", "/overview", false], ["GET", "/documents/missing", false], ["GET", "/documents", false], ["GET", "/clients", false],
    ["GET", "/reports/daily", true], ["GET", "/reports/daily/summary", true], ["GET", "/reports/daily/incomplete", true],
    ["GET", "/reports/daily/roles?role=ANALYST", false], ["GET", "/reports/daily/roles?role=ADMIN", false], ["GET", "/reports/monthly", false],
    ["GET", `/clients/${P}`, false], ["GET", "/review", false], ["GET", "/police", false],
    ["GET", `/review/${REVIEW}`, false], ["GET", `/review/${REVIEW}/file`, false],
    ["POST", `/review/${REVIEW}/approve`, false], ["POST", `/review/${REVIEW}/keep-pending`, false], ["POST", `/review/${REVIEW}/remove`, false],
    ["POST", `/review/${REVIEW}/retry`, false], ["POST", `/review/${REVIEW}/replace-verified`, false], ["POST", `/review/${REVIEW}/keep-as-version`, false],
    ["POST", `/review/${REVIEW}/document-type`, false], ["POST", `/review/${REVIEW}/assign-client`, false],
    ["DELETE", `/temporary-documents/${NO_ID}`, false], ["POST", `/documents/${NO_ID}/police-date`, false],
    ["GET", "/candidates", true], ["POST", "/candidates", true], ["GET", `/candidates/${P}`, true], ["PUT", `/candidates/${P}`, true],
    ["PUT", `/candidates/${P}/stages/IVS_INTERVIEW`, true], ["POST", `/candidates/${P}/verification`, false],
    ["POST", `/candidates/${P}/documents/upload-target`, true], ["POST", `/candidates/${P}/documents/finalize`, true],
    ["POST", `/candidates/${P}/documents/${NO_ID}/remove`, true], ["GET", `/candidates/${P}/call-logs`, true],
    ["POST", `/candidates/${P}/call-logs`, true], ["POST", `/candidates/${P}/call-logs/${NO_ID}/follow-up`, true],
    ["GET", "/follow-ups", true], ["POST", `/follow-ups/${NO_ID}/complete`, true], ["DELETE", `/follow-ups/${NO_ID}`, false],
    ["GET", `/candidates/${P}/additional-details`, true], ["PUT", `/candidates/${P}/additional-details`, true],
    ["GET", `/candidates/${P}/form-submission`, true], ["POST", `/candidates/${P}/form-submission/confirm-field`, false],
    ["POST", `/candidates/${P}/form-submission/reject-field`, false], ["GET", `/candidates/${P}/form-share`, true],
    ["POST", `/candidates/${P}/form-share`, true], ["POST", `/candidates/${P}/form-share/revoke`, true],
    ["GET", "/work-allocation/candidates?status=NOPE", true], ["GET", "/work-allocation/analysts", true],
    ["POST", "/work-allocation/assign", true], ["POST", "/work-allocation/auto-allocate", true],
    ["POST", "/work-allocation/allocate", true], ["POST", "/work-allocation/unassign", true],
    ["GET", "/job-options", true], ["GET", "/job-type-choices", true], ["GET", "/job-types", false],
    ["PATCH", `/job-types/${NO_ID}`, false], ["POST", "/job-types", false],
    ["GET", "/jobs?view=nope", true], ["POST", "/jobs", true], ["GET", `/jobs/${NO_ID}`, true], ["PUT", `/jobs/${NO_ID}`, true],
    ["POST", `/jobs/${NO_ID}/candidates`, true], ["DELETE", `/jobs/${NO_ID}/candidates/${P}`, true],
    ["GET", `/jobs/${NO_ID}/form-share`, false], ["POST", `/jobs/${NO_ID}/form-share`, false], ["POST", `/jobs/${NO_ID}/form-share/revoke`, false],
    ["POST", `/jobs/${NO_ID}/complete`, true], ["POST", `/jobs/${NO_ID}/cancel`, true],
    ["GET", "/agents?status=NOPE", true], ["GET", "/agent-options", true], ["POST", "/agents", true],
    ["GET", `/agents/${NO_ID}`, true], ["PATCH", `/agents/${NO_ID}`, true], ["PATCH", `/agents/${NO_ID}/status`, true],
    ["GET", "/client-management?status=NOPE", true], ["GET", "/client-options", true], ["POST", "/client-management", true],
    ["GET", `/client-management/${NO_ID}`, true], ["PATCH", `/client-management/${NO_ID}`, true],
    ["PATCH", `/client-management/${NO_ID}/agent`, true], ["PATCH", `/client-management/${NO_ID}/status`, true],
    ["GET", "/audit-logs", false], ["GET", "/settings/sheet-sync/status", false],
    ["POST", "/settings/sheet-sync/run", false], ["POST", "/settings/sheet-sync/import/preview", false],
    ["GET", "/users", false], ["POST", "/users/invite", false], ["PUT", "/users/nobody/role", false], ["POST", "/users/nobody/deactivate", false],
];

describe("every route, the TEAM_LEAD column", () => {
    test("TEAM_LEAD has exactly its operational access, and 403 everywhere else", async () => {
        const wrong = [];
        for (const [method, path, allowed] of TEAM_LEAD_ROUTES) {
            const body = ["POST", "PUT", "PATCH"].includes(method) ? {} : undefined;
            const { status } = await api(TL, method, path, body);
            if (allowed ? status === 403 || status === 401 : status !== 403) wrong.push(`${method} ${path}: ${status} (expected ${allowed ? "allowed" : "403"})`);
        }
        assert.deepEqual(wrong, [], `TEAM_LEAD:\n${wrong.join("\n")}`);
    });

    test("a retired MANAGER account still gets 403 on every route, TEAM_LEAD's included", async () => {
        const wrong = [];
        for (const [method, path] of TEAM_LEAD_ROUTES) {
            const body = ["POST", "PUT", "PATCH"].includes(method) ? {} : undefined;
            const { status } = await api(USERS.MANAGER, method, path, body);
            if (status !== 403) wrong.push(`${method} ${path}: ${status}`);
        }
        assert.deepEqual(wrong, []);
        assert.equal(isValidRole("MANAGER"), false);
    });
});
