// Settings -> Google Sheet Sync -> Update Sheet: the bulk candidate import API, mounted at
// /api/admin/settings/sheet-sync/import (candidateImportService.js).
//
//   GET  /source-columns            the allow-listed legacy headers the browser may send
//   POST /preview                   { fileName, headers, rows } -> counts, masked problem rows, importId
//                                   (writes nothing to a candidate table)
//   POST /:importId/chunks/:index   { rows } -> one previewed chunk committed (idempotent)
//   POST /:importId/finish          totals, audit, and the existing RECONCILE run
//   GET  /:importId                 the import's state (counts only)
//
// ADMIN and MANAGER only (requireRole; the role is re-read from the database on every request).
// The workbook itself never reaches the server: the browser reads it and sends only the
// allow-listed columns. This router parses its own, larger JSON bodies (a preview of up to
// MAX_IMPORT_ROWS rows), and only after the admin router has authenticated the request; the
// app's global parser leaves these paths alone (createApp.js).
// Logs: event names, import IDs, counts and admin IDs only; never a row or a value.

import express from "express";
import { requireRole, ROLES } from "../middleware/requireRole.js";
import { resolveDb } from "../utils/resolveClients.js";
import {
    CandidateImportError, commitChunk, finishImport, getImport, importSourceColumns, isValidImportId, parseChunkBody, parsePreviewBody, previewImport,
} from "../services/candidateImportService.js";

export const CANDIDATE_IMPORT_ROLES = Object.freeze([ROLES.ADMIN, ROLES.MANAGER]);
// A preview of MAX_IMPORT_ROWS allow-listed rows stays well under this (and under Vercel's 4.5 MB).
export const CANDIDATE_IMPORT_BODY_LIMIT = "4mb";

export function createCandidateImportRouter({ db, log = console } = {}) {
    const router = express.Router();
    router.use(requireRole(CANDIDATE_IMPORT_ROLES));
    router.use(express.json({ limit: CANDIDATE_IMPORT_BODY_LIMIT }));

    const fail = (res, error) => {
        if (error instanceof CandidateImportError) {
            return res.status(error.status).json({ message: error.message, code: error.code, ...(error.missing ? { missing: error.missing } : {}) });
        }
        throw error;
    };
    const event = (name, fields) => log.log(JSON.stringify({ event: `candidate_import.${name}`, ...fields }));

    router.get("/source-columns", (req, res) => res.json(importSourceColumns()));

    router.post("/preview", async (req, res) => {
        const parsed = parsePreviewBody(req.body);
        if (parsed.errors) return res.status(400).json({ message: "Invalid request body", errors: parsed.errors });
        try {
            const result = await previewImport({ db: await resolveDb(db), actor: req.user, ...parsed.values });
            event("previewed", { importId: result.importId, adminId: req.user.adminId, rows: result.summary.totalRows, chunks: result.chunkCount });
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
