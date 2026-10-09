-- Phase 1 of the database/authentication restructure
-- (Docs: database & authentication migration audit, 2026-10-08).
--
-- Renames the two core application tables to the target architecture's
-- naming:
--   "users"  (candidate records)        -> "candidate"
--   "admins" (staff/application users)  -> "user"
--
-- PostgreSQL `user` is a reserved keyword, so every statement below that
-- names the renamed staff table double-quotes it as "user".
--
-- This is a pure rename: ALTER TABLE ... RENAME TO keeps the table's OID,
-- so all existing rows, foreign keys, RLS settings, grants/revokes and
-- triggers carry over automatically. No row is inserted, updated or
-- deleted by this migration; no application data is lost.
--
-- Three things do NOT follow a rename automatically and are fixed
-- explicitly below:
--   1. The primary key / unique index names Prisma generated from the old
--      table names (e.g. "users_pkey") are renamed to match the new table
--      names, so a future `prisma migrate diff` sees no drift.
--   2. The Sheet Sync change-capture trigger + function bound to the
--      candidate table ("users_sheet_sync_capture" /
--      "sheet_sync_capture_users") are renamed to "candidate_sheet_sync_capture"
--      / "sheet_sync_capture_candidate" so their names no longer say "users".
--   3. "sheet_sync_capture_candidate_child()" (the trigger function shared
--      by candidate_stages and documents) contains a literal
--      `FROM "users"` lookup in its body. Table renames are not visible to
--      the text inside a function body, so this statement would silently
--      start failing (table "users" no longer exists) if left unchanged.
--      It is replaced here to read `FROM "candidate"`.
--
-- Also adds "user"."auth_user_id": an optional, unique column that will
-- hold the Supabase auth.users.id once Phase 2 wires up Supabase Auth.
-- Nullable and unenforced in this phase; no row is given a value here.
--
-- Foreign keys into these tables (documents, temporary_data,
-- candidate_stages, candidate_call_logs -> candidate; audit_logs,
-- admin_invitations, admin_password_resets, candidate_call_logs -> "user")
-- need no SQL change: PostgreSQL foreign keys reference the table by OID,
-- so they keep working against the renamed table under its new name.

-- ---------------------------------------------------------------- tables

ALTER TABLE "users" RENAME TO "candidate";
ALTER TABLE "admins" RENAME TO "user";

-- ---------------------------------------------------------------- constraint / index names

ALTER TABLE "candidate" RENAME CONSTRAINT "users_pkey" TO "candidate_pkey";
ALTER INDEX "users_unique_id_key" RENAME TO "candidate_unique_id_key";
ALTER INDEX "users_nic_key" RENAME TO "candidate_nic_key";
ALTER INDEX "users_whatsapp_number_key" RENAME TO "candidate_whatsapp_number_key";

ALTER TABLE "user" RENAME CONSTRAINT "admins_pkey" TO "user_pkey";
ALTER INDEX "admins_email_key" RENAME TO "user_email_key";

-- ---------------------------------------------------------------- auth_user_id preparation

-- AlterTable
ALTER TABLE "user" ADD COLUMN "auth_user_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "user_auth_user_id_key" ON "user"("auth_user_id");

-- ---------------------------------------------------------------- Sheet Sync trigger / function repoint

-- Rename the candidate-table trigger and its function so neither name says
-- "users" any more. ALTER TRIGGER / ALTER FUNCTION RENAME only change the
-- name; the trigger stays bound to the same function by OID, and the
-- function's (unchanged) body still works on whatever table it's attached
-- to via OLD/NEW, so behavior is identical.
ALTER TRIGGER "users_sheet_sync_capture" ON "candidate" RENAME TO "candidate_sheet_sync_capture";
ALTER FUNCTION "sheet_sync_capture_users"() RENAME TO "sheet_sync_capture_candidate";

-- Repoint the one literal `FROM "users"` lookup in the child-capture
-- function (shared by candidate_stages and documents) to "candidate".
-- CREATE OR REPLACE keeps the function's OID, so the two existing
-- triggers ("candidate_stages_sheet_sync_capture", "documents_sheet_sync_capture")
-- stay bound to it without being recreated. Business behavior (which rows
-- get enqueued, and when) is unchanged — only the table name in the lookup.
CREATE OR REPLACE FUNCTION "sheet_sync_capture_candidate_child"() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path FROM CURRENT
AS $$
DECLARE
    old_unique_id TEXT;
    new_unique_id TEXT;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        SELECT "unique_id" INTO old_unique_id FROM "candidate" WHERE "passport_id" = OLD."passport_id";
        IF old_unique_id IS NOT NULL THEN
            PERFORM "sheet_sync_enqueue"(old_unique_id, false);
        END IF;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        SELECT "unique_id" INTO new_unique_id FROM "candidate" WHERE "passport_id" = NEW."passport_id";
        IF new_unique_id IS NOT NULL AND new_unique_id IS DISTINCT FROM old_unique_id THEN
            PERFORM "sheet_sync_enqueue"(new_unique_id, false);
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

-- Rollback (stops capture, keeps candidate/user data untouched):
--   DROP TRIGGER "candidate_sheet_sync_capture" ON "candidate";
--   DROP TRIGGER "candidate_stages_sheet_sync_capture" ON "candidate_stages";
--   DROP TRIGGER "documents_sheet_sync_capture" ON "documents";
