import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { findEnvProblems, assertValidEnv, trustProxyHops, REQUIRED_ENV_VARS } from "../src/config/env.js";

// Synthetic placeholders only.
const VALID_ENV = Object.freeze({
    DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-placeholder",
    SUPABASE_BUCKET: "test-bucket",
    JWT_SECRET: "test-jwt-secret-placeholder-0123456789",
    META_APP_SECRET: "test-app-secret-placeholder",
    WHATSAPP_VERIFY_TOKEN: "test-verify-token-placeholder",
    WHATSAPP_ACCESS_TOKEN: "test-access-token-placeholder",
    WHATSAPP_API_VERSION: "v21.0",
});

Object.assign(process.env, VALID_ENV);
const { createApp } = await import("../src/createApp.js");

describe("startup environment check (SEC-019)", () => {
    test("a complete environment passes", () => {
        assert.deepEqual(findEnvProblems(VALID_ENV), []);
        assert.doesNotThrow(() => assertValidEnv(VALID_ENV));
    });

    test("each missing variable is reported by name", () => {
        for (const name of REQUIRED_ENV_VARS) {
            const env = { ...VALID_ENV };
            delete env[name];
            assert.deepEqual(findEnvProblems(env), [`${name} is missing`]);
            assert.deepEqual(findEnvProblems({ ...VALID_ENV, [name]: "   " }), [`${name} is missing`]);
        }
    });

    test("malformed values are reported without their contents", () => {
        const env = {
            ...VALID_ENV,
            JWT_SECRET: "short-secret-value",
            DATABASE_URL: "mysql://secret-db-password@host/db",
            SUPABASE_URL: "not a url secret-value",
            WHATSAPP_API_VERSION: "latest",
            PORT: "http",
            TRUST_PROXY_HOPS: "true",
        };
        const problems = findEnvProblems(env);
        assert.equal(problems.length, 6);

        let message = "";
        try { assertValidEnv(env); } catch (error) { message = error.message; }
        for (const value of ["short-secret-value", "secret-db-password", "secret-value", "latest"]) {
            assert.ok(!message.includes(value), `message contains ${value}`);
        }
    });

    test("TRUST_PROXY_HOPS: unset trusts nothing; only a small whole number is accepted", () => {
        assert.equal(trustProxyHops(undefined), null);
        assert.equal(trustProxyHops(""), null);
        assert.equal(trustProxyHops("1"), 1);
        for (const bad of ["true", "yes", "-1", "1.5", "11", "loopback"]) {
            assert.throws(() => trustProxyHops(bad), /TRUST_PROXY_HOPS/);
        }
    });

    test("the server exits at startup, naming only the missing variables", () => {
        const appPath = fileURLToPath(new URL("../src/app.js", import.meta.url));
        const env = { ...process.env, ...VALID_ENV, DOTENV_CONFIG_PATH: "does-not-exist.env", DOTENV_CONFIG_QUIET: "true" };
        delete env.JWT_SECRET;
        delete env.META_APP_SECRET;

        // DOTENV_CONFIG_PATH points dotenv away from the real .env.
        const result = spawnSync(process.execPath, [appPath], {
            env,
            encoding: "utf8",
            timeout: 30_000,
        });

        assert.equal(result.status, 1);
        assert.match(result.stderr, /JWT_SECRET is missing/);
        assert.match(result.stderr, /META_APP_SECRET is missing/);
        assert.ok(!result.stderr.includes(VALID_ENV.SUPABASE_SERVICE_ROLE_KEY));
        assert.ok(!result.stdout.includes("Server is running"));
    });
});

describe("HTTP hardening (SEC-015)", () => {
    const app = createApp();
    let server;
    before(() => new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); }));
    after(() => server.close());
    const url = (path) => `http://127.0.0.1:${server.address().port}${path}`;

    test("no X-Powered-By header", async () => {
        const response = await fetch(url("/health"));
        assert.equal(response.headers.get("x-powered-by"), null);
    });

    test("standard security headers are set", async () => {
        const response = await fetch(url("/health"));
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
        assert.match(response.headers.get("strict-transport-security") ?? "", /max-age=\d+/);
        assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    });

    test("headers are also set on errors", async () => {
        const response = await fetch(url("/auth/login"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad" });
        assert.equal(response.status, 400);
        assert.equal(response.headers.get("x-powered-by"), null);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    });

    test("proxy headers are not trusted by default", () => {
        assert.equal(app.get("trust proxy"), false);
    });
});
