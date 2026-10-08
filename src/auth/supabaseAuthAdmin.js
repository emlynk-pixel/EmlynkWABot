// The Supabase Auth Admin API, as the application uses it (server only: it
// runs with the service-role key from config/supabase.js, which never leaves
// the backend). A narrow interface so the services stay testable with a fake
// and never see the raw client:
//
//   inviteUserByEmail(email, { redirectTo }) -> { authUserId }
//   createUser({ email, password })          -> { authUserId }
//   findUserByEmail(email)                   -> { authUserId, email } | null
//   deleteUser(authUserId)                   -> void
//
// Errors are AuthAdminError with a code the services act on:
//   EMAIL_EXISTS  the email already has a confirmed Supabase identity
//   WEAK_PASSWORD the password does not meet the project's policy
//   RATE_LIMITED  Supabase refused the request for now
//   FAILED        anything else (message never includes the email or password)
//
// No role or status is ever written to Supabase user metadata: the
// application's public."user" row is the only source of authorization.

export class AuthAdminError extends Error {
    constructor(code, message, status) {
        super(message);
        this.name = "AuthAdminError";
        this.code = code;
        this.status = status;
    }
}

const EXISTS_CODES = new Set(["email_exists", "user_already_exists"]);

function toAuthAdminError(error) {
    const code = error?.code;
    const status = error?.status;
    if (EXISTS_CODES.has(code) || (status === 422 && /already (been )?registered|already exists/i.test(error?.message ?? ""))) {
        return new AuthAdminError("EMAIL_EXISTS", "A Supabase Auth account with this email already exists", status);
    }
    if (code === "weak_password") return new AuthAdminError("WEAK_PASSWORD", "The password does not meet the password policy", status);
    if (status === 429 || code === "over_email_send_rate_limit" || code === "over_request_rate_limit") {
        return new AuthAdminError("RATE_LIMITED", "Supabase Auth is rate limiting requests; try again later", status);
    }
    return new AuthAdminError("FAILED", "The Supabase Auth request failed", status);
}

const LIST_PAGE_SIZE = 200;
const MAX_LIST_PAGES = 50;

export function createSupabaseAuthAdmin({ client }) {
    const admin = client?.auth?.admin;
    if (!admin) throw new Error("A Supabase service-role client is required");

    return Object.freeze({
        async inviteUserByEmail(email, { redirectTo } = {}) {
            const { data, error } = await admin.inviteUserByEmail(email, redirectTo ? { redirectTo } : undefined);
            if (error) throw toAuthAdminError(error);
            return { authUserId: data.user.id };
        },

        async createUser({ email, password }) {
            const { data, error } = await admin.createUser({ email, password, email_confirm: true });
            if (error) throw toAuthAdminError(error);
            return { authUserId: data.user.id };
        },

        // The Admin API has no lookup by email; page through the users.
        async findUserByEmail(email) {
            const wanted = email.toLowerCase();
            for (let page = 1; page <= MAX_LIST_PAGES; page++) {
                const { data, error } = await admin.listUsers({ page, perPage: LIST_PAGE_SIZE });
                if (error) throw toAuthAdminError(error);
                const users = data?.users ?? [];
                const match = users.find((user) => user.email?.toLowerCase() === wanted);
                if (match) return { authUserId: match.id, email: wanted };
                if (users.length < LIST_PAGE_SIZE) return null;
            }
            throw new AuthAdminError("FAILED", "Too many Supabase Auth users to search");
        },

        async deleteUser(authUserId) {
            const { error } = await admin.deleteUser(authUserId);
            if (error) throw toAuthAdminError(error);
        },
    });
}

let defaultAuthAdmin;
export async function getSupabaseAuthAdmin() {
    if (!defaultAuthAdmin) {
        const { default: supabase } = await import("../config/supabase.js");
        defaultAuthAdmin = createSupabaseAuthAdmin({ client: supabase });
    }
    return defaultAuthAdmin;
}
