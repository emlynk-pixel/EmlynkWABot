-- Candidate Form: new Personal Details answers (City in Romania, Blood Group, Other Languages,
-- Driving Licence, Can Read Drawings, Team Leading Skills, Height, Weight) and the parents'
-- Mother Alive / Father Alive answers.
-- ADDITIVE ONLY: nullable columns on candidate_form_response (the submitted answers) and
-- candidate_form_prefill_snapshot (the original values). No column is dropped, renamed or
-- retyped, nothing is backfilled, and no other table is touched: earlier submissions and
-- snapshots keep every value and simply have NULL in the new columns. The application
-- requires the new answers on NEW submissions (candidateFormDataService.js).
--
-- On candidate_form_response the server also stores two DERIVED values, never taken from the
-- request: height_cm (the height in centimetres) and distance_to_bucharest_km (the approximate
-- straight-line distance of a listed Romanian city to Bucharest, whole km; NULL otherwise).
--
-- The CHECK constraints hold for every existing row (all NULL) and mirror the application's
-- own rules, so a value outside them can never be stored by any path.

-- AlterTable
ALTER TABLE "candidate_form_response" ADD COLUMN     "blood_group" TEXT,
ADD COLUMN     "can_read_drawings" BOOLEAN,
ADD COLUMN     "city_in_romania" TEXT,
ADD COLUMN     "distance_to_bucharest_km" INTEGER,
ADD COLUMN     "driving_licence" BOOLEAN,
ADD COLUMN     "father_alive" BOOLEAN,
ADD COLUMN     "height" TEXT,
ADD COLUMN     "height_cm" DECIMAL(5,1),
ADD COLUMN     "mother_alive" BOOLEAN,
ADD COLUMN     "other_languages" TEXT,
ADD COLUMN     "team_leading_skills" BOOLEAN,
ADD COLUMN     "weight_kg" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "candidate_form_prefill_snapshot" ADD COLUMN     "blood_group" TEXT,
ADD COLUMN     "can_read_drawings" BOOLEAN,
ADD COLUMN     "city_in_romania" TEXT,
ADD COLUMN     "driving_licence" BOOLEAN,
ADD COLUMN     "father_alive" BOOLEAN,
ADD COLUMN     "height" TEXT,
ADD COLUMN     "mother_alive" BOOLEAN,
ADD COLUMN     "other_languages" TEXT,
ADD COLUMN     "team_leading_skills" BOOLEAN,
ADD COLUMN     "weight_kg" DECIMAL(5,2);

-- Constraints (NULL always passes).
ALTER TABLE "candidate_form_response"
    ADD CONSTRAINT "candidate_form_response_blood_group_check" CHECK ("blood_group" IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
    ADD CONSTRAINT "candidate_form_response_height_cm_check" CHECK ("height_cm" BETWEEN 50 AND 250),
    ADD CONSTRAINT "candidate_form_response_weight_kg_check" CHECK ("weight_kg" BETWEEN 20 AND 300),
    ADD CONSTRAINT "candidate_form_response_distance_check" CHECK ("distance_to_bucharest_km" >= 0);

ALTER TABLE "candidate_form_prefill_snapshot"
    ADD CONSTRAINT "candidate_form_prefill_snapshot_blood_group_check" CHECK ("blood_group" IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
    ADD CONSTRAINT "candidate_form_prefill_snapshot_weight_kg_check" CHECK ("weight_kg" BETWEEN 20 AND 300);
