// Google Sheet sync worker process (Cloud Run service emlynk-sheet-sync-worker).
//
//   node src/sheetSyncWorker.js        (npm run sheet:worker)
//
// Runs requested reconciliations and connection tests (sheet_sync_runs) and
// answers Cloud Scheduler's authenticated reconcile trigger (06:00, 12:00 and
// 18:00 Asia/Colombo, SHEET_SYNC_SCHEDULE). Nothing is synced in real time:
// the Sheet is written only by those scheduled runs and by Sync Now. See
// src/services/sheetSyncWorker.js and Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md.
//
// Google authentication is keyless (Application Default Credentials: the
// Cloud Run service's runtime identity emlynk-sheet-sync@...). No key file;
// GOOGLE_APPLICATION_CREDENTIALS set is refused. While SHEET_SYNC_ENABLED is
// not "true" the Google token is requested with the read-only scope, so this
// process can't write to the Sheet even by mistake.
//
// It must be the only deployment running this file against a given Sheet
// (Cloud Run min = max instances = 1); the database writer lease protects
// the Sheet even if that is ever violated.

import "dotenv/config";
import { assertValidEnv, SHEET_SYNC_WORKER_REQUIRED_ENV_VARS } from "./config/env.js";
import { assertValidRuntime } from "./config/runtime.js";
import { readFormSubmissionSheetConfig, readSheetSyncConfig, readSheetSyncTuning } from "./config/sheetSync.js";

let config;
let tuning;
let formConfig;
try {
    assertValidRuntime();
    assertValidEnv(process.env, { required: SHEET_SYNC_WORKER_REQUIRED_ENV_VARS });
    config = readSheetSyncConfig(process.env);
    tuning = readSheetSyncTuning(process.env);
    formConfig = readFormSubmissionSheetConfig(process.env);
    const problems = [...config.problems, ...tuning.problems, ...formConfig.problems];
    if (problems.length) throw new Error(`Invalid Google Sheet sync configuration:\n- ${problems.join("\n- ")}`);
} catch (error) {
    // Variable names only, never values.
    console.error(error.message);
    process.exit(1);
}

const { default: prisma } = await import("./config/prisma.js");
const { createShutdown } = await import("./shutdown.js");
const { createCandidateAggregateReader } = await import("./services/candidateAggregateReader.js");
const { createGoogleSheetsAdapter, createLiveSheetsClient, SHEETS_SCOPE, SHEETS_READONLY_SCOPE } = await import("./services/googleSheetsAdapter.js");
const { createSheetSyncEngine } = await import("./services/sheetSyncEngine.js");
const { createSheetSyncStore, RUN_KIND, RUN_TRIGGER } = await import("./services/sheetSyncStore.js");
const { createSheetSyncWorker } = await import("./services/sheetSyncWorker.js");
const { createFormSubmissionSheetsAdapter } = await import("./services/formSubmissionSheetAdapter.js");
const { createFormSubmissionSyncStore } = await import("./services/formSubmissionSyncStore.js");
const { createFormSubmissionSync } = await import("./services/formSubmissionSync.js");
const { runSheetHealthCheck } = await import("./services/sheetHealthCheck.js");
const { createOidcVerifier, createSheetSyncHttpServer, startSheetSyncWorkerProcess } = await import("./sheetSyncWorkerProcess.js");

try {
    const scopes = config.enabled ? [SHEETS_SCOPE] : [SHEETS_READONLY_SCOPE];
    const reader = createCandidateAggregateReader({ db: prisma });
    // One adapter + engine per Sync Destination (SHEET_SYNC_DESTINATIONS, or
    // SHEET_SPREADSHEET_ID / SHEET_TAB_NAME), built when first used; each
    // run picks the active one when it starts.
    const runners = new Map();
    const forDestination = (destination) => {
        if (!runners.has(destination.key)) {
            const sheets = createGoogleSheetsAdapter({
                config: { ...config, spreadsheetId: destination.spreadsheetId, tabName: destination.tabName },
                sheetsClient: () => createLiveSheetsClient({ scopes }),
            });
            runners.set(destination.key, {
                engine: createSheetSyncEngine({ reader, sheets }),
                healthCheck: () => runSheetHealthCheck({ env: process.env, destination }),
            });
        }
        return runners.get(destination.key);
    };
    const store = createSheetSyncStore({ db: prisma });
    // The Candidate Form submissions: their own outbox and their own tab ("Candidate Form
    // Submissions") of the active destination's spreadsheet; the mirror's tab is never written.
    const formAdapters = new Map();
    const formSubmissions = createFormSubmissionSync({
        db: prisma,
        store: createFormSubmissionSyncStore({ db: prisma }),
        tabName: formConfig.tabName,
        adapterFor: (destination, tabName) => {
            const key = `${destination.key}|${tabName}`;
            if (!formAdapters.has(key)) {
                formAdapters.set(key, createFormSubmissionSheetsAdapter({
                    config: { enabled: config.enabled, spreadsheetId: destination.spreadsheetId, tabName },
                    sheetsClient: () => createLiveSheetsClient({ scopes }),
                }));
            }
            return formAdapters.get(key);
        },
    });
    const worker = createSheetSyncWorker({ store, forDestination, destinations: config.destinations, config, tuning, formSubmissions });

    let verifyScheduler = null;
    if (process.env.SHEET_SYNC_SCHEDULER_AUDIENCE && process.env.SHEET_SYNC_SCHEDULER_INVOKER) {
        const { OAuth2Client } = await import("google-auth-library");
        verifyScheduler = createOidcVerifier({
            audience: process.env.SHEET_SYNC_SCHEDULER_AUDIENCE,
            invoker: process.env.SHEET_SYNC_SCHEDULER_INVOKER,
            client: new OAuth2Client(),
        });
    }
    const server = createSheetSyncHttpServer({
        verifyScheduler,
        requestReconcile: async () => {
            const { run, created } = await store.requestRun({ kind: RUN_KIND.RECONCILE, triggerSource: RUN_TRIGGER.SCHEDULER });
            return { runId: run.runId, status: run.status, created };
        },
    });

    console.log(JSON.stringify({ event: "sheet_sync.worker_config", writeGate: config.gate, gateReason: config.gateReason, schedulerTrigger: Boolean(verifyScheduler), batchSize: tuning.batchSize, pollIntervalMs: tuning.pollIntervalMs, pilotCandidates: tuning.pilotCandidateIds?.length ?? 0, destinations: config.destinations.map((d) => d.key), formSubmissionsTab: formConfig.tabName }));
    await startSheetSyncWorkerProcess({ worker, server, createShutdown, db: prisma });
} catch (error) {
    console.error(JSON.stringify({ event: "sheet_sync.worker_start_failed", errorType: error?.name ?? "Error", code: typeof error?.code === "string" ? error.code : null }));
    process.exit(1);
}
