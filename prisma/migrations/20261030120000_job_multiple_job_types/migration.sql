-- Job <-> Job Type becomes MANY-TO-MANY (Job Management).
-- A single Job can support multiple Job Types (e.g. ALUMINIUM WORKER, WELDER, PLUMBER).
--
-- ADDITIVE, STAGED: a new join table "job_job_type", backfilled from the current
-- single job type link (job.job_type_id). Nothing is dropped or rewritten:
--   * job.job_type_id, its FK and its index STAY (deprecated): maintained as the primary
--     (first) job type for backwards compatibility with legacy queries and external callers.
--     Its NOT NULL constraint is dropped so new relations are decoupled.
--   * Backfill: every existing job with a job_type_id gets its corresponding row in "job_job_type".
--   * Safe to run twice (IF NOT EXISTS / ON CONFLICT DO NOTHING / guarded constraints).

CREATE TABLE IF NOT EXISTS "job_job_type" (
    "job_id" UUID NOT NULL,
    "job_type_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- UNIQUE(job_id, job_type_id): prevents duplicate Job Type associations on the same Job.
    CONSTRAINT "job_job_type_pkey" PRIMARY KEY ("job_id", "job_type_id")
);

-- Foreign keys:
-- CASCADE: if a job is deleted, its job_job_type rows are removed.
-- RESTRICT: a Job Type cannot be deleted while a job_job_type row references it.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_job_type_job_id_fkey') THEN
        ALTER TABLE "job_job_type" ADD CONSTRAINT "job_job_type_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_job_type_job_type_id_fkey') THEN
        ALTER TABLE "job_job_type" ADD CONSTRAINT "job_job_type_job_type_id_fkey" FOREIGN KEY ("job_type_id") REFERENCES "job_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

-- Index to support querying jobs by job_type_id.
CREATE INDEX IF NOT EXISTS "job_job_type_job_type_id_idx" ON "job_job_type"("job_type_id");

-- Drop NOT NULL on legacy job.job_type_id so future decouple is supported without constraint violation.
ALTER TABLE "job" ALTER COLUMN "job_type_id" DROP NOT NULL;

-- Backfill every existing job's current Job Type into job_job_type.
INSERT INTO "job_job_type" ("job_id", "job_type_id")
SELECT "id", "job_type_id" FROM "job"
WHERE "job_type_id" IS NOT NULL
ON CONFLICT ("job_id", "job_type_id") DO NOTHING;

-- Verify: every job with job_type_id has its job_job_type row.
DO $$
DECLARE missing INTEGER;
BEGIN
    SELECT count(*) INTO missing FROM "job" j
    WHERE j."job_type_id" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "job_job_type" jjt WHERE jjt."job_id" = j."id" AND jjt."job_type_id" = j."job_type_id");
    IF missing > 0 THEN
        RAISE EXCEPTION 'job_job_type backfill incomplete: % job(s) without their job type link', missing;
    END IF;
END $$;

COMMENT ON TABLE "job_job_type" IS 'Job <-> Job Type associations (many-to-many). Supports multiple job types per job while preserving legacy job.job_type_id.';
COMMENT ON COLUMN "job"."job_type_id" IS 'DEPRECATED (20261030120000_job_multiple_job_types): the Job''s primary job type before job_job_type existed. Maintained for backwards compatibility; job_job_type is the source.';

-- Backend-only table: RLS enabled, no privileges for anon or authenticated API roles.
ALTER TABLE "job_job_type" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "job_job_type" FROM anon, authenticated;
