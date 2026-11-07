# 11. Troubleshooting

Each entry: **Symptom → Cause → How to verify → Fix.** Only problems that apply to the current architecture are listed. Commands use placeholders; read `--project` before running anything.

## Index

[Environment and startup](#environment-and-startup) · [Database](#database) · [Vercel](#vercel) · [Supabase Auth](#supabase-auth) · [Cloud Run and OCR](#cloud-run-and-ocr) · [Artifact Registry / build](#artifact-registry-and-build) · [Sheet Sync](#sheet-sync) · [Candidate Form](#candidate-form) · [WhatsApp](#whatsapp-webhook)

---

## Environment and startup

### "Invalid environment configuration:" and a list of names
- **Cause:** a required variable is missing or malformed (`src/config/env.js`). The message names variables, never values.
- **Verify:** compare with [02](02-ENVIRONMENT-VARIABLES.md). Format rules: `DATABASE_URL` must be `postgresql://…`; `OCR_SERVICE_URL` must be `https://` unless loopback; `WHATSAPP_API_VERSION` like `v21.0`; `APP_BASE_URL` an origin with no path.
- **Fix:** set the variable in the right place (Vercel scope, Cloud Run `--set-env-vars`/`--set-secrets`, or `.env`), then redeploy/restart. The submission worker needs only its five variables; the Sheet Sync worker only `DATABASE_URL`, `SHEET_SPREADSHEET_ID`, `SHEET_TAB_NAME`.

### Startup fails with `ERR_MODULE_NOT_FOUND` / TypeScript syntax error from `generated/prisma`
- **Cause:** Node older than 22.18 (cannot load the TypeScript-generated Prisma client), or the client was never generated.
- **Verify:** `node --version`; `ls generated/prisma/client.ts`.
- **Fix:** use Node `^22.18.0 || >=23.6.0`; run `npx prisma generate`. In Docker the image runs `prisma generate` during `npm ci`; if you changed the Dockerfile, keep `COPY prisma/schema.prisma` **before** `npm ci`.

### `EPERM: operation not permitted, rename '...query_engine-windows.dll.node'` (Windows)
- **Cause:** a running Node process locks the engine.
- **Fix:** stop Node processes (`Get-Process node | Stop-Process`), rerun `npx prisma generate`.

### Missing module (for example `google-auth-library`) in a deployed container
- **Cause:** `google-auth-library` is a normal dependency of the root package, so a missing module means a stale or broken image/install, not a missing package in `package.json`.
- **Verify:** `grep google-auth-library package.json`; check the build log of the image that is actually running (`gcloud run services describe … --format='value(spec.template.spec.containers[0].image)'`).
- **Fix:** rebuild from a clean checkout (`npm ci --omit=dev` runs in the Dockerfile) and redeploy.

---

## Database

### `EMAXCONNSESSION: max clients reached in session mode`
- **Symptom:** admin API returns 500; `prisma migrate status` fails with that code.
- **Cause:** Supavisor's session-mode pooler has hit its client limit: too many pools (many Vercel instances, Cloud Run instances, local processes, IDE connections), each up to `DATABASE_POOL_MAX` connections.
- **Verify:** Supabase dashboard → Reports → Database connections; count running instances.
- **Fix:** keep `DATABASE_POOL_MAX` at its default 3 on Vercel and 2–3 on workers; stop idle local Node processes and DB IDE sessions; do not raise `--max-instances` carelessly. Keep the **session** pooler (needed for interactive transactions); do not switch to transaction mode.

### `P1001` / "Can't reach database server" from Cloud Run
- **Cause:** using the **direct** host (`db.<ref>.supabase.co`), which is IPv6 only; Cloud Run's default egress is IPv4.
- **Fix:** use the **session pooler** string (`aws-0-<region>.pooler.supabase.com:5432`, user `postgres.<project-ref>`).

### Authentication failed / wrong password
- **Cause:** wrong or un-encoded password in `DATABASE_URL` (special characters must be URL-encoded), or the password was reset.
- **Verify:** `npm run db:check` (prints only the error type).
- **Fix:** reset the DB password in Supabase, URL-encode it, update the Secret Manager version and redeploy.

### `P3009` or checksum mismatch on `prisma migrate deploy`
- **Cause:** a previously applied migration file was edited, or a migration failed half-way.
- **Fix:** never edit applied migrations. For an aborted migration inspect with `npx prisma migrate status`; resolve with `npx prisma migrate resolve --rolled-back <name>` only after confirming nothing was applied, then add a new forward-only migration. Ask the senior before resolving anything on production.

### `P4002` from `prisma db pull` / `migrate diff`
- **Cause:** `"user".auth_user_id` references Supabase's `auth` schema, which Prisma does not manage.
- **Fix:** accepted limitation. Do not use these commands against Supabase; use `migrate status` and `validate` (`Docs/SUPABASE_AUTH.md`).

---

## Vercel

### Admin works but the API / deployment behaves like another environment
- **Cause:** a variable is scoped to Production only, so Preview (`stage`) lacks it or has stale values.
- **Verify:** Vercel → Settings → Environment Variables: the **Preview** box checked for every variable stage needs.
- **Fix:** enable Preview scope, then redeploy (environment variables apply to new deployments only).

### The Admin URL gives a 404 at `/`
- **Cause:** the Admin SPA is served under **`/admin`** only (`vite base: "/admin/"`, router basename `/admin`). `/` is not mapped.
- **Fix:** open `https://<DOMAIN>/admin`. Make sure `APP_BASE_URL` is the bare origin; the app appends `/admin/setup-password` itself.

### Build runs the API entry or the worker on Vercel
- **Cause:** Vercel auto-detected Express because the project's Framework Preset was changed from "Other".
- **Fix:** Framework Preset **Other** (`vercel.json` sets `framework: null`). The function entry is `api/index.js`.

### Webhook signature failures only on Vercel
- **Cause:** the request body was parsed before Express could verify the HMAC.
- **Verify:** `NODEJS_HELPERS=0` present in the project's variables; `Docs/08-cloud-deployment.md` Step 7.
- **Fix:** set `NODEJS_HELPERS=0` and redeploy.

### All users share one rate-limit allowance (429 for unrelated users)
- **Cause:** `TRUST_PROXY_HOPS` wrong: Express sees Vercel's internal address for everyone.
- **Fix:** leave `TRUST_PROXY_HOPS` unset on Vercel (defaults to 1) or set it to `1`; never `true`.

### Candidate Form root directory not found when creating project B
- **Cause:** the repository's default branch does not yet contain `candidate-form/`.
- **Fix:** temporarily set the Production Branch to the branch that has it, or merge first.

### Admin shows "Sign-in is not configured"
- **Cause:** `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` missing **at build time**.
- **Fix:** set both in Vercel (and `admin/.env.local` locally) and **redeploy**; Vite embeds them at build.

---

## Supabase Auth

### Invitation endpoint returns 503 `INVITE_NOT_CONFIGURED`; no e-mail is sent
- **Cause:** `APP_BASE_URL` missing or not a valid origin.
- **Fix:** set `APP_BASE_URL` (origin only, no path, no trailing slash) for that environment.

### Invitation link opens the wrong site, or "redirect URL not allowed"
- **Cause:** the environment's `/admin/setup-password` (or `/admin/reset-password`) is not in Supabase → Authentication → URL Configuration → Redirect URLs, or `APP_BASE_URL` points elsewhere.
- **Fix:** add the exact URLs; correct `APP_BASE_URL`.

### Sign-in works but every API call is 401/403
- **Cause:** the user has no `public."user"` row, is `INVITED`/`INACTIVE`, or holds the retired `MANAGER` role (403 `ROLE_NOT_SUPPORTED`); or the backend's `SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_URL` belong to a different project than the browser's.
- **Verify:** both `SUPABASE_URL` values (server and `VITE_SUPABASE_URL`) refer to the same project ref; check the user's row.
- **Fix:** align the projects; `npm run user:create -- --email … --link` links an existing identity; convert retired roles with `npm run user:migrate-manager`.

---

## Cloud Run and OCR

### OCR requests return 403 (or 401) from Cloud Run
- **Cause:** the caller's identity lacks `roles/run.invoker` on `emlynk-ocr-worker`, or the token audience is not the service URL (a custom or alternate URL).
- **Verify:** `gcloud run services get-iam-policy emlynk-ocr-worker --region=<REGION>`; the submission worker's service account (`emlynk-backend@…`) must be listed. Test: `curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" <URL>/health`.
- **Fix:** add the binding ([06](06-OCR-WORKER-DEPLOYMENT.md#5-authentication-how-the-caller-gets-in)). Use the exact `status.url` as `OCR_SERVICE_URL`.

### Submissions stay queued; worker log shows OCR "credentials unavailable" (`reason: CREDENTIALS`)
- **Cause:** the process has no Application Default Credentials: you are running the worker **locally/in a plain container** against a deployed OCR URL, or the Cloud Run service has no service account attached.
- **Verify:** `gcloud run services describe emlynk-submission-worker --format='value(spec.template.spec.serviceAccountName)'`.
- **Fix:** on Cloud Run, attach `emlynk-backend`. Locally, use `OCR_SERVICE_URL=http://127.0.0.1:8080` with `npm run ocr:start`, or `gcloud auth application-default login`. Do not create key files unless unavoidable.

### OCR returns 503 `OCR_BUSY`, or the instance restarts / is killed for memory
- **Cause:** more concurrent documents than slots; or too little memory for large images (512 MiB is below the recommended 2 GiB).
- **Fix:** deploy with `--cpu=2 --memory=2Gi --concurrency=2`; check the Memory metric. The queue retries on `OCR_BUSY`.

### A Cloud Run revision fails to become ready
- **Cause:** the container is not listening on `$PORT`, or crashes at startup on a missing variable.
- **Verify:** `gcloud run services logs read <service> --region=<REGION> --limit=50`. The worker listens only when `PORT` is set (Cloud Run sets it).
- **Fix:** deploy the image with the right `--command=node --args=src/worker.js` (submission worker) or `src/sheetSyncWorker.js`; supply required variables/secrets.

### Deploy fails: "Permission denied on secret" / "Secret ... not found"
- **Cause:** the runtime service account lacks `roles/secretmanager.secretAccessor` on that secret, or the secret name/version is wrong.
- **Fix:** `gcloud secrets add-iam-policy-binding <SECRET> --member=serviceAccount:<SA> --role=roles/secretmanager.secretAccessor`; confirm `gcloud secrets versions list <SECRET>`.

### A rotated secret is not picked up
- **Cause:** running instances keep the value read at start.
- **Fix:** roll a new revision (`gcloud run services update <service> --update-secrets=…` or redeploy).

### Wrong region errors ("service not found")
- **Cause:** services are in different regions (submission worker `asia-northeast1`, OCR and Sheet Sync `asia-south1`) and the command used the wrong `--region`.
- **Fix:** `gcloud run services list --project=<PROJECT_ID>` shows each service's region.

---

## Artifact Registry and build

### `denied: Permission "artifactregistry.repositories.uploadArtifacts" denied` / push unauthorized
- **Cause:** Docker is not authenticated to the registry host, or the identity doing the build/push lacks write access to the repository.
- **Fix:** `gcloud auth configure-docker <REGION>-docker.pkg.dev`; grant `roles/artifactregistry.writer` on the repository to the pushing identity (for Cloud Build, the identity named in the build log).

### Repository not found
- **Cause:** repository or region name mismatch (`emlynk-ocr` is in `asia-south1`; `emlynk-backend` in `asia-northeast1` in the documented layout).
- **Fix:** `gcloud artifacts repositories list --project=<PROJECT_ID>`.

### Cloud Build image lacks files you changed
- **Cause:** upload follows `.gcloudignore`/`.gitignore`; the build ran from the wrong directory or a different checkout.
- **Fix:** run from the repository root (backend) or give `ocr-worker` as the source (OCR); confirm `git status` and the commit you intend to ship.

---

## Sheet Sync

### Worker exits at start: "GOOGLE_APPLICATION_CREDENTIALS must not be set"
- **Cause:** the variable is defined on the service. Authentication is keyless by design.
- **Fix:** remove it: `gcloud run services update emlynk-sheet-sync-worker --remove-env-vars=GOOGLE_APPLICATION_CREDENTIALS`.

### Test Connection: `ACCESS_DENIED` / HTTP 403
- **Cause:** the spreadsheet is not shared with `emlynk-sheet-sync@…`, or the Sheets API is disabled in the project.
- **Verify:** the Sheet's Share dialog lists the service account; `gcloud services list --enabled --project=<PROJECT_ID> | grep sheets`.
- **Fix:** share the Sheet (Editor to write, Viewer to read) and enable `sheets.googleapis.com`.

### `SCHEMA_INVALID` / `CONFIG_ERROR`
- **Cause:** a required header is missing, renamed or duplicated in row 1 of the mirror tab, or `SHEET_TAB_NAME` does not match.
- **Verify:** `npm run sheet:check` or the check job; compare row 1 with `src/services/sheetSchema.js`.
- **Fix:** restore the header text exactly (order and extra columns are fine). The run is re-checked every 15 minutes and does not burn retries.

### Scheduler job runs but nothing happens (or returns 404/403)
- **Cause:** 404 means `SHEET_SYNC_SCHEDULER_AUDIENCE` and/or `SHEET_SYNC_SCHEDULER_INVOKER` are not both set; 403 means the scheduler account lacks `roles/run.invoker` on the worker; an audience mismatch fails token verification.
- **Verify:** `gcloud scheduler jobs describe emlynk-sheet-sync-reconcile --location=<REGION>`; compare `oidcToken.audience` with the worker URL; `gcloud run services describe … --format='value(spec.template.spec.containers[0].env)'`.
- **Fix:** set both variables to the exact worker URL and the scheduler account e-mail; grant `run.invoker`.

### Sync Now / Test Connection request never completes
- **Cause:** the worker is not running, is an **old image** that predates a Sheet Sync change, or cannot read the database.
- **Fix:** check the worker logs; rebuild and redeploy the worker with every Sheet Sync code change.

### Nothing is written to the Sheet
- **Cause:** by design while `SHEET_SYNC_ENABLED` is not exactly `true`, or a pilot (`SHEET_SYNC_PILOT_CANDIDATE_IDS`) restricts the run.
- **Fix:** do not "fix" this casually; writing is enabled only through the activation procedure (`Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md` §24.10).

---

## Candidate Form

### Share Form returns 503 `FORM_NOT_CONFIGURED`
- **Cause:** `CANDIDATE_FORM_ORIGIN` (or `CANDIDATE_FORM_TOKEN_SECRET`) is missing/invalid on project A.
- **Fix:** set `CANDIDATE_FORM_ORIGIN` to the bare https origin (no path, no trailing slash) and a ≥ 32-character secret; redeploy A.

### Generated links point to `localhost`
- **Cause:** `CANDIDATE_FORM_ORIGIN` holds a local value in that Vercel scope. The origin is deliberately never taken from the request.
- **Fix:** correct the value in the Preview/Production scope; redeploy.

### Browser blocks form API calls (CORS or CSP)
- **Cause:** `CANDIDATE_FORM_ORIGIN` does not exactly equal the form's origin (scheme, host, port); or the form was built with a different `VITE_API_BASE_URL` than the backend actually serving it (the CSP `connect-src` is fixed at build time).
- **Fix:** make them identical, rebuild project B, redeploy.

### The form's root URL shows "Open your link"
- **Cause:** expected. It unlocks only from `/#k=<secret>` links created by **Share Form**.

### Form build fails
- **Cause:** invalid `VITE_API_BASE_URL` (path, query, credentials or a non-http(s) scheme).
- **Fix:** use a bare origin without trailing slash.

---

## WhatsApp webhook

### Meta cannot verify the callback URL
- **Cause:** wrong `WHATSAPP_VERIFY_TOKEN`, wrong URL, or the API is not reachable.
- **Verify:** `curl "https://<DOMAIN>/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=<TOKEN>&hub.challenge=1"` returns `1`; a wrong token returns 403.
- **Fix:** align the token in Meta and in the environment; use the correct environment's domain.

### Webhook POSTs are rejected (401)
- **Cause:** `META_APP_SECRET` does not match the Meta app, or the body was altered before the signature check ([Vercel entry above](#webhook-signature-failures-only-on-vercel)).
- **Fix:** correct the secret from Meta → App settings → Basic.

### Messages arrive but are never processed
- **Cause:** the submission worker is not running or cannot reach OCR/Storage/DB. The Vercel function only records the message.
- **Verify:** submission-worker logs; look for `TEMPORARY_STORED` rows lingering in the Admin console.
- **Fix:** [07](07-SUBMISSION-WORKER-DEPLOYMENT.md); retry failed items from the Admin console after fixing the cause.
