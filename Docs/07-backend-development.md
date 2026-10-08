# Backend Development

Describes the current backend code structure and API surface. For deep detail on any one area, see the dedicated document listed in each section.

## Source Layout

```
src/
├── app.js              # Process entry: starts the HTTP server AND the submission worker (local/Docker/Cloud Run)
├── httpHandler.js       # HTTP-only entry: the Express app with no process lifecycle (Vercel)
├── worker.js             # Worker-only entry: the submission worker with no HTTP server (Cloud Run)
├── workerProcess.js       # Worker lifecycle wrapper used by worker.js (health port, SIGTERM handling)
├── createApp.js          # Express application factory: routes, middleware, security headers
├── adminFrontend.js       # Static SPA server for the built admin assets (/admin), Express-only
├── shutdown.js            # Coordinated graceful shutdown
├── auth/
│   ├── supabaseIdentity.js   # Verifies a Supabase access token (auth.getUser); returns the Supabase user ID
│   └── supabaseAuthAdmin.js  # Supabase Auth Admin API wrapper: inviteUserByEmail, createUser, lookup, delete
├── config/
│   ├── env.js              # Strict environment variable validation (server and worker each have their own required list)
│   ├── runtime.js           # Node version and generated-Prisma-client prerequisite check
│   ├── prisma.js            # Shared PrismaClient instance
│   ├── supabase.js          # Server-side Supabase client (service-role key): Storage, token verification, Auth Admin API
│   ├── appBaseUrl.js        # APP_BASE_URL validation and the invitation redirect (required)
│   └── requiredDocuments.js  # Configuration of mandatory client document types
├── middleware/
│   ├── requireActiveUser.js        # Verifies the Supabase session, then loads public."user" and requires ACTIVE, on every request
│   ├── requireRole.js              # RBAC (ADMIN, MANAGER, ANALYST, REGISTRATION_DESK) from public."user".role
│   ├── apiRateLimiter.js           # Generic API rate limiter
│   ├── postgresRateLimitStore.js   # Shared PostgreSQL-backed store for the limiter (08-cloud-deployment.md)
│   ├── verifyWhatsAppSignature.js  # Raw-body HMAC-SHA256 signature verification
│   └── errorHandler.js             # Centralized error handler; hides internal error details
├── routes/
│   ├── admin.js         # Admin dashboard API (/api/admin/*)
│   ├── auth.js           # /auth/me, /auth/complete-invite (sign-in, recovery and sign-out are Supabase Auth's)
│   ├── users.js          # /api/admin/users: invite, list, change role, deactivate (ADMIN only)
│   └── whatsapp.js        # Webhook verification and message ingestion
├── services/              # Core domain logic — see 05, 06, 09a for the services that live here
└── utils/                 # Pure helpers: checksums, formatters, safe logging, storage naming
```

There are three process entry points, for three different runtimes (`08-cloud-deployment.md` explains why):

| Entry | Runs | Used by |
|---|---|---|
| `src/app.js` | HTTP server + submission worker, in one process | Local development, Docker, a plain single-process deployment |
| `src/httpHandler.js` | HTTP server only, no process lifecycle | Vercel (`api/index.js` imports and exports it) |
| `src/worker.js` | Submission worker only, no HTTP server (except an optional health-check listener) | The dedicated Cloud Run worker service |

All three build the same Express app via `createApp()` and start the same worker via `startSubmissionWorker()` — the split is only about *which* of those two things a given process runs, never a difference in behavior.

## Key Modules

- **`src/app.js` / `src/httpHandler.js` / `src/worker.js`:** each runs the startup checks (`assertValidRuntime`, `assertValidEnv`) before importing anything that reads environment variables at import time. `app.js` and `worker.js` call `process.exit(1)` on failure (so a container fails to start visibly); `httpHandler.js` throws instead, since a Vercel function can't `process.exit()` usefully.
- **`src/createApp.js`:** sets security headers via Helmet (disables `X-Powered-By`, configures CSP with `blob:` support for in-browser file previews), mounts the JSON body parser (with raw-body retention for HMAC verification), and mounts every route.
- **`src/shutdown.js`:** coordinated termination within an 8-second deadline (under Docker's/Cloud Run's 10-second default grace period): stop accepting new HTTP connections, stop the worker from claiming new jobs, let an in-flight job finish or release its lease, disconnect Prisma, exit. `server` is optional (the worker-only process has none unless a health port is configured).
- **`src/middleware/requireActiveUser.js` / `requireRole.js`:** every protected request carries a Supabase access token (`Authorization: Bearer`). The token is verified with Supabase, `public."user"` is loaded by `auth_user_id`, and the user must be `ACTIVE`; `req.user` is that row. `requireRole` then checks `req.user.role`, which is always the database value (never a token claim) and returns a generic 403 without exposing which permission was missing. No cookie authenticates a request. See `SUPABASE_AUTH.md`.
- **`src/routes/whatsapp.js`:** see `04-whatsapp-integration.md`.
- **`src/services/submissionQueue.js`:** the durable background worker — see `05-ocr-document-processing.md` and `08-cloud-deployment.md`.
- **`src/services/documentProcessingService.js`:** orchestrates the full pipeline for one document — see `05-ocr-document-processing.md`.
- **`src/services/storagePlacementService.js`:** where a document ends up — see `06-storage-management.md`.
- **`src/services/policeCountdownService.js` / `adminPoliceService.js`:** the 21-day police report countdown (`OVERDUE`, `DUE_TODAY`, `DUE_SOON`, `PENDING`, `DATE_MISSING`, `NOT_UPLOADED`, `COMPLETED`).
- **`src/services/adminReviewActionService.js`:** the audited review-queue actions (Approve, Keep Pending, Remove, Retry, Replace Verified, Keep as Version, Set Document Type, Assign Client, Set Police Date) — see `09a-admin-dashboard-api.md`.

## API Routes

### Authentication (`/auth`)

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/auth/me` | The signed-in user's application profile (`userId`, `email`, `name`, `role`, `status`) | Supabase access token, ACTIVE user |
| POST | `/auth/complete-invite` | The invitee, after setting a password with Supabase, activates their `INVITED` account | Supabase access token |

Sign-in, sign-out, password recovery and the invitation email are **Supabase Auth's**, called directly by the admin app; the backend has no login, logout or password endpoints. User management (invite, list, change role, deactivate) is `/api/admin/users` (ADMIN only, `09a-admin-dashboard-api.md`).

### WhatsApp Webhook (`/whatsapp`)

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/whatsapp/webhook` | Meta verification handshake | Verify token |
| POST | `/whatsapp/webhook` | Ingest incoming document messages | HMAC-SHA256 signature |

### Admin Dashboard API (`/api/admin`)

| Method | Path | Purpose | Role |
|---|---|---|---|
| GET | `/api/admin/overview` | KPIs, status breakdown, review summary | ADMIN, MANAGER, ANALYST |
| GET | `/api/admin/documents` | List stored documents, filters/sort/paging | ADMIN, MANAGER, ANALYST |
| GET | `/api/admin/documents/missing` | Clients missing required documents | ADMIN, MANAGER, ANALYST |
| POST | `/api/admin/documents/:documentId/police-date` | Correct a stored police slip's date | ADMIN, MANAGER |
| GET | `/api/admin/clients` | Client directory, search, completion filters | ADMIN, MANAGER, ANALYST |
| GET | `/api/admin/clients/:passportId` | Client detail: documents, countdown, audit history | ADMIN, MANAGER, ANALYST |
| GET | `/api/admin/review` | Review queue listing | ADMIN, MANAGER, ANALYST |
| GET | `/api/admin/review/:reviewId` | Review item detail | ADMIN, MANAGER, ANALYST |
| GET | `/api/admin/review/:reviewId/file` | Sandboxed file preview stream | ADMIN, MANAGER, ANALYST |
| POST | `/api/admin/review/:reviewId/approve` | Approve → permanent client folder | ADMIN, MANAGER, ANALYST |
| POST | `/api/admin/review/:reviewId/keep-pending` | Leave in review with a reason | ADMIN, MANAGER, ANALYST |
| POST | `/api/admin/review/:reviewId/remove` | Delete the waiting file and record | ADMIN, MANAGER, ANALYST |
| POST | `/api/admin/review/:reviewId/retry` | Re-queue a failed submission | ADMIN, MANAGER, ANALYST |
| POST | `/api/admin/review/:reviewId/replace-verified` | Replace an existing verified document | ADMIN, MANAGER, ANALYST |
| POST | `/api/admin/review/:reviewId/keep-as-version` | Keep alongside an existing verified document | ADMIN, MANAGER, ANALYST |
| POST | `/api/admin/review/:reviewId/document-type` | Correct a misclassified type | ADMIN, MANAGER, ANALYST |
| POST | `/api/admin/review/:reviewId/assign-client` | Link an unidentified submission to a client | ADMIN, MANAGER, ANALYST |
| DELETE | `/api/admin/temporary-documents/:temporaryId` | Manually delete a temporary document | ADMIN, MANAGER, ANALYST |
| GET | `/api/admin/police` | Police workflow status table | ADMIN, MANAGER, ANALYST |
| GET | `/api/admin/reports/daily` | Business-day figures (Asia/Colombo) | ADMIN, MANAGER, ANALYST |

Full detail on every review action and its audit trail: `09a-admin-dashboard-api.md`.

## Environment Variables

The server (`src/app.js`/`src/httpHandler.js`) and the worker (`src/worker.js`) each validate their own required subset at startup and refuse to start with anything missing or malformed (`src/config/env.js`).

| Variable | Required by | Notes |
|---|---|---|
| `DATABASE_URL` | Server, worker | Session-pooler URL in production |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET` | Server, worker | `SUPABASE_SERVICE_ROLE_KEY` is server-side only (Storage, session verification, Auth Admin API); never in a browser build |
| `OCR_SERVICE_URL` | Server, worker | Only the worker calls it, but both validate it |
| `META_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_API_VERSION` | Server only | |
| `APP_BASE_URL` | Server only, **required** | This environment's public admin address: the site origin only, no path, no trailing slash (`http://localhost:5173` locally, the stage/production site address elsewhere). The only source of the invitation redirect `${APP_BASE_URL}/admin/setup-password`; invitations are refused (503 `INVITE_NOT_CONFIGURED`) if it is missing or invalid. Must differ per environment and be an allowed redirect URL in Supabase |
| `PORT` | Optional | Listen port; also enables the worker's health-check listener when set |
| `TRUST_PROXY_HOPS` | Optional, but required behind a real proxy | See `10-security.md` |
| `NODE_ENV` | Optional, but should be `production` in production | Standard Express behaviour (e.g. hides error details) |
| `NODEJS_HELPERS` | Vercel only | Set to `0` so only Express parses the request body |
| `REQUIRED_DOCUMENT_TYPES` | Optional | Defaults to `PASSPORT,POLICE_REPORT,MEDICAL` |
| `BOOTSTRAP_PASSWORD` | Optional, `npm run user:create` only | Password for a bootstrap user, if not typed at the prompt; goes to Supabase Auth only |

**Frontend (admin build, public):** `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (browser-safe anon / publishable key); see `admin/.env.example`. Locally, put them in `admin/.env.local`.

**Not used (removed):** the application has no `JWT_SECRET`, no SMTP settings (`SMTP_*`, `EMAIL_FROM`) and no `ADMIN_SETUP_URL_BASE`. Authentication, invitations, password recovery and their emails are Supabase Auth's; the outgoing-email SMTP server is configured in the Supabase dashboard, not in this application.

Never required: `GOOGLE_APPLICATION_CREDENTIALS` or any service-account key file — Cloud Run's attached identity provides OCR authentication automatically (`08-cloud-deployment.md`).
