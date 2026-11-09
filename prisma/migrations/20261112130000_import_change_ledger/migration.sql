-- Bulk candidate import: the per-import CHANGE LEDGER (candidateImportLedger.js). ADDITIVE ONLY: one new
-- table; nothing existing changes. Applied after 20261112120000_import_hardening.
--
-- One row per change an import made to one entity, written in the SAME transaction as the change itself
-- (one chunk = one transaction, or one row's own transaction when a chunk falls back to row by row), so a
-- chunk that fails leaves neither its changes nor its ledger rows, and a chunk that commits has both.
-- It exists so an import can later be reversed safely (rollback), entry by entry, and only where nothing
-- has changed the record since:
--   entity_type / entity_key  what was changed, by INTERNAL id: a candidate by its unique_id, a Job, Client or
--                             Agent by its uuid, a stage / link by a composite of those. No passport number.
--   candidate_unique_id       the candidate concerned (also how the Google Sheet mirror's queue names it)
--   op                        CREATE (the import created the entity), FILL (the import filled blank fields of
--                             an entity that already existed), LINK (the import created a relationship)
--   pre_existing              false = created by this import, true = existed before it
--   changes                   { field: { before, after } }. Candidate / details / Client / Agent values are
--                             personal or business data: before is the blank that was there (null / ""),
--                             after is { "h": sha256 } so the ledger holds no personal data and a rollback can
--                             still check "is the current value still what this import wrote". Ids, flags,
--                             statuses and dates of stages / Jobs / allocations are stored as they are.
--   related_job_id / job_created_by_import   the Job a membership belongs to, and whether this import made it
--   audit_ids                 the audit_logs rows written for this change (same transaction)
--   rollback_action           what a rollback may do, and only if the record is unchanged:
--                             DELETE_IF_UNCHANGED (created by the import), CLEAR_IF_UNCHANGED (blank the filled
--                             fields), NONE
--   status / revert_detail    APPLIED -> REVERTED | CONFLICT | SKIPPED, set by the rollback (never by the import)
--   changes_digest            hash of the entry's content: a repeated write of the same change is refused by
--                             the unique index instead of being recorded twice
-- Synchronization to Google Sheets needs no row of its own: the queue (sheet_sync_queue) holds only "candidate
-- <unique_id> changed", never data, and a reconciliation mirrors the database as it is then.
CREATE TABLE "candidate_import_change" (
    "change_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "import_id" UUID NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "row_number" INTEGER,
    "entity_type" TEXT NOT NULL,
    "entity_key" TEXT NOT NULL,
    "candidate_unique_id" TEXT,
    "op" TEXT NOT NULL,
    "pre_existing" BOOLEAN NOT NULL,
    "changes" JSONB NOT NULL DEFAULT '{}',
    "related_job_id" UUID,
    "job_created_by_import" BOOLEAN,
    "audit_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "rollback_action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'APPLIED',
    "revert_detail" JSONB,
    "reverted_at" TIMESTAMPTZ(3),
    "changes_digest" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "candidate_import_change_pkey" PRIMARY KEY ("change_id"),
    CONSTRAINT "candidate_import_change_entity_type_check" CHECK ("entity_type" IN (
        'CANDIDATE', 'CANDIDATE_ADDITIONAL_DETAILS', 'CANDIDATE_STAGE', 'CANDIDATE_ALLOCATION',
        'CLIENT', 'AGENT', 'AGENT_CLIENT', 'JOB', 'IMPORT_JOB_GROUP', 'JOB_CANDIDATE'
    )),
    CONSTRAINT "candidate_import_change_op_check" CHECK ("op" IN ('CREATE', 'FILL', 'LINK')),
    CONSTRAINT "candidate_import_change_rollback_action_check" CHECK ("rollback_action" IN ('DELETE_IF_UNCHANGED', 'CLEAR_IF_UNCHANGED', 'NONE')),
    CONSTRAINT "candidate_import_change_status_check" CHECK ("status" IN ('APPLIED', 'REVERTED', 'CONFLICT', 'SKIPPED')),
    CONSTRAINT "candidate_import_change_changes_check" CHECK (jsonb_typeof("changes") = 'object'),
    CONSTRAINT "candidate_import_change_chunk_index_check" CHECK ("chunk_index" >= 0),
    CONSTRAINT "candidate_import_change_created_has_no_before_check" CHECK ("op" <> 'CREATE' OR "pre_existing" = false),
    CONSTRAINT "candidate_import_change_fill_is_pre_existing_check" CHECK ("op" <> 'FILL' OR "pre_existing" = true)
);

-- An import's own history is deleted only with the import (the application never deletes either).
ALTER TABLE "candidate_import_change" ADD CONSTRAINT "candidate_import_change_import_id_fkey"
    FOREIGN KEY ("import_id") REFERENCES "candidate_import"("import_id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "candidate_import_change_unique_entry" ON "candidate_import_change" ("import_id", "entity_type", "entity_key", "op", "changes_digest");
CREATE INDEX "candidate_import_change_import_chunk_idx" ON "candidate_import_change" ("import_id", "chunk_index");
CREATE INDEX "candidate_import_change_entity_idx" ON "candidate_import_change" ("entity_type", "entity_key");
CREATE INDEX "candidate_import_change_candidate_idx" ON "candidate_import_change" ("candidate_unique_id");

ALTER TABLE "candidate_import_change" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "candidate_import_change" FROM anon, authenticated;
