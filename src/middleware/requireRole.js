// Role-based authorization. The role is public."user".role, loaded from the
// database on every request by requireActiveUser (never a token claim), so a
// role change applies to the next request.
//
//   OWNER              the system owner (one, set in the database only): every
//                      ADMIN permission, plus managing ADMIN accounts (see
//                      "User management" below)
//   ADMIN              everything, including Settings and managing the roles
//                      below ADMIN; never another ADMIN or an OWNER
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
    OWNER: "OWNER",
    ADMIN: "ADMIN",
    MANAGER: "MANAGER",
    ANALYST: "ANALYST",
    REGISTRATION_DESK: "REGISTRATION_DESK",
    JOB_HANDLER: "JOB_HANDLER",
});

// The only values a role may be set to (public."user".role is TEXT, validated here).
export const ALL_ROLES = Object.freeze([ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER, ROLES.ANALYST, ROLES.REGISTRATION_DESK, ROLES.JOB_HANDLER]);

export const isValidRole = (value) => ALL_ROLES.includes(value);

// Whether `role` is in a tier. OWNER holds every ADMIN permission, so a tier that admits ADMIN
// admits OWNER too: the route tiers name ADMIN only. Every role check goes through here.
export const hasRole = (role, allowedRoles) => allowedRoles.includes(role) || (role === ROLES.OWNER && allowedRoles.includes(ROLES.ADMIN));

// User management (routes/users.js, services/userAccountService.js). An OWNER changes every
// account and gives every role except the OWNER's; an ADMIN changes, and gives, only the roles
// below ADMIN: never another ADMIN's account, never the ADMIN role. Nobody changes their own
// account there. The OWNER is set in the database only (Docs/OWNER_ROLE.md): no one gives the
// OWNER role, or changes or deactivates an OWNER account, through the application.
const BELOW_ADMIN = Object.freeze([ROLES.MANAGER, ROLES.ANALYST, ROLES.REGISTRATION_DESK, ROLES.JOB_HANDLER]);
const BELOW_OWNER = Object.freeze([ROLES.ADMIN, ...BELOW_ADMIN]);
export const ASSIGNABLE_ROLES = Object.freeze({
    [ROLES.OWNER]: BELOW_OWNER,
    [ROLES.ADMIN]: BELOW_ADMIN,
});
export const USER_MANAGER_ROLES = Object.freeze(Object.keys(ASSIGNABLE_ROLES));
export const canAssignRole = (actorRole, role) => (ASSIGNABLE_ROLES[actorRole] ?? []).includes(role);
// The accounts an actor may change: never an OWNER's; otherwise those holding a role it may give
// (an OWNER: every other account, one with a legacy role too).
export const canManageAccount = (actorRole, targetRole) => targetRole !== ROLES.OWNER && (actorRole === ROLES.OWNER || canAssignRole(actorRole, targetRole));

// Who may invite whom (POST /api/admin/users/invite). OWNER invites any role but OWNER, ADMIN
// the roles below ADMIN, MANAGER Job Handlers only (and nothing else of user management is a
// MANAGER's). Nobody invites an OWNER.
export const INVITABLE_ROLES = Object.freeze({
    [ROLES.OWNER]: BELOW_OWNER,
    [ROLES.ADMIN]: BELOW_ADMIN,
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
        if (!hasRole(req.user.role, allowedRoles)) {
            return res.status(403).json(INSUFFICIENT_ROLE);
        }
        return next();
    };
}
