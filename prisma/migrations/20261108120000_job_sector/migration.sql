-- Job "Job Sector" (Y26S01): the industry sector a job belongs to, chosen in the New Job form.
-- ADDITIVE ONLY: one nullable column and its CHECK. No existing row, column or constraint is
-- changed.
--
-- A fixed list, stored as a code like job.status: CONSTRUCTION | INDUSTRIAL (labels in the
-- admin app). Optional: a job created before this column, or without a sector, stays NULL.
-- No backfill. Safe to run twice.

ALTER TABLE "job" ADD COLUMN IF NOT EXISTS "job_sector" TEXT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_job_sector_check') THEN
        ALTER TABLE "job" ADD CONSTRAINT "job_job_sector_check" CHECK ("job_sector" IS NULL OR "job_sector" IN ('CONSTRUCTION', 'INDUSTRIAL'));
    END IF;
END $$;

COMMENT ON COLUMN "job"."job_sector" IS 'Job Sector: CONSTRUCTION or INDUSTRIAL. NULL when not set (optional; jobs created before it was recorded).';
