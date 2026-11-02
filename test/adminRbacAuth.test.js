// Role-based authorization on the real admin router. The role is
// public."user".role, read on every request; the Supabase session only says
// who the caller is. Matrix (routes/admin.js tiers):
//   ALL_ACTIVE      ADMIN, ANALYST                              reads (overview, documents, reports, …)
//   CANDIDATE_STAFF ADMIN, TEAM_LEAD, ANALYST                   the Candidates area and Need Attention
//   CANDIDATE_READERS  … plus JOB_HANDLER                       candidate reads (list, page)
//   REGISTRATION_WORKFLOW  … plus REGISTRATION_DESK             the Add Candidate form's routes
//   ANALYSTS_UP     ADMIN, ANALYST                              review actions, corrections
//   ADMINS_ONLY     ADMIN                                       users, Audit Logs, Settings, Work Allocation,
//                                                               police-date correction (the former MANAGER tier)
// OWNER gets every route ADMIN gets (requireRole.js hasRole), and nothing more. The retired MANAGER
// role gets nothing: requireActiveUser refuses it (403 ROLE_NOT_SUPPORTED) before any role check.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createAdminRouter } from "../src/routes/admin.js";
import { ALL_ROLES, RETIRED_ROLES, ROLES, isValidRole, requireRole } from "../src/middleware/requireRole.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { createFakeReviewDb } from "./helpers/fakeReviewDb.js";
import { createFakeAuthAdmin, fakeVerifyAccessToken, tokenFor } from "./helpers/fakeSupabaseAuth.js";

const user = (role, status = "ACTIVE") => ({ adminId: `user-${role}-${status}`, name: role, email: `${role}-${status}@example.invalid`.toLowerCase(), role, status });
const USERS = [...ALL_ROLES.map((role) => user(role)), user("VIEWER"), user("MANAGER"), user("ADMIN", "INACTIVE"), user("ANALYST", "INVITED")];
const DOCUMENT_ID = "00000000-0000-4000-8000-000000000001";
// The Candidates area and Need Attention: not REGISTRATION_DESK (registration only), not JOB_HANDLER.
const CANDIDATE_STAFF = ["ADMIN", "TEAM_LEAD", "ANALYST"];
// JOB_HANDLER reads candidates (never writes them).
const CANDIDATE_READERS = [...CANDIDATE_STAFF, "JOB_HANDLER"];
// The routes the Add Candidate form uses (the lookup, saving details, registration documents).
const REGISTRATION_WORKFLOW = [...CANDIDATE_STAFF, "REGISTRATION_DESK"];

// OWNER holds every ADMIN permission, so a tier naming ADMIN admits OWNER too.
const admits = (allowed, role) => allowed.includes(role) || (role === "OWNER" && allowed.includes("ADMIN"));

// [method, path, body, roles allowed]
const MATRIX = [
    ["GET", "/overview", undefined, ["ADMIN", "ANALYST"]],
    ["GET", "/documents", undefined, ["ADMIN", "ANALYST"]],
    // The Daily Report: the dashboard roles plus TEAM_LEAD.
    ["GET", "/reports/daily", undefined, ["ADMIN", "TEAM_LEAD", "ANALYST"]],
    ["GET", "/candidates", undefined, CANDIDATE_READERS],
    // The job candidate picker: the job managers.
    ["GET", "/job-candidate-options", undefined, ["ADMIN", "TEAM_LEAD", "JOB_HANDLER"]],
    // Registering is not an Analyst action: a new candidate is unallocated (Work Allocation).
    ["POST", "/candidates", {}, ["ADMIN", "TEAM_LEAD", "REGISTRATION_DESK"]],
    // Work Allocation: ADMIN and TEAM_LEAD (an invalid request, so the allowed roles get 400).
    ["GET", "/work-allocation/candidates?status=NOPE", undefined, ["ADMIN", "TEAM_LEAD"]],
    ["POST", "/work-allocation/assign", {}, ["ADMIN", "TEAM_LEAD"]],
    ["POST", "/work-allocation/unassign", {}, ["ADMIN", "TEAM_LEAD"]],
    ["GET", "/candidates/N1023757", undefined, [...CANDIDATE_READERS, "REGISTRATION_DESK"]],
    ["PUT", "/candidates/N1023757", {}, REGISTRATION_WORKFLOW],
    // REGISTRATION_DESK: the Candidate Details stage (its note) only.
    ["PUT", "/candidates/N1023757/stages/IVS_INTERVIEW", {}, CANDIDATE_STAFF],
    ["POST", "/candidates/N1023757/documents/upload-target", {}, REGISTRATION_WORKFLOW],
    ["POST", "/candidates/N1023757/documents/finalize", {}, REGISTRATION_WORKFLOW],
    ["POST", `/candidates/N1023757/documents/${DOCUMENT_ID}/remove`, {}, CANDIDATE_STAFF],
    ["GET", "/candidates/N1023757/call-logs", undefined, CANDIDATE_READERS],
    ["POST", "/candidates/N1023757/call-logs", {}, CANDIDATE_STAFF],
    // Need Attention: REGISTRATION_DESK reads it (no flag, complete or delete).
    ["GET", "/follow-ups", undefined, [...CANDIDATE_STAFF, "REGISTRATION_DESK"]],
    ["POST", "/follow-ups/11111111-1111-4111-8111-111111111111/complete", {}, CANDIDATE_STAFF],
    ["DELETE", "/follow-ups/11111111-1111-4111-8111-111111111111", undefined, ["ADMIN"]],
    ["GET", "/candidates/N1023757/additional-details", undefined, CANDIDATE_READERS],
    ["PUT", "/candidates/N1023757/additional-details", {}, CANDIDATE_STAFF],
    ["GET", "/review", undefined, ["ADMIN", "ANALYST"]],
    ["POST", "/review/pending-11111111-1111-4111-8111-111111111111/keep-pending", {}, ["ADMIN", "ANALYST"]],
    ["POST", `/documents/${DOCUMENT_ID}/police-date`, {}, ["ADMIN"]],
    ["GET", "/users", undefined, ["ADMIN"]],
    ["POST", "/users/invite", {}, ["ADMIN"]],
    ["PUT", "/users/someone/role", { role: "ANALYST" }, ["ADMIN"]],
    ["POST", "/users/someone/deactivate", {}, ["ADMIN"]],
    ["GET", "/audit-logs", undefined, ["ADMIN"]],
    // Google Sheet Sync and Upload (the bulk import): ADMIN only, like every Settings tab.
    ["GET", "/settings/sheet-sync/status", undefined, ["ADMIN"]],
    ["POST", "/settings/sheet-sync/run", {}, ["ADMIN"]],
    ["GET", "/settings/sheet-sync/import/source-columns", undefined, ["ADMIN"]],
    ["POST", "/settings/sheet-sync/import/preview", {}, ["ADMIN"]],
];

let server;
let baseUrl;
let fixture;
let authAdmin;

before(async () => {
    fixture = createFakeReviewDb({ admins: USERS });
    authAdmin = createFakeAuthAdmin();
    const app = express();
    app.use(express.json());
    app.use("/api/admin", createAdminRouter({ db: fixture.client, bucket: {}, verifyAccessToken: fakeVerifyAccessToken, authAdmin, apiLimiter: (req, res, next) => next() }));
    app.use(errorHandler);
    await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

async function call(method, path, adminId, body) {
    const headers = { Accept: "application/json" };
    if (adminId) headers.Authorization = `Bearer ${tokenFor(adminId)}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${baseUrl}/api/admin${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
}

describe("role constants", () => {
    test("exactly the six application roles; the retired MANAGER and legacy VIEWER/REVIEWER are not roles", () => {
        assert.deepEqual(ALL_ROLES, ["OWNER", "ADMIN", "TEAM_LEAD", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]);
        assert.deepEqual(Object.values(ROLES), ALL_ROLES);
        assert.deepEqual(RETIRED_ROLES, { MANAGER: "MANAGER" });
        for (const legacy of ["MANAGER", "manager", "VIEWER", "REVIEWER", "admin", "owner", "SUPERADMIN", "", null]) assert.equal(isValidRole(legacy), false);
    });

    test("requireRole reads req.user only: no user -> 401, other role -> 403", () => {
        const middleware = requireRole([ROLES.ADMIN]);
        const run = (req) => {
            let status = null;
            let nextCalled = false;
            middleware(req, { status: (code) => { status = code; return { json: () => {} }; } }, () => { nextCalled = true; });
            return nextCalled ? "next" : status;
        };
        assert.equal(run({}), 401);
        assert.equal(run({ admin: { role: "ADMIN" } }), 401, "the legacy req.admin is never trusted");
        assert.equal(run({ user: { role: "MANAGER" } }), 403);
        assert.equal(run({ user: { role: "ADMIN" } }), "next");
        assert.equal(run({ user: { role: "OWNER" } }), "next", "OWNER passes an ADMIN tier");
        const analysts = requireRole([ROLES.ANALYST]);
        let status = null;
        analysts({ user: { role: "OWNER" } }, { status: (code) => { status = code; return { json: () => {} }; } }, () => { status = "next"; });
        assert.equal(status, 403, "OWNER only inherits ADMIN, not a tier without ADMIN");
    });
});

describe("role matrix (backend is the boundary)", () => {
    for (const role of ALL_ROLES) {
        test(`${role}`, async () => {
            for (const [method, path, body, allowed] of MATRIX) {
                const { status, body: response } = await call(method, path, `user-${role}-ACTIVE`, body);
                if (admits(allowed, role)) {
                    assert.notEqual(status, 403, `${role} ${method} ${path} should be allowed`);
                    assert.notEqual(status, 401, `${role} ${method} ${path}`);
                } else {
                    assert.equal(status, 403, `${role} ${method} ${path} should be refused`);
                    assert.deepEqual(response, { message: "Insufficient permissions" });
                }
            }
        });
    }

    test("an unknown role (legacy VIEWER) is refused everywhere", async () => {
        for (const [method, path, body] of MATRIX) assert.equal((await call(method, path, "user-VIEWER-ACTIVE", body)).status, 403, `${method} ${path}`);
    });

    test("an ACTIVE account still holding the retired MANAGER role is refused everywhere, the former MANAGER routes included", async () => {
        for (const [method, path, body] of MATRIX) {
            const result = await call(method, path, "user-MANAGER-ACTIVE", body);
            assert.deepEqual([result.status, result.body?.code], [403, "ROLE_NOT_SUPPORTED"], `${method} ${path}`);
        }
        assert.equal(authAdmin.calls.length, 0, "nothing sent to Supabase");
    });

    test("no session -> 401; INACTIVE or INVITED user -> 403 before any role check", async () => {
        for (const [method, path, body] of MATRIX) {
            assert.equal((await call(method, path, null, body)).status, 401, `${method} ${path}`);
            for (const id of ["user-ADMIN-INACTIVE", "user-ANALYST-INVITED"]) {
                const result = await call(method, path, id, body);
                assert.equal(result.status, 403, `${id} ${method} ${path}`);
                assert.equal(result.body.code, "ACCOUNT_NOT_ACTIVE");
            }
        }
    });

    test("a role change in the database applies to the very next request", async () => {
        const row = fixture.adminRows.find((r) => r.adminId === "user-REGISTRATION_DESK-ACTIVE");
        assert.equal((await call("GET", "/overview", row.adminId)).status, 403);
        row.role = "ANALYST";
        assert.equal((await call("GET", "/overview", row.adminId)).status, 200);
        row.role = "REGISTRATION_DESK";
        assert.equal((await call("GET", "/overview", row.adminId)).status, 403);
    });

    test("a role in the request body or query is ignored", async () => {
        assert.equal((await call("GET", "/audit-logs?role=ADMIN", "user-REGISTRATION_DESK-ACTIVE")).status, 403);
        assert.equal((await call("POST", "/candidates", "user-VIEWER-ACTIVE", { role: "REGISTRATION_DESK" })).status, 403);
        assert.equal((await call("GET", "/users?role=ADMIN", "user-ANALYST-ACTIVE")).status, 403);
        assert.equal((await call("POST", "/users/invite", "user-MANAGER-ACTIVE", { role: "ADMIN", actor: { role: "ADMIN" } })).status, 403);
        assert.equal(authAdmin.calls.length, 0, "no Supabase call for a refused request");
    });
});
