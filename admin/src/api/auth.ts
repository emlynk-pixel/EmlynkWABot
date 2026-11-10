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

// PUT /auth/me/name: the signed-in user's own name (every role; only the name). Answers the new profile.
export async function updateOwnName(token: string, name: string): Promise<AppUser> {
    const { user } = await apiRequest<{ user: AppUser }>("/auth/me/name", { method: "PUT", token, body: { name } });
    return user;
}

// GET /auth/invitation — the status of the signed-in identity's own account, asked BEFORE a
// password is set, so a revoked invitation never gets one. null: no account for this identity.
export async function fetchInvitationStatus(token: string): Promise<"INVITED" | "ACTIVE" | "INACTIVE" | null> {
    const { status } = await apiRequest<{ status: "INVITED" | "ACTIVE" | "INACTIVE" | null }>("/auth/invitation", { token });
    return status;
}

// POST /auth/complete-invite — the invitee (signed in from their invite link,
// password set) activates their INVITED account.
export async function completeInvitation(token: string): Promise<AppUser> {
    const { user } = await apiRequest<{ user: AppUser }>("/auth/complete-invite", { method: "POST", token });
    return user;
}
