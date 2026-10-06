// Settings -> Google Sheet Sync API (Phase 5 backend): authorization and
// durable run requests, through the real admin router and auth middleware on
// a real PostgreSQL (PGlite). No Google client exists in this file: the API
// must answer without Google (it runs on Vercel, which has no credentials).
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createRequireActiveAdmin } from "../src/middleware/requireActiveAdmin.js";
import { JWT_ALGORITHM } from "../src/middleware/auth.js";

process.env.JWT_SECRET ??= "test-jwt-secret-placeholder-for-sheet-sync-0123456789";

const BASE = "/api/admin/settings/sheet-sync";
const ROLES = ["ADMIN", "MANAGER", "ANALYST", "REGISTRATION_DESK"];

let database;
let prisma;
let server;
let baseUrl;

before(async () => {
    database = await createTestDatabase();
    prisma = database.prisma;
    for (const role of ROLES) {
        await prisma.admin.create({ data: { adminId: `admin-${role}`, name: role, email: `${role.toLowerCase()}@example.invalid`, role, status: "ACTIVE" } });
    }
    await prisma.admin.create({ data: { adminId: "admin-inactive", name: "x", email: "inactive@example.invalid", role: "ADMIN", status: "INACTIVE" } });
    // A demoted admin whose token still says ADMIN: the database role decides.
    await prisma.admin.create({ data: { adminId: "admin-demoted", name: "y", email: "demoted@example.invalid", role: "MANAGER", status: "ACTIVE" } });

    const app = express();
    app.use(express.json());
    app.use("/api/admin", createAdminRouter({ db: prisma, requireAdmin: createRequireActiveAdmin({ db: prisma }), apiLimiter: (req, res, next) => next() }));
    app.use((error, req, res, next) => res.status(500).json({ message: "Internal server error" })); // eslint-disable-line no-unused-vars
    await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await database?.close();
});
beforeEach(async () => {
    await prisma.sheetSyncRun.deleteMany();
    await prisma.sheetSyncState.update({ where: { stateId: "sheet-sync" }, data: { workerHeartbeatAt: null, writeGate: null, configured: null, targetHint: null } });
});

const token = (adminId, role) => jwt.sign({ adminId, email: "x@example.invalid", role }, process.env.JWT_SECRET, { algorithm: JWT_ALGORITHM, expiresIn: "1h" });
async function call(method, path, adminId, role = "ADMIN") {
    const headers = { Accept: "application/json" };
    if (adminId) headers.Authorization = `Bearer ${token(adminId, role)}`;
    const response = await fetch(`${baseUrl}${BASE}${path}`, { method, headers });
    return { status: response.status, body: await response.json().catch(() => null) };
}

describe("authorization (backend is the boundary)", () => {
    const endpoints = [["GET", "/status"], ["POST", "/test"], ["POST", "/run"], ["GET", "/runs/00000000-0000-4000-8000-000000000000"]];

    for (const role of ["MANAGER", "ANALYST", "REGISTRATION_DESK"]) {
        test(`${role}: 403 on every Settings endpoint, and no run is recorded`, async () => {
            for (const [method, path] of endpoints) {
                const { status, body } = await call(method, path, `admin-${role}`, role);
                assert.equal(status, 403, `${method} ${path}`);
                assert.deepEqual(body, { message: "Insufficient permissions" });
            }
            assert.equal(await prisma.sheetSyncRun.count(), 0);
        });
    }

    test("no token: 401; inactive admin: 401", async () => {
        for (const [method, path] of endpoints) assert.equal((await call(method, path, null)).status, 401);
        assert.equal((await call("GET", "/status", "admin-inactive")).status, 401);
    });

    test("the role is re-read from the database: a token claiming ADMIN for a MANAGER is refused", async () => {
        assert.equal((await call("POST", "/run", "admin-demoted", "ADMIN")).status, 403);
        assert.equal(await prisma.sheetSyncRun.count(), 0);
    });
});

describe("ADMIN", () => {
    test("GET /status reads PostgreSQL only and exposes no secret or full spreadsheet ID", async () => {
        await prisma.sheetSyncState.update({ where: { stateId: "sheet-sync" }, data: { workerHeartbeatAt: new Date(), writeGate: "DISABLED", configured: true, targetHint: "…JirMpE / Emlynk Candidate Operational Mirror" } });
        const { status, body } = await call("GET", "/status", "admin-ADMIN");
        assert.equal(status, 200);
        assert.equal(body.worker.online, true);
        assert.equal(body.writeGate, "DISABLED");
        assert.deepEqual(body.queue, { pending: 0, processing: 0, failed: 0 });
        assert.equal(body.integration.state, "UNKNOWN");
        assert.deepEqual(body.activeRuns, { reconcile: null, testConnection: null });
        assert.doesNotMatch(JSON.stringify(body), /1-11g-0tQruJbgVslH0nzCzG_JRr-4LahSCU8ZJirMpE|private_key|ya29|BEGIN/);
    });

    test("a stale or missing worker heartbeat is reported as offline (queued runs won't progress)", async () => {
        assert.equal((await call("GET", "/status", "admin-ADMIN")).body.worker.online, false);
        await prisma.sheetSyncState.update({ where: { stateId: "sheet-sync" }, data: { workerHeartbeatAt: new Date(Date.now() - 10 * 60_000) } });
        assert.equal((await call("GET", "/status", "admin-ADMIN")).body.worker.online, false);
    });

    test("POST /run (Sync Now) returns 202 at once with a durable QUEUED run; a second request returns the same run", async () => {
        const first = await call("POST", "/run", "admin-ADMIN");
        assert.equal(first.status, 202);
        assert.deepEqual([first.body.run.kind, first.body.run.status, first.body.run.trigger, first.body.alreadyActive], ["RECONCILE", "QUEUED", "ADMIN", false]);
        const second = await call("POST", "/run", "admin-ADMIN");
        assert.equal(second.status, 202);
        assert.equal(second.body.run.runId, first.body.run.runId);
        assert.equal(second.body.alreadyActive, true);
        const stored = await prisma.sheetSyncRun.findMany();
        assert.equal(stored.length, 1);
        assert.equal(stored[0].requestedBy, "admin-ADMIN");
        const status = await call("GET", "/status", "admin-ADMIN");
        assert.equal(status.body.activeRuns.reconcile.runId, first.body.run.runId);
    });

    test("overlapping Sync Now requests at the same moment create exactly one run", async () => {
        const results = await Promise.all(Array.from({ length: 5 }, () => call("POST", "/run", "admin-ADMIN")));
        assert.deepEqual(results.map((r) => [r.status, r.body?.message ?? null]), results.map(() => [202, null]));
        assert.equal(new Set(results.map((r) => r.body.run.runId)).size, 1);
        assert.equal(await prisma.sheetSyncRun.count(), 1);
    });

    test("POST /test (Test Connection) creates a durable TEST_CONNECTION run, separate from reconciliation", async () => {
        await call("POST", "/run", "admin-ADMIN");
        const { status, body } = await call("POST", "/test", "admin-ADMIN");
        assert.equal(status, 202);
        assert.equal(body.run.kind, "TEST_CONNECTION");
        assert.equal(await prisma.sheetSyncRun.count(), 2);
    });

    test("GET /runs/:runId: the run, 400 for a malformed ID, 404 for an unknown one", async () => {
        const { body } = await call("POST", "/run", "admin-ADMIN");
        const found = await call("GET", `/runs/${body.run.runId}`, "admin-ADMIN");
        assert.deepEqual([found.status, found.body.runId, found.body.status], [200, body.run.runId, "QUEUED"]);
        assert.equal((await call("GET", "/runs/not-a-uuid", "admin-ADMIN")).status, 400);
        assert.equal((await call("GET", "/runs/00000000-0000-4000-8000-000000000000", "admin-ADMIN")).status, 404);
    });
});

describe("existing routes are unchanged", () => {
    test("Candidate Pool list still answers for every role it allowed before", async () => {
        for (const role of ROLES) {
            const response = await fetch(`${baseUrl}/api/admin/candidates`, { headers: { Authorization: `Bearer ${token(`admin-${role}`, role)}` } });
            assert.equal(response.status, 200, role);
        }
    });

    test("unknown /api/admin paths still 404", async () => {
        const response = await fetch(`${baseUrl}/api/admin/settings/other`, { headers: { Authorization: `Bearer ${token("admin-ADMIN", "ADMIN")}` } });
        assert.equal(response.status, 404);
    });
});
