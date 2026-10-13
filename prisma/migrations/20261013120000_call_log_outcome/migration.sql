-- Call log outcome: a call can be recorded as NO_ANSWER (the candidate did
-- not pick up), with no note.
-- Additive only: one new column on candidate_call_logs. No row is changed:
-- every existing call log takes the default, ANSWERED, which is what it was.
--   call_outcome  ANSWERED | NO_ANSWER
-- note stays NOT NULL (nothing that reads it has to handle null); a NO_ANSWER
-- call stores an empty string. A call that was answered still needs a note,
-- now enforced by the database as well as by the API.

ALTER TABLE "candidate_call_logs" ADD COLUMN "call_outcome" TEXT NOT NULL DEFAULT 'ANSWERED';

ALTER TABLE "candidate_call_logs" ADD CONSTRAINT "candidate_call_logs_call_outcome_check" CHECK ("call_outcome" IN ('ANSWERED', 'NO_ANSWER'));

ALTER TABLE "candidate_call_logs" ADD CONSTRAINT "candidate_call_logs_note_required_check" CHECK ("call_outcome" = 'NO_ANSWER' OR btrim("note") <> '');
