-- Candidate Status cleanup.
--
-- 1. REMOVES the retired deployment stages IVS_INTERVIEW and FINALIZING_JOB (hidden from the candidate
--    page since the stepper change, no longer in the application), and any other stage value the
--    application does not know, from candidate_stages. DESTRUCTIVE: those rows (their completion and
--    notes) are deleted. Who completed them stays in audit_logs (UPDATE_STAGE entries are never
--    deleted). Run `node scripts/auditCandidateStages.js` BEFORE deploying to see what will go.
--    The sheet-sync capture trigger queues the affected candidates, so the Google Sheet mirror is
--    refreshed (its IVS / Finalizing columns are no longer written; delete them from the Sheet).
-- 2. GUARDS candidate_stages.stage: only the six stages the application uses (CHECK).
-- 3. ADDS candidate.outcome / outcome_at: a recorded final outcome (Visa Not Going, Cancelled,
--    Rejected), from the bulk import's VISA STATUS or an Admin on the candidate page. Additive and
--    nullable; no backfill. A candidate is never both departed and given an outcome (CHECK).
--
-- Safe to run twice.

-- 1. Retired and unknown stages.
DELETE FROM "candidate_stages"
WHERE "stage" NOT IN ('TEST_DETAILS', 'JOB_DETAILS', 'CANDIDATE_DETAILS', 'DOCUMENT_SUBMISSION', 'VISA_SUBMISSION', 'VISA_APPROVAL');

-- 2. Only known stages from now on.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'candidate_stages_stage_check') THEN
        ALTER TABLE "candidate_stages" ADD CONSTRAINT "candidate_stages_stage_check"
            CHECK ("stage" IN ('TEST_DETAILS', 'JOB_DETAILS', 'CANDIDATE_DETAILS', 'DOCUMENT_SUBMISSION', 'VISA_SUBMISSION', 'VISA_APPROVAL'));
    END IF;
END $$;

-- 3. Final outcome.
ALTER TABLE "candidate" ADD COLUMN IF NOT EXISTS "outcome" TEXT;
ALTER TABLE "candidate" ADD COLUMN IF NOT EXISTS "outcome_at" TIMESTAMP(3);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'candidate_outcome_check') THEN
        ALTER TABLE "candidate" ADD CONSTRAINT "candidate_outcome_check"
            CHECK ("outcome" IS NULL OR "outcome" IN ('VISA_NOT_GOING', 'CANCELLED', 'REJECTED'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'candidate_outcome_at_check') THEN
        ALTER TABLE "candidate" ADD CONSTRAINT "candidate_outcome_at_check"
            CHECK (("outcome" IS NULL) = ("outcome_at" IS NULL));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'candidate_departed_or_outcome_check') THEN
        ALTER TABLE "candidate" ADD CONSTRAINT "candidate_departed_or_outcome_check"
            CHECK ("departed_at" IS NULL OR "outcome" IS NULL);
    END IF;
END $$;

COMMENT ON COLUMN "candidate"."outcome" IS 'Final outcome: VISA_NOT_GOING, CANCELLED or REJECTED (bulk import VISA STATUS or an Admin). NULL when none. Never set together with departed_at.';
COMMENT ON COLUMN "candidate"."outcome_at" IS 'When the outcome was recorded. NULL exactly when outcome is NULL.';
