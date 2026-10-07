-- Google Sheet operational mirror, Phase 3: durable outbox, run requests and
-- integration state (Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md,
-- Sections 8 and 9).
--
-- Additive only: three new tables, their indexes and access restrictions,
-- one seed row, and change-capture triggers on users, candidate_stages and
-- documents. No existing table, column, constraint or row is changed or
-- removed.
--
-- The triggers only INSERT/UPDATE rows of sheet_sync_queue, in the same
-- transaction as the candidate change. They never call Google (nothing in the
-- database can), so a Google outage can't fail or roll back a candidate
-- write. Rollback (stops capture, keeps candidate data untouched):
--   DROP TRIGGER "users_sheet_sync_capture" ON "users";
--   DROP TRIGGER "candidate_stages_sheet_sync_capture" ON "candidate_stages";
--   DROP TRIGGER "documents_sheet_sync_capture" ON "documents";

-- CreateTable
CREATE TABLE "sheet_sync_queue" (
    "queue_id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "unique_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "candidate_deleted" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMPTZ(3),
    "last_result" TEXT,
    "last_error_class" TEXT,
    "last_error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "sheet_sync_queue_pkey" PRIMARY KEY ("queue_id"),
    CONSTRAINT "sheet_sync_queue_status_check" CHECK ("status" IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'))
);

-- CreateTable
CREATE TABLE "sheet_sync_runs" (
    "run_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "trigger_source" TEXT NOT NULL,
    "requested_by" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "dry_run" BOOLEAN,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMPTZ(3),
    "summary" JSONB,
    "error_class" TEXT,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sheet_sync_runs_pkey" PRIMARY KEY ("run_id"),
    CONSTRAINT "sheet_sync_runs_kind_check" CHECK ("kind" IN ('RECONCILE', 'TEST_CONNECTION')),
    CONSTRAINT "sheet_sync_runs_status_check" CHECK ("status" IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED'))
);

-- CreateTable
CREATE TABLE "sheet_sync_state" (
    "state_id" TEXT NOT NULL,
    "integration_state" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "last_error_class" TEXT,
    "last_error_code" TEXT,
    "last_error_at" TIMESTAMPTZ(3),
    "last_sync_success_at" TIMESTAMPTZ(3),
    "write_gate" TEXT,
    "configured" BOOLEAN,
    "target_hint" TEXT,
    "worker_heartbeat_at" TIMESTAMPTZ(3),
    "writer_lease_owner" TEXT,
    "writer_lease_expires_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sheet_sync_state_pkey" PRIMARY KEY ("state_id")
);

-- CreateIndex
CREATE INDEX "sheet_sync_queue_status_next_attempt_at_idx" ON "sheet_sync_queue"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "sheet_sync_queue_unique_id_idx" ON "sheet_sync_queue"("unique_id");

-- CreateIndex
CREATE INDEX "sheet_sync_runs_kind_created_at_idx" ON "sheet_sync_runs"("kind", "created_at");

-- CreateIndex
CREATE INDEX "sheet_sync_runs_status_idx" ON "sheet_sync_runs"("status");

-- Coalescing: at most ONE pending row per candidate. Rapid changes refresh
-- that row instead of adding more, so the queue stays bounded by the number
-- of candidates however long Google is unavailable. A change made while a
-- row is PROCESSING finds no PENDING row and adds one, so the candidate is
-- synchronized again after that change (eventual latest state).
-- (A WHERE-conditioned unique index can't be expressed in schema.prisma.)
CREATE UNIQUE INDEX "sheet_sync_queue_pending_unique_id_key" ON "sheet_sync_queue"("unique_id") WHERE "status" = 'PENDING';

-- At most one QUEUED/RUNNING run per kind: repeated "Sync Now" requests and
-- scheduler calls return the active run instead of piling up.
CREATE UNIQUE INDEX "sheet_sync_runs_active_kind_key" ON "sheet_sync_runs"("kind") WHERE "status" IN ('QUEUED', 'RUNNING');

-- SEC-001: not readable or writable by Supabase's public API roles (the
-- backend connects as the table owner, which bypasses RLS).
ALTER TABLE "sheet_sync_queue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sheet_sync_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sheet_sync_state" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "sheet_sync_queue" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE "sheet_sync_runs" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE "sheet_sync_state" FROM anon, authenticated;

-- The single state row the worker and the Admin API read and update.
INSERT INTO "sheet_sync_state" ("state_id") VALUES ('sheet-sync');

-- ---------------------------------------------------------------- change capture

-- Records "candidate <unique_id> needs synchronization", coalescing into the
-- candidate's PENDING row if there is one. The pending row keeps its retry
-- schedule (a burst of changes must not bypass the backoff while Google is
-- failing). candidate_deleted is sticky (OR): a later child-row event in the
-- same cascade can't clear a deletion; the worker only uses it when the
-- candidate really is absent from the database.
CREATE FUNCTION "sheet_sync_enqueue"(p_unique_id TEXT, p_candidate_deleted BOOLEAN) RETURNS void
    LANGUAGE sql
    SET search_path FROM CURRENT
AS $$
    INSERT INTO "sheet_sync_queue" ("unique_id", "candidate_deleted")
    VALUES (p_unique_id, p_candidate_deleted)
    ON CONFLICT ("unique_id") WHERE "status" = 'PENDING'
    DO UPDATE SET
        "candidate_deleted" = "sheet_sync_queue"."candidate_deleted" OR EXCLUDED."candidate_deleted",
        "updated_at" = CURRENT_TIMESTAMP;
$$;

-- users: the candidate itself. A deleted row (or a changed unique_id, which
-- the application never does) marks the old identity as deleted.
CREATE FUNCTION "sheet_sync_capture_users"() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path FROM CURRENT
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM "sheet_sync_enqueue"(OLD."unique_id", true);
        RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD."unique_id" IS DISTINCT FROM NEW."unique_id" THEN
        PERFORM "sheet_sync_enqueue"(OLD."unique_id", true);
    END IF;
    PERFORM "sheet_sync_enqueue"(NEW."unique_id", false);
    RETURN NULL;
END;
$$;

-- candidate_stages and documents: rows that belong to a candidate through
-- passport_id. The candidate's unique_id is looked up for the old and the new
-- row; a row whose candidate no longer exists (e.g. cascaded from a users
-- delete, already captured above) adds nothing. Every document change is
-- captured; the worker compares the mapped row and writes only differences.
CREATE FUNCTION "sheet_sync_capture_candidate_child"() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path FROM CURRENT
AS $$
DECLARE
    old_unique_id TEXT;
    new_unique_id TEXT;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        SELECT "unique_id" INTO old_unique_id FROM "users" WHERE "passport_id" = OLD."passport_id";
        IF old_unique_id IS NOT NULL THEN
            PERFORM "sheet_sync_enqueue"(old_unique_id, false);
        END IF;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        SELECT "unique_id" INTO new_unique_id FROM "users" WHERE "passport_id" = NEW."passport_id";
        IF new_unique_id IS NOT NULL AND new_unique_id IS DISTINCT FROM old_unique_id THEN
            PERFORM "sheet_sync_enqueue"(new_unique_id, false);
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "users_sheet_sync_capture"
    AFTER INSERT OR UPDATE OR DELETE ON "users"
    FOR EACH ROW EXECUTE FUNCTION "sheet_sync_capture_users"();

CREATE TRIGGER "candidate_stages_sheet_sync_capture"
    AFTER INSERT OR UPDATE OR DELETE ON "candidate_stages"
    FOR EACH ROW EXECUTE FUNCTION "sheet_sync_capture_candidate_child"();

CREATE TRIGGER "documents_sheet_sync_capture"
    AFTER INSERT OR UPDATE OR DELETE ON "documents"
    FOR EACH ROW EXECUTE FUNCTION "sheet_sync_capture_candidate_child"();
