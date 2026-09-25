/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Backend the dev server forwards API calls to (the Express app, `npm start`).
const apiTarget = process.env.ADMIN_API_PROXY_TARGET || "http://localhost:3000";

export default defineConfig({
    // Served by Express under /admin (src/adminFrontend.js), so every asset
    // URL is built with this prefix.
    base: "/admin/",
    plugins: [react(), tailwindcss()],
    server: {
        port: 5173,
        strictPort: true,
        // Same-origin API calls in development, like in production.
        proxy: {
            "/auth": { target: apiTarget, changeOrigin: false },
            "/health": { target: apiTarget, changeOrigin: false },
        },
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        sourcemap: false,
    },
    test: {
        environment: "jsdom",
        setupFiles: ["./src/test/setup.ts"],
        css: false,
        restoreMocks: true,
    },
});
