// Where the admin JWT lives in this checkpoint (Phase 10, Checkpoint 1).
//
// sessionStorage: kept across reloads of this tab, gone when the tab or
// browser closes, never shared with other tabs, never sent automatically.
// The backend token itself expires after 1 hour. Moving to an httpOnly
// cookie is planned for Phase 12 (security hardening).
//
// Storage can be unavailable (private mode, blocked site data), so every
// access is guarded and a memory copy keeps the current tab working.

const KEY = "emlynk.admin.token";
let memoryToken: string | null = null;

// The memory copy is only used when sessionStorage itself is unavailable.
export function readToken(): string | null {
    try {
        return window.sessionStorage.getItem(KEY);
    } catch {
        return memoryToken;
    }
}

export function saveToken(token: string): void {
    memoryToken = token;
    try {
        window.sessionStorage.setItem(KEY, token);
    } catch {
        // memory copy only
    }
}

export function clearToken(): void {
    memoryToken = null;
    try {
        window.sessionStorage.removeItem(KEY);
    } catch {
        // nothing stored
    }
}

// Expiry (ms since epoch) from the JWT payload, or null if unreadable. Only
// used to sign out on time in the browser; the backend verifies the token.
export function tokenExpiresAt(token: string): number | null {
    try {
        const payload = token.split(".")[1];
        if (!payload) return null;
        const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
        const { exp } = JSON.parse(json) as { exp?: unknown };
        return typeof exp === "number" ? exp * 1000 : null;
    } catch {
        return null;
    }
}
