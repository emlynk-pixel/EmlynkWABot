-- SEC-001: stop Supabase's public API roles from reading or changing
-- application tables. The backend connects as "postgres", which owns these
-- tables and has BYPASSRLS, so Prisma is not affected by anything below.
-- No data is changed. No RLS policies are created on purpose: with RLS on and
-- no policies, roles that don't bypass RLS see no rows at all.

-- 1. Turn on Row Level Security (deny-by-default for anon/authenticated).
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admins" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "temporary_data" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;

-- 2. Remove the table rights Supabase granted to its public API roles.
REVOKE ALL PRIVILEGES ON TABLE "users" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE "admins" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE "documents" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE "temporary_data" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE "_prisma_migrations" FROM anon, authenticated;

-- 3. Future tables created by "postgres" (i.e. by our migrations) must not be
-- exposed automatically either. Defaults owned by supabase_admin can't be
-- changed from this role and aren't used by our migrations.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE ALL ON TABLES FROM anon, authenticated;
