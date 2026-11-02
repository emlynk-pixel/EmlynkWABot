-- Settings > Candidate Form: the public form's title, logo and colours.
-- ADDITIVE ONLY: one new table. Nothing existing changes. No row means the
-- EMLYNK defaults (src/services/candidateFormBrandingService.js).
--
-- One row at most (the CHECK). logo_data_uri holds a small image as a data: URI,
-- not a Storage path: the bucket is private, and the form's Content-Security-Policy
-- already allows data: images and nothing else from outside its own origin.
-- It holds NO candidate data.
CREATE TABLE "candidate_form_branding" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "form_title" TEXT NOT NULL,
    "colors" JSONB NOT NULL,
    "logo_data_uri" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "candidate_form_branding_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "candidate_form_branding_single_row" CHECK ("id" = 'default')
);

ALTER TABLE "candidate_form_branding" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "candidate_form_branding" FROM anon, authenticated;
