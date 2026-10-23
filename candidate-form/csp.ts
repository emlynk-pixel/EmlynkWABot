// Content-Security-Policy of the Candidate Extra Details form.
//
// Two layers, and the browser enforces BOTH (the effective policy is their
// intersection):
//   - a <meta> policy injected into index.html at build time (vite.config.ts),
//     the only place that knows the API origin. It owns every fetch directive;
//     connect-src is exactly the configured API origin ('self' only when the
//     API is served from the same origin), never "https:" or "*".
//   - an HTTP header policy in vercel.json with ONLY the directives a <meta>
//     policy cannot carry or that need no origin (frame-ancestors, base-uri,
//     form-action, object-src). It has no connect-src / default-src, so it
//     never widens or conflicts with the API boundary.
//
// Shared by vite.config.ts and the backend tests (test/publicCandidateDetails.test.js).

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const INVALID_API_BASE_URL = "VITE_API_BASE_URL must be an https:// origin with no path (http:// only for localhost)";

// "" for same origin, otherwise the API origin. Throws for anything else, so
// a bad value fails the build instead of producing a weaker policy.
export function apiOriginFor(apiBaseUrl: string): string {
    const raw = apiBaseUrl.trim().replace(/\/+$/, "");
    if (raw === "") return "";
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(INVALID_API_BASE_URL);
    }
    const allowedProtocol = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
    if (!allowedProtocol || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
        throw new Error(INVALID_API_BASE_URL);
    }
    return url.origin;
}

// The <meta> policy for the built index.html.
export function buildMetaContentSecurityPolicy(apiBaseUrl: string): string {
    const apiOrigin = apiOriginFor(apiBaseUrl);
    return [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        `connect-src ${apiOrigin || "'self'"}`,
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "upgrade-insecure-requests",
    ].join("; ");
}

// The header policy (must equal the Content-Security-Policy value in vercel.json).
export const HEADER_CONTENT_SECURITY_POLICY = "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'; upgrade-insecure-requests";
