-- Phase 10: Remove from Review. Additive only: two nullable columns on
-- audit_logs. Removing a waiting file deletes its temporary_data row and its
-- files, so the audit entry keeps what was removed (document type and file
-- checksum). Existing rows get NULL; no row is updated, nothing is dropped.
-- Adding a column is a schema change, not a row UPDATE, so the append-only
-- trigger is not involved.

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "document_type" TEXT,
ADD COLUMN     "file_sha256" CHAR(64);
