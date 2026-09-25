import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAuthRouter, ACTIVE_ADMIN_STATUS } from "../src/routes/auth.js";
import { hashPassword } from "../src/utils/password.js";
import { createFakeAdminDb, noRateLimit } from "./helpers/fakeAdminDb.js";

// Placeholders so the app's modules load without real credentials.
Object.assign(process.env, {
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-placeholder",
    DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
    META_APP_SECRET: "test-app-secret-placeholder",
    JWT_SECRET: "test-jwt-secret-placeholder-0123456789",
});
const { createApp } = await import("../src/createApp.js");

// A stand-in admin build: index.html, one hashed asset, one public file.
function fakeBuild() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-dist-"));
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "index.html"), '<!doctype html><div id="root"></div><script type="module" src="/admin/assets/index-abc123.js"></script>');
    fs.writeFileSync(path.join(dir, "assets", "index-abc123.js"), "console.log('admin');");
    fs.writeFileSync(path.join(dir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    return dir;
}

async function start(app) {
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    return { server, url: (p) => `http://127.0.0.1:${server.address().port}${p}` };
}

describe("admin dashboard static serving (/admin)", () => {
    let dist;
    let http;
    before(async () => {
        dist = fakeBuild();
        http = await start(createApp({ adminDistDir: dist }));
    });
    after(() => {
        http.server.close();
        fs.rmSync(dist, { recursive: true, force: true });
    });

    test("/admin and /admin/ serve the app page, never cached", async () => {
        for (const p of ["/admin", "/admin/"]) {
            const response = await fetch(http.url(p));
            assert.equal(response.status, 200, p);
            assert.match(response.headers.get("content-type"), /text\/html/);
            assert.equal(response.headers.get("cache-control"), "no-cache");
            assert.match(await response.text(), /<div id="root">/);
        }
    });

    test("client-side routes fall back to the app page (reload on /admin/review works)", async () => {
        for (const p of ["/admin/login", "/admin/review", "/admin/clients/N1234567", "/admin/police?x=1"]) {
            const response = await fetch(http.url(p));
            assert.equal(response.status, 200, p);
            assert.match(await response.text(), /<div id="root">/);
        }
    });

    test("hashed assets are served with long-term caching", async () => {
        const response = await fetch(http.url("/admin/assets/index-abc123.js"));
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /javascript/);
        assert.match(response.headers.get("cache-control"), /max-age=31536000/);
        assert.match(response.headers.get("cache-control"), /immutable/);
    });

    test("a missing asset is a 404, not the app page", async () => {
        const response = await fetch(http.url("/admin/assets/missing-000.js"));
        assert.equal(response.status, 404);
        assert.doesNotMatch(await response.text(), /<div id="root">/);
    });

    test("public files are served", async () => {
        const response = await fetch(http.url("/admin/favicon.svg"));
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /svg/);
    });

    test("no path traversal out of the build folder", async () => {
        for (const p of ["/admin/..%2F..%2Fpackage.json", "/admin/assets/..%2F..%2F..%2F.env", "/admin/%2e%2e/%2e%2e/package.json"]) {
            const response = await fetch(http.url(p));
            const text = await response.text();
            assert.ok(!text.includes('"dependencies"'), p);
            assert.ok(!text.includes("JWT_SECRET"), p);
        }
    });

    test("security headers apply to the dashboard too", async () => {
        const response = await fetch(http.url("/admin/"));
        assert.equal(response.headers.get("x-powered-by"), null);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
    });

    test("only GET/HEAD serve the app; other methods do not", async () => {
        const response = await fetch(http.url("/admin/review"), { method: "POST" });
        assert.notEqual(response.status, 200);
    });

    test("the API routes are unaffected", async () => {
        assert.equal((await fetch(http.url("/health"))).status, 200);
        assert.equal((await fetch(http.url("/auth/me"))).status, 401);
    });
});

describe("admin dashboard not built", () => {
    test("/admin explains how to build it instead of failing", async () => {
        const http = await start(createApp({ adminDistDir: path.join(os.tmpdir(), "no-such-admin-dist-xyz") }));
        try {
            const response = await fetch(http.url("/admin/"));
            assert.equal(response.status, 404);
            assert.deepEqual(await response.json(), { message: "Admin dashboard is not built. Run: npm run admin:build" });
        } finally {
            http.server.close();
        }
    });
});

describe("dashboard login flow against the real auth routes (same origin)", () => {
    let dist;
    let http;
    const PASSWORD = "Correct-Horse-7";

    before(async () => {
        dist = fakeBuild();
        const db = createFakeAdminDb([
            { adminId: "admin-1", name: "Test Admin", email: "admin@example.invalid", passwordHash: await hashPassword(PASSWORD), role: "ADMIN", status: ACTIVE_ADMIN_STATUS },
        ]);
        http = await start(createApp({ adminDistDir: dist, authRouter: createAuthRouter({ db, loginLimiter: noRateLimit }) }));
    });
    after(() => {
        http.server.close();
        fs.rmSync(dist, { recursive: true, force: true });
    });

    test("page -> POST /auth/login -> GET /auth/me with the Bearer token", async () => {
        assert.equal((await fetch(http.url("/admin/login"))).status, 200);

        const login = await fetch(http.url("/auth/login"), {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ email: "admin@example.invalid", password: PASSWORD }),
        });
        assert.equal(login.status, 200);
        const { token } = await login.json();
        assert.equal(typeof token, "string");

        const me = await fetch(http.url("/auth/me"), { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(me.status, 200);
        const { admin } = await me.json();
        assert.equal(admin.name, "Test Admin");
        assert.equal(admin.passwordHash, undefined);
    });

    test("wrong password -> the generic 401 the login page shows", async () => {
        const login = await fetch(http.url("/auth/login"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "admin@example.invalid", password: "wrong-password" }),
        });
        assert.equal(login.status, 401);
        assert.deepEqual(await login.json(), { message: "Invalid email or password" });
    });
});
