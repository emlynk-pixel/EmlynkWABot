import express from "express";
import helmet from "helmet";
import authRoutes from "./routes/auth.js";
import whatsappRoutes from "./routes/whatsapp.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { trustProxyHops } from "./config/env.js";

// Builds the Express app without starting a server, so tests can use it.
// Environment variables must already be loaded (src/app.js does that first).
export function createApp() {
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
    app.use(helmet());

    app.use(
        express.json({
            // Keep the raw bytes for WhatsApp signature verification.
            verify: (req, res, buffer) => {
                req.rawBody = buffer;
            },
        })
    );

    app.use("/auth", authRoutes);
    app.use("/whatsapp", whatsappRoutes);

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
