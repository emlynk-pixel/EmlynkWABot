# 04. Vercel Deployment

Two separate Vercel projects are deployed from the **same GitHub repository**:

| | Project A: API + Admin | Project B: Candidate Form |
|---|---|---|
| What | Express API, WhatsApp webhook, React Admin console at `/admin` | Public React form for candidates |
| Root Directory | repository root (`.`) | `candidate-form` |
| Config file | root `vercel.json` | `candidate-form/vercel.json` |
| Framework preset | **Other** (`"framework": null`) | Vite |
| Holds secrets? | Yes (server env vars) | **No.** Only `VITE_API_*` public values |
| Output | `public/` (Admin at `public/admin`) + serverless function `api/index.js` | `dist/` |

Why two projects: different roots, different output folders, different public domains, and a hard security boundary. The public form must never share environment variables, secrets or the service-role key with the backend (`Docs/08-cloud-deployment.md` Part 3, §3.3).

> Prerequisites: Supabase is ready ([03](03-SUPABASE-SETUP.md)); you have the OCR service URL ([06](06-OCR-WORKER-DEPLOYMENT.md)). Vercel needs no Google credentials: the API never calls OCR, workers, or Google APIs.

## Project A: API + Admin

### 1. Connect the repository

Vercel dashboard → **Add New → Project** → import the GitHub repository `EmlynkWABot` (grant the Vercel GitHub app access if asked).

### 2. Branches

| Branch | Vercel environment |
|---|---|
| `main` | **Production** (set as the project's Production Branch) |
| `stage` | Preview (final QA before production) |
| other branches | Preview |

Settings → Git → Production Branch = `main`. Never push unreviewed commits to `main` (`Docs/08-cloud-deployment.md` Part 3, §2).

### 3. Project settings

These values are already in `vercel.json`; the file overrides the dashboard. Leave the dashboard on the defaults but confirm what you see matches:

| Setting | Value (from `vercel.json`) |
|---|---|
| Framework Preset | **Other** (`framework: null`). If Vercel auto-detects Express it would run `src/app.js` including the worker, which cannot work in a serverless function |
| Root Directory | `.` (repository root) |
| Install Command | `npm ci && npm --prefix admin install` (the root install runs `prisma generate` via `postinstall`) |
| Build Command | `npm --prefix admin run build -- --outDir ../public/admin --emptyOutDir` (type-checks, then builds the Admin SPA into `public/admin`) |
| Output Directory | `public` |
| Function | `api/index.js` imports `src/httpHandler.js`; `maxDuration: 60`; `includeFiles` packages the generated Prisma client |
| Region | `hnd1` (Tokyo), next to the database |
| Node.js version | Settings → General → Node.js Version: choose **22.x**. The repo requires Node `^22.18.0 \|\| >=23.6.0`; confirm the deploy log shows 22.18 or newer (**needs verification** on first deploy) |

### 4. Environment variables

Settings → Environment Variables. Mark secrets as **Sensitive**. Scope each variable to the right environment: **Production** for `main`, **Preview** for `stage` and feature branches. A variable set only for Production does not exist in Preview (a classic cause of "stage behaves like production" or fails to start).

| Variable | Sensitive? | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Session pooler string for **this environment's** database |
| `DATABASE_POOL_MAX` | no | `3` (the default) |
| `SUPABASE_URL` | no | |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-side only |
| `SUPABASE_BUCKET` | no | |
| `META_APP_SECRET` | yes | |
| `WHATSAPP_VERIFY_TOKEN` | yes | |
| `WHATSAPP_ACCESS_TOKEN` | yes | |
| `WHATSAPP_API_VERSION` | no | e.g. `v21.0` |
| `OCR_SERVICE_URL` | no | Required by the startup check even though the Vercel handler never calls OCR |
| `APP_BASE_URL` | no | **This environment's** Admin origin, no path, no trailing slash. See below |
| `TRUST_PROXY_HOPS` | no | Optional: defaults to `1` automatically on Vercel |
| `NODEJS_HELPERS` | no | `0` (documented in `Docs/08-cloud-deployment.md`; keeps the raw body for webhook signature checking) |
| `REQUIRED_DOCUMENT_TYPES` | no | Optional |
| `CANDIDATE_FORM_ORIGIN` | no | Project B's origin; set after B exists |
| `CANDIDATE_FORM_TOKEN_SECRET` | yes | Different value in each environment |
| `VITE_SUPABASE_URL` | no (public) | **Build-time**, ends up in the public bundle |
| `VITE_SUPABASE_ANON_KEY` | no (public) | **Build-time**, anon/publishable key only |

Full explanations and sources: [02](02-ENVIRONMENT-VARIABLES.md#1-backend-api-vercel-project-a-and-local-npm-start). Do **not** add `GOOGLE_APPLICATION_CREDENTIALS`, `PORT` or any Google key to this project.

**`APP_BASE_URL` is per environment.** The invitation link is always `${APP_BASE_URL}/admin/setup-password`. It must be the Admin site origin only. Example shapes (fake):

```
Production  APP_BASE_URL=https://admin.example.com
Stage       APP_BASE_URL=https://<project>-git-stage-<team>.vercel.app
Local       APP_BASE_URL=http://localhost:5173
```

Each of these origins must also appear in Supabase's redirect URLs ([03](03-SUPABASE-SETUP.md#auth)). The admin URL **must contain `/admin`** when opened in a browser: `https://<domain>/` is not the Admin console, and the setup link `.../admin/setup-password` is derived from `APP_BASE_URL` without a path.

### 5. Deploy

Push to the branch (or use Deployments → Redeploy). Watch the build log for: dependency install, `prisma generate`, the Admin type check (`tsc --noEmit`) and the Vite build. A Vite build embeds `VITE_*` values **at build time**: changing them requires a **redeploy**, not just a restart.

### 6. Validate the deployment

Replace `<DOMAIN>` with the deployment URL.

```bash
curl -s https://<DOMAIN>/health
#   {"status":"OK","message":"Emlynk backend is running..!"}

curl -s -o /dev/null -w '%{http_code}\n' https://<DOMAIN>/admin
#   200  (the Admin SPA's index.html)

curl -s -o /dev/null -w '%{http_code}\n' https://<DOMAIN>/api/admin/candidates
#   401  (an admin API call without a login is rejected)

# Webhook verification handshake (uses your WHATSAPP_VERIFY_TOKEN; do not paste it into shared logs)
curl -s "https://<DOMAIN>/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=<WHATSAPP_VERIFY_TOKEN>&hub.challenge=12345"
#   12345   (a wrong token returns 403)
```

Routing from `vercel.json` (any other path returns 404):

| Browser path | Goes to |
|---|---|
| `/auth/*`, `/api/*`, `/whatsapp/*`, `/health` | the Express function |
| `/admin/assets/*` | static files (cached one year, immutable) |
| `/admin`, `/admin/*` | `admin/index.html` (client-side routes) |

Because Admin and API share one origin there is no CORS between them, and `connect-src` in the Admin CSP only allows `self` and `https://*.supabase.co`.

### 7. Confirm the client IP handling

On Vercel `TRUST_PROXY_HOPS` is `1` by default, so the rate limiters key each client by its real address. After the first deploy confirm that two clients on different networks do not share one allowance (`Docs/08-cloud-deployment.md` Step 7 asks for this check).

### 8. Scheduled notifications (Cloud Scheduler)

The in-app notifications that are not triggered by an action (daily reminders and summaries at 16:00 / 18:00, the Owners' health check at 06:00, deleting notifications older than 90 days) are sent by `POST /api/tasks/notification-scan` (`src/services/notificationScanService.js`). Cloud Scheduler calls it every 15 minutes; the endpoint decides what is due from the Asia/Colombo clock, so the schedule itself carries no business time. Repeated, overlapping or retried calls never duplicate a notification (dedupe keys), and a missed call is made up by the next one the same day.

Authentication is the same as `/api/tasks/import-recovery`: a Google-signed OIDC token with the expected audience and the scheduler service account's verified e-mail. The route answers **404** unless **both** `NOTIFICATION_SCAN_SCHEDULER_AUDIENCE` and `NOTIFICATION_SCAN_SCHEDULER_INVOKER` are set, and 401 for a call without a valid token.

**Configure it per Vercel project / environment.** Each deployment that should send notifications (production is `prod-lilygaops`, served at the production admin domain) needs its own two variables (scope: that project's Production) and its own scheduler job pointing at its own URL. A job pointing at another deployment's URL does nothing for this one; a deployment without the variables never sends scheduled notifications.

```bash
API=https://<DOMAIN>                     # this Vercel project's production domain
SCHED_SA=<sa>@$PROJECT.iam.gserviceaccount.com

# In Vercel (this project, Production), then redeploy:
#   NOTIFICATION_SCAN_SCHEDULER_AUDIENCE = $API/api/tasks/notification-scan
#   NOTIFICATION_SCAN_SCHEDULER_INVOKER  = $SCHED_SA

gcloud scheduler jobs create http emlynk-notification-scan --project=$PROJECT --location=$REGION   --schedule="*/15 * * * *" --time-zone=Asia/Colombo   --uri="$API/api/tasks/notification-scan" --http-method=POST   --oidc-service-account-email=$SCHED_SA --oidc-token-audience="$API/api/tasks/notification-scan"   --attempt-deadline=60s

gcloud scheduler jobs describe emlynk-notification-scan --project=$PROJECT --location=$REGION
#   expect schedule '*/15 * * * *', httpTarget.oidcToken set, audience = the full endpoint URL
```

Use `gcloud scheduler jobs run emlynk-notification-scan --project=$PROJECT --location=$REGION` to trigger one at once: the answer (200) lists each rule with `NOT_DUE`, `DONE`, `SKIPPED` or `FAILED` and counts only. The function log has one `notification_scan.run` line per call; a rejected token logs `notification_scan.trigger_rejected`. Use a different job name per project when one Google Cloud project schedules several deployments.

**Known limitation: password-change reminders (A3 Analysts 3 months, C3 Job Handlers 2 months, D4 Team Leads 30 days).** The app stores no password-change date, so these reminders use Supabase `auth.users.updated_at` (then the account's activation date, then its creation date). If Supabase also moves `updated_at` on sign-in, which has not been verified, the reminders may fire late or rarely for staff who sign in often. Each reminder is sent once per recorded change time. A later upgrade should add an app-owned `password_changed_at` that is set only when the password changes.

## Project B: Candidate Form

### 1. Create the project

Add New → Project → the same repository, then set:

| Setting | Value |
|---|---|
| Root Directory | **`candidate-form`** |
| Framework Preset | Vite |
| Install Command | `npm ci` |
| Build Command | `npm run build` (runs `tsc --noEmit` then `vite build`) |
| Output Directory | `dist` |
| Production Branch | `main` once the folder exists there; until `candidate-form/` is merged to `main`, the Root Directory picker cannot find it: temporarily set the Production Branch to the branch that has it (`stage`) |

(`candidate-form/vercel.json` already contains these and the security headers: CSP `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Cache-Control: no-store`, `X-Robots-Tag: noindex`.)

### 2. Environment variables

| Variable | Value |
|---|---|
| `VITE_API_BASE_URL` | Project A's public origin: `https://<project-A-domain>`; **no trailing slash, no `/admin`**. An invalid value fails the build |
| `VITE_API_ADMIN_MOBILE_NUMBERS` | Optional contact numbers, comma separated |

No secrets, no Supabase keys, no service-role key.

### 3. Order for the two Vercel projects

The two projects each need the other's domain:

1. Deploy **Project A** first (without `CANDIDATE_FORM_ORIGIN`): the form feature is simply unavailable until it is set.
2. Note A's domain. Create **Project B** with `VITE_API_BASE_URL=https://<A-domain>` and deploy it.
3. Note B's domain. On Project A set `CANDIDATE_FORM_ORIGIN=https://<B-domain>` (bare origin) and `CANDIDATE_FORM_TOKEN_SECRET`, then **redeploy A**.

A bad `CANDIDATE_FORM_ORIGIN` shows up as `503 FORM_NOT_CONFIGURED` when staff click **Share Form**, or as share links pointing at `localhost` ([11](11-TROUBLESHOOTING.md)). The backend never derives the link origin from the request `Host` header (host-header injection protection).

### 4. Validate

- Opening `https://<B-domain>/` directly shows **"Open your link"**: this is correct. The form only unlocks from a link of the form `https://<B-domain>/#k=<secret>` generated by **Share Form** in the Admin console.
- In the Admin console open a **test** candidate (no real data), use **Share Form**, and confirm the link origin is B's domain, not `localhost`.

## Meta (WhatsApp) webhook

Do this after Project A is live and healthy (or for stage, after the stage deployment works).

1. Meta for Developers → your app → WhatsApp → Configuration → Webhook.
2. Callback URL: `https://<A-domain>/whatsapp/webhook`.
3. Verify token: exactly the value of `WHATSAPP_VERIFY_TOKEN` for that environment.
4. Verify and save; then subscribe to the **`messages`** field.
5. Send a test message from a **test** number. Do not send real candidate documents while testing.

Every POST is HMAC-SHA256 verified with `META_APP_SECRET` before any processing (`Docs/04-whatsapp-integration.md`). A received message becomes a `temporary_data` row; the Cloud Run submission worker ([07](07-SUBMISSION-WORKER-DEPLOYMENT.md)) then processes it. If nothing is processing, check the worker's logs, not Vercel's.

## Rollback

Vercel → Deployments → pick the previous good deployment → **Promote to Production** (or Instant Rollback). Database migrations are forward only and are **not** rolled back by this: migrate additively so the previous deployment still works with the new schema.

## Vercel checklist

- [ ] Project A: root `.`, framework Other, Production Branch `main`
- [ ] Every variable present in the right scope (Production / Preview)
- [ ] Secrets marked Sensitive
- [ ] `APP_BASE_URL` matches this environment and is in Supabase redirect URLs
- [ ] `/health` 200, `/admin` 200, unauthenticated admin API 401
- [ ] Project B: root `candidate-form`, `VITE_API_BASE_URL` set before the build
- [ ] `CANDIDATE_FORM_ORIGIN` on A equals B's origin
- [ ] Meta webhook verified and subscribed to `messages`
- [ ] Scheduled notifications: `NOTIFICATION_SCAN_SCHEDULER_*` set on this project and a Cloud Scheduler job (every 15 min) calling its own `/api/tasks/notification-scan`
