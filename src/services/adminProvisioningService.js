// Creating admin accounts (SEC-023). Used by scripts/createAdmin.js; there is
// no HTTP endpoint for this. Existing admins are never changed or replaced.

import crypto from "crypto";
import { hashPassword } from "../utils/password.js";
import { ACTIVE_ADMIN_STATUS, MAX_EMAIL_LENGTH, MAX_PASSWORD_LENGTH } from "../routes/auth.js";

export const MIN_ADMIN_PASSWORD_LENGTH = 12;
export const DEFAULT_ADMIN_ROLE = "ADMIN";
const MAX_NAME_LENGTH = 100;

export class AdminProvisioningError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "AdminProvisioningError";
        this.code = code;
    }
}

// Emails are stored lowercased and login lowercases what is typed, so
// "Admin@Example.com" and "admin@example.com" are the same account.
export function normalizeAdminEmail(email) {
    return typeof email === "string" ? email.trim().toLowerCase() : email;
}

// Messages describe the rule, never the value that broke it.
export function validateAdminInput({ name, email, password, role = DEFAULT_ADMIN_ROLE }) {
    if (typeof name !== "string" || name.trim() === "" || name.trim().length > MAX_NAME_LENGTH) {
        throw new AdminProvisioningError("INVALID_NAME", `Name is required (at most ${MAX_NAME_LENGTH} characters)`);
    }

    const normalizedEmail = normalizeAdminEmail(email);
    if (
        typeof normalizedEmail !== "string" ||
        normalizedEmail.length > MAX_EMAIL_LENGTH ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
    ) {
        throw new AdminProvisioningError("INVALID_EMAIL", "A valid email address is required");
    }

    if (typeof password !== "string" || password.length < MIN_ADMIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
        throw new AdminProvisioningError(
            "WEAK_PASSWORD",
            `Password must be ${MIN_ADMIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters`
        );
    }
    if (password.trim() === "" || password.toLowerCase().includes(normalizedEmail.split("@")[0])) {
        throw new AdminProvisioningError("WEAK_PASSWORD", "Password must not be blank or contain the email name");
    }

    if (typeof role !== "string" || !/^[A-Z_]{1,32}$/.test(role)) {
        throw new AdminProvisioningError("INVALID_ROLE", "Role must be upper-case letters and underscores, e.g. ADMIN");
    }

    return { name: name.trim(), email: normalizedEmail, password, role };
}

const isUniqueViolation = (error) => error?.code === "P2002";

// Creates one ACTIVE admin with a bcrypt-hashed password. Returns only the new
// admin's ID and status: nothing that should not appear in a terminal.
export async function createAdminAccount(input, { db, hash = hashPassword, newId = () => crypto.randomUUID() } = {}) {
    const admin = validateAdminInput(input);
    const client = db ?? (await import("../config/prisma.js")).default;

    const existing = await client.admin.findUnique({ where: { email: admin.email }, select: { adminId: true } });
    if (existing) {
        throw new AdminProvisioningError("ADMIN_EXISTS", "An admin with this email already exists; nothing was changed");
    }

    const passwordHash = await hash(admin.password);

    try {
        const created = await client.admin.create({
            data: {
                adminId: newId(),
                name: admin.name,
                email: admin.email,
                passwordHash,
                role: admin.role,
                status: ACTIVE_ADMIN_STATUS,
            },
            select: { adminId: true, status: true },
        });
        return { adminId: created.adminId, status: created.status };
    } catch (error) {
        // Another run created the same email in the meantime.
        if (isUniqueViolation(error)) {
            throw new AdminProvisioningError("ADMIN_EXISTS", "An admin with this email already exists; nothing was changed");
        }
        throw error;
    }
}
