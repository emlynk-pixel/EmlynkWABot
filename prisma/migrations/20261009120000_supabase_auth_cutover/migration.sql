-- Supabase Auth cutover: the application no longer stores credentials or
-- issues tokens. Supabase Auth (auth.users) is the only credential and
-- session authority; public."user" keeps the profile, role and status.
--
--   - admin_invitations and admin_password_resets are dropped: invitations
--     and password recovery are Supabase Auth flows now. Their rows are
--     one-time tokens (test data only); nothing else references them.
--   - "user".password_hash is dropped: passwords live in Supabase Auth only.
--   - "user".auth_user_id becomes a required UUID (auth.users.id), still
--     unique, and a foreign key to auth.users where that schema exists
--     (Supabase). Plain PostgreSQL (tests, a Prisma shadow database) has no
--     auth schema, so the constraint is only added when auth.users exists.
--     ON DELETE RESTRICT: an application user is deactivated, never deleted
--     (audit history references the row).
--
-- PREREQUISITE: every "user" row must already be linked to a Supabase Auth
-- identity (npm run user:create -- --email <email> --link). No placeholder
-- value is ever invented: the migration stops with an error instead, before
-- changing anything.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "user" WHERE "auth_user_id" IS NULL) THEN
        RAISE EXCEPTION 'Supabase Auth cutover: % "user" row(s) have no auth_user_id. Link each one first (npm run user:create -- --email <email> --link), then apply this migration again.',
            (SELECT count(*) FROM "user" WHERE "auth_user_id" IS NULL);
    END IF;
END $$;

-- DropTable
DROP TABLE "admin_invitations";

-- DropTable
DROP TABLE "admin_password_resets";

-- AlterTable
ALTER TABLE "user" DROP COLUMN "password_hash";

-- AlterTable: Supabase identities are UUIDs; the unique index is rebuilt.
ALTER TABLE "user" ALTER COLUMN "auth_user_id" TYPE UUID USING "auth_user_id"::uuid;
ALTER TABLE "user" ALTER COLUMN "auth_user_id" SET NOT NULL;

-- AddForeignKey (Supabase only)
DO $$
BEGIN
    IF to_regclass('auth.users') IS NOT NULL THEN
        ALTER TABLE "user"
            ADD CONSTRAINT "user_auth_user_id_fkey"
            FOREIGN KEY ("auth_user_id") REFERENCES auth.users ("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;
