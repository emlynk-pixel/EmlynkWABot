// Password Reset Service (Self-service recovery).
//
// Implements secure password recovery:
//   1. Generates 256-bit cryptographically secure random token (crypto.randomBytes(32)).
//   2. Stores ONLY SHA-256 hash of the token in admin_password_resets.
//   3. Tokens expire after 1 hour and are strictly one-time use.
//   4. Generic response ensures zero account or email enumeration.
//   5. Passwords must satisfy length requirements (8-128 chars) and are hashed with bcrypt.
//   6. Inactive/disabled accounts are not activated by reset.
//   7. Audit log records password reset events with previous and new account status.

import crypto from "crypto";
import { hashPassword } from "../utils/password.js";
import { ACTIVE_ADMIN_STATUS } from "../middleware/requireActiveAdmin.js";
import * as defaultEmailService from "./emailService.js";

export const RESET_TOKEN_EXPIRATION_MS = 60 * 60 * 1000; // 1 hour
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
export const MAX_EMAIL_LENGTH = 254;

export const GENERIC_FORGOT_PASSWORD_RESPONSE = Object.freeze({
    message: "If the account exists, a password reset link has been sent.",
});

export class PasswordResetError extends Error {
    constructor(message, status = 400, code = null) {
        super(message);
        this.name = "PasswordResetError";
        this.status = status;
        this.code = code;
    }
}

/**
 * Computes SHA-256 hash of the raw reset token.
 * Raw tokens are never stored in the database.
 */
export function hashResetToken(token) {
    if (!token || typeof token !== "string") {
        throw new PasswordResetError("Invalid password reset token", 400, "INVALID_TOKEN");
    }
    return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Generates a 256-bit cryptographically secure random reset token.
 */
export function generateResetToken() {
    return crypto.randomBytes(32).toString("hex");
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email) {
    if (typeof email !== "string") return false;
    const trimmed = email.trim();
    return trimmed.length > 0 && trimmed.length <= MAX_EMAIL_LENGTH && EMAIL_REGEX.test(trimmed);
}

/**
 * Initiates the password reset workflow.
 * Always returns a generic success message to prevent user enumeration.
 */
export async function requestPasswordReset({
    db,
    email,
    emailService = defaultEmailService,
    env = process.env,
}) {
    if (!email || typeof email !== "string") {
        throw new PasswordResetError("Email is required", 400, "INVALID_EMAIL");
    }

    const cleanEmail = email.trim().toLowerCase();
    if (!validateEmail(cleanEmail)) {
        // Return generic message even for invalid email formats to prevent probing
        return GENERIC_FORGOT_PASSWORD_RESPONSE;
    }

    // Lookup admin account
    const admin = await db.user.findUnique({
        where: { email: cleanEmail },
    });

    // Only active admins receive a reset token and email
    if (admin && admin.status === ACTIVE_ADMIN_STATUS) {
        const rawToken = generateResetToken();
        const tokenHash = hashResetToken(rawToken);
        const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRATION_MS);
        const resetId = crypto.randomUUID();

        // Invalidate any previously unused reset tokens for this admin
        if (db.adminPasswordReset?.updateMany) {
            await db.adminPasswordReset.updateMany({
                where: {
                    adminId: admin.adminId,
                    usedAt: null,
                },
                data: {
                    usedAt: new Date(),
                },
            });
        }

        // Store only the hashed token
        await db.adminPasswordReset.create({
            data: {
                resetId,
                adminId: admin.adminId,
                tokenHash,
                expiresAt,
            },
        });

        // Dispatch reset email asynchronously (fire-and-forget).
        // Not awaited so the response time is the same whether the account
        // exists, is active or inactive — eliminates the timing side-channel
        // (AUDIT-001). A send failure is logged but never surfaces to the
        // caller; the token is already stored and valid when the admin retries.
        void emailService
            .sendPasswordResetEmail({
                email: admin.email,
                name: admin.name,
                token: rawToken,
                expiresAt,
                env,
            })
            .catch((sendError) => {
                console.error("Password reset email could not be sent:", {
                    errorType: sendError?.name ?? "Error",
                });
            });
    }

    // Generic response regardless of whether account exists, is active, or inactive
    return GENERIC_FORGOT_PASSWORD_RESPONSE;
}

/**
 * Validates a reset token without consuming it.
 */
export async function validateResetToken({ db, token }) {
    if (!token || typeof token !== "string") {
        throw new PasswordResetError("Invalid password reset token", 400, "INVALID_TOKEN");
    }

    const tokenHash = hashResetToken(token);
    const reset = await db.adminPasswordReset.findUnique({
        where: { tokenHash },
    });

    if (!reset) {
        throw new PasswordResetError("Invalid or expired password reset link", 400, "INVALID_TOKEN");
    }

    if (reset.usedAt) {
        throw new PasswordResetError("Password reset link has already been used", 400, "ALREADY_USED");
    }

    if (new Date() > new Date(reset.expiresAt)) {
        throw new PasswordResetError("Password reset link has expired", 400, "EXPIRED");
    }

    return {
        valid: true,
        message: "Reset token is valid",
    };
}

/**
 * Consumes the reset token, updates the admin's password hash, marks the token as used,
 * and records an immutable audit log entry.
 */
export async function resetPassword({ db, token, password }) {
    if (!token || typeof token !== "string") {
        throw new PasswordResetError("Invalid password reset token", 400, "INVALID_TOKEN");
    }

    if (
        !password ||
        typeof password !== "string" ||
        password.length < MIN_PASSWORD_LENGTH ||
        password.length > MAX_PASSWORD_LENGTH
    ) {
        throw new PasswordResetError(
            `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`,
            400,
            "INVALID_PASSWORD"
        );
    }

    const tokenHash = hashResetToken(token);
    const reset = await db.adminPasswordReset.findUnique({
        where: { tokenHash },
    });

    if (!reset) {
        throw new PasswordResetError("Invalid or expired password reset link", 400, "INVALID_TOKEN");
    }

    if (reset.usedAt) {
        throw new PasswordResetError("Password reset link has already been used", 400, "ALREADY_USED");
    }

    if (new Date() > new Date(reset.expiresAt)) {
        throw new PasswordResetError("Password reset link has expired", 400, "EXPIRED");
    }

    const admin = await db.user.findUnique({
        where: { adminId: reset.adminId },
    });

    if (!admin) {
        throw new PasswordResetError("Admin account not found", 404, "ADMIN_NOT_FOUND");
    }

    const passwordHash = await hashPassword(password);
    const now = new Date();

    const executeUpdate = async (tx) => {
        // Mark token as used
        await tx.adminPasswordReset.update({
            where: { resetId: reset.resetId },
            data: { usedAt: now },
        });

        // Update password hash. NOTE: admin status is intentionally NOT changed.
        // Inactive/disabled accounts remain inactive/disabled.
        await tx.user.update({
            where: { adminId: admin.adminId },
            data: { passwordHash },
        });

        // Create audit log entry
        await tx.auditLog.create({
            data: {
                auditId: crypto.randomUUID(),
                adminId: admin.adminId,
                action: "RESET_PASSWORD",
                previousStatus: admin.status,
                newStatus: admin.status,
                reason: "Password reset via self-service recovery token",
                newValue: admin.email,
            },
        });
    };

    if (typeof db.$transaction === "function") {
        await db.$transaction(executeUpdate);
    } else {
        await executeUpdate(db);
    }

    return {
        message: "Password reset successful. You can now sign in with your new password.",
    };
}
