import { rateLimit } from "express-rate-limit";

// Generic rate limiter for API endpoints and static assets to prevent basic DoS.
export const API_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const API_RATE_LIMIT_MAX_REQUESTS = 1000; // 1000 requests per window
export const API_RATE_LIMIT_MESSAGE = "Too many requests. Please try again later.";

/**
 * Applies basic rate limiting per client IP.
 */
export function createApiRateLimiter({
    windowMs = API_RATE_LIMIT_WINDOW_MS,
    limit = API_RATE_LIMIT_MAX_REQUESTS,
} = {}) {
    return rateLimit({
        windowMs,
        limit,
        skipSuccessfulRequests: false,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        identifier: "generic-api",
        handler: (req, res, next, options) => {
            res.status(options.statusCode).json({ message: API_RATE_LIMIT_MESSAGE });
        },
    });
}
