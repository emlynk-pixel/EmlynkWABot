// Phase 12, Step 5C: rate-limit counts in PostgreSQL, shared by every app
// instance (several serverless instances on Vercel).
//
// The concurrency, persistence and window tests need a real PostgreSQL with
// the migrations applied — never production. They run only when
// RATE_LIMIT_TEST_DATABASE_URL is set, e.g. a throwaway container:
//
//   docker run -d --name emlynk-ratelimit-test -p 127.0.0.1:55432:5432 \
//     -e POSTGRES_PASSWORD=testpw -e POSTGRES_DB=ratelimit_test postgres:16
//   (create roles anon, authenticated; then with that URL as DATABASE_URL:
//    npx prisma migrate deploy)
//   RATE_LIMIT_TEST_DATABASE_URL=postgresql://postgres:testpw@127.0.0.1:55432/ratelimit_test \
//     node --test test/postgresRateLimitStore.test.js
//
// "Two instances" below are two separately created limiters/apps sharing only
// the database, as two Vercel instances would.
import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";

import { createPostgresRateLimitStore } from "../src/middleware/postgresRateLimitStore.js";
import { createLoginRateLimiter, LOGIN_RATE_LIMIT_MESSAGE } from "../src/middleware/loginRateLimiter.js";
import { createApiRateLimiter, API_RATE_LIMIT_MESSAGE } from "../src/middleware/apiRateLimiter.js";

const TEST_DB_URL = process.env.RATE_LIMIT_TEST_DATABASE_URL;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------ without a database

describe("PostgreSQL rate-limit store: cost and shape (no database)", () => {
    // Records the statements the store sends.
    function recordingDb() {
        const calls = [];
        const sql = (strings) => strings.join("?").replace(/\s+/g, " ").trim();
        return {
            calls,
            $queryRaw: async (strings) => { calls.push(sql(strings)); return [{ hits: 1, reset_at: new Date(Date.now() + 60_000) }]; },
            $executeRaw: async (strings) => { calls.push(sql(strings)); return 0; },
        };
    }

    test("one statement per counted request; cleanup at most once per window", async () => {
        const db = recordingDb();
        const store = createPostgresRateLimitStore({ prefix: "t:", db });
        store.init({ windowMs: 60_000 });

        for (let i = 0; i < 10; i++) await store.increment("client");

        const upserts = db.calls.filter((s) => s.startsWith("INSERT INTO \"public\".\"rate_limits\""));
        const cleanups = db.calls.filter((s) => s.startsWith("DELETE FROM \"public\".\"rate_limits\" WHERE \"reset_at\""));
        assert.equal(upserts.length, 10);
        assert.equal(cleanups.length, 1, "cleanup ran once, not per request");
        assert.equal(db.calls.length, 11, "no other queries");
        assert.ok(db.calls.every((s) => /"rate_limits"/.test(s)), "no other table is touched");
    });

    test("a failing cleanup doesn't fail the request", async () => {
        const db = recordingDb();
        db.$executeRaw = async () => { throw new Error("cleanup down"); };
        const store = createPostgresRateLimitStore({ prefix: "t:", db, log: { error() {} } });
        store.init({ windowMs: 60_000 });
        assert.equal((await store.increment("client")).totalHits, 1);
    });

    test("no counts in module memory; no raw client key in the row key", () => {
        const source = fs.readFileSync(new URL("../src/middleware/postgresRateLimitStore.js", import.meta.url), "utf8");
        assert.ok(!/new (Map|Set)\(/.test(source), "no Map/Set of counts");
        assert.ok(source.includes("sha256Hex"), "the client key is hashed");
    });
});

// ------------------------------------------------ with a real database

describe("PostgreSQL rate-limit store (real database)", { skip: !TEST_DB_URL && "set RATE_LIMIT_TEST_DATABASE_URL to run" }, () => {
    let db;
    before(async () => {
        const { PrismaClient } = await import("../generated/prisma/client.ts");
        const { PrismaPg } = await import("@prisma/adapter-pg");
        db = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_DB_URL }) });
    });
    after(() => db?.$disconnect());
    beforeEach(() => db.$executeRaw`DELETE FROM "rate_limits"`);

    const newStore = (prefix = "t:", windowMs = 60_000) => {
        const store = createPostgresRateLimitStore({ prefix, db });
        store.init({ windowMs });
        return store;
    };

    // One app = one "instance": its own limiter object, the shared database.
    async function startInstance(mount) {
        const app = express();
        app.use(express.json());
        mount(app);
        const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
        return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
    }

    describe("store", () => {
        test("counts up within a window, with the window's end time", async () => {
            const store = newStore();
            const first = await store.increment("client-a");
            const second = await store.increment("client-a");
            assert.equal(first.totalHits, 1);
            assert.equal(second.totalHits, 2);
            assert.equal(second.resetTime.getTime(), first.resetTime.getTime(), "fixed window: the end doesn't move");
            assert.ok(first.resetTime.getTime() > Date.now());
        });

        test("concurrent increments from two instances never share a count", async () => {
            const [a, b] = [newStore(), newStore()];
            const results = await Promise.all(Array.from({ length: 60 }, (_, i) => (i % 2 ? a : b).increment("client-a")));
            const hits = results.map((r) => r.totalHits).sort((x, y) => x - y);
            assert.deepEqual(hits, Array.from({ length: 60 }, (_, i) => i + 1), "each request got its own count 1..60");
        });

        test("keys and limiters are isolated", async () => {
            const login = newStore("login:");
            const api = newStore("generic-api:");
            await login.increment("client-a");
            await login.increment("client-a");
            assert.equal((await login.increment("client-b")).totalHits, 1, "another client");
            assert.equal((await api.increment("client-a")).totalHits, 1, "another limiter, same client");
            assert.equal((await login.increment("client-a")).totalHits, 3);
        });

        test("a new instance continues the same count (nothing kept in process memory)", async () => {
            await newStore().increment("client-a");
            await newStore().increment("client-a");
            assert.equal((await newStore().increment("client-a")).totalHits, 3);
        });

        test("the window resets after it has passed", async () => {
            const store = newStore("t:", 400);
            await store.increment("client-a");
            await store.increment("client-a");
            await sleep(500);
            const next = await store.increment("client-a");
            assert.equal(next.totalHits, 1);
            assert.ok(next.resetTime.getTime() > Date.now());
        });

        test("decrement: within the window only, never below 0; resetKey clears", async () => {
            const store = newStore();
            await store.increment("client-a");
            await store.increment("client-a");
            await store.decrement("client-a");
            await store.decrement("client-a");
            await store.decrement("client-a");
            assert.equal((await store.increment("client-a")).totalHits, 1);
            await store.resetKey("client-a");
            assert.equal((await store.increment("client-a")).totalHits, 1);
        });

        test("expired rows are deleted by the cleanup; live rows stay", async () => {
            await newStore("old:", 100).increment("gone");
            await sleep(200);
            await newStore("t:", 60_000).increment("live"); // a fresh store: its first count runs the cleanup
            const rows = await db.$queryRaw`SELECT "key" FROM "rate_limits" ORDER BY "key"`;
            assert.equal(rows.length, 1);
            assert.ok(rows[0].key.startsWith("t:"));
        });

        test("no IP address is stored", async () => {
            await newStore("login:").increment("127.0.0.1");
            const [row] = await db.$queryRaw`SELECT "key" FROM "rate_limits"`;
            assert.ok(!row.key.includes("127.0.0.1"));
            assert.match(row.key, /^login:[0-9a-f]{64}$/);
        });
    });

    describe("login limiter (5 failures / window) across two instances", () => {
        // A login handler that always fails (401), like a wrong password.
        const failingLogin = (limiter) => (app) => app.post("/login", limiter, (req, res) => res.status(401).json({ message: "Invalid email or password" }));

        test("20 concurrent failed attempts: exactly 5 reach the login, 15 are limited with the same response as before", async () => {
            const one = await startInstance(failingLogin(createLoginRateLimiter({ store: createPostgresRateLimitStore({ prefix: "login:", db }) })));
            const two = await startInstance(failingLogin(createLoginRateLimiter({ store: createPostgresRateLimitStore({ prefix: "login:", db }) })));
            try {
                const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => fetch(`${(i % 2 ? one : two).url}/login`, { method: "POST" })));
                const statuses = responses.map((r) => r.status);
                assert.equal(statuses.filter((s) => s === 401).length, 5);
                assert.equal(statuses.filter((s) => s === 429).length, 15);
                const limited = responses.find((r) => r.status === 429);
                const body = await limited.json();
                assert.equal(body.message, LOGIN_RATE_LIMIT_MESSAGE);
                assert.match(limited.headers.get("ratelimit-policy"), /q=5\b/);
                assert.match(limited.headers.get("ratelimit-policy"), /w=300\b/);
            } finally {
                await one.close();
                await two.close();
            }
        });

        test("successful logins are not counted (skipSuccessfulRequests), across instances", async () => {
            const ok = (limiter) => (app) => app.post("/login", limiter, (req, res) => res.status(200).json({ ok: true }));
            const one = await startInstance(ok(createLoginRateLimiter({ store: createPostgresRateLimitStore({ prefix: "login:", db }) })));
            const two = await startInstance(ok(createLoginRateLimiter({ store: createPostgresRateLimitStore({ prefix: "login:", db }) })));
            try {
                for (let i = 0; i < 12; i++) {
                    const response = await fetch(`${(i % 2 ? one : two).url}/login`, { method: "POST" });
                    assert.equal(response.status, 200);
                }
            } finally {
                await one.close();
                await two.close();
            }
        });

        test("the window resets", async () => {
            const limiter = createLoginRateLimiter({ windowMs1: 1_000, windowMs2: 1_000, store1: createPostgresRateLimitStore({ prefix: "login:t1:", db }), store2: createPostgresRateLimitStore({ prefix: "login:t2:", db }) });
            const one = await startInstance(failingLogin(limiter));
            try {
                for (let i = 0; i < 5; i++) assert.equal((await fetch(`${one.url}/login`, { method: "POST" })).status, 401);
                assert.equal((await fetch(`${one.url}/login`, { method: "POST" })).status, 429);
                await sleep(1_200);
                assert.equal((await fetch(`${one.url}/login`, { method: "POST" })).status, 401);
            } finally {
                await one.close();
            }
        });
    });

    describe("API limiter across two instances", () => {
        const api = (limiter) => (app) => app.get("/api", limiter, (req, res) => res.json({ ok: true }));

        test("concurrent requests can't pass the limit; the response is the same as before", async () => {
            const make = () => createApiRateLimiter({ limit: 10, store: createPostgresRateLimitStore({ prefix: "generic-api:", db }) });
            const one = await startInstance(api(make()));
            const two = await startInstance(api(make()));
            try {
                const responses = await Promise.all(Array.from({ length: 30 }, (_, i) => fetch(`${(i % 2 ? one : two).url}/api`)));
                assert.equal(responses.filter((r) => r.status === 200).length, 10);
                const limited = responses.filter((r) => r.status === 429);
                assert.equal(limited.length, 20);
                assert.deepEqual(await limited[0].json(), { message: API_RATE_LIMIT_MESSAGE });
            } finally {
                await one.close();
                await two.close();
            }
        });

        test("the default policy is unchanged: 1000 per 15 minutes", async () => {
            const one = await startInstance(api(createApiRateLimiter({ store: createPostgresRateLimitStore({ prefix: "generic-api:", db }) })));
            try {
                const response = await fetch(`${one.url}/api`);
                assert.equal(response.status, 200);
                assert.match(response.headers.get("ratelimit-policy"), /q=1000\b/);
                assert.match(response.headers.get("ratelimit-policy"), /w=900\b/);
            } finally {
                await one.close();
            }
        });

        test("the window resets", async () => {
            const one = await startInstance(api(createApiRateLimiter({ limit: 2, windowMs: 1_000, store: createPostgresRateLimitStore({ prefix: "generic-api:", db }) })));
            try {
                assert.equal((await fetch(`${one.url}/api`)).status, 200);
                assert.equal((await fetch(`${one.url}/api`)).status, 200);
                assert.equal((await fetch(`${one.url}/api`)).status, 429);
                await sleep(1_200);
                assert.equal((await fetch(`${one.url}/api`)).status, 200);
            } finally {
                await one.close();
            }
        });
    });
});
