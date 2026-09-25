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
    getReviewItem,
    getReviewFile,
    parseReviewQueueQuery,
    parseReviewId,
} from "../services/adminReviewService.js";

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

// Read-only admin dashboard API, mounted at /api/admin (Phase 10).
// Every route needs a valid token of an ACTIVE admin. Responses hold client
// data, so browsers and proxies must not cache them.
// Errors: { message } or { message, errors: [{ field, message }] }.
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

    const invalidReviewId = (res) => res.status(400).json({
        message: "Invalid review ID",
        errors: [{ field: "reviewId", message: "must be pending-<id> or document-<id>" }],
    });

    router.get("/review/:reviewId", async (req, res) => {
        if (!parseReviewId(req.params.reviewId)) return invalidReviewId(res);
        const client = await resolveDb(db);
        const item = await getReviewItem({ db: client, reviewId: req.params.reviewId });
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

    // Anything else under /api/admin (only reached by an authenticated admin).
    router.use((req, res) => res.status(404).json({ message: "Not found" }));

    return router;
}
