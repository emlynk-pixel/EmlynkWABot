import { rateLimit } from "express-rate-limit";
import { createPostgresRateLimitStore } from "./postgresRateLimitStore.js";

// Generic rate limiter for API endpoints and static assets to prevent basic DoS.
export const API_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const API_RATE_LIMIT_MAX_REQUESTS = 1000; // 1000 requests per window
export const API_RATE_LIMIT_MESSAGE = "Too many requests. Please try again later.";

/**
 * Applies basic rate limiting per client IP. Counts are kept in PostgreSQL
 * (Step 5C), shared by every app instance. `prefix` keeps separately mounted
 * limiters counting separately, as they did in memory.
 */
export function createApiRateLimiter({
    windowMs = API_RATE_LIMIT_WINDOW_MS,
    limit = API_RATE_LIMIT_MAX_REQUESTS,
    prefix = "generic-api:",
    store = createPostgresRateLimitStore({ prefix }),
} = {}) {
    return rateLimit({
        windowMs,
        limit,
        store,
        skipSuccessfulRequests: false,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        identifier: "generic-api",
        handler: (req, res, next, options) => {
            res.status(options.statusCode).json({ message: API_RATE_LIMIT_MESSAGE });
        },
    });
}
