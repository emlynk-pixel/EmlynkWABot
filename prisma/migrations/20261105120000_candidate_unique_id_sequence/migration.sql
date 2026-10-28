-- Candidate unique ID allocation (candidateService.js createCandidate): a PostgreSQL sequence.
--
-- Before, a registration read EVERY candidate's unique_id, took the highest numeric one in the
-- application and added 1. Concurrent registrations read the same highest value, all but one lost
-- on candidate_unique_id_key (P2002), retried with a fresh full scan, and after 5 attempts answered
-- 503 TRY_AGAIN (REG-02: 9 of 50 at 5 concurrent users, 88 rolled-back transactions).
-- nextval() is atomic, so concurrent registrations can never draw the same number.
--
-- ADDITIVE ONLY: one new sequence. No candidate row is read for anything but its highest numeric
-- unique_id, and nothing is updated, deleted or rewritten. The outward format is unchanged (the
-- application zero-pads to 4 digits, as before). Non-numeric legacy IDs (e.g. LT00001) are ignored,
-- exactly as before, and stay valid. A number drawn by a registration that then fails is not reused
-- (a gap); the IDs are identifiers, never counted.

-- CreateSequence
CREATE SEQUENCE "candidate_unique_id_seq" AS BIGINT MINVALUE 1 START WITH 1;

-- The next value is the highest numeric unique_id + 1 (1 when there is none), as the old allocator
-- would have chosen. 18 digits always fit in BIGINT.
SELECT setval(
    '"candidate_unique_id_seq"',
    COALESCE((SELECT max("unique_id"::BIGINT) FROM "candidate" WHERE "unique_id" ~ '^[0-9]{1,18}$'), 0) + 1,
    false
);

-- SEC-001: not usable by Supabase's public API roles (the backend connects as the owner).
REVOKE ALL PRIVILEGES ON SEQUENCE "candidate_unique_id_seq" FROM anon, authenticated;
