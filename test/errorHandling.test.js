import { describe, test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { errorHandler } from "../src/middleware/errorHandler.js";

// Placeholders so the app's modules load without real credentials. dotenv
// never overrides variables that are already set, so these win over .env.
// None of the requests below reach the database or Supabase.
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-placeholder";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.META_APP_SECRET = "test-app-secret-placeholder";

const { createApp } = await import("../src/createApp.js");
const { createAuthRouter } = await import("../src/routes/auth.js");
const { createApiRateLimiter } = await import("../src/middleware/apiRateLimiter.js");
const { MemoryStore } = await import("express-rate-limit");

// The real auth routes and their limiter; the limiter counts in memory here
// (its default store is PostgreSQL, which these tests don't have).
const appWithMemoryLimiter = () => createApp({
    authRouter: createAuthRouter({ apiLimiter: createApiRateLimiter({ store: new MemoryStore() }) }),
});

// Anything that would reveal internals if it appeared in a response.
const LEAK_PATTERNS = [
    /node_modules/i,
    /SyntaxError/,
    /\bat\s+\S+\s+\(/,          // stack frame: "at parse (…)"
    /[A-Za-z]:\\/,               // Windows path
    /\/(Users|home|usr|var)\//,  // Unix-style path
    /<pre>|<html/i,              // Express's HTML error page
    /entity\.(parse|too)/,       // body-parser internals
];

function assertNoLeaks(text) {
    for (const pattern of LEAK_PATTERNS) {
        assert.doesNotMatch(text, pattern, `response leaks ${pattern}`);
    }
}

async function startServer(app) {
    return new Promise((resolve) => {
        const server = app.listen(0, "127.0.0.1", () => {
            resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
        });
    });
}

async function post(baseUrl, path, body, headers = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
    });
    return { status: response.status, contentType: response.headers.get("content-type"), text: await response.text() };
}

// Capture console.error so tests can check what gets logged, and keep the
// test output quiet.
let logged;
let realConsoleError;
beforeEach(() => {
    logged = [];
    realConsoleError = console.error;
    console.error = (...args) => logged.push(args);
});
afterEach(() => {
    console.error = realConsoleError;
});

describe("error responses from the real app", () => {
    let server;
    let baseUrl;
    let savedNodeEnv;

    before(async () => {
        savedNodeEnv = process.env.NODE_ENV;
        delete process.env.NODE_ENV; // must be safe even without NODE_ENV=production
        ({ server, baseUrl } = await startServer(appWithMemoryLimiter()));
    });

    after(() => {
        server.close();
        process.env.NODE_ENV = savedNodeEnv;
    });

    test("1. malformed JSON to /auth/complete-invite -> 400 JSON, nothing leaked", async () => {
        const result = await post(baseUrl, "/auth/complete-invite", '{"email": "a", bad json');

        assert.equal(result.status, 400);
        assert.match(result.contentType, /application\/json/);
        assert.deepEqual(JSON.parse(result.text), { message: "Invalid request body" });
        assertNoLeaks(result.text);
    });

    test("2. malformed JSON to /whatsapp/webhook -> 400 JSON, nothing leaked (with or without a signature)", async () => {
        for (const headers of [{}, { "X-Hub-Signature-256": `sha256=${"0".repeat(64)}` }]) {
            const result = await post(baseUrl, "/whatsapp/webhook", "{not json", headers);

            assert.equal(result.status, 400);
            assert.deepEqual(JSON.parse(result.text), { message: "Invalid request body" });
            assertNoLeaks(result.text);
        }
    });

    test("3. oversized JSON body -> 413 JSON, nothing leaked", async () => {
        const oversized = JSON.stringify({ padding: "a".repeat(200_000) }); // default limit is 100 kB

        for (const path of ["/whatsapp/webhook", "/auth/complete-invite"]) {
            const result = await post(baseUrl, path, oversized);

            assert.equal(result.status, 413, path);
            assert.deepEqual(JSON.parse(result.text), { message: "Request payload too large" });
            assertNoLeaks(result.text);
        }
    });

    test("4. the log line has safe metadata only: no body, message or stack", async () => {
        await post(baseUrl, "/auth/complete-invite", '{"email": "person@example.invalid", "password": "hunter2", broken');

        assert.equal(logged.length, 1);
        const [label, details] = logged[0];
        assert.equal(label, "Request failed:");
        assert.deepEqual(details, { method: "POST", path: "/auth/complete-invite", status: 400, type: "entity.parse.failed" });

        const serialized = JSON.stringify(logged);
        assert.ok(!serialized.includes("person@example.invalid"));
        assert.ok(!serialized.includes("hunter2"));
        assert.doesNotMatch(serialized, /node_modules|SyntaxError/);
    });

    test("valid JSON still reaches the routes normally", async () => {
        const result = await post(baseUrl, "/auth/complete-invite", "{}");

        // Reaches the route's own checks: no Supabase session -> 401.
        assert.equal(result.status, 401);
        assert.deepEqual(JSON.parse(result.text), { message: "Authentication Token is required!" });
    });

    test("health check unchanged", async () => {
        const response = await fetch(`${baseUrl}/health`);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).status, "OK");
    });
});

describe("errorHandler with other errors", () => {
    // A small app with the same handler, to trigger errors the real routes
    // don't throw on purpose.
    function appThatThrows(error) {
        const app = express();
        app.get("/boom", () => { throw error; });
        app.get("/async-boom", async () => { throw error; });
        app.use(errorHandler);
        return app;
    }

    test("5. unexpected internal error -> 500 generic JSON; message and stack never sent", async () => {
        const error = new Error("database password=hunter2 failed at C:\\Users\\someone\\app\\db.js:10");
        const { server, baseUrl } = await startServer(appThatThrows(error));

        try {
            for (const path of ["/boom", "/async-boom"]) {
                const response = await fetch(`${baseUrl}${path}`);
                const text = await response.text();

                assert.equal(response.status, 500, path);
                assert.deepEqual(JSON.parse(text), { message: "Internal server error" });
                assert.ok(!text.includes("hunter2"));
                assertNoLeaks(text);
            }
            assert.ok(!JSON.stringify(logged).includes("hunter2"), "error message must not be logged");
        } finally {
            server.close();
        }
    });

    test("safe with NODE_ENV=production too", async () => {
        const saved = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
        const { server, baseUrl } = await startServer(appThatThrows(new Error("secret detail")));

        try {
            const response = await fetch(`${baseUrl}/boom`);
            assert.equal(response.status, 500);
            assert.deepEqual(await response.json(), { message: "Internal server error" });
        } finally {
            server.close();
            process.env.NODE_ENV = saved;
        }
    });

    test("a client error from anywhere else is not mistaken for a body error", async () => {
        const notFoundLike = Object.assign(new Error("Not found in DB"), { status: 404 }); // no `type`
        const { server, baseUrl } = await startServer(appThatThrows(notFoundLike));

        try {
            const response = await fetch(`${baseUrl}/boom`);
            assert.equal(response.status, 500);
        } finally {
            server.close();
        }
    });

    // Mirrors how a real P2010 reaches this handler in production: the login
    // and forgot-password rate limiters run as middleware, before the route
    // handler's own try/catch, so a failing $queryRaw in
    // postgresRateLimitStore.js surfaces here, not in src/routes/auth.js.
    test("a raw-query Prisma error (P2010) from middleware -> still a generic 500, log gains the SQLSTATE", async () => {
        const error = Object.assign(new Error("Raw query failed. Code: `42501`. Message: `permission denied for table \"rate_limits\"`"), {
            name: "PrismaClientKnownRequestError",
            code: "P2010",
            meta: { code: "42501", message: 'permission denied for table "rate_limits"' },
        });
        const { server, baseUrl } = await startServer(appThatThrows(error));

        try {
            const response = await fetch(`${baseUrl}/boom`);
            const text = await response.text();

            assert.equal(response.status, 500);
            assert.deepEqual(JSON.parse(text), { message: "Internal server error" });
            assert.ok(!text.includes("permission denied"));

            assert.equal(logged.length, 1);
            const [label, details] = logged[0];
            assert.equal(label, "Request failed:");
            assert.equal(details.prismaCode, "P2010");
            assert.deepEqual(details.prismaMeta, {
                dbMetaKeys: ["code", "message"],
                dbErrorCode: "42501",
                dbErrorMessage: "permission denied for table [redacted]",
            });

            // The driver message is now intentionally logged (as dbErrorMessage,
            // diagnostic-only), but redacted/truncated via safeErrorText: no
            // quoted value from it survives.
            const serialized = JSON.stringify(logged);
            assert.ok(!serialized.includes('"rate_limits"'), "a quoted value from the driver message must be redacted");
        } finally {
            server.close();
        }
    });
});
