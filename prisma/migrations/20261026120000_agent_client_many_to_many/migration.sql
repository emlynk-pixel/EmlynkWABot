-- Agent <-> Client becomes MANY-TO-MANY (Admin > Agents, Admin > Client Management).
-- One Agent works with many Clients, and one Client works with many Agents.
-- Docs/AGENT_CLIENT_MANAGEMENT.md.
--
-- ADDITIVE, STAGED: a new join table "agent_client", backfilled from the current
-- one-to-many link (client.agent_id). Nothing is dropped, renamed or rewritten:
--   * client.agent_id, its FK and its index STAY (deprecated): the application no
--     longer reads or writes it after this release. It keeps the pre-migration
--     value as a record and lets the previous release keep running during a
--     rollout. Dropping it is a later, separate migration.
--   * job.client_id / job.responsible_agent_id / job.country_code are untouched:
--     a Job still belongs to ONE Client and keeps the Agent and the To Country it
--     was created with.
--
-- Backfill: exactly one row per client that has an agent_id today. Agents a client
-- had in the past (former agents still recorded on its old jobs) are NOT added:
-- they are not current associations, and adding them would invent links.
-- Verified below: the migration aborts if any current link is missing.
-- Safe to run twice (IF NOT EXISTS / ON CONFLICT DO NOTHING / guarded constraints).

CREATE TABLE IF NOT EXISTS "agent_client" (
    "agent_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- UNIQUE(agent_id, client_id): one row per pair.
    CONSTRAINT "agent_client_pkey" PRIMARY KEY ("agent_id", "client_id")
);

-- RESTRICT: removing a LINK deletes only the agent_client row; an Agent or a Client
-- (never hard-deleted in this system) cannot be deleted while a link refers to it.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_client_agent_id_fkey') THEN
        ALTER TABLE "agent_client" ADD CONSTRAINT "agent_client_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_client_client_id_fkey') THEN
        ALTER TABLE "agent_client" ADD CONSTRAINT "agent_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

-- The primary key serves agent -> clients; this index serves client -> agents.
CREATE INDEX IF NOT EXISTS "agent_client_client_id_idx" ON "agent_client"("client_id");

-- Backfill every current association.
INSERT INTO "agent_client" ("agent_id", "client_id")
SELECT c."agent_id", c."id" FROM "client" c WHERE c."agent_id" IS NOT NULL
ON CONFLICT ("agent_id", "client_id") DO NOTHING;

-- Verify: every current client.agent_id has its agent_client row.
DO $$
DECLARE missing INTEGER;
BEGIN
    SELECT count(*) INTO missing FROM "client" c
    WHERE c."agent_id" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "agent_client" ac WHERE ac."client_id" = c."id" AND ac."agent_id" = c."agent_id");
    IF missing > 0 THEN
        RAISE EXCEPTION 'agent_client backfill incomplete: % client(s) without their agent link', missing;
    END IF;
END $$;

COMMENT ON TABLE "agent_client" IS 'Agent <-> Client associations (many-to-many). Replaces client.agent_id, which is deprecated and no longer read or written by the application.';
COMMENT ON COLUMN "client"."agent_id" IS 'DEPRECATED (20261026120000_agent_client_many_to_many): the Client''s agent before agent_client existed. Not read or written by the application; agent_client is the source. To be dropped in a later migration.';

-- Backend-only table, like the other Job Management tables: RLS on, no API-role privileges.
ALTER TABLE "agent_client" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "agent_client" FROM anon, authenticated;
