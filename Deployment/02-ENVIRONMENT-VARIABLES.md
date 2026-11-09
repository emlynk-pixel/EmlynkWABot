# 02. Environment Variables

Every variable the code reads, where it is set, and where its value comes from. Built from `src/config/env.js`, a search of `process.env` / `import.meta.env` across `src/`, `scripts/`, `ocr-worker/`, `admin/` and `candidate-form/`, the three `.env.example` files, and `deploy/sheet-sync-worker.env.yaml`.

**Never put a real value in this file, in Git, in chat or in a ticket.** Examples below are fake.

## Legend

| Tag | Meaning |
|---|---|
| **REQUIRED** | The process refuses to start (or the feature cannot work) without it |
| **OPTIONAL** | Has a default or only enables a feature |
| **LOCAL ONLY** | Never set in a deployed environment |
| **PRODUCTION ONLY** | Set in deployed environments, not locally |
| **SECRET** | Store in Vercel "Sensitive" variables or Google Secret Manager. Never in code, `.env.example` or logs |
| **PUBLIC** | Embedded in a browser bundle. Safe by design; never put a secret under a `VITE_` name |

## Where each service gets its variables

| Service | Where to set them | Startup check |
|---|---|---|
| Vercel project A (API + Admin) | Vercel → Project → Settings → Environment Variables (Production / Preview) | `REQUIRED_ENV_VARS` in `src/config/env.js` |
| Vercel project B (Candidate Form) | its own Vercel project | build fails on invalid `VITE_API_BASE_URL` (`candidate-form/csp.ts`) |
| Cloud Run submission worker | `--set-env-vars` + `--set-secrets` | `WORKER_REQUIRED_ENV_VARS` |
| Cloud Run Sheet Sync worker | `--env-vars-file` + `--set-secrets` | `SHEET_SYNC_WORKER_REQUIRED_ENV_VARS` |
| Cloud Run OCR worker | none required | n/a |
| Local | `.env`, `admin/.env.local`, `candidate-form/.env.local` | same as the service you run |

## 1. Backend API (Vercel project A, and local `npm start`)

| Variable | Tag | Purpose | Example (fake) | Where the value comes from |
|---|---|---|---|---|
| `DATABASE_URL` | REQUIRED, SECRET | Prisma/pg connection | `postgresql://postgres.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres` | Supabase → Connect → **Session pooler** string (see [03](03-SUPABASE-SETUP.md#postgresql)) |
| `DATABASE_POOL_MAX` | OPTIONAL | Max `pg` pool size per instance. Default **3** (`src/config/prisma.js`). Keep low on Vercel | `3` | You |
| `SUPABASE_URL` | REQUIRED | Project API URL | `https://<project-ref>.supabase.co` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | REQUIRED, SECRET | Backend-only key: storage access, Auth Admin API, token verification. Bypasses RLS | `<service-role-key>` | Supabase → Project Settings → API keys. **Never in a browser, `admin/` or `candidate-form/`** |
| `SUPABASE_BUCKET` | REQUIRED | Private bucket name (holds `temporary/`, `clients/`, `pending/`) | `<bucket-name>` | The name you chose in [03](03-SUPABASE-SETUP.md#storage) |
| `META_APP_SECRET` | REQUIRED, SECRET | Verifies `X-Hub-Signature-256` on webhook POSTs | `<meta-app-secret>` | Meta for Developers → your app → App settings → Basic → App secret |
| `WHATSAPP_VERIFY_TOKEN` | REQUIRED, SECRET | Webhook subscription handshake | `<random-string>` | You invent it; enter the same string in the Meta webhook configuration |
| `WHATSAPP_ACCESS_TOKEN` | REQUIRED, SECRET | Downloads WhatsApp media | `<system-user-token>` | Meta Business → System user token with WhatsApp permissions |
| `WHATSAPP_API_VERSION` | REQUIRED | Graph API version. Must match `^v\d+\.\d+$` | `v21.0` | Meta for Developers |
| `OCR_SERVICE_URL` | REQUIRED (startup check) | OCR worker URL. `https://` unless a loopback address. **The Vercel handler never calls OCR**; the variable is required only because the shared startup check demands it | `https://emlynk-ocr-worker-<hash>.<region>.run.app` | `gcloud run services describe` ([06](06-OCR-WORKER-DEPLOYMENT.md)); locally `http://127.0.0.1:8080` |
| `APP_BASE_URL` | REQUIRED, per environment | This environment's public Admin **origin**: no path, no trailing slash. The only source of the invitation redirect `${APP_BASE_URL}/admin/setup-password` | local `http://localhost:5173`; Vercel `https://<your-admin-domain>` | The environment's public address. Different in every environment |
| `TRUST_PROXY_HOPS` | OPTIONAL | Number of trusted proxy hops (0–10, never `true`). **Defaults to 1 on Vercel** (`VERCEL=1`), unset elsewhere | `1` | Set explicitly only if behind a known proxy |
| `REQUIRED_DOCUMENT_TYPES` | OPTIONAL | Comma list that must include `PASSPORT`; allowed `PASSPORT, POLICE_SLIP, POLICE_REPORT, MEDICAL`. Default `PASSPORT,POLICE_REPORT,MEDICAL` | `PASSPORT,POLICE_REPORT,MEDICAL` | Business decision |
| `CANDIDATE_FORM_ORIGIN` | OPTIONAL (required for the Candidate Form to work) | Candidate Form's exact origin: CORS allow-list and share-link origin. https only (localhost allowed). Bare origin, no path | `https://<candidate-form-domain>` | Vercel project B's domain |
| `CANDIDATE_FORM_TOKEN_SECRET` | OPTIONAL (required for the form), SECRET | ≥ 32 chars; signs/encrypts candidate session tokens | generate below | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `IMPORT_LEDGER_HMAC_SECRET` | REQUIRED for the sheet Upload (import), SECRET | Key of the import change ledger: personal values the ledger must compare later (NIC, phone, dates...) are stored as an HMAC-SHA256 under this key, never in clear and never as a plain hash. **At least 32 random characters. Server only: never in `admin/`, a log or a ticket.** Without a valid key the Upload is refused (503 `LEDGER_KEY_NOT_CONFIGURED`) and nothing is imported: there is no weaker fallback | generate below | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `IMPORT_LEDGER_HMAC_KEY_ID` | OPTIONAL | Id of the current key, `[A-Za-z0-9_-]{1,32}`, stored with every digest it makes. Default `k1` | `k1` | You |
| `IMPORT_RECOVERY_SCHEDULER_AUDIENCE`, `IMPORT_RECOVERY_SCHEDULER_INVOKER` | REQUIRED for the automatic recovery of interrupted imports | The OIDC audience Cloud Scheduler puts in its token (the full URL of `POST /api/tasks/import-recovery`) and the scheduler service account's verified e-mail. **Both unset: the route answers 404 and interrupted imports are not recovered automatically.** Schedule: every minute (`* * * * *`), attempt deadline 60 s | `https://<api>/api/tasks/import-recovery`, `<sa>@<project>.iam.gserviceaccount.com` | You |
| `IMPORT_RECOVERY_HEARTBEAT_GRACE_MS`, `IMPORT_RECOVERY_MAX_IDLE_MS`, `IMPORT_RECOVERY_MAX_ATTEMPTS` | OPTIONAL | How long the dialog's heartbeat may hold an import whose commit lease ran out (default 90 000 ms, min 45 000), the longest it may do so (default 600 000 ms), and consecutive failures before an import needs attention (default 8) | defaults | You |
| `IMPORT_LEDGER_HMAC_SECRET_PREVIOUS`, `IMPORT_LEDGER_HMAC_KEY_ID_PREVIOUS` | OPTIONAL (rotation), SECRET | The key that was current before a rotation, with its id (both, a different id and secret). Entries signed with it stay verifiable; re-sign them with `rekeyImportLedger`, then remove these. Rotation: set the new secret and id as current, move the old pair here | `old` | You |
| `PORT` | OPTIONAL, LOCAL ONLY | Listen port (default 3000 locally). Do not set on Vercel | `3000` | n/a |
| `NODEJS_HELPERS` | PRODUCTION ONLY (Vercel) | Set to `0` so only Express reads the request body (webhook signature needs raw bytes). This is a Vercel platform setting documented in `Docs/08-cloud-deployment.md` Step 7; it is not read by the app code | `0` | n/a |
| `VERCEL` | automatic | Set to `1` by Vercel. Selects the `TRUST_PROXY_HOPS` default | `1` | Vercel sets it. Do not set it yourself |

Not used any more (remove if you find them): `JWT_SECRET`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `ADMIN_SETUP_URL_BASE`. Authentication and email are Supabase Auth's ([`Docs/SUPABASE_AUTH.md`](../Docs/SUPABASE_AUTH.md)).

**Never set on Vercel:** `GOOGLE_APPLICATION_CREDENTIALS` or any Google key file, and `PORT`.

## 2. Admin console build (Vite; Vercel project A build, and `admin/.env.local`)

Read at **build time** and embedded in the public JavaScript bundle (`admin/src/auth/supabaseClient.ts`).

| Variable | Tag | Purpose | Example (fake) | Source |
|---|---|---|---|---|
| `VITE_SUPABASE_URL` | REQUIRED, PUBLIC | Browser-side Supabase Auth client | `https://<project-ref>.supabase.co` | Supabase → Project Settings → API |
| `VITE_SUPABASE_ANON_KEY` | REQUIRED, PUBLIC | Browser-safe anon / publishable key. **The app refuses a service-role key** | `<anon-or-publishable-key>` | Supabase → Project Settings → API keys |
| `ADMIN_API_PROXY_TARGET` | OPTIONAL, LOCAL ONLY | Where the Vite dev server forwards `/auth`, `/api`, `/health`. Default `http://localhost:3000` | `http://localhost:3000` | n/a |

## 3. Candidate Form build (Vercel project B, and `candidate-form/.env.local`)

Only variables beginning `VITE_API_` can reach the bundle (`candidate-form/vite.config.ts`, `envPrefix`).

| Variable | Tag | Purpose | Example (fake) | Source |
|---|---|---|---|---|
| `VITE_API_BASE_URL` | REQUIRED for deployed builds, PUBLIC | The backend's public origin (project A). Injected into the page's Content-Security-Policy `connect-src` at build time; an invalid value **fails the build**. No trailing slash, no `/admin` | `https://<admin-api-domain>` | Vercel project A's domain. Locally `http://localhost:3000` (or empty to use the dev proxy) |
| `VITE_API_ADMIN_MOBILE_NUMBERS` | OPTIONAL, PUBLIC | Comma-separated phone numbers shown on the "Contact Admin" screens | `0771234567,0719876543` | Business |
| `FORM_API_PROXY_TARGET` | OPTIONAL, LOCAL ONLY | Dev-server proxy target. Default `http://localhost:3000` | `http://localhost:3000` | n/a |

## 4. Submission worker (Cloud Run `emlynk-submission-worker`, command `node src/worker.js`)

It reads **only** the five variables in `WORKER_REQUIRED_ENV_VARS` (plus the optional pool size). It needs **no** Meta/WhatsApp secret and no `APP_BASE_URL`.

| Variable | Tag | How it is set on Cloud Run |
|---|---|---|
| `DATABASE_URL` | REQUIRED, SECRET | `--set-secrets=DATABASE_URL=DATABASE_URL:latest` (Secret Manager) |
| `SUPABASE_SERVICE_ROLE_KEY` | REQUIRED, SECRET | `--set-secrets=SUPABASE_SERVICE_ROLE_KEY=SUPABASE_SERVICE_ROLE_KEY:latest` |
| `SUPABASE_URL` | REQUIRED | plain `--set-env-vars` |
| `SUPABASE_BUCKET` | REQUIRED | plain `--set-env-vars` |
| `OCR_SERVICE_URL` | REQUIRED | plain `--set-env-vars` (the OCR service's Cloud Run URL) |
| `DATABASE_POOL_MAX` | OPTIONAL | plain (default 3) |
| `PORT` | automatic | Cloud Run sets it; the worker then opens a tiny `/health` listener |

`NODE_ENV=production` is set in the `Dockerfile`. Do **not** set `GOOGLE_APPLICATION_CREDENTIALS`: the service account attached to the service supplies identity tokens for OCR.

## 5. OCR worker (Cloud Run `emlynk-ocr-worker`)

| Variable | Tag | Purpose |
|---|---|---|
| `PORT` | automatic | Cloud Run sets 8080; the image also sets `PORT=8080` |
| `HOST` | set in the image | `0.0.0.0` in the container; default `127.0.0.1` when run with `npm start` locally |

No application secrets. It has no database or storage access.

## 6. Google Sheet Sync worker (Cloud Run `emlynk-sheet-sync-worker`, command `node src/sheetSyncWorker.js`)

Required: `DATABASE_URL`, `SHEET_SPREADSHEET_ID`, `SHEET_TAB_NAME` (`SHEET_SYNC_WORKER_REQUIRED_ENV_VARS`). The API (Vercel) does **not** read the `SHEET_*` variables; its Settings screen reads the database.

| Variable | Tag | Purpose | Example (fake) | Source |
|---|---|---|---|---|
| `DATABASE_URL` | REQUIRED, SECRET | Same database as the application | (secret) | Secret Manager `DATABASE_URL` |
| `SHEET_SPREADSHEET_ID` | REQUIRED | Target spreadsheet | `<GOOGLE_SPREADSHEET_ID>` | The ID in the spreadsheet URL: `https://docs.google.com/spreadsheets/d/<ID>/edit` |
| `SHEET_TAB_NAME` | REQUIRED | Tab holding the operational mirror | `<SHEET_TAB_NAME>` | The tab's exact name in the spreadsheet |
| `SHEET_SYNC_ENABLED` | OPTIONAL | **Write gate.** Only exactly `"true"` allows writing. Anything else (default `false`) runs read-only | `false` | Change only through the activation procedure ([08](08-GOOGLE-SHEET-SYNC-DEPLOYMENT.md)) |
| `SHEET_FORM_SUBMISSIONS_TAB_NAME` | OPTIONAL | Tab for Candidate Form submissions (same spreadsheet). Default `Candidate Form Submissions` | `Candidate Form Submissions` | Spreadsheet |
| `SHEET_SYNC_DESTINATIONS` | OPTIONAL | JSON list of several destinations instead of the two variables above | see `Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md` §25.2 | n/a |
| `SHEET_SYNC_POLL_INTERVAL_MS` | OPTIONAL | Worker poll interval, default `10000` | `10000` | n/a |
| `SHEET_SYNC_DELETION_GUARD_MAX` / `_FRACTION` | OPTIONAL | Reconciliation safety limits, defaults `10` / `0.05` | | n/a |
| `SHEET_SYNC_BATCH_SIZE`, `SHEET_SYNC_MAX_RETRIES` | OPTIONAL | Accepted but **no effect** (belonged to the removed real-time path) | | |
| `SHEET_SYNC_SCHEDULER_AUDIENCE` | OPTIONAL (both or neither) | Worker URL; the audience of Scheduler's OIDC token. Without both, `/tasks/reconcile` stays disabled (404) | `https://emlynk-sheet-sync-worker-<hash>.<region>.run.app` | `gcloud run services describe` |
| `SHEET_SYNC_SCHEDULER_INVOKER` | OPTIONAL (both or neither) | E-mail of the scheduler service account | `emlynk-sheet-sync-scheduler@<PROJECT_ID>.iam.gserviceaccount.com` | your service account |
| `SHEET_SYNC_PILOT_CANDIDATE_IDS` | OPTIONAL | First-write pilot only: comma list of candidate unique IDs | | [08](08-GOOGLE-SHEET-SYNC-DEPLOYMENT.md) |
| `DATABASE_POOL_MAX` | OPTIONAL | `2` in `deploy/sheet-sync-worker.env.yaml` | `2` | n/a |
| `GOOGLE_APPLICATION_CREDENTIALS` | **MUST NOT BE SET** | The worker refuses to start with it set: authentication is keyless | | |

The non-secret subset is kept in `deploy/sheet-sync-worker.env.yaml` (used with `--env-vars-file`). **That file in the repo contains the real spreadsheet ID and tab name.** Treat it as environment-specific: for a new environment copy it outside the repo or edit your own copy and do not commit it.

## 7. Scripts and tests

| Variable | Tag | Used by |
|---|---|---|
| `BOOTSTRAP_PASSWORD` | OPTIONAL, LOCAL ONLY | `npm run user:create` for non-interactive runs. Prefer the hidden prompt; never put it on a command line or in a committed file |
| `RUN_OCR_TESTS` | OPTIONAL, LOCAL ONLY | `RUN_OCR_TESTS=1` enables real-Tesseract tests (slow) |
| `GOOGLE_APPLICATION_CREDENTIALS` | LOCAL ONLY, OCR only | Only when the backend runs **outside Google Cloud** and must call the private OCR service: path to a key of an account with `roles/run.invoker`. Not for Sheet Sync. Never commit the file |

## 8. Per-environment values

| Variable | Local | Stage | Production |
|---|---|---|---|
| `DATABASE_URL` | dev DB | stage DB | production DB |
| `SUPABASE_URL` / keys / bucket | dev project | stage project (or separate bucket) | production project |
| `APP_BASE_URL` | `http://localhost:5173` | the stage Vercel Preview URL | the production Admin domain |
| `OCR_SERVICE_URL` | `http://127.0.0.1:8080` | stage OCR service | production OCR service |
| `CANDIDATE_FORM_ORIGIN` | `http://localhost:5174` | stage form URL | production form URL |
| `CANDIDATE_FORM_TOKEN_SECRET` | local random | **different** random | **different** random |
| `META_*`, `WHATSAPP_*` | placeholders or a Meta test number | Meta test app | production Meta app |

Rule: **a secret value is never shared between two environments**, and never copied to a laptop.

## 9. Quick validation

The server validates variables at startup and names only the failing variable, never its value:

```bash
npm start            # prints "Invalid environment configuration:" with names if something is wrong
npm run worker       # same for the worker's five variables
npm run db:check     # only tests DATABASE_URL
```
