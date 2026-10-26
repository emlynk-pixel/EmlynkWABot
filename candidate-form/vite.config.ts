/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { buildMetaContentSecurityPolicy } from "./csp";

// Candidate Extra Details public form. Deployed as its own Vercel project
// (Root Directory: candidate-form/), separate from the Admin app and the
// backend. It talks only to the backend's public API.

// Only variables starting with this prefix can reach the browser bundle. The
// form needs two, both public (not secrets): VITE_API_BASE_URL and the
// optional VITE_API_ADMIN_MOBILE_NUMBERS (the "Contact Admin" numbers). Any other
// variable, including any other VITE_* value, is never embedded.
const ENV_PREFIX = "VITE_API_";

// Production builds get the Content-Security-Policy <meta> from csp.ts:
// connect-src is exactly the configured API origin. An invalid
// VITE_API_BASE_URL fails the build. (frame-ancestors and the other headers a
// <meta> policy cannot carry are in vercel.json.) Not applied to the dev
// server, which needs inline scripts.
function contentSecurityPolicy(apiBaseUrl: string): Plugin {
    const policy = buildMetaContentSecurityPolicy(apiBaseUrl);
    return {
        name: "candidate-form-csp",
        apply: "build",
        transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: policy }, injectTo: "head-prepend" }],
    };
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, ".", ENV_PREFIX);
    return {
        envPrefix: ENV_PREFIX,
        // Static files copied as they are (robots.txt). Named "static" rather
        // than "public" so a generic "public/" ignore rule cannot drop it.
        publicDir: "static",
        plugins: [react(), contentSecurityPolicy((env.VITE_API_BASE_URL ?? "").trim())],
        server: { port: 5174, strictPort: true },
        preview: { port: 4174, strictPort: true },
        build: {
            outDir: "dist",
            emptyOutDir: true,
            // No source maps in the public bundle.
            sourcemap: false,
        },
        // Component tests (npm test): a browser-like document, no network.
        test: {
            environment: "jsdom",
            setupFiles: ["./src/test/setup.ts"],
            // The stylesheet is read as text by the layout test (FORM-004).
            css: true,
            restoreMocks: true,
            // The whole-journey tests fill every answer of the form (about 60 controls) through
            // user events; on a slow machine that can take longer than vitest's 5 s default.
            testTimeout: 20000,
        },
    };
});
