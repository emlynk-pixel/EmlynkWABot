-- Candidate lists (Admin > Candidates, Work Allocation): every page is ORDER BY created_date DESC,
-- passport_id ASC with LIMIT / OFFSET, and the advanced filters' Registered date range is a range on
-- created_date. Neither had an index (a sort of the whole table per request). ADDITIVE ONLY: no row
-- or column changes; IF NOT EXISTS so a re-run is harmless.
CREATE INDEX IF NOT EXISTS "candidate_created_date_passport_id_idx" ON "candidate"("created_date" DESC, "passport_id" ASC);
