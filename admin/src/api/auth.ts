import { apiRequest } from "./client";

// Existing backend endpoints (src/routes/auth.js); unchanged in Phase 10.
export type Admin = {
    adminId: string;
    email: string;
    name: string;
    role: string;
    status: string;
};

export async function login(email: string, password: string): Promise<string> {
    const { token } = await apiRequest<{ token: string }>("/auth/login", {
        method: "POST",
        body: { email, password },
    });
    return token;
}

export async function fetchCurrentAdmin(token: string, signal?: AbortSignal): Promise<Admin> {
    const { admin } = await apiRequest<{ admin: Admin }>("/auth/me", { token, signal });
    return admin;
}
