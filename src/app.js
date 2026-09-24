import express from "express";
// Must load before the routes: supabase.js reads env vars at import time.
import "dotenv/config";
import authRoutes from "./routes/auth.js";
import whatsappRoutes from "./routes/whatsapp.js";

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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
