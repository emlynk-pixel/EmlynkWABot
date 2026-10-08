// Password recovery belongs to Supabase Auth: the admin app calls
// resetPasswordForEmail() and updateUser({ password }) directly (covered by
// admin/src/test/passwordReset.test.tsx). The backend keeps no reset tokens
// and has no recovery endpoint; this file checks that nothing of the old
// custom flow is reachable or stored.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";

import { createAuthRouter } from "../src/routes/auth.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { createFakeAdminDb, noRateLimit } from "./helpers/fakeAdminDb.js";
import { fakeVerifyAccessToken, tokenFor } from "./helpers/fakeSupabaseAuth.js";

let server;
let baseUrl;

before(async () => {
    const app = express();
    app.use(express.json());
    const db = createFakeAdminDb([{ adminId: "u1", name: "U", email: "u@example.invalid", role: "ADMIN", status: "ACTIVE" }]);
    app.use("/auth", createAuthRouter({ db, verifyAccessToken: fakeVerifyAccessToken, apiLimiter: noRateLimit }));
    app.use((req, res) => res.status(404).json({ message: "Not found" }));
    app.use(errorHandler);
    await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

describe("password recovery is Supabase's", () => {
    test("the backend has no forgot/reset endpoints (with or without a session)", async () => {
        for (const [method, path] of [["POST", "/auth/forgot-password"], ["GET", "/auth/reset-password?token=abc"], ["POST", "/auth/reset-password"]]) {
            for (const headers of [{}, { Authorization: `Bearer ${tokenFor("u1")}` }]) {
                const response = await fetch(`${baseUrl}${path}`, { method, headers: { ...headers, "Content-Type": "application/json" }, body: method === "POST" ? JSON.stringify({ email: "u@example.invalid", token: "abc", password: "New-Password-1" }) : undefined });
                assert.equal(response.status, 404, `${method} ${path}`);
            }
        }
    });

    test("no live application code references the old reset service, its table or the custom email sender", () => {
        const files = ["src/routes/auth.js", "src/routes/admin.js", "src/routes/users.js", "src/createApp.js", "src/services/userAccountService.js"];
        for (const file of files) {
            const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
            assert.doesNotMatch(source, /passwordResetService|adminPasswordReset|emailService|forgot-password/, file);
        }
    });
});
