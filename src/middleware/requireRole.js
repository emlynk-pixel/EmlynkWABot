// Role-based authorization. The role is public."user".role, loaded from the
// database on every request by requireActiveUser (never a token claim), so a
// role change applies to the next request.
//
//   OWNER              the system owner (one, set in the database only): every
//                      ADMIN permission, plus managing ADMIN accounts (see
//                      "User management" below)
//   ADMIN              everything, including Settings, Work Allocation,
//                      verification and managing the roles below ADMIN; never
//                      another ADMIN or an OWNER
//   TEAM_LEAD          exactly seven areas, NOT every ADMIN permission: the
//                      Candidates area for every candidate, Need Attention, Work
//                      Allocation, Jobs, Agents, Clients and the standard Daily
//                      Report; no ADMIN-only action within them, no Settings, user
//                      management, Audit Logs, dashboards or review
//   ANALYST            reads, review actions, corrections and candidate work;
//                      not police-date corrections on stored documents
//   REGISTRATION_DESK  the Candidates area only: list, lookup, registration,
//                      details, stages, candidate documents and call logs
//   JOB_HANDLER        manages Jobs, Agents and Clients; reads Candidates (list,
//                      details) and changes no candidate record; no dashboards,
//                      reports, review, Settings, Audit Logs or user management
//
// The per-route tiers are in routes/admin.js. A role outside the allowed list
// gets 403; the body never names the role or the user. A retired role
// (RETIRED_ROLES) is in no tier, so an account still holding one is refused
// everywhere until it is converted (scripts/migrateManagerRole.js).

export const ROLES = Object.freeze({
    OWNER: "OWNER",
    ADMIN: "ADMIN",
    TEAM_LEAD: "TEAM_LEAD",
    ANALYST: "ANALYST",
    REGISTRATION_DESK: "REGISTRATION_DESK",
    JOB_HANDLER: "JOB_HANDLER",
});

// The only values a role may be set to (public."user".role is TEXT, validated here).
export const ALL_ROLES = Object.freeze([ROLES.OWNER, ROLES.ADMIN, ROLES.TEAM_LEAD, ROLES.ANALYST, ROLES.REGISTRATION_DESK, ROLES.JOB_HANDLER]);

export const isValidRole = (value) => ALL_ROLES.includes(value);

// Roles no longer supported. Never valid (isValidRole), never in a tier; named here only so the
// conversion script and the tests can find accounts that still hold one (Docs/ROLES_AND_PERMISSIONS.md).
// MANAGER: retired, ADMIN holds everything it could do.
export const RETIRED_ROLES = Object.freeze({ MANAGER: "MANAGER" });

// Whether `role` is in a tier. OWNER holds every ADMIN permission, so a tier that admits ADMIN
// admits OWNER too: the route tiers name ADMIN only. TEAM_LEAD inherits nothing: it is in a tier
// only where the tier names it. Every role check goes through here.
export const hasRole = (role, allowedRoles) => allowedRoles.includes(role) || (role === ROLES.OWNER && allowedRoles.includes(ROLES.ADMIN));

// User management (routes/users.js, services/userAccountService.js). An OWNER changes every
// account and gives every role except the OWNER's; an ADMIN changes, and gives, only the roles
// below ADMIN: never another ADMIN's account, never the ADMIN role. Nobody changes their own
// account there. The OWNER is set in the database only (Docs/OWNER_ROLE.md): no one gives the
// OWNER role, or changes or deactivates an OWNER account, through the application. Inviting
// (POST /api/admin/users/invite) follows the same lists: nobody invites an OWNER. TEAM_LEAD is
// below ADMIN (an ADMIN may give it) and manages no account itself.
const BELOW_ADMIN = Object.freeze([ROLES.TEAM_LEAD, ROLES.ANALYST, ROLES.REGISTRATION_DESK, ROLES.JOB_HANDLER]);
const BELOW_OWNER = Object.freeze([ROLES.ADMIN, ...BELOW_ADMIN]);
export const ASSIGNABLE_ROLES = Object.freeze({
    [ROLES.OWNER]: BELOW_OWNER,
    [ROLES.ADMIN]: BELOW_ADMIN,
});
export const USER_MANAGER_ROLES = Object.freeze(Object.keys(ASSIGNABLE_ROLES));
export const canAssignRole = (actorRole, role) => (ASSIGNABLE_ROLES[actorRole] ?? []).includes(role);
// The accounts an actor may change: never an OWNER's; otherwise those holding a role it may give
// (an OWNER: every other account, one with a retired role too).
export const canManageAccount = (actorRole, targetRole) => targetRole !== ROLES.OWNER && (actorRole === ROLES.OWNER || canAssignRole(actorRole, targetRole));

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
