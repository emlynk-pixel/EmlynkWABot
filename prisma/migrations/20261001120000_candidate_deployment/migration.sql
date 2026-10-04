-- Candidate deployment (candidateService.js). Additive only: new nullable
-- columns and two new tables. No existing row or column is changed.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "job_experience" TEXT,
ADD COLUMN     "nic" TEXT;

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "document_variant" TEXT;

-- CreateTable
CREATE TABLE "candidate_stages" (
    "passport_id" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "completed_at" TIMESTAMP(3),
    "notes" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_stages_pkey" PRIMARY KEY ("passport_id","stage")
);

-- CreateTable
CREATE TABLE "candidate_call_logs" (
    "call_log_id" TEXT NOT NULL,
    "passport_id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_call_logs_pkey" PRIMARY KEY ("call_log_id")
);

-- CreateIndex
CREATE INDEX "candidate_call_logs_passport_id_created_date_idx" ON "candidate_call_logs"("passport_id", "created_date");

-- CreateIndex
-- NIC is new, so every existing row is NULL; PostgreSQL allows any number of
-- NULLs under a unique index.
CREATE UNIQUE INDEX "users_nic_key" ON "users"("nic");

-- AddForeignKey
ALTER TABLE "candidate_stages" ADD CONSTRAINT "candidate_stages_passport_id_fkey" FOREIGN KEY ("passport_id") REFERENCES "users"("passport_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_call_logs" ADD CONSTRAINT "candidate_call_logs_passport_id_fkey" FOREIGN KEY ("passport_id") REFERENCES "users"("passport_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_call_logs" ADD CONSTRAINT "candidate_call_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SEC-001: not readable or writable by Supabase's public API roles (the
-- backend connects as the table owner, which bypasses RLS).
ALTER TABLE "candidate_stages" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "candidate_stages" FROM anon, authenticated;
ALTER TABLE "candidate_call_logs" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "candidate_call_logs" FROM anon, authenticated;
