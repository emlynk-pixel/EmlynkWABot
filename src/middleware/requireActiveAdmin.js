import { authenticateAdmin } from "./auth.js";

// The only admin status that may use admin endpoints (same rule as login and
// GET /auth/me in src/routes/auth.js; admins.status is a plain string).
export const ACTIVE_ADMIN_STATUS = "ACTIVE";

const INVALID_TOKEN = { message: "Invalid or Expired Token" };

// Loaded lazily so tests can pass a fake client without touching the DB.
async function resolveDb(db) {
    return db ?? (await import("../config/prisma.js")).default;
}

// For /api/admin/*: a valid Bearer JWT (existing authenticateAdmin), and the
// admin it names must still exist and be ACTIVE. The token alone doesn't
// show a later deactivation, so the stored status is checked on every
// request, exactly as GET /auth/me does. Deleted and deactivated admins get
// the same 401 as a bad token, without saying which.
// On success req.admin is the stored profile (never the password hash).
export function createRequireActiveAdmin({ db } = {}) {
    const checkActive = async (req, res, next) => {
        const client = await resolveDb(db);
        const admin = await client.admin.findUnique({
            where: { adminId: req.admin.adminId },
            select: { adminId: true, email: true, name: true, role: true, status: true },
        });

        if (!admin || admin.status !== ACTIVE_ADMIN_STATUS) {
            return res.status(401).json(INVALID_TOKEN);
        }

        req.admin = admin;
        return next();
    };

    // Express 5 forwards a rejected promise (e.g. database down) to the error
    // handler, which answers a generic 500.
    return [authenticateAdmin, checkActive];
}
