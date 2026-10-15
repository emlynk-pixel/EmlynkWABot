-- Work Allocation: which Analyst a candidate is assigned to.
-- Additive only: one new table, its index and foreign keys. No existing
-- table, column or row is changed, so every existing candidate starts
-- unallocated (no row here).
--
-- A separate 1:1 table rather than a column on "candidate": allocating or
-- moving a candidate never updates the candidate row, so it does not fire
-- the candidate's Google Sheet sync trigger or change its updated_date.
--   passport_id   -> candidate (ON DELETE CASCADE, ON UPDATE CASCADE like
--                    the other candidate child tables); one row per
--                    candidate at most (primary key)
--   analyst_id    -> "user" (the assigned Analyst; ON DELETE RESTRICT:
--                    staff rows are deactivated, never deleted)
-- Who allocated and the earlier Analyst are in audit_logs
-- (ASSIGN_CANDIDATE / REASSIGN_CANDIDATE / UNASSIGN_CANDIDATE).

-- CreateTable
CREATE TABLE "candidate_allocation" (
    "passport_id" TEXT NOT NULL,
    "analyst_id" TEXT NOT NULL,
    "assigned_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_allocation_pkey" PRIMARY KEY ("passport_id")
);

-- CreateIndex: an Analyst's candidates, and the per-Analyst counts.
CREATE INDEX "candidate_allocation_analyst_id_idx" ON "candidate_allocation"("analyst_id");

-- AddForeignKey
ALTER TABLE "candidate_allocation" ADD CONSTRAINT "candidate_allocation_passport_id_fkey" FOREIGN KEY ("passport_id") REFERENCES "candidate"("passport_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_allocation" ADD CONSTRAINT "candidate_allocation_analyst_id_fkey" FOREIGN KEY ("analyst_id") REFERENCES "user"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;
