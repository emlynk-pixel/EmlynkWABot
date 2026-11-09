// Settings -> Google Sheet Sync -> Update Sheet: the bulk candidate import API, mounted at
// /api/admin/settings/sheet-sync/import (candidateImportService.js).
//
//   GET  /source-columns            the allow-listed legacy headers the browser may send
//   POST /preview                   { fileName, headers, rows } -> counts, masked problem rows, importId
//                                   (writes nothing to a candidate table). Optional header
//                                   Idempotency-Key: the same key + file returns the same import; a file
//                                   already being committed gets 409 IMPORT_ALREADY_ACTIVE (+ details to resume)
//   GET  /active                    YOUR import that is committing now (at most one per administrator), for Resume / Abort
//   POST /:importId/chunks/:index   { rows } -> one previewed chunk committed (idempotent); 409
//                                   IMPORT_IN_PROGRESS while YOU have another import committing (other
//                                   administrators' imports do not matter: they run side by side)
//   POST /:importId/finish          totals, audit, and the existing RECONCILE run (idempotent)
//   GET  /recovery                  the automatic recovery of interrupted imports: in progress, needing attention,
//                                   committing now (states, counts, codes; importRecoveryService.js)
//   POST /:importId/heartbeat       the dialog's "still here" while committing (~20 s); 409 IMPORT_RECOVERY_STARTED
//                                   once the recovery has taken the import over. Never renews the commit lease.
//   POST /:importId/abort           stop on purpose, keep the rows imported so far (owner; any ADMIN if stale)
//   GET  /:importId/rollback/preview  what a rollback would do now (eligible / conflicts and why / missing / already
//                                   reverted); writes nothing. The administrator who ran the import, or an Owner.
//   POST /:importId/rollback        { confirm: true, expectedEligible } -> runs the rollback within a time budget and
//                                   answers the report; done = false means call again (a long import takes several
//                                   calls, each safe to repeat). 409 ROLLBACK_IN_PROGRESS while another call holds it.
//   GET  /:importId/rollback        the rollback's report (counts and codes only)
//   GET  /:importId                 the import's state (counts only)
//
// ADMIN only (an OWNER too; requireRole, the role is re-read from the database on every request).
// The workbook itself never reaches the server: the browser reads it and sends only the
// allow-listed columns. This router parses its own, larger JSON bodies (a preview of up to
// MAX_IMPORT_ROWS rows), and only after the admin router has authenticated the request; the
// app's global parser leaves these paths alone (createApp.js).
// Logs: event names, import IDs, counts and admin IDs only; never a row or a value.

import express from "express";
import { requireRole, ROLES } from "../middleware/requireRole.js";
import { resolveDb } from "../utils/resolveClients.js";
import {
    CandidateImportError, abortImport, commitChunk, finishImport, getActiveImport, getImport, importSourceColumns, isValidImportId, parseChunkBody, parsePreviewBody, previewImport, recordImportHeartbeat, updateImportJobGroups,
} from "../services/candidateImportService.js";
import { executeRollback, getRollback, previewRollback } from "../services/candidateImportRollback.js";
import { listImportRecoveries } from "../services/importRecoveryService.js";

export const CANDIDATE_IMPORT_ROLES = Object.freeze([ROLES.ADMIN]);
// A preview of MAX_IMPORT_ROWS allow-listed rows stays well under this (and under Vercel's 4.5 MB).
export const CANDIDATE_IMPORT_BODY_LIMIT = "4mb";

export function createCandidateImportRouter({ db, log = console } = {}) {
    const router = express.Router();
    router.use(requireRole(CANDIDATE_IMPORT_ROLES));
    router.use(express.json({ limit: CANDIDATE_IMPORT_BODY_LIMIT }));

    const fail = (res, error) => {
        if (error instanceof CandidateImportError) {
            return res.status(error.status).json({
                message: error.message, code: error.code, ...(error.missing ? { missing: error.missing } : {}), ...(error.errors ? { errors: error.errors } : {}),
                ...(error.details ? { details: error.details } : {}),
            });
        }
        throw error;
    };
    const event = (name, fields) => log.log(JSON.stringify({ event: `candidate_import.${name}`, ...fields }));

    router.get("/source-columns", (req, res) => res.json(importSourceColumns()));

    router.post("/preview", async (req, res) => {
        const parsed = parsePreviewBody(req.body);
        if (parsed.errors) return res.status(400).json({ message: "Invalid request body", errors: parsed.errors });
        try {
            const idempotencyKey = req.get("Idempotency-Key") ?? null;
            const result = await previewImport({ db: await resolveDb(db), actor: req.user, ...parsed.values, idempotencyKey });
            event("previewed", { importId: result.importId, adminId: req.user.adminId, rows: result.summary.totalRows, chunks: result.chunkCount });
            return res.json(result);
        } catch (error) {
            return fail(res, error);
        }
    });

    router.get("/active", async (req, res) => {
        try {
            return res.json(await getActiveImport({ db: await resolveDb(db), actor: req.user }));
        } catch (error) {
            return fail(res, error);
        }
    });

    // The automatic recovery of interrupted imports (importRecoveryService.js): what is being recovered, what needs an
    // administrator, the imports committing now. States, counts and codes only.
    router.get("/recovery", async (req, res) => {
        try {
            return res.json(await listImportRecoveries({ db: await resolveDb(db) }));
        } catch (error) {
            return fail(res, error);
        }
    });

    // The Upload dialog's "still here" while it commits (about every 20 s). Never renews the commit lease.
    router.post("/:importId/heartbeat", async (req, res) => {
        if (!isValidImportId(req.params.importId)) return res.status(400).json({ message: "Invalid import" });
        try {
            return res.json(await recordImportHeartbeat({ db: await resolveDb(db), actor: req.user, importId: req.params.importId }));
        } catch (error) {
            return fail(res, error);
        }
    });

    router.post("/:importId/abort", async (req, res) => {
        if (!isValidImportId(req.params.importId)) return res.status(400).json({ message: "Invalid import" });
        try {
            const result = await abortImport({ db: await resolveDb(db), actor: req.user, importId: req.params.importId });
            event("aborted", { importId: result.importId, status: result.status, ...result.counts, syncRunId: result.syncRunId, adminId: req.user.adminId });
            return res.json(result);
        } catch (error) {
            return fail(res, error);
        }
    });

    router.post("/:importId/chunks/:index", async (req, res) => {
        const index = Number(req.params.index);
        if (!isValidImportId(req.params.importId) || !/^\d{1,4}$/.test(req.params.index)) return res.status(400).json({ message: "Invalid import or chunk" });
        const parsed = parseChunkBody(req.body);
        if (parsed.errors) return res.status(400).json({ message: "Invalid request body", errors: parsed.errors });
        try {
            const result = await commitChunk({ db: await resolveDb(db), actor: req.user, importId: req.params.importId, chunkIndex: index, rows: parsed.values.rows });
            event("chunk_committed", { importId: req.params.importId, chunkIndex: index, status: result.status, ...result.counts, adminId: req.user.adminId });
            return res.json(result);
        } catch (error) {
            return fail(res, error);
        }
    });

    // The last two digits of the NEW Jobs this upload will create (importJobGroups.js), before the commit.
    router.put("/:importId/job-groups", async (req, res) => {
        if (!isValidImportId(req.params.importId)) return res.status(400).json({ message: "Invalid import" });
        try {
            return res.json(await updateImportJobGroups({ db: await resolveDb(db), actor: req.user, importId: req.params.importId, suffixes: req.body?.suffixes }));
        } catch (error) {
            return fail(res, error);
        }
    });

    router.post("/:importId/finish", async (req, res) => {
        if (!isValidImportId(req.params.importId)) return res.status(400).json({ message: "Invalid import" });
        try {
            const result = await finishImport({ db: await resolveDb(db), actor: req.user, importId: req.params.importId });
            event("finished", { importId: result.importId, status: result.status, ...result.counts, syncRunId: result.syncRunId, adminId: req.user.adminId });
            return res.json(result);
        } catch (error) {
            return fail(res, error);
        }
    });

    router.get("/:importId/rollback/preview", async (req, res) => {
        if (!isValidImportId(req.params.importId)) return res.status(400).json({ message: "Invalid import" });
        try {
            return res.json(await previewRollback({ db: await resolveDb(db), actor: req.user, importId: req.params.importId }));
        } catch (error) {
            return fail(res, error);
        }
    });

    router.get("/:importId/rollback", async (req, res) => {
        if (!isValidImportId(req.params.importId)) return res.status(400).json({ message: "Invalid import" });
        try {
            return res.json(await getRollback({ db: await resolveDb(db), actor: req.user, importId: req.params.importId }));
        } catch (error) {
            return fail(res, error);
        }
    });

    router.post("/:importId/rollback", async (req, res) => {
        if (!isValidImportId(req.params.importId)) return res.status(400).json({ message: "Invalid import" });
        const { confirm, expectedEligible } = req.body ?? {};
        if (confirm !== true) return res.status(400).json({ message: "Confirm the rollback to run it.", code: "CONFIRMATION_REQUIRED" });
        if (expectedEligible !== undefined && expectedEligible !== null && !Number.isSafeInteger(expectedEligible)) return res.status(400).json({ message: "expectedEligible must be a whole number." });
        try {
            const report = await executeRollback({ db: await resolveDb(db), actor: req.user, importId: req.params.importId, confirm: true, expectedEligible: expectedEligible ?? null });
            event("rollback_step", { importId: report.importId, status: report.status, done: report.done, ...report.counts, adminId: req.user.adminId });
            return res.json(report);
        } catch (error) {
            return fail(res, error);
        }
    });

    router.get("/:importId", async (req, res) => {
        if (!isValidImportId(req.params.importId)) return res.status(400).json({ message: "Invalid import" });
        try {
            return res.json(await getImport({ db: await resolveDb(db), actor: req.user, importId: req.params.importId }));
        } catch (error) {
            return fail(res, error);
        }
    });

    return router;
}
