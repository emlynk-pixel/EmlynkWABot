// Worker-only process (Phase 12, Step 5B): the background submission worker
// without the HTTP API, for its own Cloud Run service.
//
//   node src/worker.js        (npm run worker)
//
// The API and webhook run elsewhere (src/httpHandler.js on Vercel). They
// record each submission in PostgreSQL; this process claims and processes
// them with the existing worker (src/services/submissionQueue.js). PostgreSQL
// is the queue: there is no other channel between the two, and none is
// needed (the worker polls).
//
// src/app.js still runs the API and the worker together in one process (local
// development). Running it next to this one is safe: claims are
// compare-and-swap, so each submission is processed by one worker only.

// Must load before anything that reads env vars at import time.
import "dotenv/config";
import { assertValidEnv, WORKER_REQUIRED_ENV_VARS } from "./config/env.js";
import { assertValidRuntime } from "./config/runtime.js";

// Fail fast on an unsupported Node version, a missing generated Prisma
// client, or a missing or malformed setting (only those the worker uses).
// The message names the variables only, never their values.
try {
    assertValidRuntime();
    assertValidEnv(process.env, { required: WORKER_REQUIRED_ENV_VARS });
} catch (error) {
    console.error(error.message);
    process.exit(1);
}

// Imported after the check: some modules read env vars when loaded.
const { startSubmissionWorker } = await import("./services/submissionQueue.js");
const { createShutdown } = await import("./shutdown.js");
const { default: prisma } = await import("./config/prisma.js");
const { startWorkerProcess } = await import("./workerProcess.js");

try {
    await startWorkerProcess({ startWorker: startSubmissionWorker, createShutdown, db: prisma });
} catch (error) {
    console.error("Submission worker failed to start:", { errorType: error?.name ?? "Error", code: error?.code ?? null });
    process.exit(1);
}
