// Google Sheet sync worker process (Phase 6): the private HTTP surface, the
// Cloud Scheduler OIDC check, the operator request command, and the process
// lifecycle. No Google call: the token verifier is a fake.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { createOidcVerifier, createSheetSyncHttpServer, startSheetSyncWorkerProcess } from "../src/sheetSyncWorkerProcess.js";
import { requestFromCommandLine } from "../src/sheetSyncRequest.js";
import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { createShutdown } from "../src/shutdown.js";
import { SHEET_SYNC_WORKER_REQUIRED_ENV_VARS, findEnvProblems } from "../src/config/env.js";

const silent = { log() {}, warn() {}, error() {} };
const AUDIENCE = "https://emlynk-sheet-sync-worker.example.run.app";
const INVOKER = "emlynk-sheet-sync-scheduler@project.iam.gserviceaccount.com";

// Accepts only tokens shaped "good:<email>:<email_verified>:<audience>".
const fakeOauthClient = {
    async verifyIdToken({ idToken, audience }) {
        const match = /^good:(.+?):(true|false):(.+)$/.exec(idToken);
        if (!match || match[3] !== audience) throw new Error("bad token");
        return { getPayload: () => ({ email: match[1], email_verified: match[2] === "true" }) };
    },
};

async function serve(server) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
}

describe("HTTP surface", () => {
    let requests = 0;
    const requestReconcile = async () => { requests += 1; return { runId: "00000000-0000-4000-8000-000000000001", status: "QUEUED", created: true }; };

    test("GET /health answers OK; everything else is 404", async () => {
        const server = createSheetSyncHttpServer({ requestReconcile, log: silent });
        const url = await serve(server);
        try {
            const health = await fetch(`${url}/health`);
            assert.deepEqual([health.status, await health.json()], [200, { status: "OK" }]);
            assert.equal((await fetch(`${url}/`)).status, 404);
            assert.equal((await fetch(`${url}/health`, { method: "POST" })).status, 404);
        } finally {
            server.close();
        }
    });

    test("without scheduler settings the reconcile trigger does not exist (404), and records nothing", async () => {
        const server = createSheetSyncHttpServer({ requestReconcile, verifyScheduler: createOidcVerifier({ audience: AUDIENCE, invoker: null, client: fakeOauthClient }), log: silent });
        const url = await serve(server);
        try {
            const before = requests;
            assert.equal((await fetch(`${url}/tasks/reconcile`, { method: "POST", headers: { Authorization: `Bearer good:${INVOKER}:true:${AUDIENCE}` } })).status, 404);
            assert.equal(requests, before);
        } finally {
            server.close();
        }
    });

    test("the trigger requires a valid OIDC token for the right audience and the scheduler's verified e-mail", async () => {
        const verifyScheduler = createOidcVerifier({ audience: AUDIENCE, invoker: INVOKER, client: fakeOauthClient });
        const server = createSheetSyncHttpServer({ requestReconcile, verifyScheduler, log: silent });
        const url = await serve(server);
        const post = (authorization) => fetch(`${url}/tasks/reconcile`, { method: "POST", headers: authorization ? { Authorization: authorization } : {} });
        try {
            const before = requests;
            for (const bad of [null, "Basic abc", "Bearer nonsense", `Bearer good:someone-else@x.iam.gserviceaccount.com:true:${AUDIENCE}`,
                `Bearer good:${INVOKER}:false:${AUDIENCE}`, `Bearer good:${INVOKER}:true:https://other-audience`]) {
                assert.equal((await post(bad)).status, 401, String(bad));
            }
            assert.equal(requests, before, "no run recorded for a rejected call");
            const ok = await post(`Bearer good:${INVOKER}:true:${AUDIENCE}`);
            assert.equal(ok.status, 202);
            assert.deepEqual(await ok.json(), { runId: "00000000-0000-4000-8000-000000000001", status: "QUEUED", created: true });
            assert.equal(requests, before + 1);
        } finally {
            server.close();
        }
    });

    test("a failure while recording the run is a generic 500 without details", async () => {
        const server = createSheetSyncHttpServer({
            requestReconcile: async () => { throw new Error("db down at postgresql://user:secret@host"); },
            verifyScheduler: async () => true,
            log: silent,
        });
        const url = await serve(server);
        try {
            const response = await fetch(`${url}/tasks/reconcile`, { method: "POST" });
            assert.equal(response.status, 500);
            assert.doesNotMatch(await response.text(), /secret|postgresql/);
        } finally {
            server.close();
        }
    });
});

describe("operator request command and configuration", () => {
    let database;
    before(async () => { database = await createTestDatabase(); });
    after(async () => database?.close());

    test("records a durable run, or reports the active one", async () => {
        const out = [];
        assert.equal(await requestFromCommandLine({ argv: ["reconcile"], db: database.prisma, write: (t) => out.push(JSON.parse(t)) }), 0);
        assert.equal(await requestFromCommandLine({ argv: ["reconcile"], db: database.prisma, write: (t) => out.push(JSON.parse(t)) }), 0);
        assert.deepEqual(out.map((o) => [o.kind, o.created]), [["RECONCILE", true], ["RECONCILE", false]]);
        assert.equal(out[0].runId, out[1].runId);
        assert.equal((await database.prisma.sheetSyncRun.findFirst()).triggerSource, "OPERATOR");
        assert.equal(await requestFromCommandLine({ argv: ["delete-everything"], db: database.prisma, write: () => {} }), 2);
    });

    test("the worker needs only the database and the Sheet target", () => {
        assert.deepEqual([...SHEET_SYNC_WORKER_REQUIRED_ENV_VARS], ["DATABASE_URL", "SHEET_SPREADSHEET_ID", "SHEET_TAB_NAME"]);
        const problems = findEnvProblems({}, { required: SHEET_SYNC_WORKER_REQUIRED_ENV_VARS });
        assert.deepEqual(problems, ["DATABASE_URL is missing", "SHEET_SPREADSHEET_ID is missing", "SHEET_TAB_NAME is missing"]);
    });
});

describe("process lifecycle", () => {
    test("starts the worker once, and SIGTERM stops it through the shared graceful shutdown", async () => {
        const events = [];
        const worker = { start: () => events.push("start"), stop: async () => { events.push("stop"); return { finished: true, released: 0 }; } };
        const signals = new (await import("node:events")).EventEmitter();
        let exitCode = null;
        const server = createSheetSyncHttpServer({ requestReconcile: async () => ({}), log: silent });
        const { shutdown } = await startSheetSyncWorkerProcess({
            worker, server, createShutdown, db: { $disconnect: async () => events.push("disconnect") },
            port: 0, signals, exit: (code) => { exitCode = code; }, log: silent,
        });
        signals.emit("SIGTERM");
        await shutdown("SIGTERM");
        assert.deepEqual(events, ["start", "stop", "disconnect"]);
        assert.equal(exitCode, 0);
    });
});
