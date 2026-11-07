// Migration 20261110120000_user_activation_tracking: activated_at / invited_at, and their backfill.
// Rehearsed on a database as it is just before the migration (PGlite), with raw SQL only.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTestDatabase, migrationNames } from "./helpers/pgliteDatabase.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261110120000_user_activation_tracking";
const SQL = fs.readFileSync(path.join(HERE, "..", "prisma", "migrations", MIGRATION, "migration.sql"), "utf8");
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe(`migration ${MIGRATION}`, () => {
    test("backfill: set up only where certain; an invited-then-reactivated account (old bug) stays NULL; pending invitations get their time", async () => {
        const names = migrationNames();
        const old = await createTestDatabase({ upTo: names[names.indexOf(MIGRATION) - 1] });
        try {
            const { pg } = old;
            await pg.exec(`
                INSERT INTO "user" ("admin_id","auth_user_id","name","email","role","status","created_date","updated_date") VALUES
                    ('boot',     '${id(1)}', 'Boot',     'boot@example.invalid',     'ADMIN',   'ACTIVE',   '2026-09-01', now()),
                    ('accepted', '${id(2)}', 'Accepted', 'accepted@example.invalid', 'ANALYST', 'INACTIVE', '2026-10-01', now()),
                    ('bug1',     '${id(3)}', 'Bug One',  'bug1@example.invalid',     'ANALYST', 'ACTIVE',   '2026-10-02', now()),
                    ('pending',  '${id(4)}', 'Pending',  'Pending@Example.invalid',  'ANALYST', 'INVITED',  '2026-10-03', now());
                INSERT INTO "audit_logs" ("audit_id","admin_id","action","previous_status","new_status","new_value","created_date") VALUES
                    ('a1','boot','INVITE_USER','NONE','INVITED','accepted@example.invalid','2026-10-01T01:00:00Z'),
                    ('a2','accepted','COMPLETE_INVITATION','INVITED','ACTIVE','accepted@example.invalid','2026-10-01T02:00:00Z'),
                    ('a3','boot','INVITE_USER','NONE','INVITED','bug1@example.invalid','2026-10-02T01:00:00Z'),
                    ('a4','boot','REACTIVATE_USER','INACTIVE','ACTIVE','bug1@example.invalid','2026-10-02T03:00:00Z'),
                    ('a5','boot','INVITE_USER','NONE','INVITED','pending@example.invalid','2026-10-03T01:00:00Z'),
                    ('a6','boot','INVITE_USER','INVITED','INVITED','pending@example.invalid','2026-10-04T01:00:00Z');
            `);
            await pg.exec(SQL);
            await pg.exec(SQL); // safe to run twice
            const rows = Object.fromEntries((await pg.query(`SELECT "admin_id", to_char("activated_at", 'YYYY-MM-DD HH24:MI') AS "activated_at", to_char("invited_at", 'YYYY-MM-DD HH24:MI') AS "invited_at" FROM "user"`)).rows.map((r) => [r.admin_id, r]));
            assert.equal(rows.boot.activated_at, "2026-09-01 00:00", "provisioned, never invited");
            assert.equal(rows.accepted.activated_at, "2026-10-01 02:00", "accepted an invitation");
            assert.equal(rows.bug1.activated_at, null, "invited, then made ACTIVE without setup: left for review");
            assert.equal(rows.pending.activated_at, null);
            assert.equal(rows.pending.invited_at, "2026-10-04 01:00", "the latest invitation, any letter case");
            assert.equal(rows.boot.invited_at, null);
        } finally {
            await old.close();
        }
    });
});
