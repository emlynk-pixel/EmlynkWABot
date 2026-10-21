// Role-based authorization. The role is public."user".role, loaded from the
// database on every request by requireActiveUser (never a token claim), so a
// role change applies to the next request.
//
//   ADMIN              everything, including user management and settings
//   MANAGER            everything except user management and settings
//   ANALYST            reads, review actions, corrections and candidate work;
//                      not police-date corrections on stored documents
//   REGISTRATION_DESK  the Candidates area only: list, lookup, registration,
//                      details, stages, candidate documents and call logs
//   JOB_HANDLER        manages Jobs, Agents and Clients; reads Candidates (list,
//                      details) and changes no candidate record; no dashboards,
//                      reports, review, Settings, Audit Logs or user management
//
// The per-route tiers are in routes/admin.js. A role outside the allowed list
// gets 403; the body never names the role or the user.

export const ROLES = Object.freeze({
    ADMIN: "ADMIN",
    MANAGER: "MANAGER",
    ANALYST: "ANALYST",
    REGISTRATION_DESK: "REGISTRATION_DESK",
    JOB_HANDLER: "JOB_HANDLER",
});

// The only values a role may be set to (public."user".role is TEXT, validated here).
export const ALL_ROLES = Object.freeze([ROLES.ADMIN, ROLES.MANAGER, ROLES.ANALYST, ROLES.REGISTRATION_DESK, ROLES.JOB_HANDLER]);

export const isValidRole = (value) => ALL_ROLES.includes(value);

// Who may invite whom (POST /api/admin/users/invite). ADMIN invites any role; MANAGER
// invites Job Handlers only (and nothing else of user management is a MANAGER's).
export const INVITABLE_ROLES = Object.freeze({
    [ROLES.ADMIN]: ALL_ROLES,
    [ROLES.MANAGER]: Object.freeze([ROLES.JOB_HANDLER]),
});
export const INVITER_ROLES = Object.freeze(Object.keys(INVITABLE_ROLES));
export const canInviteRole = (actorRole, role) => (INVITABLE_ROLES[actorRole] ?? []).includes(role);

const INSUFFICIENT_ROLE = Object.freeze({ message: "Insufficient permissions" });

export function requireRole(allowedRoles) {
    return (req, res, next) => {
        if (!req.user) {
            // Only reachable if requireActiveUser did not run first.
            return res.status(401).json({ message: "Invalid or Expired Token" });
        }
        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json(INSUFFICIENT_ROLE);
        }
        return next();
    };
}
