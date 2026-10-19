-- Manual verification of a candidate's details and documents.
-- ADDITIVE ONLY: one new table. Nothing existing is changed; no row is created or inferred, so
-- every existing candidate starts as "not verified" (nothing was ever manually verified before).
--
-- The Candidate list Status ("Details Verified", "Documents Verified") needs an EXPLICIT human
-- signal. Completing or saving details, uploading a document, or an OCR-accepted document
-- (documents.verification_status = VERIFIED is also set automatically) are not that signal.
--
-- One row per candidate, created by the first verification. Each *_at / *_by pair is set or
-- cleared together. Verifying and un-verifying are audited in audit_logs (candidateVerificationService.js).

CREATE TABLE "candidate_verification" (
    "passport_id" TEXT NOT NULL,
    "details_verified_at" TIMESTAMP(3),
    "details_verified_by" TEXT,
    "documents_verified_at" TIMESTAMP(3),
    "documents_verified_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_verification_pkey" PRIMARY KEY ("passport_id"),
    CONSTRAINT "candidate_verification_details_check" CHECK (("details_verified_at" IS NULL) = ("details_verified_by" IS NULL)),
    CONSTRAINT "candidate_verification_documents_check" CHECK (("documents_verified_at" IS NULL) = ("documents_verified_by" IS NULL))
);

ALTER TABLE "candidate_verification" ADD CONSTRAINT "candidate_verification_passport_id_fkey" FOREIGN KEY ("passport_id") REFERENCES "candidate"("passport_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "candidate_verification" ADD CONSTRAINT "candidate_verification_details_verified_by_fkey" FOREIGN KEY ("details_verified_by") REFERENCES "user"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "candidate_verification" ADD CONSTRAINT "candidate_verification_documents_verified_by_fkey" FOREIGN KEY ("documents_verified_by") REFERENCES "user"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backend-only table (owner / service-role connection): RLS on, no API-role privileges, no policies.
ALTER TABLE "candidate_verification" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "candidate_verification" FROM anon, authenticated;
