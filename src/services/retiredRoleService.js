// Converting accounts that still hold a retired role (requireRole.js RETIRED_ROLES) to a supported
// one: scripts/migrateManagerRole.js, Docs/ROLES_AND_PERMISSIONS.md ("Retired MANAGER role").
//
// An account with a retired role can't use the application (requireActiveUser.js answers 403
// ROLE_NOT_SUPPORTED, and no route tier admits it), so every such account, whatever its status
// (an INVITED one would otherwise become ACTIVE with that role), is converted before or when the
// role is retired. The business decision for MANAGER: ADMIN already holds everything a MANAGER
// could do, so a MANAGER becomes an ADMIN.
//
// The conversion is done in one transaction, as the OWNER (the only role that may change an
// account holding a retired role, requireRole.js canManageAccount), with one UPDATE_USER_ROLE
// audit entry per account, the same entry Change Roles writes. Only the rows still holding the
// retired role are changed: running it again changes nothing.

import crypto from "node:crypto";

import { RETIRED_ROLES, ROLES, isValidRole } from "../middleware/requireRole.js";
import { USER_STATUS } from "../middleware/requireActiveUser.js";

export const DEFAULT_REPLACEMENT_ROLE = Object.freeze({ [RETIRED_ROLES.MANAGER]: ROLES.ADMIN });

export class RetiredRoleError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "RetiredRoleError";
        this.code = code;
    }
}

const isRetiredRole = (role) => Object.values(RETIRED_ROLES).includes(role);

// The accounts holding `retiredRole` (IDs and statuses only: nothing personal is printed).
export async function findRetiredRoleAccounts({ db, retiredRole }) {
    if (!isRetiredRole(retiredRole)) throw new RetiredRoleError("NOT_RETIRED", "Not a retired role");
    return db.user.findMany({ where: { role: retiredRole }, select: { adminId: true, status: true }, orderBy: { adminId: "asc" } });
}

// Converts every account holding `retiredRole` to `replacementRole`, as the ACTIVE OWNER `actorId`.
// Returns the converted accounts ({ adminId, status }).
export async function convertRetiredRole({ db, retiredRole, replacementRole, actorId }) {
    if (!isRetiredRole(retiredRole)) throw new RetiredRoleError("NOT_RETIRED", "Not a retired role");
    // Never the OWNER role (set in the database only, Docs/OWNER_ROLE.md), never another retired one.
    if (!isValidRole(replacementRole) || replacementRole === ROLES.OWNER) {
        throw new RetiredRoleError("INVALID_ROLE", "The replacement must be a supported role other than OWNER");
    }
    return db.$transaction(async (tx) => {
        const actor = await tx.user.findUnique({ where: { adminId: String(actorId ?? "") } });
        if (actor?.role !== ROLES.OWNER || actor.status !== USER_STATUS.ACTIVE) {
            throw new RetiredRoleError("OWNER_REQUIRED", "The conversion runs as the ACTIVE OWNER account (--owner <admin_id>)");
        }
        if (typeof tx.$queryRaw === "function") {
            await tx.$queryRaw`SELECT "admin_id" FROM "user" WHERE "role" = ${retiredRole} ORDER BY "admin_id" FOR UPDATE`;
        }
        const accounts = await tx.user.findMany({ where: { role: retiredRole }, select: { adminId: true, status: true }, orderBy: { adminId: "asc" } });
        for (const account of accounts) {
            await tx.user.update({ where: { adminId: account.adminId }, data: { role: replacementRole } });
            await tx.auditLog.create({
                data: {
                    auditId: crypto.randomUUID(),
                    adminId: actor.adminId,
                    action: "UPDATE_USER_ROLE",
                    previousStatus: retiredRole,
                    newStatus: replacementRole,
                    reason: `Retired role ${retiredRole} converted for user ${account.adminId}`,
                    previousValue: retiredRole,
                    newValue: replacementRole,
                },
            });
        }
        return accounts;
    });
}
