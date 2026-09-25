-- Phase 10: admin corrections (set document type, assign client, set police
-- slip date). Additive only: two nullable columns on audit_logs holding the
-- corrected value before and after the change. Existing rows get NULL; no
-- row is updated, nothing is dropped. Adding a column is a schema change,
-- not a row UPDATE, so the append-only trigger is not involved.

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "new_value" TEXT,
ADD COLUMN     "previous_value" TEXT;
