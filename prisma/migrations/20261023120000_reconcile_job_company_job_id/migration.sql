-- Forward-only completion of 20261018125900_bridge_dev_first_company_job_id.
--
-- Acts ONLY where the bridge acted (the column "company_job_id_reconcile"
-- exists): a database built from dev first. There 20261018130000 has just
-- re-added an empty job.company_job_id with its CHECK, and an index on the
-- temporary, empty "company_id" column. This step:
--   1. copies the dev values back into company_job_id (no data loss; they
--      already passed the same CHECK and were unique per client);
--   2. drops the parked column and the temporary company_id column (which
--      also drops the index that was built on it);
--   3. recreates the unique index on ("client_id", "company_job_id") and
--      the column comment, exactly as a fresh database has them.
-- Everywhere else (fresh, Candidate Form branch, shared) it does nothing.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job' AND column_name = 'company_job_id_reconcile') THEN
        UPDATE "job" SET "company_job_id" = "company_job_id_reconcile" WHERE "company_job_id_reconcile" IS NOT NULL;
        ALTER TABLE "job" DROP COLUMN "company_job_id_reconcile";
        DROP INDEX IF EXISTS "job_company_job_id_key";
        ALTER TABLE "job" DROP COLUMN IF EXISTS "company_id";
        CREATE UNIQUE INDEX "job_company_job_id_key" ON "job"("client_id", "company_job_id") WHERE "company_job_id" IS NOT NULL;
        COMMENT ON COLUMN "job"."company_job_id" IS 'The employer''s own external job reference (a label, not a key). Not related to the removed "company" entity, which is now "client".';
    END IF;
END $$;
