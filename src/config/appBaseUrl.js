// APP_BASE_URL: the public origin of THIS environment's admin site, e.g.
//   local   http://localhost:5173
//   stage   https://<stage host>
// It is the only source of the redirect addresses Supabase puts in invitation
// emails (${APP_BASE_URL}/admin/setup-password). It is read from the server's
// environment, never from a request body or header, and it is required: an
// invitation is refused rather than sent with a link to a wrong place.
//
// Each address must also be in the Supabase project's allowed redirect URLs
// (Docs/SUPABASE_AUTH.md); Supabase ignores a redirect it doesn't allow.
//
// The password-recovery redirect (/admin/reset-password) is built by the admin
// app itself from its own page origin (admin/src/auth/supabaseClient.ts), which
// is the same site as APP_BASE_URL in a correctly configured environment.

export const SETUP_PASSWORD_PATH = "/admin/setup-password";

// { origin } for a valid value, otherwise { problem } (a message that never
// repeats the value).
export function parseAppBaseUrl(value) {
    if (typeof value !== "string" || value.trim() === "") return { problem: "APP_BASE_URL is missing" };
    let url;
    try {
        url = new URL(value.trim());
    } catch {
        return { problem: "APP_BASE_URL is not a valid URL" };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return { problem: "APP_BASE_URL must start with http:// or https://" };
    if (url.username || url.password) return { problem: "APP_BASE_URL must not contain credentials" };
    if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
        return { problem: "APP_BASE_URL must be the site address only, with no path, query or fragment (for example https://host)" };
    }
    return { origin: url.origin };
}

// The address Supabase sends an invitee to. Throws when APP_BASE_URL is not
// usable, so no invitation is sent with a link to the wrong place.
export function inviteRedirectUrl(env = process.env) {
    const { origin, problem } = parseAppBaseUrl(env.APP_BASE_URL);
    if (problem) throw new InviteConfigError(problem);
    return `${origin}${SETUP_PASSWORD_PATH}`;
}

export class InviteConfigError extends Error {
    constructor(problem) {
        super(`Invitations are not configured: ${problem}.`);
        this.name = "InviteConfigError";
    }
}
