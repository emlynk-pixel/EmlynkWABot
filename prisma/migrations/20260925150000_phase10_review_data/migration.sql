-- Phase 10, Checkpoint 3: persist the review data the pipeline already
-- computes, so the admin Review Queue and Review Detail can show it.
-- Additive only: new nullable columns, no rename, no drop, no data rewrite.
-- Existing rows keep NULL (processed before this migration).

-- The submission a stored document came from. A REVIEW_REQUIRED document's
-- review reason and processing summary live on that temporary_data row.
-- SET NULL: if temporary rows are ever cleaned up (Phase 8), documents stay.
ALTER TABLE "documents" ADD COLUMN "temporary_id" TEXT;

-- processing_summary: the PII-free processing summary that is already logged
-- (confidences, band, flags, identity status/notes, field names, placement,
-- failing stage with a redacted error). No document text, names, dates,
-- passport numbers, phone numbers, paths or checksums.
-- review_reason: why a person must review the submission (a fixed code set,
-- src/services/reviewReason.js), NULL when no review is needed.
ALTER TABLE "temporary_data" ADD COLUMN "processing_summary" JSONB,
ADD COLUMN "review_reason" TEXT;

CREATE INDEX "documents_temporary_id_idx" ON "documents"("temporary_id");

ALTER TABLE "documents" ADD CONSTRAINT "documents_temporary_id_fkey" FOREIGN KEY ("temporary_id") REFERENCES "temporary_data"("temporary_id") ON DELETE SET NULL ON UPDATE CASCADE;
