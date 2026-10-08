// Migration 20261009120000_supabase_auth_cutover on a real PostgreSQL (PGlite).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createTestDatabase, migrationNames } from "./helpers/pgliteDatabase.js";

const CUTOVER = "20261009120000_supabase_auth_cutover";
const SQL = fs.readFileSync(new URL(`../prisma/migrations/${CUTOVER}/migration.sql`, import.meta.url), "utf8");
const previous = () => { const names = migrationNames(); return names[names.indexOf(CUTOVER) - 1]; };
const AUTH_ID = "3f0e9a52-6d1b-4c7e-9a3f-0b1c2d3e4f50";

const tableNames = async (pg) => (await pg.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map((r) => r.table_name);
const userColumns = async (pg) => Object.fromEntries((await pg.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user'`)).rows.map((r) => [r.column_name, r]));

async function before({ withAuthSchema = false } = {}) {
    const db = await createTestDatabase({ upTo: previous() });
    if (withAuthSchema) await db.pg.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users ("id" UUID PRIMARY KEY);`);
    return db;
}

describe("Supabase Auth cutover migration", () => {
    test("refuses to run while a user is not linked to Supabase Auth, and changes nothing", async () => {
        const db = await before();
        try {
            await db.pg.query(`INSERT INTO "user" ("admin_id", "name", "email", "role", "status", "updated_date") VALUES ('legacy', 'Legacy', 'legacy@example.invalid', 'ADMIN', 'ACTIVE', now())`);
            await assert.rejects(db.pg.exec(SQL), /no auth_user_id\. Link each one first/);
            const tables = await tableNames(db.pg);
            assert.ok(tables.includes("admin_invitations") && tables.includes("admin_password_resets"), "nothing dropped");
            assert.ok("password_hash" in (await userColumns(db.pg)));
        } finally {
            await db.close();
        }
    });

    test("once every user is linked: legacy tables and password_hash gone; auth_user_id a required, unique UUID", async () => {
        const db = await before();
        try {
            await db.pg.query(`INSERT INTO "user" ("admin_id", "auth_user_id", "name", "email", "role", "status", "updated_date") VALUES ('linked', $1, 'Linked', 'linked@example.invalid', 'ADMIN', 'ACTIVE', now())`, [AUTH_ID]);
            await db.pg.exec(SQL);

            const tables = await tableNames(db.pg);
            assert.ok(!tables.includes("admin_invitations") && !tables.includes("admin_password_resets"));
            const columns = await userColumns(db.pg);
            assert.equal(columns.password_hash, undefined);
            assert.deepEqual([columns.auth_user_id.data_type, columns.auth_user_id.is_nullable], ["uuid", "NO"]);
            assert.equal((await db.pg.query(`SELECT "auth_user_id"::text AS id FROM "user"`)).rows[0].id, AUTH_ID, "the link is kept");

            await assert.rejects(db.pg.query(`INSERT INTO "user" ("admin_id", "name", "email", "role", "status", "updated_date") VALUES ('x', 'X', 'x@example.invalid', 'ADMIN', 'ACTIVE', now())`), /null value/);
            await assert.rejects(db.pg.query(`INSERT INTO "user" ("admin_id", "auth_user_id", "name", "email", "role", "status", "updated_date") VALUES ('y', $1, 'Y', 'y@example.invalid', 'ADMIN', 'ACTIVE', now())`, [AUTH_ID]), /duplicate key/);
            await assert.rejects(db.pg.query(`INSERT INTO "user" ("admin_id", "auth_user_id", "name", "email", "role", "status", "updated_date") VALUES ('z', 'not-a-uuid', 'Z', 'z@example.invalid', 'ADMIN', 'ACTIVE', now())`), /uuid/);
        } finally {
            await db.close();
        }
    });

    test("on Supabase (auth.users exists) auth_user_id references auth.users, ON DELETE RESTRICT", async () => {
        const db = await before({ withAuthSchema: true });
        try {
            await db.pg.query(`INSERT INTO auth.users ("id") VALUES ($1)`, [AUTH_ID]);
            await db.pg.query(`INSERT INTO "user" ("admin_id", "auth_user_id", "name", "email", "role", "status", "updated_date") VALUES ('linked', $1, 'L', 'l@example.invalid', 'ADMIN', 'ACTIVE', now())`, [AUTH_ID]);
            await db.pg.exec(SQL);
            await assert.rejects(db.pg.query(`INSERT INTO "user" ("admin_id", "auth_user_id", "name", "email", "role", "status", "updated_date") VALUES ('ghost', '00000000-0000-4000-8000-000000000000', 'G', 'g@example.invalid', 'ADMIN', 'ACTIVE', now())`), /foreign key/);
            await assert.rejects(db.pg.query(`DELETE FROM auth.users WHERE "id" = $1`, [AUTH_ID]), /foreign key/, "deactivate, never delete, an application user's identity");
        } finally {
            await db.close();
        }
    });

    test("plain PostgreSQL (no auth schema): applies without the foreign key", async () => {
        const db = await createTestDatabase();
        try {
            const fks = (await db.pg.query(`SELECT conname FROM pg_constraint WHERE conname = 'user_auth_user_id_fkey'`)).rows;
            assert.deepEqual(fks, []);
        } finally {
            await db.close();
        }
    });
});
