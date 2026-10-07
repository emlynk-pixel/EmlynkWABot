// Lifecycle and HTTP surface of the Google Sheet sync worker process
// (src/sheetSyncWorker.js; Cloud Run service emlynk-sheet-sync-worker).
// Importing this module starts nothing.
//
// HTTP (Cloud Run needs a listener on $PORT; the service is PRIVATE, deployed
// with --no-allow-unauthenticated, so Cloud Run IAM rejects every caller
// without roles/run.invoker before a request gets here):
//   GET/HEAD /health      200 {"status":"OK"}; reveals nothing
//   POST /tasks/reconcile Cloud Scheduler's trigger. Defence in depth on top
//                         of IAM: the OIDC token is verified again here
//                         (signature, audience, verified caller e-mail).
//                         It only RECORDS a durable RECONCILE run (or returns
//                         the active one) and answers 202 at once; the worker
//                         loop does the work. Disabled (404) unless
//                         SHEET_SYNC_SCHEDULER_AUDIENCE and
//                         SHEET_SYNC_SCHEDULER_INVOKER are both set.
//   anything else         404
// No request body is read. The reconciliation schedule lives in Cloud
// Scheduler, never in this process.

import http from "node:http";

// verify(authorizationHeader) -> true only for a valid Google-signed ID token
// whose audience is `audience` and whose verified e-mail is `invoker`.
export function createOidcVerifier({ audience, invoker, client }) {
    if (!audience || !invoker || !client) return null;
    return async (authorization) => {
        const match = /^Bearer\s+(\S+)$/.exec(authorization ?? "");
        if (!match) return false;
        try {
            const ticket = await client.verifyIdToken({ idToken: match[1], audience });
            const payload = ticket.getPayload() ?? {};
            return payload.email === invoker && payload.email_verified === true;
        } catch {
            return false;
        }
    };
}

// requestReconcile() -> { runId, status, created }; verifyScheduler: from
// createOidcVerifier, or null (endpoint disabled).
export function createSheetSyncHttpServer({ requestReconcile, verifyScheduler = null, log = console }) {
    return http.createServer(async (req, res) => {
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        const send = (status, body) => {
            res.writeHead(status, body ? { "content-type": "application/json", "cache-control": "no-store" } : {});
            res.end(body && req.method !== "HEAD" ? JSON.stringify(body) : undefined);
        };
        try {
            if ((req.method === "GET" || req.method === "HEAD") && path === "/health") return send(200, { status: "OK" });
            if (req.method === "POST" && path === "/tasks/reconcile" && verifyScheduler) {
                if (!(await verifyScheduler(req.headers.authorization))) {
                    log.warn(JSON.stringify({ event: "sheet_sync.trigger_rejected" }));
                    return send(401, { message: "Unauthorized" });
                }
                const run = await requestReconcile();
                log.log(JSON.stringify({ event: "sheet_sync.run_requested", kind: "RECONCILE", trigger: "SCHEDULER", runId: run.runId, created: run.created }));
                return send(202, run);
            }
            return send(404);
        } catch (error) {
            log.error(JSON.stringify({ event: "sheet_sync.trigger_failed", errorType: error?.name ?? "Error" }));
            return send(500, { message: "Internal server error" });
        }
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

// Starts the HTTP listener (if `port`), then the worker loop, and hands
// SIGTERM/SIGINT to the shared graceful shutdown (src/shutdown.js).
export async function startSheetSyncWorkerProcess({ worker, server = null, createShutdown, db, port = process.env.PORT, signals = process, exit, log = console }) {
    let listening = null;
    if (server && port !== undefined && port !== "") {
        await listen(server, port);
        listening = server;
    }
    worker.start();
    const shutdown = createShutdown({ server: listening, worker, db, log, ...(exit ? { exit } : {}) });
    for (const signal of ["SIGTERM", "SIGINT"]) signals.once(signal, () => shutdown(signal));
    log.log(JSON.stringify({ event: "sheet_sync.worker_started", port: listening ? listening.address().port : null }));
    return { shutdown, server: listening };
}
