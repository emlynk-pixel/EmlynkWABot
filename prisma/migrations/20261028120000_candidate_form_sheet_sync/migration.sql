-- Outbox of the Candidate Form -> Google Sheet submission sync (tab "Candidate Form Submissions").
-- ADDITIVE ONLY: one new table. candidate_form_response, the lock, the draft, the prefill snapshot
-- and the operational mirror's sheet_sync_queue are not touched.
--
-- One row per submission, inserted by the application in the same transaction as the
-- candidate_form_response row. A candidate submits once, so passport_id is UNIQUE: a retried or
-- repeated submit can never enqueue a second row, and the Sheet never gets a second row for the
-- same submission. submission_id is the submission's stable ID (the Sheet's _SUBMISSION_ID).
-- The row holds no candidate data: the worker reads the response when it processes the row.
-- Rows are kept after they complete (they are the stable ID of the submission).

CREATE TABLE "candidate_form_sheet_sync" (
    "submission_id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "passport_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMPTZ(3),
    "last_result" TEXT,
    "last_error_class" TEXT,
    "last_error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "candidate_form_sheet_sync_pkey" PRIMARY KEY ("submission_id"),
    CONSTRAINT "candidate_form_sheet_sync_status_check" CHECK ("status" IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'))
);

CREATE UNIQUE INDEX "candidate_form_sheet_sync_passport_id_key" ON "candidate_form_sheet_sync"("passport_id");
CREATE INDEX "candidate_form_sheet_sync_status_next_attempt_at_idx" ON "candidate_form_sheet_sync"("status", "next_attempt_at");

ALTER TABLE "candidate_form_sheet_sync" ADD CONSTRAINT "candidate_form_sheet_sync_passport_id_fkey" FOREIGN KEY ("passport_id") REFERENCES "candidate"("passport_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backend-only table: RLS on, no API-role privileges, no policies.
ALTER TABLE "candidate_form_sheet_sync" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "candidate_form_sheet_sync" FROM anon, authenticated;
