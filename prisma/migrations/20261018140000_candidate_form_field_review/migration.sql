-- Per-field review of candidate-submitted Candidate Form values.
-- ADDITIVE ONLY: one new table. Nothing existing changes (candidate_form_response is
-- never touched: what the candidate submitted stays separate from how staff reviewed it).
--
-- A candidate submits at most once, so one review per (candidate, field) is one review per
-- submission. PENDING is the ABSENCE of a row; a decision is CONFIRMED (the value was applied
-- to the canonical record, by the Confirm action) or REJECTED (the proposal was dismissed and
-- the record left as it was). The primary key makes "both confirmed and rejected" impossible,
-- and a trigger makes a decision final.

CREATE TABLE "candidate_form_field_review" (
    "passport_id" TEXT NOT NULL,
    "field_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    -- What the candidate submitted, and the canonical value at the time of the decision (audit context).
    "submitted_value" TEXT,
    "current_value" TEXT,
    "reviewed_by" TEXT NOT NULL,
    "reviewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_form_field_review_pkey" PRIMARY KEY ("passport_id", "field_key"),
    CONSTRAINT "candidate_form_field_review_status_check" CHECK ("status" IN ('CONFIRMED', 'REJECTED')),
    CONSTRAINT "candidate_form_field_review_field_key_check" CHECK ("field_key" ~ '^[A-Za-z]+(\.[A-Za-z0-9]+){1,2}$')
);

CREATE INDEX "candidate_form_field_review_reviewed_by_idx" ON "candidate_form_field_review"("reviewed_by");

ALTER TABLE "candidate_form_field_review" ADD CONSTRAINT "candidate_form_field_review_passport_id_fkey" FOREIGN KEY ("passport_id") REFERENCES "candidate"("passport_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "candidate_form_field_review" ADD CONSTRAINT "candidate_form_field_review_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "user"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A decision is final: it cannot be changed or reversed (only a passport ID correction may cascade).
CREATE FUNCTION "candidate_form_field_review_is_final"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW."status", NEW."field_key", NEW."submitted_value", NEW."current_value", NEW."reviewed_by", NEW."reviewed_at")
        IS DISTINCT FROM (OLD."status", OLD."field_key", OLD."submitted_value", OLD."current_value", OLD."reviewed_by", OLD."reviewed_at") THEN
        RAISE EXCEPTION 'candidate_form_field_review: a review decision cannot be changed';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "candidate_form_field_review_is_final_trg" BEFORE UPDATE ON "candidate_form_field_review"
    FOR EACH ROW EXECUTE FUNCTION "candidate_form_field_review_is_final"();

-- Backend-only table: RLS on, no API-role privileges, no policies.
ALTER TABLE "candidate_form_field_review" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "candidate_form_field_review" FROM anon, authenticated;
