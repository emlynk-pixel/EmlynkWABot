# Emlynk Deployment and QA Process

This document defines the deployment architecture, branch workflow, database migration standards, pre-integration verification, and Quality Assurance (QA) procedures for the Emlynk platform.

---

## 1. Purpose

The purpose of this document is to ensure predictable, secure, and regression-free releases across all components of the Emlynk platform:

1. **Strict Environment Separation**: Maintaining distinct boundaries between local development (`dev`), pre-release integration/staging (`stage`), and live production (`main`).
2. **Preventing Data Corruption & Regression**: Ensuring schema migrations and data transformations are thoroughly validated before hitting shared or production databases.
3. **Rigorous Quality Assurance (QA)**: Establishing mandatory test gates (type-checking, unit/integration testing, security auditing, and responsive browser validation) before code promotion.
4. **Multi-Application Coordination**: Coordinating releases between the Admin Console + API backend (Vercel Project A), the Candidate Extra Details Form (Vercel Project B), and background Cloud Run workers.

---

## 2. Repository & Branch Strategy

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

### 2.1 Branch Definitions

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

### 2.2 Merging Strategy: Cherry-Pick vs. Full Merge

- **Cherry-Pick**:
  - Used when an isolated bug fix or self-contained UI update in a feature branch (e.g., specific Admin styling improvements, date picker corrections) must be brought into `dev` without dragging in incomplete architectural work from the feature branch.
- **Full Merge**:
  - Used when a feature branch has achieved full maturity, completed its internal test suite, and reconciled schema overlaps.
  - *Example*: The `version/candidate-extra-details-form` branch was reconciled with `dev` (aligning the new Client architecture and migration history) and subsequently merged into `dev` via a clean full merge after passing all backend, Admin, and Candidate Form test suites.

---

## 3. Application Deployment Architecture

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

### 3.1 Admin Dashboard + Express Backend (Project A)
- **Deployment Platform**: Vercel (Project A).
- **Build Root**: Repository root (`.`).
- **Components**:
  - **Admin Dashboard**: React 19 + TypeScript + Vite single-page application built into `public/admin`.
  - **API Backend**: Express 5 application running as a Vercel Serverless Function entry point (`api/index.js` importing `src/httpHandler.js`).
- **Routing**: Same-origin routing. Rewrites in root `vercel.json` direct `/api/*`, `/auth/*`, `/whatsapp/*`, and `/health` to the Express handler, while `/admin/*` routes serve `public/admin/index.html`.
- **Branch Binding**: Production points to `main`; Preview deployments trigger on `stage` and feature branches.

### 3.2 Candidate Extra Details Form (Project B)
- **Deployment Platform**: Vercel (Project B).
- **Build Root**: Dedicated subfolder (`candidate-form/`).
- **Components**:
  - React 19 + TypeScript + Vite public single-page application.
  - Completely static distribution (`dist/`).
  - Isolated from internal backend dependencies, Prisma, Supabase SDKs, and private credentials.
- **Communication**: Cross-origin HTTPS calls exclusively to the backend public endpoint (`/api/public/candidate-details/*`).
- **Branch Binding**: Tested on `stage` and feature branches before production cutover.

### 3.3 Rationale for Separate Vercel Projects
Even though both applications reside on the same Git branch, separate Vercel projects are required because:
1. **Different Build Roots**: Project A builds from the repository root; Project B builds from `candidate-form/`.
2. **Different Output Directories**: Project A serves static assets from `public`; Project B compiles to `dist`.
3. **Distinct Public Domains**: Admin is served under the primary domain (`/admin`); Candidate Form is hosted on a dedicated public candidate domain (e.g. `https://candidate-form-preview.vercel.app`).
4. **Strict Security Boundaries**: Candidate Form is public-facing and untrusted; it must never share environment variables, encryption secrets, or service-role keys with the backend.

---

## 4. Admin / Backend Build Configuration

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

## 5. Candidate Form Build Configuration

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

## 6. Environment Variables

All environment variables must be configured with precise environment scoping (Production vs. Preview).

### 6.1 Backend & Admin Project (Vercel Project A)

#### Candidate Form Integration Variables

| Variable | Scope | Type | Description & Format |
|---|---|---|---|
| `CANDIDATE_FORM_ORIGIN` | Preview, Production | Public URL | Exact public origin of the Candidate Form (e.g. `https://candidate-form-preview.vercel.app`). **Bare origin only**: must include protocol, host, and optional port; no path (`/admin`), no trailing slash, no fragment (`/#k=`). Required for CORS allowlist and share-link generation. |
| `CANDIDATE_FORM_TOKEN_SECRET` | Preview, Production | Secret | Minimum 32-character CSPRNG secret used to encrypt/sign candidate session tokens via AES-256-GCM + HKDF. **Backend-only**: never expose to client bundles. |

#### Database & Connection Pool Variables

| Variable | Scope | Type | Description & Format |
|---|---|---|---|
| `DATABASE_URL` | Preview, Production | Secret | PostgreSQL connection string pointing to Supabase **Supavisor session-mode pooler** (e.g., `aws-0-ap-northeast-1.pooler.supabase.com:5432` or port `6543`). Session mode is required for interactive transactions and `FOR UPDATE` row locks. |
| `DATABASE_POOL_MAX` | Preview, Production | Config | Maximum pool size per serverless instance (default: `3`). Keep low to prevent pool exhaustion across concurrent Vercel serverless function invocations. |
| `DIRECT_URL` | N/A | Optional | *Note*: The current `prisma/schema.prisma` configures a single datasource URL (`url = env("DATABASE_URL")`). Direct connection is not currently configured in the schema. |

#### Core Backend Application Variables

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

#### Admin Frontend Build Variables (Embedded in Bundle)

| Variable | Scope | Description |
|---|---|---|
| `VITE_SUPABASE_URL` | Preview, Production | Supabase project URL for browser-side Supabase Auth client. |
| `VITE_SUPABASE_ANON_KEY` | Preview, Production | Supabase public anonymous key (browser-safe). |

### 6.2 Candidate Form Project (Vercel Project B)

| Variable | Scope | Description & Format |
|---|---|---|
| `VITE_API_BASE_URL` | Preview, Production | Backend root domain (e.g., `https://emlynk-wa-bot-git-stage-emlynk-pixel.vercel.app`). **Bare origin only**: no `/admin` suffix, no trailing slash. Injected into CSP `connect-src` at build time. |
| `VITE_API_ADMIN_MOBILE_NUMBERS` | Preview, Production | Optional comma-separated list of administrative contact phone numbers (e.g., `0771234567,0719876543`). Displayed in the Contact Admin state. Configurable without code modifications. |

---

## 7. Prisma & Database Migration Process

### 7.1 Strict Migration Rules

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

### 7.2 Scratch PostgreSQL Rehearsals

For complex or structural migrations (renaming tables, adding foreign keys, altering multi-column unique constraints):
1. Test migration execution on a local throwaway PostgreSQL instance (or PGLite).
2. Validate both execution paths:
   - **Clean-Path**: Replaying all migrations from `20260921064444_init_schema` to latest on an empty database.
   - **Upgrade-Path**: Applying the migration against a clone of the existing shared database containing historical data and previously applied branch migrations.

### 7.3 Multi-Branch Reconciliation & Migration Bridge History

During parallel development on `version/candidate-extra-details-form` and `version/client-management`:
1. Candidate Form migration `20261018130000_job_company_id_and_form_job_group` had already added `job.company_job_id` and unique index `("company_id", "company_job_id")` on the shared database.
2. In parallel, Client Management migration `20261019120000_client_management` renamed `company` to `client`, changed `job.company_id` to `job.client_id`, but on a database built from `dev` first, `company_job_id` already existed.
3. **Bridge & Reconciliation Strategy**:
   - Rather than editing already-applied migrations (which would alter migration checksums and break `_prisma_migrations`), two forward-only migrations were created:
     - `20261018125900_bridge_dev_first_company_job_id`: If in a dev-first state, safely parks `company_job_id` values in `company_job_id_reconcile` and creates a temporary `company_id` column.
     - `20261023120000_reconcile_job_company_job_id`: Copies the parked values back to `company_job_id`, cleans up temporary columns, and establishes the definitive unique index `("client_id", "company_job_id")`.
   - On fresh databases and on the shared database, these bridge migrations safely perform no-op checks (`DO $$ BEGIN IF EXISTS ... END $$;`).

---

## 8. QA Process Before Integration

Before merging any branch into `dev` or promoting `dev` to `stage`, every test suite must pass cleanly.

### 8.1 Automated Test Gates

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

### 8.2 Additional QA Verification Checks

- **Browser QA**: Validate desktop Chrome, Firefox, Safari, and Edge.
- **Mobile Responsive QA**: Inspect responsive layouts at 320px, 375px, 390px, and 412px viewports. Confirm zero horizontal scrolling (`scrollWidth === clientWidth`).
- **Role-Based Access Control (RBAC)**: Verify endpoint authorization for all four roles (`ADMIN`, `MANAGER`, `ANALYST`, `REGISTRATION_DESK`).
- **Audit Logging**: Confirm critical actions (user invite, work allocation, link generation, link revocation, field confirm/reject) record complete audit trails without storing plain credentials or link secrets.
- **Security Scans**: Verify no secrets exist in client bundles, CORS policies reject unauthorized origins, and CSP headers strictly limit connections.

---

## 9. Candidate Form Security QA

The Candidate Extra Details Form handles sensitive candidate data across the public internet and incorporates defense-in-depth security controls.

### 9.1 Single-Candidate Links
- **Entropy & Cryptography**: Created with 256-bit cryptographically secure pseudorandom numbers (`crypto.randomBytes(32)` -> 43-character base64url string).
- **Fragment URL Delivery**: Sent to candidates via URL fragment (`<origin>/#k=<secret>`). Browsers never transmit URL fragments to servers, keeping the secret out of server access logs, proxy logs, and `Referer` headers.
- **Stored Hash**: Only a SHA-256 hash (`token_hash`) is stored in `candidate_form_link`. The plaintext secret cannot be recovered from the database.
- **Two-Factor Candidate Verification**: Unlocking the form requires proving possession of the link secret plus verifying **Passport Number + NIC Number**.
- **Finite Lifespan**: Links expire after 3 days (`FORM_LINK_TTL_MS = 259200000`).
- **Single Submission Guarantee**: Access follows `LOCKED -> UNLOCKED -> SUBMITTED`. Once submitted, the state is immutable; no link can reopen a submitted form.

### 9.2 Job-Group Links
- **Job Binding**: Bound strictly to the immutable UUID `job.id` (never display codes or legacy text).
- **Live Membership Evaluation**: Eligibility is evaluated dynamically against active `job_candidate` records where the job is in `PROCESSING` status. A candidate added to the job later can use the link; a removed candidate is immediately locked out.
- **Cross-Job Isolation**: Candidates assigned to other jobs or unassigned candidates are rejected.
- **Shared Usability**: When one candidate in a job group submits their form, the group link remains active and accessible for remaining eligible candidates.
- **Failure Thresholds**: Group links lock after 100 failed attempts (preventing typos from denying service to the whole group), while per-IP (10 failures / 15 min) and per-passport (5 failures / 1 hour) rate limits prevent targeted brute force.

### 9.3 Session State Machine & Token Invalidation
- Sessions use custom format `cf1~<iv>~<ciphertext>` (AES-256-GCM + HKDF), not JWT-shaped, preventing accidental submission to staff Supabase auth endpoints.
- The session payload carries the candidate's `accessVersion`. Any administrative action (revoking a link, generating a new link, or submitting a form) increments `version`, instantly invalidating all active sessions.

### 9.4 Information Leakage Prevention
- Zero raw Passport Numbers, NICs, or internal Job UUIDs appear in public URLs.
- Verification failures return generic 401 messages with equalized query execution and constant-time comparisons, preventing user enumeration.
- Contact Admin and error states render generic bilingual help text with zero candidate identifiers in the DOM or logs.

---

## 10. Stage Deployment Flow

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

## 11. Stage Smoke-Test Checklist

Every staging release must be verified against this checklist before production approval:

### 11.1 Admin Dashboard Smoke Tests

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

### 11.2 Candidate Form Smoke Tests

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

## 12. Common Deployment Issues & Troubleshooting

### 12.1 Prisma Windows EPERM DLL Lock
- **Symptom**: `npx prisma generate` fails with `EPERM: operation not permitted, rename '...\query_engine-windows.dll.node'`.
- **Root Cause**: A running Node.js process (such as a local backend server or file watcher) holds an active lock on the Prisma query engine DLL.
- **Resolution**: Terminate all active Node processes (`Get-Process node | Stop-Process`), then rerun `npx prisma generate`.

### 12.2 Vercel Wrong Branch / Environment Variable Scope
- **Symptom**: Staging deployment behaves like production, or variables configured in Vercel do not take effect.
- **Root Cause**: Environment variables in Vercel were scoped only to "Production" rather than "Preview", or the deployment was triggered from an unexpected branch.
- **Resolution**: In Vercel Project Settings > Environment Variables, ensure variables required by `stage` have the **Preview** checkbox enabled. Redeploy the deployment after saving.

### 12.3 Candidate Form Root Directory Not Visible in Vercel UI
- **Symptom**: Vercel project configuration cannot find the `candidate-form` directory during setup.
- **Root Cause**: The repository's default branch (`main`) lacked the `candidate-form/` folder before the feature branch was integrated.
- **Resolution**: Set the Vercel project's Production Branch to `stage` (or the relevant feature branch) during initial configuration, or set Root Directory explicitly to `candidate-form`.

### 12.4 Candidate Form Root URL Showing "Open your link"
- **Symptom**: Navigating directly to `https://candidate-form-preview.vercel.app` shows "Open your link" with no input fields.
- **Root Cause**: Expected security behavior. The Candidate Form requires a valid link secret in the URL fragment (`/#k=...`). Without a fragment, verification is disabled to prevent unauthenticated enumeration.
- **Resolution**: Always open the form using a link generated via Admin **Share Form**.

### 12.5 `FORM_NOT_CONFIGURED` (503 Service Unavailable)
- **Symptom**: `POST /api/admin/candidates/:passportId/form-share` returns `503 Service Unavailable` with body `{"code": "FORM_NOT_CONFIGURED"}`.
- **Root Cause**: `CANDIDATE_FORM_ORIGIN` is missing or contains an invalid value (e.g. contains a path or trailing slash) in the backend Vercel environment.
- **Resolution**: Set `CANDIDATE_FORM_ORIGIN` to the bare HTTPS origin (e.g. `https://candidate-form-preview.vercel.app`) in the backend Vercel project settings (Preview scope) and redeploy.

### 12.6 Supabase `EMAXCONNSESSION` Connection Pool Exhaustion
- **Symptom**: Admin API routes return `500 Internal Server Error`; `prisma migrate status` fails with `EMAXCONNSESSION: max clients reached in session mode`.
- **Root Cause**: Supabase session-mode pooler has reached its concurrent client limit. Serverless functions each spawn database connections; if `DATABASE_POOL_MAX` is too high or local development processes stay connected, the pool is exhausted.
- **Resolution**:
  1. Confirm backend `DATABASE_POOL_MAX` is set to `3` on Vercel.
  2. Terminate idle local Node instances and database IDE connections.
  3. Verify Supabase project pooler settings (use session pooler on port 5432 or 6543 session mode for interactive transactions).

### 12.7 Migration History Conflicts & Checksum Mismatches
- **Symptom**: `npx prisma migrate deploy` fails with `P3009` or reports checksum mismatch on previously applied migrations.
- **Root Cause**: An applied historical migration script was modified retroactively instead of introducing a forward-only migration.
- **Resolution**: Never edit applied migrations. Resolve conflicts using `npx prisma migrate resolve --rolled-back <name>` if a transaction aborted cleanly, and introduce forward-only idempotent migrations.

### 12.8 Generated Links Pointing to `localhost`
- **Symptom**: Admin Share Form generates links pointing to `http://localhost:5174/#k=...` instead of the public staging domain.
- **Root Cause**: `CANDIDATE_FORM_ORIGIN` in backend environment is set to local dev origin rather than the staging Candidate Form domain.
- **Resolution**: Update `CANDIDATE_FORM_ORIGIN` in Vercel Preview settings to the public staging URL. The backend intentionally never derives share URLs from the `Host` header to protect against host-header injection attacks.
