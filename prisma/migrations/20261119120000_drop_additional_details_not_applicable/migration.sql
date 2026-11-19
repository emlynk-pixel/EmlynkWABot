-- Additional details: remove the "N/A" marks for the optional fields.
--
-- The N/A feature is removed, so the column added by 20261114120000_additional_details_not_applicable
-- is dropped. That migration stays as it is (it is already applied on some databases); a database
-- that has not applied it yet adds and then drops the column in the same deploy.
--
-- DROPS ONLY THIS COLUMN: the existing N/A marks are discarded. The marked fields themselves were
-- always left NULL, so no other data changes. No constraint, index, view or trigger references the
-- column (the verification-reset trigger compares whole rows with to_jsonb, and the sheet-sync
-- capture trigger only reads passport_id), so nothing else changes.
--
-- Rollback (the discarded N/A marks do not come back; every row gets '{}'):
--   ALTER TABLE "candidate_additional_details" ADD COLUMN     "not_applicable_fields" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "candidate_additional_details" DROP COLUMN IF EXISTS "not_applicable_fields";
