-- Password Reset Tokens: Self-service recovery for administrator accounts
-- Stores ONLY SHA-256 hashes of reset tokens with 1-hour expiration.
CREATE TABLE "admin_password_resets" (
    "reset_id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_password_resets_pkey" PRIMARY KEY ("reset_id")
);

-- Unique constraint on token_hash ensures fast lookup and prevents collision
CREATE UNIQUE INDEX "admin_password_resets_token_hash_key" ON "admin_password_resets"("token_hash");

-- Index on token_hash for lookup performance
CREATE INDEX "admin_password_resets_token_hash_idx" ON "admin_password_resets"("token_hash");

-- Index on admin_id and expires_at for account reset querying and cleanup
CREATE INDEX "admin_password_resets_admin_id_expires_at_idx" ON "admin_password_resets"("admin_id", "expires_at");

-- Foreign key linking reset tokens to admin account (cascade deletion if admin is removed)
ALTER TABLE "admin_password_resets" ADD CONSTRAINT "admin_password_resets_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("admin_id") ON DELETE CASCADE ON UPDATE CASCADE;
