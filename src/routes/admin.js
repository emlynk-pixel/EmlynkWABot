import express from "express";

import { createRequireActiveUser } from "../middleware/requireActiveUser.js";
import { requireRole, ROLES } from "../middleware/requireRole.js";
import { createApiRateLimiter } from "../middleware/apiRateLimiter.js";
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
import { getDailyReport, getMonthlyOverview, parseDailyReportQuery, parseMonthlyOverviewQuery } from "../services/adminReportService.js";
import { createUsersRouter } from "./users.js";
import { createSheetSyncSettingsRouter } from "./sheetSyncSettings.js";
import { resolveDb, resolveBucket } from "../utils/resolveClients.js";
import { deleteTemporaryDocument } from "../services/temporaryDataService.js";
import {
    addCallLog,
    CandidateError,
    createCandidate,
    createUploadTarget,
    finalizeUpload,
    getCandidate,
    resolveCandidatePassportId,
    isCandidateStage,
    isValidCandidateIdParam,
    listCallLogs,
    listCandidates,
    removeCandidateDocument,
    parseCallLogBody,
    parseCandidateBody,
    parseCandidateListQuery,
    parseFinalizeUploadBody,
    parseRemoveDocumentBody,
    parseStageBody,
    parseUploadTargetBody,
    updateCandidateDetails,
    updateStage,
} from "../services/candidateService.js";


// Quotes and non-ASCII characters are replaced so the header can't be broken.
function contentDisposition(fileName) {
    const safe = String(fileName ?? "document").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "document";
    return `inline; filename="${safe}"`;
}

// Phase 12 RBAC: role shorthand constants for this router.
// ANALYST: reads + review actions.
// MANAGER: full access except user management.
// ADMIN: full access including user management.
// REGISTRATION_DESK: only candidate registration.
const { ADMIN, MANAGER, ANALYST, REGISTRATION_DESK } = ROLES;
// The set of roles allowed for each endpoint tier.
const ALL_ACTIVE = [ADMIN, MANAGER, ANALYST];                   // overview, reports, etc
const REGISTRATION_UP = [ADMIN, MANAGER, ANALYST, REGISTRATION_DESK]; // candidate basic routes
const ANALYSTS_UP = [ADMIN, MANAGER, ANALYST];                  // analyst or above
const MANAGERS_UP = [ADMIN, MANAGER];                           // manager or above
const ADMINS_ONLY = [ADMIN];                                    // administrators only

// Admin dashboard API, mounted at /api/admin (Phase 10). Read-only except
// the review actions (approve, keep pending, remove from review) and the
// corrections (document type, client, police slip date); every change is
// audited. There is no reject action and no route that changes or deletes
// an audit entry, and nothing removes a pending item automatically.
// Every route needs a valid Supabase session of an ACTIVE application user. Responses hold client
// data, so browsers and proxies must not cache them.
// Phase 12: RBAC is enforced per-endpoint via requireRole.
// Errors: { message } or { message, errors: [{ field, message }] }; review
// action conflicts also carry a machine-readable { code }.
export function createAdminRouter({
    db,
    bucket,
    verifyAccessToken,
    authAdmin,
    requireAdmin = createRequireActiveUser({ db, verifyAccessToken }),
    apiLimiter = createApiRateLimiter(),
} = {}) {
    const router = express.Router();

    router.use(apiLimiter);

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

    // Monthly overview for one business month (Sri Lanka), default this month.
    router.get("/reports/monthly", requireRole(ALL_ACTIVE), async (req, res) => {
        const parsed = parseMonthlyOverviewQuery(req.query);
        if (parsed.errors) {
            return res.status(400).json({ message: "Invalid query parameters", errors: parsed.errors });
        }
        const client = await resolveDb(db);
        return res.json(await getMonthlyOverview({ db: client, month: parsed.params.month }));
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

    // ---------------------------------------------------------------- review actions (ANALYST and above)

    // Review actions. The acting user is the authenticated one (req.user), never the body.
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
            return action({ ...values, db: client, bucket: storage, admin: req.user, reviewId: req.params.reviewId });
        });
    };

    // PENDING: pending/ -> client folder, VERIFIED. DOCUMENT: REVIEW_REQUIRED -> VERIFIED.
    // A police slip is approved with its submitted date (entered, or confirmed if OCR read it).
    router.post("/review/:reviewId/approve", requireRole(ANALYSTS_UP), reviewAction(approveReviewItem, { reasonRequired: false, needsBucket: true, acceptsPoliceDate: true }));
    // Stays pending and in the queue; the reason is required.
    router.post("/review/:reviewId/keep-pending", requireRole(ANALYSTS_UP), reviewAction(keepReviewItemPending, { reasonRequired: true, needsBucket: false }));
    // Permanently deletes one waiting file and its record after an admin's
    // inspection; the reason is required. Only files in pending/.
    router.post("/review/:reviewId/remove", requireRole(ANALYSTS_UP), reviewAction(removeFromReview, { reasonRequired: true, needsBucket: true }));
    // H3: a failed submission (failed-<id>) is processed again by the
    // background worker; the reason is optional. Audited.
    router.post("/review/:reviewId/retry", requireRole(ANALYSTS_UP), reviewAction(retryFailedSubmission, { reasonRequired: false, needsBucket: true }));

    // M4 Policy B: a waiting file of a type the client already has VERIFIED
    // (pending-<id> only). Replace names the existing document explicitly
    // (documentId in the body) and supersedes it; Keep as Version stores the
    // new file as a second, REVIEW_REQUIRED document. Both are audited and
    // never remove or overwrite the existing VERIFIED document.
    router.post("/review/:reviewId/replace-verified", requireRole(ANALYSTS_UP), reviewAction(replaceVerifiedDocument, { needsBucket: true, parse: parseReplaceVerifiedBody }));
    router.post("/review/:reviewId/keep-as-version", requireRole(ANALYSTS_UP), reviewAction(keepDocumentAsVersion, { reasonRequired: false, needsBucket: true }));

    // Corrections of a waiting file; it stays pending and in the queue.
    router.post("/review/:reviewId/document-type", requireRole(ANALYSTS_UP), reviewAction(setDocumentType, { needsBucket: false, parse: parseSetDocumentTypeBody }));
    router.post("/review/:reviewId/assign-client", requireRole(ANALYSTS_UP), reviewAction(assignClient, { needsBucket: false, parse: parseAssignClientBody }));

    // ---------------------------------------------------------------- temporary documents deletion (ANALYSTS_UP)
    
    // Manually delete a temporary document (e.g. from the Review Queue or Missing Documents).
    router.delete("/temporary-documents/:temporaryId", requireRole(ANALYSTS_UP), async (req, res) => {
        const { temporaryId } = req.params;
        if (!temporaryId || typeof temporaryId !== "string" || !/^[0-9a-fA-F-]+$/.test(temporaryId)) {
            return res.status(400).json({ message: "Invalid temporary document ID" });
        }
        
        try {
            await deleteTemporaryDocument(temporaryId, req.user, { db, bucket });
            return res.status(200).json({ action: "DELETE_TEMPORARY_DOCUMENT", temporaryId, deleted: true });
        } catch (error) {
            if (error.message === "Temporary document not found.") {
                return res.status(404).json({ message: "Temporary document not found." });
            }
            console.error("Failed to delete temporary document", { temporaryId, error });
            return res.status(500).json({ message: "An unexpected error occurred." });
        }
    });

    // ---------------------------------------------------------------- corrections (ADMIN only)

    // Sets or corrects a stored police slip's submitted date (audited).
    // This modifies a stored document (not just a pending item) so it is
    // reserved for ADMIN; a ANALYST can approve slips with a date but cannot
    // change a date after the fact.
    router.post("/documents/:documentId/police-date", requireRole(MANAGERS_UP), async (req, res) => {
        if (!isValidDocumentIdParam(req.params.documentId)) {
            return res.status(400).json({ message: "Invalid document ID", errors: [{ field: "documentId", message: "must be a document ID" }] });
        }
        const parsed = parsePoliceDateBody(req.body);
        return runAction(res, parsed, false, ({ client }) => setPoliceSubmittedDate({
            db: client, admin: req.user, documentId: req.params.documentId, reason: parsed.reason, policeSubmittedDate: parsed.policeSubmittedDate,
        }));
    });

    // ---------------------------------------------------------------- candidates (Admin > Candidates)
    // Reads for every active admin; registration, details, stages, uploads
    // and call notes for ANALYST and above. Audited where documents change.

    const invalidCandidateId = (res) => res.status(400).json({
        message: "Invalid passport ID",
        errors: [{ field: "passportId", message: "must be letters and digits (at most 20)" }],
    });
    // Runs a candidate action; CandidateError becomes { message, code } with its status.
    const candidateAction = async (res, run) => {
        try {
            return await run();
        } catch (error) {
            if (error instanceof CandidateError) {
                return res.status(error.status).json({ message: error.message, code: error.code, ...(error.passportId ? { passportId: error.passportId } : {}) });
            }
            throw error;
        }
    };
    // The stored passport ID for the one in the URL, resolved like the GET
    // below (exact, else the single case-insensitive match; never a guess
    // between two rows). Every candidate action runs on the stored ID.
    const storedCandidateId = async (client, requested) => {
        const passportId = await resolveCandidatePassportId({ db: client, passportId: requested });
        if (!passportId) throw new CandidateError(404, "NOT_FOUND", "Candidate not found");
        return passportId;
    };

    router.get("/candidates", requireRole(REGISTRATION_UP), async (req, res) => {
        const parsed = parseCandidateListQuery(req.query);
        if (parsed.errors) {
            return res.status(400).json({ message: "Invalid query parameters", errors: parsed.errors });
        }
        const client = await resolveDb(db);
        return res.json(await listCandidates({ db: client, params: parsed.params }));
    });

    router.post("/candidates", requireRole(REGISTRATION_UP), async (req, res) => {
        const parsed = parseCandidateBody(req.body, { creating: true });
        if (parsed.errors) {
            return res.status(400).json({ message: "Invalid request body", errors: parsed.errors });
        }
        const client = await resolveDb(db);
        return candidateAction(res, async () => res.status(201).json(await createCandidate({ db: client, values: parsed.values, actor: req.user })));
    });

    router.get("/candidates/:passportId", requireRole(REGISTRATION_UP), async (req, res) => {
        if (!isValidCandidateIdParam(req.params.passportId)) return invalidCandidateId(res);
        const client = await resolveDb(db);
        // Also the registration lookup: the response carries the stored passport ID.
        const passportId = await resolveCandidatePassportId({ db: client, passportId: req.params.passportId });
        const candidate = passportId && await getCandidate({ db: client, passportId });
        if (!candidate) return res.status(404).json({ message: "Candidate not found" });
        return res.json(candidate);
    });

    router.put("/candidates/:passportId", requireRole(REGISTRATION_UP), async (req, res) => {
        if (!isValidCandidateIdParam(req.params.passportId)) return invalidCandidateId(res);
        const parsed = parseCandidateBody(req.body, { creating: false });
        if (parsed.errors) {
            return res.status(400).json({ message: "Invalid request body", errors: parsed.errors });
        }
        const client = await resolveDb(db);
        return candidateAction(res, async () => res.json(await updateCandidateDetails({
            db: client, actor: req.user, passportId: await storedCandidateId(client, req.params.passportId), values: parsed.values,
        })));
    });

    router.put("/candidates/:passportId/stages/:stage", requireRole(ANALYSTS_UP), async (req, res) => {
        if (!isValidCandidateIdParam(req.params.passportId)) return invalidCandidateId(res);
        if (!isCandidateStage(req.params.stage)) return res.status(404).json({ message: "Stage not found" });
        const parsed = parseStageBody(req.body, req.params.stage);
        if (parsed.errors) {
            return res.status(400).json({ message: "Invalid request body", errors: parsed.errors });
        }
        const client = await resolveDb(db);
        return candidateAction(res, async () => res.json(await updateStage({
            db: client, passportId: await storedCandidateId(client, req.params.passportId), stage: req.params.stage, values: parsed.values, actor: req.user,
        })));
    });

    // Document uploads: the browser sends the file straight to storage, never
    // to this API (candidateService.js, "direct uploads"). Both requests are
    // small JSON bodies (express.json in createApp.js); no route here parses
    // a file body.
    router.post("/candidates/:passportId/documents/upload-target", requireRole(ANALYSTS_UP), async (req, res) => {
        if (!isValidCandidateIdParam(req.params.passportId)) return invalidCandidateId(res);
        const parsed = parseUploadTargetBody(req.body);
        if (parsed.errors) {
            return res.status(400).json({ message: "Invalid request body", errors: parsed.errors });
        }
        const [client, storage] = await Promise.all([resolveDb(db), resolveBucket(bucket)]);
        return candidateAction(res, async () => res.json(await createUploadTarget({
            db: client,
            bucket: storage,
            passportId: await storedCandidateId(client, req.params.passportId),
            documentType: parsed.values.documentType,
            mimeType: parsed.values.mimeType,
            fileSize: parsed.values.fileSize,
        })));
    });

    router.post("/candidates/:passportId/documents/finalize", requireRole(ANALYSTS_UP), async (req, res) => {
        if (!isValidCandidateIdParam(req.params.passportId)) return invalidCandidateId(res);
        const parsed = parseFinalizeUploadBody(req.body);
        if (parsed.errors) {
            return res.status(400).json({ message: "Invalid request body", errors: parsed.errors });
        }
        const [client, storage] = await Promise.all([resolveDb(db), resolveBucket(bucket)]);
        return candidateAction(res, async () => res.json(await finalizeUpload({
            db: client,
            bucket: storage,
            admin: req.user,
            passportId: await storedCandidateId(client, req.params.passportId),
            ...parsed.values,
        })));
    });

    // Removes the candidate's current document of a type: record and file,
    // with a required reason, audited (like Remove from Review).
    router.post("/candidates/:passportId/documents/:documentId/remove", requireRole(ANALYSTS_UP), async (req, res) => {
        if (!isValidCandidateIdParam(req.params.passportId)) return invalidCandidateId(res);
        if (!isValidDocumentIdParam(req.params.documentId)) {
            return res.status(400).json({ message: "Invalid document ID", errors: [{ field: "documentId", message: "must be a document ID" }] });
        }
        const parsed = parseRemoveDocumentBody(req.body);
        if (parsed.errors) {
            return res.status(400).json({ message: "Invalid request body", errors: parsed.errors });
        }
        const [client, storage] = await Promise.all([resolveDb(db), resolveBucket(bucket)]);
        return candidateAction(res, async () => res.json(await removeCandidateDocument({
            db: client,
            bucket: storage,
            admin: req.user,
            passportId: await storedCandidateId(client, req.params.passportId),
            documentId: req.params.documentId,
            reason: parsed.values.reason,
        })));
    });

    router.get("/candidates/:passportId/call-logs", requireRole(ALL_ACTIVE), async (req, res) => {
        if (!isValidCandidateIdParam(req.params.passportId)) return invalidCandidateId(res);
        const client = await resolveDb(db);
        return candidateAction(res, async () => res.json(await listCallLogs({ db: client, passportId: await storedCandidateId(client, req.params.passportId) })));
    });

    router.post("/candidates/:passportId/call-logs", requireRole(ANALYSTS_UP), async (req, res) => {
        if (!isValidCandidateIdParam(req.params.passportId)) return invalidCandidateId(res);
        const parsed = parseCallLogBody(req.body);
        if (parsed.errors) {
            return res.status(400).json({ message: "Invalid request body", errors: parsed.errors });
        }
        const client = await resolveDb(db);
        return candidateAction(res, async () => res.status(201).json(await addCallLog({
            db: client, admin: req.user, passportId: await storedCandidateId(client, req.params.passportId), values: parsed.values,
        })));
    });

    // ---------------------------------------------------------------- users (ADMIN only)
    router.use("/users", createUsersRouter({ db, authAdmin }));

    // ---------------------------------------------------------------- settings: Google Sheet Sync (ADMIN only)
    // Reads PostgreSQL and records run requests; never calls Google.
    router.use("/settings/sheet-sync", requireRole(ADMINS_ONLY), createSheetSyncSettingsRouter({ db }));

    // Anything else under /api/admin (only reached by an authenticated admin).
    router.use((req, res) => res.status(404).json({ message: "Not found" }));

    return router;
}
