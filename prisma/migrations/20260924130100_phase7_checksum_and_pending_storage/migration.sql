-- Phase 7: SHA-256 duplicate detection and pending-copy location.
-- Adds nullable columns and indexes only; no existing data is changed.
-- Checksums are unique per client (passport_id), not globally, so the same
-- file under another client is flagged for review instead of rejected.

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "file_sha256" CHAR(64);

-- AlterTable
ALTER TABLE "temporary_data" ADD COLUMN     "file_sha256" CHAR(64),
ADD COLUMN     "pending_storage_path" TEXT;

-- CreateIndex
CREATE INDEX "documents_file_sha256_idx" ON "documents"("file_sha256");

-- CreateIndex
CREATE UNIQUE INDEX "documents_passport_id_file_sha256_key" ON "documents"("passport_id", "file_sha256");

-- CreateIndex
CREATE INDEX "temporary_data_whatsapp_number_file_sha256_idx" ON "temporary_data"("whatsapp_number", "file_sha256");
