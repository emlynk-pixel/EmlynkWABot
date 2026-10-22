-- A candidate may now be active on several PROCESSING jobs at the same time.
--
-- NON-DESTRUCTIVE: only the partial unique index that allowed at most ONE active
-- job_candidate row per candidate is dropped. No row, column or constraint holding data
-- changes, so every existing (and historical) assignment stays exactly as it is, and no
-- backfill is needed: the existing rows already are the multiple-assignment model
-- (job_candidate is a join table).
--
-- Still guaranteed by the database:
--   job_candidate_pkey (job_id, passport_id)   one membership row per candidate AND job, so the
--                                               same candidate can never be on the same job twice;
--   job_candidate_released_check                a removed membership is not active;
--   job_candidate_active_requires_processing   a membership is active only on a PROCESSING job;
--   job_status_transition                       completing / cancelling a job releases only THAT
--                                               job's memberships (the candidate's other jobs stay).
-- The existing index job_candidate_passport_id_idx keeps "a candidate's jobs" lookups indexed.

DROP INDEX IF EXISTS "job_candidate_one_active_per_candidate";
