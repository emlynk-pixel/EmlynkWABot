// HTTP-only entry point (Phase 12, Step 5A): the Express app as a request
// handler, for a serverless platform (Vercel) that calls it per request.
//
// Importing this module builds the same app as src/app.js (createApp.js:
// same routes, middleware and security headers) and nothing else. It does
// not listen on a port, does not start the background submission worker
// and registers no signal handlers: a serverless function doesn't keep a
// process alive between requests, so a polling worker could never run there.
// Submissions recorded by the webhook wait in PostgreSQL for a worker
// running as a long-lived process (src/app.js; later its own Cloud Run
// service).
//
// src/app.js stays the entry point for a normal Node process (local
// development, Docker, Cloud Run): it adds app.listen(), the worker and the
// graceful shutdown around the same app.
//
// Same startup checks as src/app.js, but a failure throws instead of calling
// process.exit(), so the platform reports it for the function. The message
// names the variables only, never their values.
import "dotenv/config";
import { assertValidEnv } from "./config/env.js";
import { assertValidRuntime } from "./config/runtime.js";

assertValidRuntime();
assertValidEnv();

// Imported after the check: some modules read env vars when loaded.
const { createApp } = await import("./createApp.js");

const app = createApp();

export default app;
