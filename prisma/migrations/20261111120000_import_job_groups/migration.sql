-- Jobs from the Google Sheet upload (importJobGroups.js): candidates are grouped by their
-- Interview Date and the hundreds block of their UNIQUE NUMBER (floor(n / 100)); each group is ONE
-- Job whose code is JOB-YYYY-MMDDNN (NN: the group's two-digit suffix for that date).
-- ADDITIVE ONLY: one new table and one new column. No existing job, job code or row is changed;
-- manual Job creation (JOB-YYYY-NNNNNN from job_code_counter) is untouched.
--
-- import_job_group  the stable mapping (date, block) -> Job. Re-uploads reuse it, so a group keeps
--                   its Job, and a suffix edited by a user (the last two digits of the code) is never
--                   recalculated. One group per (date, block), one suffix per date, one group per Job.
-- candidate_import.job_groups  the group plan the preview built for the whole file (a date's blocks
--                   are ordered across every chunk) with the user's suffix edits; every chunk of the
--                   commit applies it.

CREATE TABLE IF NOT EXISTS "import_job_group" (
    "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
    "interview_date" DATE         NOT NULL,
    "hundreds_block" INTEGER      NOT NULL,
    "suffix"         CHAR(2)      NOT NULL,
    "job_id"         UUID         NOT NULL,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "import_job_group_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "import_job_group_block_check" CHECK ("hundreds_block" >= 0),
    CONSTRAINT "import_job_group_suffix_check" CHECK ("suffix" ~ '^[0-9]{2}$' AND "suffix" <> '00'),
    CONSTRAINT "import_job_group_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "import_job_group_date_block_key" ON "import_job_group" ("interview_date", "hundreds_block");
CREATE UNIQUE INDEX IF NOT EXISTS "import_job_group_date_suffix_key" ON "import_job_group" ("interview_date", "suffix");
CREATE UNIQUE INDEX IF NOT EXISTS "import_job_group_job_id_key" ON "import_job_group" ("job_id");

ALTER TABLE "candidate_import" ADD COLUMN IF NOT EXISTS "job_groups" JSONB NOT NULL DEFAULT '[]';

COMMENT ON TABLE "import_job_group" IS 'Sheet-upload Jobs: (Interview Date, UNIQUE NUMBER hundreds block) -> Job. Code JOB-YYYY-MMDD + suffix. Stable across re-uploads.';
COMMENT ON COLUMN "candidate_import"."job_groups" IS 'The Job group plan of the preview (with the user''s suffix edits), applied by every commit chunk.';

-- Backend-only table: RLS enabled, no privileges for anon or authenticated API roles.
ALTER TABLE "import_job_group" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "import_job_group" FROM anon, authenticated;
