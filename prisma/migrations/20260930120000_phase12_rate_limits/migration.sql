-- Phase 12, Step 5C: rate-limit counters shared by all app instances
-- (middleware/postgresRateLimitStore.js). Operational state only: one row per
-- limiter and client, no history. New table only; no existing data changes.

-- CreateTable
CREATE TABLE "rate_limits" (
    "key" TEXT NOT NULL,
    "hits" INTEGER NOT NULL,
    "reset_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
-- For deleting expired rows.
CREATE INDEX "rate_limits_reset_at_idx" ON "rate_limits"("reset_at");

-- SEC-001: not readable or writable by Supabase's public API roles (the
-- backend connects as the table owner, which bypasses RLS).
ALTER TABLE "rate_limits" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "rate_limits" FROM anon, authenticated;
