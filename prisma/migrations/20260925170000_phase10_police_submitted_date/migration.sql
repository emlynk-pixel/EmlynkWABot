-- Phase 10, Checkpoint 5: police slip submitted date (minimal Phase 9 data
-- for the Police Workflow). Additive only: two nullable DATE columns.
-- Existing rows get NULL; no row is updated, nothing is dropped or renamed.
-- Adding a column to audit_logs is a schema change, not a row UPDATE, so
-- the append-only trigger is not involved.

-- documents: the submitted date of a police slip (read by OCR, or entered
-- by an admin when approving the slip). The 21-day countdown starts here.
-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "police_submitted_date" DATE;

-- audit_logs: the date an admin entered or confirmed when approving a slip.
-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "police_submitted_date" DATE;
