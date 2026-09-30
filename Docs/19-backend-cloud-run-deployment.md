# 19 — Backend on Google Cloud Run: deployment foundation

Status as this document is written: the backend container image and its IAM/
Secret Manager foundation are prepared. The backend has **not** been deployed
to Cloud Run yet. No secret values appear anywhere in this file.

## Regions

- Backend (planned): Cloud Run, **`asia-northeast1`** (Tokyo) — next to the
  database (see below), which the backend calls far more often, per request,
  than it calls the OCR service.
- OCR worker (already deployed): Cloud Run, **`asia-south1`** (Mumbai),
  service `emlynk-ocr-worker`. See `ocr-worker/README.md`.

## Container image (Step 1)

Root `Dockerfile` and `.dockerignore` build the Express backend
(`node src/app.js`) for Cloud Run: Node 22 (the generated Prisma client needs
22.18+), production dependencies only, the Linux Prisma engine generated
inside the image, run as the unprivileged `node` user, no `.env` baked in.
Verified locally: image build, `prisma migrate deploy` from the image against
a throwaway database, `/health`, the WhatsApp webhook routes, admin auth, the
background worker claiming a job, and a clean SIGTERM shutdown.

## Database connection (Step 2)

Production `DATABASE_URL` uses Supabase's **Supavisor session-mode pooler**,
not the direct database host:

- Direct host (`db.<project-ref>.supabase.co`): IPv6 only, unreachable from
  Cloud Run's default (IPv4) egress.
- Session pooler host: `aws-0-ap-northeast-1.pooler.supabase.com:5432`,
  database `postgres`, user `postgres.<project-ref>`. Has IPv4 addresses.
  Verified: a simple query, a Prisma model query, an interactive transaction
  with `SELECT … FOR UPDATE` row locking (rolled back, no data changed), and
  `prisma migrate status` (all 14 migrations already applied).

Session mode (not transaction mode / port 6543) is required because the
backend uses interactive Prisma transactions and explicit row locks
(`adminReviewActionService.js`), which need one connection held for the whole
transaction.

Connection pool: `@prisma/adapter-pg` creates a `pg.Pool` with no `max` set,
so pg's default of 10 applies per running instance.

## Backend service account (Step 3)

```
emlynk-backend@project-aa11e15e-a951-4e1b-a65.iam.gserviceaccount.com
```

This is the runtime identity the backend Cloud Run service will run as (not
yet attached to a deployed service). No user-managed JSON key exists for it —
Cloud Run uses this identity directly, and the OCR client
(`src/services/ocrClient.js`) already gets a Google identity token this way
with no code change. It holds no project-level roles (no Editor/Owner); its
only grants are the ones below.

## Secret Manager

Project: `project-aa11e15e-a951-4e1b-a65`.

These secrets hold the production values (never committed, never in this
repo):

| Secret name | Backend env var it becomes |
|---|---|
| `DATABASE_URL` | `DATABASE_URL` (the session pooler URL above) |
| `SUPABASE_SERVICE_ROLE_KEY` | `SUPABASE_SERVICE_ROLE_KEY` |
| `JWT_SECRET` | `JWT_SECRET` |
| `META_APP_SECRET` | `META_APP_SECRET` |
| `WHATSAPP_VERIFY_TOKEN` | `WHATSAPP_VERIFY_TOKEN` |
| `WHATSAPP_ACCESS_TOKEN` | `WHATSAPP_ACCESS_TOKEN` |
| `SMTP_PASS` | `SMTP_PASS` |

Each secret grants `roles/secretmanager.secretAccessor` to
`emlynk-backend@…` at the **secret level** (not project-wide). No other
principal or role was added.

Non-secret production values (`SUPABASE_URL`, `SUPABASE_BUCKET`,
`WHATSAPP_API_VERSION`, `OCR_SERVICE_URL`, `APP_BASE_URL`, `SMTP_HOST`,
`SMTP_PORT`, `SMTP_USER`, `EMAIL_FROM`, `NODE_ENV`, `TRUST_PROXY_HOPS`,
`REQUIRED_DOCUMENT_TYPES`) are plain Cloud Run environment variables, set at
deploy time — not put in Secret Manager.

## OCR invocation IAM

`emlynk-ocr-worker` (asia-south1) stays private — no `allUsers`, no
`--allow-unauthenticated`. It now grants `roles/run.invoker` to
`emlynk-backend@…` specifically on that service (not project-wide), alongside
the pre-existing implicit access from the developer's own project-owner
account. `ocrClient.js` needs no change: it already requests a Google
identity token for the service's own audience via Application Default
Credentials, which on Cloud Run resolves to the attached service account
automatically.

## Not done yet

- The backend has not been deployed to Cloud Run.
- No Cloud Run environment variables or secret references have been attached
  to any revision.
- The Vercel frontend and the Meta webhook URL are not configured for
  production.
- `.env` on this machine is unchanged and still uses the direct database
  host, which is fine for local development.

See the root `README.md` and `ocr-worker/README.md` for the OCR service's own
deployment, and the earlier Cloud Run readiness audit for the reasoning
behind these choices.

## Step 5A — HTTP handler separated from the process lifecycle

Architecture decided since the steps above: the admin UI and the stateless
API/webhook run on **Vercel**; the submission worker runs on **Cloud Run**;
OCR stays on its existing Cloud Run service. This step only prepares the
Express app for the Vercel side.

**Why.** A Vercel function is called once per request and is not kept alive
in between. `src/app.js` is a process entry point: it calls `app.listen()`,
starts the polling submission worker (`startSubmissionWorker()`) and
registers SIGTERM/SIGINT shutdown. None of that can run inside a serverless
function — in particular the worker loop would never get CPU time to claim
jobs.

**What changed.**
- New `src/httpHandler.js`: runs the same runtime and environment checks as
  `src/app.js` (throwing instead of `process.exit()` on failure), builds the
  app with the existing `createApp()` and exports it as the default request
  handler. It does not listen, does not start the worker, and registers no
  signal handlers.
- New `test/httpHandler.test.js`: importing the handler leaves nothing
  running (the child process ends by itself — a started worker or server
  would keep it alive; verified with a negative control); used as a handler
  it answers `/health` 200, an admin API call without login 401, webhook
  verification 200/403, an unsigned webhook POST 401, with security headers;
  a missing variable throws on import without exiting the process.

**What did not change.** `src/app.js` (still the entry point for local
development, Docker and Cloud Run: same checks, `app.listen()`, worker,
graceful shutdown), `src/createApp.js` (routes, middleware order, security
headers, error handler), `src/services/submissionQueue.js` (claiming,
leases, fencing, retries), WhatsApp processing, authentication and cookies,
RBAC, rate limiting, OCR, storage, Prisma, the schema and migrations. No
CORS, no Vercel configuration yet.

With the Vercel handler alone, the webhook still records each submission
durably (file in `temporary/`, `temporary_data` row) and answers 200; the
submission then waits in PostgreSQL until a worker process claims it
(Step 5B). `notifySubmissionQueued()` in the webhook becomes a no-op there
(no worker in that process listens); the worker's own polling picks the
submission up.

**Tests.** `node --test test/httpHandler.test.js`: 4/4 pass. `npm test`:
1039 tests, 1017 pass, 0 fail, 22 skipped (the OCR-gated ones, as before).
`src/app.js` started with placeholder settings: listens, `/health` 200,
worker running.

**For Step 5D.** Vercel's zero-configuration Express detection may treat
`src/app.js` as the entry point (it matches the file names it looks for);
the Vercel configuration must point at `src/httpHandler.js` explicitly.
The handler runs the same environment check as the server, so
`OCR_SERVICE_URL` is required on Vercel too, although only the worker calls
OCR.

## Step 5B — Worker-only process for Cloud Run

**Why the worker stays on Cloud Run, not Vercel.** The submission worker is
a polling loop that must keep running between requests, hold a claim (lease)
for up to 10 minutes while a document is processed, and wait up to 4
minutes for one OCR call. A Vercel function exists only for one request.
A Cloud Run service with CPU always allocated keeps the process alive, and
it reaches the OCR service with its own service identity (no key file).

**Why PostgreSQL stays the queue.** The webhook's durable
`temporary_data` row *is* the job; the worker claims it with a
compare-and-swap lease, fences every write with that claim, and retries or
gives up within the recorded attempts (`submissionQueue.js`, unchanged).
That already works across processes and across restarts, so the Vercel
handler and the Cloud Run worker need no other channel: the handler writes
the row, the worker polls for it (every 5 s). `notifySubmissionQueued()` is
kept as it is — an in-process wake-up for `src/app.js`, where API and worker
share a process; on Vercel it wakes nothing, and the poll covers it. No new
queue, no wake-up endpoint.

**What changed.**
- New `src/worker.js` (`npm run worker`): the worker-only entry point. Same
  runtime check as the server, an environment check limited to what the
  worker reads, then starts the existing worker through `src/workerProcess.js`.
  Exits 1 only if startup fails.
- New `src/workerProcess.js`: the lifecycle, and nothing else. Starts
  `startSubmissionWorker()` exactly once; hands SIGTERM/SIGINT to the
  existing graceful shutdown (stop claiming, let a running job finish or
  release its lease, disconnect Prisma, exit). When `PORT` is set it opens
  a minimal listener that answers `GET /health` with 200 and everything else
  with 404: a Cloud Run service must listen on `$PORT` to become ready. The
  worker's own poll timer keeps the process alive; the listener is not an
  API.
- `src/config/env.js`: `WORKER_REQUIRED_ENV_VARS` (`DATABASE_URL`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET`,
  `OCR_SERVICE_URL` — traced from the worker's imports) and an optional
  `required` list for `findEnvProblems`/`assertValidEnv`. The server's own
  check is unchanged. The worker service therefore needs no JWT, Meta or
  WhatsApp secret.
- `src/shutdown.js`: `server` is optional (the worker has none without a
  health port). Unchanged when a server is given.
- `package.json`: `"worker": "node src/worker.js"`.

**Unchanged.** `submissionQueue.js` (claims, leases, fencing, retries, max
attempts), document processing, OCR, storage, WhatsApp handling,
authentication, RBAC, rate limiting, `src/app.js`, `src/createApp.js`,
`src/httpHandler.js`, the `Dockerfile`, `.dockerignore`, schema and
migrations.

**Running it.**
- Locally: `npm run worker` (no `PORT` in `.env`: no listener). `npm start`
  still runs API + worker in one process; running both at once is safe
  (claims are compare-and-swap), just two workers.
- Container: the same image, with the command overridden —
  `docker run … <image> node src/worker.js`, or on Cloud Run
  `--command=node --args=src/worker.js`. The image's `PORT=8080` enables the
  health listener. The default command (`node src/app.js`) is unchanged.

**Tests.**
- `node --test test/workerProcess.test.js`: 12/12 pass — the real worker is
  started once; SIGTERM and SIGINT each stop it (no poll afterwards, Prisma
  disconnected, exit 0); a second signal does nothing more; the health
  listener answers only `/health`; a busy port fails startup before the
  worker starts; shutdown works without a server; the worker's settings are
  a subset of the server's and still format-checked; `node src/worker.js`
  exits naming a missing setting, and starts, stays running and answers
  `/health` with only the five worker settings; the entry and lifecycle
  contain no queue code; `claimNextSubmission`/`startSubmissionWorker` are
  defined only in `submissionQueue.js`.
- `node --test test/httpHandler.test.js`: 4/4 pass (the Vercel handler still
  starts no worker).
- `npm test`: 1051 tests, 1029 pass, 0 fail, 22 skipped (OCR-gated, as
  before).
- `node src/app.js` with placeholder settings: listens, `/health` 200, admin
  API 401 without login, worker running.
- Docker (existing Dockerfile, command `node src/worker.js`, placeholder
  settings, only the five worker variables): `/health` 200 on 8080, API
  paths 404, `docker stop` (SIGTERM) → "Shutdown complete", exit 0 in 0.6 s.

**Still to do.**
- Step 5C: persistent rate limiting (the in-memory limiters don't hold
  across Vercel instances).
- Step 5D: Vercel routing/configuration (entry `src/httpHandler.js`, admin
  rewrites).
- Deploying the worker service: `asia-northeast1`, service account
  `emlynk-backend`, the four worker secrets plus `SUPABASE_URL`,
  `SUPABASE_BUCKET`, `OCR_SERVICE_URL`, `--no-cpu-throttling`,
  `--min-instances=1`, command `node src/worker.js`.
