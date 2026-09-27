// Graceful shutdown on SIGTERM / SIGINT (M1).
//
// Docker sends SIGTERM and kills the process 10 s later (default stop grace
// period). Everything here ends before that:
//   1. the HTTP server stops accepting connections; requests already
//      running (webhook deliveries) may finish;
//   2. the background worker starts no new job; a running job may finish
//      until WORKER_STOP_MS, else it is released and resumed by the next run
//      in about a minute (submissionQueue.js);
//   3. Prisma disconnects;
//   4. the process exits. If anything is still waiting at the deadline, it
//      exits anyway (code 1): a webhook cut off then was not acknowledged,
//      so Meta sends it again, and the unique message ID keeps it single.

export const SHUTDOWN_DEADLINE_MS = 8_000;          // < Docker's 10 s grace period
const CLEANUP_RESERVE_MS = 2_000;                   // releasing jobs + disconnecting Prisma
export const WORKER_STOP_MS = SHUTDOWN_DEADLINE_MS - CLEANUP_RESERVE_MS;

export function createShutdown({ server, worker, db, deadlineMs = SHUTDOWN_DEADLINE_MS, workerStopMs = deadlineMs - CLEANUP_RESERVE_MS, exit = (code) => process.exit(code), log = console }) {
    let running = null;
    let exited = false;
    const exitOnce = (code) => {
        if (exited) return;
        exited = true;
        exit(code);
    };

    return function shutdown(signal) {
        running ??= (async () => {
            log.log("Shutting down:", { signal });
            const hardStop = setTimeout(() => {
                log.error("Shutdown deadline reached; exiting now");
                exitOnce(1);
            }, deadlineMs);

            let code = 0;
            const serverClosed = new Promise((resolve) => server.close((error) => resolve(error ?? null)));
            const [closeError, workerResult] = await Promise.all([
                serverClosed,
                worker.stop({ timeoutMs: Math.max(0, workerStopMs) }).catch((error) => ({ error })),
            ]);
            if (closeError) {
                log.error("HTTP server did not close cleanly:", { errorType: closeError.name ?? "Error" });
                code = 1;
            }
            if (workerResult?.error) {
                log.error("Background worker did not stop cleanly:", { errorType: workerResult.error.name ?? "Error" });
                code = 1;
            }

            try {
                await db.$disconnect();
            } catch (error) {
                log.error("Database disconnect failed:", { errorType: error?.name ?? "Error" });
                code = 1;
            }

            clearTimeout(hardStop);
            log.log("Shutdown complete:", { workerFinished: workerResult?.finished ?? false, jobsReleased: workerResult?.released ?? 0 });
            exitOnce(code);
        })();
        return running;
    };
}
