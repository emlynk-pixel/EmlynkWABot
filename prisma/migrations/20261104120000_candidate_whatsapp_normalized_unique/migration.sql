-- Candidate WhatsApp numbers: uniqueness by the NUMBER, not by how it is written.
-- ADDITIVE ONLY: one function and one index. No row is changed; the existing raw-text index
-- (users_whatsapp_number_key, migration 20261001140000) stays.
--
-- Stored values come in several forms (older rows 94771234567, new writes +94771234567, possibly
-- 0771234567). The raw-text index treats those as different values, so the same number could be
-- held by two candidates. candidate_phone_key() reduces any form to the comparison key the
-- application uses (src/utils/phoneNumber.js phoneKey; the two are tested for parity):
--   digits only; a leading 00 dropped; 0XXXXXXXXX (10 digits) and 7XXXXXXXX (9 digits) -> 94...;
--   8 to 15 digits -> the key; anything else -> NULL (not compared).
-- The already exempted shared number (+94771581916) stays exempt, by its key.
--
-- SAFETY: the index is created only when no two candidates already share a key. Otherwise this
-- migration stops BEFORE changing anything and reports how many groups (counts only, never a
-- number). Resolve them first: scripts/auditCandidatePhones.mjs lists them by candidate, masked.
CREATE FUNCTION "candidate_phone_key"(p_value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE
        WHEN d ~ '^0[0-9]{9}$' THEN '94' || substr(d, 2)
        WHEN d ~ '^7[0-9]{8}$' THEN '94' || d
        WHEN length(d) BETWEEN 8 AND 15 THEN d
        ELSE NULL
    END
    FROM (
        SELECT CASE WHEN digits LIKE '00%' THEN substr(digits, 3) ELSE digits END AS d
        FROM (SELECT regexp_replace(coalesce(p_value, ''), '[^0-9]', '', 'g') AS digits) AS raw
    ) AS normalized
$$;

DO $$
DECLARE
    v_groups INTEGER;
    v_rows INTEGER;
BEGIN
    SELECT count(*), coalesce(sum(n), 0) INTO v_groups, v_rows FROM (
        SELECT count(*) AS n FROM "candidate"
        WHERE "whatsapp_number" IS NOT NULL
          AND "candidate_phone_key"("whatsapp_number") IS NOT NULL
          AND "candidate_phone_key"("whatsapp_number") <> '94771581916'
        GROUP BY "candidate_phone_key"("whatsapp_number")
        HAVING count(*) > 1
    ) AS shared;
    IF v_groups > 0 THEN
        RAISE EXCEPTION 'candidate WhatsApp numbers: % group(s) (% candidates) hold the same number written differently; resolve them before this migration (node scripts/auditCandidatePhones.mjs)', v_groups, v_rows;
    END IF;
END $$;

CREATE UNIQUE INDEX "candidate_whatsapp_number_key_normalized" ON "candidate" ("candidate_phone_key"("whatsapp_number"))
WHERE "whatsapp_number" IS NOT NULL AND "candidate_phone_key"("whatsapp_number") <> '94771581916';
