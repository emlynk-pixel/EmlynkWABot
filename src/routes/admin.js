import express from "express";

import { createRequireActiveAdmin } from "../middleware/requireActiveAdmin.js";
import {
    getOverview,
    listDocuments,
    getClientDetails,
    parseDocumentListQuery,
    isValidPassportIdParam,
} from "../services/adminDashboardService.js";
import {
    listReviewQueue,
    getReviewFile,
    parseReviewQueueQuery,
    parseReviewId,
} from "../services/adminReviewService.js";
import {
    approveReviewItem,
    getReviewItemWithActions,
    keepReviewItemPending,
    removeFromReview,
    parseReviewActionBody,
    ReviewActionError,
} from "../services/adminReviewActionService.js";
import { listPoliceWorkflow, parsePoliceListQuery } from "../services/adminPoliceService.js";

// Loaded lazily so tests can pass a fake client without touching the DB.
async function resolveDb(db) {
    return db ?? (await import("../config/prisma.js")).default;
}

// The private bucket (service-role client on the server only).
async function resolveBucket(bucket) {
    if (bucket) return bucket;
    const { default: supabase } = await import("../config/supabase.js");
    return supabase.storage.from(process.env.SUPABASE_BUCKET);
}

// Quotes and non-ASCII characters are replaced so the header can't be broken.
function contentDisposition(fileName) {
    const safe = String(fileName ?? "document").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "document";
    return `inline; filename="${safe}"`;
}

// Admin dashboard API, mounted at /api/admin (Phase 10). Read-only except
// the review actions (approve, keep pending, remove from review); there is
// no reject action and no route that changes or deletes an audit entry.
// Every route needs a valid token of an ACTIVE admin. Responses hold client
// data, so browsers and proxies must not cache them.
// Errors: { message } or { message, errors: [{ field, message }] }; review
// action conflicts also carry a machine-readable { code }.
export function createAdminRouter({ db, bucket, requireAdmin = createRequireActiveAdmin({ db }) } = {}) {
    const router = express.Router();

    router.use((req, res, next) => {
        res.set("Cache-Control", "no-store");
        next();
    });
    router.use(requireAdmin);

    router.get("/overview", async (req, res) => {
        const client = await resolveDb(db);
        res.json(await getOverview({ db: client }));
    });

    router.get("/documents", async (req, res) => {
        const parsed = parseDocumentListQuery(req.query);
        if (parsed.errors) {
            return res.status(400).json({ message: "Invalid query parameters", errors: parsed.errors });
        }
        const client = await resolveDb(db);
        return res.json(await listDocuments({ db: client, params: parsed.params }));
    });

    router.get("/clients/:passportId", async (req, res) => {
        const { passportId } = req.params;
        if (!isValidPassportIdParam(passportId)) {
            return res.status(400).json({
                message: "Invalid passport ID",
                errors: [{ field: "passportId", message: "must be letters and digits (at most 20)" }],
            });
        }
        const client = await resolveDb(db);
        const details = await getClientDetails({ db: client, passportId });
        if (!details) {
            return res.status(404).json({ message: "Client not found" });
        }
        return res.json(details);
    });

    router.get("/review", async (req, res) => {
        const parsed = parseReviewQueueQuery(req.query);
        if (parsed.errors) {
            return res.status(400).json({ message: "Invalid query parameters", errors: parsed.errors });
        }
        const client = await resolveDb(db);
        return res.json(await listReviewQueue({ db: client, params: parsed.params }));
    });

    // Police Workflow: every client's 21-day status, calculated (read-only).
    router.get("/police", async (req, res) => {
        const parsed = parsePoliceListQuery(req.query);
        if (parsed.errors) {
            return res.status(400).json({ message: "Invalid query parameters", errors: parsed.errors });
        }
        const client = await resolveDb(db);
        return res.json(await listPoliceWorkflow({ db: client, params: parsed.params }));
    });

    const invalidReviewId = (res) => res.status(400).json({
        message: "Invalid review ID",
        errors: [{ field: "reviewId", message: "must be pending-<id> or document-<id>" }],
    });

    router.get("/review/:reviewId", async (req, res) => {
        if (!parseReviewId(req.params.reviewId)) return invalidReviewId(res);
        const client = await resolveDb(db);
        const item = await getReviewItemWithActions({ db: client, reviewId: req.params.reviewId });
        if (!item) return res.status(404).json({ message: "Review item not found" });
        return res.json(item);
    });

    // The item's file, streamed from private storage for the in-page preview.
    // The storage path comes from the database record, never the request, and
    // no storage URL or credential reaches the browser. The response is
    // sandboxed so a file opened directly can't run anything.
    router.get("/review/:reviewId/file", async (req, res) => {
        if (!parseReviewId(req.params.reviewId)) return invalidReviewId(res);
        const [client, storage] = await Promise.all([resolveDb(db), resolveBucket(bucket)]);
        const file = await getReviewFile({ db: client, bucket: storage, reviewId: req.params.reviewId });
        if (!file) return res.status(404).json({ message: "Review item not found" });
        if (file.unavailable) return res.status(502).json({ message: "The file could not be loaded from storage" });

        res.set({
            "Content-Type": file.mimeType,
            "Content-Length": String(file.buffer.length),
            "Content-Disposition": contentDisposition(file.fileName),
            "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
            "Cross-Origin-Resource-Policy": "same-origin",
        });
        return res.send(file.buffer);
    });

    // Review actions. The admin comes from the token (req.admin), never the body.
    const reviewAction = (action, { reasonRequired, needsBucket, acceptsPoliceDate = false }) => async (req, res) => {
        if (!parseReviewId(req.params.reviewId)) return invalidReviewId(res);
        const parsed = parseReviewActionBody(req.body, { reasonRequired, acceptsPoliceDate });
        if (parsed.errors) {
            return res.status(400).json({ message: "Invalid request body", errors: parsed.errors });
        }
        const [client, storage] = await Promise.all([resolveDb(db), needsBucket ? resolveBucket(bucket) : null]);
        try {
            const result = await action({
                db: client, bucket: storage, admin: req.admin, reviewId: req.params.reviewId,
                reason: parsed.reason, policeSubmittedDate: parsed.policeSubmittedDate,
            });
            return res.json(result);
        } catch (error) {
            if (error instanceof ReviewActionError) {
                return res.status(error.status).json({ message: error.message, code: error.code });
            }
            throw error;
        }
    };

    // PENDING: pending/ -> client folder, VERIFIED. DOCUMENT: REVIEW_REQUIRED -> VERIFIED.
    // A police slip is approved with its submitted date (entered, or confirmed if OCR read it).
    router.post("/review/:reviewId/approve", reviewAction(approveReviewItem, { reasonRequired: false, needsBucket: true, acceptsPoliceDate: true }));
    // Stays pending and in the queue; the reason is required.
    router.post("/review/:reviewId/keep-pending", reviewAction(keepReviewItemPending, { reasonRequired: true, needsBucket: false }));
    // Permanently deletes one waiting file and its record after an admin's
    // inspection; the reason is required. Only files in pending/.
    router.post("/review/:reviewId/remove", reviewAction(removeFromReview, { reasonRequired: true, needsBucket: true }));

    // Anything else under /api/admin (only reached by an authenticated admin).
    router.use((req, res) => res.status(404).json({ message: "Not found" }));

    return router;
}
