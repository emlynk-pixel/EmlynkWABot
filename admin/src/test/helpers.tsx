import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import { AppRoutes } from "../App";
import { AuthProvider } from "../auth/AuthProvider";

// Synthetic admin and tokens only.
export const ADMIN = { adminId: "admin-1", email: "admin@example.invalid", name: "Test Admin", role: "ADMIN", status: "ACTIVE" };

// A JWT-shaped string with the given expiry (signature not checked here).
export function fakeJwt(expiresInSeconds = 3600): string {
    const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const now = Math.floor(Date.now() / 1000);
    return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ adminId: ADMIN.adminId, iat: now, exp: now + expiresInSeconds })}.signature`;
}

type Route = { status: number; body?: unknown };
export type FetchRoutes = Partial<Record<"POST /auth/login" | "GET /auth/me", Route | (() => Route)>>;

// Stub for the two backend endpoints the app calls; records every request.
export function stubBackend(routes: FetchRoutes) {
    const calls: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        const method = init.method ?? "GET";
        calls.push({ method, path, headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
        const route = routes[`${method} ${path}` as keyof FetchRoutes];
        const { status, body } = typeof route === "function" ? route() : route ?? { status: 404, body: { message: "Not found" } };
        return new Response(JSON.stringify(body ?? {}), { status, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { calls, fetchMock };
}

export function renderApp(initialPath = "/") {
    return render(
        <MemoryRouter initialEntries={[initialPath]}>
            <AuthProvider>
                <AppRoutes />
            </AuthProvider>
        </MemoryRouter>
    );
}
