// Must load before the app: supabase.js reads env vars at import time.
import "dotenv/config";
import { assertValidEnv } from "./config/env.js";
import { assertValidRuntime } from "./config/runtime.js";

// Fail fast on an unsupported Node version, a missing generated Prisma
// client, or a missing or malformed setting. The message names the
// variables only, never their values.
try {
    assertValidRuntime();
    assertValidEnv();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}

// Imported after the check: some modules read env vars when loaded.
const { createApp } = await import("./createApp.js");

const { startSubmissionWorker } = await import("./services/submissionQueue.js");

const app = createApp();

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

// Background processing of WhatsApp submissions (M1). It also resumes
// submissions left unfinished by a previous run.
const worker = startSubmissionWorker();

// Stop taking new work, let running jobs finish; an interrupted job's
// lease runs out and it is resumed by the next run.
for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, async () => {
        server.close();
        await worker.stop();
        process.exit(0);
    });
}
