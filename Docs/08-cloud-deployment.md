# Cloud Deployment and Release Process

**Contents:** Part 1 — OCR Worker (`emlynk-ocr-worker`) · Part 2 — Backend and Worker Deployment (the step-by-step Cloud Run / Vercel record) · Part 3 — Deployment and QA Process (branches, environments, Vercel projects, environment variables, Prisma migrations, QA gates, stage flow, smoke tests, troubleshooting; formerly `DEPLOYMENT_AND_QA_PROCESS.md`). For the Google Sheet Sync worker's own deployment see `GOOGLE_SHEET_INTEGRATION.md`.

Consolidates the OCR worker's Cloud Run handoff document and the backend's Cloud Run/Vercel deployment log. The backend section is kept close to its original, step-by-step form — it's the record of exactly what was configured and verified, in order, and later steps depend on earlier ones. Superseded originals are kept in full in `Docs/archive/` (`18-ocr-worker-cloud-run.md`).

Target architecture:

```
                    Vercel
        ┌──────────────────────────┐
        │  React Admin (/admin)     │
        │  Express API/Webhook      │  ← api/index.js → src/httpHandler.js
        └──────────────┬────────────┘
                        │ same-origin rewrites
                        ▼
              Supabase PostgreSQL (session pooler)
                        ▲
                        │ polls, claims (compare-and-swap)
              Cloud Run: emlynk-submission-worker
              (asia-northeast1, node src/worker.js)
                        │
                        ▼
              Cloud Run: emlynk-ocr-worker
              (asia-south1, Tesseract.js OCR)
                        │
                        ▼
              Supabase Storage (private bucket)
```

Region choice: the submission worker and backend sit in `asia-northeast1` (Tokyo), next to the database, which they call far more often per request than they call OCR; the OCR worker stays in `asia-south1` (Mumbai). Project: `project-aa11e15e-a951-4e1b-a65`.

---

## Part 1 — OCR Worker (`emlynk-ocr-worker`)

Full service reference (API contract, Docker, deployment commands, cost, rollback): [`ocr-worker/README.md`](../ocr-worker/README.md).

**What it is.** The CPU-heavy Tesseract.js OCR, extracted out of the Express app into its own Cloud Run service, so the backend's process stays free of OCR's memory/CPU spikes. Nothing else moved: the webhook, queue, Supabase storage, Prisma, classification, identity, reconciliation, placement and admin dashboard stay in the backend, with unchanged behavior (`05-ocr-document-processing.md`).

```
WhatsApp → Express webhook → Supabase temporary/ + temporary_data → HTTP 200
                    │
          submission queue (lease, retries) → processDocument() → extractText()
                    │
          src/services/ocrClient.js ── HTTPS + Google identity token ──▶ Cloud Run: emlynk-ocr-worker
                    ◀──────────────── extraction result ─────────────────  (Tesseract.js, pdf-parse,
                    │                                                        preprocessing, MRZ read selection)
          classification → passport/MRZ → identity → reconciliation → placement → DB/storage → dashboard
```

**What was built.**
- `ocr-worker/` — an independent Node service: `POST /process` (raw document body, `Content-Type` = MIME type) returns exactly the old `extractDocumentText` result; `GET /health`. English language data (`@tesseract.js-data/eng`) is bundled in the image, so no instance downloads it at runtime. Runs as non-root, stops cleanly on SIGTERM.
- `src/services/ocrClient.js` — the pipeline's default `extractText`. Sends the buffer, attaches a Google identity token (Cloud Run IAM) unless the URL is loopback.
- `src/services/ocrContract.js` — result shape and errors (`OcrResourceError`, `OcrServiceUnavailableError`, `OcrRequestRejectedError`).
- The queue (`submissionQueue.js`) has its own concurrency constant, `MAX_CONCURRENT_OCR_REQUESTS = 2`; an unreachable or overloaded OCR service uses the existing retry-later path (1 min, max 3 attempts, then `FAILED` at `TEXT_EXTRACTION`). Lease, claims and orphan recovery are unchanged.
- `OCR_SERVICE_URL` is required at startup; plain `http://` is allowed only for loopback (local development).

**Error behavior across the HTTP boundary:**

| Service answer | Backend result |
|---|---|
| 422 `IMAGE_TOO_LARGE` / `IMAGE_UNREADABLE` / `PDF_TOO_MANY_PAGES` / `PDF_PAGE_TOO_LARGE` / `OCR_TIMEOUT` | same `OcrResourceError` as before → FAILED, same dashboard code |
| 503 `OCR_BUSY`, 401/403/404/429/5xx, timeout, unreachable | retried by the queue; FAILED after 3 attempts (`OCR_BUSY` keeps its code) |
| 400 / 413 | final → FAILED (`TEXT_EXTRACTION_FAILED`) |

**Current status.** Deployed: service `emlynk-ocr-worker`, region `asia-south1`, private (no `--allow-unauthenticated`). The backend service account `emlynk-backend@project-aa11e15e-a951-4e1b-a65.iam.gserviceaccount.com` has been granted `roles/run.invoker` on it directly (see Part 2, Backend service account). Verified end to end from the deployed submission worker in production (Part 2, Step 5F): a real OCR call succeeded using the worker's own Cloud Run identity, no key file.

**Local development, testing, and the full from-scratch deployment recipe (project setup, Artifact Registry, service accounts, `gcloud run deploy` flags, budget alerts, rollback)** are all in [`ocr-worker/README.md`](../ocr-worker/README.md) and are not repeated here.

---

## Part 2 — Backend and Worker Deployment

Steps below are numbered in the order they were completed. Each one depends on the ones before it.

### Step 1 — Container image

Root `Dockerfile` and `.dockerignore` build the Express backend (`node src/app.js`) for Cloud Run: Node 22 (the generated Prisma client needs 22.18+), production dependencies only, the Linux Prisma engine generated inside the image, run as the unprivileged `node` user, no `.env` baked in. Verified locally: image build, `prisma migrate deploy` from the image against a throwaway database, `/health`, the WhatsApp webhook routes, admin auth, the background worker claiming a job, and a clean SIGTERM shutdown.

### Step 2 — Database connection

Production `DATABASE_URL` uses Supabase's **Supavisor session-mode pooler**, not the direct database host:

- Direct host (`db.<project-ref>.supabase.co`): IPv6 only, unreachable from Cloud Run's default (IPv4) egress.
- Session pooler host: `aws-0-ap-northeast-1.pooler.supabase.com:5432`, database `postgres`, user `postgres.<project-ref>`. Has IPv4 addresses. Verified: a simple query, a Prisma model query, an interactive transaction with `SELECT … FOR UPDATE` row locking (rolled back, no data changed), and `prisma migrate status`.

Session mode (not transaction mode / port 6543) is required because the backend uses interactive Prisma transactions and explicit row locks (`adminReviewActionService.js`), which need one connection held for the whole transaction.

Connection pool: `@prisma/adapter-pg` creates a `pg.Pool` with no `max` set, so pg's default of 10 applies per running instance.

### Step 3 — Backend service account and Secret Manager

```
emlynk-backend@project-aa11e15e-a951-4e1b-a65.iam.gserviceaccount.com
```

The runtime identity the backend and worker Cloud Run services run as. No user-managed JSON key exists for it — Cloud Run uses this identity directly, and the OCR client (`src/services/ocrClient.js`) gets a Google identity token this way with no code change. It holds no project-level roles (no Editor/Owner); only the grants below.

Secrets (project `project-aa11e15e-a951-4e1b-a65`), each granting `roles/secretmanager.secretAccessor` to `emlynk-backend@…` at the **secret level**, not project-wide:

| Secret name | Backend env var it becomes |
|---|---|
| `DATABASE_URL` | `DATABASE_URL` (the session pooler URL above) |
| `SUPABASE_SERVICE_ROLE_KEY` | `SUPABASE_SERVICE_ROLE_KEY` |
| `META_APP_SECRET` | `META_APP_SECRET` |
| `WHATSAPP_VERIFY_TOKEN` | `WHATSAPP_VERIFY_TOKEN` |
| `WHATSAPP_ACCESS_TOKEN` | `WHATSAPP_ACCESS_TOKEN` |

Non-secret production values (`SUPABASE_URL`, `SUPABASE_BUCKET`, `WHATSAPP_API_VERSION`, `OCR_SERVICE_URL`, `APP_BASE_URL`, `NODE_ENV`, `TRUST_PROXY_HOPS`, `REQUIRED_DOCUMENT_TYPES`) are plain Cloud Run/Vercel environment variables, not in Secret Manager.

**OCR invocation IAM.** `emlynk-ocr-worker` (asia-south1) stays private — no `allUsers`, no `--allow-unauthenticated`. It grants `roles/run.invoker` to `emlynk-backend@…` specifically on that service (not project-wide). `ocrClient.js` needs no change: it requests a Google identity token for the service's own audience via Application Default Credentials, which on Cloud Run resolves to the attached service account automatically.

### Step 4 (5A) — HTTP handler separated from the process lifecycle

Architecture decided at this point: the admin UI and the stateless API/webhook run on **Vercel**; the submission worker runs on **Cloud Run**; OCR stays on its existing Cloud Run service.

**Why.** A Vercel function is called once per request and is not kept alive in between. `src/app.js` is a process entry point: it calls `app.listen()`, starts the polling submission worker (`startSubmissionWorker()`) and registers SIGTERM/SIGINT shutdown. None of that can run inside a serverless function — in particular the worker loop would never get CPU time to claim jobs.

**What changed.**
- New `src/httpHandler.js`: runs the same runtime and environment checks as `src/app.js` (throwing instead of `process.exit()` on failure), builds the app with the existing `createApp()` and exports it as the default request handler. It does not listen, does not start the worker, and registers no signal handlers.
- New `test/httpHandler.test.js`: importing the handler leaves nothing running (the child process ends by itself); used as a handler it answers `/health` 200, an admin API call without login 401, webhook verification 200/403, an unsigned webhook POST 401, with security headers; a missing variable throws on import without exiting the process.

**What did not change.** `src/app.js` (still the entry point for local development, Docker and Cloud Run), `src/createApp.js`, `src/services/submissionQueue.js`, WhatsApp processing, RBAC, rate limiting, OCR, storage, Prisma, the schema and migrations.

With the Vercel handler alone, the webhook still records each submission durably and answers 200; the submission then waits in PostgreSQL until a worker process claims it. `notifySubmissionQueued()` becomes a no-op there (no worker in that process listens); the worker's own polling picks the submission up.

### Step 5 (5B) — Worker-only process for Cloud Run

**Why the worker stays on Cloud Run, not Vercel.** The submission worker is a polling loop that must keep running between requests, hold a claim (lease) for up to 10 minutes while a document is processed, and wait up to 4 minutes for one OCR call. A Cloud Run service with CPU always allocated keeps the process alive, and it reaches the OCR service with its own service identity (no key file).

**Why PostgreSQL stays the queue.** The webhook's durable `temporary_data` row *is* the job; the worker claims it with a compare-and-swap lease, fences every write with that claim, and retries or gives up within the recorded attempts (`submissionQueue.js`, unchanged). That already works across processes and restarts, so the Vercel handler and the Cloud Run worker need no other channel: the handler writes the row, the worker polls for it every 5 s. No new queue, no wake-up endpoint.

**What changed.**
- New `src/worker.js` (`npm run worker`): the worker-only entry point. Same runtime check as the server, an environment check limited to what the worker reads, then starts the existing worker through `src/workerProcess.js`. Exits 1 only if startup fails.
- New `src/workerProcess.js`: the lifecycle, nothing else. Starts `startSubmissionWorker()` exactly once; hands SIGTERM/SIGINT to the existing graceful shutdown. When `PORT` is set it opens a minimal listener answering `GET /health` with 200 and everything else with 404 — required because a Cloud Run service must listen on `$PORT` to become ready. The worker's own poll timer keeps the process alive; the listener is not an API.
- `src/config/env.js`: `WORKER_REQUIRED_ENV_VARS` (`DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET`, `OCR_SERVICE_URL`) and an optional `required` list for the environment check. The server's own check is unchanged; the worker needs no JWT, Meta or WhatsApp secret.
- `src/shutdown.js`: `server` is optional (the worker has none without a health port).
- `package.json`: `"worker": "node src/worker.js"`.

**Unchanged.** `submissionQueue.js`, document processing, OCR, storage, WhatsApp handling, authentication, RBAC, rate limiting, `src/app.js`, `src/createApp.js`, `src/httpHandler.js`, the `Dockerfile`, `.dockerignore`, schema and migrations.

**Running it.** Locally: `npm run worker` (no `PORT`: no listener). Container: the same image, with the command overridden — `docker run … <image> node src/worker.js`, or on Cloud Run `--command=node --args=src/worker.js`.

### Step 6 (5C) — Rate-limit counts shared in PostgreSQL

**Why.** The limiters (express-rate-limit) kept their counts in process memory. On Vercel each function instance has its own memory, so every instance would grant its own allowance (e.g. 5 failed logins *per instance*).

**Mechanism.** `src/middleware/postgresRateLimitStore.js`, an express-rate-limit store on the existing Prisma/PostgreSQL connection — chosen because it's already there and already shared by every instance, no new service or dependency. One table, `rate_limits` (migration `20260930120000_phase12_rate_limits`): `key` (primary key), `hits`, `reset_at`, one index on `reset_at`; RLS on, no rights for Supabase's public API roles. The key is `<limiter>:<sha256 of the client key>`, so no IP address is stored.

**Limits preserved (unchanged):**

| Limiter | Limit / window | Counts | Routes |
|---|---|---|---|
| generic-api | 1000 / 15 min | every request | `/api/admin/*`, `/auth/me`, `/auth/complete-invite` |
| admin-frontend | 1000 / 15 min | every request | `/admin/*` (Express only) |

**Superseded by Supabase Auth.** The original `login` (5 failures / 15 min) and `password-reset` limiters protected the application's own login and recovery endpoints. Those endpoints no longer exist: sign-in, password recovery and invitation email are Supabase Auth's, which applies its own rate limits (configured in the Supabase dashboard, Authentication > Rate Limits). See `SUPABASE_AUTH.md`.

**Concurrency.** One statement per counted request: `INSERT … ON CONFLICT (key) DO UPDATE` that increments, or restarts an expired window, and returns the count. The primary key serializes concurrent requests for a key. Tested with 60 concurrent increments from two instances (counts 1–60, none repeated) and 20 concurrent failed logins across two apps (exactly 5 reach the login, 15 get 429); a naive read-then-write control let all 60 read the same count.

**Cleanup.** An expired row is reused by that client's next request. Rows of clients that don't return are deleted with one `DELETE … WHERE reset_at <= now()`, run at most once per window per instance, right after a count. No cron, no extra service.

**Failure behavior.** If the database can't be reached, a limited request fails with 500 instead of passing unlimited — login, password reset and the admin API need the same database anyway.

**Known limitation.** The key is still `req.ip`; behind Vercel, `TRUST_PROXY_HOPS` must be set correctly (see Step 7) or all clients share one key.

### Step 7 (5D) — Vercel configuration and routing

**Entry point.** `api/index.js` imports `src/httpHandler.js` and exports it; that is the only function. `vercel.json` sets `"framework": null` ("Other"): without it, Vercel's zero-configuration Express detection looks for `src/app.js` — and supports `app.listen()` — so it would run the process entry, including the worker.

**Admin build.** One Vercel project at the repository root. `installCommand`: `npm ci && npm --prefix admin ci` (the root install runs `prisma generate`). `buildCommand`: the existing admin build with its output redirected: `npm --prefix admin run build -- --outDir ../public/admin --emptyOutDir`. `outputDirectory`: `public`, so the files sit at `/admin/index.html`, `/admin/assets/*`, `/admin/favicon.svg` — the URLs the build already uses (`base: "/admin/"`, router `basename="/admin"`). `npm run admin:build` (→ `admin/dist`, served by Express under `/admin`) is unchanged for local runs and Docker.

**Routing** (`vercel.json` rewrites; an existing file is served before any rewrite applies):

| Browser path | Goes to |
|---|---|
| `/auth/*`, `/api/*`, `/whatsapp/*`, `/health` | the function (Express sees the original path) |
| `/admin/assets/*` | the static file, or 404 if missing (like Express) |
| `/admin`, `/admin/*` | `/admin/index.html` (client-side routes) |
| anything else | 404 |

The Cloud Run worker is not routed at all.

**Same origin.** Browser, admin pages and API share one origin (the Vercel domain), so there is no CORS. Authentication uses a Supabase access token sent as `Authorization: Bearer` (no cookie authenticates a request; `SUPABASE_AUTH.md`). The browser talks to Supabase directly for sign-in and recovery, which is why the CSP `connect-src` allows `https://*.supabase.co`.

**Headers.** The static admin pages get the same security headers Express sends through helmet (CSP, HSTS, `X-Frame-Options`, …), and `/admin/assets/*` is cached for a year, immutable, as Express serves it.

**Webhook.** `https://<vercel-domain>/whatsapp/webhook`. `NODEJS_HELPERS=0` turns off Vercel's own `request.body` helper so only Express reads the request body (the signature check depends on the raw bytes).

**Function settings.** `regions: ["hnd1"]` (Tokyo, next to the database). `maxDuration: 60`. `includeFiles`: the generated Prisma client and `@prisma/client/runtime`.

**Environment variables on Vercel:**

| | Variables |
|---|---|
| Secrets | `DATABASE_URL` (session pooler URL), `SUPABASE_SERVICE_ROLE_KEY` (server-side only), `META_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN` |
| Non-secret, required | `SUPABASE_URL`, `SUPABASE_BUCKET`, `WHATSAPP_API_VERSION`, `OCR_SERVICE_URL`, `APP_BASE_URL`, `TRUST_PROXY_HOPS=1`, `NODEJS_HELPERS=0` |
| Non-secret, optional | `REQUIRED_DOCUMENT_TYPES` |
| Build-time, public (admin build) | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (browser-safe anon / publishable key; they end up in the public bundle) |
| Not on Vercel | `GOOGLE_APPLICATION_CREDENTIALS`, any service-account key, `PORT` |

`APP_BASE_URL` is **required** and **environment-specific**: this deployment's own public address, the site origin only with no path and no trailing slash. Invitation links are built from it (`${APP_BASE_URL}/admin/setup-password`) and invitations are refused if it is missing or invalid. For the stage deployment: `https://emlynk-wa-bot-git-stage-emlynk-pixel.vercel.app` (a different value from production). Each deployment's setup and reset addresses must also be in the Supabase allowed redirect URLs (`SUPABASE_AUTH.md`).

`OCR_SERVICE_URL` is only there because the startup check requires it; the handler never calls OCR.

**Removed from the deployment configuration.** `JWT_SECRET`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` and `ADMIN_SETUP_URL_BASE` are no longer used. The application sends no email and issues no tokens: Supabase Auth handles authentication, sessions, invitations and password recovery, and the SMTP server for those emails is configured in the Supabase dashboard (Authentication > SMTP Settings), not here. Remove them from Vercel and Cloud Run only after the Supabase Auth version is deployed.

**Cloud Run worker** (unchanged from Step 5): secrets `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; plain `SUPABASE_URL`, `SUPABASE_BUCKET`, `OCR_SERVICE_URL`. No Meta, WhatsApp or `APP_BASE_URL` values.

**`TRUST_PROXY_HOPS = 1`.** Vercel documents `x-forwarded-for` as "the public IP address of the client that made the request" and states that it overwrites the header and does not forward external IPs, to prevent spoofing. So the header holds one address written by the platform; with one trusted hop Express uses it as `req.ip`, and a client can't supply its own. **Confirm this after the first deploy** (two clients on different networks must not share a login allowance).

**Admin build fix (applied).** The admin build's type check failed on committed code: `admin/src/pages/ReviewDetailPage.tsx` used `deleteTemporaryDocument` without importing it, and `open()`'s parameter type lacked `"deleteTemporary"`. Fixed with exactly those two edits.

**Validation done so far.** `vercel.json` validates against Vercel's published schema. Local tests confirm: the entry point, auto-detection off, routing for every mounted backend route and the admin paths, header parity with Express, `api/index.js` imported as a handler leaves nothing running. **Not run: a real `vercel build`** (needs the Vercel CLI linked to a project) — this is still pending.

### Step 8 (5E) — Production migration applied and verified

Migration `20260930120000_phase12_rate_limits` (the `rate_limits` table, Step 6) is applied on the production database through the session pooler. Verified read-only: `prisma migrate status` up to date; the table's columns, indexes, owner and RLS match the schema exactly; `prisma migrate diff` between the live database and `schema.prisma` is empty; every existing table is present with its rows, nothing dropped or reset; a smoke test of the real rate-limit store against the production table (counting, fixed window, key isolation, concurrency, decrement, reset) passed and left no test rows behind.

**Note.** The `admin_invitations` and `admin_password_resets` tables mentioned in earlier steps were dropped by migration `20261009120000_supabase_auth_cutover` (Supabase Auth replaced them).

### Step 9 (5F) — Cloud Run submission worker deployed and verified end to end

| | |
|---|---|
| Name | `emlynk-submission-worker` |
| Region | `asia-northeast1` |
| Image | `asia-northeast1-docker.pkg.dev/project-aa11e15e-a951-4e1b-a65/emlynk-backend/worker:v1` (Artifact Registry repo `emlynk-backend`, built from the unchanged root `Dockerfile`) |
| Command | `node src/worker.js` |
| Service account | `emlynk-backend@project-aa11e15e-a951-4e1b-a65.iam.gserviceaccount.com` |
| CPU / memory | 1 / 1Gi, `--no-cpu-throttling`, `--cpu-boost` |
| Concurrency / timeout | 80 / 300 s |
| Scaling | `--min-instances=1 --max-instances=1` (kept low for this first verification, deliberately not optimized yet) |
| Ingress / auth | private; confirmed with an unauthenticated `GET /health` → 403 |
| URL | `https://emlynk-submission-worker-76153319636.asia-northeast1.run.app` |

**Environment.** Exactly the 5 variables the worker reads: `DATABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from Secret Manager; `SUPABASE_URL`, `SUPABASE_BUCKET`, `OCR_SERVICE_URL` as plain values. No `GOOGLE_APPLICATION_CREDENTIALS`, no service-account key.

**Startup.** Logs show, in order: the instance starting, "Submission worker running", the startup TCP probe succeeding — no exception, no missing-variable error, no Prisma failure.

**Production verification (against the real database, storage and OCR service; nothing simulated).**
- **Database:** connects through the session pooler.
- **Storage:** read and wrote the private bucket with the service-role key.
- **OCR:** the deployed service reached `emlynk-ocr-worker` and got a real result back, using its own Cloud Run identity — the one thing that couldn't be checked before deployment (a local container has no metadata server to source identity tokens from; it correctly logged `reason: CREDENTIALS` and retried when tried locally, exactly as designed, then worked once deployed).
- **Queue processing, end to end, against the live deployment:** a synthetic submission (a non-identity test image, a WhatsApp number matching no real client) was inserted the same way the webhook does. The deployed worker claimed it, ran OCR, classified it (`MEDICAL`), and — since the number matches no client — correctly routed it to `pending/unidentified/.../uncleared-docs/` with `MANUAL_REVIEW` (one attempt, `outcome: PROCESSED`). Its storage objects and `temporary_data` row were then deleted; a follow-up query confirmed nothing remains. No real client data was touched.

**Logs.** Only `temporaryId`, `attempt`, `outcome` and `processingStatus` appear — no document text, file name, phone number, token or key.

---

## What's left before this is fully live

1. Deploy the actual Vercel project (Step 7 above validated the configuration locally but a real `vercel build`/deploy has not been run).
2. Confirm `TRUST_PROXY_HOPS=1` behaves as expected on the live Vercel deployment.
3. Point the Meta webhook at `https://<vercel-domain>/whatsapp/webhook`.
4. Run a full end-to-end test with a real WhatsApp message once the above are done.
5. Reconsider `--max-instances` on the submission worker once traffic patterns are known (kept at 1 deliberately for this first verification).

---

## Part 3 — Deployment and QA Process

*Formerly `DEPLOYMENT_AND_QA_PROCESS.md` (Emlynk Deployment and QA Process).*

This document defines the deployment architecture, branch workflow, database migration standards, pre-integration verification, and Quality Assurance (QA) procedures for the Emlynk platform.

---

### 1. Purpose

The purpose of this document is to ensure predictable, secure, and regression-free releases across all components of the Emlynk platform:

1. **Strict Environment Separation**: Maintaining distinct boundaries between local development (`dev`), pre-release integration/staging (`stage`), and live production (`main`).
2. **Preventing Data Corruption & Regression**: Ensuring schema migrations and data transformations are thoroughly validated before hitting shared or production databases.
3. **Rigorous Quality Assurance (QA)**: Establishing mandatory test gates (type-checking, unit/integration testing, security auditing, and responsive browser validation) before code promotion.
4. **Multi-Application Coordination**: Coordinating releases between the Admin Console + API backend (Vercel Project A), the Candidate Extra Details Form (Vercel Project B), and background Cloud Run workers.

---

### 2. Repository & Branch Strategy

The Emlynk project uses a structured Git workflow designed for stability and traceability across multiple parallel features.

```text
feature branches (e.g., version/*)
          │
          │ (cherry-pick or full merge after QA)
          ▼
        dev (integrated active development)
          │
          │ (full test suite + migration verification)
          ▼
       stage (Vercel preview & staging validation)
          │
          │ (smoke testing & stakeholder sign-off)
          ▼
       main (production release only)
```

#### 2.1 Branch Definitions

- **`main`**:
  - Authoritative production release branch.
  - Must **never** receive direct or unverified commits.
  - Updated solely via approved merges from `stage` after successful smoke testing and stakeholder sign-off.
- **`dev`**:
  - Central integration branch for ongoing development.
  - All completed feature branches and hotfixes are merged here for integration testing.
  - Must remain buildable and pass automated test suites at all times.
- **`stage`**:
  - Dedicated staging and preview branch connected to Vercel Preview deployments.
  - Serves as the environment for final end-to-end QA, cross-browser validation, and client acceptance testing prior to production release.
- **`version/*` branches**:
  - Isolated feature branches used for major architectural milestones.
  - Examples:
    - `version/Admin-dashboard`: Admin UI development, token styling, date picker integration.
    - `version/candidate-extra-details-form`: Candidate-facing public form, security hardening, share links.
    - `version/client-management`: Employer client management, agent entity separation, and job tracking.
    - `version/Cloud-run-worker`: Background submission worker lifecycle and Cloud Run containerization.
    - `version/google-sheet-sync`: Google Sheets outbox, dynamic header mapping, and Cloud Run sync worker.

#### 2.2 Merging Strategy: Cherry-Pick vs. Full Merge

- **Cherry-Pick**:
  - Used when an isolated bug fix or self-contained UI update in a feature branch (e.g., specific Admin styling improvements, date picker corrections) must be brought into `dev` without dragging in incomplete architectural work from the feature branch.
- **Full Merge**:
  - Used when a feature branch has achieved full maturity, completed its internal test suite, and reconciled schema overlaps.
  - *Example*: The `version/candidate-extra-details-form` branch was reconciled with `dev` (aligning the new Client architecture and migration history) and subsequently merged into `dev` via a clean full merge after passing all backend, Admin, and Candidate Form test suites.

---

### 3. Application Deployment Architecture

The single GitHub repository (`emlynk-pixel/EmlynkWABot`) contains multiple deployable web applications and backend services.

```text
                             GitHub Repository: EmlynkWABot
                                           │
                  ┌────────────────────────┴────────────────────────┐
                  ▼                                                 ▼
      Vercel Project: Backend + Admin                   Vercel Project: Candidate Form
      (Project A: Repository Root)                     (Project B: Root Directory: candidate-form)
      ┌───────────────────────────────┐                 ┌───────────────────────────────┐
      │ • Root vercel.json            │                 │ • candidate-form/vercel.json  │
      │ • Express API (/api, /auth)   │                 │ • React 19 + Vite SPA         │
      │ • React 19 Admin (/admin)     │                 │ • Public Static Deployment    │
      │ • Serverless Function         │                 │ • Zero backend credentials    │
      └──────────────┬────────────────┘                 └──────────────┬────────────────┘
                     │                                                 │
                     │                 CORS / HTTPS API                │
                     │◄────────────────────────────────────────────────┘
                     ▼
             Supabase PostgreSQL
```

#### 3.1 Admin Dashboard + Express Backend (Project A)
- **Deployment Platform**: Vercel (Project A).
- **Build Root**: Repository root (`.`).
- **Components**:
  - **Admin Dashboard**: React 19 + TypeScript + Vite single-page application built into `public/admin`.
  - **API Backend**: Express 5 application running as a Vercel Serverless Function entry point (`api/index.js` importing `src/httpHandler.js`).
- **Routing**: Same-origin routing. Rewrites in root `vercel.json` direct `/api/*`, `/auth/*`, `/whatsapp/*`, and `/health` to the Express handler, while `/admin/*` routes serve `public/admin/index.html`.
- **Branch Binding**: Production points to `main`; Preview deployments trigger on `stage` and feature branches.

#### 3.2 Candidate Extra Details Form (Project B)
- **Deployment Platform**: Vercel (Project B).
- **Build Root**: Dedicated subfolder (`candidate-form/`).
- **Components**:
  - React 19 + TypeScript + Vite public single-page application.
  - Completely static distribution (`dist/`).
  - Isolated from internal backend dependencies, Prisma, Supabase SDKs, and private credentials.
- **Communication**: Cross-origin HTTPS calls exclusively to the backend public endpoint (`/api/public/candidate-details/*`).
- **Branch Binding**: Tested on `stage` and feature branches before production cutover.

#### 3.3 Rationale for Separate Vercel Projects
Even though both applications reside on the same Git branch, separate Vercel projects are required because:
1. **Different Build Roots**: Project A builds from the repository root; Project B builds from `candidate-form/`.
2. **Different Output Directories**: Project A serves static assets from `public`; Project B compiles to `dist`.
3. **Distinct Public Domains**: Admin is served under the primary domain (`/admin`); Candidate Form is hosted on a dedicated public candidate domain (e.g. `https://candidate-form-preview.vercel.app`).
4. **Strict Security Boundaries**: Candidate Form is public-facing and untrusted; it must never share environment variables, encryption secrets, or service-role keys with the backend.

---

### 4. Admin / Backend Build Configuration

Verified configuration from `vercel.json`, `package.json`, and `admin/vite.config.ts`:

| Setting | Value / Specification | Notes |
|---|---|---|
| **Vercel Framework** | `null` (Other) | Prevents Vercel from incorrectly running `src/app.js` as an auto-detected Express entry |
| **Root Directory** | `.` (Repository root) | Built from repository root |
| **Install Command** | `npm ci && npm --prefix admin ci` | Installs root dependencies (triggers `prisma generate`) and admin dependencies |
| **Build Command** | `npm --prefix admin run build -- --outDir ../public/admin --emptyOutDir` | Runs admin typecheck (`tsc --noEmit`) and Vite build into `public/admin` |
| **Output Directory** | `public` | Static files served from `public` |
| **Admin Base Path** | `/admin/` | Configured in `admin/vite.config.ts` (`base: "/admin/"`) |
| **Router Basename** | `/admin` | Configured in `admin/src/basePath.ts` and `<BrowserRouter basename={APP_BASE_PATH}>` |
| **Serverless Function** | `api/index.js` | Exports `src/httpHandler.js` (`regions: ["hnd1"]`, `maxDuration: 60`) |
| **Function Includes** | `"{generated/prisma/**,node_modules/@prisma/client/runtime/**}"` | Ensures generated Prisma engine is packaged in serverless bundle |

---

### 5. Candidate Form Build Configuration

Verified configuration from `candidate-form/vercel.json`, `candidate-form/package.json`, and `candidate-form/vite.config.ts`:

| Setting | Value / Specification | Notes |
|---|---|---|
| **Vercel Framework** | `vite` | Native Vite framework preset |
| **Root Directory** | `candidate-form` | Mandatory setting in Vercel project configuration |
| **Install Command** | `npm ci` | Installs clean dependencies for candidate-form |
| **Build Command** | `npm run build` | Executes `tsc --noEmit -p tsconfig.json && vite build` |
| **Output Directory** | `dist` | Production static bundle output |
| **Public Directory** | `static` | Configured in `vite.config.ts` as `publicDir: "static"` to prevent `.gitignore` exclusion |
| **Env Prefix** | `VITE_API_` | Strict filter ensuring only safe public variables are bundled |
| **Sourcemap** | `false` | Disabled to avoid leaking source code in the public client bundle |
| **Content Security Policy** | Dynamic `<meta>` injection via `csp.ts` | Pins `connect-src` strictly to `VITE_API_BASE_URL`; fails build if URL is invalid |

---

### 6. Environment Variables

All environment variables must be configured with precise environment scoping (Production vs. Preview).

#### 6.1 Backend & Admin Project (Vercel Project A)

##### Candidate Form Integration Variables

| Variable | Scope | Type | Description & Format |
|---|---|---|---|
| `CANDIDATE_FORM_ORIGIN` | Preview, Production | Public URL | Exact public origin of the Candidate Form (e.g. `https://candidate-form-preview.vercel.app`). **Bare origin only**: must include protocol, host, and optional port; no path (`/admin`), no trailing slash, no fragment (`/#k=`). Required for CORS allowlist and share-link generation. |
| `CANDIDATE_FORM_TOKEN_SECRET` | Preview, Production | Secret | Minimum 32-character CSPRNG secret used to encrypt/sign candidate session tokens via AES-256-GCM + HKDF. **Backend-only**: never expose to client bundles. |

##### Database & Connection Pool Variables

| Variable | Scope | Type | Description & Format |
|---|---|---|---|
| `DATABASE_URL` | Preview, Production | Secret | PostgreSQL connection string pointing to Supabase **Supavisor session-mode pooler** (e.g., `aws-0-ap-northeast-1.pooler.supabase.com:5432` or port `6543`). Session mode is required for interactive transactions and `FOR UPDATE` row locks. |
| `DATABASE_POOL_MAX` | Preview, Production | Config | Maximum pool size per serverless instance (default: `3`). Keep low to prevent pool exhaustion across concurrent Vercel serverless function invocations. |
| `DIRECT_URL` | N/A | Optional | *Note*: The current `prisma/schema.prisma` configures a single datasource URL (`url = env("DATABASE_URL")`). Direct connection is not currently configured in the schema. |

##### Core Backend Application Variables

| Variable | Scope | Description |
|---|---|---|
| `SUPABASE_URL` | Preview, Production | Supabase project API URL (e.g., `https://<ref>.supabase.co`). |
| `SUPABASE_SERVICE_ROLE_KEY` | Preview, Production | Backend service-role key (bypasses RLS for administrative operations). |
| `SUPABASE_BUCKET` | Preview, Production | Private storage bucket holding candidate documents (`temporary/`, `clients/`, `pending/`). |
| `META_APP_SECRET` | Preview, Production | Meta app secret for WhatsApp webhook HMAC-SHA256 signature verification. |
| `WHATSAPP_VERIFY_TOKEN` | Preview, Production | Webhook challenge verification token. |
| `WHATSAPP_ACCESS_TOKEN` | Preview, Production | System user access token for WhatsApp Business Cloud API calls. |
| `WHATSAPP_API_VERSION` | Preview, Production | Meta Graph API version string (e.g., `v21.0`). |
| `OCR_SERVICE_URL` | Preview, Production | HTTPS endpoint of the Cloud Run OCR Worker (`https://...run.app`). |
| `APP_BASE_URL` | Preview, Production | Public admin URL for THIS environment (e.g. `https://emlynk-wa-bot-git-stage-emlynk-pixel.vercel.app`). Required for Supabase invitation and password-setup redirects. |
| `TRUST_PROXY_HOPS` | Preview, Production | Number of reverse proxy hops (defaults to `1` when `VERCEL=1`). Ensures real client IP resolution for rate limiting. |
| `NODEJS_HELPERS` | Preview, Production | Set to `0` on Vercel to preserve raw request buffers for webhook signature validation. |

##### Admin Frontend Build Variables (Embedded in Bundle)

| Variable | Scope | Description |
|---|---|---|
| `VITE_SUPABASE_URL` | Preview, Production | Supabase project URL for browser-side Supabase Auth client. |
| `VITE_SUPABASE_ANON_KEY` | Preview, Production | Supabase public anonymous key (browser-safe). |

#### 6.2 Candidate Form Project (Vercel Project B)

| Variable | Scope | Description & Format |
|---|---|---|
| `VITE_API_BASE_URL` | Preview, Production | Backend root domain (e.g., `https://emlynk-wa-bot-git-stage-emlynk-pixel.vercel.app`). **Bare origin only**: no `/admin` suffix, no trailing slash. Injected into CSP `connect-src` at build time. |
| `VITE_API_ADMIN_MOBILE_NUMBERS` | Preview, Production | Optional comma-separated list of administrative contact phone numbers (e.g., `0771234567,0719876543`). Displayed in the Contact Admin state. Configurable without code modifications. |

---

### 7. Prisma & Database Migration Process

#### 7.1 Strict Migration Rules

> [!CAUTION]
> **NEVER run `npx prisma migrate dev` against shared Supabase, staging, or production databases.**
> `migrate dev` is an interactive development command intended solely for local prototyping. In shared environments, it triggers prompt loops, risks dropping schemas, and can generate unexpected migration files.

Always use standard forward-only migration commands:

```bash
# 1. Validate Prisma schema syntax and relation consistency
npx prisma validate

# 2. Regenerate Prisma Client in generated/prisma
npx prisma generate

# 3. Check migration ledger status against database
npx prisma migrate status

# 4. Apply pending migrations forward-only in an atomic transaction
npx prisma migrate deploy
```

#### 7.2 Scratch PostgreSQL Rehearsals

For complex or structural migrations (renaming tables, adding foreign keys, altering multi-column unique constraints):
1. Test migration execution on a local throwaway PostgreSQL instance (or PGLite).
2. Validate both execution paths:
   - **Clean-Path**: Replaying all migrations from `20260921064444_init_schema` to latest on an empty database.
   - **Upgrade-Path**: Applying the migration against a clone of the existing shared database containing historical data and previously applied branch migrations.

#### 7.3 Multi-Branch Reconciliation & Migration Bridge History

During parallel development on `version/candidate-extra-details-form` and `version/client-management`:
1. Candidate Form migration `20261018130000_job_company_id_and_form_job_group` had already added `job.company_job_id` and unique index `("company_id", "company_job_id")` on the shared database.
2. In parallel, Client Management migration `20261019120000_client_management` renamed `company` to `client`, changed `job.company_id` to `job.client_id`, but on a database built from `dev` first, `company_job_id` already existed.
3. **Bridge & Reconciliation Strategy**:
   - Rather than editing already-applied migrations (which would alter migration checksums and break `_prisma_migrations`), two forward-only migrations were created:
     - `20261018125900_bridge_dev_first_company_job_id`: If in a dev-first state, safely parks `company_job_id` values in `company_job_id_reconcile` and creates a temporary `company_id` column.
     - `20261023120000_reconcile_job_company_job_id`: Copies the parked values back to `company_job_id`, cleans up temporary columns, and establishes the definitive unique index `("client_id", "company_job_id")`.
   - On fresh databases and on the shared database, these bridge migrations safely perform no-op checks (`DO $$ BEGIN IF EXISTS ... END $$;`).

---

### 8. QA Process Before Integration

Before merging any branch into `dev` or promoting `dev` to `stage`, every test suite must pass cleanly.

#### 8.1 Automated Test Gates

```bash
# Backend test suite (Node test runner)
npm test

# Admin Dashboard typecheck, tests, and build
npm --prefix admin run typecheck
npm --prefix admin test
npm --prefix admin run build

# Candidate Form typecheck, tests, and build
npm --prefix candidate-form run typecheck
npm --prefix candidate-form test
npm --prefix candidate-form run build

# Prisma schema and migration status verification
npx prisma validate
npx prisma generate
npx prisma migrate status
```

#### 8.2 Additional QA Verification Checks

- **Browser QA**: Validate desktop Chrome, Firefox, Safari, and Edge.
- **Mobile Responsive QA**: Inspect responsive layouts at 320px, 375px, 390px, and 412px viewports. Confirm zero horizontal scrolling (`scrollWidth === clientWidth`).
- **Role-Based Access Control (RBAC)**: Verify endpoint authorization for all four roles (`ADMIN`, `MANAGER`, `ANALYST`, `REGISTRATION_DESK`).
- **Audit Logging**: Confirm critical actions (user invite, work allocation, link generation, link revocation, field confirm/reject) record complete audit trails without storing plain credentials or link secrets.
- **Security Scans**: Verify no secrets exist in client bundles, CORS policies reject unauthorized origins, and CSP headers strictly limit connections.

---

### 9. Candidate Form Security QA

The Candidate Extra Details Form handles sensitive candidate data across the public internet and incorporates defense-in-depth security controls.

#### 9.1 Single-Candidate Links
- **Entropy & Cryptography**: Created with 256-bit cryptographically secure pseudorandom numbers (`crypto.randomBytes(32)` -> 43-character base64url string).
- **Fragment URL Delivery**: Sent to candidates via URL fragment (`<origin>/#k=<secret>`). Browsers never transmit URL fragments to servers, keeping the secret out of server access logs, proxy logs, and `Referer` headers.
- **Stored Hash**: Only a SHA-256 hash (`token_hash`) is stored in `candidate_form_link`. The plaintext secret cannot be recovered from the database.
- **Two-Factor Candidate Verification**: Unlocking the form requires proving possession of the link secret plus verifying **Passport Number + NIC Number**.
- **Finite Lifespan**: Links expire after 3 days (`FORM_LINK_TTL_MS = 259200000`).
- **Single Submission Guarantee**: Access follows `LOCKED -> UNLOCKED -> SUBMITTED`. Once submitted, the state is immutable; no link can reopen a submitted form.

#### 9.2 Job-Group Links
- **Job Binding**: Bound strictly to the immutable UUID `job.id` (never display codes or legacy text).
- **Live Membership Evaluation**: Eligibility is evaluated dynamically against active `job_candidate` records where the job is in `PROCESSING` status. A candidate added to the job later can use the link; a removed candidate is immediately locked out.
- **Cross-Job Isolation**: Candidates assigned to other jobs or unassigned candidates are rejected.
- **Shared Usability**: When one candidate in a job group submits their form, the group link remains active and accessible for remaining eligible candidates.
- **Failure Thresholds**: Group links lock after 100 failed attempts (preventing typos from denying service to the whole group), while per-IP (10 failures / 15 min) and per-passport (5 failures / 1 hour) rate limits prevent targeted brute force.

#### 9.3 Session State Machine & Token Invalidation
- Sessions use custom format `cf1~<iv>~<ciphertext>` (AES-256-GCM + HKDF), not JWT-shaped, preventing accidental submission to staff Supabase auth endpoints.
- The session payload carries the candidate's `accessVersion`. Any administrative action (revoking a link, generating a new link, or submitting a form) increments `version`, instantly invalidating all active sessions.

#### 9.4 Information Leakage Prevention
- Zero raw Passport Numbers, NICs, or internal Job UUIDs appear in public URLs.
- Verification failures return generic 401 messages with equalized query execution and constant-time comparisons, preventing user enumeration.
- Contact Admin and error states render generic bilingual help text with zero candidate identifiers in the DOM or logs.

---

### 10. Stage Deployment Flow

Releases follow a disciplined progression to staging before production deployment:

```text
1. Feature Branch Complete
   ├── All unit & integration tests pass locally
   └── Scratch DB migration rehearsal passes
          ↓
2. Merge into dev
   ├── Full suite: Backend + Admin + Candidate Form
   └── Confirm git status and commit history
          ↓
3. Promote dev to stage
   └── git checkout stage && git merge dev
          ↓
4. Deploy to Vercel Preview
   ├── Project A (Backend + Admin): triggers on stage branch
   ├── Project B (Candidate Form): triggers on stage branch
   └── Verify Preview environment variables are configured
          ↓
5. Run Database Migrations
   └── npx prisma migrate deploy (against staging Supabase DB)
          ↓
6. Execute Stage Smoke-Test Checklist
   └── Complete Admin + Candidate Form verification
          ↓
7. Promotion to Production (main)
   └── Merge stage into main only after full sign-off
```

---

### 11. Stage Smoke-Test Checklist

Every staging release must be verified against this checklist before production approval:

#### 11.1 Admin Dashboard Smoke Tests

- [ ] **Authentication**: Sign in using valid Supabase Auth credentials across different roles (`ADMIN`, `MANAGER`, `ANALYST`, `REGISTRATION_DESK`).
- [ ] **Candidates Pool**: Verify candidate list renders, search by passport/name works, and server-side pagination transitions smoothly.
- [ ] **Status & Workflow**: Confirm candidate status filters and transition controls update candidate state correctly.
- [ ] **Candidate Stages**: Check 7-stage deployment workflow progression and stage history tracking.
- [ ] **Job Assignment**: Verify assigning a candidate to a job requires passed test prerequisites and updates the active assignment.
- [ ] **Verify Details**: Test manual detail verification toggle and confirm audit log records actor and timestamp.
- [ ] **Verify Documents**: Inspect signed document URLs in preview drawer and verify document status toggles.
- [ ] **Work Allocation**: Execute automated equal distribution across active Analysts; verify remainder handling and row-lock concurrency.
- [ ] **Job Management**: Create a new job with Client Job ID; verify auto-generated `job_code` sequence.
- [ ] **Agent Management**: Create and update recruitment agents; confirm active-job deactivation guard works.
- [ ] **Client Management**: Create employer clients linked to agents; confirm client list and edit drawers function cleanly.
- [ ] **Audit Logs**: Review `/admin/settings/audit-logs` to ensure administrative actions are logged with actor details and zero exposed secrets.

#### 11.2 Candidate Form Smoke Tests

- [ ] **Single Link Generation**: In Admin Candidate Details, click **Share Form**; verify the modal generates a link with `/#k=<secret>`.
- [ ] **Domain Check**: Confirm generated link origin matches the configured Candidate Form domain (not localhost or backend domain).
- [ ] **Successful Verification**: Open link; submit matching Passport Number + NIC Number; verify form unlocks and prefills candidate data marked *From your record*.
- [ ] **Invalid Identity Rejection**: Test incorrect Passport or NIC; verify generic error appears and rate-limit counters increment.
- [ ] **Already Submitted State**: Attempt to verify a candidate who has already submitted; confirm bilingual Contact Admin screen is shown.
- [ ] **Revoked / Expired Link**: Revoke link in Admin; reload candidate form; confirm access is rejected.
- [ ] **Contact Admin Mobile Numbers**: Confirm configured mobile numbers (`VITE_API_ADMIN_MOBILE_NUMBERS`) display cleanly with no WhatsApp buttons or `wa.me` links.
- [ ] **Job-Group Link**: Generate group link for a `PROCESSING` job; verify assigned candidate unlocks form; verify non-assigned candidate is refused.
- [ ] **Form Submission**: Complete 4-step wizard, review summary, and submit; confirm success screen appears and button locks during submission.
- [ ] **Idempotent Resubmission**: Re-open the submitted link; confirm neutral already-submitted state displays.
- [ ] **Mobile Responsiveness**: Test verification and 4-step form on mobile device or 375px viewport; ensure bottom-sheet DatePicker and inputs fit without horizontal overflow.

---

### 12. Common Deployment Issues & Troubleshooting

#### 12.1 Prisma Windows EPERM DLL Lock
- **Symptom**: `npx prisma generate` fails with `EPERM: operation not permitted, rename '...\query_engine-windows.dll.node'`.
- **Root Cause**: A running Node.js process (such as a local backend server or file watcher) holds an active lock on the Prisma query engine DLL.
- **Resolution**: Terminate all active Node processes (`Get-Process node | Stop-Process`), then rerun `npx prisma generate`.

#### 12.2 Vercel Wrong Branch / Environment Variable Scope
- **Symptom**: Staging deployment behaves like production, or variables configured in Vercel do not take effect.
- **Root Cause**: Environment variables in Vercel were scoped only to "Production" rather than "Preview", or the deployment was triggered from an unexpected branch.
- **Resolution**: In Vercel Project Settings > Environment Variables, ensure variables required by `stage` have the **Preview** checkbox enabled. Redeploy the deployment after saving.

#### 12.3 Candidate Form Root Directory Not Visible in Vercel UI
- **Symptom**: Vercel project configuration cannot find the `candidate-form` directory during setup.
- **Root Cause**: The repository's default branch (`main`) lacked the `candidate-form/` folder before the feature branch was integrated.
- **Resolution**: Set the Vercel project's Production Branch to `stage` (or the relevant feature branch) during initial configuration, or set Root Directory explicitly to `candidate-form`.

#### 12.4 Candidate Form Root URL Showing "Open your link"
- **Symptom**: Navigating directly to `https://candidate-form-preview.vercel.app` shows "Open your link" with no input fields.
- **Root Cause**: Expected security behavior. The Candidate Form requires a valid link secret in the URL fragment (`/#k=...`). Without a fragment, verification is disabled to prevent unauthenticated enumeration.
- **Resolution**: Always open the form using a link generated via Admin **Share Form**.

#### 12.5 `FORM_NOT_CONFIGURED` (503 Service Unavailable)
- **Symptom**: `POST /api/admin/candidates/:passportId/form-share` returns `503 Service Unavailable` with body `{"code": "FORM_NOT_CONFIGURED"}`.
- **Root Cause**: `CANDIDATE_FORM_ORIGIN` is missing or contains an invalid value (e.g. contains a path or trailing slash) in the backend Vercel environment.
- **Resolution**: Set `CANDIDATE_FORM_ORIGIN` to the bare HTTPS origin (e.g. `https://candidate-form-preview.vercel.app`) in the backend Vercel project settings (Preview scope) and redeploy.

#### 12.6 Supabase `EMAXCONNSESSION` Connection Pool Exhaustion
- **Symptom**: Admin API routes return `500 Internal Server Error`; `prisma migrate status` fails with `EMAXCONNSESSION: max clients reached in session mode`.
- **Root Cause**: Supabase session-mode pooler has reached its concurrent client limit. Serverless functions each spawn database connections; if `DATABASE_POOL_MAX` is too high or local development processes stay connected, the pool is exhausted.
- **Resolution**:
  1. Confirm backend `DATABASE_POOL_MAX` is set to `3` on Vercel.
  2. Terminate idle local Node instances and database IDE connections.
  3. Verify Supabase project pooler settings (use session pooler on port 5432 or 6543 session mode for interactive transactions).

#### 12.7 Migration History Conflicts & Checksum Mismatches
- **Symptom**: `npx prisma migrate deploy` fails with `P3009` or reports checksum mismatch on previously applied migrations.
- **Root Cause**: An applied historical migration script was modified retroactively instead of introducing a forward-only migration.
- **Resolution**: Never edit applied migrations. Resolve conflicts using `npx prisma migrate resolve --rolled-back <name>` if a transaction aborted cleanly, and introduce forward-only idempotent migrations.

#### 12.8 Generated Links Pointing to `localhost`
- **Symptom**: Admin Share Form generates links pointing to `http://localhost:5174/#k=...` instead of the public staging domain.
- **Root Cause**: `CANDIDATE_FORM_ORIGIN` in backend environment is set to local dev origin rather than the staging Candidate Form domain.
- **Resolution**: Update `CANDIDATE_FORM_ORIGIN` in Vercel Preview settings to the public staging URL. The backend intentionally never derives share URLs from the `Host` header to protect against host-header injection attacks.
