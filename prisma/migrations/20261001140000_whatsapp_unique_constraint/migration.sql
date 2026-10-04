-- Create a partial unique index for whatsapp_number to enforce uniqueness for candidates,
-- while explicitly exempting the already duplicated data (+94771581916).
CREATE UNIQUE INDEX "users_whatsapp_number_key" ON "users"("whatsapp_number")
WHERE "whatsapp_number" IS NOT NULL AND "whatsapp_number" != '+94771581916';
