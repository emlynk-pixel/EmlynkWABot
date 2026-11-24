-- English Knowledge on the ENGLISH 6..10 scale (src/services/englishKnowledgeLevels.js).
-- DDL only: the check of candidate_additional_details.english_knowledge is replaced by one
-- that also allows ENGLISH 6..10. The older six levels stay allowed, so every stored row
-- still passes and nothing is rewritten or backfilled (older levels are translated when
-- read). NULL still passes. The Candidate Form's own tables (candidate_form_response,
-- candidate_form_prefill_snapshot) keep the older six: the form still answers with them.
ALTER TABLE "candidate_additional_details"
    DROP CONSTRAINT "candidate_additional_details_english_knowledge_check",
    ADD CONSTRAINT "candidate_additional_details_english_knowledge_check" CHECK ("english_knowledge" IN (
        'ENGLISH 6', 'ENGLISH 7', 'ENGLISH 8', 'ENGLISH 9', 'ENGLISH 10',
        'NO KNOWLEDGE', 'BASIC', 'FAIR', 'GOOD', 'VERY GOOD', 'FLUENT'
    ));
