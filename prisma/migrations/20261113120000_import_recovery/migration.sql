-- Bulk candidate import: AUTOMATIC RECOVERY of interrupted imports (importRecoveryService.js). ADDITIVE ONLY: new
-- nullable columns (and one with a default), two partial indexes, and one widened CHECK. No existing row changes
-- meaning; no existing status, column or ledger entry is altered. Applied after 20261112140000_import_rollback.
--
-- Business rule: an import is all-or-nothing. One that stops before the backend has recorded its completion (the
-- browser closed, the computer lost power, the network or the backend failed) is rolled back automatically, from
-- its change ledger, by the existing rollback (candidateImportRollback.js), without any browser.
--
-- candidate_import:
--   commit_lease_expires_at   set by EVERY chunk transaction (and every row transaction of a chunk that falls back to
--                             row by row) to database now() + the commit lease, in the statement that locks the
--                             import row. Only real backend work renews it. NULL = the import never committed a chunk
--                             under this code: such an import (every COMMITTING import that exists when this migration
--                             runs) is NEVER recovered automatically; it keeps the existing Resume / Abort / Rollback.
--   heartbeat_at              the browser's "still here" (about every 20 s while the import is open). It never renews
--                             the lease: it only delays recovery for a bounded time (a grace period, and never more
--                             than the maximum idle time after the last chunk).
--   recovery_status           NULL (not under recovery) | ROLLING_BACK (the database rollback is running or resumable) |
--                             SHEET_PENDING (database rolled back, the Google Sheet reconciliation not yet confirmed) |
--                             COMPLETED (rolled back cleanly AND the Sheet reconciled) | NEEDS_ATTENTION (an
--                             administrator must look: conflicts kept, the ledger key unavailable, or retries used up)
--   recovery_reason           ABANDONED_COMMIT (an import stopped while committing) | ROLLBACK_INTERRUPTED (a rollback
--                             started by an administrator stopped and was taken over)
--   recovery_attempts         consecutive failed attempts (bounded retries with exponential backoff; reset on progress)
--   recovery_started_at / recovery_completed_at / recovery_next_attempt_at / recovery_notified_at
--   recovery_last_error       a code only (LEDGER_KEY_NOT_CONFIGURED, ROLLBACK_CONFLICTS, SHEET_RECONCILIATION_INCOMPLETE ...)
--   recovery_result           counts and codes only (never a value): Sheet runs requested, pending approvals, ...
--
-- candidate_import_change.entity_type gains JOB_TYPE: a Job Type a chunk created for a Job Role of the sheet that
-- was not a type yet (now created inside the chunk transaction, so it is recorded like every other change). A
-- rollback deletes it only when nothing uses it (no Job, no candidate preference) and it is unchanged.
ALTER TABLE "candidate_import"
    ADD COLUMN "commit_lease_expires_at" TIMESTAMPTZ(3),
    ADD COLUMN "heartbeat_at" TIMESTAMPTZ(3),
    ADD COLUMN "recovery_status" TEXT,
    ADD COLUMN "recovery_reason" TEXT,
    ADD COLUMN "recovery_attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "recovery_started_at" TIMESTAMPTZ(3),
    ADD COLUMN "recovery_completed_at" TIMESTAMPTZ(3),
    ADD COLUMN "recovery_next_attempt_at" TIMESTAMPTZ(3),
    ADD COLUMN "recovery_notified_at" TIMESTAMPTZ(3),
    ADD COLUMN "recovery_last_error" TEXT,
    ADD COLUMN "recovery_result" JSONB;

ALTER TABLE "candidate_import" ADD CONSTRAINT "candidate_import_recovery_status_check"
    CHECK ("recovery_status" IS NULL OR "recovery_status" IN ('ROLLING_BACK', 'SHEET_PENDING', 'COMPLETED', 'NEEDS_ATTENTION'));
ALTER TABLE "candidate_import" ADD CONSTRAINT "candidate_import_recovery_reason_check"
    CHECK ("recovery_reason" IS NULL OR "recovery_reason" IN ('ABANDONED_COMMIT', 'ROLLBACK_INTERRUPTED'));
ALTER TABLE "candidate_import" ADD CONSTRAINT "candidate_import_recovery_attempts_check" CHECK ("recovery_attempts" >= 0);

-- The detector's scan: committing imports by lease expiry.
CREATE INDEX "candidate_import_committing_lease_idx" ON "candidate_import" ("commit_lease_expires_at") WHERE "status" = 'COMMITTING';
-- The worker's queue: recoveries still to be worked on.
CREATE INDEX "candidate_import_recovery_due_idx" ON "candidate_import" ("recovery_next_attempt_at")
    WHERE "recovery_status" IS NOT NULL AND "recovery_status" <> 'COMPLETED';

ALTER TABLE "candidate_import_change" DROP CONSTRAINT "candidate_import_change_entity_type_check";
ALTER TABLE "candidate_import_change" ADD CONSTRAINT "candidate_import_change_entity_type_check" CHECK ("entity_type" IN (
    'CANDIDATE', 'CANDIDATE_ADDITIONAL_DETAILS', 'CANDIDATE_STAGE', 'CANDIDATE_ALLOCATION',
    'CLIENT', 'AGENT', 'AGENT_CLIENT', 'JOB', 'IMPORT_JOB_GROUP', 'JOB_CANDIDATE', 'JOB_TYPE'
));
