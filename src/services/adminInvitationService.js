// Admin Invitation Service (Phase 12, Checkpoint 2).
//
// Implements the self-service administrator invitation workflow:
//   1. ADMIN creates an invitation (name, email, role).
//   2. A cryptographically secure 256-bit random token is generated.
//   3. ONLY a SHA-256 hash of the token is stored in the database.
//   4. The invitation is set to expire in 24 hours.
//   5. An email is dispatched with the password setup link.
//   6. Invitee visits the setup page and enters a secure password.
//   7. Password is encrypted using bcrypt via existing hashPassword utility.
//   8. Account is created or set to ACTIVE only after successful password setup.
//   9. The invitation token is marked ACCEPTED and becomes permanently unusable.
//  10. Audit entries record invitation issuance, completion, and revocation.

import crypto from "crypto";
import { hashPassword } from "../utils/password.js";
import { ADMIN_ROLES, ALL_ROLES } from "../middleware/requireRole.js";
import { ACTIVE_ADMIN_STATUS } from "../middleware/requireActiveAdmin.js";
import * as defaultEmailService from "./emailService.js";

export const INVITATION_STATUS = Object.freeze({
    PENDING: "PENDING",
    ACCEPTED: "ACCEPTED",
    REVOKED: "REVOKED",
    EXPIRED: "EXPIRED",
});

export const INVITATION_EXPIRATION_HOURS = 24;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
export const MAX_NAME_LENGTH = 100;
export const MAX_EMAIL_LENGTH = 254;

export class InvitationError extends Error {
    constructor(message, status = 400, code = null) {
        super(message);
        this.name = "InvitationError";
        this.status = status;
        this.code = code;
    }
}

/**
 * Computes a SHA-256 hash of the plain token.
 * Raw tokens are never stored in the database.
 */
export function hashInvitationToken(token) {
    if (!token || typeof token !== "string") {
        throw new InvitationError("Invalid invitation token", 400, "INVALID_TOKEN");
    }
    return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Generates a 256-bit cryptographically secure random token (64 hex chars).
 */
export function generateInvitationToken() {
    return crypto.randomBytes(32).toString("hex");
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email) {
    if (typeof email !== "string") return false;
    const trimmed = email.trim();
    return trimmed.length > 0 && trimmed.length <= MAX_EMAIL_LENGTH && EMAIL_REGEX.test(trimmed);
}

function validateName(name) {
    if (typeof name !== "string") return false;
    const trimmed = name.trim();
    return trimmed.length > 0 && trimmed.length <= MAX_NAME_LENGTH;
}

/**
 * Issues a new admin invitation.
 * Only callable by an active admin with role 'ADMIN'.
 */
export async function createInvitation({
    db,
    admin,
    email,
    name,
    role,
    emailService = defaultEmailService,
}) {
    if (!admin || admin.status !== ACTIVE_ADMIN_STATUS) {
        throw new InvitationError("Authentication Token is required!", 401);
    }
    if (admin.role !== ADMIN_ROLES.ADMIN) {
        throw new InvitationError("Insufficient permissions", 403);
    }

    if (!validateName(name)) {
        throw new InvitationError("Name is required and must be under 100 characters", 400, "INVALID_NAME");
    }
    if (!validateEmail(email)) {
        throw new InvitationError("A valid email address is required", 400, "INVALID_EMAIL");
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanName = name.trim();
    const cleanRole = String(role ?? "").trim().toUpperCase();

    if (!ALL_ROLES.includes(cleanRole)) {
        throw new InvitationError(`Invalid role. Must be one of: ${ALL_ROLES.join(", ")}`, 400, "INVALID_ROLE");
    }

    // Prevent duplicate active accounts for the same email
    const existingAdmin = await db.user.findUnique({
        where: { email: cleanEmail },
    });
    if (existingAdmin && existingAdmin.status === ACTIVE_ADMIN_STATUS) {
        throw new InvitationError("An active admin with this email already exists", 409, "DUPLICATE_ACTIVE_ADMIN");
    }

    const rawToken = generateInvitationToken();
    const tokenHash = hashInvitationToken(rawToken);
    const expiresAt = new Date(Date.now() + INVITATION_EXPIRATION_HOURS * 60 * 60 * 1000);
    const invitationId = crypto.randomUUID();

    // Revoke any previous pending invitations for this email to prevent confusion
    if (db.adminInvitation.updateMany) {
        await db.adminInvitation.updateMany({
            where: { email: cleanEmail, status: INVITATION_STATUS.PENDING },
            data: { status: INVITATION_STATUS.REVOKED, revokedAt: new Date() },
        });
    }

    // Persist invitation with hashed token
    const invitation = await db.adminInvitation.create({
        data: {
            invitationId,
            email: cleanEmail,
            name: cleanName,
            role: cleanRole,
            tokenHash,
            invitedBy: admin.adminId,
            status: INVITATION_STATUS.PENDING,
            expiresAt,
        },
    });

    // Immutable audit record of invitation issuance
    await db.auditLog.create({
        data: {
            auditId: crypto.randomUUID(),
            adminId: admin.adminId,
            action: "INVITE_ADMIN",
            previousStatus: "NONE",
            newStatus: "INVITED",
            reason: `Invited as ${cleanRole}`,
            newValue: cleanEmail,
        },
    });

    // Send invitation email with setup link
    await emailService.sendInvitationEmail({
        email: cleanEmail,
        name: cleanName,
        role: cleanRole,
        token: rawToken,
        expiresAt,
    });

    // Return safe presentation data (never expose raw token or token hash)
    return {
        invitationId: invitation.invitationId,
        email: invitation.email,
        name: invitation.name,
        role: invitation.role,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt,
    };
}

/**
 * Validates an invitation token for the password setup page.
 * Returns safe invitee profile details without consuming the token.
 */
export async function getInvitationByToken({ db, token }) {
    if (!token || typeof token !== "string") {
        throw new InvitationError("Invalid invitation token", 400, "INVALID_TOKEN");
    }

    const tokenHash = hashInvitationToken(token);
    const invitation = await db.adminInvitation.findUnique({
        where: { tokenHash },
    });

    if (!invitation) {
        throw new InvitationError("Invalid invitation token", 400, "INVALID_TOKEN");
    }

    if (invitation.status === INVITATION_STATUS.ACCEPTED) {
        throw new InvitationError("Invitation has already been used", 400, "ALREADY_USED");
    }
    if (invitation.status === INVITATION_STATUS.REVOKED) {
        throw new InvitationError("Invitation has been revoked", 400, "REVOKED");
    }
    if (new Date() > new Date(invitation.expiresAt) || invitation.status === INVITATION_STATUS.EXPIRED) {
        throw new InvitationError("Invitation has expired", 400, "EXPIRED");
    }
    if (invitation.status !== INVITATION_STATUS.PENDING) {
        throw new InvitationError("Invalid invitation status", 400, "INVALID_STATUS");
    }

    return {
        invitationId: invitation.invitationId,
        email: invitation.email,
        name: invitation.name,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
    };
}

/**
 * Completes password setup, creates or activates the admin account,
 * marks the invitation token permanently unusable, and creates an audit entry.
 */
export async function setupPasswordFromInvitation({ db, token, password }) {
    if (!token || typeof token !== "string") {
        throw new InvitationError("Invalid invitation token", 400, "INVALID_TOKEN");
    }
    if (!password || typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
        throw new InvitationError(`Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`, 400, "INVALID_PASSWORD");
    }

    const tokenHash = hashInvitationToken(token);
    const invitation = await db.adminInvitation.findUnique({
        where: { tokenHash },
    });

    if (!invitation) {
        throw new InvitationError("Invalid invitation token", 400, "INVALID_TOKEN");
    }

    if (invitation.status === INVITATION_STATUS.ACCEPTED) {
        throw new InvitationError("Invitation has already been used", 400, "ALREADY_USED");
    }
    if (invitation.status === INVITATION_STATUS.REVOKED) {
        throw new InvitationError("Invitation has been revoked", 400, "REVOKED");
    }
    if (new Date() > new Date(invitation.expiresAt) || invitation.status === INVITATION_STATUS.EXPIRED) {
        throw new InvitationError("Invitation has expired", 400, "EXPIRED");
    }
    if (invitation.status !== INVITATION_STATUS.PENDING) {
        throw new InvitationError("Invalid invitation status", 400, "INVALID_STATUS");
    }

    // Check duplicate active account before completing
    const existingAdmin = await db.user.findUnique({
        where: { email: invitation.email },
    });
    if (existingAdmin && existingAdmin.status === ACTIVE_ADMIN_STATUS) {
        throw new InvitationError("An active admin with this email already exists", 409, "DUPLICATE_ACTIVE_ADMIN");
    }

    const passwordHash = await hashPassword(password);
    const now = new Date();

    const executeUpdate = async (tx) => {
        // Mark invitation as accepted
        await tx.adminInvitation.update({
            where: { invitationId: invitation.invitationId },
            data: {
                status: INVITATION_STATUS.ACCEPTED,
                acceptedAt: now,
            },
        });

        let activeAdminId;
        if (existingAdmin) {
            activeAdminId = existingAdmin.adminId;
            await tx.user.update({
                where: { adminId: activeAdminId },
                data: {
                    name: invitation.name,
                    role: invitation.role,
                    passwordHash,
                    status: ACTIVE_ADMIN_STATUS,
                },
            });
        } else {
            activeAdminId = crypto.randomUUID();
            await tx.user.create({
                data: {
                    adminId: activeAdminId,
                    name: invitation.name,
                    email: invitation.email,
                    role: invitation.role,
                    passwordHash,
                    status: ACTIVE_ADMIN_STATUS,
                },
            });
        }

        // Audit completion
        await tx.auditLog.create({
            data: {
                auditId: crypto.randomUUID(),
                adminId: activeAdminId,
                action: "COMPLETE_INVITATION",
                previousStatus: "INVITED",
                newStatus: ACTIVE_ADMIN_STATUS,
                reason: "Password setup completed via invitation",
                newValue: invitation.email,
            },
        });

        return { adminId: activeAdminId };
    };

    if (typeof db.$transaction === "function") {
        await db.$transaction(executeUpdate);
    } else {
        await executeUpdate(db);
    }

    return {
        message: "Password set successfully. Account is now active.",
    };
}

/**
 * Lists all invitations. Restricted to ADMIN role.
 */
export async function listInvitations({ db, admin }) {
    if (!admin || admin.status !== ACTIVE_ADMIN_STATUS) {
        throw new InvitationError("Authentication Token is required!", 401);
    }
    if (admin.role !== ADMIN_ROLES.ADMIN) {
        throw new InvitationError("Insufficient permissions", 403);
    }

    const rows = await db.adminInvitation.findMany({
        orderBy: [{ createdAt: "desc" }],
    });

    const now = new Date();
    return rows.map((inv) => {
        let computedStatus = inv.status;
        if (computedStatus === INVITATION_STATUS.PENDING && now > new Date(inv.expiresAt)) {
            computedStatus = INVITATION_STATUS.EXPIRED;
        }

        return {
            invitationId: inv.invitationId,
            email: inv.email,
            name: inv.name,
            role: inv.role,
            status: computedStatus,
            expiresAt: inv.expiresAt,
            createdAt: inv.createdAt,
            acceptedAt: inv.acceptedAt ?? null,
            revokedAt: inv.revokedAt ?? null,
            invitedBy: inv.invitedBy,
        };
    });
}

/**
 * Revokes a pending invitation. Restricted to ADMIN role.
 */
export async function revokeInvitation({ db, admin, invitationId }) {
    if (!admin || admin.status !== ACTIVE_ADMIN_STATUS) {
        throw new InvitationError("Authentication Token is required!", 401);
    }
    if (admin.role !== ADMIN_ROLES.ADMIN) {
        throw new InvitationError("Insufficient permissions", 403);
    }

    const invitation = await db.adminInvitation.findUnique({
        where: { invitationId },
    });

    if (!invitation) {
        throw new InvitationError("Invitation not found", 404, "NOT_FOUND");
    }

    if (invitation.status === INVITATION_STATUS.ACCEPTED) {
        throw new InvitationError("Cannot revoke an accepted invitation", 400, "CANNOT_REVOKE_ACCEPTED");
    }
    if (invitation.status === INVITATION_STATUS.REVOKED) {
        throw new InvitationError("Invitation is already revoked", 400, "ALREADY_REVOKED");
    }

    await db.adminInvitation.update({
        where: { invitationId },
        data: {
            status: INVITATION_STATUS.REVOKED,
            revokedAt: new Date(),
        },
    });

    await db.auditLog.create({
        data: {
            auditId: crypto.randomUUID(),
            adminId: admin.adminId,
            action: "REVOKE_INVITATION",
            previousStatus: invitation.status,
            newStatus: INVITATION_STATUS.REVOKED,
            reason: "Invitation revoked by administrator",
            newValue: invitation.email,
        },
    });

    return { message: "Invitation revoked" };
}

/**
 * Permanently removes an invitation from the database. Restricted to ADMIN role.
 */
export async function deleteInvitation({ db, admin, invitationId }) {
    if (!admin || admin.status !== ACTIVE_ADMIN_STATUS) {
        throw new InvitationError("Authentication Token is required!", 401);
    }
    if (admin.role !== ADMIN_ROLES.ADMIN) {
        throw new InvitationError("Insufficient permissions", 403);
    }

    const invitation = await db.adminInvitation.findUnique({
        where: { invitationId },
    });

    if (!invitation) {
        throw new InvitationError("Invitation not found", 404, "NOT_FOUND");
    }

    await db.adminInvitation.delete({
        where: { invitationId },
    });

    await db.auditLog.create({
        data: {
            auditId: crypto.randomUUID(),
            adminId: admin.adminId,
            action: "DELETE_INVITATION",
            previousStatus: invitation.status,
            newStatus: "DELETED",
            reason: "Invitation removed from list permanently",
            newValue: invitation.email,
        },
    });

    return { message: "Invitation permanently removed" };
}
