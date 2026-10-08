// Role-based authorization on the real admin router. The role is
// public."user".role, read on every request; the Supabase session only says
// who the caller is. Matrix (routes/admin.js tiers):
//   ALL_ACTIVE      ADMIN, MANAGER, ANALYST                     reads (overview, documents, reports, …)
//   REGISTRATION_UP ADMIN, MANAGER, ANALYST, REGISTRATION_DESK  candidate list/registration/details
//   ANALYSTS_UP     ADMIN, MANAGER, ANALYST                     review actions, corrections, uploads
//   MANAGERS_UP     ADMIN, MANAGER                              police-date correction
//   ADMINS_ONLY     ADMIN                                       users, Settings
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createAdminRouter } from "../src/routes/admin.js";
import { ALL_ROLES, ROLES, isValidRole, requireRole } from "../src/middleware/requireRole.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { createFakeReviewDb } from "./helpers/fakeReviewDb.js";
import { createFakeAuthAdmin, fakeVerifyAccessToken, tokenFor } from "./helpers/fakeSupabaseAuth.js";

const user = (role, status = "ACTIVE") => ({ adminId: `user-${role}-${status}`, name: role, email: `${role}-${status}@example.invalid`.toLowerCase(), role, status });
const USERS = [...ALL_ROLES.map((role) => user(role)), user("VIEWER"), user("ADMIN", "INACTIVE"), user("ANALYST", "INVITED")];
const DOCUMENT_ID = "00000000-0000-4000-8000-000000000001";

// [method, path, body, roles allowed]
const MATRIX = [
    ["GET", "/overview", undefined, ["ADMIN", "MANAGER", "ANALYST"]],
    ["GET", "/documents", undefined, ["ADMIN", "MANAGER", "ANALYST"]],
    ["GET", "/reports/daily", undefined, ["ADMIN", "MANAGER", "ANALYST"]],
    ["GET", "/candidates", undefined, ["ADMIN", "MANAGER", "ANALYST", "REGISTRATION_DESK"]],
    ["POST", "/review/pending-11111111-1111-4111-8111-111111111111/keep-pending", {}, ["ADMIN", "MANAGER", "ANALYST"]],
    ["POST", `/documents/${DOCUMENT_ID}/police-date`, {}, ["ADMIN", "MANAGER"]],
    ["GET", "/users", undefined, ["ADMIN"]],
    ["POST", "/users/invite", {}, ["ADMIN"]],
    ["PUT", "/users/someone/role", { role: "ANALYST" }, ["ADMIN"]],
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
    test("exactly the four application roles; legacy VIEWER/REVIEWER are not roles", () => {
        assert.deepEqual(ALL_ROLES, ["ADMIN", "MANAGER", "ANALYST", "REGISTRATION_DESK"]);
        assert.deepEqual(Object.values(ROLES), ALL_ROLES);
        for (const legacy of ["VIEWER", "REVIEWER", "admin", "", null]) assert.equal(isValidRole(legacy), false);
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
    });
});

describe("role matrix (backend is the boundary)", () => {
    for (const role of ALL_ROLES) {
        test(`${role}`, async () => {
            for (const [method, path, body, allowed] of MATRIX) {
                const { status, body: response } = await call(method, path, `user-${role}-ACTIVE`, body);
                if (allowed.includes(role)) {
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
        assert.equal((await call("GET", "/users?role=ADMIN", "user-ANALYST-ACTIVE")).status, 403);
        assert.equal((await call("POST", "/users/invite", "user-MANAGER-ACTIVE", { role: "ADMIN", actor: { role: "ADMIN" } })).status, 403);
        assert.equal(authAdmin.calls.length, 0, "no Supabase call for a refused request");
    });
});
