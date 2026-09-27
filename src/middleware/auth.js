import jwt from "jsonwebtoken";

export const JWT_ALGORITHM = "HS256";

// The cookie name that holds the admin JWT (Phase 12: httpOnly cookie
// replaces the sessionStorage approach). Named without a leading underscore
// so all proxies pass it through without modification.
export const AUTH_COOKIE_NAME = "emlynk_admin_token";

// Whether the Secure flag should be set: always in production; skipped in
// development (where HTTPS is usually absent). Tests set NODE_ENV=test,
// which also skips the flag so test fetch calls work without TLS.
export function isSecureContext() {
    return process.env.NODE_ENV === "production";
}

// Cookie options used both when setting and clearing the cookie.
export function authCookieOptions() {
    return {
        httpOnly: true,
        sameSite: "strict",
        secure: isSecureContext(),
        // No explicit Domain: defaults to the current host (same-origin).
        // No explicit Path: defaults to "/", so the cookie is sent on every request.
    };
}

// Require a valid JWT. Accepts:
//   1. An httpOnly cookie (Phase 12, preferred).
//   2. An Authorization: Bearer <JWT> header (kept for backward-compatible
//      tests and CLI tooling — the frontend no longer sends this).
export function authenticateAdmin(req, res, next) {
    // 1. Cookie (preferred, set by POST /auth/login).
    const cookieToken = req.cookies?.[AUTH_COOKIE_NAME];
    if (cookieToken) {
        return verifyToken(cookieToken, req, res, next);
    }

    // 2. Authorization header (tests / backward compatibility).
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
        const headerToken = authHeader.split(" ")[1];
        return verifyToken(headerToken, req, res, next);
    }

    return res.status(401).json({ message: "Authentication Token is required!" });
}

function verifyToken(token, req, res, next) {
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
        req.admin = decoded;
        next();
    } catch {
        return res.status(401).json({ message: "Invalid or Expired Token" });
    }
}
