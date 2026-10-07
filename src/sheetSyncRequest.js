// Operator command: record a durable Google Sheet sync run request.
//
//   node src/sheetSyncRequest.js reconcile   (npm run sheet:request -- reconcile)
//   node src/sheetSyncRequest.js test
//
// Inserts a QUEUED run into sheet_sync_runs (or reports the run of that kind
// already queued/running) and prints one JSON line. The sheet-sync worker
// executes it. Needs DATABASE_URL only; never talks to Google.

import { pathToFileURL } from "node:url";

export async function requestFromCommandLine({ argv = process.argv.slice(2), db, write = (text) => process.stdout.write(text) }) {
    const { RUN_KIND, RUN_TRIGGER, createSheetSyncStore } = await import("./services/sheetSyncStore.js");
    const kind = { reconcile: RUN_KIND.RECONCILE, test: RUN_KIND.TEST_CONNECTION }[argv[0]];
    if (!kind) {
        write(`${JSON.stringify({ event: "sheet_sync.request", error: "usage: sheetSyncRequest.js reconcile|test" })}\n`);
        return 2;
    }
    const { run, created } = await createSheetSyncStore({ db }).requestRun({ kind, triggerSource: RUN_TRIGGER.OPERATOR });
    write(`${JSON.stringify({ event: "sheet_sync.request", kind, runId: run.runId, status: run.status, created })}\n`);
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await import("dotenv/config");
    const { default: prisma } = await import("./config/prisma.js");
    try {
        process.exitCode = await requestFromCommandLine({ db: prisma });
    } catch (error) {
        console.error(JSON.stringify({ event: "sheet_sync.request_failed", errorType: error?.name ?? "Error" }));
        process.exitCode = 1;
    } finally {
        await prisma.$disconnect();
    }
}
