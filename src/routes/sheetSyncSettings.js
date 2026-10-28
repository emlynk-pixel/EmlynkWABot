// Settings -> Google Sheet Sync API, mounted at /api/admin/settings/sheet-sync
// (Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md, Section 13).
//
//   GET  /status          integration state, queue counts, last runs
//   POST /test            Test Connection: durable TEST_CONNECTION run -> 202
//   POST /run             Sync Now: durable RECONCILE run -> 202
//   GET  /runs/:runId     one run's status and result
//   PUT  /destination     Sync Destination: ask to switch to another
//                         configured Sheet { key } -> 202 (pending until the
//                         worker validated it) or 200 (already active)
//   /import/...           Update Sheet: the bulk candidate import (routes/candidateImport.js)
//
// Roles, enforced here by requireRole (the role is re-read from the database
// for every request by requireActiveUser), on top of the admin router's
// Supabase-session authentication and rate limiting (no cookie authenticates a
// request, so CSRF does not apply; Docs/SUPABASE_AUTH.md):
//   ADMIN    everything
//   MANAGER  reads the status and runs, and uses Update Sheet; Test Connection,
//            Sync Now and the destination switch stay ADMIN only
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
import { DestinationSwitchError, getSheetSyncRun, getSheetSyncStatus, isValidRunId, requestDestinationSwitch, requestSheetSyncRun } from "../services/sheetSyncStatusService.js";
import { isValidDestinationKey } from "../config/sheetSync.js";
import { createCandidateImportRouter } from "./candidateImport.js";

const ADMINS_ONLY = [ROLES.ADMIN];
// Who opens Settings -> Google Sheet Sync at all.
export const SHEET_SYNC_AREA_ROLES = Object.freeze([ROLES.ADMIN, ROLES.MANAGER]);

export function createSheetSyncSettingsRouter({ db, log = console } = {}) {
    const router = express.Router();
    router.use(requireRole(SHEET_SYNC_AREA_ROLES));

    // Update Sheet (ADMIN and MANAGER; its own router checks the roles again).
    router.use("/import", createCandidateImportRouter({ db, log }));

    router.get("/status", async (req, res) => {
        res.json(await getSheetSyncStatus({ db: await resolveDb(db) }));
    });

    const request = (kind) => async (req, res) => {
        const { run, created } = await requestSheetSyncRun({ db: await resolveDb(db), kind, triggerSource: RUN_TRIGGER.ADMIN, requestedBy: req.user.adminId });
        // IDs and codes only.
        log.log(JSON.stringify({ event: "sheet_sync.run_requested", kind, runId: run.runId, created, adminId: req.user.adminId }));
        res.status(202).json({ run, alreadyActive: !created });
    };
    router.post("/test", requireRole(ADMINS_ONLY), request(RUN_KIND.TEST_CONNECTION));
    router.post("/run", requireRole(ADMINS_ONLY), request(RUN_KIND.RECONCILE));

    router.put("/destination", requireRole(ADMINS_ONLY), async (req, res) => {
        const key = req.body?.key;
        if (!isValidDestinationKey(key)) {
            return res.status(400).json({ message: "Invalid request body", errors: [{ field: "key", message: "must be a configured destination key" }] });
        }
        try {
            const result = await requestDestinationSwitch({ db: await resolveDb(db), key, requestedBy: req.user.adminId });
            log.log(JSON.stringify({ event: "sheet_sync.destination_requested", destinationKey: key, status: result.status, runId: result.run?.runId ?? null, adminId: req.user.adminId }));
            return res.status(result.status === "PENDING" ? 202 : 200).json(result);
        } catch (error) {
            if (error instanceof DestinationSwitchError) return res.status(error.status).json({ message: error.message, code: error.code });
            throw error;
        }
    });

    router.get("/runs/:runId", async (req, res) => {
        if (!isValidRunId(req.params.runId)) return res.status(400).json({ message: "Invalid run ID" });
        const run = await getSheetSyncRun({ db: await resolveDb(db), runId: req.params.runId });
        if (!run) return res.status(404).json({ message: "Run not found" });
        return res.json(run);
    });

    return router;
}
