// Runs one Candidate Form submission load test against the LOCAL load-test backend.
//   npm run loadtest:cf -- CF-01     20 candidates, 20 VUs, one burst
//   npm run loadtest:cf -- CF-02     100 candidates, at most 20 VUs, sustained
// Needs `npm run loadtest:backend` running (explicitly on .env.loadtest). Real flow only, one
// candidate = one link = one token = one submission:
//   guard -> preflight (backend, form config, sheet sync off, complete baseline that the database
//   still matches, no /verify failures in their window, free identities, answers accepted by the
//   server's own rules) -> ADMIN token -> create the candidates (POST /api/admin/candidates) -> one
//   share link each (POST /api/admin/candidates/:id/form-share) -> k6 (verify + open per candidate,
//   sequentially, then the measured submissions, then a second-submit lock probe) -> collect (k6
//   summary, pool metrics, DB deltas, form state of the run's candidates).
// Verdict: integrity (every candidate submitted exactly once, every row exactly once) and stability
// (no 5xx / 429 / 409, no rollbacks) always gate; latency gates only where the scenario says so
// (CF-01). Pool waiting is reported, never gating.
// Secrets are never printed. The link secrets exist only in a temporary targets file in the
// git-ignored results folder, which is deleted when the run ends. Results go to
// performance-tests/results/ (ignored by Git). Restore the baseline afterwards:
//   npm run loadtest:db -- restore

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { acquireAdminToken } from "./adminToken.mjs";
import { REPO_ROOT, loadLoadTestEnv } from "./loadTestEnv.mjs";
import { connect, tableState, countsOf, pgStats, compareWithSnapshot, latestSnapshot, defaultSnapshotDir } from "./dbState.mjs";
import { MAX_CANDIDATES, NIC_PREFIX, PASSPORT_PREFIX, WHATSAPP_PREFIX, identityFor, submitBodyFor } from "../../performance-tests/candidate-form/identity.js";

const cleanEnv = { ...process.env }; // before the load-test variables (and secrets) are applied

const SCENARIOS = {
    // candidates: unique candidates (links, tokens, submissions); vus: the most at once.
    "CF-01": { script: "cf-01-submit-20vus.js", candidates: 20, vus: 20, runId: 1, latencyGate: true },
    "CF-02": { script: "cf-02-sustained-100x20vus.js", candidates: 100, vus: 20, runId: 2, latencyGate: false },
};
// Reported for every scenario; gating only where latencyGate is set.
const P95_TARGET_MS = 6000;
const scenarioName = (process.argv[2] ?? "").toUpperCase();
const scenario = SCENARIOS[scenarioName];
if (!scenario) {
    console.error(`usage: runCandidateForm.mjs ${Object.keys(SCENARIOS).join(" | ")}`);
    process.exit(1);
}

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const SIDECAR = `http://127.0.0.1:${process.env.LOADTEST_METRICS_PORT || 3999}/__loadtest`;
const RUN_ID = Number(process.env.CF_RUN_ID ?? scenario.runId);
const JOB_TYPE = process.env.JOB_TYPE || "BARBENDER";
const N = scenario.candidates;
const abort = (message) => { console.error(`[loadtest] ABORT: ${message}`); process.exit(2); };
// Tables that drift on their own (rate-limit windows); not part of the "database is at its baseline" check.
const DRIFTING_TABLES = new Set(["rate_limits"]);

if (!Number.isInteger(RUN_ID) || RUN_ID < 0 || RUN_ID > 99) abort("CF_RUN_ID must be an integer 0..99");
if (N > MAX_CANDIDATES) abort(`at most ${MAX_CANDIDATES} candidates per run`);

const summary = loadLoadTestEnv({ log: (line) => console.log(line) });

// ---------------------------------------------------------------- preflight: configuration
const { isUsableTokenSecret, parseCandidateFormOrigin } = await import("../../src/config/candidateForm.js");
if (!isUsableTokenSecret(process.env.CANDIDATE_FORM_TOKEN_SECRET)) abort("CANDIDATE_FORM_TOKEN_SECRET in .env.loadtest is missing or too short; /verify would answer 503");
if (!parseCandidateFormOrigin(process.env.CANDIDATE_FORM_ORIGIN)) abort("CANDIDATE_FORM_ORIGIN in .env.loadtest is missing or invalid; no share link can be created");
if (process.env.SHEET_SYNC_ENABLED !== "false") abort("SHEET_SYNC_ENABLED must be false for a load test");

// ---------------------------------------------------------------- preflight: backend
const health = await fetch(`${BASE_URL}/health`).catch(() => null);
if (!health?.ok) abort(`the backend is not answering at ${BASE_URL}. Start it with: npm run loadtest:backend`);
const sidecar = await fetch(`${SIDECAR}/metrics`).then((r) => r.json()).catch(() => null);
if (!sidecar) abort("the load-test metrics sidecar is not answering; the backend must be started with: npm run loadtest:backend");
if (sidecar.poolMax !== Number(summary.profile.DATABASE_POOL_MAX)) abort(`the running backend has pool max ${sidecar.poolMax}, expected ${summary.profile.DATABASE_POOL_MAX}`);

// ---------------------------------------------------------------- preflight: database
const db = await connect();
const fail = async (message) => { await db.end().catch(() => {}); abort(message); };

// A complete baseline of THIS project exists, and the database is still at it, so the restore
// afterwards removes exactly what this run adds.
const snapshotFile = latestSnapshot();
if (!snapshotFile) await fail(`no baseline snapshot in ${defaultSnapshotDir()}. Take one: npm run loadtest:db -- snapshot`);
let baseline;
try {
    baseline = await compareWithSnapshot(db, snapshotFile);
} catch (error) {
    await fail(error.message);
}
if (!baseline.complete) await fail(`the latest baseline does not cover ${baseline.missing.join(", ")}. Restore with it, then take a new one: npm run loadtest:db -- restore, then npm run loadtest:db -- snapshot`);
const drifted = Object.entries(baseline.report).filter(([table, r]) => !DRIFTING_TABLES.has(table) && !r.identical).map(([table]) => table);
if (drifted.length) await fail(`the database is not at its baseline (${drifted.join(", ")} changed). Restore it first: npm run loadtest:db -- restore`);
console.log(`[loadtest] baseline: ${path.basename(snapshotFile)} (complete, database matches)`);

// The /verify limiters' failed attempts still inside their window (e.g. the 429s of an aborted run):
// setup's 20 verifications come from one IP, so they would start from those. Never cleared here;
// the run waits until the window has passed.
const { rows: [limiter] } = await db.query(
    `SELECT coalesce(max(hits), 0)::int AS hits, max(reset_at) AS reset_at FROM rate_limits
      WHERE (key LIKE 'public-verify-ip:%' OR key LIKE 'public-verify-passport:%') AND hits > 0 AND reset_at > now()`);
if (limiter.hits) await fail(`the /verify rate limiter still counts ${limiter.hits} failed attempt(s) until ${new Date(limiter.reset_at).toISOString()}. Wait until then and run again (the limiter is not bypassed or reset by the load test).`);

// This run's identities are free: passport, NIC and WhatsApp blocks of its own (identity.js).
const identities = Array.from({ length: N }, (_, i) => ({ n: i + 1, ...identityFor(RUN_ID, i + 1) }));
const passports = identities.map((c) => c.passportId);
const nics = identities.map((c) => c.nic);
const whatsapps = identities.map((c) => c.whatsappNumber.replace(/\D/g, ""));
const { rows: [taken] } = await db.query(
    `SELECT count(*)::int AS n FROM candidate WHERE upper(passport_id) = ANY($1::text[]) OR nic = ANY($2::text[]) OR whatsapp_number = ANY($3::text[])`,
    [passports, nics, whatsapps]);
if (taken.n) await fail(`${taken.n} candidates already use this run's identities (${passports[0]}..${passports.at(-1)}). Restore the baseline first: npm run loadtest:db -- restore`);
const { rows: [formRows] } = await db.query(`SELECT count(*)::int AS n FROM candidate_form_access WHERE passport_id = ANY($1::text[])`, [passports]);
if (formRows.n) await fail("form rows already exist for this run's identities. Restore the baseline first: npm run loadtest:db -- restore");
const { rows: admins } = await db.query(`SELECT email FROM "user" WHERE role = 'ADMIN' AND status = 'ACTIVE' AND auth_user_id IS NOT NULL ORDER BY created_date LIMIT 1`);
if (!admins.length) await fail("the load-test database has no ACTIVE, linked ADMIN user");
const { rows: jobTypes } = await db.query(`SELECT name FROM job_type WHERE is_active`);
const activeJobTypes = jobTypes.map((r) => r.name);
if (!activeJobTypes.some((name) => name.toLowerCase() === JOB_TYPE.toLowerCase())) await fail(`JOB_TYPE "${JOB_TYPE}" is not an active job type in the load-test database`);

// Every candidate's answers pass the server's own submission rules (read-only use of the parser).
const { parseSubmission } = await import("../../src/services/candidateFormDataService.js");
for (const { n } of identities) {
    const parsed = parseSubmission(submitBodyFor(RUN_ID, n, JOB_TYPE), { jobCategories: activeJobTypes });
    if (parsed.errors) await fail(`the answers of candidate ${n} would be refused: ${parsed.errors.map((e) => `${e.field} ${e.code}`).join(", ")}`);
}
console.log(`[loadtest] identities ${PASSPORT_PREFIX}.. ${passports[0]}..${passports.at(-1)} (NIC ${NIC_PREFIX}.., WhatsApp +${WHATSAPP_PREFIX}..) are free; ${N} answer sets accepted by parseSubmission`);

// ---------------------------------------------------------------- token (load-test Supabase project)
let token;
try {
    const acquired = await acquireAdminToken({
        supabaseUrl: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY, anonKey: cleanEnv.SUPABASE_ANON_KEY,
        email: admins[0].email, password: cleanEnv.LOADTEST_ADMIN_PASSWORD,
    });
    token = acquired.token;
    console.log(`[loadtest] auth: ADMIN session for load-test project ${summary.projectRef} (${acquired.method})`);
} catch (error) {
    await fail(error.message);
}
const admin = (route, body) => fetch(`${BASE_URL}/api/admin${route}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
});

// ---------------------------------------------------------------- baseline
const before = { counts: countsOf(await tableState(db)), pg: await pgStats(db) };
const { rows: [submittedBefore] } = await db.query(`SELECT count(*)::int AS n FROM candidate_form_access WHERE status = 'SUBMITTED'`);
console.log(`[loadtest] ${scenarioName} baseline: ${JSON.stringify(before.counts)}`);

// ---------------------------------------------------------------- candidates and their links (the real staff flow)
const resultsDir = path.join(REPO_ROOT, "performance-tests", "results");
fs.mkdirSync(resultsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const targetsFile = path.join(resultsDir, `${scenarioName}-${stamp}.targets.json`);
const targets = [];
const prepStarted = Date.now();
try {
    for (const c of identities) {
        const created = await admin("/candidates", { passportId: c.passportId, nic: c.nic, whatsappNumber: c.whatsappNumber, surname: c.surname, otherNames: c.otherNames, jobTypes: [JOB_TYPE] });
        if (created.status !== 201) throw new Error(`creating candidate ${c.n} failed: HTTP ${created.status} ${(await created.json().catch(() => ({}))).code ?? ""}`);
        const shared = await admin(`/candidates/${encodeURIComponent(c.passportId)}/form-share`);
        const link = await shared.json().catch(() => ({}));
        const linkSecret = typeof link.url === "string" ? new URL(link.url).hash.replace(/^#k=/, "") : "";
        if (shared.status !== 201 || !/^[A-Za-z0-9_-]{43}$/.test(linkSecret)) throw new Error(`creating the share link of candidate ${c.n} failed: HTTP ${shared.status} ${link.code ?? ""}`);
        targets.push({ n: c.n, passportId: c.passportId, nic: c.nic, linkSecret });
    }
} catch (error) {
    await fail(`${error.message}. Restore the baseline: npm run loadtest:db -- restore`);
}
if (new Set(targets.map((t) => t.linkSecret)).size !== N) await fail("two candidates received the same link secret");
fs.writeFileSync(targetsFile, JSON.stringify(targets), { mode: 0o600 });
const { rows: [open] } = await db.query(
    `SELECT count(*)::int AS links, count(DISTINCT l.passport_id)::int AS candidates, count(*) FILTER (WHERE a.status = 'UNLOCKED')::int AS unlocked
       FROM candidate_form_link l JOIN candidate_form_access a ON a.passport_id = l.passport_id
      WHERE l.passport_id = ANY($1::text[]) AND l.revoked_at IS NULL AND l.kind = 'SINGLE'`, [passports]);
if (open.links !== N || open.candidates !== N || open.unlocked !== N) {
    fs.rmSync(targetsFile, { force: true });
    await fail(`expected ${N} active links on ${N} UNLOCKED forms, found ${JSON.stringify(open)}. Restore the baseline: npm run loadtest:db -- restore`);
}
console.log(`[loadtest] ${N} candidates created, ${N} share links (one each, forms UNLOCKED) in ${((Date.now() - prepStarted) / 1000).toFixed(1)}s`);
const prepared = { counts: countsOf(await tableState(db)), pg: await pgStats(db) };

// ---------------------------------------------------------------- k6
await fetch(`${SIDECAR}/reset`, { method: "POST" });
const summaryFile = path.join(resultsDir, `${scenarioName}-${stamp}.k6.json`);
const logFile = path.join(resultsDir, `${scenarioName}-${stamp}.k6.log`);
const k6Args = ["run", "--summary-export", summaryFile, "--summary-trend-stats", "avg,min,med,max,p(90),p(95),p(99)", path.join(REPO_ROOT, "performance-tests", "candidate-form", scenario.script)];
console.log(`[loadtest] k6 ${scenario.script} (CF_RUN_ID=${RUN_ID}, JOB_TYPE=${JOB_TYPE}, BASE_URL=${BASE_URL})`);
const startedAt = Date.now();
const k6Exit = await new Promise((resolve) => {
    const child = spawn("k6", k6Args, { env: { ...cleanEnv, BASE_URL, CF_RUN_ID: String(RUN_ID), JOB_TYPE, CF_TARGETS_FILE: targetsFile, SIDECAR_URL: SIDECAR }, stdio: ["ignore", "pipe", "pipe"] });
    const log = fs.createWriteStream(logFile);
    child.stdout.on("data", (d) => { log.write(d); process.stdout.write(d); });
    child.stderr.on("data", (d) => { log.write(d); process.stderr.write(d); });
    child.on("close", (code) => { log.end(); resolve(code); });
    child.on("error", () => resolve(-1));
});
const durationS = (Date.now() - startedAt) / 1000;
fs.rmSync(targetsFile, { force: true });

// ---------------------------------------------------------------- collect
// Pool metrics: reset again by k6 after verify + form, so they cover the submissions (and the probe).
const pool = await fetch(`${SIDECAR}/metrics`).then((r) => r.json());
const after = { counts: countsOf(await tableState(db)), pg: await pgStats(db) };
const { rows: [form] } = await db.query(
    `SELECT count(*) FILTER (WHERE a.status = 'SUBMITTED')::int AS submitted,
            count(*) FILTER (WHERE a.status <> 'SUBMITTED')::int AS not_submitted,
            count(DISTINCT a.submit_key) FILTER (WHERE a.status = 'SUBMITTED')::int AS distinct_submit_keys,
            count(*) FILTER (WHERE a.submitted_via_link_id = a.unlocked_via_link_id)::int AS submitted_via_own_link,
            (SELECT count(*)::int FROM candidate_form_response r WHERE r.passport_id = ANY($1::text[])) AS responses,
            (SELECT count(*)::int FROM candidate_form_prefill_snapshot s WHERE s.passport_id = ANY($1::text[])) AS snapshots,
            (SELECT count(*)::int FROM candidate_form_draft d WHERE d.passport_id = ANY($1::text[])) AS drafts,
            (SELECT count(*)::int FROM candidate_form_sheet_sync q WHERE q.passport_id = ANY($1::text[])) AS sheet_outbox,
            (SELECT count(*)::int FROM candidate_form_link l WHERE l.passport_id = ANY($1::text[]) AND l.last_verified_at IS NOT NULL) AS links_verified
       FROM candidate_form_access a WHERE a.passport_id = ANY($1::text[])`, [passports]);
const { rows: [submittedAfter] } = await db.query(`SELECT count(*)::int AS n FROM candidate_form_access WHERE status = 'SUBMITTED'`);
await db.end();

const k6 = fs.existsSync(summaryFile) ? JSON.parse(fs.readFileSync(summaryFile, "utf8")).metrics : {};
const metric = (name) => k6[name]?.values ?? k6[name] ?? {};
const count = (name) => metric(name).count ?? 0;
const latency = (name) => { const d = metric(`http_req_duration{name:${name}}`); return { avg: d.avg, p50: d.med, p90: d["p(90)"], p95: d["p(95)"], p99: d["p(99)"], min: d.min, max: d.max }; };
const SUBMIT = "POST /api/public/candidate-details/submit";
const delta = (from, to) => Object.fromEntries(Object.keys(from.counts).map((t) => [t, to.counts[t] - from.counts[t]]));

const status = { s200: count("cf_submit_200"), s409: count("cf_submit_409"), s429: count("cf_submit_429"), s500: count("cf_submit_500"), s503: count("cf_submit_503"), s5xxOther: count("cf_submit_5xx_other"), other: count("cf_submit_other_status") };
const submitRequests = Object.values(status).reduce((a, b) => a + b, 0);
const submitLatency = latency(SUBMIT);
const submitFailedRate = metric(`http_req_failed{name:${SUBMIT}}`).rate ?? metric(`http_req_failed{name:${SUBMIT}}`).value;
// The submission phase: from the pool reset at the end of k6 setup to the start of teardown.
const submitPhaseMs = metric("cf_submit_phase_ms").value ?? null;
const rollbacksInK6 = after.pg.rollbacks - prepared.pg.rollbacks;
const verdict = {
    // Every candidate submitted exactly once, and every row written exactly once.
    integrity: {
        exactlyNSubmitted: form.submitted === N && form.not_submitted === 0,
        uniqueSubmitKeyEach: form.distinct_submit_keys === N,
        exactlyNResponses: form.responses === N,
        exactlyNPrefillSnapshots: form.snapshots === N,
        exactlyNSheetOutboxRows: form.sheet_outbox === N,
        noDraftsLeft: form.drafts === 0,
        submittedViaOwnLink: form.submitted_via_own_link === N && form.links_verified === N,
        // Across the whole table: exactly this run's candidates became SUBMITTED, nobody else.
        submittedDeltaIsN: submittedAfter.n - submittedBefore.n === N,
        secondSubmitRefused: count("cf_lock_probe_409") === 1,
    },
    // The system and the database held up: every submission answered 200, no error class at all.
    stability: {
        allNAnswered200: status.s200 === N && submitRequests === N,
        no500: status.s500 === 0 && status.s5xxOther === 0,
        no503: status.s503 === 0,
        no429: status.s429 === 0,
        no409: status.s409 === 0,
        failureRateUnder1pct: typeof submitFailedRate === "number" && submitFailedRate < 0.01,
        noRollbacks: rollbacksInK6 === 0,
    },
    latency: {
        [`p95Under${P95_TARGET_MS}ms`]: typeof submitLatency.p95 === "number" && submitLatency.p95 < P95_TARGET_MS,
    },
};
const allOf = (group) => Object.values(group).every(Boolean);
const outcome = {
    integrityPassed: allOf(verdict.integrity),
    stabilityPassed: allOf(verdict.stability),
    latencyPassed: allOf(verdict.latency),
    latencyGating: scenario.latencyGate,
    k6ThresholdsPassed: k6Exit === 0,
    // Reported, not gating: requests waited for a pooled connection.
    poolWaited: (pool.sampled?.peakWaiting ?? 0) > 0 || (pool.queries?.peakWaitingAtAcquire ?? 0) > 0,
};
const result = {
    scenario: scenarioName, runId: RUN_ID, projectRef: summary.projectRef, k6Exit, durationS: Number(durationS.toFixed(1)),
    passed: outcome.integrityPassed && outcome.stabilityPassed && (!scenario.latencyGate || outcome.latencyPassed),
    outcome,
    verdict,
    config: { poolMax: pool.poolMax, ...summary.profile, candidates: N, maxVus: scenario.vus, jobType: JOB_TYPE },
    candidates: { first: passports[0], last: passports.at(-1) },
    submit: {
        requests: submitRequests, status, alreadySubmitted: count("cf_code_ALREADY_SUBMITTED"),
        successRate: submitRequests ? Number((status.s200 / submitRequests).toFixed(4)) : 0,
        failedRate: submitFailedRate, latencyMs: submitLatency,
        phaseDurationS: submitPhaseMs === null ? null : Number((submitPhaseMs / 1000).toFixed(2)),
        throughputPerS: submitPhaseMs ? Number((status.s200 / (submitPhaseMs / 1000)).toFixed(2)) : null,
    },
    poolSummary: {
        peakActive: pool.sampled?.peakActive, peakWaiting: pool.sampled?.peakWaiting, avgActive: pool.sampled?.avgActive,
        avgAcquireWaitMs: pool.queries?.avgAcquireWaitMs, maxAcquireWaitMs: pool.queries?.maxAcquireWaitMs, queries: pool.queries?.count,
    },
    setup: { verifyLatencyMs: latency("POST /api/public/candidate-details/verify"), formLatencyMs: latency("POST /api/public/candidate-details/form") },
    lockProbe: { refusedWithAlreadySubmitted: count("cf_lock_probe_409") === 1 },
    pool,
    form,
    db: {
        before: before.counts, after: after.counts,
        createdByPreparation: delta(before, prepared), createdByK6: delta(prepared, after),
        k6Phase: { xactCommitDelta: after.pg.commits - prepared.pg.commits, xactRollbackDelta: after.pg.rollbacks - prepared.pg.rollbacks },
        wholeRun: { xactCommitDelta: after.pg.commits - before.pg.commits, xactRollbackDelta: after.pg.rollbacks - before.pg.rollbacks },
    },
    files: { summary: summaryFile, log: logFile },
};
const resultFile = path.join(resultsDir, `${scenarioName}-${stamp}.json`);
fs.writeFileSync(resultFile, JSON.stringify(result, null, 1));
console.log(`\n[loadtest] RESULT ${scenarioName}\n${JSON.stringify({ ...result, files: undefined }, null, 1)}\n[loadtest] saved ${path.relative(REPO_ROOT, resultFile)}`);
console.log(`[loadtest] ${result.passed ? "PASSED" : "FAILED"} (integrity ${outcome.integrityPassed ? "ok" : "FAILED"}, stability ${outcome.stabilityPassed ? "ok" : "FAILED"}, latency ${outcome.latencyPassed ? "ok" : "missed"}${scenario.latencyGate ? "" : " (reported only)"}). Restore the baseline: npm run loadtest:db -- restore`);
process.exit(0);
