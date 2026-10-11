-- Priority Follow-Ups: a call log marked as needing attention.
-- Additive only: one new table, its indexes and foreign keys. No existing
-- table, column or row is changed; existing call logs simply have no
-- follow-up until one is flagged.
--
-- The call log stays the source of truth for the note, the call time, the
-- caller and the candidate, so none of those are copied here.
--   call_log_id   -> candidate_call_logs (ON DELETE CASCADE: a follow-up
--                    never outlives its call log, so none is orphaned)
--   flagged_by    -> "user" (who flagged it)
--   completed_by  -> "user" (who completed it; null while OPEN)
-- Deleting a follow-up (ADMIN / MANAGER) removes this row only.

-- CreateTable
CREATE TABLE "call_log_follow_up" (
    "follow_up_id" TEXT NOT NULL,
    "call_log_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "flagged_by" TEXT NOT NULL,
    "flagged_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_by" TEXT,
    "completed_date" TIMESTAMP(3),

    CONSTRAINT "call_log_follow_up_pkey" PRIMARY KEY ("follow_up_id"),
    -- OPEN has no completion; COMPLETED has both who and when.
    CONSTRAINT "call_log_follow_up_status_check" CHECK ("status" IN ('OPEN', 'COMPLETED')),
    CONSTRAINT "call_log_follow_up_completion_check" CHECK (
        ("status" = 'OPEN' AND "completed_by" IS NULL AND "completed_date" IS NULL)
        OR ("status" = 'COMPLETED' AND "completed_by" IS NOT NULL AND "completed_date" IS NOT NULL)
    )
);

-- CreateIndex
CREATE INDEX "call_log_follow_up_call_log_id_idx" ON "call_log_follow_up"("call_log_id");

-- CreateIndex
CREATE INDEX "call_log_follow_up_status_flagged_date_idx" ON "call_log_follow_up"("status", "flagged_date");

-- At most one OPEN follow-up per call log (completed ones are kept as
-- history, so a call log can be flagged again after one is completed).
-- A WHERE-conditioned unique index: not expressible in schema.prisma.
CREATE UNIQUE INDEX "call_log_follow_up_one_open_per_call_log" ON "call_log_follow_up"("call_log_id") WHERE "status" = 'OPEN';

-- AddForeignKey
ALTER TABLE "call_log_follow_up" ADD CONSTRAINT "call_log_follow_up_call_log_id_fkey" FOREIGN KEY ("call_log_id") REFERENCES "candidate_call_logs"("call_log_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_log_follow_up" ADD CONSTRAINT "call_log_follow_up_flagged_by_fkey" FOREIGN KEY ("flagged_by") REFERENCES "user"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_log_follow_up" ADD CONSTRAINT "call_log_follow_up_completed_by_fkey" FOREIGN KEY ("completed_by") REFERENCES "user"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SEC-001: not readable or writable by Supabase's public API roles (the
-- backend connects as the table owner, which bypasses RLS).
ALTER TABLE "call_log_follow_up" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "call_log_follow_up" FROM anon, authenticated;
