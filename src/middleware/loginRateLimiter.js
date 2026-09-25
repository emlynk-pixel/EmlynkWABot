import { rateLimit } from "express-rate-limit";

// Brute-force protection for POST /auth/login (SEC-004).
export const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const LOGIN_RATE_LIMIT_MAX_FAILURES = 5;
export const LOGIN_RATE_LIMIT_MESSAGE = "Too many login attempts. Please try again later.";

// Limits failed login attempts per client IP.
//
// - Only failures count (skipSuccessfulRequests): an admin who signs in
//   normally never uses up their own allowance.
// - Clients are told nothing about the email, password or account; the 429
//   body is the same for everyone.
// - Standard RateLimit / RateLimit-Policy headers (draft-8); the old
//   X-RateLimit-* headers are off.
//
// IP address: the key is req.ip. Express's "trust proxy" is left at its
// default (off), so req.ip is the address of the incoming connection, which
// is correct when clients connect directly (local development). Behind a
// reverse proxy or load balancer every request would appear to come from
// the proxy and share one allowance; in that setup "trust proxy" must be set
// to the exact number of proxies in front of the app (not simply `true`,
// which lets clients fake their IP with X-Forwarded-For).
//
// Store: in memory, which fits the current single server. Counts reset when
// the server restarts, and several app instances would each keep their own
// counts; running more than one instance needs a shared store (e.g. Redis).
export function createLoginRateLimiter({
    windowMs = LOGIN_RATE_LIMIT_WINDOW_MS,
    limit = LOGIN_RATE_LIMIT_MAX_FAILURES,
} = {}) {
    return rateLimit({
        windowMs,
        limit,
        skipSuccessfulRequests: true,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        identifier: "login",
        handler: (req, res, next, options) => {
            res.status(options.statusCode).json({ message: LOGIN_RATE_LIMIT_MESSAGE });
        },
    });
}
