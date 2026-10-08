// Phase 12, Step 5D: vercel.json and the Vercel function entry (api/index.js).
//
// Vercel itself isn't run here. The routing checks apply vercel.json the way
// Vercel documents it: an existing static file is served first ("precedence
// is given to the filesystem prior to rewrites being applied"), then the
// first matching rewrite.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import express from "express";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const config = JSON.parse(read("vercel.json"));
const FUNCTION = "/api";

// The static files of an admin build, at the URLs they are served from.
const STATIC_FILES = new Set(["/admin/index.html", "/admin/assets/index-abc123.js", "/admin/favicon.svg"]);

// Where a request path ends up: a static file, the function, or 404.
function route(path) {
    if (STATIC_FILES.has(path)) return path;
    for (const { source, destination } of config.rewrites) {
        const match = new RegExp(`^${source}$`).exec(path);
        if (!match) continue;
        const target = destination.replace(/\$(\d)/g, (_, n) => match[Number(n)] ?? "");
        if (target === FUNCTION) return "function";
        return STATIC_FILES.has(target) ? target : 404;
    }
    return 404;
}

describe("Step 5D: Vercel entry point", () => {
    test("the function is api/index.js and it exports the HTTP handler, nothing else", () => {
        assert.deepEqual(Object.keys(config.functions), ["api/index.js"]);
        const entry = read("api/index.js").split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
        assert.deepEqual([...entry.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]), ["../src/httpHandler.js"]);
        assert.match(entry, /export default app;/);
        for (const forbidden of ["app.js", ".listen(", "startSubmissionWorker", "worker", "process.on("]) {
            assert.ok(!entry.includes(forbidden), `api/index.js must not contain ${forbidden}`);
        }
    });

    test("importing api/index.js gives a working handler and leaves nothing running", () => {
        // Child process with placeholder settings (never the real .env). A
        // listening server or the worker's poll loop would keep it alive
        // until the timeout.
        const entryUrl = new URL("../api/index.js", import.meta.url).href;
        const script = `
            import http from "node:http";
            const { default: handler } = await import(${JSON.stringify(entryUrl)});
            const server = http.createServer(handler);
            await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
            const base = "http://127.0.0.1:" + server.address().port;
            const health = await fetch(base + "/health");
            const verify = await fetch(base + "/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token-placeholder&hub.challenge=abc123");
            const out = { isHandler: typeof handler === "function", health: health.status, verify: await verify.text() };
            await new Promise((resolve) => server.close(resolve));
            console.log(JSON.stringify(out));
        `;
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
            env: {
                ...process.env,
                DOTENV_CONFIG_PATH: "does-not-exist.env",
                DOTENV_CONFIG_QUIET: "true",
                DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
                SUPABASE_URL: "http://127.0.0.1:1",
                SUPABASE_SERVICE_ROLE_KEY: "test-service-role-placeholder",
                SUPABASE_BUCKET: "test-bucket",
                META_APP_SECRET: "test-app-secret-placeholder",
                WHATSAPP_VERIFY_TOKEN: "test-verify-token-placeholder",
                WHATSAPP_ACCESS_TOKEN: "test-access-token-placeholder",
                WHATSAPP_API_VERSION: "v21.0",
                OCR_SERVICE_URL: "http://127.0.0.1:1",
            },
            encoding: "utf8",
            timeout: 30_000,
        });
        assert.equal(result.error, undefined, "the process did not end by itself");
        assert.equal(result.status, 0, result.stderr);
        const out = JSON.parse(result.stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1));
        assert.deepEqual(out, { isHandler: true, health: 200, verify: "abc123" });
        assert.ok(!result.stdout.includes("Server is running"));
        assert.ok(!result.stdout.includes("Submission worker running"));
    });

    test("framework auto-detection is off, so src/app.js is never picked as the entry", () => {
        // Vercel's zero-configuration Express detection looks for src/app.js
        // (and supports app.listen): "framework": null selects "Other".
        assert.ok(fs.existsSync(new URL("../src/app.js", import.meta.url)));
        assert.equal(config.framework, null);
        assert.equal(config.builds, undefined, "no legacy builds");
        for (const name of ["server.js", "src/server.js", "index.js", "src/index.js", "app.js"]) {
            assert.ok(!fs.existsSync(new URL(`../${name}`, import.meta.url)), `${name} would be auto-detected as a server entry`);
        }
    });

    test("the function bundle includes the generated Prisma client and its runtime", () => {
        const { includeFiles, maxDuration } = config.functions["api/index.js"];
        assert.match(includeFiles, /generated\/prisma\/\*\*/);
        assert.match(includeFiles, /node_modules\/@prisma\/client\/runtime\/\*\*/);
        assert.ok(Number.isInteger(maxDuration) && maxDuration >= 1 && maxDuration <= 60);
    });

    test("no secrets, environment values or CORS in vercel.json", () => {
        assert.equal(config.env, undefined);
        assert.equal(config.build, undefined);
        const text = read("vercel.json");
        assert.ok(!/access-control-/i.test(text), "no CORS headers: everything is same-origin");
        assert.ok(!/(secret|token|password|postgresql:\/\/)/i.test(text));
    });
});

describe("Step 5D: routing", () => {
    test("every backend route mounted by the Express app reaches the function", () => {
        // The mounts in src/createApp.js, except /admin (static on Vercel).
        const source = read("src/createApp.js");
        const mounts = [...source.matchAll(/app\.(?:use|get)\("(\/[a-z/]+)"/g)].map((m) => m[1]).filter((m) => m !== "/admin");
        assert.deepEqual(mounts.sort(), ["/api/admin", "/auth", "/health", "/whatsapp"]);

        for (const path of [
            "/auth/login", "/auth/me", "/auth/logout", "/auth/forgot-password",
            "/api/admin/overview", "/api/admin/review/DOC-1/file", "/api/admin/temporary-documents/abc",
            "/whatsapp/webhook", "/health",
        ]) {
            assert.equal(route(path), "function", path);
        }
    });

    test("the admin app is static: pages, client-side routes and assets never reach the function", () => {
        for (const path of ["/admin", "/admin/", "/admin/login", "/admin/review", "/admin/review/DOC-1", "/admin/clients/N1234567"]) {
            assert.equal(route(path), "/admin/index.html", path);
        }
        assert.equal(route("/admin/assets/index-abc123.js"), "/admin/assets/index-abc123.js");
        assert.equal(route("/admin/favicon.svg"), "/admin/favicon.svg");
        // Like Express: a missing asset is a 404, never the app page.
        assert.equal(route("/admin/assets/missing.js"), 404);
    });

    test("nothing else is served: no root page, no source files", () => {
        for (const path of ["/", "/src/app.js", "/src/worker.js", "/package.json", "/.env", "/prisma/schema.prisma"]) {
            assert.equal(route(path), 404, path);
        }
        assert.equal(config.outputDirectory, "public", "only the build output is static, not the repository");
    });

    test("rewrites stay inside this deployment and don't add query parameters", () => {
        for (const { source, destination } of config.rewrites) {
            assert.ok(destination.startsWith("/"), `${destination}: no external origin, so cookies stay same-origin`);
            // Named parameters (:name) are passed on in the query string.
            assert.ok(!source.includes(":"), `${source}: no named parameters`);
        }
    });

    test("the build writes the admin app where the routes expect it", () => {
        assert.match(config.buildCommand, /npm --prefix admin run build -- --outDir \.\.\/public\/admin --emptyOutDir/);
        assert.match(config.installCommand, /npm ci && npm --prefix admin (ci|install)/);
        assert.match(read("admin/vite.config.ts"), /base: "\/admin\/"/);
        assert.match(read("admin/src/basePath.ts"), /APP_BASE_PATH = "\/admin"/);
        assert.match(read("admin/src/main.tsx"), /basename=\{APP_BASE_PATH\}/);
        assert.match(read(".gitignore"), /^\/public\/$/m);
    });
});

describe("Step 5D: headers", () => {
    const headersFor = (source) => Object.fromEntries(
        config.headers.find((h) => h.source === source).headers.map(({ key, value }) => [key.toLowerCase(), value]));

    test("static admin pages get the same security headers Express (helmet) sends", async () => {
        Object.assign(process.env, {
            SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "test-service-role-placeholder",
            DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test", META_APP_SECRET: "test-app-secret-placeholder",
        });
        const { createApp } = await import("../src/createApp.js");
        const server = await new Promise((resolve) => { const s = createApp().listen(0, "127.0.0.1", () => resolve(s)); });
        try {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
            const notSecurity = new Set(["content-type", "content-length", "etag", "date", "connection", "keep-alive"]);
            const fromExpress = Object.fromEntries([...response.headers].filter(([key]) => !notSecurity.has(key)));
            assert.ok(fromExpress["content-security-policy"], "helmet is active");
            assert.deepEqual(headersFor("/admin(.*)"), fromExpress);
        } finally {
            server.close();
        }
    });

    test("hashed assets are cached like Express serves them (1 year, immutable)", () => {
        assert.deepEqual(headersFor("/admin/assets/(.*)"), { "cache-control": "public, max-age=31536000, immutable" });
    });
});

describe("Step 5D: TRUST_PROXY_HOPS=1 on Vercel", () => {
    // Vercel sets x-forwarded-for to the client's public IP and overwrites
    // anything the client sent (Vercel docs, Request headers). One hop: Express
    // takes the address the platform's proxy wrote.
    test("with one trusted hop, req.ip is the address the platform wrote, not the proxy's", async () => {
        const { trustProxyHops } = await import("../src/config/env.js");
        const app = express();
        app.set("trust proxy", trustProxyHops("1"));
        app.get("/ip", (req, res) => res.json({ ip: req.ip }));
        const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
        try {
            const url = `http://127.0.0.1:${server.address().port}/ip`;
            const viaProxy = await (await fetch(url, { headers: { "x-forwarded-for": "203.0.113.7" } })).json();
            assert.equal(viaProxy.ip, "203.0.113.7");
            const direct = await (await fetch(url)).json();
            assert.match(direct.ip, /127\.0\.0\.1/, "without the header: the connecting address");
        } finally {
            server.close();
        }
    });
});
