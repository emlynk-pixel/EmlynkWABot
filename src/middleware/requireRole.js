// Role-Based Authorization (Phase 12, Checkpoint 1).
//
// The proposal (§33) recommends three roles:
//   ADMIN    — full access: every read and every write action
//   REVIEWER — read access + review actions (approve/keep-pending/remove/retry/
//              replace-verified/keep-as-version/document-type/assign-client)
//              but NOT police-date corrections, which change stored documents
//              rather than waiting pending items
//   VIEWER   — read-only: GET requests only, no POSTs
//
// The role column already exists in the admins table (created in the initial
// migration). No new migration is needed. All existing accounts have role
// "ADMIN" (the default from scripts/createAdmin.js), so existing behaviour
// is fully preserved.
//
// The admin is always checked active before this middleware runs
// (requireActiveAdmin.js). If the role is not in the allowed list the request
// is refused with 403; the error body never names the role or admin details.

export const ADMIN_ROLES = Object.freeze({
    ADMIN: "ADMIN",
    REVIEWER: "REVIEWER",
    VIEWER: "VIEWER",
});

// Ordered by privilege (most privileged first). Used to validate role values
// when creating or updating admins.
export const ALL_ROLES = Object.freeze([
    ADMIN_ROLES.ADMIN,
    ADMIN_ROLES.REVIEWER,
    ADMIN_ROLES.VIEWER,
]);

const INSUFFICIENT_ROLE = { message: "Insufficient permissions" };

// Returns Express middleware that allows only requests whose admin (set by
// requireActiveAdmin) has one of the listed roles.
//
// Usage:
//   router.post("/sensitive", requireRole([ADMIN_ROLES.ADMIN]), handler);
export function requireRole(allowedRoles) {
    return (req, res, next) => {
        if (!req.admin) {
            // This should never happen if requireActiveAdmin runs first.
            return res.status(401).json({ message: "Invalid or Expired Token" });
        }
        if (!allowedRoles.includes(req.admin.role)) {
            return res.status(403).json(INSUFFICIENT_ROLE);
        }
        return next();
    };
}
