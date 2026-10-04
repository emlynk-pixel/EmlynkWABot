-- Test details stage: the job ID the admin enters, the test's result (PASS or
-- FAIL) and the date the candidate actually sat it. All nullable: existing
-- stage rows keep their notes and completion and simply have no test
-- recorded yet.
-- AlterTable
ALTER TABLE "candidate_stages" ADD COLUMN     "job_id" TEXT,
ADD COLUMN     "test_date" DATE,
ADD COLUMN     "test_result" TEXT;
