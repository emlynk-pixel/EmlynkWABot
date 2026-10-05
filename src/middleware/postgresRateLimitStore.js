// Rate-limit counters in PostgreSQL (Phase 12, Step 5C): an
// express-rate-limit store, so every app instance (several serverless
// instances on Vercel) shares the same counts. The limiters themselves
// (limits, windows, keys, responses, headers) are unchanged; only where the
// counts live changed (before: each process's memory).
//
// Same semantics as express-rate-limit's MemoryStore: a fixed window per key
// that starts with its first hit; after it has passed, the next hit starts a
// new window. decrement() never goes below 0.
//
// One statement per counted request: an atomic upsert (INSERT … ON CONFLICT
// DO UPDATE) on the key's row, which also restarts an expired window. The
// primary key serializes concurrent requests for the same key, so each gets
// its own count and none can slip past the limit. Times come from the
// database clock, the same for every instance.
//
// Rows: key = "<limiter prefix><sha256 of the client key>" (no IP address
// stored). An expired row is reused by that client's next request; rows of
// clients that don't come back are deleted by a cleanup statement run at
// most once per window per instance, after a count (never on its own timer).
//
// If the database can't be reached, the request fails (500) instead of
// passing unlimited: the limits keep protecting login and the admin API.
import { sha256Hex } from "../utils/fileChecksum.js";
import { resolveDb } from "../utils/resolveClients.js";

export function createPostgresRateLimitStore({ prefix, db = null, log = console }) {
    let windowMs = 60_000;          // replaced by the limiter's windowMs (init)
    let nextCleanupAt = 0;
    const rowKey = (key) => `${prefix}${sha256Hex(Buffer.from(String(key)))}`;

    async function cleanupIfDue(client) {
        if (Date.now() < nextCleanupAt) return;
        nextCleanupAt = Date.now() + windowMs;
        try {
            await client.$executeRaw`DELETE FROM "rate_limits" WHERE "reset_at" <= now()`;
        } catch (error) {
            // Only housekeeping: the count itself already succeeded.
            log.error("Rate-limit cleanup failed (retried later):", { errorType: error?.name ?? "Error" });
        }
    }

    return {
        prefix,
        localKeys: false,

        init(options) {
            windowMs = options.windowMs;
        },

        async increment(key) {
            const client = await resolveDb(db);
            const [row] = await client.$queryRaw`
                INSERT INTO "rate_limits" ("key", "hits", "reset_at")
                VALUES (${rowKey(key)}, 1, now() + ${windowMs}::double precision * interval '1 millisecond')
                ON CONFLICT ("key") DO UPDATE SET
                    "hits" = CASE WHEN "rate_limits"."reset_at" <= now() THEN 1 ELSE "rate_limits"."hits" + 1 END,
                    "reset_at" = CASE WHEN "rate_limits"."reset_at" <= now() THEN EXCLUDED."reset_at" ELSE "rate_limits"."reset_at" END
                RETURNING "hits", "reset_at"`;
            await cleanupIfDue(client);
            return { totalHits: Number(row.hits), resetTime: new Date(row.reset_at) };
        },

        // Used by skipSuccessfulRequests (login): a successful request is
        // taken off again. Only within the current window, never below 0.
        async decrement(key) {
            const client = await resolveDb(db);
            await client.$executeRaw`
                UPDATE "rate_limits" SET "hits" = "hits" - 1
                WHERE "key" = ${rowKey(key)} AND "hits" > 0 AND "reset_at" > now()`;
        },

        async resetKey(key) {
            const client = await resolveDb(db);
            await client.$executeRaw`DELETE FROM "rate_limits" WHERE "key" = ${rowKey(key)}`;
        },
    };
}
