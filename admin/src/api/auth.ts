import { apiRequest } from "./client";

// The application profile of the signed-in Supabase session (src/routes/auth.js).
// Role and status come from public."user", never from Supabase.
export type AppUser = {
    userId: string;
    email: string;
    name: string;
    role: string;
    status: string;
};

// GET /auth/me — 401 without a valid session, 403 when the session has no
// ACTIVE application user.
export async function fetchCurrentUser(token: string, signal?: AbortSignal): Promise<AppUser> {
    const { user } = await apiRequest<{ user: AppUser }>("/auth/me", { token, signal });
    return user;
}

// POST /auth/complete-invite — the invitee (signed in from their invite link,
// password set) activates their INVITED account.
export async function completeInvitation(token: string): Promise<AppUser> {
    const { user } = await apiRequest<{ user: AppUser }>("/auth/complete-invite", { method: "POST", token });
    return user;
}
