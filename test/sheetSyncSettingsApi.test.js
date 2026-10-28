// Settings -> Google Sheet Sync API (Phase 5 backend): authorization and
// durable run requests, through the real admin router and auth middleware on
// a real PostgreSQL (PGlite). No Google client exists in this file: the API
// must answer without Google (it runs on Vercel, which has no credentials).
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createRequireActiveUser } from "../src/middleware/requireActiveUser.js";
import { authIdFor, fakeVerifyAccessToken, tokenFor } from "./helpers/fakeSupabaseAuth.js";

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
        await prisma.user.create({ data: { adminId: `admin-${role}`, authUserId: authIdFor(`admin-${role}`), name: role, email: `${role.toLowerCase()}@example.invalid`, role, status: "ACTIVE" } });
    }
    await prisma.user.create({ data: { adminId: "admin-inactive", authUserId: authIdFor("admin-inactive"), name: "x", email: "inactive@example.invalid", role: "ADMIN", status: "INACTIVE" } });
    // Its role is changed in the database during a test: the next request uses it.
    await prisma.user.create({ data: { adminId: "admin-demoted", authUserId: authIdFor("admin-demoted"), name: "y", email: "demoted@example.invalid", role: "MANAGER", status: "ACTIVE" } });

    const app = express();
    app.use(express.json());
    app.use("/api/admin", createAdminRouter({ db: prisma, requireAdmin: createRequireActiveUser({ db: prisma, verifyAccessToken: fakeVerifyAccessToken }), apiLimiter: (req, res, next) => next() }));
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

// A Supabase session carries no role: the role parameter is ignored by design.
const token = (adminId) => tokenFor(adminId);
async function call(method, path, adminId) {
    const headers = { Accept: "application/json" };
    if (adminId) headers.Authorization = `Bearer ${token(adminId)}`;
    const response = await fetch(`${baseUrl}${BASE}${path}`, { method, headers });
    return { status: response.status, body: await response.json().catch(() => null) };
}

describe("authorization (backend is the boundary)", () => {
    const endpoints = [["GET", "/status"], ["POST", "/test"], ["POST", "/run"], ["GET", "/runs/00000000-0000-4000-8000-000000000000"]];

    for (const role of ["ANALYST", "REGISTRATION_DESK"]) {
        test(`${role}: 403 on every Settings endpoint, and no run is recorded`, async () => {
            for (const [method, path] of endpoints) {
                const { status, body } = await call(method, path, `admin-${role}`);
                assert.equal(status, 403, `${method} ${path}`);
                assert.deepEqual(body, { message: "Insufficient permissions" });
            }
            assert.equal(await prisma.sheetSyncRun.count(), 0);
        });
    }

    // MANAGER opens the Google Sheet Sync area (status, runs, Update Sheet); every action on the
    // integration itself (Test Connection, Sync Now, destination) stays ADMIN only.
    test("MANAGER: reads the status and runs; 403 on Test Connection, Sync Now and the destination; no run is recorded", async () => {
        assert.equal((await call("GET", "/status", "admin-MANAGER")).status, 200);
        assert.equal((await call("GET", "/runs/00000000-0000-4000-8000-000000000000", "admin-MANAGER")).status, 404, "allowed; the run doesn't exist");
        for (const [method, path] of [["POST", "/test"], ["POST", "/run"], ["PUT", "/destination"]]) {
            const { status, body } = await call(method, path, "admin-MANAGER");
            assert.equal(status, 403, `${method} ${path}`);
            assert.deepEqual(body, { message: "Insufficient permissions" });
        }
        assert.equal(await prisma.sheetSyncRun.count(), 0);
    });

    test("no token: 401; inactive user: 403", async () => {
        for (const [method, path] of endpoints) assert.equal((await call(method, path, null)).status, 401);
        assert.equal((await call("GET", "/status", "admin-inactive")).status, 403);
    });

    test("the role is re-read from the database on every request: a change applies immediately", async () => {
        await prisma.user.update({ where: { adminId: "admin-demoted" }, data: { role: "ANALYST" } });
        assert.equal((await call("GET", "/status", "admin-demoted")).status, 403);
        await prisma.user.update({ where: { adminId: "admin-demoted" }, data: { role: "ADMIN" } });
        assert.equal((await call("GET", "/status", "admin-demoted")).status, 200);
        await prisma.user.update({ where: { adminId: "admin-demoted" }, data: { role: "MANAGER" } });
        assert.equal((await call("POST", "/run", "admin-demoted")).status, 403);
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
            const response = await fetch(`${baseUrl}/api/admin/candidates`, { headers: { Authorization: `Bearer ${token(`admin-${role}`)}` } });
            assert.equal(response.status, 200, role);
        }
    });

    test("unknown /api/admin paths still 404", async () => {
        const response = await fetch(`${baseUrl}/api/admin/settings/other`, { headers: { Authorization: `Bearer ${token("admin-ADMIN")}` } });
        assert.equal(response.status, 404);
    });
});

describe("automatic vs manual sync (from each run's stored trigger)", () => {
    let n = 0;
    // A finished reconciliation; created a few seconds before it finished.
    const run = (triggerSource, finishedAt, { status = "SUCCEEDED", dryRun = false } = {}) => {
        n += 1;
        const finished = new Date(finishedAt);
        return prisma.sheetSyncRun.create({
            data: {
                runId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, kind: "RECONCILE", triggerSource, status, dryRun,
                createdAt: new Date(finished.getTime() - 5_000), startedAt: new Date(finished.getTime() - 4_000), finishedAt: finished,
                summary: status === "SUCCEEDED" ? { appended: 0, updated: 1, unchanged: 6 } : null,
                errorClass: status === "FAILED" ? "RETRYABLE" : null,
            },
        });
    };
    const status = async () => (await call("GET", "/status", "admin-ADMIN")).body;

    test("never run: both are null; the schedule is reported (06:00, 12:00, 18:00 Asia/Colombo)", async () => {
        const body = await status();
        assert.equal(body.lastAutomaticSync, null);
        assert.equal(body.lastManualSync, null);
        assert.equal(body.lastSuccessfulReconciliation, null);
        assert.deepEqual(body.schedule, { times: ["06:00", "12:00", "18:00"], timeZone: "Asia/Colombo" });
    });

    test("a scheduled run is the last automatic sync; a later manual run does not replace it; a later scheduled run does", async () => {
        await run("SCHEDULER", "2026-10-11T12:30:04.000Z"); // 18:00:04 Colombo
        let body = await status();
        assert.equal(body.lastAutomaticSync.trigger, "SCHEDULER");
        assert.equal(body.lastAutomaticSync.finishedAt, "2026-10-11T12:30:04.000Z");
        assert.equal(body.lastManualSync, null);

        await run("ADMIN", "2026-10-12T08:15:00.000Z"); // 13:45 Colombo, Sync Now
        body = await status();
        assert.equal(body.lastAutomaticSync.finishedAt, "2026-10-11T12:30:04.000Z", "unchanged by the manual run");
        assert.equal(body.lastManualSync.trigger, "ADMIN");
        assert.equal(body.lastManualSync.finishedAt, "2026-10-12T08:15:00.000Z");
        assert.equal(body.lastSuccessfulReconciliation.trigger, "ADMIN", "the latest sync is the manual one, and says so");

        // A late scheduled run (18:07 Colombo) is still automatic: the trigger decides, not the time.
        await run("SCHEDULER", "2026-10-12T12:37:00.000Z");
        body = await status();
        assert.equal(body.lastAutomaticSync.finishedAt, "2026-10-12T12:37:00.000Z");
        assert.equal(body.lastManualSync.finishedAt, "2026-10-12T08:15:00.000Z");
        assert.equal(body.lastSuccessfulReconciliation.trigger, "SCHEDULER");
    });

    test("only successful runs count; the operator command is manual; dry runs are reported as such", async () => {
        await run("SCHEDULER", "2026-10-11T00:30:00.000Z");
        await run("SCHEDULER", "2026-10-11T06:30:00.000Z", { status: "FAILED" });
        await run("OPERATOR", "2026-10-11T07:00:00.000Z", { dryRun: true });
        const body = await status();
        assert.equal(body.lastAutomaticSync.finishedAt, "2026-10-11T00:30:00.000Z", "the failed later run is not a sync");
        assert.equal(body.lastReconciliation.trigger, "OPERATOR", "the last reconciliation (any outcome) is still the newest run");
        assert.equal(body.lastManualSync.trigger, "OPERATOR");
        assert.equal(body.lastManualSync.dryRun, true);
    });
});
