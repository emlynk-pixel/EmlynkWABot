import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import bcrypt from "bcrypt";

import {
    createAdminAccount,
    validateAdminInput,
    AdminProvisioningError,
    MIN_ADMIN_PASSWORD_LENGTH,
} from "../src/services/adminProvisioningService.js";
import { createFakeAdminDb } from "./helpers/fakeAdminDb.js";

// Synthetic accounts only.
const PASSWORD = "Long-Synthetic-Pass-42";
const input = (overrides = {}) => ({ name: "Test Admin", email: "new.admin@example.invalid", password: PASSWORD, ...overrides });

const rejectsWith = (promise, code) =>
    assert.rejects(promise, (error) => error instanceof AdminProvisioningError && error.code === code);

describe("createAdminAccount (SEC-023)", () => {
    test("creates one ACTIVE admin with a bcrypt hash, returning only ID and status", async () => {
        const db = createFakeAdminDb([]);
        const result = await createAdminAccount(input(), { db, newId: () => "admin-new-1" });

        assert.deepEqual(result, { adminId: "admin-new-1", status: "ACTIVE" });
        const [row] = db.rows;
        assert.equal(row.status, "ACTIVE");
        assert.equal(row.role, "ADMIN");
        assert.equal(row.email, "new.admin@example.invalid");
        assert.notEqual(row.passwordHash, PASSWORD);
        assert.match(row.passwordHash, /^\$2[aby]\$\d{2}\$/);
        assert.equal(await bcrypt.compare(PASSWORD, row.passwordHash), true);
    });

    test("email is trimmed and lowercased", async () => {
        const db = createFakeAdminDb([]);
        await createAdminAccount(input({ email: "  New.Admin@Example.INVALID " }), { db });
        assert.equal(db.rows[0].email, "new.admin@example.invalid");
    });

    test("an existing email is refused and the existing admin is not changed", async () => {
        const existing = { adminId: "admin-old", name: "Old", email: "new.admin@example.invalid", passwordHash: "$2b$10$existinghashexistinghashexistinghashexistinghashexi", role: "ADMIN", status: "INACTIVE" };
        const db = createFakeAdminDb([existing]);

        await rejectsWith(createAdminAccount(input({ email: "NEW.admin@example.invalid" }), { db }), "ADMIN_EXISTS");
        assert.equal(db.rows.length, 1);
        assert.deepEqual(db.rows[0], existing);
    });

    test("a unique-index race is reported as ADMIN_EXISTS", async () => {
        const db = createFakeAdminDb([]);
        const racingDb = {
            admin: {
                findUnique: async () => null, // looked free…
                create: async (args) => { await db.admin.create(args); return db.admin.create(args); }, // …but taken meanwhile
            },
        };
        await rejectsWith(createAdminAccount(input(), { db: racingDb }), "ADMIN_EXISTS");
    });

    test("weak, blank or over-long passwords are refused before hashing", async () => {
        let hashed = 0;
        const hash = async () => { hashed += 1; return "x"; };
        const db = createFakeAdminDb([]);

        for (const password of ["", "short", "a".repeat(MIN_ADMIN_PASSWORD_LENGTH - 1), " ".repeat(20), "p".repeat(129), "new.admin-is-my-password", undefined, 12345678901234]) {
            await rejectsWith(createAdminAccount(input({ password }), { db, hash }), "WEAK_PASSWORD");
        }
        assert.equal(hashed, 0);
        assert.equal(db.rows.length, 0);
    });

    test("invalid name, email or role is refused", async () => {
        const db = createFakeAdminDb([]);
        await rejectsWith(createAdminAccount(input({ name: " " }), { db }), "INVALID_NAME");
        await rejectsWith(createAdminAccount(input({ email: "not-an-email" }), { db }), "INVALID_EMAIL");
        await rejectsWith(createAdminAccount(input({ email: { $ne: null } }), { db }), "INVALID_EMAIL");
        await rejectsWith(createAdminAccount(input({ role: "admin; DROP" }), { db }), "INVALID_ROLE");
        assert.equal(db.rows.length, 0);
    });

    test("error messages never contain the password or email given", () => {
        const secret = "short-secret";
        for (const bad of [input({ password: secret }), input({ email: "bad email secret-mail" })]) {
            try {
                validateAdminInput(bad);
                assert.fail("expected a validation error");
            } catch (error) {
                assert.ok(!error.message.includes(secret));
                assert.ok(!error.message.includes("secret-mail"));
            }
        }
    });
});

describe("scripts/createAdmin.js", () => {
    const source = readFileSync(new URL("../scripts/createAdmin.js", import.meta.url), "utf8");

    test("takes no password argument and prints no password or hash", () => {
        assert.doesNotMatch(source, /password:\s*\{\s*type/);
        assert.doesNotMatch(source, /console\.(log|error)\([^)]*(password|passwordHash)\b/i);
    });
});

describe("no hard-coded credentials remain (SEC-016)", () => {
    test("the old password test script is gone", () => {
        assert.throws(() => readFileSync(new URL("../src/utils/password-test.js", import.meta.url)), { code: "ENOENT" });
        assert.throws(() => readFileSync(new URL("../src/config/prisma-test.js", import.meta.url)), { code: "ENOENT" });
    });
});
