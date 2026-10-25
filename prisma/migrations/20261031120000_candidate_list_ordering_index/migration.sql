-- CreateIndex
CREATE INDEX "candidate_created_date_passport_id_idx" ON "candidate"("created_date" DESC, "passport_id" ASC);
