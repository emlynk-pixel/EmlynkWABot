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

// The administrators' contact mobile numbers for the "Contact Admin" section:
// comma-separated list of mobile numbers. Split by comma, trimmed, ignoring empty entries.
// A public contact setting, not a secret.
export function parseAdminMobileNumbers(value: string | undefined): string[] {
    if (!value) return [];
    return value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

// Read when needed (not at load), so a test can set it.
export const adminMobileNumbers = (): string[] => parseAdminMobileNumbers(import.meta.env.VITE_API_ADMIN_MOBILE_NUMBERS);

export const API_BASE_URL = parseApiBaseUrl(import.meta.env.VITE_API_BASE_URL);

export const isApiConfigured = API_BASE_URL !== null;

export function apiUrl(path: string): string {
    if (API_BASE_URL === null) throw new Error("API base URL is not configured");
    return `${API_BASE_URL}${path}`;
}
