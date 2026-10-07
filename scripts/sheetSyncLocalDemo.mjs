// LOCAL TRY-OUT of the Google Sheet sync (Settings page, queue, worker).
//
//   npm run sheet:demo            (then, in another terminal: npm run admin:dev)
//
// Everything is throwaway and in this process:
//   - the database is PGlite (real PostgreSQL in memory) with every migration
//     in prisma/migrations applied: the .env DATABASE_URL (Supabase) is never
//     read or contacted;
//   - the "Google Sheet" is an in-memory fake (test/helpers/fakeGoogleSheet.js):
//     nothing here can reach Google or the real operational Sheet;
//   - the real API routers, auth, triggers, queue, engine and worker run as in
//     production code.
// Data disappears when you stop it (Ctrl+C).
//
//   --writes-off   run like the deployed default (SHEET_SYNC_ENABLED=false):
//                  the worker writes nothing and Sync Now is a dry run.
//
// Sign in at http://localhost:5173/admin (Vite, npm run admin:dev):
//   admin@example.invalid    / Local-Test-1!   (ADMIN: sees Settings)
//   manager@example.invalid  / Local-Test-1!   (MANAGER: no Settings)
// The fake Sheet can be inspected and poked at http://localhost:3101 (menu).

import http from "node:http";
import express from "express";
import cookieParser from "cookie-parser";

process.env.JWT_SECRET ??= "local-demo-jwt-secret-not-for-production-0123456789";

const writesEnabled = !process.argv.includes("--writes-off");
const API_PORT = Number(process.env.PORT || 3000);
const SHEET_PORT = 3101;
const PASSWORD = "Local-Test-1!";
const TAB = "Emlynk Candidate Operational Mirror";

const { createTestDatabase } = await import("../test/helpers/pgliteDatabase.js");
const { createFakeGoogleSheet, googleError } = await import("../test/helpers/fakeGoogleSheet.js");
const { createAuthRouter } = await import("../src/routes/auth.js");
const { createAdminRouter } = await import("../src/routes/admin.js");
const { createRequireActiveAdmin } = await import("../src/middleware/requireActiveAdmin.js");
const { hashPassword } = await import("../src/utils/password.js");
const { createCandidate, parseCandidateBody } = await import("../src/services/candidateService.js");
const { createCandidateAggregateReader } = await import("../src/services/candidateAggregateReader.js");
const { createGoogleSheetsAdapter } = await import("../src/services/googleSheetsAdapter.js");
const { createSheetSyncEngine } = await import("../src/services/sheetSyncEngine.js");
const { createSheetSyncStore } = await import("../src/services/sheetSyncStore.js");
const { createSheetSyncWorker } = await import("../src/services/sheetSyncWorker.js");
const { runSheetHealthCheck } = await import("../src/services/sheetHealthCheck.js");
const { readSheetSyncConfig, readSheetSyncTuning, sheetTargetHint } = await import("../src/config/sheetSync.js");
const { SHEET_HEADERS, SHEET_COLUMNS, SYSTEM_CANDIDATE_ID_INDEX } = await import("../src/services/sheetSchema.js");

console.log("Starting a throwaway PostgreSQL (PGlite) and applying the migrations...");
const database = await createTestDatabase();
const prisma = database.prisma;

// ---- seed: two admins and three candidates (synthetic)
const passwordHash = await hashPassword(PASSWORD);
await prisma.admin.create({ data: { adminId: "local-admin", name: "Local Admin", email: "admin@example.invalid", passwordHash, role: "ADMIN", status: "ACTIVE" } });
await prisma.admin.create({ data: { adminId: "local-manager", name: "Local Manager", email: "manager@example.invalid", passwordHash, role: "MANAGER", status: "ACTIVE" } });
const SEED = [
    { passportId: "N1000001", surname: "Perera", otherNames: "Kamal", nic: "199012345678", whatsappNumber: "+94770000001", jobTypes: ["Caregiver"], jobExperience: "3 years" },
    { passportId: "N1000002", surname: "Silva", otherNames: "Nimal", nic: "198512345678", whatsappNumber: "+94770000002", jobTypes: ["Electrician"], jobExperience: "5 years" },
    { passportId: "N1000003", surname: "Fernando", otherNames: "Anusha", nic: "965404378V", whatsappNumber: "+94770000003", jobTypes: ["Construction Worker"], jobExperience: "1 year" },
];
for (const body of SEED) await createCandidate({ db: prisma, values: parseCandidateBody(body, { creating: true }).values });

// ---- the fake Sheet and the real worker (all-in-memory)
const sheet = createFakeGoogleSheet({ tabName: TAB });
const env = {
    SHEET_SYNC_ENABLED: writesEnabled ? "true" : "false",
    SHEET_SPREADSHEET_ID: "local-demo-spreadsheet-id",
    SHEET_TAB_NAME: TAB,
    SHEET_SYNC_POLL_INTERVAL_MS: "2000",
};
const config = readSheetSyncConfig(env);
const tuning = readSheetSyncTuning(env);
const store = createSheetSyncStore({ db: prisma });
const worker = createSheetSyncWorker({
    store,
    engine: createSheetSyncEngine({
        reader: createCandidateAggregateReader({ db: prisma }),
        sheets: createGoogleSheetsAdapter({ config, sheetsClient: sheet.client }),
    }),
    healthCheck: () => runSheetHealthCheck({ env, sheetsClient: sheet.client }),
    config,
    tuning,
    targetHint: sheetTargetHint(config),
    log: {
        log: (line) => console.log("  worker>", line),
        warn: (line) => console.log("  worker>", line),
        error: (line) => console.log("  worker>", line),
    },
});
worker.start({ pollMs: 2000 });

// ---- the API (real routers; the same wiring as src/createApp.js minus WhatsApp)
const app = express();
app.use(cookieParser());
app.use(express.json());
const passThrough = (req, res, next) => next();
app.use("/auth", createAuthRouter({ db: prisma, loginLimiter: passThrough, apiLimiter: passThrough }));
app.use("/api/admin", createAdminRouter({ db: prisma, requireAdmin: createRequireActiveAdmin({ db: prisma }), apiLimiter: passThrough }));
app.get("/health", (req, res) => res.json({ status: "OK", demo: true }));
app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error("API error:", error?.name);
    res.status(500).json({ message: "Internal server error" });
});
const api = app.listen(API_PORT, "127.0.0.1");

// ---- a tiny inspector for the fake Sheet: http://localhost:3101
const col = (field) => SHEET_COLUMNS.findIndex((c) => c.field === field);
const SHOW = ["systemCandidateId", "passportNumber", "firstName", "otherName", "job", "ivsInterviewStatus", "passportCopy", "recordStatus", "lastMirroredAt"];
const page = (body) => `<!doctype html><meta charset="utf-8"><title>Fake Sheet (local demo)</title>
<style>body{font:14px system-ui;margin:24px;max-width:1100px}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:4px 8px}th{background:#eee}
code{background:#eee;padding:1px 4px}.warn{background:#fff3cd;padding:8px 12px;border:1px solid #e0c36c}</style>${body}`;
const sheetServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (html) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); };
    const back = () => { res.writeHead(302, { location: "/" }); res.end(); };
    if (url.pathname === "/outage") { // ?on=1 / 0: Google returns 503 for every call
        sheet.clearFailures();
        if (url.searchParams.get("on") === "1") sheet.failNext("*", googleError(503, { reason: "backendError", googleStatus: "UNAVAILABLE" }), 100000);
        return back();
    }
    if (url.pathname === "/tamper") { // edit a cell by hand, as staff might
        const row = Number(url.searchParams.get("row") || 2);
        sheet.setCell(row, col("firstName"), "EDITED BY HAND");
        return back();
    }
    if (url.pathname === "/header") { // ?broken=1 renames a header; 0 restores it
        const headers = [...SHEET_HEADERS];
        if (url.searchParams.get("broken") === "1") headers[5] = "RENAMED HEADER";
        sheet.setHeader(headers);
        return back();
    }
    if (url.pathname === "/duplicate") { // copies row 2 below itself (same AN)
        const existing = sheet.row(2);
        const next = sheet.dataRows().length + 2;
        existing.forEach((value, i) => sheet.setCell(next, i, value));
        return back();
    }
    if (url.pathname === "/run") { // queue a run from here (same as Settings -> Sync Now)
        const kind = url.searchParams.get("kind") === "test" ? "TEST_CONNECTION" : "RECONCILE";
        await store.requestRun({ kind, triggerSource: "OPERATOR" });
        return back();
    }
    const rows = sheet.dataRows();
    const state = await store.getState();
    const queue = await store.queueCounts();
    send(page(`
<h2>Fake Google Sheet <small>(in memory, local demo)</small></h2>
<p class="warn">Writes are <b>${writesEnabled ? "ENABLED (fake Sheet only)" : "DISABLED"}</b>. Nothing here touches Google or any real database.</p>
<p>Integration: <b>${state?.integrationState}</b> &middot; queue pending ${queue.pending}, failed ${queue.failed} &middot; Sheet rows: <b>${rows.length}</b>
&middot; header: <b>${sheet.row(1).join("|") === SHEET_HEADERS.join("|") ? "valid" : "BROKEN"}</b></p>
<p>Try: <a href="/tamper?row=2">edit a cell by hand</a> (Sync Now repairs it) &middot; <a href="/outage?on=1">Google outage ON</a> / <a href="/outage?on=0">OFF</a>
&middot; <a href="/header?broken=1">break header</a> / <a href="/header?broken=0">fix</a> &middot; <a href="/duplicate">duplicate row 2's ID</a>
&middot; <a href="/run?kind=reconcile">queue reconcile</a> &middot; <a href="/run?kind=test">queue test</a> &middot; <a href="/">refresh</a></p>
<table><tr><th>row</th>${SHOW.map((f) => `<th>${SHEET_COLUMNS[col(f)].column} ${SHEET_COLUMNS[col(f)].header}</th>`).join("")}</tr>
${rows.map((r, i) => `<tr><td>${i + 2}</td>${SHOW.map((f) => `<td>${String(r[col(f)]).replace(/</g, "&lt;")}</td>`).join("")}</tr>`).join("") || "<tr><td colspan='10'>(empty)</td></tr>"}</table>`));
});
sheetServer.listen(SHEET_PORT, "127.0.0.1");
void SYSTEM_CANDIDATE_ID_INDEX;

console.log(`
=====================================================================
 Google Sheet sync: LOCAL DEMO is running (nothing real is touched)
 Writes to the fake Sheet: ${writesEnabled ? "ENABLED" : "DISABLED (dry runs only)"}

 1. In another terminal:   npm run admin:dev
 2. Open:                  http://localhost:5173/admin
 3. Sign in (ADMIN):       admin@example.invalid   /  ${PASSWORD}
    Sign in (MANAGER):     manager@example.invalid /  ${PASSWORD}   (no Settings)
 4. Settings -> Google Sheet Sync   (sidebar, after Change Roles)
 5. Fake Sheet inspector:  http://localhost:${SHEET_PORT}
 Stop with Ctrl+C. All data is discarded.
=====================================================================`);

let stopping = false;
async function stop() {
    if (stopping) return;
    stopping = true;
    console.log("\nStopping...");
    await worker.stop({ timeoutMs: 3000 }).catch(() => {});
    api.close();
    sheetServer.close();
    await database.close().catch(() => {});
    process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
