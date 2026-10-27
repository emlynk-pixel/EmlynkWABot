// Runs one Candidate Registration load-test scenario against the LOCAL load-test backend.
//   npm run loadtest:reg -- REG-00 | REG-01 | REG-02
// Needs `npm run loadtest:backend` running (explicitly on .env.loadtest). Steps:
//   guard -> preflight (backend, identity range, auth) -> mint an ADMIN token -> auth-latency probe
//   -> DB / pool baseline -> k6 -> collect (k6 summary, pool metrics, DB deltas, unique_id findings).
// Secrets are never printed. The token is minted for the existing ACTIVE ADMIN of the load-test
// project (adminToken.mjs: LOADTEST_ADMIN_PASSWORD in the shell, or a real service_role key) and is only
// handed to k6 in its environment. Results go to performance-tests/results/ (ignored by Git).

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { acquireAdminToken } from "./adminToken.mjs";
import { REPO_ROOT, loadLoadTestEnv } from "./loadTestEnv.mjs";
import { connect, tableState, countsOf, pgStats } from "./dbState.mjs";

const cleanEnv = { ...process.env }; // before the load-test variables (and secrets) are applied

const SCENARIOS = {
    "REG-00": { script: "reg-00-smoke.js", runId: 1 },
    "REG-01": { script: "reg-01-baseline.js", runId: 2 },
    "REG-02": { script: "reg-02-5vus.js", runId: 3 },
};
const scenarioName = (process.argv[2] ?? "").toUpperCase();
const scenario = SCENARIOS[scenarioName];
if (!scenario) {
    console.error(`usage: runRegistration.mjs ${Object.keys(SCENARIOS).join(" | ")}   (10 / 20 VU scenarios are intentionally not available yet)`);
    process.exit(1);
}

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const SIDECAR = `http://127.0.0.1:${process.env.LOADTEST_METRICS_PORT || 3999}/__loadtest`;
const RUN_ID = Number(process.env.REG_RUN_ID ?? scenario.runId);
const JOB_TYPE = process.env.JOB_TYPE || "BARBENDER";
const abort = (message) => { console.error(`[loadtest] ABORT: ${message}`); process.exit(2); };

const summary = loadLoadTestEnv({ log: (line) => console.log(line) });

// ---------------------------------------------------------------- preflight
const health = await fetch(`${BASE_URL}/health`).catch(() => null);
if (!health?.ok) abort(`the backend is not answering at ${BASE_URL}. Start it with: npm run loadtest:backend`);
const sidecar = await fetch(`${SIDECAR}/metrics`).then((r) => r.json()).catch(() => null);
if (!sidecar) abort("the load-test metrics sidecar is not answering; the backend must be started with: npm run loadtest:backend");
if (sidecar.poolMax !== Number(summary.profile.DATABASE_POOL_MAX)) abort(`the running backend has pool max ${sidecar.poolMax}, expected ${summary.profile.DATABASE_POOL_MAX}`);

const db = await connect();
const base = RUN_ID * 10000;
const lo = `P9${String(base).padStart(6, "0")}`;
const hi = `P9${String(base + 9999).padStart(6, "0")}`;
const { rows: [taken] } = await db.query(`SELECT count(*)::int AS n FROM candidate WHERE passport_id BETWEEN $1 AND $2`, [lo, hi]);
if (taken.n) abort(`${taken.n} candidates already exist in this run's identity range (${lo}..${hi}). Restore the baseline first: node scripts/loadtest/dbState.mjs restore`);
const { rows: admins } = await db.query(`SELECT email, role, status FROM "user" WHERE role = 'ADMIN' AND status = 'ACTIVE' AND auth_user_id IS NOT NULL ORDER BY created_date LIMIT 1`);
if (!admins.length) abort("the load-test database has no ACTIVE, linked ADMIN user");
const { rows: [jt] } = await db.query(`SELECT count(*)::int AS n FROM job_type WHERE is_active AND lower(name) = lower($1)`, [JOB_TYPE]);
if (!jt.n) abort(`JOB_TYPE "${JOB_TYPE}" is not an active job type in the load-test database`);

// ---------------------------------------------------------------- token (load-test Supabase project)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
let token;
try {
    const acquired = await acquireAdminToken({
        supabaseUrl: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY, anonKey: cleanEnv.SUPABASE_ANON_KEY,
        email: admins[0].email, password: cleanEnv.LOADTEST_ADMIN_PASSWORD,
    });
    token = acquired.token;
    console.log(`[loadtest] auth: ADMIN session for load-test project ${summary.projectRef} (${acquired.method})`);
} catch (error) {
    abort(error.message);
}
const me = await fetch(`${BASE_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
const meBody = await me.json().catch(() => ({}));
if (me.status !== 200) abort(`the backend refused the ADMIN token on /auth/me (HTTP ${me.status})`);
console.log(`[loadtest] auth: the backend accepted the ADMIN session (HTTP 200, role ${meBody?.user?.role ?? meBody?.role ?? "?"})`);

// ---------------------------------------------------------------- Supabase auth latency (what requireActiveUser does per request)
const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    return { n: sorted.length, avgMs: Number((sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(1)), p50Ms: Number(at(0.5).toFixed(1)), p95Ms: Number(at(0.95).toFixed(1)), maxMs: Number(sorted.at(-1).toFixed(1)) };
};
const timeGetUser = async () => { const t = performance.now(); const { error } = await supabase.auth.getUser(token); if (error) throw new Error("auth.getUser failed"); return performance.now() - t; };
const sequential = []; for (let i = 0; i < 20; i++) sequential.push(await timeGetUser());
const concurrent = []; for (let round = 0; round < 4; round++) concurrent.push(...(await Promise.all(Array.from({ length: 5 }, timeGetUser))));
const authLatency = { sequential: stats(sequential), concurrent5: stats(concurrent) };
console.log(`[loadtest] supabase auth.getUser: sequential avg ${authLatency.sequential.avgMs}ms p95 ${authLatency.sequential.p95Ms}ms | 5 concurrent avg ${authLatency.concurrent5.avgMs}ms p95 ${authLatency.concurrent5.p95Ms}ms`);

// ---------------------------------------------------------------- baseline
const before = { counts: countsOf(await tableState(db)), pg: await pgStats(db) };
await fetch(`${SIDECAR}/reset`, { method: "POST" });
console.log(`[loadtest] ${scenarioName} baseline: ${JSON.stringify(before.counts)}`);

// ---------------------------------------------------------------- k6
const resultsDir = path.join(REPO_ROOT, "performance-tests", "results");
fs.mkdirSync(resultsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const summaryFile = path.join(resultsDir, `${scenarioName}-${stamp}.k6.json`);
const logFile = path.join(resultsDir, `${scenarioName}-${stamp}.k6.log`);
const k6Args = ["run", "--summary-export", summaryFile, "--summary-trend-stats", "avg,min,med,max,p(90),p(95),p(99)", path.join(REPO_ROOT, "performance-tests", "registration", scenario.script)];
console.log(`[loadtest] k6 ${scenario.script} (RUN_ID=${RUN_ID}, JOB_TYPE=${JOB_TYPE}, BASE_URL=${BASE_URL})`);
const startedAt = Date.now();
const k6Exit = await new Promise((resolve) => {
    const child = spawn("k6", k6Args, { env: { ...cleanEnv, BASE_URL, RUN_ID: String(RUN_ID), JOB_TYPE, ACCESS_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] });
    const log = fs.createWriteStream(logFile);
    child.stdout.on("data", (d) => { log.write(d); process.stdout.write(d); });
    child.stderr.on("data", (d) => { log.write(d); process.stderr.write(d); });
    child.on("close", (code) => { log.end(); resolve(code); });
    child.on("error", () => resolve(-1));
});
const durationS = (Date.now() - startedAt) / 1000;

// ---------------------------------------------------------------- collect
const pool = await fetch(`${SIDECAR}/metrics`).then((r) => r.json());
const afterState = await tableState(db);
const after = { counts: countsOf(afterState), pg: await pgStats(db) };
const { rows: made } = await db.query(`SELECT unique_id FROM candidate WHERE passport_id BETWEEN $1 AND $2 ORDER BY created_date`, [lo, hi]);
const uniqueIds = made.map((r) => r.unique_id);
const { rows: [uid] } = await db.query(`SELECT count(*)::int AS numeric_ids, coalesce(max(unique_id::int), 0) AS max_numeric FROM candidate WHERE unique_id ~ '^\\d+$'`);
await db.end();

const k6 = fs.existsSync(summaryFile) ? JSON.parse(fs.readFileSync(summaryFile, "utf8")).metrics : {};
const metric = (name) => k6[name]?.values ?? k6[name] ?? {};
const named = metric("http_req_duration{name:POST /api/admin/candidates}");
const dur = Object.keys(named).length ? named : metric("http_req_duration");
const count = (name) => metric(name).count ?? 0;
const result = {
    scenario: scenarioName, runId: RUN_ID, projectRef: summary.projectRef, k6Exit, thresholdsPassed: k6Exit === 0, durationS: Number(durationS.toFixed(1)),
    config: { poolMax: pool.poolMax, ...summary.profile },
    requests: count("http_reqs"),
    status: { s201: count("reg_201"), s409: count("reg_409"), s429: count("reg_429"), s503: count("reg_503"), s5xxOther: count("reg_5xx_other"), other: count("reg_other_status") },
    errorCodes: { CANDIDATE_EXISTS: count("reg_code_CANDIDATE_EXISTS"), NIC_EXISTS: count("reg_code_NIC_EXISTS"), WHATSAPP_EXISTS: count("reg_code_WHATSAPP_EXISTS"), TRY_AGAIN: count("reg_code_TRY_AGAIN") },
    latencyMs: { avg: dur.avg, p50: dur.med, p90: dur["p(90)"], p95: dur["p(95)"], p99: dur["p(99)"], min: dur.min, max: dur.max },
    httpReqFailedRate: metric("http_req_failed").rate ?? metric("http_req_failed").value,
    pool,
    authLatency,
    db: {
        before: before.counts, after: after.counts,
        created: Object.fromEntries(Object.keys(before.counts).map((t) => [t, after.counts[t] - before.counts[t]])),
        xactCommitDelta: after.pg.commits - before.pg.commits, xactRollbackDelta: after.pg.rollbacks - before.pg.rollbacks,
    },
    uniqueIds: { created: uniqueIds.length, distinct: new Set(uniqueIds).size, first: uniqueIds[0], last: uniqueIds.at(-1), numericIdsInTable: uid.numeric_ids, maxNumeric: uid.max_numeric },
    files: { summary: summaryFile, log: logFile },
};
const resultFile = path.join(resultsDir, `${scenarioName}-${stamp}.json`);
fs.writeFileSync(resultFile, JSON.stringify(result, null, 1));
console.log(`\n[loadtest] RESULT ${scenarioName}\n${JSON.stringify({ ...result, files: undefined }, null, 1)}\n[loadtest] saved ${path.relative(REPO_ROOT, resultFile)}`);
process.exit(0);
