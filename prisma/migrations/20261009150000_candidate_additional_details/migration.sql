-- Candidate additional details (Admin > Candidates > Additional Details).
-- Additive only: one new table and its foreign key. No existing table,
-- column or row is changed, and existing candidates simply have no
-- additional details row until one is saved.
--
-- One row per candidate at most: passport_id is the primary key and the
-- foreign key to candidate (ON UPDATE CASCADE follows a passport ID
-- correction; ON DELETE CASCADE removes the details with the candidate).

-- CreateTable
CREATE TABLE "candidate_additional_details" (
    "passport_id" TEXT NOT NULL,
    "name_as_in_passport" TEXT,
    "permanent_address" TEXT,
    "birthday" DATE,
    "tshirt_size" TEXT,
    "pant_size" TEXT,
    "shoe_size" TEXT,
    "father_alive" BOOLEAN,
    "father_full_name" TEXT,
    "father_birthday" DATE,
    "mother_alive" BOOLEAN,
    "mother_full_name" TEXT,
    "mother_birthday" DATE,
    "marital_status" TEXT,
    "wife_full_name" TEXT,
    "wife_birthday" DATE,
    "child_1_name" TEXT,
    "child_2_name" TEXT,
    "child_3_name" TEXT,
    "other_job_skills" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_additional_details_pkey" PRIMARY KEY ("passport_id")
);

-- AddForeignKey
ALTER TABLE "candidate_additional_details" ADD CONSTRAINT "candidate_additional_details_passport_id_fkey" FOREIGN KEY ("passport_id") REFERENCES "candidate"("passport_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- SEC-001: not readable or writable by Supabase's public API roles (the
-- backend connects as the table owner, which bypasses RLS).
ALTER TABLE "candidate_additional_details" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "candidate_additional_details" FROM anon, authenticated;
