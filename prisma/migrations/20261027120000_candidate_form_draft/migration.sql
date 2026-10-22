-- Saved progress of the Candidate Form (draft), one row per candidate.
-- ADDITIVE ONLY: one new table. Nothing existing changes: candidate_form_access (the lock),
-- candidate_form_response (the final answers) and the prefill snapshot are never touched by a
-- draft, so a draft can never count as a submission.
--
-- `answers` is a JSON object keyed by the form's groups (basic, contact, passport, qualifications,
-- measurements, family, guardian), each holding the validated answers of a step the candidate
-- passed with Next. A save merges its step's groups into the row (jsonb ||), so saving one step
-- never overwrites another, a repeated save changes nothing, and there is never a second row.
-- The final submission deletes the row in its own transaction. The candidate's own NIC and
-- passport number are never part of the answers.

CREATE TABLE "candidate_form_draft" (
    "passport_id" TEXT NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_form_draft_pkey" PRIMARY KEY ("passport_id"),
    CONSTRAINT "candidate_form_draft_answers_check" CHECK (jsonb_typeof("answers") = 'object')
);

ALTER TABLE "candidate_form_draft" ADD CONSTRAINT "candidate_form_draft_passport_id_fkey" FOREIGN KEY ("passport_id") REFERENCES "candidate"("passport_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backend-only table: RLS on, no API-role privileges, no policies.
ALTER TABLE "candidate_form_draft" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "candidate_form_draft" FROM anon, authenticated;
