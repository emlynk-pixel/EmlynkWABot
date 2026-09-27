-- M1: asynchronous WhatsApp processing. Additive only: five nullable or
-- defaulted columns on temporary_data and two indexes. No existing column,
-- constraint or row is changed; existing rows get NULL / 0 (no message ID,
-- so the new unique index can't conflict).
--   message_id             WhatsApp message ID, unique: a redelivered
--                          message never creates a second submission
--   original_filename,
--   received_at            as received, for the background worker
--   processing_attempts,
--   processing_started_at  the worker's lease (crash recovery, bounded attempts)

-- AlterTable
ALTER TABLE "temporary_data" ADD COLUMN     "message_id" TEXT,
ADD COLUMN     "original_filename" TEXT,
ADD COLUMN     "processing_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "processing_started_at" TIMESTAMP(3),
ADD COLUMN     "received_at" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "temporary_data_message_id_key" ON "temporary_data"("message_id");

-- CreateIndex
CREATE INDEX "temporary_data_processing_status_created_date_idx" ON "temporary_data"("processing_status", "created_date");
