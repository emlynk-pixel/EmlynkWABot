-- Additional details: "N/A" for the optional fields.
--
-- The Additional details step is completed when every field the form shows is filled. The optional
-- fields (Physical details & skills, Clothing & sizes, Employment / skills) may be unknown, and most
-- of them cannot hold the text "N/A" (a DATE, BOOLEAN or DECIMAL column, or a CHECK list such as
-- blood_group). So the field stays NULL and this column lists which fields were marked N/A.
--
-- ADDITIVE ONLY: one column with an empty-list default (as Prisma creates a scalar list). Every existing row gets '{}', nothing
-- is backfilled or dropped, no existing column, constraint or trigger changes (the sheet-sync capture
-- trigger fires on row changes, not on the column default).
--
-- Rollback (keeps all other data):
--   ALTER TABLE "candidate_additional_details" DROP COLUMN "not_applicable_fields";

-- AlterTable
ALTER TABLE "candidate_additional_details" ADD COLUMN     "not_applicable_fields" TEXT[] DEFAULT ARRAY[]::TEXT[];
