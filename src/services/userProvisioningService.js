// Bootstrap provisioning (scripts/createUser.js): creates the first users
// before anyone can invite, and links application rows that predate Supabase
// Auth. There is no HTTP endpoint for this.
//
//   create  a new Supabase Auth identity (Admin API, email confirmed) with
//           the password typed at the prompt, and its ACTIVE public."user"
//   link    an existing Supabase Auth identity (found by email) to a new or
//           existing public."user" row; no password involved
//
// The password goes to Supabase Auth only; nothing here stores, hashes or
// prints it. An email whose application row is already linked is refused,
// so running the script twice never makes a second account.

import crypto from "node:crypto";

import { ALL_ROLES, ROLES, isValidRole } from "../middleware/requireRole.js";
import { USER_STATUS } from "../middleware/requireActiveUser.js";
import { AuthAdminError } from "../auth/supabaseAuthAdmin.js";
import { MAX_EMAIL_LENGTH, MAX_NAME_LENGTH, isValidEmail, normalizeEmail } from "./userAccountService.js";

export const MIN_BOOTSTRAP_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;
export const DEFAULT_BOOTSTRAP_ROLE = ROLES.ADMIN;

export class UserProvisioningError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "UserProvisioningError";
        this.code = code;
    }
}

// Messages describe the rule, never the value that broke it.
export function validateProvisioningInput({ name, email, password, role, link = false }) {
    const cleanEmail = normalizeEmail(email);
    if (!isValidEmail(cleanEmail)) {
        throw new UserProvisioningError("INVALID_EMAIL", `A valid email address is required (at most ${MAX_EMAIL_LENGTH} characters)`);
    }
    const cleanName = typeof name === "string" ? name.trim() : "";
    if (cleanName.length > MAX_NAME_LENGTH || (!link && !cleanName)) {
        throw new UserProvisioningError("INVALID_NAME", `Name is required (at most ${MAX_NAME_LENGTH} characters)`);
    }
    if (role !== undefined && !isValidRole(role)) {
        throw new UserProvisioningError("INVALID_ROLE", `Role must be one of: ${ALL_ROLES.join(", ")}`);
    }
    if (!link) {
        if (typeof password !== "string" || password.length < MIN_BOOTSTRAP_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
            throw new UserProvisioningError("WEAK_PASSWORD", `Password must be ${MIN_BOOTSTRAP_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters`);
        }
        if (password.trim() === "" || password.toLowerCase().includes(cleanEmail.split("@")[0])) {
            throw new UserProvisioningError("WEAK_PASSWORD", "Password must not be blank or contain the email name");
        }
    }
    return { name: cleanName, email: cleanEmail, password, role, link };
}

// Returns { userId, status, created } (created: a new Supabase identity was
// made). Only IDs and status: nothing that should not appear in a terminal.
export async function provisionUser(input, { db, authAdmin, newId = () => crypto.randomUUID() }) {
    const user = validateProvisioningInput(input);

    const existing = await db.user.findUnique({ where: { email: user.email } });
    if (existing?.authUserId) {
        throw new UserProvisioningError("USER_EXISTS", "A user with this email is already linked to Supabase Auth; nothing was changed");
    }
    if (!existing && !user.name) {
        throw new UserProvisioningError("INVALID_NAME", "Name is required for a new user");
    }

    let authUserId;
    let created = false;
    if (user.link) {
        authUserId = (await authAdmin.findUserByEmail(user.email))?.authUserId;
        if (!authUserId) throw new UserProvisioningError("AUTH_USER_NOT_FOUND", "No Supabase Auth account has this email; create one without --link");
    } else {
        try {
            ({ authUserId } = await authAdmin.createUser({ email: user.email, password: user.password }));
            created = true;
        } catch (error) {
            if (error instanceof AuthAdminError && error.code === "EMAIL_EXISTS") {
                throw new UserProvisioningError("AUTH_USER_EXISTS", "A Supabase Auth account with this email already exists; use --link to link it");
            }
            if (error instanceof AuthAdminError && error.code === "WEAK_PASSWORD") {
                throw new UserProvisioningError("WEAK_PASSWORD", "Supabase Auth rejected the password (project password policy)");
            }
            throw error;
        }
    }

    try {
        const row = existing
            // A row from before Supabase Auth: link it, keep its role unless one was given.
            ? await db.user.update({
                where: { adminId: existing.adminId },
                data: { authUserId, status: USER_STATUS.ACTIVE, ...(user.role ? { role: user.role } : {}), ...(user.name ? { name: user.name } : {}) },
            })
            : await db.user.create({
                data: { adminId: newId(), authUserId, email: user.email, name: user.name, role: user.role ?? DEFAULT_BOOTSTRAP_ROLE, status: USER_STATUS.ACTIVE },
            });
        return { userId: row.adminId, status: row.status, created };
    } catch (error) {
        // Never leave a Supabase identity this run created without its row.
        if (created) await authAdmin.deleteUser(authUserId).catch(() => {});
        if (error?.code === "P2002") {
            throw new UserProvisioningError("USER_EXISTS", "A user with this email or Supabase identity already exists; nothing was changed");
        }
        throw error;
    }
}
