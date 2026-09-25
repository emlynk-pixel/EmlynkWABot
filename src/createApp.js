import express from "express";
import authRoutes from "./routes/auth.js";
import whatsappRoutes from "./routes/whatsapp.js";
import { errorHandler } from "./middleware/errorHandler.js";

// Builds the Express app without starting a server, so tests can use it.
// Environment variables must already be loaded (src/app.js does that first).
export function createApp() {
    const app = express();

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
