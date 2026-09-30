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

## Step 5C — Rate-limit counts shared in PostgreSQL

**Why.** The limiters (express-rate-limit) kept their counts in process
memory. On Vercel each function instance has its own memory, and requests
are spread across instances, so every instance granted its own allowance
(e.g. 5 failed logins *per instance*).

**Mechanism.** The limiters are unchanged except for their store:
`src/middleware/postgresRateLimitStore.js`, an express-rate-limit store on
the existing Prisma/PostgreSQL connection. PostgreSQL was chosen because it
is already there and already shared by every instance: no new service,
dependency or network hop. One table, `rate_limits` (migration
`20260930120000_phase12_rate_limits`): `key` (primary key), `hits`,
`reset_at`, one index on `reset_at`; RLS on and no rights for Supabase's
public API roles, like the other tables. The key is
`<limiter>:<sha256 of the client key>`, so no IP address is stored.

**Limits preserved (unchanged).**

| Limiter | Limit / window | Counts | Routes |
|---|---|---|---|
| login | 5 / 15 min | failures only | `POST /auth/login` |
| password-reset | 5 / 15 min | every request | `/auth/setup-password`, `/auth/forgot-password`, `/auth/reset-password` |
| generic-api | 1000 / 15 min | every request | `/api/admin/*` |
| admin-frontend | 1000 / 15 min | every request | `/admin/*` (Express only) |

Same keys (client IP), same 429 JSON messages, same `RateLimit` /
`RateLimit-Policy` headers. The admin API and `/admin` keep separate counts
(different prefixes), as they did in memory.

**Concurrency.** One statement per counted request: `INSERT … ON CONFLICT
(key) DO UPDATE` that increments, or restarts an expired window, and
returns the count. The primary key serializes concurrent requests for a key,
so each gets its own number: tested with 60 concurrent increments from two
instances (counts 1–60, none repeated) and 20 concurrent failed logins across
two apps (exactly 5 reach the login, 15 get 429). A naive read-then-write
version, run as a control, let all 60 read the same count. Window times come
from the database clock, the same for every instance. Semantics match the old
in-memory store: fixed window from a key's first hit; successful logins are
taken off again (never below 0).

**Cleanup.** An expired row is reused by that client's next request. Rows of
clients that don't return are deleted with one `DELETE … WHERE reset_at <=
now()`, run at most once per window per instance, right after a count
(awaited, never a background timer). No cron, no extra service.

**Failure behavior.** If the database can't be reached, a limited request
fails with 500 instead of passing unlimited. Login, password reset and the
admin API need the same database anyway, so nothing that would have worked
is blocked, and a missing `rate_limits` table (migration not applied) shows
up at once instead of silently disabling the limits.

**Cost.** One database round trip per limited request (login, password
reset, admin API; not the webhook, not `/health`), plus the occasional
cleanup. No other table is read.

**Changed files.** New: `src/middleware/postgresRateLimitStore.js`, the
migration, the `RateLimit` model in `prisma/schema.prisma`,
`test/postgresRateLimitStore.test.js`. Modified: `loginRateLimiter.js` and
`apiRateLimiter.js` (a `store` option, PostgreSQL by default; `prefix` for
the API limiter), `src/adminFrontend.js` (its own prefix),
`src/createApp.js` (an `adminFrontendLimiter` option for tests, like its
other test options). Tests that exercise routes with fake databases now pass
an in-memory store explicitly (`errorHandling`, `adminFrontend`,
`loginRateLimit`, `adminPasswordReset`); `httpHandler.test.js` checks the
unauthenticated response on `/auth/me` and that the admin API fails closed
when the store's database is unreachable.

**Tests.**
- `npm test` (no database): 1054 tests, 1032 pass, 0 fail, 22 skipped.
- `RATE_LIMIT_TEST_DATABASE_URL=<throwaway> node --test
  test/postgresRateLimitStore.test.js`: 17/17 pass (throwaway PostgreSQL 16
  on 127.0.0.1:55432 with all migrations applied; never production).
- The same with the full suite: 1068 tests, 1046 pass, 0 fail, 22 skipped.

**Known limitations.**
- The key is still `req.ip`; behind Vercel, `TRUST_PROXY_HOPS` must be set
  correctly or all clients share one key (Step 5D).
- Production needs the migration before this code runs:
  `npx prisma migrate deploy` against the session pooler.

## Step 5D — Vercel configuration and routing

Nothing is deployed yet. Platform facts below are from Vercel's documentation
(Express on Vercel, vercel.json, Rewrites, Request headers, Node.js runtime),
checked when this was written.

**Entry point.** `api/index.js` imports `src/httpHandler.js` and exports it;
that is the only function. `vercel.json` sets `"framework": null` ("Other"):
without it, Vercel's zero-configuration Express detection looks for
`src/app.js` — and supports `app.listen()` — so it would run the process
entry, including the worker.

**Admin build.** One Vercel project at the repository root.
`installCommand`: `npm ci && npm --prefix admin ci` (the root install runs
`prisma generate`). `buildCommand`: the existing admin build with its output
redirected: `npm --prefix admin run build -- --outDir ../public/admin
--emptyOutDir`. `outputDirectory`: `public`, so the files sit at
`/admin/index.html`, `/admin/assets/*`, `/admin/favicon.svg` — the URLs the
build already uses (`base: "/admin/"`, router `basename="/admin"`). Only
`public/` is static; the repository is not served. `npm run admin:build`
(→ `admin/dist`, served by Express under `/admin`) is unchanged for local
runs and Docker. `express.static()` is ignored on Vercel, which is why the
admin is built as static files there.

**Routing** (`vercel.json` rewrites; an existing file is served before any
rewrite applies):

| Browser path | Goes to |
|---|---|
| `/auth/*`, `/api/*`, `/whatsapp/*`, `/health` | the function (Express sees the original path) |
| `/admin/assets/*` | the static file, or 404 if missing (like Express) |
| `/admin`, `/admin/*` | `/admin/index.html` (client-side routes) |
| anything else | 404 |

No rewrite leaves the deployment and none uses named parameters (those would
be added to the query string). The Cloud Run worker is not routed at all.

**Cookies.** Browser, admin pages and API share one origin (the Vercel
domain), so the login cookie stays as it is: `HttpOnly`, `SameSite=Strict`,
`Secure` when `NODE_ENV=production`, same name, no `Domain`. No CORS, no
cross-origin authentication, no code change. The admin client keeps its
relative `/auth/*` and `/api/*` calls with `credentials: "include"`.

**Headers.** The static admin pages get the same security headers Express
sends through helmet (CSP, HSTS, `X-Frame-Options`, … — a test compares them
with the running app), and `/admin/assets/*` is cached for a year, immutable,
as Express serves it. API responses get their headers from Express as before.

**Webhook.** `https://<vercel-domain>/whatsapp/webhook` (GET verification and
POST). Not configured in Meta yet. Express's body parser reads the request
itself and keeps the raw bytes for the signature check; `NODEJS_HELPERS=0`
turns off Vercel's own `request.body` helper so nothing else touches the body.

**Function settings.** `regions: ["hnd1"]` (Tokyo, next to the database in
`ap-northeast-1`; the default is `iad1`). `maxDuration: 60`. `includeFiles`:
the generated Prisma client (`generated/prisma/**`, git-ignored, created at
install) and `@prisma/client/runtime`, which only the generated client
imports. Node.js: `engines` in `package.json` selects the latest 24.x, which
loads the generated `.ts` client.

**Environment variables on Vercel** (the handler's code reads exactly these):

| | Variables |
|---|---|
| Secrets | `DATABASE_URL` (session pooler URL), `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `META_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `SMTP_PASS` |
| Non-secret, required | `SUPABASE_URL`, `SUPABASE_BUCKET`, `WHATSAPP_API_VERSION`, `OCR_SERVICE_URL`, `APP_BASE_URL` (the Vercel domain, no trailing slash), `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `EMAIL_FROM`, `TRUST_PROXY_HOPS=1`, `NODEJS_HELPERS=0` |
| Non-secret, optional | `REQUIRED_DOCUMENT_TYPES`, `ADMIN_SETUP_URL_BASE` |
| Not on Vercel | `GOOGLE_APPLICATION_CREDENTIALS`, any service-account key, `PORT` |

`OCR_SERVICE_URL` is only there because the startup check requires it; the
handler never calls OCR and needs no Google credential. `NODE_ENV` must be
`production` at runtime (the cookie's `Secure` flag depends on it): check the
`Set-Cookie` of the first login. The sender variable is `EMAIL_FROM` (there
is no `SMTP_EMAIL_FROM`).

**Cloud Run worker** (unchanged from Step 5B): secrets `DATABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`; plain `SUPABASE_URL`, `SUPABASE_BUCKET`,
`OCR_SERVICE_URL`. No JWT, Meta, WhatsApp or SMTP values.

**TRUST_PROXY_HOPS = 1.** Vercel documents `x-forwarded-for` as "the public
IP address of the client that made the request" and states that it
overwrites the header and does not forward external IPs, to prevent
spoofing. So the header holds one address written by the platform; with one
trusted hop Express uses it as `req.ip`, and a client can't supply its own.
Unset, `req.ip` would be the platform's internal address and every client
would share one rate-limit count. This is derived from the documentation,
not yet observed on a deployment: confirm after the first deploy (two
clients on different networks must not share a login allowance).

**Validation (local).** `vercel.json` validates against Vercel's published
schema (`https://openapi.vercel.sh/vercel.json`). `node --test
test/vercelConfig.test.js`: 13/13 — entry point, auto-detection off, routing
for every mounted backend route and the admin paths, header parity with
Express, `api/index.js` imported as a handler leaves nothing running.
`npm test`: 1067 tests, 1045 pass, 0 fail, 22 skipped. Admin `vitest`:
144/144. `npm start` and `npm run worker` start as before. Not run: a real
`vercel build` (needs the Vercel CLI linked to a project).

**Admin build fix.** The admin build's type check failed on committed code
(since `c133eb5`), so the Vercel build would have failed too:
`admin/src/pages/ReviewDetailPage.tsx` used `deleteTemporaryDocument` without
importing it from `../api/admin` (where it exists), and `open()`'s parameter
type lacked `"deleteTemporary"`. Fixed with exactly those two edits; the
"Delete Document" action on a review item now calls the existing
`DELETE /api/admin/temporary-documents/:id` route instead of throwing.
`npm run admin:build` and the Vercel `buildCommand` both pass (0 type errors).

**Remaining, in order.**
1. Apply the rate-limit migration to Supabase through the session pooler
   (`npx prisma migrate deploy`) — before any deployed code uses the limiters.
2. Deploy and test the Cloud Run worker (Step 5B settings).
3. Create the Vercel project (root directory: repository root), set the
   variables above, deploy; check `/health`, login (`Secure` cookie), the
   admin pages, and the rate-limit key per client.
4. Set the Meta webhook to `https://<vercel-domain>/whatsapp/webhook`.
5. End-to-end test.

**Known limitations.**
- Each function instance has its own database pool (up to 10 connections)
  against the session pooler; watch the connection count under load.
- The webhook's worst case (media lookup 10 s + download 30 s + upload up to
  60 s) can exceed `maxDuration`; Meta then redelivers, and the unique
  message ID keeps the submission single.

## Step 5E — Production migration verified

**Migration.** `20260930120000_phase12_rate_limits` is applied on the
production database (recorded as finished 2026-09-30 13:31 UTC, not rolled
back; 15 of 15 migrations applied). It was already applied when this step's
checks began; `npx prisma migrate deploy` run here reported "No pending
migrations to apply".

**Target.** Supabase PostgreSQL through the Supavisor session pooler
(`aws-0-ap-northeast-1.pooler.supabase.com:5432`, database `postgres`, the
project's `postgres.<project-ref>` user). The pooler URL was supplied to the
commands for this step only; `.env` on the development machine still holds
the direct host.

**Verification (read-only).**
- `npx prisma migrate status`: "Database schema is up to date!".
- `rate_limits`: `key` text (primary key), `hits` integer, `reset_at`
  timestamptz(3), all NOT NULL; indexes `rate_limits_pkey` and
  `rate_limits_reset_at_idx`; owner `postgres`; RLS on; no rights for `anon`
  or `authenticated`.
- Live database compared with `prisma/schema.prisma` (`prisma migrate diff`):
  no difference.
- Existing tables all present with their rows (`users`, `admins`,
  `documents`, `temporary_data`, `audit_logs`, `admin_invitations`,
  `admin_password_resets`, `_prisma_migrations`); nothing dropped or reset.
- `npm run db:check`: connection successful.

**Smoke test.** The real store (`postgresRateLimitStore.js`) against the
production table, under a unique test prefix: counting, fixed window, key
isolation, 10 concurrent increments from two store instances (distinct
counts), a new instance continuing the count, decrement and reset — all
pass. Its rows were deleted afterwards (0 test rows left; the table had 0
rows before and after).

**Note.** `admin_invitations` and `admin_password_resets` have row level
security off. They are not exposed (`anon` and `authenticated` hold no rights
on any table), but unlike the other tables they rely on that alone.

Nothing was deployed. Next: the Cloud Run worker, then Vercel.
