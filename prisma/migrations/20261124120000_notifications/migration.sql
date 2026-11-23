-- In-app notifications (src/services/notificationService.js, GET /api/admin/notifications).
-- Additive only: one new table, its indexes and one foreign key. No existing
-- table, column or row is changed, nothing is backfilled, and nothing here
-- depends on the Supabase auth schema.
--
-- One row per recipient: a notification sent to five users is five rows, so
-- each user's read state is their own.
--   recipient_id  -> "user" (ON DELETE CASCADE: a deleted account takes its
--                    notifications with it)
--   type          the notification's key (e.g. A1_NEW_CANDIDATES_ALLOCATED)
--   dedupe_key    one event = one row per recipient: inserts use
--                 ON CONFLICT DO NOTHING on (recipient_id, dedupe_key), so a
--                 repeated or retried event never notifies twice
--   read_at       null = unread; set once, by the recipient only
-- Title and message are display text only: no passport number, NIC, phone
-- number or other identifier is ever written here.

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recipient_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT,
    "message" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(3),

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_recipient_dedupe_key" ON "notification"("recipient_id", "dedupe_key");

-- The bell: a user's notifications newest first, and their unread count.
-- CreateIndex
CREATE INDEX "notification_recipient_read_created_idx" ON "notification"("recipient_id", "read_at", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "user"("admin_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SEC-001: not readable or writable by Supabase's public API roles (the
-- backend connects as the table owner, which bypasses RLS).
ALTER TABLE "notification" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "notification" FROM anon, authenticated;
