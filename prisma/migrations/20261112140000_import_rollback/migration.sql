-- Bulk candidate import: ROLLBACK (candidateImportRollback.js). ADDITIVE ONLY: new columns, one new table and
-- one index; nothing existing changes. Applied after 20261112130000_import_change_ledger.
--
-- A rollback reverses what an import did, entry by entry, from its change ledger (candidate_import_change), and
-- only where the record is exactly as the import left it. It runs in short batches (one transaction each), so a
-- large import never needs one long transaction and an interrupted rollback is resumed, never repeated.
--
-- candidate_import (the import row coordinates the rollback; the statuses ROLLING_BACK / ROLLED_BACK /
-- ROLLED_BACK_WITH_CONFLICTS already exist in its CHECK, migration 20261112120000):
--   rollback_admin_id          who started it
--   rollback_previous_status   the status before it started (shown in the report)
--   rollback_started_at / rollback_completed_at
--   rollback_lease_token / rollback_lease_expires_at
--                              ONE worker at a time: a call claims the lease with a compare-and-swap (free or
--                              expired), renews it after each batch, and a second administrator (or a double
--                              click) is refused while it is held. A request that died leaves a lease that simply
--                              runs out; the next call takes over.
--   rollback_result            counts and codes only (reverted, kept, reasons): never a value
--
-- sheet_deletion_approval: the candidates a rollback deleted. The Google Sheet mirror marks a row inactive
-- only for a few absent candidates at a time (the deletion guard); a rollback of a whole import would exceed it
-- and the guard would, rightly, refuse. The rollback therefore records, in the SAME transaction that deletes a
-- candidate, an approval for exactly that candidate's unique_id. The sheet worker may mark a Sheet row inactive
-- beyond the guard ONLY for an approved unique_id that is absent from its complete database snapshot, then marks
-- the approval consumed. Every other row still goes through the unchanged guard. An approval carries an
-- internal id, never candidate data.
ALTER TABLE "candidate_import"
    ADD COLUMN "rollback_admin_id" TEXT,
    ADD COLUMN "rollback_previous_status" TEXT,
    ADD COLUMN "rollback_started_at" TIMESTAMPTZ(3),
    ADD COLUMN "rollback_completed_at" TIMESTAMPTZ(3),
    ADD COLUMN "rollback_lease_token" UUID,
    ADD COLUMN "rollback_lease_expires_at" TIMESTAMPTZ(3),
    ADD COLUMN "rollback_result" JSONB;

-- The ledger entries still to be reversed / still conflicting, by import.
CREATE INDEX "candidate_import_change_import_status_idx" ON "candidate_import_change" ("import_id", "status");

CREATE TABLE "sheet_deletion_approval" (
    "approval_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "unique_id" TEXT NOT NULL,
    "import_id" UUID NOT NULL,
    "approved_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMPTZ(3),
    CONSTRAINT "sheet_deletion_approval_pkey" PRIMARY KEY ("approval_id")
);

ALTER TABLE "sheet_deletion_approval" ADD CONSTRAINT "sheet_deletion_approval_import_id_fkey"
    FOREIGN KEY ("import_id") REFERENCES "candidate_import"("import_id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "sheet_deletion_approval_import_unique_id_key" ON "sheet_deletion_approval" ("import_id", "unique_id");
CREATE INDEX "sheet_deletion_approval_open_idx" ON "sheet_deletion_approval" ("unique_id") WHERE "consumed_at" IS NULL;

ALTER TABLE "sheet_deletion_approval" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "sheet_deletion_approval" FROM anon, authenticated;
