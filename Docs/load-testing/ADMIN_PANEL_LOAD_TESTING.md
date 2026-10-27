# Admin Panel / Backend Load Testing

| | |
|---|---|
| Branch | `version/load-testing` (branched from `dev` at merge `d04b0f0`) |
| Commits in scope | `d830c40`, `2922dc7`, `343c4d3`, `15fc38f` |
| Environment | Local backend on `.env.loadtest`, dedicated load-test Supabase project |
| Test tool | k6 v2.2.0 |
| Results folder | `performance-tests/results/` (git-ignored) |
| Companion document | [`CANDIDATE_FORM_LOAD_TESTING.md`](CANDIDATE_FORM_LOAD_TESTING.md) |

Every number here comes from the saved result files listed in [Appendix A](#appendix-a-result-files). Anything without a saved file is labelled **Reported (no saved artifact)** or **Result unavailable**.

---

## 1. Scope

What exists in the repository, and what has saved results:

| Area | Scripts | Saved results | Status |
|---|---|---|---|
| Health smoke | `performance-tests/smoke.js` | none | scripts only |
| User / Auth | `auth-smoke.js`, `auth-me-baseline.js`, `auth-me-load-10vus.js`, `auth-me-load-20vus.js` | none | scripts only; see [Section 3](#3-userauth-testing) |
| Candidate Read / List | `candidates-baseline.js`, `candidates-load-5vus.js`, `candidates-load-10vus.js`, `candidates-load-20vus.js` | none | scripts only; see [Section 4](#4-candidate-readlist-testing) |
| Candidate Registration | `performance-tests/registration/reg-00` … `reg-04` + `scripts/loadtest/runRegistration.mjs` | 13 runs (REG-00 ×2, REG-01 ×2, REG-02 ×2, REG-03 ×1, REG-04 ×6) | **complete** |
| DB pool tuning | REG-04 at pool 15, 12, 5, 10, 13 | 6 REG-04 runs | **complete** |
| Candidate Form (public) | `performance-tests/candidate-form/` | CF-01 ×2, CF-02 ×1 | see the companion document |

`performance-tests/results/` contains only `REG-*` and `CF-*` result files, plus `backend.log` (9 lines) and `suite-after.txt` (a `node --test` unit-test run, not a load test).

---

## 2. Load-Test Environment

### 2.1 Isolation: `scripts/loadtest/loadTestEnv.mjs`

Every load-test command goes through `loadLoadTestEnv()`. It:

- loads `.env.loadtest` explicitly and **never falls back to `.env`**. It sets `DOTENV_CONFIG_PATH`, so the app's `import "dotenv/config"` reads `.env.loadtest`;
- aborts if `.env.loadtest` is missing, is not ignored by Git, or is tracked by Git;
- aborts if `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_BUCKET` is missing;
- aborts if the database and Supabase API point at different projects, or if the project is the same as the one in `.env`, `.env.local`, `.env.preview` or `.env.production`;
- removes `SHEET_SPREADSHEET_ID`, `SHEET_TAB_NAME` and `GOOGLE_APPLICATION_CREDENTIALS` from the process, so no real Google Sheet can be targeted;
- logs variable names and project refs only, never values.

### 2.2 Forced profile

```js
export const PROFILE = Object.freeze({ DATABASE_POOL_MAX: "13", LOAD_TEST_MODE: "true", SHEET_SYNC_ENABLED: "false" });
```

`PROFILE` **overrides** whatever `.env.loadtest` says. For example, the launcher logged `profile override DATABASE_POOL_MAX: 12 -> 13` while `.env.loadtest` held 12. To change the pool size for a test, `PROFILE.DATABASE_POOL_MAX` in `loadTestEnv.mjs` must be edited. Editing `.env.loadtest` has no effect.

| Setting | Effect |
|---|---|
| `DATABASE_POOL_MAX` | `max` of the `pg.Pool` behind Prisma (`src/config/prisma.js`, `PRISMA_POOL_MAX`; default 3 when unset) |
| `LOAD_TEST_MODE=true` | skips **only** the admin API rate limiter in `src/routes/admin.js` (commit `2922dc7`). Authentication and RBAC still apply. The public Candidate Form verify limiter is unaffected. |
| `SHEET_SYNC_ENABLED=false` | Google Sheet writes off. `startBackend.mjs` also aborts if sheet sync is enabled. |

### 2.3 Backend and metrics sidecar: `scripts/loadtest/startBackend.mjs`

`npm run loadtest:backend` starts `src/app.js` on `.env.loadtest`. It also serves a sidecar on `127.0.0.1:3999`:

- `GET /__loadtest/metrics`: pool state, peaks sampled every 25 ms (`peakTotal`, `peakActive`, `peakWaiting`, `avgActive`, `avgWaiting`, `minIdle`), and query counters (`count`, `avgExecMs`, `avgAcquireWaitMs`, `maxAcquireWaitMs`, `peakWaitingAtAcquire`).
- `POST /__loadtest/reset`: zeroes the peaks and counters.

The counters come from temporary instrumentation in `src/config/prisma.js` (commit `d830c40`). It wraps `pool.query`, so it counts non-transactional statements only. Prisma interactive transactions take a connection through `pool.connect()` (`@prisma/adapter-pg`) and are not in `count` or acquire wait, although they **are** in `peakActive` / `peakWaiting`, which sample the pool directly.

### 2.4 Database baseline: `scripts/loadtest/dbState.mjs`

`npm run loadtest:db -- counts | snapshot | verify | restore`.

- A snapshot stores the count, checksum and primary keys of each covered table, outside the repository (`~/EmlynkWABot-loadtest-artifacts/snapshots/`).
- Restore deletes rows that are not in the baseline and rewinds `candidate_unique_id_seq` to the highest numeric `unique_id` + 1.
- Covered tables: `candidate`, `candidate_stages`, `audit_logs`, `sheet_sync_queue`, `rate_limits`, plus the six candidate-form tables (see the companion document, Section 5).

### 2.5 Other tooling

| File | Purpose |
|---|---|
| `scripts/loadtest/adminToken.mjs` | ADMIN session for the load-test project: password sign-in with `LOADTEST_ADMIN_PASSWORD` (shell only), or a magic-link mint when a real `service_role` key is configured |
| `scripts/loadtest/migrateDeploy.mjs` | guarded `prisma migrate status/deploy` against the load-test DB only (`npm run loadtest:migrate`) |
| `scripts/loadtest/runRegistration.mjs` | REG scenario runner (`npm run loadtest:reg -- REG-0X`) |

---

## 3. User/Auth Testing

### 3.1 Scripts

| Script | Load | Target | Thresholds |
|---|---|---|---|
| `auth-smoke.js` | 1 VU × 1 | Supabase password sign-in, then `GET /api/admin/candidates` | — |
| `auth-me-baseline.js` | 1 VU × 10 iterations | `GET /auth/me` | p95 < 3000 ms, failed < 1 % |
| `auth-me-load-10vus.js` | 10 VUs, 1 m | `GET /auth/me` | p95 < 3000 ms, failed < 1 % |
| `auth-me-load-20vus.js` | 20 VUs, 1 m | `GET /auth/me` | p95 < 3000 ms, failed < 1 % |

They read `BASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `TEST_EMAIL` and `TEST_PASSWORD` from the environment.

### 3.2 Results

**Result unavailable.** No result, summary or log file for any of these scripts exists in `performance-tests/results/`, so their metrics and pass/fail status cannot be documented. If they were run, the output was not saved.

### 3.3 Related auth measurement that was saved

Every registration run (`runRegistration.mjs`) measures `supabase.auth.getUser(token)`, the same call `requireActiveUser` makes on every admin request. It does this 20 times sequentially and 4 × 5 times concurrently before k6 starts. Across the 13 saved REG runs:

| Measurement | Range of averages across runs |
|---|---|
| Sequential `auth.getUser` | 266.6 ms – 434.2 ms |
| 5 concurrent `auth.getUser` | 301.2 ms – 428.8 ms |

Every authenticated admin request therefore spends roughly 0.3–0.4 s on Supabase session verification before any database work. In every run the backend accepted the ADMIN token on `/auth/me` (HTTP 200); the runner aborts otherwise.

---

## 4. Candidate Read/List Testing

### 4.1 Scripts

| Script | Load | Endpoint | Thresholds |
|---|---|---|---|
| `candidates-baseline.js` | 1 VU × 10 iterations | `GET /api/admin/candidates?page=1&pageSize=1&search=N487569` | p95 < 3000 ms, failed < 1 % |
| `candidates-load-5vus.js` | 5 VUs, 1 m | same | same |
| `candidates-load-10vus.js` | 10 VUs, 1 m | same | same |
| `candidates-load-20vus.js` | 20 VUs, 1 m | same | same |

### 4.2 Results

**Result unavailable.** No saved result exists for any candidate-list script, so p95, errors, pass/fail and bottlenecks cannot be documented. Completion is not assumed.

The endpoint has temporary per-request timing that prints a `[PERF][GET /api/admin/candidates]` line to the backend console (commit `2922dc7`). That output was not saved to `performance-tests/results/`.

### 4.3 Application changes made for the candidate list

These changes exist in code even though no saved measurement shows their effect. They are listed in [Section 9.2](#92-application-code-changes-on-this-branch).

---

## 5. Candidate Registration Testing

### 5.1 Scenarios

Endpoint: `POST /api/admin/candidates` with an ADMIN token.

Each payload is unique: passport `P9` + 6 digits, NIC `990000` + 6 digits, WhatsApp `+9499` + 7 digits, job type `BARBENDER`. The digits are `seq = RUN_ID × 10000 + (VU − 1) × 100 + iteration`. The runner checks that the run's passport block is empty before starting.

| Scenario | Script | Run ID | Load | p95 threshold | Failed threshold |
|---|---|---|---|---|---|
| REG-00 | `reg-00-smoke.js` | 1 | 1 VU × 1 | — | — |
| REG-01 | `reg-01-baseline.js` | 2 | 1 VU × 20 | < 3000 ms | < 1 % |
| REG-02 | `reg-02-5vus.js` | 3 | 5 VUs × 10 | < 4000 ms | < 1 % |
| REG-03 | `reg-03-10vus.js` | 4 | 10 VUs × 10 | < 5000 ms | < 1 % |
| REG-04 | `reg-04-20vus.js` | 5 | 20 VUs × 10 (`maxDuration` 8 m) | < 5000 ms | < 1 % |

Each run records:

- HTTP status counts (201, 409, 429, 503, other 5xx) and error codes (`CANDIDATE_EXISTS`, `NIC_EXISTS`, `WHATSAPP_EXISTS`, `TRY_AGAIN`);
- latency percentiles;
- sidecar pool metrics;
- row deltas per table;
- `pg_stat_database` commit and rollback deltas;
- the `unique_id` values created (count and distinct).

### 5.2 All saved runs (chronological)

| Time (UTC) | Scenario | Pool | Requests | 201 | 503 | 5xx other | Failed | p50 | p95 | p99 | Max | Peak active | Peak waiting | Avg acquire | Rollbacks | k6 exit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 08:16 | REG-00 | 15 | 1 | 1 | 0 | 0 | 0 % | 2.69 s | 2.69 s | 2.69 s | 2.69 s | 1 | 0 | 0.14 ms | 0 | 0 |
| 08:33 | REG-01 | 15 | 20 | 20 | 0 | 0 | 0 % | 2.54 s | 2.77 s | 3.00 s | 3.06 s | 2 | 0 | 8.35 ms | 0 | 0 |
| 08:36 | **REG-02** | 15 | 50 | **41** | **9** | 0 | **18 %** | 3.90 s | **8.11 s** | 8.68 s | 9.16 s | 6 | 0 | 14.82 ms | **88** | 99 |
| — | *unique-ID fix applied (commit `343c4d3`)* | | | | | | | | | | | | | | | |
| 09:04 | REG-00 | 15 | 1 | 1 | 0 | 0 | 0 % | 2.60 s | 2.60 s | 2.60 s | 2.60 s | 2 | 0 | 155.57 ms | 0 | 0 |
| 09:05 | REG-01 | 15 | 20 | 20 | 0 | 0 | 0 % | 2.53 s | 2.67 s | 2.76 s | 2.79 s | 2 | 0 | 8.14 ms | 0 | 0 |
| 09:06 | REG-02 | 15 | 50 | 50 | 0 | 0 | 0 % | 2.49 s | 3.29 s | 3.79 s | 3.88 s | 6 | 0 | 13.39 ms | 0 | 0 |
| 09:22 | REG-03 | 15 | 100 | 100 | 0 | 0 | 0 % | 2.57 s | 3.72 s | 3.98 s | 4.08 s | 11 | 0 | 17.77 ms | 0 | 0 |
| 09:27 | **REG-04** | 15 | 200 | **154** | 0 | **46** | **23 %** | 2.84 s | 4.17 s | 4.63 s | 4.90 s | 15 | 6 | 71.97 ms | 0 | 99 |
| 09:46 | **REG-04** | 15 | 200 | **147** | 0 | **53** | **26.5 %** | 2.81 s | 4.23 s | 4.45 s | 4.65 s | 15 | 6 | 62.26 ms | 0 | 99 |
| 09:55 | REG-04 | **12** | 200 | 200 | 0 | 0 | 0 % | 3.79 s | 5.02 s | 5.76 s | 5.88 s | 12 | 9 | 181.60 ms | 0 | 99 |
| 09:57 | REG-04 | **5** | 200 | 200 | 0 | 0 | 0 % | 8.97 s | 9.47 s | 10.08 s | 10.18 s | 5 | 17 | 857.61 ms | 0 | 99 |
| 10:01 | REG-04 | **10** | 200 | 200 | 0 | 0 | 0 % | 4.41 s | 5.27 s | 5.94 s | 6.16 s | 10 | 12 | 275.73 ms | 0 | 99 |
| 10:05 | REG-04 | **13** | 200 | 200 | 0 | 0 | 0 % | 3.42 s | 5.56 s | 6.18 s | 6.35 s | 13 | 8 | 137.16 ms | 0 | 99 |

In every run, 409, 429, `CANDIDATE_EXISTS`, `NIC_EXISTS` and `WHATSAPP_EXISTS` were 0. `TRY_AGAIN` was 9 in the first REG-02 run and 0 in every other run. In the k6 logs, all 46 and all 53 REG-04 failures at pool 15 were `REG FAIL status=500`. In every successful run, the number of `unique_id` values created equals the number that are distinct.

### 5.3 REG-02 failure and the unique-ID fix

| | Before the fix (08:36) | After the fix (09:06) |
|---|---|---|
| Succeeded | 41 / 50 | 50 / 50 |
| `503 TRY_AGAIN` | 9 | 0 |
| p95 | 8.11 s | 3.29 s |
| Rollbacks | 88 | 0 |
| Peak waiting | 0 | 0 |

**Root cause** (from the investigation and commit `343c4d3`): `createCandidate` computed the next `unique_id` in the application. It read every candidate's `unique_id`, took the maximum + 1, and retried up to 5 times on a unique-constraint collision (`P2002` on `candidate_unique_id_key`). Concurrent registrations read the same maximum and collided. Some exhausted the retries and answered `503 TRY_AGAIN`, and every collision rolled back a transaction. The pool was not saturated (peak waiting 0), so this was a correctness defect in ID allocation, not a capacity limit.

**Fix (application code):** see [Section 9.2](#92-application-code-changes-on-this-branch), item 5. IDs are now drawn from a PostgreSQL sequence with `nextval()`.

### 5.4 REG-04 database pool tuning comparison

Same scenario (20 VUs × 10 = 200 registrations), different `PROFILE.DATABASE_POOL_MAX`:

| Pool | Success | Failed | Failure rate | p50 | p95 | p99 | Peak active | Peak waiting | Avg waiting | Avg acquire | Max acquire | Run time |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 5 | 200 / 200 | 0 | 0 % | 8.97 s | 9.47 s | 10.08 s | 5 | 17 | 13.97 | 857.61 ms | 2157.17 ms | 92.3 s |
| 10 | 200 / 200 | 0 | 0 % | 4.41 s | 5.27 s | 5.94 s | 10 | 12 | 8.26 | 275.73 ms | 1304.47 ms | 46.9 s |
| 12 | 200 / 200 | 0 | 0 % | 3.79 s | 5.02 s | 5.76 s | 12 | 9 | 5.86 | 181.60 ms | 1198.54 ms | 41.5 s |
| 13 | 200 / 200 | 0 | 0 % | 3.42 s | 5.56 s | 6.18 s | 13 | 8 | 4.71 | 137.16 ms | 1091.15 ms | 38.3 s |
| 15 (09:27) | 154 / 200 | 46 × 500 | 23 % | 2.84 s | 4.17 s | 4.63 s | 15 | 6 | 2.44 | 71.97 ms | 1105.63 ms | 30.4 s |
| 15 (09:46) | 147 / 200 | 53 × 500 | 26.5 % | 2.81 s | 4.23 s | 4.45 s | 15 | 6 | 2.02 | 62.26 ms | 1117.15 ms | 30.1 s |

`Run time` is the k6 process duration from the runner.

Interpretation:

- **Smaller pool:** no errors, but requests queue for connections. At pool 5, 17 requests waited at peak, the average acquire wait was 858 ms, and p95 rose to 9.47 s.
- **Larger pool:** less waiting and lower latency, until pool 15, where 23–26.5 % of registrations failed with HTTP 500. The lower p95 at pool 15 is computed over all requests, including fast failures (minimum 0.69–0.70 s against 2.79 s or more in the clean runs). **Pool 15 is not better because its p95 is lower.** It is the only size that lost registrations.
- **Pool 12** was selected by the team as the practical stable configuration for Candidate Registration: 0 errors, p95 5.02 s.
- **Pool 13** was also stable in testing: 0 errors, lower p50 and acquire wait than pool 12, but a higher tail (p95 5.56 s, p99 6.18 s) in this single run.
- **Pool 10** was stable with more waiting (p95 5.27 s).
- Each pool size ran once. The pool 12 / 13 differences are within what one run can show and should not be over-read.

**Current committed value:** `PROFILE.DATABASE_POOL_MAX` is **13** in `loadTestEnv.mjs`, and the Candidate Form tests (CF-01, CF-02) ran at 13. The team's choice of 12 for Candidate Registration is not what the committed load-test profile currently forces.

---

## 6. REG-04 Failure Investigation

### 6.1 Evidence

| Source | What it shows |
|---|---|
| `REG-04-2026-10-27T09-27-49-463Z.k6.log` | 46 × `REG FAIL status=500 code=-` |
| `REG-04-2026-10-27T09-46-51-447Z.k6.log` | 53 × `REG FAIL status=500 code=-` |
| Both result JSONs | `peakActive` 15 = pool max 15. No 409, 503 or domain error codes. |
| Backend console, **reported (no saved artifact)** | `[PRISMA_DIAGNOSTIC_ERROR]` entries: `PrismaClientUnknownRequestError`, Postgres code `XX000`, `EMAXCONNSESSION`, *max clients reached in session mode*, `pool_size` 15, on `findUnique` / `findFirst` and other Prisma queries |

The diagnostic logger that produced those entries is `logPrismaDiagnostic` in `src/middleware/errorHandler.js` (commit `d830c40`, marked temporary). It logs the Prisma error name, code, sanitised message, cause and the underlying Postgres error, with credentials redacted. Its output went to the backend console and was not saved to `performance-tests/results/`.

### 6.2 Why this produced HTTP 500

- The Supabase pooler (Supavisor) ran in **session mode** with a client limit of 15. Each backend pool connection holds one pooler session for as long as it lives.
- When the pooler refused a new session, Postgres reported `XX000` with `EMAXCONNSESSION`. Prisma raised it as `PrismaClientUnknownRequestError`, a non-domain error, so the app's error handler answered with a generic **500**.
- The failing calls were ordinary reads and writes (`findUnique`, `findFirst`, …), not validation. No `CANDIDATE_EXISTS`, `NIC_EXISTS` or `WHATSAPP_EXISTS` occurred, and every payload was unique.

This confirms the database connection limit as the root cause, not validation errors or duplicate candidate data.

### 6.3 A contributing factor visible in the tooling (analysis)

`runRegistration.mjs` opens its own `pg.Client` to the same `DATABASE_URL` (`connect()` in `dbState.mjs`) before k6 starts, and keeps it open until results are collected. During REG-04 at pool 15, the pooler therefore served up to 15 backend connections **plus** the runner's monitoring connection, which is more than a 15-client session limit. This follows from the code; per-client session counts were not captured. In production, other clients of the same pooler (workers, other instances) would take sessions in the same way, which is a further reason to keep the application pool below the pooler limit.

---

## 7. Threshold Decisions

| Item | Decision |
|---|---|
| Registration p95 threshold in scripts | 3 s (REG-01), 4 s (REG-02), **5 s** (REG-03, REG-04). Still in the code. |
| Later business discussion | about **6 s** was accepted as a practical p95 target for Candidate Registration. This is a team decision and is **not encoded** in the REG scripts, which still use 5000 ms. Under the 5 s threshold, every REG-04 run fails k6 (exit 99), including the error-free pool 10/12/13 runs. |
| Candidate Form | CF-01 uses p95 < 6 s. CF-02 has no latency threshold and gates on integrity and stability only (see the companion document). |
| Principle | Latency thresholds are service-level targets, not correctness rules. Reliability (status codes, failure rate) and data integrity (row counts, distinct IDs) are judged separately from latency. |

---

## 8. Problems, Failed Runs, Fixes

| Problem | Test | Root cause | Fix | Result |
|---|---|---|---|---|
| 9 / 50 registrations answered `503 TRY_AGAIN`, 88 rollbacks | REG-02 (08:36) | `unique_id` computed as max + 1 in the application; concurrent collisions exhausted the retries | Sequence-based allocation (`nextval`), migration `20261103120000_candidate_unique_id_sequence` (application change) | REG-02 50/50, 0 rollbacks; REG-03 100/100 |
| 46 and 53 of 200 registrations answered 500 | REG-04 at pool 15 | Session-mode pooler limit of 15 clients reached (`EMAXCONNSESSION`, reported) | Pool reduced below the pooler limit (12 or 13) through `PROFILE` | 200/200 at pools 5, 10, 12 and 13 |
| High latency, 17 waiting | REG-04 at pool 5 | Pool too small for 20 concurrent registrations | Larger pool (10–13) | p95 9.47 s → 5.02–5.56 s |
| Editing the pool in `.env.loadtest` had no effect | all | `loadLoadTestEnv` forces `PROFILE` over the file (`profile override DATABASE_POOL_MAX: 12 -> 13` logged) | Change `PROFILE.DATABASE_POOL_MAX` in `loadTestEnv.mjs` | Documented in [Section 2.2](#22-forced-profile) |
| Leftover candidates in reserved identity range | before re-running a scenario | Earlier runs' rows still present; the runner aborts with *"N candidates already exist in this run's identity range … Restore the baseline first"* | `npm run loadtest:db -- restore` | Before the Candidate Form work, the database held 301 candidates against a 101-candidate baseline (and 200 extra audit rows); restore cleared them |
| Admin API rate limiter in the way of load tests | all admin runs | 1000 requests / 15 min staff limiter | `LOAD_TEST_MODE=true` skips that limiter only (application change, `2922dc7`) | Auth and RBAC unaffected |
| ADMIN token could not be minted | runner | `.env.loadtest` holds an anon key in `SUPABASE_SERVICE_ROLE_KEY` | Password sign-in path using `LOADTEST_ADMIN_PASSWORD` from the shell (`adminToken.mjs`) | Runs proceed with password sign-in |
| Auth / candidate-list results | auth-me, candidates-* | not saved | **Not resolved** | Result unavailable ([Sections 3](#3-userauth-testing), [4](#4-candidate-readlist-testing)) |

---

## 9. Database and Query Analysis

### 9.1 Measured database behaviour (registration)

| Run | Queries (pooled) | Avg exec | Avg acquire | Max acquire | Commits | Rollbacks |
|---|---|---|---|---|---|---|
| REG-01 (09:05, 20 regs) | 140 | 219.54 ms | 8.14 ms | 1116.49 ms | 364 | 0 |
| REG-02 (09:06, 50 regs) | 310 | 218.49 ms | 13.39 ms | 1107.24 ms | 679 | 0 |
| REG-03 (100 regs) | 610 | 224.65 ms | 17.77 ms | 1144.55 ms | 1305 | 0 |
| REG-04 pool 5 (200) | 1228 | 219.94 ms | 857.61 ms | 2157.17 ms | 2611 | 0 |
| REG-04 pool 10 (200) | 1216 | 217.47 ms | 275.73 ms | 1304.47 ms | 2588 | 0 |
| REG-04 pool 12 (200) | 1216 | 226.31 ms | 181.60 ms | 1198.54 ms | 2799 | 0 |
| REG-04 pool 13 (200) | 1215 | 224.05 ms | 137.16 ms | 1091.15 ms | 2579 | 0 |
| REG-04 pool 15, 09:46 (147 ok) | 1041 | 219.39 ms | 62.26 ms | 1117.15 ms | 2286 | 0 |

Observations:

- **About 6 pooled queries per registration**, and the count does not change with the pool size (1215–1228 for 200).
- **Average execution time is flat at about 217–226 ms per statement** at every concurrency and pool size. It does not rise with load. The database itself was not the bottleneck; the time is consistent with network round trips from the local backend to the remote pooler. This is an inference from the flat timings, not a separate measurement.
- **Acquire wait is what changes with pool size** (8 ms → 858 ms). It drives the latency differences in [Section 5.4](#54-reg-04-database-pool-tuning-comparison).
- **Rollbacks:** 0 in every run after the unique-ID fix (88 before it). The pool-15 runs also recorded 0 rollbacks despite 46 and 53 failures. This is consistent with the pooler refusing the session before any transaction began; it was not traced per request.
- Pooled `queries` and acquire wait exclude statements inside Prisma interactive transactions (see [Section 2.3](#23-backend-and-metrics-sidecar-scriptsloadteststartbackendmjs)). `peakActive` and `peakWaiting` include them.

### 9.2 Application code changes on this branch

The branch **does** contain application changes. They are separate from the load-test tooling (`scripts/loadtest/`, `performance-tests/`) and are listed here with their purpose.

| # | Commit | Files | Change | Why | Measured impact |
|---|---|---|---|---|---|
| 1 | `d830c40` | `prisma/migrations/20261031120000_candidate_list_ordering_index/migration.sql`, `prisma/schema.prisma` | `CREATE INDEX "candidate_created_date_passport_id_idx" ON "candidate"("created_date" DESC, "passport_id" ASC)` | supports the candidate list's default ordering | not measured in saved results |
| 2 | `d830c40` | `src/config/prisma.js` | Prisma now uses an explicit `pg.Pool` (`max: PRISMA_POOL_MAX`), with a pool error logger and a `pool.query` wrapper that counts queries, acquire wait and execution time (`poolMetrics`). Marked **TEMPORARY**. | pool observability for the sidecar | the source of all pool metrics here |
| 3 | `d830c40` | `src/middleware/errorHandler.js` | `logPrismaDiagnostic`: sanitised `[PRISMA_DIAGNOSTIC_ERROR]` logging for candidate endpoints. Marked **TEMPORARY**. | diagnose 500s | identified `EMAXCONNSESSION` (reported) |
| 4 | `2922dc7` | `src/services/candidateService.js`, `src/services/candidateFormSubmissionService.js`, `src/routes/admin.js` | Candidate list query consolidation (see below), admin limiter bypass under `LOAD_TEST_MODE`, and a temporary `[PERF]` timing log on `GET /candidates` | candidate list latency; load-test throughput | **not measured in saved results** |
| 5 | `343c4d3` | `prisma/migrations/20261103120000_candidate_unique_id_sequence/migration.sql`, `src/services/candidateService.js` | `unique_id` from a sequence instead of max + 1 | REG-02 collisions | REG-02 41/50 → 50/50, rollbacks 88 → 0 |

**Change 4, candidate list (`GET /api/admin/candidates`).** From the commit `2922dc7` message and diff:

- **Before:** four separate Prisma relation queries per page: stages, required documents, the active job assignment, and verification.
- **After:** one parameterised SQL statement, `fetchConsolidatedCandidateRelations`. Prisma relation queries (`fetchFallbackCandidateRelations`) remain only as a fallback when `$queryRaw` is unavailable:

  ```sql
  SELECT p.passport_id AS "passportId",
         COALESCE((SELECT json_agg(json_build_object('stage', s.stage, 'completed', s.completed, 'testResult', s.test_result))
                   FROM candidate_stages s WHERE s.passport_id = p.passport_id), '[]'::json) AS "stages",
         COALESCE((SELECT json_agg(json_build_object('documentType', d.document_type, 'documentVariant', d.document_variant, 'verificationStatus', d.verification_status))
                   FROM documents d WHERE d.passport_id = p.passport_id AND d.document_type = ANY($REQUIRED_SUBMISSION_DOCUMENTS::text[])), '[]'::json) AS "documents",
         COALESCE((SELECT json_agg(json_build_object('jobId', j.job_id) ORDER BY j.job_id ASC)
                   FROM (SELECT jc.job_id FROM job_candidate jc
                          WHERE jc.passport_id = p.passport_id AND jc.is_active = true
                          ORDER BY jc.job_id ASC, jc.passport_id ASC LIMIT 1) j), '[]'::json) AS "jobAssignments",
         (SELECT json_build_object('detailsVerifiedAt', (v.details_verified_at AT TIME ZONE 'UTC'),
                                   'documentsVerifiedAt', (v.documents_verified_at AT TIME ZONE 'UTC'))
            FROM candidate_verification v WHERE v.passport_id = p.passport_id) AS "verification"
    FROM UNNEST($passportIds::text[]) AS p(passport_id)
  ```

- The count query and the base list query now run concurrently (`Promise.all`). So do the Form Submitted lookup and the form-conflict lookup.
- `pendingConflictsByCandidate` (`candidateFormSubmissionService.js`) accepts the rows the list query has already loaded (`extraSelect: CONFIRM_SELECT.candidate`), so `candidate` is not read a second time.
- `submittedFormPassportIds` no longer runs `SELECT to_regclass('public.candidate_form_access') IS NOT NULL` before every lookup.
- **Expected impact:** fewer round trips per list request (4 relation queries → 1, a removed existence check, a removed `candidate` re-read, and independent queries run in parallel). Each round trip costs about 220 ms here.
- **Observed impact:** none recorded, because no saved candidate-list result exists ([Section 4](#4-candidate-readlist-testing)).

**Change 5, unique-ID allocation.**

Before:

```js
const rows = await db.candidate.findMany({ select: { uniqueId: true } });
const highest = rows.reduce((max, { uniqueId }) => (/^\d+$/.test(uniqueId) ? Math.max(max, Number(uniqueId)) : max), 0);
return String(highest + 1).padStart(4, "0");
```

After:

```js
const [{ value }] = await db.$queryRaw`SELECT nextval('candidate_unique_id_seq')::text AS value`;
return formatUniqueId(value);
```

- The migration creates `candidate_unique_id_seq` (`BIGINT`, `MINVALUE 1`), sets it to the highest numeric `unique_id` + 1 (IDs matching `^[0-9]{1,18}$`), and revokes access from `anon` and `authenticated`.
- On a collision with an ID written outside the allocator, `catchUpUniqueIdSequence` advances the sequence (`setval(…, GREATEST(nextval(…), max numeric unique_id))`) before retrying. The 4-digit format is unchanged.
- The registration path no longer reads every candidate row.

**Status of these changes outside this branch:**

- Migrations `20261031120000` and `20261103120000` were applied to the **load-test** database only.
- The `dev` database was verified to lack the sequence migration, and the unique-ID fix has **not** been ported to `dev`, although the same race exists there.
- Changes 2, 3 and 4's `[PERF]` log are marked temporary ("REMOVE AFTER TESTING") and must be removed or reviewed before any merge.

---

## 10. How to Reproduce the Admin Load Tests

```powershell
# Baseline
npm run loadtest:db -- verify            # compare with the latest baseline
npm run loadtest:db -- restore           # back to the baseline

# Terminal 1: backend on .env.loadtest (pool = PROFILE.DATABASE_POOL_MAX)
npm run loadtest:backend

# Terminal 2: registration scenarios (ADMIN password of the LOAD-TEST project, this shell only)
$env:LOADTEST_ADMIN_PASSWORD = "<admin password of the load-test project>"
npm run loadtest:reg -- REG-00
npm run loadtest:reg -- REG-01
npm run loadtest:reg -- REG-02
npm run loadtest:reg -- REG-03
npm run loadtest:reg -- REG-04
npm run loadtest:db -- restore           # after each run, or at least before re-running a scenario
```

To repeat the pool comparison, change `PROFILE.DATABASE_POOL_MAX` in `scripts/loadtest/loadTestEnv.mjs`, restart `npm run loadtest:backend`, restore, then run REG-04. The runner aborts if the running backend's pool differs from `PROFILE`.

Auth and candidate-list scripts are plain k6 scripts, run directly:

```powershell
$env:BASE_URL = "http://localhost:3000"
$env:SUPABASE_URL = "<load-test project URL>"
$env:SUPABASE_ANON_KEY = "<load-test anon key>"
$env:TEST_EMAIL = "<load-test staff email>"
$env:TEST_PASSWORD = "<load-test staff password>"
k6 run performance-tests/auth-me-baseline.js
k6 run performance-tests/auth-me-load-10vus.js
k6 run performance-tests/auth-me-load-20vus.js
k6 run performance-tests/candidates-baseline.js
k6 run performance-tests/candidates-load-5vus.js
k6 run performance-tests/candidates-load-10vus.js
k6 run performance-tests/candidates-load-20vus.js
```

These scripts write no result file. To keep their output, add `--summary-export performance-tests/results/<name>.k6.json`.

`candidates-*.js` searches for passport `N487569`, which must exist in the load-test database.

Results from `runRegistration.mjs`, in `performance-tests/results/`:

- `REG-0X-<timestamp>.json`: runner result;
- `.k6.json`: k6 summary export;
- `.k6.log`: k6 console output.

---

## 11. Completed vs Remaining

| Area | Status | Notes |
|---|---|---|
| User / Auth | **Scripts only, results unavailable** | Supabase `auth.getUser` latency measured inside every REG run (0.27–0.43 s average) |
| Candidate Read / List | **Scripts only, results unavailable** | query consolidation implemented but not measured in saved results |
| Candidate Registration | **Complete** | REG-00 to REG-04, unique-ID fix verified, pool comparison at 5/10/12/13/15 |
| DB pool tuning (registration) | **Complete** | 12 selected by the team; 13 also stable; 15 fails at the session limit |
| Candidate Form (public) | **Executed** | CF-01 and CF-02; see [`CANDIDATE_FORM_LOAD_TESTING.md`](CANDIDATE_FORM_LOAD_TESTING.md) |
| Candidate Update / Workflow (stages, details) | Not started | no scripts |
| Documents (upload / verify) | Not started | no scripts |
| OCR | Not started | no scripts |
| Work Allocation | Not started | no scripts |
| Jobs | Not started | no scripts |
| Mixed workload (several personas at once) | Not started | no scripts |

---

## 12. Final Findings

### 12.1 What current admin/backend load testing proves

- Candidate Registration handles 20 concurrent registrations (200 in total) with **0 errors** and unique, distinct `unique_id` values when the pool stays below the pooler's session limit (pools 5, 10, 12 and 13).
- The concurrent registration defect (`503 TRY_AGAIN` from max + 1 ID allocation) was real, was caused by application logic, and is fixed on this branch by the sequence allocator.
- At pool 15, about a quarter of registrations failed with HTTP 500 because the session-mode pooler refused new clients (`EMAXCONNSESSION`, reported). The failure is a connection limit, not a data or validation problem.

### 12.2 Pool configuration findings

- Below the limit, a larger pool means less waiting and lower latency. Pool 5's p95 of 9.47 s fell to 5.02 s at pool 12.
- The application pool plus every other client of the same pooler (the runner's monitoring connection in tests; workers and other instances in production) must stay under the pooler's session limit. Pool 15 against a limit of 15 does not.
- Pool 12 (selected) and pool 13 were both stable. The committed load-test `PROFILE` currently uses 13.

### 12.3 Reliability findings

- 0 rollbacks and 0 domain-error responses in every run after the unique-ID fix.
- Statement execution time is flat at about 220 ms regardless of load. Latency under load comes from waiting for pool connections plus the network round trips per request, plus about 0.3–0.4 s of Supabase session verification per request.

### 12.4 Limitations

- Local backend against a remote load-test project. Production hosting, region, pooler mode and limits may differ.
- Each pool size and scenario ran once, so there is no variance data.
- Auth and candidate-list load results were not saved and are not part of these findings.
- Pool counters exclude statements inside interactive transactions.
- Several instrumentation changes on this branch are temporary and are not production code.

### 12.5 Recommended future tests (not implemented)

1. Re-run the auth (`auth-me-*`) and candidate-list (`candidates-*`) scripts with `--summary-export`, to get a before/after record of the list-query consolidation.
2. Repeat REG-04 at pools 12 and 13 several times to separate them reliably, and update REG thresholds to the accepted 6 s target if that is the agreed service level.
3. Add scenarios for candidate update/workflow, documents, OCR, work allocation, jobs, and a mixed workload.
4. Port the unique-ID sequence fix to `dev` as a proper migration, then remove or review the temporary instrumentation before merging.
5. Test against the deployment target (Vercel / Cloud Run and the production pooler mode) before drawing capacity conclusions for production.

---

## Appendix A. Result files

All files are in `performance-tests/results/` (git-ignored, local only). Each run has `.json` (runner result), `.k6.json` (k6 summary) and `.k6.log`.

| Run | File prefix |
|---|---|
| REG-00 (before fix / after fix) | `REG-00-2026-10-27T08-16-01-947Z`, `REG-00-2026-10-27T09-04-56-727Z` |
| REG-01 | `REG-01-2026-10-27T08-33-54-496Z`, `REG-01-2026-10-27T09-05-33-386Z` |
| REG-02 (failed / fixed) | `REG-02-2026-10-27T08-36-39-527Z`, `REG-02-2026-10-27T09-06-50-009Z` |
| REG-03 | `REG-03-2026-10-27T09-22-53-448Z` |
| REG-04 pool 15 | `REG-04-2026-10-27T09-27-49-463Z`, `REG-04-2026-10-27T09-46-51-447Z` |
| REG-04 pool 12 | `REG-04-2026-10-27T09-55-04-651Z` |
| REG-04 pool 5 | `REG-04-2026-10-27T09-57-38-113Z` |
| REG-04 pool 10 | `REG-04-2026-10-27T10-01-04-752Z` |
| REG-04 pool 13 | `REG-04-2026-10-27T10-05-05-918Z` |
