// RBAC audit: what each role can reach through /api/admin, with a focus on
// REGISTRATION_DESK, through the real invitation -> setup -> login flow and
// the real routers (auth + admin). In-memory fakes only.
//
// The expected role set per route is read from src/routes/admin.js (the
// ALL_ACTIVE / REGISTRATION_UP / ANALYSTS_UP / MANAGERS_UP / ADMINS_ONLY
// tiers); a route that is allowed for a role is checked only to get past the
// gate (not 401/403); a refused one must answer exactly 403.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";

import { createAuthRouter, ACTIVE_ADMIN_STATUS } from "../src/routes/auth.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createRequireActiveAdmin } from "../src/middleware/requireActiveAdmin.js";
import { JWT_ALGORITHM } from "../src/middleware/auth.js";
import { ADMIN_ROLES, ALL_ROLES } from "../src/middleware/requireRole.js";
import { hashPassword } from "../src/utils/password.js";
import { createFakeAdminDb, noRateLimit } from "./helpers/fakeAdminDb.js";
import { clearSentEmails, getLastSentEmail } from "../src/services/emailService.js";
import { issueRegistrationUploadGrant } from "../src/services/registrationUploadGrant.js";

process.env.JWT_SECRET = "test-jwt-secret-placeholder-for-registration-desk-0123456789";
const PASSWORD = "Registration-Desk-Password-1";
const { ADMIN, MANAGER, ANALYST, REGISTRATION_DESK } = ADMIN_ROLES;

const PASSPORT_ID = "N1234567";
const UUID = "3f2b8c1e-0000-4000-8000-000000000001";

let server;
let baseUrl;
let db;
const tokens = {};

const sign = (adminId, role, secret = process.env.JWT_SECRET) =>
    jwt.sign({ adminId, email: `${adminId}@example.invalid`, role }, secret, { algorithm: JWT_ALGORITHM, expiresIn: "1h" });

async function call(method, path, token, body, headers = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...headers,
        },
        body: body === undefined || method === "GET" ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, body: json };
}

// Minimal candidate table so the candidate routes can complete.
function candidateTable() {
    const users = [{ passportId: PASSPORT_ID, uniqueId: "0001", firstName: "Kamal", otherName: "Perera", createdDate: new Date(), stages: [], documents: [] }];
    return {
        users,
        model: {
            findMany: async () => users,
            count: async () => users.length,
            findUnique: async ({ where }) => users.find((u) => u.passportId === where.passportId) ?? null,
            findFirst: async ({ where }) => users.find((u) => u.passportId === where?.passportId) ?? null,
        },
    };
}

before(async () => {
    const passwordHash = await hashPassword(PASSWORD);
    const mk = (adminId, role, status = ACTIVE_ADMIN_STATUS) => ({ adminId, name: adminId, email: `${adminId}@example.invalid`, passwordHash, role, status });
    db = createFakeAdminDb([
        mk("admin-1", ADMIN), mk("manager-1", MANAGER), mk("analyst-1", ANALYST), mk("desk-1", REGISTRATION_DESK), mk("desk-2", REGISTRATION_DESK),
    ]);
    // Candidate, review and report handlers use models the fake lacks: any
    // other model answers null, so those handlers end in a 4xx/5xx that is
    // still past the role gate.
    const candidates = candidateTable();
    const client = new Proxy(db, {
        get(target, prop) {
            if (prop in target) return target[prop];
            if (prop === "user") return candidates.model;
            if (prop === "then") return undefined;
            return new Proxy({}, { get: () => async () => null });
        },
    });
    for (const [key, [id, role]] of Object.entries({ admin: ["admin-1", ADMIN], manager: ["manager-1", MANAGER], analyst: ["analyst-1", ANALYST], desk: ["desk-1", REGISTRATION_DESK] })) {
        tokens[key] = sign(id, role);
    }

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/auth", createAuthRouter({ db: client, loginLimiter: noRateLimit, resetLimiter: noRateLimit, apiLimiter: noRateLimit }));
    app.use("/api/admin", createAdminRouter({
        db: client,
        bucket: { createSignedUploadUrl: async () => ({ data: null, error: new Error("fake") }) },
        requireAdmin: createRequireActiveAdmin({ db: client }),
        apiLimiter: noRateLimit,
    }));
    app.use((error, req, res, next) => res.status(500).json({ message: "fake db" }));

    await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

// ---------------------------------------------------------------- 1. roles

describe("roles", () => {
    test("the code defines exactly these roles", () => {
        assert.deepEqual([...ALL_ROLES], ["ADMIN", "MANAGER", "ANALYST", "REGISTRATION_DESK"]);
    });
});

// ---------------------------------------------------------------- 2. invitation -> login

describe("REGISTRATION_DESK through invitation, setup, login and /auth/me", () => {
    test("the invited role is stored, kept through setup and login, and returned by /auth/me", async () => {
        clearSentEmails();
        const invite = await call("POST", "/api/admin/invitations", tokens.admin, { name: "Front Desk", email: "frontdesk@example.invalid", role: "REGISTRATION_DESK" });
        assert.equal(invite.status, 201);
        assert.equal(invite.body.invitation.role, "REGISTRATION_DESK");
        assert.equal(db.invitationRows.find((r) => r.email === "frontdesk@example.invalid").role, "REGISTRATION_DESK");

        const rawToken = new URL(getLastSentEmail().setupUrl).searchParams.get("token");
        assert.equal((await call("GET", `/auth/invitation?token=${rawToken}`)).body.invitation.role, "REGISTRATION_DESK");

        // setup-password: any role the request body carries is ignored.
        const setup = await call("POST", "/auth/setup-password", undefined, { token: rawToken, password: PASSWORD, role: "ADMIN", status: "ACTIVE", adminId: "admin-1" });
        assert.equal(setup.status, 200);
        const created = db.rows.find((a) => a.email === "frontdesk@example.invalid");
        assert.equal(created.role, "REGISTRATION_DESK");
        assert.equal(created.status, ACTIVE_ADMIN_STATUS);
        assert.notEqual(created.adminId, "admin-1");

        const login = await call("POST", "/auth/login", undefined, { email: "frontdesk@example.invalid", password: PASSWORD, role: "ADMIN" });
        assert.equal(login.status, 200);
        assert.equal(jwt.decode(login.body.token).role, "REGISTRATION_DESK");

        const me = await call("GET", "/auth/me", login.body.token);
        assert.equal(me.status, 200);
        assert.equal(me.body.admin.role, "REGISTRATION_DESK");
        tokens.invitedDesk = login.body.token;
    });

    test("an invitation role outside the defined roles is refused", async () => {
        for (const role of ["SUPER_ADMIN", "OWNER", "ROOT", "", undefined]) {
            const res = await call("POST", "/api/admin/invitations", tokens.admin, { name: "X", email: "x@example.invalid", role });
            assert.equal(res.status, 400, String(role));
        }
    });

    test("an invitation cannot be turned into another role after it is issued", async () => {
        clearSentEmails();
        await call("POST", "/api/admin/invitations", tokens.admin, { name: "Desk Two", email: "desk-two@example.invalid", role: "REGISTRATION_DESK" });
        const rawToken = new URL(getLastSentEmail().setupUrl).searchParams.get("token");
        await call("POST", "/auth/setup-password", undefined, { token: rawToken, password: PASSWORD, role: "MANAGER" });
        assert.equal(db.rows.find((a) => a.email === "desk-two@example.invalid").role, "REGISTRATION_DESK");
    });
});

// ---------------------------------------------------------------- 3/7. permission matrix, direct API

// [method, path, body, roles allowed by the router's requireRole tier]
const ALL_ACTIVE = [ADMIN, MANAGER, ANALYST];
const REGISTRATION_UP = [ADMIN, MANAGER, ANALYST, REGISTRATION_DESK];
const ANALYSTS_UP = [ADMIN, MANAGER, ANALYST];
const MANAGERS_UP = [ADMIN, MANAGER];
const ADMINS_ONLY = [ADMIN];
const ROUTES = [
    ["GET", "/overview", undefined, ALL_ACTIVE],
    ["GET", "/documents/missing", undefined, ALL_ACTIVE],
    ["GET", "/documents", undefined, ALL_ACTIVE],
    ["GET", "/clients", undefined, ALL_ACTIVE],
    ["GET", "/reports/daily", undefined, ALL_ACTIVE],
    ["GET", "/reports/monthly", undefined, ALL_ACTIVE],
    ["GET", `/clients/${PASSPORT_ID}`, undefined, ALL_ACTIVE],
    ["GET", "/review", undefined, ALL_ACTIVE],
    ["GET", "/police", undefined, ALL_ACTIVE],
    ["GET", `/review/${UUID}`, undefined, ALL_ACTIVE],
    ["GET", `/review/${UUID}/file`, undefined, ALL_ACTIVE],
    ["POST", `/review/${UUID}/approve`, {}, ANALYSTS_UP],
    ["POST", `/review/${UUID}/keep-pending`, { reason: "x" }, ANALYSTS_UP],
    ["POST", `/review/${UUID}/remove`, { reason: "x" }, ANALYSTS_UP],
    ["POST", `/review/${UUID}/retry`, {}, ANALYSTS_UP],
    ["POST", `/review/${UUID}/replace-verified`, {}, ANALYSTS_UP],
    ["POST", `/review/${UUID}/keep-as-version`, {}, ANALYSTS_UP],
    ["POST", `/review/${UUID}/document-type`, {}, ANALYSTS_UP],
    ["POST", `/review/${UUID}/assign-client`, {}, ANALYSTS_UP],
    ["DELETE", `/temporary-documents/${UUID}`, undefined, ANALYSTS_UP],
    ["POST", `/documents/${UUID}/police-date`, {}, MANAGERS_UP],
    ["GET", "/candidates", undefined, ANALYSTS_UP],
    ["POST", "/candidates", {}, REGISTRATION_UP],
    ["GET", `/candidates/${PASSPORT_ID}`, undefined, ANALYSTS_UP],
    ["PUT", `/candidates/${PASSPORT_ID}`, {}, ANALYSTS_UP],
    // The desk only with a registration upload grant (test/candidates.test.js);
    // without one these are refused like any other route.
    ["PUT", `/candidates/${PASSPORT_ID}/stages/TEST_DETAILS`, {}, ANALYSTS_UP],
    ["POST", `/candidates/${PASSPORT_ID}/documents/upload-target`, {}, ANALYSTS_UP],
    ["POST", `/candidates/${PASSPORT_ID}/documents/finalize`, {}, ANALYSTS_UP],
    ["POST", `/candidates/${PASSPORT_ID}/documents/${UUID}/remove`, {}, ANALYSTS_UP],
    ["GET", `/candidates/${PASSPORT_ID}/call-logs`, undefined, ALL_ACTIVE],
    ["POST", `/candidates/${PASSPORT_ID}/call-logs`, {}, ANALYSTS_UP],
    ["GET", "/invitations", undefined, ADMINS_ONLY],
    ["POST", "/invitations", { name: "N", email: "n@example.invalid", role: "ADMIN" }, ADMINS_ONLY],
    ["POST", "/invitations/some-id/revoke", {}, ADMINS_ONLY],
    ["DELETE", "/invitations/some-id", undefined, ADMINS_ONLY],
    ["POST", "/invitations/some-id/delete", {}, ADMINS_ONLY],
    ["GET", "/admins", undefined, ADMINS_ONLY],
    // A no-op change for the roles allowed to make it, so desk-2 stays a desk.
    ["PUT", "/admins/desk-2/role", { role: "REGISTRATION_DESK" }, ADMINS_ONLY],
];

describe("permission matrix: every /api/admin route, per role", () => {
    for (const [method, path, body, allowed] of ROUTES) {
        test(`${method} ${path.replace(UUID, ":id").replace(PASSPORT_ID, ":passportId")}`, async () => {
            // Unauthenticated: always 401.
            assert.equal((await call(method, `/api/admin${path}`, undefined, body)).status, 401, "no token");

            for (const [roleName, role] of [["admin", ADMIN], ["manager", MANAGER], ["analyst", ANALYST], ["desk", REGISTRATION_DESK]]) {
                // Order matters for the mutating admin routes: the role change
                // runs last and only for ADMIN, against desk-2.
                const { status } = await call(method, `/api/admin${path}`, tokens[roleName], body);
                if (allowed.includes(role)) {
                    assert.ok(status !== 401 && status !== 403, `${role} should pass the gate, got ${status}`);
                } else {
                    assert.equal(status, 403, `${role} must be refused`);
                }
            }
        });
    }

    test("routes that do not exist answer 404 for every role (no PATCH/DELETE admin, no settings, no deactivate)", async () => {
        for (const [method, path] of [
            ["PATCH", "/admins/desk-1"], ["DELETE", "/admins/desk-1"], ["POST", "/admins/desk-1/deactivate"],
            ["POST", "/invite"], ["GET", "/settings"], ["GET", "/users"], ["DELETE", `/candidates/${PASSPORT_ID}`],
        ]) {
            for (const key of ["admin", "desk"]) {
                assert.equal((await call(method, `/api/admin${path}`, tokens[key], {})).status, 404, `${key} ${method} ${path}`);
            }
        }
    });
});

// ---------------------------------------------------------------- 8. what REGISTRATION_DESK can do

describe("REGISTRATION_DESK candidate access", () => {
    test("can register (the request reaches validation); cannot list, read or edit candidates", async () => {
        // 400 = past the gate and into validation.
        assert.equal((await call("POST", "/api/admin/candidates", tokens.desk, {})).status, 400);
        assert.equal((await call("GET", "/api/admin/candidates", tokens.desk)).status, 403);
        assert.equal((await call("GET", "/api/admin/candidates?search=Kamal", tokens.desk)).status, 403);
        assert.equal((await call("GET", `/api/admin/candidates/${PASSPORT_ID}`, tokens.desk)).status, 403);
        assert.equal((await call("GET", "/api/admin/candidates/N0000000", tokens.desk)).status, 403, "a missing one too: no existence check");
        assert.equal((await call("PUT", `/api/admin/candidates/${PASSPORT_ID}`, tokens.desk, {})).status, 403);
    });

    test("without a registration grant: cannot upload documents, change stages, view or add call logs, remove documents", async () => {
        const refused = [
            ["POST", `/candidates/${PASSPORT_ID}/documents/upload-target`], ["POST", `/candidates/${PASSPORT_ID}/documents/finalize`],
            ["POST", `/candidates/${PASSPORT_ID}/documents/${UUID}/remove`], ["PUT", `/candidates/${PASSPORT_ID}/stages/TEST_DETAILS`],
            ["GET", `/candidates/${PASSPORT_ID}/call-logs`], ["POST", `/candidates/${PASSPORT_ID}/call-logs`],
        ];
        for (const [method, path] of refused) {
            assert.equal((await call(method, `/api/admin${path}`, tokens.desk, {})).status, 403, `${method} ${path}`);
        }
    });
});

// ---------------------------------------------------------------- 9. privilege escalation

describe("privilege escalation attempts by REGISTRATION_DESK", () => {
    const roleOf = (adminId) => db.rows.find((a) => a.adminId === adminId).role;

    test("cannot change their own role or anyone else's, with any payload", async () => {
        for (const target of ["desk-1", "desk-2", "analyst-1", "admin-1"]) {
            for (const body of [{ role: "ADMIN" }, { role: "MANAGER", adminId: target }, { role: "ADMIN", admin: { role: "ADMIN" } }]) {
                assert.equal((await call("PUT", `/api/admin/admins/${target}/role`, tokens.desk, body)).status, 403);
            }
        }
        assert.equal(roleOf("desk-1"), REGISTRATION_DESK);
        assert.equal(roleOf("desk-2"), REGISTRATION_DESK);
        assert.equal(roleOf("analyst-1"), ANALYST);
    });

    test("cannot invite anyone, at any role", async () => {
        for (const role of ALL_ROLES) {
            const res = await call("POST", "/api/admin/invitations", tokens.desk, { name: "Evil", email: `evil-${role}@example.invalid`, role });
            assert.equal(res.status, 403, role);
        }
        assert.equal(db.invitationRows.filter((r) => r.email.startsWith("evil-")).length, 0);
    });

    test("cannot list admins, invitations or accounts", async () => {
        assert.equal((await call("GET", "/api/admin/admins", tokens.desk)).status, 403);
        assert.equal((await call("GET", "/api/admin/invitations", tokens.desk)).status, 403);
    });

    test("a role field in the request body or headers does not widen access", async () => {
        const res = await call("GET", "/api/admin/overview", tokens.desk, undefined, { "X-Role": "ADMIN", "X-Admin-Role": "ADMIN" });
        assert.equal(res.status, 403);
        assert.equal((await call("POST", "/api/admin/candidates/" + PASSPORT_ID + "/call-logs", tokens.desk, { note: "x", role: "ADMIN", admin: { role: "ADMIN" } })).status, 403);
    });

    test("a token whose role claim says ADMIN does not help: the stored role decides", async () => {
        const forgedClaim = sign("desk-1", ADMIN); // validly signed, claims ADMIN
        assert.equal((await call("GET", "/api/admin/admins", forgedClaim)).status, 403);
        assert.equal((await call("PUT", "/api/admin/admins/desk-2/role", forgedClaim, { role: "ADMIN" })).status, 403);
    });

    test("a token signed with another secret, or with alg none, is refused", async () => {
        assert.equal((await call("GET", "/api/admin/admins", sign("admin-1", ADMIN, "some-other-secret-0123456789012345678901"))).status, 401);
        const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from('{"adminId":"admin-1","role":"ADMIN"}').toString("base64url")}.`;
        assert.equal((await call("GET", "/api/admin/admins", none)).status, 401);
    });

    test("a role change applies at once: a token issued before is judged on the new role", async () => {
        const before = sign("desk-2", REGISTRATION_DESK);
        assert.equal((await call("POST", "/api/admin/candidates", before, {})).status, 400, "the desk may register");
        // ADMIN promotes, then demotes, desk-2. Call logs are ANALYST and up.
        const callLogs = `/api/admin/candidates/${PASSPORT_ID}/call-logs`;
        assert.equal((await call("GET", callLogs, before)).status, 403, "REGISTRATION_DESK");
        assert.equal((await call("PUT", "/api/admin/admins/desk-2/role", tokens.admin, { role: "ANALYST" })).status, 200);
        assert.notEqual((await call("GET", callLogs, before)).status, 403, "now ANALYST: past the gate");
        assert.equal((await call("PUT", "/api/admin/admins/desk-2/role", tokens.admin, { role: "REGISTRATION_DESK" })).status, 200);
        assert.equal((await call("GET", callLogs, before)).status, 403, "back to REGISTRATION_DESK");
    });

    test("a registration upload grant is not a sign-in token", async () => {
        const grant = issueRegistrationUploadGrant({ adminId: "admin-1", passportId: PASSPORT_ID });
        assert.equal((await call("GET", "/auth/me", grant)).status, 401);
        assert.equal((await call("POST", "/api/admin/candidates", grant, {})).status, 401);
        assert.equal((await call("GET", "/api/admin/admins", grant)).status, 401);
    });

    test("an inactive REGISTRATION_DESK account is refused everywhere", async () => {
        db.rows.find((a) => a.adminId === "desk-2").status = "INACTIVE";
        const token = sign("desk-2", REGISTRATION_DESK);
        assert.equal((await call("GET", "/api/admin/candidates", token)).status, 401);
        assert.equal((await call("GET", "/auth/me", token)).status, 401);
        db.rows.find((a) => a.adminId === "desk-2").status = ACTIVE_ADMIN_STATUS;
    });

    test("ADMIN cannot change their own role, and an invalid role is refused", async () => {
        assert.equal((await call("PUT", "/api/admin/admins/admin-1/role", tokens.admin, { role: "ANALYST" })).status, 400);
        assert.equal((await call("PUT", "/api/admin/admins/desk-2/role", tokens.admin, { role: "SUPER_ADMIN" })).status, 400);
    });
});

// ---------------------------------------------------------------- 10/11. login and existing admin

describe("login and existing roles", () => {
    test("REGISTRATION_DESK can sign in and /auth/me returns the stored role", async () => {
        const login = await call("POST", "/auth/login", undefined, { email: "desk-1@example.invalid", password: PASSWORD });
        assert.equal(login.status, 200);
        const me = await call("GET", "/auth/me", login.body.token);
        assert.equal(me.body.admin.role, "REGISTRATION_DESK");
    });

    test("ADMIN keeps full access", async () => {
        assert.equal((await call("GET", "/api/admin/admins", tokens.admin)).status, 200);
        assert.equal((await call("GET", "/api/admin/invitations", tokens.admin)).status, 200);
        assert.equal((await call("GET", "/api/admin/candidates", tokens.admin)).status, 200);
    });
});
