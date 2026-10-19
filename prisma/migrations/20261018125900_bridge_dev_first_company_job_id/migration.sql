-- Bridge for databases built from dev BEFORE the Candidate Form migrations.
-- Pairs with 20261023120000_reconcile_job_company_job_id. Never edits an applied migration.
--
-- Why: 20261018130000_job_company_id_and_form_job_group is already applied on
-- the shared database and must stay byte-identical. It adds job.company_job_id,
-- its CHECK and a unique index on ("company_id", "company_job_id"). A database
-- that ran dev's 20261019120000_client_management first already has
-- company_job_id (and its CHECK and index) and has no company_id (renamed to
-- client_id), so 20261018130000 would fail there.
--
-- What: ONLY in that dev-first state (company_job_id exists, company_id does
-- not, and candidate_form_link.job_id does not, i.e. 20261018130000 has not
-- run) this parks dev's company_job_id values in "company_job_id_reconcile",
-- drops the CHECK and index that 20261018130000 is about to create under the
-- same names, and adds a temporary, empty "company_id" column for its index.
-- 20261023120000 then copies the values back and removes the temporary pieces.
-- On every other database (fresh, Candidate Form branch, shared) it does nothing.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job' AND column_name = 'company_job_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job' AND column_name = 'company_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'candidate_form_link' AND column_name = 'job_id')
    THEN
        ALTER TABLE "job" DROP CONSTRAINT IF EXISTS "job_company_job_id_check";
        DROP INDEX IF EXISTS "job_company_job_id_key";
        ALTER TABLE "job" RENAME COLUMN "company_job_id" TO "company_job_id_reconcile";
        ALTER TABLE "job" ADD COLUMN "company_id" UUID;
    END IF;
END $$;
