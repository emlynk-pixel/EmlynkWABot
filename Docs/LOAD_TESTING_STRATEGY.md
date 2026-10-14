# Load Testing Strategy

**Status:** planning document. Nothing in it has been run, installed or changed. Written from a read-only review of the repository on branch `version/load-testing` (HEAD at the time: `d2a3667`, which includes the Work Allocation QA fixes).

**Scope of the review:** `src/`, `api/`, `vercel.json`, `prisma/`, `ocr-worker/`, `deploy/`, `Docs/08-cloud-deployment.md`, the admin app.

**Not yet known (needs an answer before the data and thresholds are final)** are collected in section 24. Anything marked *(unverified)* is something I could not confirm from the repository.

---

## 1. Current architecture assessment

### 1.1 Topology

```
Browser (React admin, static, served by Vercel from /admin)
   │  Supabase JS signs in directly against Supabase Auth  -> access token (JWT)
   ▼
Vercel function  api/index.js -> src/httpHandler.js -> Express app (src/createApp.js)
   region hnd1 (Tokyo), maxDuration 60 s, one pg.Pool per function instance
   │                       │
   │                       └─ Supabase Auth (HTTPS)   auth.getUser(token) on EVERY request
   ▼
Supabase PostgreSQL via Supavisor SESSION-mode pooler (aws-0-ap-northeast-1)
   ▲                       ▲
   │ polls (CAS claims)    │ polls (writer lease)
Cloud Run emlynk-submission-worker      Cloud Run emlynk-sheet-sync-worker
(asia-northeast1, min=max=1 instance,   (DB -> Google Sheet only, 10 s poll)
 2 OCR requests in flight)
   │ HTTPS + Google ID token
   ▼
Cloud Run emlynk-ocr-worker (asia-south1, Tesseract.js, 2 jobs + 10 waiting per instance)
```

- The admin API runs **only on Vercel** (serverless). `src/app.js` (listen + worker) is for local/Docker. The submission worker and Sheet worker are separate long-lived Cloud Run services that **poll PostgreSQL**; there is no other queue.
- Express 5, `helmet`, `express.json`, then `/auth`, `/whatsapp`, `/api/admin`, `/admin`, `/health`, error handler ([createApp.js](../src/createApp.js)).

### 1.2 What every authenticated admin request costs (the fixed overhead)

Before any business query runs, each `/api/admin/*` and `/auth/me` request does:

| Step | Where | Cost |
|---|---|---|
| 1. Rate-limit counter | `apiLimiter` -> [postgresRateLimitStore.js](../src/middleware/postgresRateLimitStore.js) | **One DB write** (`INSERT … ON CONFLICT DO UPDATE` on a single `rate_limits` row **per client IP**) plus an occasional cleanup `DELETE` |
| 2. Token check | [requireActiveUser.js](../src/middleware/requireActiveUser.js) -> [supabaseIdentity.js](../src/auth/supabaseIdentity.js) | **One HTTPS call to Supabase Auth** (`auth.getUser(token)`), deliberately not a local JWT check (so a signed-out session fails at once) |
| 3. Account lookup | same | **One DB read** of `public."user"` by `auth_user_id` (role/status are never taken from the token) |
| 4. Role + scope | `requireRole`, `candidateScope` | in-memory |

Consequences for load testing (the most important findings of this review):

1. **The backend amplifies authentication load.** "Reusing a token" does not avoid Supabase Auth: every API request still calls Supabase Auth once. API requests per second = Supabase Auth requests per second.
2. **Every request is also a DB write** (rate-limit upsert), and all requests from one IP hit **the same row**, so a single load generator serialises on one row lock.
3. **Each request spends at least two pool round-trips before the real work.**

### 1.3 Database access and pool behaviour

- [config/prisma.js](../src/config/prisma.js): `@prisma/adapter-pg`, `max = DATABASE_POOL_MAX` (default **3 per function instance**), `DATABASE_URL` = Supavisor **session-mode** pooler.
- Session mode is 1 client connection : 1 server connection for the life of the client. Each warm Vercel instance therefore holds up to 3 of Supabase's limited server connections. Under concurrency Vercel starts more instances, so total connections = instances × 3. The repo already records `P2024` pool-timeout errors from this ([prisma.js](../src/config/prisma.js) comment). **This is the most likely first bottleneck.** The Supabase plan's pooler/connection limits are *(unverified)*.
- Several handlers issue many queries at once with `Promise.all` (Overview ≈ 13, Daily Summary ≈ 10). With a pool of 3 those queue behind each other inside one request, so one report request can occupy an instance's whole pool.
- Interactive transactions: review actions set `{ maxWait: 10 s, timeout: 30 s }` ([adminReviewActionService.js:60](../src/services/adminReviewActionService.js#L60)). **Work Allocation assign/unassign use Prisma's defaults (maxWait 2 s, timeout 5 s)**, so under pool pressure or with 500 candidates they can fail with `P2028` before they fail on locks. Do not change yet; measure first.

### 1.4 Rate limiting ([apiRateLimiter.js](../src/middleware/apiRateLimiter.js))

- `express-rate-limit`, fixed window **15 minutes, 1000 requests per client IP**, counted in PostgreSQL, response 429 `{message}`.
- Applied to: all `/api/admin/*` (router-level), `/auth/me`, `/auth/complete-invite`, and the `/admin` static router (separate prefix).
- `/auth/*` and `/api/admin/*` use the **same default prefix** (`generic-api:`), so they share one counter per IP.
- Limit and window are **hard-coded constants**; there is no environment override. `/whatsapp/webhook` has no rate limiter (it has signature verification).
- IP comes from `X-Forwarded-For` through `TRUST_PROXY_HOPS` / `VERCEL=1` ([env.js](../src/config/env.js)).

What this means:

- **1000 requests / 900 s ≈ 1.1 requests/second per IP.** A single load generator (one IP) is rejected with 429 after roughly the first thousand requests, long before it measures application capacity. This applies to any single-machine k6 run.
- **Possible production issue, independent of load testing:** staff behind one office NAT share one bucket. A few admins each opening dashboard pages (several API calls per page) can approach 1000 requests in 15 minutes. Worth checking production logs for 429s from real users.

### 1.5 Endpoint classification

Key: R read, W write, **DB** DB-heavy, **CPU/mem** in-process work, **EXT** external dependency, **TX** transaction-sensitive.

| Area | Route(s) | Role | Type | Notes |
|---|---|---|---|---|
| Session | `GET /auth/me` | any active | R, EXT (Auth) | Fixed overhead only |
| Candidate list | `GET /api/admin/candidates?page&pageSize&search` | Admin, Manager, Analyst (scoped), Reg. Desk | R, DB | `COUNT` + `findMany` (≤100) + batched stages + batched documents ≈ 4 queries. Search is `contains` + insensitive over several columns (`ILIKE %x%`); no trigram/search index and no index on the `created_date` sort *(verified in migrations)* |
| Candidate detail | `GET /candidates/:passportId` (+ call-logs, additional-details) | same | R | passport resolve + several relations |
| Work Allocation | `GET /work-allocation/candidates`, `GET /work-allocation/analysts` | Admin, Manager | R, DB | list ≈ 4-5 queries; analysts: users + `groupBy` + unallocated anti-join |
| Allocation writes | `POST /work-allocation/assign`, `/unassign` | Admin, Manager | W, **TX**, DB | One interactive transaction: `SELECT … FOR UPDATE` on up to **500** candidates, `FOR SHARE` on users, `createMany`/`updateMany`, `audit_logs` `createMany`. Holds one pool connection and row locks for its duration |
| Review Queue | `GET /review`, `GET /review/:id` | Admin, Manager, Analyst | R, DB, mem | Merges pending + documents in memory over a window of up to `page*pageSize`; the summary loads **all** `REVIEW_REQUIRED` documents |
| Review file | `GET /review/:id/file` | same | R, **EXT (Storage)**, mem | Streams a file from Supabase Storage through the function. Not for the main benchmark |
| Review actions | `POST /review/:id/*`, `DELETE /temporary-documents/:id` | Admin, Manager, Analyst | W, TX, **EXT (Storage)** | Moves/deletes real objects. Exclude |
| Overview | `GET /overview` | Admin, Manager, Analyst | R, **DB-heavy**, mem | ≈ 13 parallel queries; `clientCompletenessCounts` and `policeDueCounts` each **load every in-scope candidate** and compute in memory. O(candidates) per call |
| Daily Report | `GET /reports/daily`, `/daily/summary`, `/daily/incomplete`, `/monthly` | Admin, Manager, Analyst | R, **DB-heavy**, mem | Summary reads progress of all in-scope candidates (`readProgress`) plus ≈10 parallel queries; lists bounded to 200 |
| Role summary | `GET /reports/daily/roles` | Admin, Manager | R | bounded to 1000 rows |
| Need Attention | `GET /follow-ups`, `POST /follow-ups/:id/complete`, `POST /candidates/:id/call-logs/:logId/follow-up` | candidate staff | R / W (small TX) | complete runs in a transaction |
| Call logs / history | `GET/POST /candidates/:id/call-logs` | candidate staff | R / W | Small writes; call-log writes do **not** touch the Sheet outbox |
| Audit logs | `GET /audit-logs` | Admin | R, DB | Append-only table that only grows; indexes are on `(admin_id, created_date)`, `(temporary_id, …)`, `(document_id, …)` *(verified)*; filters by action/category/date may scan |
| Clients / Documents / Missing / Police | `GET /clients`, `/documents`, `/documents/missing`, `/police` | Admin, Manager, Analyst | R, DB, mem | `/police` and `/documents/missing` compute over all in-scope clients in memory |
| Candidate writes | `POST /candidates`, `PUT /candidates/:id`, `PUT …/stages/:stage` | candidate staff | W | **Fire the Sheet outbox triggers** (see 1.6) |
| Document upload | `POST …/documents/upload-target`, `/finalize`, `/remove` | candidate staff | W, **EXT (Storage)** | Signed URL + storage move/delete. Exclude |
| Users | `POST /users/invite`, role change, deactivate | Admin | W, **EXT (Auth email)** | Sends real emails; changes the test accounts. Exclude |
| Sheet settings | `POST /settings/sheet-sync/run`, `/test` | Admin | W, **EXT (Google, via worker)** | Queues runs against the real Sheet. Exclude |
| Webhook | `POST /whatsapp/webhook` | Meta (HMAC) | W, EXT | Inserts submissions that the worker sends to OCR. Separate, isolated test only |

### 1.6 Side effects that make some writes unsafe on a shared database

1. **Sheet outbox triggers** (`20261006120000_sheet_sync_outbox`): inserts/updates on the candidate table, `candidate_stages` and `documents` write to `sheet_sync_queue`. If a Sheet worker is running against that database with `SHEET_SYNC_ENABLED=true`, load-test writes become real writes to the **operational Google Sheet** (the docs state there is no test copy). Work Allocation and call logs avoid these triggers by design; registration, candidate edits, stage updates and document changes do not.
2. **`audit_logs` is append-only and cannot be cleaned.** A trigger rejects `UPDATE`, `DELETE` and `TRUNCATE`. Every assign/reassign/unassign, flag/complete follow-up and registration adds permanent rows. The test suites clean it with `ALTER TABLE … DISABLE TRIGGER USER`, which needs elevated rights and must never be done on production. **Consequence: write-load tests need a disposable database.**
3. **`rate_limits`** gains one row per source IP; harmless, but it is the hot row from 1.2.

---

## 2. Recommended primary tool: k6

Verified against this repository:

- k6 **v2.1.0 is already installed** on this machine (`C:\Program Files\k6`). Nothing needs installing.
- The repo has no existing load tooling and **no CI configuration** (no `.github/`).
- The API is plain JSON over HTTP with a bearer token, so a protocol-level tool fits.

| | k6 | Artillery | JMeter | Locust | Playwright / Lighthouse |
|---|---|---|---|---|---|
| Setup | single binary, already present | `npm i`, Node-native | Java + GUI/XML plans | Python + pip | `npm i` + browsers |
| JS developer friendliness | JS scripts (not Node: no npm modules, ES modules only) | Best: YAML + Node functions | Poor (XML) | Python | Best (TS) |
| CI suitability | Very good (exit code on thresholds, headless) | Good | Heavy | Good | Good for UX, slow |
| Scripting flexibility | Scenarios, executors, setup/teardown, checks | Good, plugins | GUI-driven, verbose | Excellent (Python) | n/a (browser) |
| Auth support | Manual (HTTP in `setup()`) | Manual | Manual | Manual | Real browser sign-in |
| Thresholds | **Built in**, fail the run | `ensure` plugin | Via assertions / plugins | Manual | Budgets (Lighthouse CI) |
| Reports | JSON/CSV/summary, Prometheus/Grafana outputs | JSON/HTML | HTML dashboard | Web UI + CSV | HTML |
| Concurrency modelling | **Open model (arrival-rate) and closed model (VUs)**, ramping | Arrival phases | Thread groups | Users / spawn rate | Not for load |
| Maintainability | Small scripts, readable diffs | good | poor | good | good |

**Why k6:** built-in pass/fail thresholds, both closed (VU) and open (arrival-rate) workload models, ramping/spike/soak executors, low load-generator overhead (one machine can drive far more than the limited Vercel/Supabase capacity needs), and the binary is already installed. Artillery is the runner-up if the team prefers staying in Node; it is not clearly better for this system.

**What k6 does not do** (kept separate, section 14): browser rendering/UX timing (Lighthouse, Playwright), DB-side verification (a small Node/SQL script after runs), and OCR/Sheet worker tests.

---

## 3. Target endpoints and priority

Not equal weight: the cost differs by two orders of magnitude between a `GET /auth/me` and `GET /overview`.

| Pri | Endpoint | Method | Role | Expected DB load | Concurrency risk | Suitable | Cleanup |
|---|---|---|---|---|---|---|---|
| **P0** | `/overview` | GET | Manager (also Analyst scoped) | Very high (O(candidates) in memory, ≈13 queries) | Pool starvation, response time grows with data | Yes, scaled dataset | None |
| **P0** | `/reports/daily/summary`, `/incomplete` | GET | Manager / Analyst | High (all-candidate progress read) | Same | Yes | None |
| **P0** | `POST /work-allocation/assign` (+ reassign, unassign, multi-Analyst) | POST | Manager | High, TX, row locks | Lock waits, `P2028`, deadlock, 409 correctness | **Yes, disposable DB** | Required (audit rows stay) |
| **P0** | `GET /candidates` (list, paging) | GET | all | Medium-high (4 queries) | Pool | Yes | None |
| **P0** | `GET /candidates?search=` | GET | all | High (ILIKE scan) | Scales with table size | Yes, large dataset | None |
| P1 | `GET /work-allocation/candidates`, `/analysts` | GET | Manager | Medium | Pool | Yes | None |
| P1 | `GET /review`, `/review/:id` | GET | Manager / Analyst | Medium-high | Memory (window), summary loads all | Yes (not `/file`) | None |
| P1 | `GET /candidates/:id` | GET | all | Medium | Pool | Yes | None |
| P1 | `GET /follow-ups` (Need Attention) | GET | all | Medium | Pool | Yes | None |
| P1 | `GET/POST …/call-logs` (history) | GET/POST | Analyst | Low / small write | Write contention per candidate low | Yes, prefixed data | Required (rows + audit) |
| P1 | `POST /follow-ups/:id/complete`, flag | POST | Analyst | Small TX | OPEN-per-call unique index conflicts | Yes, controlled | Required |
| P2 | `GET /auth/me` | GET | all | 1 read | Auth/rate-limit overhead only | As baseline probe | None |
| P2 | `GET /reports/daily`, `/monthly` | GET | Manager | Medium | Pool | Yes | None |
| P2 | `GET /audit-logs` | GET | Admin | Medium, grows | Scans | Yes after write tests | None |
| P2 | `/clients`, `/documents`, `/police` | GET | all | Medium | In-memory `/police` | Optional | None |
| **Exclude** | `POST /candidates`, `PUT /candidates/:id`, stages | W | | Fires Sheet outbox | | Only with Sheet worker absent (see 6) | Required |
| **Exclude** | uploads, `/review/:id/file`, review actions, `DELETE /temporary-documents` | | | Supabase Storage | | Separate small storage test | |
| **Exclude** | users invite/role/deactivate, sheet-sync run/test, `/whatsapp/webhook` | | | Real emails / Google / Meta | | Never in the main run | |

---

## 4. Environment strategy

**Rule: never production, and never the shared development/staging database for write tests.**

Recommended, in order of preference:

1. **Dedicated load-test stack (preferred).** Own Supabase project (own Auth, own database, own Storage), own Vercel deployment (a branch preview or separate project) pointing at it, **no Cloud Run workers attached** (or workers attached with `SHEET_SYNC_ENABLED` unset and the OCR URL unreachable/mocked). Reasons: the audit log cannot be cleaned, the Auth load is multiplied by the request rate (1.2), and nothing shared can be hurt.
2. **Disposable copy of staging** (Supabase branch / restore of a backup) if a second project is not possible. Same rule: no live workers.
3. **App-capacity benchmark outside Vercel/Supabase Auth.** A local Node process built with `createApp` and the already-supported injected `verifyAccessToken` (used by the test suites), against a local/disposable PostgreSQL. Measures the Express + Prisma + SQL cost without Supabase Auth or Vercel in the way. Useful to separate "the code is slow" from "the platform limit is hit". **Needs a small harness script, not a business-logic change; not part of this task.**

Platform limits to check before the first real run:

| Area | Risk | Action |
|---|---|---|
| Vercel | Function concurrency / instance count, plan limits, `maxDuration 60 s`, hnd1 region, cold starts, possible "fair use" throttling on preview deployments *(plan unverified)* | Read the project's plan limits; ramp slowly; watch instance count in Vercel logs |
| Supabase pooler | Session-mode client/connection ceiling ≈ instances × 3 *(plan limits unverified)* | Check Dashboard > Database > Connection pooling and max connections for the load-test project |
| Supabase Auth | Per-project/IP limits; the app calls `getUser` per request | Use a dedicated project; read Auth > Rate Limits; keep auth tests small |
| Cloud Run | Autoscaling (min=max=1 submission worker) | Not in the API benchmark; separate OCR/worker plans |
| Rate limiting | 1000/15 min per IP | See section 17 |
| Shared database | Noisy neighbours, polluted audit log | Disposable database |
| External APIs | Meta, Google, Supabase Storage/Email | Section 16 |

**Mock / disable / isolate:** Sheet worker (absent or `SHEET_SYNC_ENABLED` unset), submission worker and OCR (absent; no webhook traffic), user invites (not called), Storage endpoints (excluded), Meta webhook (excluded). The app sends **no outbound WhatsApp messages** (it only downloads inbound media), so WhatsApp cannot be spammed by admin-API load; the real risks are Storage, Auth email, Sheets and OCR.

---

## 5. Test data strategy

### 5.1 Accounts (created through `npm run user:create` or Supabase Auth admin on the **load-test project only**)

| Account | Role | Use |
|---|---|---|
| `lt-admin` | ADMIN | audit logs, global reads |
| `lt-manager-a`, `lt-manager-b` | MANAGER | Work Allocation, two for the concurrency test, reports |
| `lt-analyst-a`, `lt-analyst-b` (+ a few more for multi-Analyst distribution) | ANALYST | scoped reads, call logs, history |
| `lt-desk` | REGISTRATION_DESK | list/detail reads (unscoped) |

Use throwaway e-mail addresses on a domain/inbox you control, strong generated passwords kept in the runner's environment (never in the repo).

### 5.2 Candidates

All created by a seed script run **against the load-test database only**, with predictable prefixes so cleanup and verification can target them:

- Passport IDs `LT` + 7 digits (`^[A-Za-z0-9]{1,20}$` is the API's pattern), unique IDs from a reserved range, NICs `LT…`-based and WhatsApp/contact numbers from a clearly fake range (no real number; nothing in the app messages candidates).
- Groups: unallocated (bulk of the Work Allocation pool); allocated to Analyst A; allocated to Analyst B; with documents (verified, review-required) and without; with call logs and open follow-ups (Need Attention); review items (pending submissions linked and unlinked); candidates registered across several days for the Daily Report.
- Separate **allocation-concurrency pool** (`LTA…`, e.g. 500 candidates), reset before each run.

### 5.3 Dataset sizes (to be confirmed, see section 24)

| Dataset | Candidates | Purpose |
|---|---|---|
| Small | 1,000 | smoke, script correctness |
| Baseline | ≈ current production size | normal/peak baseline |
| Growth | 3-5× baseline | shows how Overview/Reports/search scale (they are O(candidates)) |

### 5.4 Cleanup

- **Preferred:** reset the whole disposable database (restore snapshot / recreate branch) between write-test runs. This is the only way to clear `audit_logs`.
- Targeted cleanup (disposable DB only, never shared): delete rows where passport ID starts with `LT`; `audit_logs` needs the trigger disabled (elevated rights), which is another reason not to do this on a shared database.
- Read-only runs need no cleanup.
- Record the seed version and row counts in each result report.

---

## 6. Authentication strategy

How auth works today: the browser signs in with Supabase JS (`signInWithPassword`), then sends `Authorization: Bearer <access token>`. The backend verifies it with Supabase Auth on every request, then reads role/status from `public."user"`.

Separate the two kinds of test:

1. **Authenticated application load test (the main one).** Obtain one session per test account **once, in k6 `setup()`** (Supabase `POST /auth/v1/token?grant_type=password`), share the tokens with the VUs, and reuse them. Access tokens are short-lived (default about 1 hour *(project setting, verify)*), so soak tests must refresh with the refresh token. Many VUs share a small number of identities, which is realistic enough for an admin tool with a handful of staff.
   - Why not log in per VU: it would load Supabase Auth with sign-ins that real users do rarely, hit sign-in rate limits, and measure Supabase rather than Emlynk.
   - Note (1.2): reuse does **not** remove Auth load; each request still triggers `getUser`. That load is part of the system under test and is why the load-test project must be its own.
2. **Auth load test (small, deliberate).** A separate script that signs in N users at a modest rate and calls `/auth/me`, to check login-burst behaviour and the Auth rate limits. Run it rarely, on the load-test project only.

Also test the **session-end path** once (expired/invalid token returns 401 quickly and cheaply) and that a deactivated user is refused on the next request (already covered functionally by backend tests).

---

## 7. Load profiles

Initial values only; they are not final until the pool/instance limits in section 4 are known. "VUs" use think time between iterations (3-10 s), so 100 VUs is roughly 10-35 requests/second, not 100 concurrent requests.

| Profile | Shape | Purpose |
|---|---|---|
| **A. Smoke** | 1-5 VUs, 1-2 min | Script correctness, auth works, baseline numbers, thresholds sane |
| **B. Normal** | ramp to 10-25 VUs over 2 min, hold 10 min | Expected daily admin use. Baseline for comparisons |
| **C. Peak** | ramp 0 -> 50 -> 100 VUs, hold 10 min each step | Busy operational period; first look at pool/instance limits |
| **D. Stress** | +10 VUs every 2 min until a threshold fails or errors > 5 % | Find the breaking point and the failure mode |
| **E. Spike** | 5 -> 100 VUs in ~10 s, hold 3 min, back to 5, watch recovery | Cold starts, pool exhaustion, recovery time |
| **F. Soak** | 20-30 VUs, 30-60 min | Memory/connection leaks, slow degradation, token refresh |

Use the **open model (arrival rate)** for stress/spike on read endpoints (it keeps pressure constant when responses slow down) and the closed VU model for realistic user flows. Add a 1-2 minute warm-up before measuring (cold starts, plan caches).

---

## 8. Realistic user scenarios (weighted)

Normal-load mix (percentages of VUs; adjust once real usage is known):

| Persona | Weight | Iteration |
|---|---|---|
| Candidate reader (Reg. Desk / Analyst) | 40 % | list page 1 -> search by passport/phone/name -> open detail -> open call history |
| Analyst | 25 % | list assigned candidates -> open detail -> add call log (every ~5th iteration) -> view history -> Need Attention list |
| Manager | 10 % | Work Allocation list + analysts -> assign a small batch (5-20) from the prefixed pool -> occasional reassign |
| Reviewer | 10 % | review queue -> open an item detail (no file, no action) |
| Reporter | 15 % | Overview -> Daily Summary -> incomplete drill-down (few per minute, they are heavy) |

Think time 3-10 s per step, randomised. Endpoint-stress scenarios (one endpoint hammered) are separate, clearly named scripts, not mixed into the normal profile.

---

## 9. Work Allocation concurrency test (critical)

**Goal:** prove allocation stays correct when managers overlap. Existing backend tests already cover two concurrent managers on one candidate set; this extends it to sustained and larger overlap under platform load.

Setup: a reset pool of controlled candidates (`LTA…`, for example 500), 2+ manager accounts, 3+ active Analysts, no other writers on those candidates.

Scenarios:

1. **Overlapping first assignment (`reassign: false`).** Manager A assigns candidates 1-100, Manager B assigns 51-150 at the same instant, repeated over fresh pools. Expect each request to be **all or nothing**: one succeeds for its whole set; the other gets `409 ALREADY_ALLOCATED` (or `CANDIDATE_NOT_AVAILABLE`) for the whole set, never a partial result.
2. **Overlapping reassignment (`reassign: true`).** Both succeed, one after the other (row locks, consistent lock order by `created_date DESC, passport_id ASC`); the final owner of every overlapping candidate is the later writer; no deadlock (`40P01`).
3. **Multi-Analyst distribution under load.** `allocations: [{A,4},{B,6}]` on 10 candidates from several managers on disjoint sets: counts exact, deterministic order.
4. **Assign vs unassign racing** on the same candidates.
5. **Large batch** (up to the 500 limit) while read load runs, to look for `P2028` (default 5 s transaction timeout) and lock waits.

Verify after every run (a Node/SQL script, not k6):

```sql
-- no candidate has more than one allocation (PK already guarantees it; confirms no corruption)
SELECT passport_id, count(*) FROM candidate_allocation GROUP BY 1 HAVING count(*) > 1;
-- every allocation points to an existing, ANALYST, ACTIVE user (as of assignment time)
SELECT a.passport_id FROM candidate_allocation a LEFT JOIN "user" u ON u.admin_id = a.analyst_id
 WHERE u.admin_id IS NULL OR u.role <> 'ANALYST';
-- audit consistency: per candidate, the latest ASSIGN/REASSIGN audit "new" analyst equals the current allocation;
-- UNASSIGN is the last event iff there is no allocation row
-- audit row count == number of real changes (unchanged candidates are not audited)
-- no orphan: no allocation row for a missing candidate (FK) and no partial request (per-request all-or-nothing:
-- compare each request's response with the rows it was supposed to change)
```

k6 records every request's status and body (`candidateIds`, counts); the verifier replays them against the final state.

---

## 10. Database observability

Watch during every run (Supabase Dashboard > Reports, plus SQL):

| Metric | Source |
|---|---|
| Active / idle connections, connections per role, pooler client count | `pg_stat_activity`; Supavisor / dashboard connection graph |
| Pool saturation (client-side) | Prisma/pg errors `P2024`, `P2028`, "timeout acquiring a connection" in Vercel logs |
| Query duration, top queries by total time | `pg_stat_statements` (enable on the load-test project) |
| Lock waits and blockers | `pg_locks` joined to `pg_stat_activity`, `pg_blocking_pids(pid)` |
| Transaction duration | `now() - xact_start` in `pg_stat_activity` |
| Deadlocks, rollbacks | `pg_stat_database` (`deadlocks`, `xact_rollback`) |
| CPU, memory, disk IO, IOPS | Supabase Reports |
| Slow queries | Supabase logs / `pg_stat_statements` |
| Timeouts | Vercel function logs (60 s), Prisma errors |
| Rate-limit table hot row | `rate_limits` update latency in `pg_stat_statements` |

Do not change `DATABASE_POOL_MAX` or pool mode yet. After the baseline, change **one** setting at a time.

---

## 11. Application observability

Per scenario and per endpoint (k6 tags): requests, RPS, p50 / p90 / p95 / p99, error rate, HTTP status distribution (200, 400, 401, 403, 404, 409, **429**, 500, 502/504), timeouts, throughput (bytes). From the platforms: Vercel function invocations, duration, cold starts and instance count, memory; Cloud Run instance count and CPU/memory if workers are attached; Supabase Auth request count. Tag requests with the commit and a run ID so results can be traced.

---

## 12. Initial performance thresholds

*Initial engineering thresholds, **not SLAs**. Replace them with measured baselines after the first runs.*

| Class | Threshold |
|---|---|
| Light reads (`/auth/me`, candidate list, detail, history, Need Attention, Work Allocation list) | p95 < 1000 ms, p99 < 2000 ms |
| Heavy reads (Overview, Daily Summary, incomplete, review list) | p95 < 2500 ms, p99 < 5000 ms (expected to need tuning; set by baseline) |
| Writes (call log, follow-up) | p95 < 1500 ms |
| Allocation writes (assign/reassign/unassign) | p95 < 3000 ms for ≤ 100 candidates; none reaching 5 s |
| HTTP error rate (non-2xx excluding expected 4xx tests) | < 1 % |
| **Unexpected 5xx on allocation/transactions** | **0** |
| **Correctness checks** (right status, right counts, scope respected) | 100 % |
| 429 responses | 0 in tests that are not testing the limiter |

---

## 13. Frontend performance strategy

Kept separate from backend load. k6 does not measure browser rendering.

Hotspots: Candidates table (100 rows with stage progress), Work Allocation (100 rows + selection + counts), Daily Report (several lists), Review Queue, Candidate History/call-log dialog. The main bundle is large (about 820 kB / 220 kB gzipped in the last build, with a size warning), so first-load time matters.

- **Lighthouse / Lighthouse CI:** page load for login, Candidates, Overview, Daily Report on a throttled profile; track LCP, TBT, total JS.
- **Playwright** timing against the load-test stack with the large dataset: time to interactive for the 100-row table, Select-all on Work Allocation, route transitions (list -> detail -> back), search interaction delay, Daily Report render, PDF export time (jsPDF is a separate chunk).
- Run browser checks **idle** (no k6 running) for a clean number, and once **during** a Normal-load run to see UX under backend load.

---

## 14. OCR worker load test plan (separate; do not run yet)

Facts: Cloud Run `emlynk-ocr-worker` (asia-south1), private, IAM-invoked; per instance **2 concurrent jobs + 10 waiting**, 60 s queue wait, 120 s per job, 10 MB max body; `503 OCR_BUSY` when full; the backend limits itself to **2 in-flight OCR requests** (`MAX_CONCURRENT_OCR_REQUESTS`), single submission worker instance.

Plan:

- Test the OCR service **directly** with synthetic documents (generated passports/PDFs, no real candidate data) from a separate k6 script against a **separate staging OCR service**.
- Vary size/type (small JPEG, 10 MB image, 1-page PDF text layer, 3-page scanned PDF), concurrency (1, 2, 4, 8, 20 to exceed 2+10), and measure latency per type, `503` rate, 422/500 rates, instance count, CPU/memory (OOM risk), cold start.
- Verify backpressure: the queue returns `OCR_BUSY` with `Retry-After`, the backend retries (1 min, 3 attempts) and nothing is lost.
- End-to-end pipeline test only on the isolated stack: insert synthetic `temporary_data` rows and watch the worker drain them; measure queue depth and time to completion.
- Never mixed into the admin API benchmark. Estimate throughput as `2 jobs / mean job time` per instance and compare with expected daily document volume *(volume unknown)*.

## 15. Google Sheet worker plan (separate; do not run now)

Facts: DB-to-Sheet only; outbox rows from triggers; single writer under a lease; poll every 10 s; runs queued from Settings; deletion guard; `SHEET_SYNC_ENABLED` gate (off unless `true`); **the only configured target is the real operational Sheet** (supported destination list, no test copy).

- Create a **dedicated test spreadsheet** and a separate worker deployment/destination key (the destinations feature supports several) before any sync test. Never point load tests at the operational Sheet.
- Measure: outbox backlog drain time under a write burst, run duration versus candidate count, database read load of a reconcile, Google API quota behaviour (batch sizes), lease behaviour with scheduled + manual runs at once, and that the admin API stays within thresholds while a reconcile runs.
- Until the test sheet exists: load tests run **without** a Sheet worker, and write scenarios that fire the triggers stay excluded.

## 16. Third-party safety

| Service | Risk from artificial load | Protection |
|---|---|---|
| Meta WhatsApp | The app sends no outbound messages; inbound webhook needs a valid HMAC | Do not call `/whatsapp/webhook` in the main benchmark; no Meta app/secret on the test stack |
| Supabase Auth | Per-request `getUser`, sign-in limits, invite emails | Own project; sign-in once per account; never call `/users/invite` |
| Supabase Storage | Upload/finalize/remove/file streaming touch real buckets | Exclude those routes; separate small storage test on the test project |
| Google Sheets | Real operational sheet | No Sheet worker on the test DB; dedicated test sheet later |
| Cloud Run OCR / workers | Real processing cost, queueing | Not attached; separate plans |
| Email | Auth invites/resets | Not called |

Stack-level rule: the load-test environment gets **its own secrets**; no production secret exists there, so a mistake cannot reach production services.

---

## 17. Rate-limit analysis and safe approach

Findings are in 1.4. Impact on testing:

- A single k6 machine is one IP, so ≥ 1 request/second sustained exhausts the 1000 per 15 minutes within minutes and every later request is a 429 that never reaches the application. Capacity cannot be measured with the limiter as it is.
- The limiter itself also costs one DB write per request, on one row per IP; that cost is part of the real system and should stay in the test.
- **Do not disable the limiter globally and do not weaken production.**

Options (the first needs a small, separately approved code change, so I did not make it):

1. **Staging-only override (recommended later):** read the limit from an environment variable (for example `API_RATE_LIMIT_MAX_REQUESTS`) that is **ignored on production** (`VERCEL_ENV === "production"`) and set only on the load-test deployment. Keeps the code path and the DB write; removes only the ceiling.
2. **No code change:** on the **disposable** load-test database, periodically `DELETE FROM rate_limits` (for example every 30-60 s from the runner). Crude but changes nothing in the app.
3. **Distribute the source IPs** (several runners/cloud k6). Realistic but costly; the per-IP limit then applies per runner.
4. **A deliberate limiter test**, separate and small: confirm 429 at 1001 requests, `Retry-After`/headers, window reset, and that `/auth/me` and `/api/admin` share the counter.

Also review in production logs whether real staff behind one IP already trigger 429s (1.4).

---

## 18. Likely bottlenecks and failure modes (observe, do not optimise yet)

1. **Prisma pool (3 per instance) and Supavisor session-mode limits**: `P2024`, connection timeouts, 500s that look random.
2. **Fixed overhead per request** (Auth call + rate-limit write + user lookup): sets a floor on latency and a ceiling on throughput; the single `rate_limits` row per IP serialises.
3. **Overview and Daily Report**: O(candidates) loads, many parallel queries behind a pool of 3; likely the slowest endpoints and the first to degrade as data grows.
4. **Candidate search**: `ILIKE %x%` over several columns with no supporting index; fine on small tables, scales linearly.
5. **Candidate list `ORDER BY created_date`** without an index (sort cost grows with the table).
6. **Allocation transactions**: default 5 s timeout / 2 s start wait, row locks up to 500 candidates, audit bulk insert; lock waits when managers overlap.
7. **Audit log writes** and a table that only grows; filters without matching indexes.
8. **Review queue summary** loads all `REVIEW_REQUIRED` documents; window merge up to `page*pageSize`.
9. **Vercel**: cold starts, instance fan-out multiplying connections, 60 s limit.
10. **External latency**: Supabase Auth and Storage; Auth is on the critical path of every request.
11. **Large JSON** from Overview/Review/Reports (memory, serialisation).
12. **Rate limiter** returning 429 before the app is saturated (section 17).

---

## 19. Suggested k6 project structure (not created yet)

```
load-tests/
  README.md                 how to run, environments, safety rules, result template
  config/
    env.example.json        base URL, Supabase URL/anon key, account emails (no secrets)
    profiles.js             smoke / normal / peak / stress / spike / soak executors
    thresholds.js           the initial thresholds from section 12
  helpers/
    auth.js                 setup(): sign in once per role, refresh handling
    data.js                 prefixes (LT…), id pickers, weighted choice, think time
    checks.js               shared response + correctness checks
  scenarios/
    smoke.js                every P0/P1 endpoint once, correctness only
    candidates.js           list / search / detail / history reader flows
    work-allocation.js      list, assign, reassign, unassign, multi-Analyst
    allocation-concurrency.js   overlapping managers (section 9)
    reports.js              overview, daily summary, incomplete, monthly
    review.js               queue + item detail (no file/action)
    mixed-normal.js         the weighted mix (section 8)
    spike.js
    soak.js
    auth.js                 the small, separate auth load test
  verify/
    allocation-invariants.sql   the integrity queries from section 9
    verify.mjs              runs them after a test (Node + pg, load-test DB only)
  seed/
    seed.mjs                creates LT… candidates/accounts on the load-test DB
    reset.md                how to reset the disposable database
  results/                  git-ignored; one JSON/summary per run, named by commit and date
```

Credentials come from environment variables on the runner, never from files in the repo.

---

## 20. CI strategy

The repository has **no CI configuration today**, so this is a proposal.

| When | What | Where |
|---|---|---|
| Every PR | **Tiny smoke only**: 1-3 VUs, under 1 minute, against a preview/test stack, correctness checks and generous thresholds. Optional until a stable test stack exists | CI |
| Manual, before a release | Normal load (10-25 VUs, 10 min) + the allocation concurrency test; compare with the last baseline | Manually triggered job |
| Scheduled, non-production | Peak, stress, spike and soak on the disposable stack (nightly/weekly), results archived | Scheduled job |
| Never in normal CI | 100-VU stress, soak, anything writing at volume, OCR/Sheet tests | |

---

## 21. Result report format

Use one file per run in `load-tests/results/`, same fields every time:

```
Test:
Environment:            (stack, dataset size, Vercel/Supabase tier, workers attached? y/n)
Date:
Commit:
Scenario / profile:
Duration:
VUs (or arrival rate):
Requests:
RPS:
p50 / p90 / p95 / p99:  (overall and per endpoint tag)
Error rate:             (non-2xx excluding expected 4xx; 429 count shown separately)
Status distribution:
DB observations:        (connections max, pool errors, lock waits, slow queries, CPU)
Platform observations:  (Vercel instances/cold starts, Auth errors)
Correctness checks:     (passed / failed, invariant verifier result)
Failures:
Bottlenecks:
Recommendation:
```

---

## 22. Best practices to follow

- Take a **baseline before any optimisation**; change **one variable at a time**; repeat each test (at least 3 runs, report the median and the spread).
- Ramp gradually; include a **warm-up** period and exclude it from the numbers.
- Use realistic data volumes and shapes; keep **reads and writes in separate runs** at first, then mix.
- **Never judge by the average**; always p95/p99 and the error rate.
- **Verify correctness during load** (right status, scope respected, invariants) not only speed.
- Monitor the database during every run; stop the run on a runaway error rate.
- Clean up or reset generated data; keep results and logs per commit/version.
- Keep thresholds labelled as initial until baselines exist.

---

## 23. Risks

| Risk | Mitigation |
|---|---|
| Hitting production or shared data | Dedicated stack, separate secrets, refuse to run if the base URL is not on an allow-list |
| Permanent audit-log rows | Disposable database |
| Writing to the real Google Sheet | No Sheet worker on the test stack; dedicated test sheet later |
| Overloading Supabase Auth / Storage | Own project; sign-in once; exclude storage routes |
| Rate limiter hides capacity | Section 17 |
| Misleading results from tiny data | Realistic and growth datasets |
| Misreading VUs as users | Think time; report RPS, not only VUs |
| Platform plan limits unknown | Confirm plan limits before stress/spike |

---

## 24. Open questions (needed to finalise data and thresholds)

1. How many candidates exist today, and how many are expected in 6-12 months? (Overview, reports and search scale with it.)
2. How many staff use the admin at the same time at peak, and are they behind one office IP?
3. Which Vercel plan and which Supabase compute/plan (pooler client and connection limits, Auth rate limits)?
4. Can a second Supabase project and a separate Vercel deployment be created for load testing?
5. Is a dedicated test Google Sheet acceptable to create (for later Sheet worker tests)?
6. Are production logs available to check how often real users receive 429?

---

## 25. Recommended implementation order

1. Answer section 24; create the **load-test Supabase project and Vercel deployment** (no workers attached).
2. Seed script + accounts + reset procedure (small dataset).
3. `load-tests/` skeleton: config, auth helper, smoke scenario; run a **smoke test**.
4. Decide and (if approved) implement the **staging-only rate-limit override** (section 17, option 1) or use option 2.
5. Read-only baselines at the baseline dataset: candidates, Work Allocation reads, reports, review; record the first result reports and replace the initial thresholds with measured ones.
6. **Work Allocation concurrency test** + invariant verifier on the disposable database.
7. Mixed Normal and Peak profiles; observe pool/connection behaviour with the monitoring from section 10.
8. Stress, spike, soak.
9. Growth-dataset runs to quantify the O(candidates) endpoints; only then consider optimisations (one at a time, each re-measured).
10. Frontend (Lighthouse/Playwright), then separate OCR and Sheet worker plans on their own isolated stacks.
11. Wire the smoke test into CI last.
