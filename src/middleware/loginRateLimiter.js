import { rateLimit } from "express-rate-limit";
import { createPostgresRateLimitStore } from "./postgresRateLimitStore.js";

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
// Store: PostgreSQL (Step 5C, postgresRateLimitStore.js), shared by every app
// instance and kept across restarts, so several serverless instances can't
// each grant their own allowance. Tests may pass another store.
export function createLoginRateLimiter({
    windowMs1 = 5 * 60 * 1000, // 5 minutes
    limit1 = 5,
    windowMs2 = 20 * 60 * 1000, // 20 minutes
    limit2 = 8,
    store1,
    store2,
    store,
} = {}) {
    // For backwards compatibility in tests that pass a custom store.
    store1 = store1 || store || createPostgresRateLimitStore({ prefix: "login:t1:" });
    store2 = store2 || store || createPostgresRateLimitStore({ prefix: "login:t2:" });

    const handler = (req, res, next, options) => {
        res.status(options.statusCode).json({ message: LOGIN_RATE_LIMIT_MESSAGE, resetTime: req.rateLimit.resetTime.toISOString() });
    };

    const tier2 = rateLimit({
        windowMs: windowMs2,
        limit: limit2,
        store: store2,
        skipSuccessfulRequests: true,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        handler,
    });

    const tier1 = rateLimit({
        windowMs: windowMs1,
        limit: limit1,
        store: store1,
        skipSuccessfulRequests: true,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        handler,
    });

    return [tier2, tier1];
}

// Abuse protection for POST /auth/forgot-password.
export const RESET_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const RESET_RATE_LIMIT_MAX_REQUESTS = 5;
export const RESET_RATE_LIMIT_MESSAGE = "Too many password reset requests. Please try again later.";

/**
 * Limits password reset requests per client IP to mitigate email bombing / enumeration.
 */
export function createResetRateLimiter({
    windowMs = RESET_RATE_LIMIT_WINDOW_MS,
    limit = RESET_RATE_LIMIT_MAX_REQUESTS,
    store = createPostgresRateLimitStore({ prefix: "password-reset:" }),
} = {}) {
    return rateLimit({
        windowMs,
        limit,
        store,
        skipSuccessfulRequests: false,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        identifier: "password-reset",
        handler: (req, res, next, options) => {
            res.status(options.statusCode).json({ message: RESET_RATE_LIMIT_MESSAGE });
        },
    });
}

