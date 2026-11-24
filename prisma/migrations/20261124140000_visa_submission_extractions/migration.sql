-- Visa Submission Phase 2: extraction of the signed VISA_SUBMISSION documents into
-- VISA SUBMISSION/{YYYY-MM-DD}/Plan B/ (src/services/visaExtractionService.js).
-- Additive only: two new tables, their indexes and foreign keys. No existing table,
-- column or row is changed and nothing is backfilled.
--
-- visa_submission_extraction: one row per extracted document.
--   document_id   UNIQUE: a document is extracted once; a re-uploaded signed file is a
--                 new document, so it is eligible again. ON DELETE SET NULL: removing a
--                 VISA_SUBMISSION document deletes its row (candidateService.js
--                 removeCandidateDocument), which must keep working and keep this history.
--   passport_id   -> candidate (CASCADE, like job_candidate)
--   job_id        -> job (RESTRICT: jobs are never deleted)
--   extracted_by  -> "user" (RESTRICT, like audit_logs)
-- visa_submission_extraction_lock: a lease per (Asia/Colombo date, Client files), so two
-- extractions never read-modify-write the same Excel files at once. No candidate data.

-- CreateTable
CREATE TABLE "visa_submission_extraction" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "passport_id" TEXT NOT NULL,
    "job_id" UUID NOT NULL,
    "document_id" TEXT,
    "client_name" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "extracted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "extracted_by" TEXT NOT NULL,

    CONSTRAINT "visa_submission_extraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visa_submission_extraction_lock" (
    "lock_key" TEXT NOT NULL,
    "holder" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "visa_submission_extraction_lock_pkey" PRIMARY KEY ("lock_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "visa_submission_extraction_document_id_key" ON "visa_submission_extraction"("document_id");

-- CreateIndex
CREATE INDEX "visa_submission_extraction_job_id_extracted_at_idx" ON "visa_submission_extraction"("job_id", "extracted_at");

-- CreateIndex
CREATE INDEX "visa_submission_extraction_passport_id_idx" ON "visa_submission_extraction"("passport_id");

-- CreateIndex
CREATE INDEX "visa_submission_extraction_extracted_by_idx" ON "visa_submission_extraction"("extracted_by");

-- AddForeignKey
ALTER TABLE "visa_submission_extraction" ADD CONSTRAINT "visa_submission_extraction_passport_id_fkey" FOREIGN KEY ("passport_id") REFERENCES "candidate"("passport_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visa_submission_extraction" ADD CONSTRAINT "visa_submission_extraction_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visa_submission_extraction" ADD CONSTRAINT "visa_submission_extraction_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("document_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visa_submission_extraction" ADD CONSTRAINT "visa_submission_extraction_extracted_by_fkey" FOREIGN KEY ("extracted_by") REFERENCES "user"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SEC-001: not readable or writable by Supabase's public API roles (the backend
-- connects as the table owner, which bypasses RLS).
ALTER TABLE "visa_submission_extraction" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "visa_submission_extraction" FROM anon, authenticated;
ALTER TABLE "visa_submission_extraction_lock" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "visa_submission_extraction_lock" FROM anon, authenticated;
