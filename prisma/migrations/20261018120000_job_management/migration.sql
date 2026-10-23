-- Job Management: a real Job entity and a real Candidate <-> Job relation.
-- ADDITIVE ONLY: new tables, indexes, constraints, functions and triggers. No
-- existing table, column or row is changed or dropped.
--
-- New tables: job_type, company, agent, job_code_counter, job, job_candidate.
-- (No Agent, Company or Job Type table existed before.)
--
-- LEGACY candidate_stages.job_id (free text on TEST_DETAILS) is NOT dropped
-- and NOT converted. A job reference carries no Company, Agent or Job Type, so
-- a Job row could only be fabricated from it; it stays in place as read-only
-- legacy data (the API no longer writes it), shown as "Legacy job reference"
-- until staff create the real Job and assign the candidate. Audit at the time
-- of writing (scripts/auditLegacyJobIds.js, read-only): 11 stage rows, 1 with
-- a job_id ("Job12", one candidate, no duplicates or spelling variants).
-- Dropping the column is a later, separate decision once no legacy value is
-- left to map (Docs/JOB_MANAGEMENT_IMPLEMENTATION.md).

-- CreateTable
CREATE TABLE "job_type" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_type_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "job_type_code_check" CHECK ("code" ~ '^[A-Z0-9_]{1,40}$'),
    CONSTRAINT "job_type_name_check" CHECK (btrim("name") <> '')
);
CREATE UNIQUE INDEX "job_type_code_key" ON "job_type"("code");
CREATE UNIQUE INDEX "job_type_name_lower_key" ON "job_type"(lower("name"));

-- CreateTable
CREATE TABLE "company" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "company_name_check" CHECK (btrim("name") <> '')
);
CREATE UNIQUE INDEX "company_name_lower_key" ON "company"(lower("name"));

-- CreateTable
CREATE TABLE "agent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_name_check" CHECK (btrim("name") <> ''),
    CONSTRAINT "agent_country_code_check" CHECK ("country_code" ~ '^[A-Z]{2}$')
);
CREATE UNIQUE INDEX "agent_name_country_lower_key" ON "agent"(lower("name"), "country_code");

-- CreateTable: next_number = the number the NEXT job of that year gets.
CREATE TABLE "job_code_counter" (
    "year" INTEGER NOT NULL,
    "next_number" INTEGER NOT NULL,

    CONSTRAINT "job_code_counter_pkey" PRIMARY KEY ("year"),
    CONSTRAINT "job_code_counter_next_check" CHECK ("next_number" >= 1)
);

-- CreateTable
CREATE TABLE "job" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_code" TEXT NOT NULL,
    "job_type_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "responsible_agent_id" UUID NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "vacancies" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,

    CONSTRAINT "job_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "job_code_format_check" CHECK ("job_code" ~ '^JOB-[0-9]{4}-[0-9]{6,}$'),
    CONSTRAINT "job_status_check" CHECK ("status" IN ('PROCESSING', 'COMPLETED', 'CANCELLED')),
    CONSTRAINT "job_country_code_check" CHECK ("country_code" ~ '^[A-Z]{2}$'),
    CONSTRAINT "job_vacancies_check" CHECK ("vacancies" IS NULL OR "vacancies" > 0),
    -- The timestamps and the reason say exactly what the status says.
    CONSTRAINT "job_completed_at_check" CHECK (("status" = 'COMPLETED') = ("completed_at" IS NOT NULL)),
    CONSTRAINT "job_cancelled_check" CHECK (
        ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)
        AND (("status" = 'CANCELLED') = ("cancel_reason" IS NOT NULL))
        AND ("cancel_reason" IS NULL OR btrim("cancel_reason") <> '')
    )
);
CREATE UNIQUE INDEX "job_job_code_key" ON "job"("job_code");
CREATE INDEX "job_status_created_at_idx" ON "job"("status", "created_at");
CREATE INDEX "job_company_id_idx" ON "job"("company_id");
CREATE INDEX "job_responsible_agent_id_idx" ON "job"("responsible_agent_id");
CREATE INDEX "job_job_type_id_idx" ON "job"("job_type_id");

-- CreateTable
CREATE TABLE "job_candidate" (
    "job_id" UUID NOT NULL,
    "passport_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- UNIQUE(job_id, passport_id): one membership row per candidate and job.
    CONSTRAINT "job_candidate_pkey" PRIMARY KEY ("job_id", "passport_id"),
    -- A candidate removed from a job is not active on it.
    CONSTRAINT "job_candidate_released_check" CHECK ("released_at" IS NULL OR NOT "is_active")
);
CREATE INDEX "job_candidate_passport_id_idx" ON "job_candidate"("passport_id");

-- A candidate is active on AT MOST ONE job (the PROCESSING one). This is the
-- database's own guarantee behind the service's checks and row locks: two
-- concurrent assignments cannot both commit.
CREATE UNIQUE INDEX "job_candidate_one_active_per_candidate" ON "job_candidate"("passport_id") WHERE "is_active";

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_job_type_id_fkey" FOREIGN KEY ("job_type_id") REFERENCES "job_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "job" ADD CONSTRAINT "job_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "job" ADD CONSTRAINT "job_responsible_agent_id_fkey" FOREIGN KEY ("responsible_agent_id") REFERENCES "agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "job" ADD CONSTRAINT "job_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Jobs are never hard-deleted: a job with memberships cannot be removed.
ALTER TABLE "job_candidate" ADD CONSTRAINT "job_candidate_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "job_candidate" ADD CONSTRAINT "job_candidate_passport_id_fkey" FOREIGN KEY ("passport_id") REFERENCES "candidate"("passport_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "job_candidate" ADD CONSTRAINT "job_candidate_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "user"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A COMPLETED or CANCELLED job never returns to PROCESSING (reopening is not
-- approved; it needs its own migration and the re-check of every candidate).
-- Leaving PROCESSING clears the job's active memberships in the same
-- transaction; the rows themselves are kept as history.
CREATE FUNCTION "job_status_transition"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD."status" <> 'PROCESSING' AND NEW."status" <> OLD."status" THEN
        RAISE EXCEPTION 'job % is % and cannot change status', OLD."job_code", OLD."status";
    END IF;
    IF OLD."status" = 'PROCESSING' AND NEW."status" <> 'PROCESSING' THEN
        UPDATE "job_candidate" SET "is_active" = false, "updated_at" = CURRENT_TIMESTAMP
        WHERE "job_id" = NEW."id" AND "is_active";
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "job_status_transition_trg" BEFORE UPDATE OF "status" ON "job"
    FOR EACH ROW WHEN (OLD."status" IS DISTINCT FROM NEW."status") EXECUTE FUNCTION "job_status_transition"();

-- A membership can only be active on a PROCESSING job.
CREATE FUNCTION "job_candidate_active_requires_processing"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."is_active" AND (SELECT "status" FROM "job" WHERE "id" = NEW."job_id") <> 'PROCESSING' THEN
        RAISE EXCEPTION 'job_candidate cannot be active on a job that is not PROCESSING';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "job_candidate_active_requires_processing_trg" BEFORE INSERT OR UPDATE OF "is_active" ON "job_candidate"
    FOR EACH ROW EXECUTE FUNCTION "job_candidate_active_requires_processing"();

COMMENT ON COLUMN "candidate_stages"."job_id" IS 'DEPRECATED legacy free text. Not written or used for assignment any more; the relation is job_candidate. Read-only, kept so old values are not lost.';

-- Backend-only tables (owner / service-role connection): RLS on, no API-role
-- privileges, no policies. The backend connects as the owner, which bypasses RLS.
ALTER TABLE "job_type" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "job_type" FROM anon, authenticated;
ALTER TABLE "company" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "company" FROM anon, authenticated;
ALTER TABLE "agent" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "agent" FROM anon, authenticated;
ALTER TABLE "job_code_counter" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "job_code_counter" FROM anon, authenticated;
ALTER TABLE "job" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "job" FROM anon, authenticated;
ALTER TABLE "job_candidate" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "job_candidate" FROM anon, authenticated;
