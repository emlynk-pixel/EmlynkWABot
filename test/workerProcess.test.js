// Phase 12, Step 5B: the worker-only process (src/worker.js +
// src/workerProcess.js). A thin lifecycle around the existing worker: it
// starts startSubmissionWorker() once, optionally answers /health, and hands
// SIGTERM/SIGINT to the existing graceful shutdown. No queue logic of its own.
//
// Nothing here touches a real database or storage: the worker runs against
// an in-memory double, and the process checks use synthetic placeholders.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { startWorkerProcess, createHealthServer } from "../src/workerProcess.js";
import { startSubmissionWorker } from "../src/services/submissionQueue.js";
import { createShutdown } from "../src/shutdown.js";
import { findEnvProblems, REQUIRED_ENV_VARS, WORKER_REQUIRED_ENV_VARS } from "../src/config/env.js";

const quiet = { log() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// An empty queue: every claim attempt finds nothing. Counts the polls.
function emptyQueueDb() {
    const db = {
        polls: 0,
        disconnected: 0,
        temporaryData: {
            findFirst: async () => { db.polls += 1; return null; },
            updateMany: async () => ({ count: 0 }),
        },
        $disconnect: async () => { db.disconnected += 1; },
    };
    return db;
}

// The real worker on the in-memory queue, polling fast.
function realWorker(db) {
    return () => startSubmissionWorker({ db, bucket: {}, pollMs: 20, log: quiet });
}

async function waitFor(check, timeoutMs = 2_000) {
    const until = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > until) throw new Error("condition not reached");
        await sleep(10);
    }
}

describe("Step 5B: worker process lifecycle", () => {
    test("starts the existing worker exactly once and registers one handler per signal", async () => {
        let starts = 0;
        const stopped = [];
        const signals = new EventEmitter();
        const { server } = await startWorkerProcess({
            startWorker: () => { starts += 1; return { stop: async () => { stopped.push(true); return { finished: true, released: 0 }; } }; },
            createShutdown,
            db: { $disconnect: async () => {} },
            port: undefined,
            signals,
            exit: () => {},
            log: quiet,
        });

        assert.equal(starts, 1);
        assert.equal(server, null, "no port: no listener");
        assert.equal(signals.listenerCount("SIGTERM"), 1);
        assert.equal(signals.listenerCount("SIGINT"), 1);

        signals.emit("SIGTERM");
        await waitFor(() => stopped.length === 1);
        signals.emit("SIGTERM"); // once() handler: already removed
        await sleep(50);
        assert.equal(stopped.length, 1, "the worker is stopped once");
        assert.equal(starts, 1, "never started again");
    });

    for (const signal of ["SIGTERM", "SIGINT"]) {
        test(`${signal} stops the real worker: no poll afterwards, Prisma disconnected, exit 0`, async () => {
            const db = emptyQueueDb();
            const signals = new EventEmitter();
            const exits = [];
            const { server } = await startWorkerProcess({
                startWorker: realWorker(db),
                createShutdown,
                db,
                port: "0",
                signals,
                exit: (code) => exits.push(code),
                log: quiet,
            });

            await waitFor(() => db.polls >= 3); // the worker is really polling
            signals.emit(signal);
            await waitFor(() => exits.length === 1);

            assert.deepEqual(exits, [0]);
            assert.equal(db.disconnected, 1);
            assert.equal(server.listening, false, "health listener closed");
            const pollsAtStop = db.polls;
            await sleep(150); // several poll intervals
            assert.equal(db.polls, pollsAtStop, "the worker keeps no loop running after shutdown");
        });
    }

    test("the health listener answers GET/HEAD /health only, and reveals nothing", async () => {
        const server = createHealthServer();
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        try {
            const health = await fetch(`${base}/health`);
            assert.equal(health.status, 200);
            assert.deepEqual(await health.json(), { status: "OK" });
            assert.equal((await fetch(`${base}/health`, { method: "HEAD" })).status, 200);
            assert.equal((await fetch(`${base}/health`, { method: "POST" })).status, 404);
            assert.equal((await fetch(`${base}/api/admin/overview`)).status, 404);
            assert.equal((await fetch(`${base}/whatsapp/webhook`)).status, 404);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test("a port that can't be opened fails startup before the worker starts", async () => {
        const blocker = net.createServer();
        await new Promise((resolve) => blocker.listen(0, resolve));
        let starts = 0;
        try {
            await assert.rejects(startWorkerProcess({
                startWorker: () => { starts += 1; return { stop: async () => ({ finished: true, released: 0 }) }; },
                createShutdown,
                db: { $disconnect: async () => {} },
                port: String(blocker.address().port),
                signals: new EventEmitter(),
                exit: () => {},
                log: quiet,
            }), { code: "EADDRINUSE" });
            assert.equal(starts, 0);
        } finally {
            await new Promise((resolve) => blocker.close(resolve));
        }
    });

    test("the shutdown works without an HTTP server (worker-only, no health port)", async () => {
        const exits = [];
        const db = emptyQueueDb();
        await createShutdown({
            server: null,
            worker: { stop: async () => ({ finished: true, released: 0 }) },
            db,
            exit: (code) => exits.push(code),
            log: quiet,
        })("SIGTERM");
        assert.deepEqual(exits, [0]);
        assert.equal(db.disconnected, 1);
    });
});

describe("Step 5B: worker settings", () => {
    const WORKER_ENV = Object.freeze({
        DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
        SUPABASE_URL: "http://127.0.0.1:1",
        SUPABASE_SERVICE_ROLE_KEY: "test-service-role-placeholder",
        SUPABASE_BUCKET: "test-bucket",
        OCR_SERVICE_URL: "http://127.0.0.1:1",
    });

    test("the worker needs only database, storage and OCR settings (a subset of the server's)", () => {
        assert.deepEqual(Object.keys(WORKER_ENV).sort(), [...WORKER_REQUIRED_ENV_VARS].sort());
        for (const name of WORKER_REQUIRED_ENV_VARS) assert.ok(REQUIRED_ENV_VARS.includes(name), name);
        assert.deepEqual(findEnvProblems(WORKER_ENV, { required: WORKER_REQUIRED_ENV_VARS }), []);
        // The server's own check is unchanged: the same settings are not enough for it.
        assert.ok(findEnvProblems(WORKER_ENV).includes("JWT_SECRET is missing"));
    });

    test("format checks still apply to the worker's settings", () => {
        const problems = findEnvProblems({ ...WORKER_ENV, OCR_SERVICE_URL: "http://ocr.example.com" }, { required: WORKER_REQUIRED_ENV_VARS });
        assert.deepEqual(problems, ["OCR_SERVICE_URL must use https:// unless it is a loopback address"]);
    });
});

describe("Step 5B: the worker entry point (node src/worker.js)", () => {
    const workerPath = fileURLToPath(new URL("../src/worker.js", import.meta.url));
    const PLACEHOLDERS = {
        DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
        SUPABASE_URL: "http://127.0.0.1:1",
        SUPABASE_SERVICE_ROLE_KEY: "test-service-role-placeholder",
        SUPABASE_BUCKET: "test-bucket",
        OCR_SERVICE_URL: "http://127.0.0.1:1",
    };
    // DOTENV_CONFIG_PATH points dotenv away from the real .env; the server's
    // other settings are removed so only the worker's are present.
    function childEnv(overrides = {}) {
        const env = { ...process.env, DOTENV_CONFIG_PATH: "does-not-exist.env", DOTENV_CONFIG_QUIET: "true", ...PLACEHOLDERS };
        for (const name of REQUIRED_ENV_VARS) if (!(name in PLACEHOLDERS)) delete env[name];
        delete env.PORT;
        return { ...env, ...overrides };
    }

    test("exits at startup, naming only a missing worker setting", () => {
        const env = childEnv();
        delete env.DATABASE_URL;
        const result = spawnSync(process.execPath, [workerPath], { env, encoding: "utf8", timeout: 30_000 });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /DATABASE_URL is missing/);
        assert.ok(!/JWT_SECRET|META_APP_SECRET|WHATSAPP/.test(result.stderr), "server-only settings are not required");
        assert.ok(!result.stderr.includes(PLACEHOLDERS.SUPABASE_SERVICE_ROLE_KEY));
        assert.ok(!result.stdout.includes("Submission worker running"));
    });

    test("starts with the worker settings only, stays running and answers /health", async () => {
        const child = spawn(process.execPath, [workerPath], { env: childEnv({ PORT: "0" }), stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
        try {
            const port = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`not started: ${stdout}`)), 20_000);
                child.stdout.on("data", () => {
                    const match = /healthPort: (\d+)/.exec(stdout);
                    if (match) { clearTimeout(timer); resolve(Number(match[1])); }
                });
                exited.then((code) => { clearTimeout(timer); reject(new Error(`exited early (${code})`)); });
            });
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            assert.equal(response.status, 200);
            await sleep(500);
            assert.equal(child.exitCode, null, "the worker process keeps running");
            assert.equal((stdout.match(/Submission worker running/g) ?? []).length, 1, "started once");
        } finally {
            child.kill();
            await exited;
        }
    });

    test("the entry is a thin wrapper: checks first, no queue logic of its own", () => {
        const strip = (file) => fs.readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")
            .split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
        const entry = strip("worker.js");
        const lifecycle = strip("workerProcess.js");

        assert.ok(entry.indexOf("assertValidRuntime();") < entry.indexOf('await import("./services/submissionQueue.js")'));
        assert.ok(!/^import .*prisma|^import .*submissionQueue/m.test(entry), "no static import of the client or the queue");
        assert.equal((entry.match(/startSubmissionWorker/g) ?? []).length, 2, "imported once, passed once");
        for (const source of [entry, lifecycle]) {
            for (const queueCode of ["temporaryData", "findFirst", "updateMany", "claimNextSubmission", "processClaimedSubmission", "processingStartedAt", "EventEmitter"]) {
                assert.ok(!source.includes(queueCode), `no ${queueCode} outside submissionQueue.js`);
            }
        }
    });

    test("no second queue implementation exists in src/", () => {
        const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
        const files = fs.readdirSync(srcDir, { recursive: true }).filter((f) => f.endsWith(".js"));
        const definers = files.filter((f) => /export (async )?function (claimNextSubmission|startSubmissionWorker|drainSubmissionQueue)\b/
            .test(fs.readFileSync(`${srcDir}/${f}`, "utf8")));
        assert.deepEqual(definers.map((f) => f.split("\\").join("/")), ["services/submissionQueue.js"]);
    });
});
