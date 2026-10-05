// Phase 12, Step 5A: src/httpHandler.js is the Express app as a plain
// request handler, with no process lifecycle of its own (no listening
// socket, no background worker, no signal handlers).
//
// Each check runs in a child process with synthetic placeholder settings
// (never the real .env): what matters is what importing the module leaves
// running, and a process that ends on its own proves nothing was left.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const HANDLER_URL = new URL("../src/httpHandler.js", import.meta.url).href;

// Synthetic placeholders only; nothing is contacted.
const PLACEHOLDER_ENV = Object.freeze({
    DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-placeholder",
    SUPABASE_BUCKET: "test-bucket",
    JWT_SECRET: "test-jwt-secret-placeholder-0123456789",
    META_APP_SECRET: "test-app-secret-placeholder",
    WHATSAPP_VERIFY_TOKEN: "test-verify-token-placeholder",
    WHATSAPP_ACCESS_TOKEN: "test-access-token-placeholder",
    WHATSAPP_API_VERSION: "v21.0",
    OCR_SERVICE_URL: "http://127.0.0.1:1",
});

// Runs `script` (an ES module) in a fresh Node process. DOTENV_CONFIG_PATH
// points dotenv away from the real .env.
function runChild(script, env = PLACEHOLDER_ENV) {
    const childEnv = { ...process.env, ...env, DOTENV_CONFIG_PATH: "does-not-exist.env", DOTENV_CONFIG_QUIET: "true" };
    for (const name of Object.keys(PLACEHOLDER_ENV)) {
        if (!(name in env)) delete childEnv[name];
    }
    return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        env: childEnv,
        encoding: "utf8",
        timeout: 30_000,
    });
}

function lastJsonLine(stdout) {
    const line = stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
    return JSON.parse(line);
}

describe("Step 5A: HTTP handler without a process lifecycle", () => {
    test("importing the handler starts no server and no worker: the process ends by itself", () => {
        const result = runChild(`
            const before = process.listenerCount("SIGTERM");
            const { default: app } = await import(${JSON.stringify(HANDLER_URL)});
            console.log(JSON.stringify({
                isHandler: typeof app === "function" && app.length >= 2,
                sigtermHandlersAdded: process.listenerCount("SIGTERM") - before,
            }));
        `);

        // A listening server or the worker's poll loop would keep the
        // process alive until the timeout.
        assert.equal(result.error, undefined, "the process did not end by itself");
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(lastJsonLine(result.stdout), { isHandler: true, sigtermHandlersAdded: 0 });
        assert.ok(!result.stdout.includes("Server is running"));
    });

    test("used as a request handler, it answers exactly like the app (health, auth, webhook)", () => {
        // http.createServer(app) is what a platform does with a handler: it
        // calls app(req, res) per request. Closed afterwards; the process
        // must then end by itself again.
        const result = runChild(`
            import http from "node:http";
            const { default: app } = await import(${JSON.stringify(HANDLER_URL)});
            const server = http.createServer(app);
            await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
            const base = "http://127.0.0.1:" + server.address().port;
            const call = async (path, init) => {
                const response = await fetch(base + path, init);
                return { status: response.status, body: await response.text() };
            };
            const out = {
                health: await call("/health"),
                // The auth API's limiter counts in PostgreSQL (Step 5C); the
                // placeholder database is unreachable, so it fails closed.
                authWithoutLogin: await call("/auth/me"),
                // The admin API's limiter counts in PostgreSQL (Step 5C); the
                // placeholder database is unreachable, so it fails closed.
                adminWithUnreachableStore: await call("/api/admin/overview"),
                verifyGoodToken: await call("/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token-placeholder&hub.challenge=abc123"),
                verifyBadToken: await call("/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123"),
                unsignedPost: await call("/whatsapp/webhook", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
                hsts: (await fetch(base + "/health")).headers.get("strict-transport-security"),
            };
            await new Promise((resolve) => server.close(resolve));
            console.log(JSON.stringify(out));
        `);

        assert.equal(result.error, undefined, "the process did not end by itself");
        assert.equal(result.status, 0, result.stderr);
        const out = lastJsonLine(result.stdout);
        assert.equal(out.health.status, 200);
        assert.equal(JSON.parse(out.health.body).status, "OK");
        assert.deepEqual(out.authWithoutLogin, { status: 500, body: JSON.stringify({ message: "Internal server error" }) });
        assert.deepEqual(out.adminWithUnreachableStore, { status: 500, body: JSON.stringify({ message: "Internal server error" }) });
        assert.deepEqual(out.verifyGoodToken, { status: 200, body: "abc123" });
        assert.equal(out.verifyBadToken.status, 403);
        assert.equal(out.unsignedPost.status, 401);
        assert.ok(out.hsts, "security headers still applied");
    });

    test("an invalid environment throws on import instead of exiting the process", () => {
        const env = { ...PLACEHOLDER_ENV };
        delete env.JWT_SECRET;
        const result = runChild(`
            try {
                await import(${JSON.stringify(HANDLER_URL)});
                console.log(JSON.stringify({ threw: false }));
            } catch (error) {
                console.log(JSON.stringify({ threw: true, message: error.message }));
            }
        `, env);

        assert.equal(result.status, 0, "the handler must not call process.exit()");
        const out = lastJsonLine(result.stdout);
        assert.equal(out.threw, true);
        assert.match(out.message, /JWT_SECRET is missing/);
        assert.ok(!out.message.includes(PLACEHOLDER_ENV.SUPABASE_SERVICE_ROLE_KEY));
    });

    test("the handler module itself has no process lifecycle code", () => {
        const source = fs.readFileSync(new URL("../src/httpHandler.js", import.meta.url), "utf8")
            .split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
        for (const forbidden of [".listen(", "startSubmissionWorker", "createShutdown", "process.on(", "process.once(", "process.exit("]) {
            assert.ok(!source.includes(forbidden), `httpHandler.js must not contain ${forbidden}`);
        }
        // Same order as src/app.js: checks before anything that imports the Prisma client.
        assert.ok(source.indexOf("assertValidRuntime();") < source.indexOf('await import("./createApp.js")'));
        assert.ok(!/^import .*createApp|^import .*prisma/m.test(source), "no static import of the app or the client");
    });
});
