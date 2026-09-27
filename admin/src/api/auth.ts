import { apiRequest } from "./client";

// Existing backend endpoints (src/routes/auth.js).
// Phase 12: authentication supports httpOnly cookie (set by the server on login)
// and Bearer token.
export type Admin = {
    adminId: string;
    email: string;
    name: string;
    role: string;
    status: string;
};

// POST /auth/login — sends credentials, the server sets the httpOnly cookie and
// returns the session token.
export async function login(email: string, password: string): Promise<string> {
    const { token } = await apiRequest<{ token: string; message: string }>("/auth/login", {
        method: "POST",
        body: { email, password },
    });
    return token;
}

// GET /auth/me — returns the signed-in admin's profile.
export async function fetchCurrentAdmin(token?: string, signal?: AbortSignal): Promise<Admin> {
    const { admin } = await apiRequest<{ admin: Admin }>("/auth/me", { token, signal });
    return admin;
}

// POST /auth/logout — the server clears the httpOnly cookie.
export async function logout(): Promise<void> {
    await apiRequest<{ message: string }>("/auth/logout", { method: "POST" });
}
