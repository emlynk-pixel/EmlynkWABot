import "dotenv/config";
import { PrismaClient } from "../../generated/prisma/client.ts";
import { PrismaPg } from "@prisma/adapter-pg";

//Get conn details from DATABASE_URL

// Each Vercel function instance runs this module fresh and gets its own
// pg.Pool, on top of Supabase's own Supavisor session-mode pooler
// (DATABASE_URL already points at the pooler, not the direct host - see
// Docs/08-cloud-deployment.md). pg.Pool's default `max` is 10 per instance;
// under concurrent invocations that can exhaust Supavisor's own, separately
// limited pool of server-side connections, surfacing as Prisma errors
// (e.g. P2024) on any query - including the admin login lookup. A small
// per-instance cap relies on Supavisor to do the real sharing, instead of
// every instance competing for up to 10 connections each.
export const PRISMA_POOL_MAX = Number(process.env.DATABASE_POOL_MAX) > 0 ? Number(process.env.DATABASE_POOL_MAX) : 3;

const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max: PRISMA_POOL_MAX,
});

const prisma = new PrismaClient({
    adapter
});

export default prisma;