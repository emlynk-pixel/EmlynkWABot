-- Bulk candidate import hardening: duplicate-upload protection and the states an interrupted import
-- needs (candidateImportService.js). ADDITIVE: no existing row is changed.
--
--   idempotency_key  an optional client-generated key per file choice (header Idempotency-Key): the same
--                    key from the same admin names the same import, so a repeated or retried preview
--                    never creates a second one.
--   single committing  at most ONE import may be COMMITTING at a time. Imports allocate unique IDs and
--                    Job groups under shared locks and race on passports, so two committing at once only
--                    produce conflicts. A COMMITTING import that stopped (closed tab) is resumed by
--                    its owner or aborted; the application treats one idle for 15 minutes as stale.
--   status           ABORTED (stopped on purpose, rows kept) and the rollback states used by the
--                    rollback work (ROLLING_BACK, ROLLED_BACK, ROLLED_BACK_WITH_CONFLICTS).
--
-- Precondition for the single-committing index: at most one COMMITTING import exists today. If this
-- migration stops here, finish or abort the extra imports first; nothing is changed automatically.
DO $$
BEGIN
    IF (SELECT count(*) FROM "candidate_import" WHERE "status" = 'COMMITTING') > 1 THEN
        RAISE EXCEPTION 'More than one candidate_import is COMMITTING: finish or abort all but one before applying this migration';
    END IF;
END $$;

ALTER TABLE "candidate_import" ADD COLUMN "idempotency_key" TEXT;

ALTER TABLE "candidate_import" ADD CONSTRAINT "candidate_import_idempotency_key_check"
    CHECK ("idempotency_key" IS NULL OR "idempotency_key" ~ '^[A-Za-z0-9_-]{8,100}$');

CREATE UNIQUE INDEX "candidate_import_admin_idempotency_key" ON "candidate_import" ("admin_id", "idempotency_key")
    WHERE "idempotency_key" IS NOT NULL;

CREATE UNIQUE INDEX "candidate_import_single_committing" ON "candidate_import" ((TRUE))
    WHERE "status" = 'COMMITTING';

ALTER TABLE "candidate_import" DROP CONSTRAINT "candidate_import_status_check";
ALTER TABLE "candidate_import" ADD CONSTRAINT "candidate_import_status_check" CHECK ("status" IN (
    'PREVIEWED', 'COMMITTING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED',
    'ABORTED', 'ROLLING_BACK', 'ROLLED_BACK', 'ROLLED_BACK_WITH_CONFLICTS'
));
