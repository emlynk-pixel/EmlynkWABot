import express from "express";

import { createRequireActiveAdmin } from "../middleware/requireActiveAdmin.js";
import {
    getOverview,
    listDocuments,
    getClientDetails,
    parseDocumentListQuery,
    isValidPassportIdParam,
} from "../services/adminDashboardService.js";

// Loaded lazily so tests can pass a fake client without touching the DB.
async function resolveDb(db) {
    return db ?? (await import("../config/prisma.js")).default;
}

// Read-only admin dashboard API, mounted at /api/admin (Phase 10).
// Every route needs a valid token of an ACTIVE admin. Responses hold client
// data, so browsers and proxies must not cache them.
// Errors: { message } or { message, errors: [{ field, message }] }.
export function createAdminRouter({ db, requireAdmin = createRequireActiveAdmin({ db }) } = {}) {
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

    // Anything else under /api/admin (only reached by an authenticated admin).
    router.use((req, res) => res.status(404).json({ message: "Not found" }));

    return router;
}
