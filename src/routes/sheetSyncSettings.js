// Settings -> Google Sheet Sync API, mounted at /api/admin/settings/sheet-sync
// (Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md, Section 13).
//
//   GET  /status          integration state, queue counts, last runs
//   POST /test            Test Connection: durable TEST_CONNECTION run -> 202
//   POST /run             Sync Now: durable RECONCILE run -> 202
//   GET  /runs/:runId     one run's status and result
//
// ADMIN only, enforced here by requireRole (the role is re-read from the
// database for every request by requireActiveUser), on top of the admin
// router's Supabase-session authentication and rate limiting (no cookie
// authenticates a request, so CSRF does not apply; Docs/SUPABASE_AUTH.md).
// Hiding the sidebar item is not the security boundary; this is.
//
// This runs on Vercel and never calls Google: POST only records a request
// that the sheet-sync worker (Cloud Run) executes, and returns at once, so no
// HTTP request stays open while rows sync. A request made while a run of the
// same kind is queued or running returns that run (no duplicates).

import express from "express";
import { requireRole, ROLES } from "../middleware/requireRole.js";
import { resolveDb } from "../utils/resolveClients.js";
import { RUN_KIND, RUN_TRIGGER } from "../services/sheetSyncStore.js";
import { getSheetSyncRun, getSheetSyncStatus, isValidRunId, requestSheetSyncRun } from "../services/sheetSyncStatusService.js";

const ADMINS_ONLY = [ROLES.ADMIN];

export function createSheetSyncSettingsRouter({ db, log = console } = {}) {
    const router = express.Router();
    router.use(requireRole(ADMINS_ONLY));

    router.get("/status", async (req, res) => {
        res.json(await getSheetSyncStatus({ db: await resolveDb(db) }));
    });

    const request = (kind) => async (req, res) => {
        const { run, created } = await requestSheetSyncRun({ db: await resolveDb(db), kind, triggerSource: RUN_TRIGGER.ADMIN, requestedBy: req.user.adminId });
        // IDs and codes only.
        log.log(JSON.stringify({ event: "sheet_sync.run_requested", kind, runId: run.runId, created, adminId: req.user.adminId }));
        res.status(202).json({ run, alreadyActive: !created });
    };
    router.post("/test", request(RUN_KIND.TEST_CONNECTION));
    router.post("/run", request(RUN_KIND.RECONCILE));

    router.get("/runs/:runId", async (req, res) => {
        if (!isValidRunId(req.params.runId)) return res.status(400).json({ message: "Invalid run ID" });
        const run = await getSheetSyncRun({ db: await resolveDb(db), runId: req.params.runId });
        if (!run) return res.status(404).json({ message: "Run not found" });
        return res.json(run);
    });

    return router;
}
