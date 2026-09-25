import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

// Built admin dashboard (admin/, `npm run admin:build`).
export const DEFAULT_ADMIN_DIST_DIR = fileURLToPath(new URL("../admin/dist", import.meta.url));

// Serves the admin single-page app under /admin:
// - /admin/assets/*: hashed build files, cached for a year; a missing asset
//   is a plain 404, never the app page.
// - other files in dist (e.g. favicon.svg): served as they are.
// - any other GET/HEAD path: index.html, so client-side routes such as
//   /admin/review work on reload. Never cached, so a new build is picked up.
// Same origin as the API, so no CORS; helmet's headers (CSP etc.) apply.
export function createAdminFrontendRouter({ distDir = DEFAULT_ADMIN_DIST_DIR } = {}) {
    const router = express.Router();
    const indexFile = path.join(distDir, "index.html");

    if (!fs.existsSync(indexFile)) {
        router.use((req, res) => {
            res.status(404).json({ message: "Admin dashboard is not built. Run: npm run admin:build" });
        });
        return router;
    }

    router.use("/assets", express.static(path.join(distDir, "assets"), {
        index: false,
        immutable: true,
        maxAge: "1y",
        fallthrough: true,
    }));
    router.use("/assets", (req, res) => res.sendStatus(404));

    router.use(express.static(distDir, { index: false, maxAge: 0 }));

    router.get(/.*/, (req, res) => {
        res.set("Cache-Control", "no-cache");
        res.sendFile(indexFile);
    });

    return router;
}
