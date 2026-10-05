# Cloud Deployment

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
| `JWT_SECRET` | `JWT_SECRET` |
| `META_APP_SECRET` | `META_APP_SECRET` |
| `WHATSAPP_VERIFY_TOKEN` | `WHATSAPP_VERIFY_TOKEN` |
| `WHATSAPP_ACCESS_TOKEN` | `WHATSAPP_ACCESS_TOKEN` |
| `SMTP_PASS` | `SMTP_PASS` |

Non-secret production values (`SUPABASE_URL`, `SUPABASE_BUCKET`, `WHATSAPP_API_VERSION`, `OCR_SERVICE_URL`, `APP_BASE_URL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `EMAIL_FROM`, `NODE_ENV`, `TRUST_PROXY_HOPS`, `REQUIRED_DOCUMENT_TYPES`) are plain Cloud Run/Vercel environment variables, not in Secret Manager.

**OCR invocation IAM.** `emlynk-ocr-worker` (asia-south1) stays private — no `allUsers`, no `--allow-unauthenticated`. It grants `roles/run.invoker` to `emlynk-backend@…` specifically on that service (not project-wide). `ocrClient.js` needs no change: it requests a Google identity token for the service's own audience via Application Default Credentials, which on Cloud Run resolves to the attached service account automatically.

### Step 4 (5A) — HTTP handler separated from the process lifecycle

Architecture decided at this point: the admin UI and the stateless API/webhook run on **Vercel**; the submission worker runs on **Cloud Run**; OCR stays on its existing Cloud Run service.

**Why.** A Vercel function is called once per request and is not kept alive in between. `src/app.js` is a process entry point: it calls `app.listen()`, starts the polling submission worker (`startSubmissionWorker()`) and registers SIGTERM/SIGINT shutdown. None of that can run inside a serverless function — in particular the worker loop would never get CPU time to claim jobs.

**What changed.**
- New `src/httpHandler.js`: runs the same runtime and environment checks as `src/app.js` (throwing instead of `process.exit()` on failure), builds the app with the existing `createApp()` and exports it as the default request handler. It does not listen, does not start the worker, and registers no signal handlers.
- New `test/httpHandler.test.js`: importing the handler leaves nothing running (the child process ends by itself); used as a handler it answers `/health` 200, an admin API call without login 401, webhook verification 200/403, an unsigned webhook POST 401, with security headers; a missing variable throws on import without exiting the process.

**What did not change.** `src/app.js` (still the entry point for local development, Docker and Cloud Run), `src/createApp.js`, `src/services/submissionQueue.js`, WhatsApp processing, authentication and cookies, RBAC, rate limiting, OCR, storage, Prisma, the schema and migrations.

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
| login | 5 / 15 min | failures only | `POST /auth/login` |
| password-reset | 5 / 15 min | every request | `/auth/setup-password`, `/auth/forgot-password`, `/auth/reset-password` |
| generic-api | 1000 / 15 min | every request | `/api/admin/*` |
| admin-frontend | 1000 / 15 min | every request | `/admin/*` (Express only) |

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

**Cookies.** Browser, admin pages and API share one origin (the Vercel domain), so the login cookie stays as it is: `HttpOnly`, `SameSite=Strict`, `Secure` when `NODE_ENV=production`, same name, no `Domain`. No CORS, no cross-origin authentication.

**Headers.** The static admin pages get the same security headers Express sends through helmet (CSP, HSTS, `X-Frame-Options`, …), and `/admin/assets/*` is cached for a year, immutable, as Express serves it.

**Webhook.** `https://<vercel-domain>/whatsapp/webhook`. `NODEJS_HELPERS=0` turns off Vercel's own `request.body` helper so only Express reads the request body (the signature check depends on the raw bytes).

**Function settings.** `regions: ["hnd1"]` (Tokyo, next to the database). `maxDuration: 60`. `includeFiles`: the generated Prisma client and `@prisma/client/runtime`.

**Environment variables on Vercel:**

| | Variables |
|---|---|
| Secrets | `DATABASE_URL` (session pooler URL), `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `META_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `SMTP_PASS` |
| Non-secret, required | `SUPABASE_URL`, `SUPABASE_BUCKET`, `WHATSAPP_API_VERSION`, `OCR_SERVICE_URL`, `APP_BASE_URL` (the Vercel domain, no trailing slash), `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `EMAIL_FROM`, `TRUST_PROXY_HOPS=1`, `NODEJS_HELPERS=0` |
| Non-secret, optional | `REQUIRED_DOCUMENT_TYPES`, `ADMIN_SETUP_URL_BASE` |
| Not on Vercel | `GOOGLE_APPLICATION_CREDENTIALS`, any service-account key, `PORT` |

`OCR_SERVICE_URL` is only there because the startup check requires it; the handler never calls OCR. `EMAIL_FROM` is the sender variable (there is no `SMTP_EMAIL_FROM`).

**Cloud Run worker** (unchanged from Step 5): secrets `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; plain `SUPABASE_URL`, `SUPABASE_BUCKET`, `OCR_SERVICE_URL`. No JWT, Meta, WhatsApp or SMTP values.

**`TRUST_PROXY_HOPS = 1`.** Vercel documents `x-forwarded-for` as "the public IP address of the client that made the request" and states that it overwrites the header and does not forward external IPs, to prevent spoofing. So the header holds one address written by the platform; with one trusted hop Express uses it as `req.ip`, and a client can't supply its own. **Confirm this after the first deploy** (two clients on different networks must not share a login allowance).

**Admin build fix (applied).** The admin build's type check failed on committed code: `admin/src/pages/ReviewDetailPage.tsx` used `deleteTemporaryDocument` without importing it, and `open()`'s parameter type lacked `"deleteTemporary"`. Fixed with exactly those two edits.

**Validation done so far.** `vercel.json` validates against Vercel's published schema. Local tests confirm: the entry point, auto-detection off, routing for every mounted backend route and the admin paths, header parity with Express, `api/index.js` imported as a handler leaves nothing running. **Not run: a real `vercel build`** (needs the Vercel CLI linked to a project) — this is still pending.

### Step 8 (5E) — Production migration applied and verified

Migration `20260930120000_phase12_rate_limits` (the `rate_limits` table, Step 6) is applied on the production database through the session pooler. Verified read-only: `prisma migrate status` up to date; the table's columns, indexes, owner and RLS match the schema exactly; `prisma migrate diff` between the live database and `schema.prisma` is empty; every existing table is present with its rows, nothing dropped or reset; a smoke test of the real rate-limit store against the production table (counting, fixed window, key isolation, concurrency, decrement, reset) passed and left no test rows behind.

**Note.** `admin_invitations` and `admin_password_resets` have row level security off. They are not exposed (Supabase's `anon`/`authenticated` roles hold no rights on any table), but unlike the other tables they rely on that alone.

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
