-- Application users: record WHEN an account completed its setup and WHEN its last invitation was sent
-- (userAccountService.js). ADDITIVE: two nullable columns, a one-off backfill, nothing else changed.
-- Safe to run twice.
--
-- activated_at  the person finished setting up (accepted an invitation and set a password, or was
--               provisioned with a password). Re-inviting a deactivated account reactivates it ONLY
--               when this is set; otherwise a new invitation / password-setup email is sent. Before
--               this column, a Supabase "email already confirmed" answer was taken as "set up", which
--               made never-set-up accounts ACTIVE on re-invite.
-- invited_at    when the latest invitation email was sent (shown as the invitation's age; Supabase
--               invitation links expire).

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "activated_at" TIMESTAMP(3);
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "invited_at" TIMESTAMP(3);

-- Backfill activated_at, only where it is certain:
-- 1. accounts that accepted an invitation (COMPLETE_INVITATION is written by the account itself);
UPDATE "user" u
SET "activated_at" = a."first_at"
FROM (SELECT "admin_id", min("created_date") AS "first_at" FROM "audit_logs" WHERE "action" = 'COMPLETE_INVITATION' GROUP BY "admin_id") a
WHERE u."admin_id" = a."admin_id" AND u."activated_at" IS NULL;

-- 2. accounts never invited through the application (bootstrap provisioning, or from before Supabase
--    Auth): they were created ACTIVE with a password.
UPDATE "user" u
SET "activated_at" = u."created_date"
WHERE u."activated_at" IS NULL
  AND u."status" IN ('ACTIVE', 'INACTIVE')
  AND NOT EXISTS (
      SELECT 1 FROM "audit_logs" a
      WHERE a."action" IN ('INVITE_USER', 'REACTIVATE_USER') AND lower(a."new_value") = lower(u."email")
  );
-- An ACTIVE account that was invited but never accepted (made ACTIVE by the old re-invite rule) stays
-- NULL on purpose: scripts/auditUserAccounts.js lists it for review.

-- Backfill invited_at for pending invitations: the latest INVITE_USER of that email.
UPDATE "user" u
SET "invited_at" = a."last_at"
FROM (SELECT lower("new_value") AS "email", max("created_date") AS "last_at" FROM "audit_logs" WHERE "action" = 'INVITE_USER' GROUP BY lower("new_value")) a
WHERE lower(u."email") = a."email" AND u."invited_at" IS NULL;

COMMENT ON COLUMN "user"."activated_at" IS 'When the account completed setup (invitation accepted with a password, or provisioned). NULL: never set up.';
COMMENT ON COLUMN "user"."invited_at" IS 'When the latest invitation (or password-setup) email was sent. NULL: never invited through the application.';
