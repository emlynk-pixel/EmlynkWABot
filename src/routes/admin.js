import express from "express";

import { createRequireActiveAdmin } from "../middleware/requireActiveAdmin.js";
import { requireRole, ADMIN_ROLES } from "../middleware/requireRole.js";
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
    retryFailedSubmission,
    replaceVerifiedDocument,
    keepDocumentAsVersion,
    parseReviewActionBody,
    parseReplaceVerifiedBody,
    ReviewActionError,
} from "../services/adminReviewActionService.js";
import { listPoliceWorkflow, parsePoliceListQuery } from "../services/adminPoliceService.js";
import {
    listClients,
    listMissingDocuments,
    parseClientListQuery,
    parseMissingDocumentsQuery,
} from "../services/adminClientService.js";
import {
    assignClient,
    isValidDocumentIdParam,
    parseAssignClientBody,
    parsePoliceDateBody,
    parseSetDocumentTypeBody,
    setDocumentType,
    setPoliceSubmittedDate,
} from "../services/adminCorrectionService.js";
import { getDailyReport, parseDailyReportQuery } from "../services/adminReportService.js";

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

// Phase 12 RBAC: role shorthand constants for this router.
// VIEWER: read-only endpoints (GET). REVIEWER: reads + review actions.
// ADMIN: full access including police-date corrections.
const { ADMIN, REVIEWER, VIEWER } = ADMIN_ROLES;
// The set of roles allowed for each endpoint tier.
const ALL_ACTIVE = [ADMIN, REVIEWER, VIEWER];  // any active admin
const REVIEWERS_UP = [ADMIN, REVIEWER];          // reviewer or above
const ADMINS_ONLY = [ADMIN];                     // administrators only

// Admin dashboard API, mounted at /api/admin (Phase 10). Read-only except
// the review actions (approve, keep pending, remove from review) and the
// corrections (document type, client, police slip date); every change is
// audited. There is no reject action and no route that changes or deletes
// an audit entry, and nothing removes a pending item automatically.
// Every route needs a valid token of an ACTIVE admin. Responses hold client
// data, so browsers and proxies must not cache them.
// Phase 12: RBAC is enforced per-endpoint via requireRole.
// Errors: { message } or { message, errors: [{ field, message }] }; review
// action conflicts also carry a machine-readable { code }.
export function createAdminRouter({ db, bucket, requireAdmin = createRequireActiveAdmin({ db }) } = {}) {
    const router = express.Router();

    router.use((req, res, next) => {
        res.set("Cache-Control", "no-store");
        next();
    });
    router.use(requireAdmin);

    // ---------------------------------------------------------------- read-only (VIEWER and above)

    router.get("/overview", requireRole(ALL_ACTIVE), async (req, res) => {
        const client = await resolveDb(db);
        res.json(await getOverview({ db: client }));
    });

    // Incomplete clients and their missing required documents. Registered
    // before /documents so "missing" is never read as a parameter.
    router.get("/documents/missing", requireRole(ALL_ACTIVE), async (req, res) => {
        const parsed = parseMissingDocumentsQuery(req.query);
        if (parsed.errors) {
            return res.status(400).json({ message: "Invalid query parameters", errors: parsed.errors });
        }
        const client = await resolveDb(db);
        return res.json(await listMissingDocuments({ db: client, params: parsed.params }));
    });

    router.get("/documents", requireRole(ALL_ACTIVE), async (req, res) => {
        const parsed = parseDocumentListQuery(req.query);
        if (parsed.errors) {
            return res.status(400).json({ message: "Invalid query parameters", errors: parsed.errors });
        }
        const client = await resolveDb(db);
        return res.json(await listDocuments({ db: client, params: parsed.params }));
    });

    // Clients directory: search, complete/incomplete, missing type.
    router.get("/clients", requireRole(ALL_ACTIVE), async (req, res) => {
        const parsed = parseClientListQuery(req.query);
        if (parsed.errors) {
            return res.status(400).json({ message: "Invalid query parameters", errors: parsed.errors });
        }
        const client = await resolveDb(db);
        return res.json(await listClients({ db: client, params: parsed.params }));
    });

    // Daily report for one business day (Sri Lanka), default today.
    router.get("/reports/daily", requireRole(ALL_ACTIVE), async (req, res) => {
        const parsed = parseDailyReportQuery(req.query);
        if (parsed.errors) {
            return res.status(400).json({ message: "Invalid query parameters", errors: parsed.errors });
        }
        const client = await resolveDb(db);
        return res.json(await getDailyReport({ db: client, date: parsed.params.date }));
    });

    router.get("/clients/:passportId", requireRole(ALL_ACTIVE), async (req, res) => {
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

    router.get("/review", requireRole(ALL_ACTIVE), async (req, res) => {
        const parsed = parseReviewQueueQuery(req.query);
        if (parsed.errors) {
            return res.status(400).json({ message: "Invalid query parameters", errors: parsed.errors });
        }
        const client = await resolveDb(db);
        return res.json(await listReviewQueue({ db: client, params: parsed.params }));
    });

    // Police Workflow: every client's 21-day status, calculated (read-only).
    router.get("/police", requireRole(ALL_ACTIVE), async (req, res) => {
        const parsed = parsePoliceListQuery(req.query);
        if (parsed.errors) {
            return res.status(400).json({ message: "Invalid query parameters", errors: parsed.errors });
        }
        const client = await resolveDb(db);
        return res.json(await listPoliceWorkflow({ db: client, params: parsed.params }));
    });

    const invalidReviewId = (res) => res.status(400).json({
        message: "Invalid review ID",
        errors: [{ field: "reviewId", message: "must be pending-<id>, document-<id> or failed-<id>" }],
    });

    router.get("/review/:reviewId", requireRole(ALL_ACTIVE), async (req, res) => {
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
    router.get("/review/:reviewId/file", requireRole(ALL_ACTIVE), async (req, res) => {
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

    // ---------------------------------------------------------------- review actions (REVIEWER and above)

    // Review actions. The admin comes from the token (req.admin), never the body.
    // `parse` validates the body and returns the action's arguments or { errors }.
    const runAction = async (res, parsed, needsBucket, run) => {
        if (parsed.errors) {
            return res.status(400).json({ message: "Invalid request body", errors: parsed.errors });
        }
        const [client, storage] = await Promise.all([resolveDb(db), needsBucket ? resolveBucket(bucket) : null]);
        try {
            return res.json(await run({ client, storage }));
        } catch (error) {
            if (error instanceof ReviewActionError) {
                return res.status(error.status).json({ message: error.message, code: error.code });
            }
            throw error;
        }
    };
    const reviewAction = (action, { reasonRequired, needsBucket, acceptsPoliceDate = false, parse }) => async (req, res) => {
        if (!parseReviewId(req.params.reviewId)) return invalidReviewId(res);
        const parsed = parse ? parse(req.body) : parseReviewActionBody(req.body, { reasonRequired, acceptsPoliceDate });
        return runAction(res, parsed, needsBucket, ({ client, storage }) => {
            const { errors, ...values } = parsed;
            return action({ ...values, db: client, bucket: storage, admin: req.admin, reviewId: req.params.reviewId });
        });
    };

    // PENDING: pending/ -> client folder, VERIFIED. DOCUMENT: REVIEW_REQUIRED -> VERIFIED.
    // A police slip is approved with its submitted date (entered, or confirmed if OCR read it).
    router.post("/review/:reviewId/approve", requireRole(REVIEWERS_UP), reviewAction(approveReviewItem, { reasonRequired: false, needsBucket: true, acceptsPoliceDate: true }));
    // Stays pending and in the queue; the reason is required.
    router.post("/review/:reviewId/keep-pending", requireRole(REVIEWERS_UP), reviewAction(keepReviewItemPending, { reasonRequired: true, needsBucket: false }));
    // Permanently deletes one waiting file and its record after an admin's
    // inspection; the reason is required. Only files in pending/.
    router.post("/review/:reviewId/remove", requireRole(REVIEWERS_UP), reviewAction(removeFromReview, { reasonRequired: true, needsBucket: true }));
    // H3: a failed submission (failed-<id>) is processed again by the
    // background worker; the reason is optional. Audited.
    router.post("/review/:reviewId/retry", requireRole(REVIEWERS_UP), reviewAction(retryFailedSubmission, { reasonRequired: false, needsBucket: true }));

    // M4 Policy B: a waiting file of a type the client already has VERIFIED
    // (pending-<id> only). Replace names the existing document explicitly
    // (documentId in the body) and supersedes it; Keep as Version stores the
    // new file as a second, REVIEW_REQUIRED document. Both are audited and
    // never remove or overwrite the existing VERIFIED document.
    router.post("/review/:reviewId/replace-verified", requireRole(REVIEWERS_UP), reviewAction(replaceVerifiedDocument, { needsBucket: true, parse: parseReplaceVerifiedBody }));
    router.post("/review/:reviewId/keep-as-version", requireRole(REVIEWERS_UP), reviewAction(keepDocumentAsVersion, { reasonRequired: false, needsBucket: true }));

    // Corrections of a waiting file; it stays pending and in the queue.
    router.post("/review/:reviewId/document-type", requireRole(REVIEWERS_UP), reviewAction(setDocumentType, { needsBucket: false, parse: parseSetDocumentTypeBody }));
    router.post("/review/:reviewId/assign-client", requireRole(REVIEWERS_UP), reviewAction(assignClient, { needsBucket: false, parse: parseAssignClientBody }));

    // ---------------------------------------------------------------- corrections (ADMIN only)

    // Sets or corrects a stored police slip's submitted date (audited).
    // This modifies a stored document (not just a pending item) so it is
    // reserved for ADMIN; a REVIEWER can approve slips with a date but cannot
    // change a date after the fact.
    router.post("/documents/:documentId/police-date", requireRole(ADMINS_ONLY), async (req, res) => {
        if (!isValidDocumentIdParam(req.params.documentId)) {
            return res.status(400).json({ message: "Invalid document ID", errors: [{ field: "documentId", message: "must be a document ID" }] });
        }
        const parsed = parsePoliceDateBody(req.body);
        return runAction(res, parsed, false, ({ client }) => setPoliceSubmittedDate({
            db: client, admin: req.admin, documentId: req.params.documentId, reason: parsed.reason, policeSubmittedDate: parsed.policeSubmittedDate,
        }));
    });

    // Anything else under /api/admin (only reached by an authenticated admin).
    router.use((req, res) => res.status(404).json({ message: "Not found" }));

    return router;
}
