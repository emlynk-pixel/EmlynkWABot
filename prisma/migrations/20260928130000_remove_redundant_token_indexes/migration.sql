-- Drop redundant non-unique indexes for token hashes (AUDIT-005)
-- The @unique constraint on token_hash automatically provides a unique index,
-- making these secondary normal indexes redundant overhead.
DROP INDEX IF EXISTS "admin_password_resets_token_hash_idx";
DROP INDEX IF EXISTS "admin_invitations_token_hash_idx";
