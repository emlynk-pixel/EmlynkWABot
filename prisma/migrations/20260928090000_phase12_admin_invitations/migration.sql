-- Phase 12 Checkpoint 2: Admin Invitation System
-- Stores hashed invitation tokens, expiration, and status for admin invitations.
CREATE TABLE "admin_invitations" (
    "invitation_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "admin_invitations_pkey" PRIMARY KEY ("invitation_id")
);

-- Unique constraint on token_hash ensures fast lookup and one-time registration
CREATE UNIQUE INDEX "admin_invitations_token_hash_key" ON "admin_invitations"("token_hash");

-- Indexes for querying by email and by status / expiration
CREATE INDEX "admin_invitations_email_idx" ON "admin_invitations"("email");
CREATE INDEX "admin_invitations_status_expires_at_idx" ON "admin_invitations"("status", "expires_at");

-- Foreign key linking the inviter to admins table
ALTER TABLE "admin_invitations" ADD CONSTRAINT "admin_invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "admins"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;
