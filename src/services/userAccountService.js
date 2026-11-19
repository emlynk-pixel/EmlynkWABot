// Application users (public."user"): listing, invitation, role and status.
// Supabase Auth owns every credential, session, invitation email and
// password; this service owns the application profile, its role and its
// status, and the audit trail. The caller (routes/users.js) has already
// checked the actor's role (OWNER or ADMIN); this service holds the finer rules
// (requireRole.js ASSIGNABLE_ROLES) and decides them on the database rows, never on the request:
//   - an OWNER changes any account but their own and an OWNER's; an ADMIN only accounts
//     below ADMIN, and gives only roles below ADMIN (403 otherwise, never a lesser role instead);
//   - nobody gives the OWNER role or changes an OWNER account here (403 OWNER_LOCKED): the
//     OWNER is set in the database only (Docs/OWNER_ROLE.md);
//   - a retired role (requireRole.js RETIRED_ROLES, e.g. MANAGER) is never given (400
//     INVALID_ROLE); an account still holding one is changed by an OWNER only.
// Each change re-reads the actor and the target inside its transaction, with their rows
// locked (lockUserRows), so a stale actor cannot get past these rules.
//
// Invite flow:
//   OWNER (ADMIN and below) or ADMIN (below ADMIN)
//     -> POST /api/admin/users/invite { email, name, role }
//     -> role validated here (never taken from Supabase user metadata)
//     -> Supabase Auth Admin inviteUserByEmail (Supabase sends the email)
//     -> public."user" upserted by email, linked by auth_user_id, INVITED
//   invitee -> Supabase invite link -> GET /auth/invitation (still valid?) -> sets a password
//     -> POST /auth/complete-invite -> INVITED becomes ACTIVE, activated_at set (completeInvitation)
//   If that last call never happens (network, closed tab, or the password was set through "Forgot
//   password"), the first PASSWORD sign-in completes it (activateOnPasswordSignIn, GET /auth/me).
//
// Re-inviting. "Set up" means activated_at is set: the person accepted an invitation with a password
// (or was provisioned). A confirmed Supabase identity is NOT proof of that: opening the invite link,
// or an email scanner pre-fetching it, confirms the address before any password exists.
//   no row / INVITED / INACTIVE, identity not confirmed   Supabase re-sends the invite; INVITED
//   INVITED / INACTIVE / no row, identity confirmed,      Supabase refuses a new invite (email_exists):
//     never set up                                        a password-setup email is sent instead; INVITED
//   INACTIVE, set up before                               reactivated (they have a password): ACTIVE
//   ACTIVE                                                refused (409)
// One row per email (unique) and per Supabase identity (unique), so two
// concurrent invites of one person converge on the same row.

import crypto from "node:crypto";

import { ALL_ROLES, ROLES, USER_MANAGER_ROLES, canAssignRole, canManageAccount, isValidRole } from "../middleware/requireRole.js";
import { USER_STATUS } from "../middleware/requireActiveUser.js";
import { AuthAdminError } from "../auth/supabaseAuthAdmin.js";

export const MAX_NAME_LENGTH = 100;
export const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class UserAccountError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = "UserAccountError";
        this.status = status;
        this.code = code;
    }
}

export const normalizeEmail = (email) => (typeof email === "string" ? email.trim().toLowerCase() : email);
export const isValidEmail = (email) => typeof email === "string" && email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email);

// What the users API returns: never the Supabase identity or anything secret.
export const toUserSummary = (user) => ({
    userId: user.adminId,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    createdDate: user.createdDate,
    // When the latest invitation email was sent (null: none); Supabase invitation links expire.
    invitedAt: user.invitedAt ?? null,
});

const forbidden = () => new UserAccountError(403, "FORBIDDEN", "Insufficient permissions");
const ownerRequired = () => new UserAccountError(403, "OWNER_REQUIRED", "Only an Owner can change an Admin account, or give the Admin role.");
const ownerLocked = () => new UserAccountError(403, "OWNER_LOCKED", "The Owner account and role can't be changed here.");

const assertUserManager = (actor) => {
    if (actor?.status !== USER_STATUS.ACTIVE || !USER_MANAGER_ROLES.includes(actor.role)) throw forbidden();
};

// Changing `target` (its status, or its role to `newRole`): never an OWNER account or the OWNER
// role; otherwise the target's current role, and the role it gets, must both be the actor's to
// give (an ADMIN: below ADMIN only).
const assertCanChange = (actor, target, newRole = null) => {
    assertUserManager(actor);
    if (target.role === ROLES.OWNER || newRole === ROLES.OWNER) throw ownerLocked();
    if (!canManageAccount(actor.role, target.role)) throw ownerRequired();
    if (newRole !== null && !canAssignRole(actor.role, newRole)) throw ownerRequired();
};

// Inviting (requireRole.js ASSIGNABLE_ROLES): OWNER may invite ADMIN and below, ADMIN the
// roles below ADMIN. Inviting an existing email updates its role and may reactivate it, so it
// is a change of that account: an OWNER may do it to any account but an OWNER's, an ADMIN to
// an account below ADMIN only.
const assertCanInvite = (actor, role, existing) => {
    assertUserManager(actor);
    if (!canAssignRole(actor.role, role)) throw forbidden();
    if (!existing || canManageAccount(actor.role, existing.role)) return;
    throw existing.role === ROLES.OWNER ? ownerLocked() : ownerRequired();
};

// Locks (SELECT ... FOR UPDATE) the actor's and the target's rows, in admin_id order (two
// changes never deadlock), then reads them again: the request's copy of the actor may be stale.
// A second transaction waits here for the first, then reads what it committed. Test fakes
// without raw queries skip the lock and read the rows.
async function lockUserRows(tx, { actorId, targetId = null, email = null }) {
    if (typeof tx.$queryRaw === "function") {
        await tx.$queryRaw`
            SELECT "admin_id" FROM "user"
            WHERE "admin_id" IN (${actorId}, ${targetId}) OR "email" = ${email}
            ORDER BY "admin_id"
            FOR UPDATE`;
    }
    const actor = await tx.user.findUnique({ where: { adminId: actorId } });
    const target = targetId ? await tx.user.findUnique({ where: { adminId: targetId } }) : email ? await tx.user.findUnique({ where: { email } }) : null;
    return { actor, target };
}

const audit = (client, { actor, action, previousStatus, newStatus, reason, previousValue = null, newValue = null }) =>
    client.auditLog.create({
        data: { auditId: crypto.randomUUID(), adminId: actor.adminId, action, previousStatus, newStatus, reason, previousValue, newValue },
    });

const runInTransaction = (db, fn) => (typeof db.$transaction === "function" ? db.$transaction(fn) : fn(db));

// POST /api/admin/users/invite body: { email, name, role }.
export function parseInviteBody(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const errors = [];
    const email = normalizeEmail(body.email);
    if (!isValidEmail(email)) errors.push({ field: "email", message: "must be a valid email address" });
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH) errors.push({ field: "name", message: `is required (at most ${MAX_NAME_LENGTH} characters)` });
    const role = typeof body.role === "string" ? body.role.trim().toUpperCase() : "";
    if (!isValidRole(role)) errors.push({ field: "role", message: `must be one of: ${ALL_ROLES.join(", ")}` });
    return errors.length ? { errors } : { values: { email, name, role } };
}

export async function listUsers({ db }) {
    const users = await db.user.findMany({
        select: { adminId: true, name: true, email: true, role: true, status: true, createdDate: true, invitedAt: true },
        orderBy: [{ status: "asc" }, { createdDate: "desc" }],
    });
    return users.map(toUserSummary);
}

export async function inviteUser({ db, authAdmin, actor, values, redirectTo }) {
    const { email, name, role } = values;
    // Which role this actor may give, before anything else (nothing is read or sent for a refusal).
    if (actor?.status !== USER_STATUS.ACTIVE || !canAssignRole(actor.role, role)) throw forbidden();
    // Never let Supabase fall back to its Site URL for the invitation link.
    if (typeof redirectTo !== "string" || redirectTo === "") {
        throw new UserAccountError(503, "INVITE_NOT_CONFIGURED", "Invitations are not configured: no redirect address.");
    }

    const existing = await db.user.findUnique({ where: { email } });
    assertCanInvite(actor, role, existing);
    if (existing?.status === USER_STATUS.ACTIVE) {
        throw new UserAccountError(409, "USER_ALREADY_ACTIVE", "An active user with this email already exists.");
    }

    const sendFailed = (error) => {
        if (!(error instanceof AuthAdminError)) return error;
        if (error.code === "RATE_LIMITED") return new UserAccountError(429, "RATE_LIMITED", "Too many invitations right now. Please try again later.");
        return new UserAccountError(502, "INVITE_FAILED", "The invitation could not be sent. Please try again.");
    };
    // A row is bound to one Supabase identity for good: never re-pointed.
    const assertSameIdentity = (authUserId) => {
        if (existing?.authUserId && existing.authUserId !== authUserId) {
            throw new UserAccountError(409, "IDENTITY_MISMATCH", "This email is linked to a different sign-in account. Contact support.");
        }
    };

    let authUserId;
    let status;
    let via = "invitation";
    try {
        ({ authUserId } = await authAdmin.inviteUserByEmail(email, { redirectTo }));
        status = USER_STATUS.INVITED;
    } catch (error) {
        if (!(error instanceof AuthAdminError) || error.code !== "EMAIL_EXISTS") throw sendFailed(error);
        // The address is already confirmed at Supabase. That does NOT mean the person set a password
        // (opening the invite link confirms it): only an account that completed setup is reactivated.
        authUserId = existing?.authUserId ?? (await authAdmin.findUserByEmail(email).catch((e) => { throw sendFailed(e); }))?.authUserId;
        if (!authUserId) throw new UserAccountError(502, "INVITE_FAILED", "The invitation could not be sent. Please try again.");
        assertSameIdentity(authUserId);
        if (existing?.activatedAt) {
            status = USER_STATUS.ACTIVE;
        } else {
            try {
                await authAdmin.sendPasswordSetupEmail(email, { redirectTo });
            } catch (sendError) {
                throw sendFailed(sendError);
            }
            status = USER_STATUS.INVITED;
            via = "password-setup email";
        }
    }
    assertSameIdentity(authUserId);

    const user = await upsertInvitedUser(db, { email, name, role, authUserId, status, actor, via });
    return { user: toUserSummary(user), outcome: status === USER_STATUS.ACTIVE ? "REACTIVATED" : "INVITED" };
}

const isUniqueViolation = (error) => error?.code === "P2002";

async function upsertInvitedUser(db, { email, name, role, authUserId, status, actor, via = "invitation" }) {
    // A concurrent invite of the same person can win the INSERT: the retry
    // then finds that row and updates it (same email, same identity).
    for (let attempt = 0; ; attempt++) {
        try {
            return await runInTransaction(db, async (tx) => {
                // The same rules again on the locked rows: the account may have changed (been
                // activated, promoted) since it was first read, and so may the actor.
                const current = await lockUserRows(tx, { actorId: actor.adminId, email });
                assertCanInvite(current.actor, role, current.target);
                if (current.target?.status === USER_STATUS.ACTIVE) throw new UserAccountError(409, "USER_ALREADY_ACTIVE", "An active user with this email already exists.");
                // Reactivation only for an account that completed setup (re-checked on the locked row).
                if (status === USER_STATUS.ACTIVE && !current.target?.activatedAt) {
                    throw new UserAccountError(409, "CONFLICT", "This user was changed at the same time. Please try again.");
                }
                const previousStatus = current.target?.status ?? "NONE";
                // An invitation (or password-setup email) was just sent: its time is the invitation's age.
                const sent = status === USER_STATUS.INVITED ? { invitedAt: new Date() } : {};
                const user = await tx.user.upsert({
                    where: { email },
                    create: { adminId: crypto.randomUUID(), authUserId, email, name, role, status, ...sent },
                    update: { authUserId, name, role, status, ...sent },
                });
                await audit(tx, {
                    actor,
                    action: status === USER_STATUS.ACTIVE ? "REACTIVATE_USER" : "INVITE_USER",
                    previousStatus,
                    newStatus: status,
                    reason: status === USER_STATUS.ACTIVE ? `Reactivated as ${role}` : via === "invitation" ? `Invited as ${role}` : `Invited as ${role} (password-setup email: the address was already confirmed)`,
                    newValue: email,
                });
                return user;
            });
        } catch (error) {
            if (!isUniqueViolation(error)) throw error;
            if (attempt >= 1) throw new UserAccountError(409, "CONFLICT", "This user was changed at the same time. Please try again.");
        }
    }
}

// POST /auth/complete-invite: the invitee's own Supabase session (set up from
// the invite link) turns their INVITED row ACTIVE. Idempotent for ACTIVE;
// anything else (revoked, unknown) is refused.
export async function completeInvitation({ db, authUserId, reason = "Invitation accepted" }) {
    const user = await db.user.findUnique({ where: { authUserId } });
    if (user?.status === USER_STATUS.ACTIVE) {
        // An account made ACTIVE without setup (the old re-invite rule) is set up now.
        if (!user.activatedAt) await db.user.updateMany({ where: { authUserId, activatedAt: null }, data: { activatedAt: new Date() } });
        return toUserSummary(user);
    }
    if (user?.status !== USER_STATUS.INVITED) {
        throw new UserAccountError(403, "ACCOUNT_NOT_ACTIVE", "This invitation is no longer valid. Ask an administrator to invite you again.");
    }
    return runInTransaction(db, async (tx) => {
        // Conditional: a concurrent deactivation wins over the activation.
        const { count } = await tx.user.updateMany({ where: { authUserId, status: USER_STATUS.INVITED }, data: { status: USER_STATUS.ACTIVE, activatedAt: new Date() } });
        if (count !== 1) throw new UserAccountError(403, "ACCOUNT_NOT_ACTIVE", "This invitation is no longer valid. Ask an administrator to invite you again.");
        await audit(tx, { actor: user, action: "COMPLETE_INVITATION", previousStatus: USER_STATUS.INVITED, newStatus: USER_STATUS.ACTIVE, reason, newValue: user.email });
        return toUserSummary({ ...user, status: USER_STATUS.ACTIVE });
    });
}

// GET /auth/invitation: the status of the signed-in identity's own account, so the setup page can
// refuse a revoked invitation BEFORE a password is set. null: no account for this identity.
export async function invitationStatus({ db, authUserId }) {
    const user = await db.user.findUnique({ where: { authUserId }, select: { status: true } });
    return user?.status ?? null;
}

// The first sign-in WITH A PASSWORD of an INVITED account completes the invitation: a password can
// only exist if the person set it from the invite link or a password email (both prove the address)
// and the account is still invited (not revoked). Repairs an activation call that never arrived.
// Never applies to INACTIVE (revoked) or unknown accounts. Returns true when it activated.
export async function activateOnPasswordSignIn({ db, authUserId }) {
    const user = await db.user.findUnique({ where: { authUserId }, select: { status: true } });
    if (user?.status !== USER_STATUS.INVITED) return false;
    try {
        await completeInvitation({ db, authUserId, reason: "Invitation completed at the first password sign-in" });
        return true;
    } catch (error) {
        if (error instanceof UserAccountError) return false; // revoked meanwhile: stays out
        throw error;
    }
}

// The checks run on the rows read under lockUserRows, inside the transaction that changes them.
async function changeUser(db, actor, userId, change) {
    assertUserManager(actor);
    if (actor.adminId === userId) throw new UserAccountError(400, "SELF_CHANGE", "You cannot change your own account here.");
    return runInTransaction(db, async (tx) => {
        const { actor: current, target } = await lockUserRows(tx, { actorId: actor.adminId, targetId: userId });
        assertUserManager(current);
        if (!target) throw new UserAccountError(404, "NOT_FOUND", "User not found");
        return change(tx, current, target);
    });
}

export async function updateUserRole({ db, actor, userId, role }) {
    assertUserManager(actor);
    if (!isValidRole(role)) throw new UserAccountError(400, "INVALID_ROLE", `Role must be one of: ${ALL_ROLES.join(", ")}`);
    return changeUser(db, actor, userId, async (tx, current, target) => {
        assertCanChange(current, target, role);
        const updated = await tx.user.update({ where: { adminId: userId }, data: { role } });
        await audit(tx, { actor: current, action: "UPDATE_USER_ROLE", previousStatus: target.role, newStatus: role, reason: `Role changed for user ${userId}`, previousValue: target.role, newValue: role });
        return toUserSummary(updated);
    });
}

// Deactivation also revokes a pending invitation: an INACTIVE row can't use
// the application whatever its Supabase session. The Supabase identity is
// kept (audit history references the row); re-inviting reactivates it.
export async function deactivateUser({ db, actor, userId }) {
    return changeUser(db, actor, userId, async (tx, current, target) => {
        assertCanChange(current, target);
        if (target.status === USER_STATUS.INACTIVE) return toUserSummary(target);
        const updated = await tx.user.update({ where: { adminId: userId }, data: { status: USER_STATUS.INACTIVE } });
        await audit(tx, { actor: current, action: "DEACTIVATE_USER", previousStatus: target.status, newStatus: USER_STATUS.INACTIVE, reason: `User ${userId} deactivated`, newValue: target.email });
        return toUserSummary(updated);
    });
}

// ---------------------------------------------------------------- names
//
// A user's display name (only the name: never the email, role or status). Every user changes their
// own (the profile menu, PUT /api/auth/me/name); OWNER and ADMIN change another user's in Settings >
// Change Roles (PUT /api/admin/users/:userId/name), any account but the Owner's: only the Owner
// changes the Owner's name, through their own profile. Looser than role changes on purpose (an ADMIN
// may rename another ADMIN). Audited UPDATE_USER_NAME, old -> new; the same name again writes nothing.

// PUT .../name body: { name }, trimmed, inner spaces collapsed, 1 to MAX_NAME_LENGTH characters.
export function parseNameBody(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > MAX_NAME_LENGTH) return { errors: [{ field: "name", message: `is required (at most ${MAX_NAME_LENGTH} characters)` }] };
    return { values: { name } };
}

const ownerNameLocked = () => new UserAccountError(403, "OWNER_LOCKED", "Only the Owner can change the Owner's name.");

async function renameRow(tx, { actor, target, name, reason }) {
    if (target.name === name) return target;
    const updated = await tx.user.update({ where: { adminId: target.adminId }, data: { name } });
    await audit(tx, { actor, action: "UPDATE_USER_NAME", previousStatus: target.status, newStatus: target.status, reason, previousValue: target.name, newValue: name });
    return updated;
}

// The signed-in user's own name (any role). Returns the updated row.
export async function updateOwnName({ db, actor, name }) {
    if (actor?.status !== USER_STATUS.ACTIVE) throw forbidden();
    return runInTransaction(db, async (tx) => {
        const { actor: current } = await lockUserRows(tx, { actorId: actor.adminId });
        if (current?.status !== USER_STATUS.ACTIVE) throw forbidden();
        return renameRow(tx, { actor: current, target: current, name, reason: "Name changed" });
    });
}

// Another user's name (OWNER or ADMIN; never the Owner's account).
export async function updateUserName({ db, actor, userId, name }) {
    return changeUser(db, actor, userId, async (tx, current, target) => {
        if (target.role === ROLES.OWNER) throw ownerNameLocked();
        return toUserSummary(await renameRow(tx, { actor: current, target, name, reason: `Name changed for user ${userId}` }));
    });
}
