-- Business rule (senior-confirmed): a client always has a first name, and a
-- temporary record always has the sender's WhatsApp number.
-- The live database already enforces both; this records it in the migration
-- history so the schema, migrations and database agree. On a database where
-- the columns are already NOT NULL this is a no-op.
ALTER TABLE "users" ALTER COLUMN "first_name" SET NOT NULL;

ALTER TABLE "temporary_data" ALTER COLUMN "whatsapp_number" SET NOT NULL;
