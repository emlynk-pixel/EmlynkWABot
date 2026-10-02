import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/auth.js";
import whatsappRoutes from "./routes/whatsapp.js";
import { createAdminRouter } from "./routes/admin.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { trustProxyHops } from "./config/env.js";
import { createAdminFrontendRouter, DEFAULT_ADMIN_DIST_DIR } from "./adminFrontend.js";

// Candidate documents are uploaded from the admin's browser straight to
// Supabase Storage, to a signed URL the API issues, so the admin page may
// connect there. A constant, not SUPABASE_URL: vercel.json serves the same
// CSP for the static admin pages and can't read the environment (a custom
// Supabase domain would have to be added in both places).
export const STORAGE_CONNECT_SRC = "https://*.supabase.co";

// Builds the Express app without starting a server, so tests can use it.
// Environment variables must already be loaded (src/app.js does that first).
// Options exist for tests: another admin build folder, fake-DB routers, and
// the /admin rate limiter (its default counts in PostgreSQL).
export function createApp({ adminDistDir = DEFAULT_ADMIN_DIST_DIR, authRouter = authRoutes, adminApiRouter = createAdminRouter(), adminFrontendLimiter } = {}) {
    const app = express();

    // Don't advertise the framework (SEC-015).
    app.disable("x-powered-by");

    // Unset: no proxy is trusted. See config/env.js.
    const hops = trustProxyHops();
    if (hops !== null) {
        app.set("trust proxy", hops);
    }

    // Standard security headers (nosniff, frame denial, HSTS, a strict CSP
    // for anything rendered). The API only returns JSON and plain text.
    // blob: is allowed for images and frames only: the admin Review Detail
    // shows a document it fetched with the admin's token as a local blob: URL
    // (no storage URL or credential in the page). Scripts stay 'self' only.
    // connect-src: see STORAGE_CONNECT_SRC.
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                "img-src": ["'self'", "data:", "blob:"],
                "frame-src": ["'self'", "blob:"],
                "connect-src": ["'self'", STORAGE_CONNECT_SRC],
            },
        },
    }));

    // Phase 12: parse cookies so authenticateAdmin can read the httpOnly JWT
    // cookie set by POST /auth/login. No secret is needed (the JWT has its
    // own signature); unsigned cookies are fine.
    app.use(cookieParser());

    app.use(
        express.json({
            // Keep the raw bytes for WhatsApp signature verification.
            verify: (req, res, buffer) => {
                req.rawBody = buffer;
            },
        })
    );

    app.use("/auth", authRouter);
    app.use("/whatsapp", whatsappRoutes);

    // Admin dashboard API: read-only plus the review actions (ACTIVE admin token required).
    app.use("/api/admin", adminApiRouter);

    // Admin dashboard (built React app from admin/), same origin as /auth.
    app.use("/admin", createAdminFrontendRouter({ distDir: adminDistDir, ...(adminFrontendLimiter ? { apiLimiter: adminFrontendLimiter } : {}) }));

    app.get("/health", (req, res) => {
        res.json({
            status: "OK",
            message: "Emlynk backend is running..!"
        });
    });

    // Must be registered last: after the body parser and every route.
    app.use(errorHandler);

    return app;
}
