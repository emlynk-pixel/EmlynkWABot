-- Audit Logs filters and export (POST /api/admin/audit-logs/export).
-- Additive only: three indexes, no column, row or trigger is changed.
--
-- created_date: the unfiltered list / export, newest first, read in keyset
-- batches of (created_date, audit_id).
CREATE INDEX "audit_logs_created_date_idx" ON "audit_logs"("created_date");

-- A candidate's entries (the passport ID filter, a candidate name / ID search)
-- newest first.
CREATE INDEX "audit_logs_passport_id_created_date_idx" ON "audit_logs"("passport_id", "created_date");

-- The passport ID filter ignores case (auditLogService.js filterLookups):
-- lower("passport_id") = lower($1) finds the stored spellings through this
-- index. Not in schema.prisma (Prisma can't express an expression index),
-- like "job_type_name_lower_key".
CREATE INDEX "audit_logs_passport_id_lower_idx" ON "audit_logs"(lower("passport_id"));
