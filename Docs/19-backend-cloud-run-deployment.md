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
