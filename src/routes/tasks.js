// Scheduled backend tasks of the API, mounted at /api/tasks (createApp.js; on Vercel the existing /api rewrite reaches it).
//
//   POST /import-recovery   one run of the automatic recovery of interrupted bulk imports (importRecoveryService.js):
//                           detect and claim abandoned imports, continue their rollbacks within a time budget, confirm
//                           the Google Sheet reconciliation. Called by Cloud Scheduler about once a minute. Answers 200
//                           with counts, ids and codes only. Safe to call twice at once (row locks, SKIP LOCKED, leases).
//
// Authentication: the same OIDC check as the sheet worker's POST /tasks/reconcile (createOidcVerifier: a Google-signed
// ID token, the expected audience, the verified e-mail of the scheduler's service account). Unlike that private Cloud Run
// service, the API is public, so there is no IAM perimeter in front of it: the route is DISABLED (404) unless
// IMPORT_RECOVERY_SCHEDULER_AUDIENCE and IMPORT_RECOVERY_SCHEDULER_INVOKER are both set, and every call must carry a
// valid token. No request body is read.

import express from "express";

import { resolveDb } from "../utils/resolveClients.js";
import { createOidcVerifier } from "../sheetSyncWorkerProcess.js";
import { readRecoveryConfig, runImportRecovery } from "../services/importRecoveryService.js";

// The verifier from the environment, or null (route disabled). google-auth-library is loaded on the first call only.
export function recoverySchedulerVerifier(env = process.env) {
    const audience = env.IMPORT_RECOVERY_SCHEDULER_AUDIENCE;
    const invoker = env.IMPORT_RECOVERY_SCHEDULER_INVOKER;
    if (!audience || !invoker) return null;
    let verify = null;
    return async (authorization) => {
        if (!verify) {
            const { OAuth2Client } = await import("google-auth-library");
            verify = createOidcVerifier({ audience, invoker, client: new OAuth2Client() });
        }
        return verify(authorization);
    };
}

export function createTaskRouter({ db, verifyScheduler = recoverySchedulerVerifier(), runRecovery = runImportRecovery, env = process.env, log = console } = {}) {
    const router = express.Router();
    const { config, problems } = readRecoveryConfig(env);

    router.post("/import-recovery", async (req, res, next) => {
        if (!verifyScheduler) return res.status(404).end();
        try {
            if (!(await verifyScheduler(req.get("authorization")))) {
                log.warn(JSON.stringify({ event: "candidate_import.recovery_trigger_rejected" }));
                return res.status(401).json({ message: "Unauthorized" });
            }
            if (problems.length) log.warn(JSON.stringify({ event: "candidate_import.recovery_config_invalid", problems }));
            const summary = await runRecovery({ db: await resolveDb(db), config, log });
            log.log(JSON.stringify({
                event: "candidate_import.recovery_run", claimed: summary.claimed.length, adopted: summary.adopted.length, worked: summary.worked.length,
                keyAvailable: summary.keyAvailable, budgetExhausted: summary.budgetExhausted,
            }));
            return res.status(200).set("cache-control", "no-store").json(summary);
        } catch (error) {
            return next(error);
        }
    });

    return router;
}
