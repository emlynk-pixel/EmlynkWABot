-- Bulk candidate import (Settings > Google Sheet Sync > Update Sheet; candidateImport*.js).
-- ADDITIVE ONLY: one new table. Nothing existing changes.
--
-- One row per import: it coordinates the preview with the chunked commit and keeps the outcome.
-- It holds NO candidate data: no passport number, NIC, phone, name or any other cell value, and
-- never the uploaded file (the workbook is read in the browser; only allow-listed columns are sent).
--   chunk_hashes    SHA-256 of each previewed chunk of rows, so a commit can only write exactly
--                   what was previewed (a hash of a whole chunk; not reversible to a value)
--   source_flags    source ROW NUMBERS found in the preview (duplicate passports within the file,
--                   NICs or WhatsApp numbers shared by different passports within the file)
--   preview_counts  the preview's counts; result_counts / chunk_results: the commit's counts and
--                   safe reason codes (INVALID_PASSPORT, NIC_CONFLICT, ...) per chunk
-- status: PREVIEWED -> COMMITTING -> COMPLETED | COMPLETED_WITH_ERRORS | FAILED
CREATE TABLE "candidate_import" (
    "import_id" UUID NOT NULL,
    "admin_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "total_rows" INTEGER NOT NULL,
    "chunk_size" INTEGER NOT NULL,
    "chunk_hashes" JSONB NOT NULL,
    "source_flags" JSONB NOT NULL DEFAULT '{}',
    "preview_counts" JSONB NOT NULL DEFAULT '{}',
    "chunk_results" JSONB NOT NULL DEFAULT '{}',
    "result_counts" JSONB,
    "sync_run_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    CONSTRAINT "candidate_import_pkey" PRIMARY KEY ("import_id"),
    CONSTRAINT "candidate_import_status_check" CHECK ("status" IN ('PREVIEWED', 'COMMITTING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED')),
    CONSTRAINT "candidate_import_total_rows_check" CHECK ("total_rows" >= 0),
    CONSTRAINT "candidate_import_chunk_size_check" CHECK ("chunk_size" > 0),
    CONSTRAINT "candidate_import_chunk_hashes_check" CHECK (jsonb_typeof("chunk_hashes") = 'array'),
    CONSTRAINT "candidate_import_chunk_results_check" CHECK (jsonb_typeof("chunk_results") = 'object'),
    CONSTRAINT "candidate_import_file_name_check" CHECK (char_length("file_name") BETWEEN 1 AND 200)
);

ALTER TABLE "candidate_import" ADD CONSTRAINT "candidate_import_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "user"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "candidate_import_admin_id_created_at_idx" ON "candidate_import"("admin_id", "created_at");

-- Backend-only table: RLS on, no API-role privileges, no policies.
ALTER TABLE "candidate_import" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "candidate_import" FROM anon, authenticated;
