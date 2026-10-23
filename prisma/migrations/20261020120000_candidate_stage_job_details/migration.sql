-- Candidate stage "Job Details" and the Test Details field meaning.
-- ADDITIVE ONLY: three nullable columns on candidate_stages. No existing column,
-- row or constraint changes; `stage` is plain text, so the new JOB_DETAILS stage
-- needs no schema change and existing candidates simply have no JOB_DETAILS row
-- (it reads as not completed, with no date or note).
--
-- test_agent_name  TEST_DETAILS: the agent associated with the test record (text).
-- test_id          TEST_DETAILS: the test's own identifier. It replaces the old
--                  free-text "Job ID" box. job_id is LEFT IN PLACE, untouched and
--                  no longer written: another version of the application may still
--                  read it (the database is shared), and a row without test_id
--                  shows the old value as its Test ID. It is never read as a Job.
-- job_details_date JOB_DETAILS: the saved date. The note and completion use the
--                  existing notes / completed columns; the Job and Client are
--                  derived from job_candidate and are NOT stored on the stage.
--
-- IF NOT EXISTS keeps a repeat run harmless.

ALTER TABLE "candidate_stages" ADD COLUMN IF NOT EXISTS "test_agent_name" TEXT;
ALTER TABLE "candidate_stages" ADD COLUMN IF NOT EXISTS "test_id" TEXT;
ALTER TABLE "candidate_stages" ADD COLUMN IF NOT EXISTS "job_details_date" DATE;

COMMENT ON COLUMN "candidate_stages"."job_id" IS 'LEGACY free text, entered as "Job ID" on Test details. Not written any more; read only as a Test ID when test_id is empty. The Job is the job_candidate assignment.';
