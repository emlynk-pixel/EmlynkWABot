-- Automatic reset of a candidate's manual verification when the data it covered changes.
-- ADDITIVE ONLY: three functions and three triggers. No table, column or row changes.
--
-- Business rules (candidate_verification, 20261021120000):
--   * Details Verified is cleared when a material candidate-detail value (the candidate row's
--     detail columns) or any Additional details value changes.
--   * Documents Verified is cleared when the set or state of the REQUIRED documents changes
--     (PASSPORT, MEDICAL, POLICE_REPORT, SCAN): a document added, removed, replaced, or moved to
--     another status / file.
-- Nothing else resets them (test result, jobs, call logs, notes, other stages, other document types).
--
-- Why triggers: the reset must happen in the SAME transaction as the change, whichever code path
-- makes it (admin edits, uploads, review approvals, WhatsApp document processing, OCR
-- reconciliation). A trigger cannot be forgotten by a new code path and cannot leave updated data
-- with a stale verification: if the change rolls back, so does the reset.
--
-- Audit: the reset is audited when the application named the signed-in user for the transaction
-- (set_config('app.actor_id', <admin id>, true), see src/services/auditActor.js). An automated
-- change (WhatsApp processing, OCR reconciliation) has no user and audit_logs requires one, so it
-- resets WITHOUT an entry. Only a verification that was actually set is cleared and audited, so
-- there are no duplicate entries.

CREATE FUNCTION "candidate_verification_reset"(p_passport_id TEXT, p_kind TEXT, p_reason TEXT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_actor TEXT := NULLIF(current_setting('app.actor_id', true), '');
    v_rows INTEGER;
BEGIN
    IF p_kind = 'DETAILS' THEN
        UPDATE "candidate_verification" SET "details_verified_at" = NULL, "details_verified_by" = NULL, "updated_at" = CURRENT_TIMESTAMP
        WHERE "passport_id" = p_passport_id AND "details_verified_at" IS NOT NULL;
    ELSE
        UPDATE "candidate_verification" SET "documents_verified_at" = NULL, "documents_verified_by" = NULL, "updated_at" = CURRENT_TIMESTAMP
        WHERE "passport_id" = p_passport_id AND "documents_verified_at" IS NOT NULL;
    END IF;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 AND v_actor IS NOT NULL AND EXISTS (SELECT 1 FROM "user" WHERE "admin_id" = v_actor) THEN
        INSERT INTO "audit_logs" ("audit_id", "admin_id", "action", "passport_id", "previous_status", "new_status", "reason")
        VALUES (gen_random_uuid()::text, v_actor,
                CASE WHEN p_kind = 'DETAILS' THEN 'DETAILS_VERIFICATION_RESET' ELSE 'DOCUMENTS_VERIFICATION_RESET' END,
                p_passport_id, 'VERIFIED', 'NOT_VERIFIED', p_reason);
    END IF;
END;
$$;

-- Candidate details: only a real change of a detail column.
CREATE FUNCTION "candidate_details_changed_reset"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM "candidate_verification_reset"(NEW."passport_id", 'DETAILS', 'Candidate details changed after verification');
    RETURN NULL;
END;
$$;
CREATE TRIGGER "candidate_details_changed_reset_trg" AFTER UPDATE OF
    "first_name", "other_name", "address", "nic", "job", "job_experience", "whatsapp_number", "contact_number",
    "place_of_birth", "date_of_birth", "passport_issue_date", "passport_expiry_date", "nationality", "sex"
    ON "candidate" FOR EACH ROW
    WHEN ((OLD."first_name", OLD."other_name", OLD."address", OLD."nic", OLD."job", OLD."job_experience", OLD."whatsapp_number", OLD."contact_number",
           OLD."place_of_birth", OLD."date_of_birth", OLD."passport_issue_date", OLD."passport_expiry_date", OLD."nationality", OLD."sex")
          IS DISTINCT FROM
          (NEW."first_name", NEW."other_name", NEW."address", NEW."nic", NEW."job", NEW."job_experience", NEW."whatsapp_number", NEW."contact_number",
           NEW."place_of_birth", NEW."date_of_birth", NEW."passport_issue_date", NEW."passport_expiry_date", NEW."nationality", NEW."sex"))
    EXECUTE FUNCTION "candidate_details_changed_reset"();

-- Additional details: a first save, or any value changed (the version column updated_date alone is not a change).
CREATE FUNCTION "candidate_additional_details_changed_reset"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM "candidate_verification_reset"(NEW."passport_id", 'DETAILS', 'Additional details changed after verification');
    RETURN NULL;
END;
$$;
CREATE TRIGGER "candidate_additional_details_changed_reset_ins_trg" AFTER INSERT ON "candidate_additional_details"
    FOR EACH ROW EXECUTE FUNCTION "candidate_additional_details_changed_reset"();
CREATE TRIGGER "candidate_additional_details_changed_reset_upd_trg" AFTER UPDATE ON "candidate_additional_details"
    FOR EACH ROW WHEN ((to_jsonb(OLD) - 'updated_date') IS DISTINCT FROM (to_jsonb(NEW) - 'updated_date'))
    EXECUTE FUNCTION "candidate_additional_details_changed_reset"();

-- Required documents: added, removed, replaced, or moved to another status / type / variant / file.
CREATE FUNCTION "documents_changed_reset"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_required TEXT[] := ARRAY['PASSPORT', 'MEDICAL', 'POLICE_REPORT', 'SCAN'];
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."document_type" = ANY (v_required) THEN
            PERFORM "candidate_verification_reset"(OLD."passport_id", 'DOCUMENTS', 'Required document removed (' || OLD."document_type" || ')');
        END IF;
    ELSIF TG_OP = 'INSERT' THEN
        IF NEW."document_type" = ANY (v_required) THEN
            PERFORM "candidate_verification_reset"(NEW."passport_id", 'DOCUMENTS', 'Required document added (' || NEW."document_type" || ')');
        END IF;
    ELSIF OLD."document_type" = ANY (v_required) OR NEW."document_type" = ANY (v_required) THEN
        PERFORM "candidate_verification_reset"(NEW."passport_id", 'DOCUMENTS', 'Required document changed (' || NEW."document_type" || ')');
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER "documents_changed_reset_ins_del_trg" AFTER INSERT OR DELETE ON "documents"
    FOR EACH ROW EXECUTE FUNCTION "documents_changed_reset"();
CREATE TRIGGER "documents_changed_reset_upd_trg" AFTER UPDATE ON "documents"
    FOR EACH ROW WHEN ((OLD."document_type", OLD."document_variant", OLD."verification_status", OLD."storage_path", OLD."file_sha256")
                       IS DISTINCT FROM (NEW."document_type", NEW."document_variant", NEW."verification_status", NEW."storage_path", NEW."file_sha256"))
    EXECUTE FUNCTION "documents_changed_reset"();
