// Starts the backend for load testing, explicitly on `.env.loadtest` (never `.env`).
//   npm run loadtest:backend        (= node scripts/loadtest/startBackend.mjs)
// Aborts before anything starts if the environment guard fails (loadTestEnv.mjs).
// Also serves a small load-test-only metrics sidecar on 127.0.0.1:LOADTEST_METRICS_PORT (3999):
//   GET  /__loadtest/metrics   pool state + peaks since the last reset
//   POST /__loadtest/reset     zero the peaks and the pool counters, return the previous values
// It only reads the pool counters that config/prisma.js already keeps; no application code changes.

import http from "node:http";
import { loadLoadTestEnv, LoadTestGuardError } from "./loadTestEnv.mjs";

try {
    loadLoadTestEnv({ log: (line) => console.log(line) });
} catch (error) {
    console.error(error instanceof LoadTestGuardError ? `[loadtest] ABORT: ${error.message}` : `[loadtest] ABORT: ${error.message}`);
    process.exit(2);
}

const { isSheetSyncEnabled } = await import("../../src/config/sheetSync.js");
if (isSheetSyncEnabled()) {
    console.error("[loadtest] ABORT: Google Sheet sync is enabled in this process.");
    process.exit(2);
}

// The app (loads dotenv from .env.loadtest, validates its env, listens on PORT).
await import("../../src/app.js");
const { pool, poolMetrics } = await import("../../src/config/prisma.js");

const fresh = () => ({ samples: 0, peakTotal: 0, peakActive: 0, peakWaiting: 0, sumActive: 0, sumWaiting: 0, minIdle: Infinity, since: new Date().toISOString() });
let peaks = fresh();
setInterval(() => {
    const active = pool.totalCount - pool.idleCount;
    peaks.samples += 1;
    peaks.peakTotal = Math.max(peaks.peakTotal, pool.totalCount);
    peaks.peakActive = Math.max(peaks.peakActive, active);
    peaks.peakWaiting = Math.max(peaks.peakWaiting, pool.waitingCount);
    peaks.sumActive += active;
    peaks.sumWaiting += pool.waitingCount;
    peaks.minIdle = Math.min(peaks.minIdle, pool.idleCount);
}, 25).unref();

function snapshot() {
    const queries = poolMetrics.totalQueries;
    return {
        poolMax: pool.options.max,
        now: { total: pool.totalCount, idle: pool.idleCount, active: pool.totalCount - pool.idleCount, waiting: pool.waitingCount },
        sampled: {
            since: peaks.since,
            samples: peaks.samples,
            peakTotal: peaks.peakTotal,
            peakActive: peaks.peakActive,
            peakWaiting: peaks.peakWaiting,
            avgActive: peaks.samples ? Number((peaks.sumActive / peaks.samples).toFixed(2)) : 0,
            avgWaiting: peaks.samples ? Number((peaks.sumWaiting / peaks.samples).toFixed(2)) : 0,
            minIdle: Number.isFinite(peaks.minIdle) ? peaks.minIdle : null,
        },
        queries: {
            count: queries,
            avgExecMs: queries ? Number((poolMetrics.totalExecMs / queries).toFixed(2)) : 0,
            avgAcquireWaitMs: queries ? Number((poolMetrics.totalAcquireWaitMs / queries).toFixed(2)) : 0,
            maxAcquireWaitMs: Number(poolMetrics.maxAcquireWaitMs.toFixed(2)),
            peakWaitingAtAcquire: poolMetrics.peakWaitingCount,
            totalExecMs: Number(poolMetrics.totalExecMs.toFixed(1)),
        },
    };
}

function reset() {
    peaks = fresh();
    Object.assign(poolMetrics, { totalQueries: 0, totalAcquireWaitMs: 0, totalExecMs: 0, maxAcquireWaitMs: 0, peakWaitingCount: 0 });
}

const metricsPort = Number(process.env.LOADTEST_METRICS_PORT) || 3999;
http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/__loadtest/metrics") return res.end(JSON.stringify(snapshot()));
    if (req.method === "POST" && req.url === "/__loadtest/reset") {
        const before = snapshot();
        reset();
        return res.end(JSON.stringify(before));
    }
    res.statusCode = 404;
    return res.end("{}");
}).listen(metricsPort, "127.0.0.1", () => console.log(`[loadtest] metrics sidecar on http://127.0.0.1:${metricsPort}/__loadtest/metrics (pool max ${pool.options.max})`));
