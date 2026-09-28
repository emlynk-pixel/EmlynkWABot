// Shared lazy-resolution helpers for Prisma and Supabase storage clients.
//
// AUDIT-009: resolveDb and resolveBucket were copy-pasted into 9 files.
// This module is the single canonical source; each file that previously
// defined its own copy should import from here instead.
//
// The helpers keep the same behaviour:
//   - Accept an already-resolved client (used by unit tests that inject fakes).
//   - Fall back to the real singleton when none is provided (production).
//
// Import pattern:
//   import { resolveDb, resolveBucket } from "../utils/resolveClients.js";

/**
 * Returns the Prisma client.
 * @param {import("../../generated/prisma").PrismaClient | null | undefined} db
 *   An injected test double, or falsy to use the real production client.
 */
export async function resolveDb(db) {
    return db ?? (await import("../config/prisma.js")).default;
}

/**
 * Returns the Supabase storage client (bucket accessor).
 * @param {object | null | undefined} bucket
 *   An injected test double, or falsy to create the real client from env.
 */
export async function resolveBucket(bucket) {
    if (bucket) return bucket;
    const { default: supabase } = await import("../config/supabase.js");
    return supabase.storage.from(process.env.SUPABASE_BUCKET);
}
