// Vercel function entry (Phase 12, Step 5D): the Express app from
// src/httpHandler.js and nothing else. vercel.json rewrites /auth, /api,
// /whatsapp and /health to this function; Express sees the original path.
//
// Never src/app.js here: that is the long-running process entry (it listens
// on a port and starts the submission worker). vercel.json sets
// "framework": null so Vercel doesn't auto-detect src/app.js as an Express
// entry point.
import app from "../src/httpHandler.js";

export default app;
