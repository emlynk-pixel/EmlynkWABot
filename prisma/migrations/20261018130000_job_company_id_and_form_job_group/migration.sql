-- Job identity finalisation + Candidate Form job-group links.
-- ADDITIVE ONLY (no existing row changes). Follows 20261018120000_job_management,
-- which is left untouched: it was never committed or pushed, but could not be
-- verified as unapplied on every environment, so this is a new migration.
--
-- 1. job.company_job_id: the employer's own Job ID (e.g. Y26S01). A plain,
--    editable attribute: NOT a key, referenced by nothing. Identity stays
--    job.id (UUID); job.job_code stays the internal display code.
--    Unique per company when present (NOT global: two employers may use the
--    same identifier). Normalised by the service (trim, upper case); the CHECK
--    refuses control characters and anything outside A-Z 0-9 space . _ / # -.
-- 2. candidate_form_link.job_id -> job.id (immutable UUID) for kind JOB_GROUP.
--    SINGLE: passport_id set, job_id NULL. JOB_GROUP: job_id set, passport_id
--    NULL. At most ONE active (unrevoked) group link per job.

ALTER TABLE "job" ADD COLUMN "company_job_id" TEXT;
ALTER TABLE "job" ADD CONSTRAINT "job_company_job_id_check" CHECK ("company_job_id" IS NULL OR "company_job_id" ~ '^[A-Z0-9][A-Z0-9 ._/#-]{0,39}$');
CREATE UNIQUE INDEX "job_company_job_id_key" ON "job"("company_id", "company_job_id") WHERE "company_job_id" IS NOT NULL;

ALTER TABLE "candidate_form_link" ADD COLUMN "job_id" UUID;
ALTER TABLE "candidate_form_link" ADD CONSTRAINT "candidate_form_link_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "candidate_form_link_job_id_idx" ON "candidate_form_link"("job_id");

ALTER TABLE "candidate_form_link" DROP CONSTRAINT "candidate_form_link_kind_check";
ALTER TABLE "candidate_form_link" DROP CONSTRAINT "candidate_form_link_target_check";
ALTER TABLE "candidate_form_link" ADD CONSTRAINT "candidate_form_link_kind_check" CHECK ("kind" IN ('SINGLE', 'JOB_GROUP'));
-- Exactly one valid target for the kind.
ALTER TABLE "candidate_form_link" ADD CONSTRAINT "candidate_form_link_target_check" CHECK (
    ("kind" = 'SINGLE' AND "passport_id" IS NOT NULL AND "job_id" IS NULL)
    OR ("kind" = 'JOB_GROUP' AND "job_id" IS NOT NULL AND "passport_id" IS NULL)
);
-- One active group link per job (regenerating revokes the previous one first).
CREATE UNIQUE INDEX "candidate_form_link_one_active_group_per_job" ON "candidate_form_link"("job_id") WHERE "kind" = 'JOB_GROUP' AND "revoked_at" IS NULL;

-- candidate_form_link already has RLS enabled and no privileges for anon /
-- authenticated (20261017120000); a new column and constraints change neither.
