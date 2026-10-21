-- Job Types become the managed list (Settings > Job Types) behind every job type
-- choice: new Jobs, the admin candidate pickers and the Candidate Form.
-- ADDITIVE ONLY: no table, column or existing row changes.
--
-- Seeds the 17 trade categories the Candidate Form used to hard-code, so the form
-- offers the same trades from the list. Idempotent: a category whose name already
-- exists (in any letter case) or whose code is taken is skipped, so an existing job
-- type is never duplicated, renamed or reactivated. The names keep the form's
-- spelling, so earlier Candidate Form answers (e.g. "JCB OPERATOR") still match.
--
-- Not done here, on purpose: candidates' existing free-text job types are NOT copied
-- into the list (they stay on each candidate and keep displaying), and
-- "No Preferred Type" is NOT a row (a system option stored on the candidate as
-- NO_PREFERENCE; a Job can never reference it).

INSERT INTO "job_type" ("code", "name")
SELECT v."code", v."name"
FROM (VALUES
    ('PLASTER', 'PLASTER'),
    ('BLOCK_MASON', 'BLOCK MASON'),
    ('TILER', 'TILER'),
    ('SHUTTERING_CARPENTER', 'SHUTTERING CARPENTER'),
    ('BARBENDER', 'BARBENDER'),
    ('GYPSUM_WORKER', 'GYPSUM WORKER'),
    ('ALUMINIUM_WORKER', 'ALUMINIUM WORKER'),
    ('WELDER_TIG', 'WELDER TIG'),
    ('WELDER_MIG', 'WELDER MIG'),
    ('WELDER_ARC', 'WELDER ARC'),
    ('PLUMBER', 'PLUMBER'),
    ('ELECTRICIAN', 'ELECTRICIAN'),
    ('JCB_OPERATOR', 'JCB OPERATOR'),
    ('EXCAVATOR_OPERATOR', 'EXCAVATOR OPERATOR'),
    ('MOTOR_GRADER_OPERATOR', 'MOTOR GRADER OPERATOR'),
    ('BOBCAT_OPERATOR', 'BOBCAT OPERATOR'),
    ('WHEEL_LOADER_OPERATOR', 'WHEEL LOADER OPERATOR')
) AS v("code", "name")
WHERE NOT EXISTS (
    SELECT 1 FROM "job_type" t WHERE lower(t."name") = lower(v."name") OR t."code" = v."code"
);
