// Tests for GET /api/admin/candidates rate limiter and local load-test bypass (LOAD_TEST_MODE=true).
// Proves:
//   1. Normal mode (LOAD_TEST_MODE unset or "false") still rate-limits requests.
//   2. Load-test mode (LOAD_TEST_MODE="true") bypasses the admin API rate limiter.
//   3. Auth and RBAC authorization are strictly preserved under load-test mode.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { MemoryStore } from "express-rate-limit";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { createFakeVerifier, tokenFor, authIdFor } from "./helpers/fakeSupabaseAuth.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createApiRateLimiter, API_RATE_LIMIT_MESSAGE } from "../src/middleware/apiRateLimiter.js";
import { createRequireActiveUser, AUTH_REQUIRED, INVALID_TOKEN, ACCOUNT_NOT_ACTIVE } from "../src/middleware/requireActiveUser.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

const ADMIN_USER = {
    adminId: "user-admin",
    authUserId: authIdFor("user-admin"),
    name: "Admin User",
    email: "admin@example.invalid",
    role: "ADMIN",
    status: "ACTIVE",
};

const INACTIVE_USER = {
    adminId: "user-inactive",
    authUserId: authIdFor("user-inactive"),
    name: "Inactive User",
    email: "inactive@example.invalid",
    role: "ADMIN",
    status: "INACTIVE",
};

const VIEWER_USER = {
    adminId: "user-viewer",
    authUserId: authIdFor("user-viewer"),
    name: "Viewer User",
    email: "viewer@example.invalid",
    role: "VIEWER",
    status: "ACTIVE",
};

let database;
let prisma;

before(async () => {
    database = await createTestDatabase();
    ({ prisma } = database);
    await prisma.user.createMany({
        data: [ADMIN_USER, INACTIVE_USER, VIEWER_USER],
    });
    await prisma.candidate.create({
        data: {
            passportId: "N1023757",
            uniqueId: "0001",
            firstName: "Kasun",
            otherName: "Perera",
            job: "Driver",
            contactNumber: "0771234567",
        },
    });
});

after(async () => {
    await database?.close();
});

async function startServer({ loadTestMode, apiLimiter } = {}) {
    const originalEnv = process.env.LOAD_TEST_MODE;
    if (loadTestMode !== undefined) {
        process.env.LOAD_TEST_MODE = loadTestMode;
    } else {
        delete process.env.LOAD_TEST_MODE;
    }

    const verifyAccessToken = createFakeVerifier();
    const app = express();
    app.use(express.json());

    const routerOptions = {
        db: prisma,
        verifyAccessToken,
        requireAdmin: createRequireActiveUser({ db: prisma, verifyAccessToken }),
    };
    if (apiLimiter !== undefined) {
        routerOptions.apiLimiter = apiLimiter;
    }

    let router;
    try {
        router = createAdminRouter(routerOptions);
    } finally {
        if (originalEnv !== undefined) {
            process.env.LOAD_TEST_MODE = originalEnv;
        } else {
            delete process.env.LOAD_TEST_MODE;
        }
    }

    app.use("/api/admin", router);
    app.use(errorHandler);

    const server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });

    const close = () => new Promise((resolve) => server.close(resolve));
    const port = server.address().port;
    const requestCandidates = (token) => {
        const headers = { Accept: "application/json" };
        if (token) headers.Authorization = `Bearer ${token}`;
        return fetch(`http://127.0.0.1:${port}/api/admin/candidates`, { headers });
    };

    return { server, close, requestCandidates };
}

describe("GET /api/admin/candidates rate limiter and LOAD_TEST_MODE bypass", () => {
    describe("normal mode rate limits requests", () => {
        test("when LOAD_TEST_MODE is unset, requests past the limit return HTTP 429", async () => {
            const limiter = createApiRateLimiter({ limit: 2, store: new MemoryStore() });
            const instance = await startServer({ loadTestMode: undefined, apiLimiter: limiter });

            try {
                const token = tokenFor(ADMIN_USER.adminId);
                const res1 = await instance.requestCandidates(token);
                assert.equal(res1.status, 200, "1st request succeeds");

                const res2 = await instance.requestCandidates(token);
                assert.equal(res2.status, 200, "2nd request succeeds");

                const res3 = await instance.requestCandidates(token);
                assert.equal(res3.status, 429, "3rd request exceeds limit and gets HTTP 429");
                const body = await res3.json();
                assert.deepEqual(body, { message: API_RATE_LIMIT_MESSAGE });
            } finally {
                await instance.close();
            }
        });

        test("when LOAD_TEST_MODE is 'false', rate limiter remains active", async () => {
            const limiter = createApiRateLimiter({ limit: 2, store: new MemoryStore() });
            const instance = await startServer({ loadTestMode: "false", apiLimiter: limiter });

            try {
                const token = tokenFor(ADMIN_USER.adminId);
                assert.equal((await instance.requestCandidates(token)).status, 200);
                assert.equal((await instance.requestCandidates(token)).status, 200);
                assert.equal((await instance.requestCandidates(token)).status, 429);
            } finally {
                await instance.close();
            }
        });
    });

    describe("load-test mode bypasses rate limiting", () => {
        test("when LOAD_TEST_MODE is 'true', requests past the limit are not rate-limited", async () => {
            const limiter = createApiRateLimiter({ limit: 2, store: new MemoryStore() });
            const instance = await startServer({ loadTestMode: "true", apiLimiter: limiter });

            try {
                const token = tokenFor(ADMIN_USER.adminId);
                for (let i = 0; i < 6; i++) {
                    const res = await instance.requestCandidates(token);
                    assert.equal(res.status, 200, `request ${i + 1} should succeed without HTTP 429`);
                }
            } finally {
                await instance.close();
            }
        });
    });

    describe("auth and RBAC are preserved in load-test mode", () => {
        test("missing token returns HTTP 401", async () => {
            const limiter = createApiRateLimiter({ limit: 2, store: new MemoryStore() });
            const instance = await startServer({ loadTestMode: "true", apiLimiter: limiter });

            try {
                const res = await instance.requestCandidates(null);
                assert.equal(res.status, 401, "unauthenticated request rejected");
                const body = await res.json();
                assert.deepEqual(body, AUTH_REQUIRED);
            } finally {
                await instance.close();
            }
        });

        test("invalid token returns HTTP 401", async () => {
            const limiter = createApiRateLimiter({ limit: 2, store: new MemoryStore() });
            const instance = await startServer({ loadTestMode: "true", apiLimiter: limiter });

            try {
                const res = await instance.requestCandidates("invalid-token-123");
                assert.equal(res.status, 401, "invalid token rejected");
                const body = await res.json();
                assert.deepEqual(body, INVALID_TOKEN);
            } finally {
                await instance.close();
            }
        });

        test("inactive user returns HTTP 403 ACCOUNT_NOT_ACTIVE", async () => {
            const limiter = createApiRateLimiter({ limit: 2, store: new MemoryStore() });
            const instance = await startServer({ loadTestMode: "true", apiLimiter: limiter });

            try {
                const res = await instance.requestCandidates(tokenFor(INACTIVE_USER.adminId));
                assert.equal(res.status, 403, "inactive user forbidden");
                const body = await res.json();
                assert.deepEqual(body, ACCOUNT_NOT_ACTIVE);
            } finally {
                await instance.close();
            }
        });

        test("unauthorized role returns HTTP 403 Insufficient permissions", async () => {
            const limiter = createApiRateLimiter({ limit: 2, store: new MemoryStore() });
            const instance = await startServer({ loadTestMode: "true", apiLimiter: limiter });

            try {
                const res = await instance.requestCandidates(tokenFor(VIEWER_USER.adminId));
                assert.equal(res.status, 403, "unauthorized role forbidden by RBAC");
                const body = await res.json();
                assert.deepEqual(body, { message: "Insufficient permissions" });
            } finally {
                await instance.close();
            }
        });

        test("authorized role returns HTTP 200 with candidates payload", async () => {
            const limiter = createApiRateLimiter({ limit: 2, store: new MemoryStore() });
            const instance = await startServer({ loadTestMode: "true", apiLimiter: limiter });

            try {
                const res = await instance.requestCandidates(tokenFor(ADMIN_USER.adminId));
                assert.equal(res.status, 200, "authorized user succeeds");
                const body = await res.json();
                assert.ok(Array.isArray(body.items));
                assert.equal(body.items.length, 1);
                assert.equal(body.items[0].passportId, "N1023757");
            } finally {
                await instance.close();
            }
        });
    });

    describe("createApp integration", () => {
        test("createApp with LOAD_TEST_MODE='true' applies bypass to /api/admin/candidates while keeping auth", async () => {
            const originalEnv = process.env.LOAD_TEST_MODE;
            process.env.LOAD_TEST_MODE = "true";
            let server;
            try {
                const { createApp } = await import("../src/createApp.js");
                const verifyAccessToken = createFakeVerifier();
                const app = createApp({
                    adminApiRouter: createAdminRouter({
                        db: prisma,
                        verifyAccessToken,
                        requireAdmin: createRequireActiveUser({ db: prisma, verifyAccessToken }),
                        apiLimiter: createApiRateLimiter({ limit: 1, store: new MemoryStore() }),
                    }),
                });
                server = await new Promise((resolve) => {
                    const s = app.listen(0, "127.0.0.1", () => resolve(s));
                });
                const port = server.address().port;
                const token = tokenFor(ADMIN_USER.adminId);

                for (let i = 0; i < 3; i++) {
                    const res = await fetch(`http://127.0.0.1:${port}/api/admin/candidates`, {
                        headers: { Authorization: `Bearer ${token}` },
                    });
                    assert.equal(res.status, 200, "bypasses rate limit in createApp");
                }

                const unauth = await fetch(`http://127.0.0.1:${port}/api/admin/candidates`);
                assert.equal(unauth.status, 401, "still requires authentication in createApp");
            } finally {
                if (originalEnv !== undefined) {
                    process.env.LOAD_TEST_MODE = originalEnv;
                } else {
                    delete process.env.LOAD_TEST_MODE;
                }
                if (server) await new Promise((resolve) => server.close(resolve));
            }
        });
    });
});

