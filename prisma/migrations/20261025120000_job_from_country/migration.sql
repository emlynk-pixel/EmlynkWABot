-- Job "From Country": the country the job's candidates travel from (Admin > Jobs).
-- ADDITIVE ONLY: one nullable column and its CHECK. No existing row, column or
-- constraint is changed.
--
-- "To Country" is NOT a new column: it is the existing job.country_code, the
-- Client's country (= its responsible Agent's country) copied when the job is
-- created, so a job keeps the country it was created for.
--
-- No backfill, on purpose: a job created before this column has no recorded From
-- Country and stays NULL (shown as not recorded); nothing is guessed for it. New
-- jobs get one from the service (default RO, editable). Safe to run twice.

ALTER TABLE "job" ADD COLUMN IF NOT EXISTS "from_country_code" CHAR(2);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_from_country_code_check') THEN
        ALTER TABLE "job" ADD CONSTRAINT "job_from_country_code_check" CHECK ("from_country_code" IS NULL OR "from_country_code" ~ '^[A-Z]{2}$');
    END IF;
END $$;

COMMENT ON COLUMN "job"."from_country_code" IS 'ISO 3166-1 alpha-2 country the candidates travel from (default RO for new jobs). NULL for jobs created before it was recorded.';
