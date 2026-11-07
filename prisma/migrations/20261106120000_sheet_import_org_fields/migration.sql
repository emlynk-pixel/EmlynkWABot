-- Bulk candidate import (Settings > Google Sheet Sync > Upload): COMPANY / COMPANY NUMBER / AGENT.
-- ADDITIVE ONLY. No row is changed, no column is dropped or renamed.
--
-- 1. client.registration_number: the Client's company registration number (the legacy sheet's
--    COMPANY NUMBER). Optional; existing Clients keep NULL.
-- 2. agent.country_code becomes optional: the legacy sheet names Agents without a country, and the
--    import creates them with NULL ("Not set" in Admin > Agents, where an admin sets it). Existing
--    Agents all keep their country. The CHECK (^[A-Z]{2}$) still holds for every non-NULL value
--    (a NULL passes it). A Job still needs a country: creating one with a country-less responsible
--    Agent is refused by the application (jobService.js, AGENT_COUNTRY_MISSING).
-- 3. agent_name_country_lower_key (lower(name), country_code) does not stop two country-less Agents
--    with the same name (NULLs are distinct): a partial unique index does.
-- 4. candidate.departed_at: when the candidate was recorded as Departed (the legacy sheet's VISA STATUS
--    "Departed"). Its own fact, NOT the Finalizing job stage (completing that stage keeps meaning what it
--    meant). Existing candidates keep NULL. Not one of the columns the verification-reset trigger
--    watches (migration 20261022120000), so setting it never clears a verification.
ALTER TABLE "client" ADD COLUMN IF NOT EXISTS "registration_number" TEXT;

ALTER TABLE "agent" ALTER COLUMN "country_code" DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "agent_name_no_country_lower_key" ON "agent"(lower("name")) WHERE "country_code" IS NULL;

ALTER TABLE "candidate" ADD COLUMN IF NOT EXISTS "departed_at" TIMESTAMP(3);
