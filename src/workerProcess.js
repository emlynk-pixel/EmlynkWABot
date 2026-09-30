// Lifecycle of the worker-only process (Phase 12, Step 5B), used by
// src/worker.js. Importing this module starts nothing.
//
// startWorkerProcess() is a thin wrapper around the existing worker: it
// starts it once (startSubmissionWorker(), unchanged: PostgreSQL claims,
// leases, fencing and retries all stay in submissionQueue.js), and hands
// SIGTERM/SIGINT to the existing graceful shutdown (src/shutdown.js), which
// stops the worker, releases unfinished leases and disconnects Prisma.
//
// Health port: a Cloud Run service must listen on $PORT, or its revision
// never becomes ready. When a port is given (the Docker image sets PORT), a
// minimal HTTP listener answers GET /health with 200 and everything else
// with 404; it serves nothing else and reveals nothing. Without a port
// (e.g. `npm run worker` locally) there is no listener at all. The worker's
// own poll timer is what keeps the process alive.
import http from "node:http";

export function createHealthServer() {
    return http.createServer((req, res) => {
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        if ((req.method === "GET" || req.method === "HEAD") && path === "/health") {
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(req.method === "HEAD" ? undefined : JSON.stringify({ status: "OK" }));
        }
        res.writeHead(404);
        return res.end();
    });
}

function listen(server, port) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(Number(port), () => {
            server.off("error", reject);
            resolve();
        });
    });
}

// Starts the health listener (if `port`), then the worker exactly once, and
// registers the shutdown for SIGTERM/SIGINT. Throws if the port can't be
// opened; the worker is not started then.
export async function startWorkerProcess({
    startWorker,
    createShutdown,
    db,
    port = process.env.PORT,
    signals = process,
    exit,
    log = console,
}) {
    let server = null;
    if (port !== undefined && port !== "") {
        server = createHealthServer();
        await listen(server, port);
    }

    const worker = startWorker();
    const shutdown = createShutdown({ server, worker, db, log, ...(exit ? { exit } : {}) });
    for (const signal of ["SIGTERM", "SIGINT"]) {
        signals.once(signal, () => shutdown(signal));
    }

    log.log("Submission worker running:", { healthPort: server ? server.address().port : null });
    return { worker, server, shutdown };
}
