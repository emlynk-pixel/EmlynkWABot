-- Phase 10, Checkpoint 4: audit log for admin review actions
-- (APPROVE, KEEP_PENDING). Additive only: one new table, its indexes, a
-- foreign key to admins, access restrictions and an append-only trigger.
-- No existing table, column or row is changed.

-- CreateTable
CREATE TABLE "audit_logs" (
    "audit_id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "temporary_id" TEXT,
    "document_id" TEXT,
    "passport_id" TEXT,
    "previous_status" TEXT NOT NULL,
    "new_status" TEXT NOT NULL,
    "reason" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("audit_id")
);

-- CreateIndex
CREATE INDEX "audit_logs_temporary_id_created_date_idx" ON "audit_logs"("temporary_id", "created_date");

-- CreateIndex
CREATE INDEX "audit_logs_document_id_created_date_idx" ON "audit_logs"("document_id", "created_date");

-- CreateIndex
CREATE INDEX "audit_logs_admin_id_created_date_idx" ON "audit_logs"("admin_id", "created_date");

-- AddForeignKey
-- RESTRICT: an admin who has review actions on record can't be deleted
-- (deactivate instead), so every entry keeps its author.
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Same protection as the other application tables (SEC-001): Supabase's
-- public API roles get no access. The backend connects as the table owner.
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "audit_logs" FROM anon, authenticated;

-- Append-only: any UPDATE, DELETE or TRUNCATE is rejected, whoever runs it.
CREATE FUNCTION "audit_logs_reject_change"() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs is append-only: % is not allowed', TG_OP;
END;
$$;

CREATE TRIGGER "audit_logs_no_update_delete"
    BEFORE UPDATE OR DELETE ON "audit_logs"
    FOR EACH ROW EXECUTE FUNCTION "audit_logs_reject_change"();

CREATE TRIGGER "audit_logs_no_truncate"
    BEFORE TRUNCATE ON "audit_logs"
    FOR EACH STATEMENT EXECUTE FUNCTION "audit_logs_reject_change"();
