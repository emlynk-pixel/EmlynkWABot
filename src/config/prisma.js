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

import pg from "pg";

export const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: PRISMA_POOL_MAX,
});

// TEMPORARY DIAGNOSTIC LOGGING FOR POOL ERRORS
pool.on("error", (err) => {
    console.error("[PRISMA_DIAGNOSTIC_POOL_ERROR]", {
        name: err?.name,
        code: err?.code,
        message: err?.message,
        severity: err?.severity,
    });
});

// TEMPORARY POOL PERFORMANCE AUDIT INSTRUMENTATION
export const poolMetrics = {
    totalQueries: 0,
    totalAcquireWaitMs: 0,
    totalExecMs: 0,
    maxAcquireWaitMs: 0,
    peakWaitingCount: 0,
    getSnapshot() {
        return {
            totalCount: pool.totalCount,
            idleCount: pool.idleCount,
            waitingCount: pool.waitingCount,
            peakWaitingCount: this.peakWaitingCount,
            maxAcquireWaitMs: this.maxAcquireWaitMs,
        };
    },
};

const origQuery = pool.query.bind(pool);
pool.query = async function (config, values, callback) {
    if (typeof values === "function" || typeof callback === "function") {
        return origQuery.apply(pool, arguments);
    }
    const currentWaiting = pool.waitingCount;
    if (currentWaiting > poolMetrics.peakWaitingCount) {
        poolMetrics.peakWaitingCount = currentWaiting;
    }
    const tAcquireStart = performance.now();
    const client = await pool.connect();
    const acquireDuration = performance.now() - tAcquireStart;

    if (acquireDuration > poolMetrics.maxAcquireWaitMs) {
        poolMetrics.maxAcquireWaitMs = acquireDuration;
    }
    poolMetrics.totalAcquireWaitMs += acquireDuration;
    poolMetrics.totalQueries += 1;

    try {
        const tExecStart = performance.now();
        const res = await client.query(config, values);
        const execDuration = performance.now() - tExecStart;
        poolMetrics.totalExecMs += execDuration;
        return res;
    } finally {
        client.release();
    }
};

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({
    adapter
});

export default prisma;