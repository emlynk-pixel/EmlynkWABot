-- Candidate Form answers confirmed by an Admin / Manager become canonical, and reach the Google
-- Sheet operational mirror.
--
-- ADDITIVE ONLY:
--   1. nullable columns on candidate_additional_details for the Candidate Form answers that had
--      no canonical home (candidateFormFieldConfirmService.js writes them, one confirmed field at
--      a time). Nothing is backfilled: every existing row keeps every value and has NULL in the
--      new columns. candidate_form_response (the submitted answers) is not touched.
--   2. a change-capture trigger on candidate_additional_details that calls the EXISTING
--      sheet_sync_capture_candidate_child() (the one candidate_stages and documents use), so a
--      change of the details marks the candidate in the existing sheet_sync_queue. No new queue,
--      function or schedule.
--
-- The CHECK constraints hold for every existing row (all NULL) and mirror the application's
-- own rules (candidateFormDataService.js).
--
-- Rollback (stops capture, keeps all data):
--   DROP TRIGGER "candidate_additional_details_sheet_sync_capture" ON "candidate_additional_details";

-- AlterTable
ALTER TABLE "candidate_additional_details" ADD COLUMN     "blood_group" TEXT,
ADD COLUMN     "height" TEXT,
ADD COLUMN     "weight_kg" DECIMAL(5,2),
ADD COLUMN     "driving_licence" BOOLEAN,
ADD COLUMN     "can_read_drawings" BOOLEAN,
ADD COLUMN     "team_leading_skills" BOOLEAN,
ADD COLUMN     "other_languages" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "district" TEXT,
ADD COLUMN     "ds_division" TEXT,
ADD COLUMN     "gn_division" TEXT,
ADD COLUMN     "city_in_romania" TEXT,
ADD COLUMN     "english_knowledge" TEXT,
ADD COLUMN     "other_job_category" TEXT,
ADD COLUMN     "other_job_skills_2" TEXT,
ADD COLUMN     "father_passport_number" TEXT,
ADD COLUMN     "mother_passport_number" TEXT,
ADD COLUMN     "spouse_passport_number" TEXT,
ADD COLUMN     "guardian_name" TEXT,
ADD COLUMN     "guardian_relationship" TEXT,
ADD COLUMN     "guardian_nic" TEXT,
ADD COLUMN     "guardian_birthday" DATE,
ADD COLUMN     "guardian_phone" TEXT,
ADD COLUMN     "guardian_address" TEXT;

-- Constraints (NULL always passes).
ALTER TABLE "candidate_additional_details"
    ADD CONSTRAINT "candidate_additional_details_blood_group_check" CHECK ("blood_group" IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
    ADD CONSTRAINT "candidate_additional_details_weight_kg_check" CHECK ("weight_kg" BETWEEN 20 AND 300),
    ADD CONSTRAINT "candidate_additional_details_english_knowledge_check" CHECK ("english_knowledge" IN ('NO KNOWLEDGE', 'BASIC', 'FAIR', 'GOOD', 'VERY GOOD', 'FLUENT'));

-- Change capture: the same function and behaviour as candidate_stages / documents (the
-- candidate's unique_id is looked up through passport_id; a row whose candidate no longer
-- exists, e.g. cascaded from a candidate delete, adds nothing: that delete is captured on
-- "candidate").
CREATE TRIGGER "candidate_additional_details_sheet_sync_capture"
    AFTER INSERT OR UPDATE OR DELETE ON "candidate_additional_details"
    FOR EACH ROW EXECUTE FUNCTION "sheet_sync_capture_candidate_child"();
