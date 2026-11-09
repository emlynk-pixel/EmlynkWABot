-- Bulk candidate import hardening: duplicate-upload protection and the states an interrupted import
-- needs (candidateImportService.js). ADDITIVE: no existing row is changed.
--
--   idempotency_key  an optional client-generated key per file choice (header Idempotency-Key): the same
--                    key from the same admin names the same import, so a repeated or retried preview
--                    never creates a second one.
--   one committing per admin  each administrator may have at most ONE import COMMITTING at a time, so an
--                    accidental second Upload (second tab, retry, double click) can never run beside the first.
--                    Different administrators may import at the same time: what they share (passports, unique
--                    IDs, Job groups, Clients and Agents) is protected by database locks and unique
--                    constraints, not by this index (see candidateImportService.js). A COMMITTING import that
--                    stopped (closed tab) is resumed by its owner or aborted; the application treats one idle
--                    for 15 minutes as stale.
--   status           ABORTED (stopped on purpose, rows kept) and the rollback states used by the
--                    rollback work (ROLLING_BACK, ROLLED_BACK, ROLLED_BACK_WITH_CONFLICTS).
--
-- Precondition for the per-admin index: no administrator has more than one COMMITTING import today. If
-- this migration stops here, finish or abort the extra imports first; nothing is changed automatically.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "candidate_import" WHERE "status" = 'COMMITTING' GROUP BY "admin_id" HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'An administrator has more than one candidate_import COMMITTING: finish or abort all but one of theirs before applying this migration';
    END IF;
END $$;

ALTER TABLE "candidate_import" ADD COLUMN "idempotency_key" TEXT;

ALTER TABLE "candidate_import" ADD CONSTRAINT "candidate_import_idempotency_key_check"
    CHECK ("idempotency_key" IS NULL OR "idempotency_key" ~ '^[A-Za-z0-9_-]{8,100}$');

CREATE UNIQUE INDEX "candidate_import_admin_idempotency_key" ON "candidate_import" ("admin_id", "idempotency_key")
    WHERE "idempotency_key" IS NOT NULL;

CREATE UNIQUE INDEX "candidate_import_one_committing_per_admin" ON "candidate_import" ("admin_id")
    WHERE "status" = 'COMMITTING';

ALTER TABLE "candidate_import" DROP CONSTRAINT "candidate_import_status_check";
ALTER TABLE "candidate_import" ADD CONSTRAINT "candidate_import_status_check" CHECK ("status" IN (
    'PREVIEWED', 'COMMITTING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED',
    'ABORTED', 'ROLLING_BACK', 'ROLLED_BACK', 'ROLLED_BACK_WITH_CONFLICTS'
));
