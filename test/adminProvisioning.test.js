// Bootstrap provisioning through Supabase Auth (scripts/createUser.js,
// src/services/userProvisioningService.js). Supabase is a stand-in.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { provisionUser, validateProvisioningInput, UserProvisioningError, MIN_BOOTSTRAP_PASSWORD_LENGTH } from "../src/services/userProvisioningService.js";
import { createFakeAdminDb } from "./helpers/fakeAdminDb.js";
import { createFakeAuthAdmin } from "./helpers/fakeSupabaseAuth.js";

// Synthetic accounts only.
const PASSWORD = "Long-Synthetic-Pass-42";
const input = (overrides = {}) => ({ name: "Test Admin", email: "new.admin@example.invalid", password: PASSWORD, ...overrides });
const rejectsWith = (promise, code) => assert.rejects(promise, (error) => error instanceof UserProvisioningError && error.code === code);

describe("provisionUser: create", () => {
    test("creates the Supabase identity, then an ACTIVE public.user linked to it (default ADMIN)", async () => {
        const db = createFakeAdminDb([]);
        const authAdmin = createFakeAuthAdmin();
        const result = await provisionUser(input(), { db, authAdmin, newId: () => "user-new-1" });

        assert.deepEqual(result, { userId: "user-new-1", status: "ACTIVE", created: true });
        const [row] = db.rows;
        assert.deepEqual([row.email, row.role, row.status], ["new.admin@example.invalid", "ADMIN", "ACTIVE"]);
        assert.equal(row.authUserId, authAdmin.users.get("new.admin@example.invalid").authUserId);
        assert.ok(!("passwordHash" in row) && !JSON.stringify(row).includes(PASSWORD), "the password is never stored by the application");
        assert.deepEqual(authAdmin.calls, [{ method: "createUser", email: "new.admin@example.invalid", hasPassword: true }]);
    });

    test("any application role may be given; others are refused", async () => {
        for (const role of ["ADMIN", "MANAGER", "ANALYST", "REGISTRATION_DESK"]) {
            const db = createFakeAdminDb([]);
            await provisionUser(input({ role }), { db, authAdmin: createFakeAuthAdmin() });
            assert.equal(db.rows[0].role, role);
        }
        for (const role of ["VIEWER", "SUPERUSER", "admin; DROP"]) {
            await rejectsWith(provisionUser(input({ role }), { db: createFakeAdminDb([]), authAdmin: createFakeAuthAdmin() }), "INVALID_ROLE");
        }
    });

    test("duplicate protection: a linked user is refused before Supabase is called", async () => {
        const db = createFakeAdminDb([{ adminId: "u1", email: "new.admin@example.invalid", name: "Old", role: "ADMIN", status: "ACTIVE" }]);
        const authAdmin = createFakeAuthAdmin();
        await rejectsWith(provisionUser(input({ email: "NEW.admin@example.invalid" }), { db, authAdmin }), "USER_EXISTS");
        assert.equal(authAdmin.calls.length, 0);
        assert.equal(db.rows.length, 1);
    });

    test("an existing Supabase identity is not taken over without --link", async () => {
        const authAdmin = createFakeAuthAdmin({ identities: { "new.admin@example.invalid": { authUserId: "11111111-1111-4111-8111-111111111111", confirmed: true } } });
        const db = createFakeAdminDb([]);
        await rejectsWith(provisionUser(input(), { db, authAdmin }), "AUTH_USER_EXISTS");
        assert.equal(db.rows.length, 0);
    });

    test("a failed database write removes the Supabase identity this run created", async () => {
        const db = createFakeAdminDb([]);
        db.user.create = async () => { throw Object.assign(new Error("Unique constraint"), { code: "P2002" }); };
        const authAdmin = createFakeAuthAdmin();
        await rejectsWith(provisionUser(input(), { db, authAdmin }), "USER_EXISTS");
        assert.equal(authAdmin.users.size, 0);
        assert.ok(authAdmin.calls.some((c) => c.method === "deleteUser"));
    });

    test("weak, blank or over-long passwords are refused before Supabase is called", async () => {
        const authAdmin = createFakeAuthAdmin();
        for (const password of ["", "short", "a".repeat(MIN_BOOTSTRAP_PASSWORD_LENGTH - 1), " ".repeat(20), "p".repeat(129), "new.admin-is-my-password", undefined]) {
            await rejectsWith(provisionUser(input({ password }), { db: createFakeAdminDb([]), authAdmin }), "WEAK_PASSWORD");
        }
        assert.equal(authAdmin.calls.length, 0);
    });

    test("error messages never contain the password or email given", () => {
        for (const bad of [input({ password: "short-secret" }), input({ email: "bad email secret-mail" })]) {
            try {
                validateProvisioningInput(bad);
                assert.fail("expected a validation error");
            } catch (error) {
                assert.ok(!error.message.includes("short-secret") && !error.message.includes("secret-mail"));
            }
        }
    });
});

describe("provisionUser: --link", () => {
    test("links a pre-Supabase row to its existing identity, keeping its role", async () => {
        const db = createFakeAdminDb([{ adminId: "legacy-1", authUserId: null, email: "legacy@example.invalid", name: "Legacy", role: "MANAGER", status: "ACTIVE" }]);
        const authAdmin = createFakeAuthAdmin({ identities: { "legacy@example.invalid": { authUserId: "22222222-2222-4222-8222-222222222222", confirmed: true } } });
        const result = await provisionUser({ email: "legacy@example.invalid", link: true }, { db, authAdmin });
        assert.deepEqual(result, { userId: "legacy-1", status: "ACTIVE", created: false });
        assert.equal(db.rows[0].authUserId, "22222222-2222-4222-8222-222222222222");
        assert.equal(db.rows[0].role, "MANAGER");
        assert.ok(!authAdmin.calls.some((c) => c.method === "createUser"), "no password, no new identity");
    });

    test("no Supabase identity for the email -> refused", async () => {
        await rejectsWith(provisionUser({ name: "None", email: "none@example.invalid", link: true }, { db: createFakeAdminDb([]), authAdmin: createFakeAuthAdmin() }), "AUTH_USER_NOT_FOUND");
    });
});

describe("scripts/createUser.js", () => {
    const source = readFileSync(new URL("../scripts/createUser.js", import.meta.url), "utf8");

    test("takes no password argument and prints no password", () => {
        assert.doesNotMatch(source, /password:\s*\{\s*type/);
        assert.doesNotMatch(source, /console\.(log|error)\([^)]*password/i);
    });

    test("uses the Supabase Admin API, not a local password hash", () => {
        assert.match(source, /getSupabaseAuthAdmin/);
        assert.doesNotMatch(source, /bcrypt|hashPassword|passwordHash/);
    });

    test("is the npm bootstrap command", () => {
        const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
        assert.equal(pkg.scripts["user:create"], "node scripts/createUser.js");
        assert.equal(pkg.scripts["admin:create"], undefined);
    });
});

describe("no hard-coded credentials remain (SEC-016)", () => {
    test("the old password test script is gone", () => {
        assert.throws(() => readFileSync(new URL("../src/utils/password-test.js", import.meta.url)), { code: "ENOENT" });
        assert.throws(() => readFileSync(new URL("../src/config/prisma-test.js", import.meta.url)), { code: "ENOENT" });
    });
});
