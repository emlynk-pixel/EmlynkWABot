-- Candidate Form share links, the single-submission lock, and the
-- candidate's submitted answers (Docs/CANDIDATE_EXTRA_DETAILS_FORM_SHARE_LINKS_DESIGN.md).
-- Additive only: four new tables, their keys, checks, triggers and indexes.
-- No existing table, column or row is changed. Every candidate starts LOCKED
-- (no candidate_form_access row).
--
--   candidate_form_link              a share link for ONE candidate (kind
--                                    SINGLE; a job-group kind can be added
--                                    later). Only a SHA-256 hash of the link
--                                    secret is stored, never the secret.
--   candidate_form_access            the lock: LOCKED -> UNLOCKED (a link was
--                                    created) -> SUBMITTED (terminal).
--   candidate_form_response          the answers the candidate submitted, every
--                                    field nullable. Written once; never
--                                    updated.
--   candidate_form_prefill_snapshot  what the form was prefilled with, from
--                                    the existing records, taken once at the
--                                    candidate's first verified visit; never
--                                    updated. Kept for comparison.
--
-- The public form NEVER writes candidate, candidate_additional_details or
-- candidate_stages: submitted answers stay in these tables.

-- CreateTable
CREATE TABLE "candidate_form_link" (
    "link_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'SINGLE',
    "passport_id" TEXT,
    "token_hash" CHAR(64) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_verified_at" TIMESTAMP(3),

    CONSTRAINT "candidate_form_link_pkey" PRIMARY KEY ("link_id"),
    CONSTRAINT "candidate_form_link_kind_check" CHECK ("kind" IN ('SINGLE')),
    -- A SINGLE link names exactly one candidate.
    CONSTRAINT "candidate_form_link_target_check" CHECK ("kind" <> 'SINGLE' OR "passport_id" IS NOT NULL),
    CONSTRAINT "candidate_form_link_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "candidate_form_link_failed_attempts_check" CHECK ("failed_attempts" >= 0),
    CONSTRAINT "candidate_form_link_revoked_check" CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL))
);

-- CreateTable
CREATE TABLE "candidate_form_access" (
    "passport_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'LOCKED',
    "version" INTEGER NOT NULL DEFAULT 0,
    "unlocked_at" TIMESTAMP(3),
    "unlocked_by" TEXT,
    "unlocked_via_link_id" TEXT,
    "submitted_at" TIMESTAMP(3),
    "submitted_via_link_id" TEXT,
    -- The Idempotency-Key of the winning submit: a safe retry of the same
    -- request gets the same success; any other submit gets 409.
    "submit_key" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_form_access_pkey" PRIMARY KEY ("passport_id"),
    CONSTRAINT "candidate_form_access_status_check" CHECK ("status" IN ('LOCKED', 'UNLOCKED', 'SUBMITTED')),
    CONSTRAINT "candidate_form_access_submitted_check" CHECK (("status" = 'SUBMITTED') = ("submitted_at" IS NOT NULL)),
    CONSTRAINT "candidate_form_access_version_check" CHECK ("version" >= 0)
);

-- CreateTable
CREATE TABLE "candidate_form_response" (
    "passport_id" TEXT NOT NULL,
    "full_name" TEXT,
    "surname" TEXT,
    "other_names" TEXT,
    "nic" TEXT,
    "sex" TEXT,
    "civil_status" TEXT,
    "birth_date" DATE,
    "birth_place" TEXT,
    "address" TEXT,
    "city" TEXT,
    "district" TEXT,
    "ds_division" TEXT,
    "gn_division" TEXT,
    "alternative_phone" TEXT,
    "email" TEXT,
    "passport_issue_date" DATE,
    "passport_expiry_date" DATE,
    "job_category" TEXT,
    "job_category_other" TEXT,
    "experience" TEXT,
    "other_skills_1" TEXT,
    "other_skills_2" TEXT,
    "english_knowledge" TEXT,
    "shirt_size" TEXT,
    "waist_size" TEXT,
    "shoe_size" TEXT,
    "father_name" TEXT,
    "father_surname" TEXT,
    "father_passport_number" TEXT,
    "father_birth_date" DATE,
    "mother_name" TEXT,
    "mother_surname" TEXT,
    "mother_passport_number" TEXT,
    "mother_birth_date" DATE,
    "spouse_name" TEXT,
    "spouse_surname" TEXT,
    "spouse_passport_number" TEXT,
    "spouse_birth_date" DATE,
    "child_1_name" TEXT,
    "child_2_name" TEXT,
    "child_3_name" TEXT,
    "guardian_name" TEXT,
    "guardian_relationship" TEXT,
    "guardian_nic" TEXT,
    "guardian_birth_date" DATE,
    "guardian_phone" TEXT,
    "guardian_address" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_via_link_id" TEXT,

    CONSTRAINT "candidate_form_response_pkey" PRIMARY KEY ("passport_id"),
    CONSTRAINT "candidate_form_response_sex_check" CHECK ("sex" IS NULL OR "sex" IN ('MALE', 'FEMALE', 'OTHER')),
    CONSTRAINT "candidate_form_response_civil_status_check" CHECK ("civil_status" IS NULL OR "civil_status" IN ('SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED')),
    CONSTRAINT "candidate_form_response_english_knowledge_check" CHECK ("english_knowledge" IS NULL OR "english_knowledge" IN ('NO KNOWLEDGE', 'BASIC', 'FAIR', 'GOOD', 'VERY GOOD', 'FLUENT')),
    CONSTRAINT "candidate_form_response_shirt_size_check" CHECK ("shirt_size" IS NULL OR "shirt_size" IN ('XS', 'S', 'M', 'L', 'XL', 'XXL'))
);

-- CreateTable
CREATE TABLE "candidate_form_prefill_snapshot" (
    "passport_id" TEXT NOT NULL,
    "full_name" TEXT,
    "surname" TEXT,
    "other_names" TEXT,
    "nic" TEXT,
    "sex" TEXT,
    "civil_status" TEXT,
    "birth_date" DATE,
    "birth_place" TEXT,
    "address" TEXT,
    "city" TEXT,
    "district" TEXT,
    "ds_division" TEXT,
    "gn_division" TEXT,
    "alternative_phone" TEXT,
    "email" TEXT,
    "passport_issue_date" DATE,
    "passport_expiry_date" DATE,
    "job_category" TEXT,
    "job_category_other" TEXT,
    "experience" TEXT,
    "other_skills_1" TEXT,
    "other_skills_2" TEXT,
    "english_knowledge" TEXT,
    "shirt_size" TEXT,
    "waist_size" TEXT,
    "shoe_size" TEXT,
    "father_name" TEXT,
    "father_surname" TEXT,
    "father_passport_number" TEXT,
    "father_birth_date" DATE,
    "mother_name" TEXT,
    "mother_surname" TEXT,
    "mother_passport_number" TEXT,
    "mother_birth_date" DATE,
    "spouse_name" TEXT,
    "spouse_surname" TEXT,
    "spouse_passport_number" TEXT,
    "spouse_birth_date" DATE,
    "child_1_name" TEXT,
    "child_2_name" TEXT,
    "child_3_name" TEXT,
    "guardian_name" TEXT,
    "guardian_relationship" TEXT,
    "guardian_nic" TEXT,
    "guardian_birth_date" DATE,
    "guardian_phone" TEXT,
    "guardian_address" TEXT,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "captured_via_link_id" TEXT,

    CONSTRAINT "candidate_form_prefill_snapshot_pkey" PRIMARY KEY ("passport_id"),
    CONSTRAINT "candidate_form_prefill_snapshot_sex_check" CHECK ("sex" IS NULL OR "sex" IN ('MALE', 'FEMALE', 'OTHER')),
    CONSTRAINT "candidate_form_prefill_snapshot_civil_status_check" CHECK ("civil_status" IS NULL OR "civil_status" IN ('SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED')),
    CONSTRAINT "candidate_form_prefill_snapshot_english_knowledge_check" CHECK ("english_knowledge" IS NULL OR "english_knowledge" IN ('NO KNOWLEDGE', 'BASIC', 'FAIR', 'GOOD', 'VERY GOOD', 'FLUENT')),
    CONSTRAINT "candidate_form_prefill_snapshot_shirt_size_check" CHECK ("shirt_size" IS NULL OR "shirt_size" IN ('XS', 'S', 'M', 'L', 'XL', 'XXL'))
);

-- CreateIndex
CREATE UNIQUE INDEX "candidate_form_link_token_hash_key" ON "candidate_form_link"("token_hash");
CREATE INDEX "candidate_form_link_passport_id_idx" ON "candidate_form_link"("passport_id");
CREATE INDEX "candidate_form_link_created_by_idx" ON "candidate_form_link"("created_by");
CREATE INDEX "candidate_form_access_unlocked_via_link_id_idx" ON "candidate_form_access"("unlocked_via_link_id");
CREATE INDEX "candidate_form_access_submitted_via_link_id_idx" ON "candidate_form_access"("submitted_via_link_id");
CREATE INDEX "candidate_form_response_submitted_via_link_id_idx" ON "candidate_form_response"("submitted_via_link_id");
CREATE INDEX "candidate_form_prefill_snapshot_captured_via_link_id_idx" ON "candidate_form_prefill_snapshot"("captured_via_link_id");

-- AddForeignKey: the candidate (a passport ID correction follows; deleting
-- the candidate removes its form rows).
ALTER TABLE "candidate_form_link" ADD CONSTRAINT "candidate_form_link_passport_id_fkey" FOREIGN KEY ("passport_id") REFERENCES "candidate"("passport_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "candidate_form_access" ADD CONSTRAINT "candidate_form_access_passport_id_fkey" FOREIGN KEY ("passport_id") REFERENCES "candidate"("passport_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "candidate_form_response" ADD CONSTRAINT "candidate_form_response_passport_id_fkey" FOREIGN KEY ("passport_id") REFERENCES "candidate"("passport_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "candidate_form_prefill_snapshot" ADD CONSTRAINT "candidate_form_prefill_snapshot_passport_id_fkey" FOREIGN KEY ("passport_id") REFERENCES "candidate"("passport_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: staff (deactivated, never deleted).
ALTER TABLE "candidate_form_link" ADD CONSTRAINT "candidate_form_link_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "candidate_form_link" ADD CONSTRAINT "candidate_form_link_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "user"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "candidate_form_access" ADD CONSTRAINT "candidate_form_access_unlocked_by_fkey" FOREIGN KEY ("unlocked_by") REFERENCES "user"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: the link that unlocked / was used (kept if the link row goes).
ALTER TABLE "candidate_form_access" ADD CONSTRAINT "candidate_form_access_unlocked_via_link_id_fkey" FOREIGN KEY ("unlocked_via_link_id") REFERENCES "candidate_form_link"("link_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "candidate_form_access" ADD CONSTRAINT "candidate_form_access_submitted_via_link_id_fkey" FOREIGN KEY ("submitted_via_link_id") REFERENCES "candidate_form_link"("link_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "candidate_form_response" ADD CONSTRAINT "candidate_form_response_submitted_via_link_id_fkey" FOREIGN KEY ("submitted_via_link_id") REFERENCES "candidate_form_link"("link_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "candidate_form_prefill_snapshot" ADD CONSTRAINT "candidate_form_prefill_snapshot_captured_via_link_id_fkey" FOREIGN KEY ("captured_via_link_id") REFERENCES "candidate_form_link"("link_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- SUBMITTED is terminal: once a candidate has submitted, the lock row can
-- no longer change (only a passport ID correction may cascade through it).
CREATE FUNCTION "candidate_form_access_submitted_is_final"() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."status" = 'SUBMITTED' AND (
        NEW."status", NEW."version", NEW."submitted_at", NEW."submitted_via_link_id", NEW."submit_key",
        NEW."unlocked_at", NEW."unlocked_by", NEW."unlocked_via_link_id"
    ) IS DISTINCT FROM (
        OLD."status", OLD."version", OLD."submitted_at", OLD."submitted_via_link_id", OLD."submit_key",
        OLD."unlocked_at", OLD."unlocked_by", OLD."unlocked_via_link_id"
    ) THEN
        RAISE EXCEPTION 'candidate_form_access: a submitted form cannot be changed';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "candidate_form_access_submitted_is_final"
    BEFORE UPDATE ON "candidate_form_access"
    FOR EACH ROW EXECUTE FUNCTION "candidate_form_access_submitted_is_final"();

-- The answers and the snapshot are written once and never edited (only a
-- passport ID correction or a link removal may cascade through them).
CREATE FUNCTION "candidate_form_values_are_final"() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    IF (to_jsonb(NEW) - 'passport_id' - 'submitted_via_link_id' - 'captured_via_link_id')
        IS DISTINCT FROM (to_jsonb(OLD) - 'passport_id' - 'submitted_via_link_id' - 'captured_via_link_id') THEN
        RAISE EXCEPTION '%: stored candidate form values cannot be changed', TG_TABLE_NAME;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "candidate_form_response_is_final"
    BEFORE UPDATE ON "candidate_form_response"
    FOR EACH ROW EXECUTE FUNCTION "candidate_form_values_are_final"();

CREATE TRIGGER "candidate_form_prefill_snapshot_is_final"
    BEFORE UPDATE ON "candidate_form_prefill_snapshot"
    FOR EACH ROW EXECUTE FUNCTION "candidate_form_values_are_final"();

-- SEC-001 / ISS-012: not readable or writable by Supabase's public API roles
-- (the backend connects as the table owner, which bypasses RLS).
ALTER TABLE "candidate_form_link" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "candidate_form_link" FROM anon, authenticated;
ALTER TABLE "candidate_form_access" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "candidate_form_access" FROM anon, authenticated;
ALTER TABLE "candidate_form_response" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "candidate_form_response" FROM anon, authenticated;
ALTER TABLE "candidate_form_prefill_snapshot" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "candidate_form_prefill_snapshot" FROM anon, authenticated;
