// Application users (public."user"): listing, invitation, role and status.
// Supabase Auth owns every credential, session, invitation email and
// password; this service owns the application profile, its role and its
// status, and the audit trail. The caller (routes/users.js) has already
// checked that the actor is an ACTIVE ADMIN; the role checks here are defence
// in depth for any other caller.
//
// Invite flow:
//   ADMIN -> POST /api/admin/users/invite { email, name, role }
//     -> role validated here (never taken from Supabase user metadata)
//     -> Supabase Auth Admin inviteUserByEmail (Supabase sends the email)
//     -> public."user" upserted by email, linked by auth_user_id, INVITED
//   invitee -> Supabase invite link -> sets a password -> POST /auth/complete-invite
//     -> INVITED becomes ACTIVE (completeInvitation below)
//
// Re-inviting:
//   no row / INVITED / INACTIVE (never set up)  Supabase re-sends the invite; INVITED
//   INACTIVE (account already set up)           Supabase refuses (identity confirmed);
//                                               the existing identity is reactivated: ACTIVE
//   confirmed Supabase identity without a row   linked by email (the address is confirmed): ACTIVE
//   ACTIVE                                      refused (409)
// One row per email (unique) and per Supabase identity (unique), so two
// concurrent invites of one person converge on the same row.

import crypto from "node:crypto";

import { ALL_ROLES, ROLES, isValidRole } from "../middleware/requireRole.js";
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
});

const assertAdmin = (actor) => {
    if (actor?.status !== USER_STATUS.ACTIVE || actor.role !== ROLES.ADMIN) {
        throw new UserAccountError(403, "FORBIDDEN", "Insufficient permissions");
    }
};

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
        select: { adminId: true, name: true, email: true, role: true, status: true, createdDate: true },
        orderBy: [{ status: "asc" }, { createdDate: "desc" }],
    });
    return users.map(toUserSummary);
}

export async function inviteUser({ db, authAdmin, actor, values, redirectTo }) {
    assertAdmin(actor);
    const { email, name, role } = values;

    const existing = await db.user.findUnique({ where: { email } });
    if (existing?.status === USER_STATUS.ACTIVE) {
        throw new UserAccountError(409, "USER_ALREADY_ACTIVE", "An active user with this email already exists.");
    }

    let authUserId;
    let status;
    try {
        ({ authUserId } = await authAdmin.inviteUserByEmail(email, { redirectTo }));
        status = USER_STATUS.INVITED;
    } catch (error) {
        if (!(error instanceof AuthAdminError)) throw error;
        if (error.code === "RATE_LIMITED") throw new UserAccountError(429, "RATE_LIMITED", "Too many invitations right now. Please try again later.");
        if (error.code !== "EMAIL_EXISTS") throw new UserAccountError(502, "INVITE_FAILED", "The invitation could not be sent. Please try again.");
        // The person already completed a Supabase sign-up with this confirmed
        // address: reactivate / link that identity instead of inviting again.
        authUserId = existing?.authUserId ?? (await authAdmin.findUserByEmail(email))?.authUserId;
        if (!authUserId) throw new UserAccountError(502, "INVITE_FAILED", "The invitation could not be sent. Please try again.");
        status = USER_STATUS.ACTIVE;
    }

    // A row is bound to one Supabase identity for good: never re-pointed.
    if (existing?.authUserId && existing.authUserId !== authUserId) {
        throw new UserAccountError(409, "IDENTITY_MISMATCH", "This email is linked to a different sign-in account. Contact support.");
    }

    const user = await upsertInvitedUser(db, { email, name, role, authUserId, status, actor, previousStatus: existing?.status ?? "NONE" });
    return { user: toUserSummary(user), outcome: status === USER_STATUS.ACTIVE ? "REACTIVATED" : "INVITED" };
}

const isUniqueViolation = (error) => error?.code === "P2002";

async function upsertInvitedUser(db, { email, name, role, authUserId, status, actor, previousStatus }) {
    // A concurrent invite of the same person can win the INSERT: the retry
    // then finds that row and updates it (same email, same identity).
    for (let attempt = 0; ; attempt++) {
        try {
            return await runInTransaction(db, async (tx) => {
                const user = await tx.user.upsert({
                    where: { email },
                    create: { adminId: crypto.randomUUID(), authUserId, email, name, role, status },
                    update: { authUserId, name, role, status },
                });
                await audit(tx, {
                    actor,
                    action: status === USER_STATUS.ACTIVE ? "REACTIVATE_USER" : "INVITE_USER",
                    previousStatus,
                    newStatus: status,
                    reason: `Invited as ${role}`,
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
export async function completeInvitation({ db, authUserId }) {
    const user = await db.user.findUnique({ where: { authUserId } });
    if (user?.status === USER_STATUS.ACTIVE) return toUserSummary(user);
    if (user?.status !== USER_STATUS.INVITED) {
        throw new UserAccountError(403, "ACCOUNT_NOT_ACTIVE", "This invitation is no longer valid. Ask an administrator to invite you again.");
    }
    return runInTransaction(db, async (tx) => {
        // Conditional: a concurrent deactivation wins over the activation.
        const { count } = await tx.user.updateMany({ where: { authUserId, status: USER_STATUS.INVITED }, data: { status: USER_STATUS.ACTIVE } });
        if (count !== 1) throw new UserAccountError(403, "ACCOUNT_NOT_ACTIVE", "This invitation is no longer valid. Ask an administrator to invite you again.");
        await audit(tx, { actor: user, action: "COMPLETE_INVITATION", previousStatus: USER_STATUS.INVITED, newStatus: USER_STATUS.ACTIVE, reason: "Invitation accepted", newValue: user.email });
        return toUserSummary({ ...user, status: USER_STATUS.ACTIVE });
    });
}

async function requireTarget(db, actor, userId) {
    if (actor.adminId === userId) throw new UserAccountError(400, "SELF_CHANGE", "You cannot change your own account here.");
    const target = await db.user.findUnique({ where: { adminId: userId } });
    if (!target) throw new UserAccountError(404, "NOT_FOUND", "User not found");
    return target;
}

export async function updateUserRole({ db, actor, userId, role }) {
    assertAdmin(actor);
    if (!isValidRole(role)) throw new UserAccountError(400, "INVALID_ROLE", `Role must be one of: ${ALL_ROLES.join(", ")}`);
    const target = await requireTarget(db, actor, userId);
    return runInTransaction(db, async (tx) => {
        const updated = await tx.user.update({ where: { adminId: userId }, data: { role } });
        await audit(tx, { actor, action: "UPDATE_USER_ROLE", previousStatus: target.role, newStatus: role, reason: `Role changed for user ${userId}`, previousValue: target.role, newValue: role });
        return toUserSummary(updated);
    });
}

// Deactivation also revokes a pending invitation: an INACTIVE row can't use
// the application whatever its Supabase session. The Supabase identity is
// kept (audit history references the row); re-inviting reactivates it.
export async function deactivateUser({ db, actor, userId }) {
    assertAdmin(actor);
    const target = await requireTarget(db, actor, userId);
    if (target.status === USER_STATUS.INACTIVE) return toUserSummary(target);
    return runInTransaction(db, async (tx) => {
        const updated = await tx.user.update({ where: { adminId: userId }, data: { status: USER_STATUS.INACTIVE } });
        await audit(tx, { actor, action: "DEACTIVATE_USER", previousStatus: target.status, newStatus: USER_STATUS.INACTIVE, reason: `User ${userId} deactivated`, newValue: target.email });
        return toUserSummary(updated);
    });
}
