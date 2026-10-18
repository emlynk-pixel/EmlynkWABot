-- Client Management: the employer entity is a CLIENT, not a "company".
-- Follows 20261018120000_job_management (copied unchanged from the Job
-- Management work, so a database that already ran it only runs this file).
-- Forward-only and data-preserving: nothing is dropped or recreated.
--
-- 1. company -> client (table rename: primary key, rows, ids and the job
--    foreign key are kept; job.company_id -> job.client_id). Constraint and
--    index names are renamed to match. There is exactly ONE employer table.
-- 2. client.agent_id -> agent.id: each Client has ONE responsible Agent (one
--    Agent manages many Clients). Added nullable and backfilled from the
--    client's newest job, because a pre-existing client cannot be given an
--    agent it never had; a client without one cannot get a new job until staff
--    assign an Agent (the service enforces it on every create / update).
--    ON DELETE RESTRICT: agents are never hard-deleted.
-- 3. agent and client contact details (all optional).
-- 4. job.company_job_id: the EMPLOYER'S OWN external job reference (e.g.
--    Y26S01). Deliberately NOT renamed: it is a label, not the Company entity.
--    Unique per client when present, never a key. Created only if missing (the
--    Candidate Form branch's migration may already have added it).

-- 1. company -> client ------------------------------------------------------
ALTER TABLE "company" RENAME TO "client";
ALTER TABLE "client" RENAME CONSTRAINT "company_pkey" TO "client_pkey";
ALTER TABLE "client" RENAME CONSTRAINT "company_name_check" TO "client_name_check";
ALTER INDEX "company_name_lower_key" RENAME TO "client_name_lower_key";
ALTER TABLE "job" RENAME COLUMN "company_id" TO "client_id";
ALTER TABLE "job" RENAME CONSTRAINT "job_company_id_fkey" TO "job_client_id_fkey";
ALTER INDEX "job_company_id_idx" RENAME TO "job_client_id_idx";

-- 2. client -> agent ----------------------------------------------------------
ALTER TABLE "client" ADD COLUMN "agent_id" UUID;
UPDATE "client" SET "agent_id" = (
    SELECT j."responsible_agent_id" FROM "job" j WHERE j."client_id" = "client"."id" ORDER BY j."created_at" DESC LIMIT 1
);
ALTER TABLE "client" ADD CONSTRAINT "client_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "client_agent_id_idx" ON "client"("agent_id");

-- 3. contact details -----------------------------------------------------------
ALTER TABLE "agent" ADD COLUMN "contact_number" TEXT, ADD COLUMN "whatsapp_number" TEXT, ADD COLUMN "email" TEXT, ADD COLUMN "address" TEXT, ADD COLUMN "notes" TEXT;
ALTER TABLE "client" ADD COLUMN "contact_person" TEXT, ADD COLUMN "contact_number" TEXT, ADD COLUMN "whatsapp_number" TEXT, ADD COLUMN "email" TEXT, ADD COLUMN "address" TEXT;

-- 4. the employer's own job reference -------------------------------------------
-- job.company_job_id may ALREADY exist: the Candidate Form branch's migration
-- 20261018130000_job_company_id_and_form_job_group adds it (column, format CHECK
-- and the unique index), and that migration is applied on the shared database.
-- So each object is created only when missing; nothing is dropped or recreated and
-- every stored value is kept. On a database that already has them, the unique index
-- (created on company_id) followed the column rename above and is now on
-- (client_id, company_job_id) under the same name.
ALTER TABLE "job" ADD COLUMN IF NOT EXISTS "company_job_id" TEXT;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.job'::regclass AND conname = 'job_company_job_id_check') THEN
        ALTER TABLE "job" ADD CONSTRAINT "job_company_job_id_check" CHECK ("company_job_id" IS NULL OR "company_job_id" ~ '^[A-Z0-9][A-Z0-9 ._/#-]{0,39}$');
    END IF;
END
$$;
CREATE UNIQUE INDEX IF NOT EXISTS "job_company_job_id_key" ON "job"("client_id", "company_job_id") WHERE "company_job_id" IS NOT NULL;

COMMENT ON COLUMN "job"."company_job_id" IS 'The employer''s own external job reference (a label, not a key). Not related to the removed "company" entity, which is now "client".';

COMMENT ON COLUMN "candidate_stages"."job_id" IS 'Legacy free text on the Test details stage. The relational job assignment is job_candidate (Admin > Jobs); this column is neither read for it nor converted.';
