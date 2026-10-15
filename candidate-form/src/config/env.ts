// The only configuration of the Candidate Extra Details form: where the
// backend's public API lives. Empty means "same origin". This app holds no
// database, Supabase, Google or Meta configuration and never needs any.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// "" (same origin), the normalised origin, or null when the value is unusable.
// https only, except a loopback address during development.
export function parseApiBaseUrl(value: string | undefined): string | null {
    const raw = (value ?? "").trim().replace(/\/+$/, "");
    if (raw === "") return "";
    try {
        const url = new URL(raw);
        const allowedProtocol = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
        if (!allowedProtocol || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
        return url.origin;
    } catch {
        return null;
    }
}

export const API_BASE_URL = parseApiBaseUrl(import.meta.env.VITE_API_BASE_URL);

export const isApiConfigured = API_BASE_URL !== null;

export function apiUrl(path: string): string {
    if (API_BASE_URL === null) throw new Error("API base URL is not configured");
    return `${API_BASE_URL}${path}`;
}
