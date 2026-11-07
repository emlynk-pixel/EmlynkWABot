# 10. Administration, Environments, Security and Optional Components

## First system administrator

Staff accounts are **Supabase Auth identities** plus a row in `public."user"` holding the role and status. The application has no public sign-up and no HTTP endpoint that creates the first user. The first user is created once per environment with a bootstrap script run by an operator who holds the server credentials (`scripts/createUser.js`, `npm run user:create`).

### Roles (current code: `src/middleware/requireRole.js`)

```
OWNER  >  ADMIN  >  TEAM_LEAD  >  ANALYST / REGISTRATION_DESK / JOB_HANDLER
```

The retired `MANAGER` role is refused. Full matrix: [`Docs/ROLES_AND_PERMISSIONS.md`](../Docs/ROLES_AND_PERMISSIONS.md); user-management rules: [`Docs/OWNER_ROLE.md`](../Docs/OWNER_ROLE.md).

| Rule | Effect |
|---|---|
| There is **one OWNER**, set **in the database only** | The application never gives the OWNER role and never changes or deactivates the OWNER |
| Only OWNER can invite or promote **ADMIN** | An ADMIN can manage only the roles below ADMIN |
| Roles are read from the database on every request | A role change applies on the user's next click |
| Users are never deleted, only deactivated | Audit history references them |

### Create the first user

Prerequisites: the target environment's database is migrated ([03](03-SUPABASE-SETUP.md)), and you can supply that environment's `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `DATABASE_URL`.

```bash
# New environment with no users yet: create the OWNER directly
npm run user:create -- --name "Full Name" --email owner@example.com --role OWNER

# Or an ADMIN (the default role if --role is omitted)
npm run user:create -- --name "Full Name" --email admin@example.com --role ADMIN
```

What it does: creates a Supabase Auth identity (email confirmed) with the password you type at a **hidden prompt (asked twice)**, then the ACTIVE `public."user"` row. It prints only the user ID and status. The password goes to Supabase only.

Variants:

```bash
# Link an existing Supabase Auth identity (found by email) that has no application row yet
npm run user:create -- --email someone@example.com --link --role ANALYST
```

An email that already has a row is refused and nothing changes.

Precautions:

- It needs the **server** credentials of the environment. For **local/dev** put them in your own `.env`. For **stage/production**, provide them to one shell session only (for example `export` them in that terminal, run the command, close the terminal), do not save production values in a file on your laptop, and run it from a trusted machine.
- `BOOTSTRAP_PASSWORD` can supply the password non-interactively. Never put it on a command line or in a committed file; prefer the prompt.
- Use a strong, unique password and a real mailbox you control; then change the password and enable whatever Supabase Auth hardening the project uses.
- Do not paste the output (it contains no secret, but it identifies a user) into public channels.

### Promote an existing ADMIN to OWNER

If an environment already has ADMINs but no OWNER, an operator with database access runs one guarded SQL transaction once (it changes exactly one row, only for an ACTIVE ADMIN while no ACTIVE OWNER exists, and writes the audit entry). The exact SQL is in [`Docs/OWNER_ROLE.md`](../Docs/OWNER_ROLE.md) → "Existing environment: promote one existing ADMIN". Use it as written.

### Everyone else

Invite them from the Admin console (**Settings → Invite User**). The invitation e-mail link points at `${APP_BASE_URL}/admin/setup-password` ([04](04-VERCEL-DEPLOYMENT.md), [03](03-SUPABASE-SETUP.md#auth)); if it points at `localhost` or the wrong site, `APP_BASE_URL` for that environment is wrong. If the retired `MANAGER` role still exists on an environment, see `npm run user:migrate-manager` ([09](09-TESTING-AND-VERIFICATION.md)).

## Environment separation

| | Local | Dev (shared) | Stage | Production |
|---|---|---|---|---|
| Purpose | your machine | integration of finished features | final QA, client acceptance | live operation |
| Git branch | any working branch | `dev` | `stage` | `main` |
| How code arrives | edit | feature branches merged into `dev` | `dev` merged into `stage` | `stage` merged into `main` after sign-off (no direct commits) |
| Web (Vercel) | `npm start`, `npm run admin:dev` | not deployed unless configured | **Preview** deployment of `stage` | **Production** deployment of `main` |
| Database | own dev DB (Supabase dev project or local Docker) | shared dev DB | stage DB | production DB |
| Supabase Auth + Storage | dev project | dev project | stage project | production project |
| Cloud Run | local processes | none | stage services or none | production services |
| Secrets | your own dev values | dev values | stage-only values | production-only values |
| External integrations | Meta test number; Sheet copy or `SHEET_SYNC_ENABLED=false` | same | Meta test app; **a separate Sheet copy** | Meta production app; the operational Sheet |
| `APP_BASE_URL` | `http://localhost:5173` | its own | the Preview domain | the production Admin domain |

Branch strategy and promotion flow: `Docs/08-cloud-deployment.md` Part 3 §2 and §10. In short: feature branch → `dev` (all test suites green) → `stage` (Vercel Preview; run `prisma migrate deploy` against the stage database; smoke test) → `main` (production only after sign-off).

**Rules**

1. **Never reuse production secrets in local development**, and never give a developer machine production database or service-role credentials as a standing configuration.
2. Each environment has its own Supabase project, bucket, Meta credentials and `CANDIDATE_FORM_TOKEN_SECRET`.
3. Vercel Preview and Production have separate variable scopes: set both deliberately.
4. Do not run `prisma migrate dev` anywhere shared. Migrate stage first, then production.
5. Do not point a stage deployment at the production Google Sheet. One worker per Sheet, one authoritative database per worker. **Whether the existing stage Vercel Preview shares the production database is not recorded in the repository** (the Sheet Sync runbook flags it as needing confirmation): check `DATABASE_URL`'s host on each Vercel scope before you migrate or deploy workers.

## Security checklist

Tick before every production deployment.

**Secrets**
- [ ] No secret in Git: `git status` shows no `.env*` (only `.env.example` files are tracked); `git log -p` shows none added. `.gitignore` excludes `.env`, `.env.*`, `Gmail.txt`
- [ ] `deploy/sheet-sync-worker.env.yaml` (tracked) contains production spreadsheet identifiers: do not copy or reuse it for another environment
- [ ] Docker images exclude `.env*` and key files (`.dockerignore`)
- [ ] Secrets only in Vercel *Sensitive* variables and Google Secret Manager; never in client bundles, logs, tickets or chat
- [ ] Rotate immediately any secret that was ever pasted into a public place

**Supabase**
- [ ] Storage bucket **private**; no `anon`/`authenticated` Storage policies
- [ ] `SUPABASE_SERVICE_ROLE_KEY` only on the server side (Vercel server env, Secret Manager). Never in `admin/`, `candidate-form/` or any `VITE_*`
- [ ] Public sign-ups disabled; SMTP configured; redirect URLs list only this environment's `/admin/setup-password` and `/admin/reset-password`
- [ ] Row Level Security migrations applied (`prisma migrate status` up to date)

**Google Cloud**
- [ ] OCR, submission and Sheet Sync services created with `--no-allow-unauthenticated`; unauthenticated `GET /health` returns 403
- [ ] Runtime service accounts have **no Owner/Editor**; secret access granted per secret; `run.invoker` granted per service
- [ ] No service-account key files created (`gcloud iam service-accounts keys list` shows none for runtime accounts); `GOOGLE_APPLICATION_CREDENTIALS` unset on Cloud Run and on Vercel
- [ ] The Sheet Sync write gate `SHEET_SYNC_ENABLED` is `false` until the activation procedure is signed off
- [ ] Billing budget alert exists

**Web**
- [ ] CORS: only the Candidate Form origin is allowed for the public API (`CANDIDATE_FORM_ORIGIN`); Admin and API are same-origin
- [ ] `CANDIDATE_FORM_ORIGIN` is a bare https origin; `VITE_API_BASE_URL` has no trailing slash or path
- [ ] Meta webhook callback and verify token are this environment's
- [ ] Security headers/CSP in `vercel.json` and `candidate-form/vercel.json` unchanged

**Process**
- [ ] No tests against the production database; no real candidate data in test environments
- [ ] Production changes reviewed and merged via `stage`
- [ ] Backups: production database has automatic backups enabled (a paid Supabase plan). Storage objects are **not** part of Supabase database backups

## Optional components

Everything below is **OPTIONAL / NOT REQUIRED FOR BASE DEPLOYMENT.**

| Component | Status in the repository | What to do |
|---|---|---|
| **Google Drive document backup** (one-way, append-only backup of candidate documents to a Google Drive) | **Design only. Nothing is implemented, built or deployed.** There is no Drive code, migration, queue table or Cloud Run Job in the repository. The design and research exist as documents (`GOOGLE_DRIVE_DOCUMENT_BACKUP_RESEARCH.md`, `GOOGLE_DRIVE_BACKUP_IMPLEMENTATION_GUIDE.md`, `DOCUMENT_STORAGE_AND_BACKUP_PLATFORM_COMPARISON.md`) that live on the feature branch `version/Google-File-Sync`, not on `dev` at the time of writing | Do not deploy anything for it. Treat any mention of it in this guide's other documents as future work |
| Load testing | No load-test tooling is documented or checked in | Not part of deployment |
| Additional monitoring / alerting | Not implemented in code. Recommended manually: Cloud Monitoring alerts on Cloud Run 5xx and memory, Billing budget, Supabase usage alerts | Optional operations work |
| Notification system | `Docs/NOTIFICATION_SYSTEM_AUDIT.md` is a research and proposal document; nothing is implemented | Not part of deployment |
| Cloud Run Job `emlynk-sheet-sync-check` | Optional read-only check ([08](08-GOOGLE-SHEET-SYNC-DEPLOYMENT.md)) | Optional |
| Cloud Run Job `emlynk-db-migrate` | Optional way to run `prisma migrate deploy` from the backend image ([03](03-SUPABASE-SETUP.md)) | Optional alternative to migrating from a trusted machine |
| Candidate bulk import | A product feature (Admin), documented in `Docs/CANDIDATE_BULK_IMPORT.md`; needs no extra deployment | n/a |

## Items needing confirmation

Facts this guide could not settle from the repository. Raise them with the senior or project owner.

| # | Question | Why it matters |
|---|---|---|
| 1 | Do **stage** (Vercel Preview) and production use the **same Supabase database**? | Migrations and the single Sheet Sync worker act on whichever database `DATABASE_URL` names |
| 2 | Should the **OCR service** settings be aligned? The recorded production service uses 1 vCPU / 512 MiB / concurrency 80 / default compute service account, while the documented recommendation is 2 vCPU / 2 GiB / concurrency 2 / dedicated account | Possible memory failures under load; least-privilege |
| 3 | Are `META_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN` still needed in **Secret Manager**? | The submission worker doesn't read them; Vercel holds them. Extra copies widen exposure |
| 4 | What **Node.js version** is selected in the Vercel project, and is `NODEJS_HELPERS=0` still required? | The app requires Node 22.18+; the raw-body webhook check depends on the helper being off |
| 5 | Where does a **new environment's mirror tab get its 83-column header row**? (The health check validates headers; it does not create the mirror's header.) | Needed to set up a new Sheet |
| 6 | Is `sheets.googleapis.com` the only extra API Sheet Sync needs? | Enable command isn't written down in the repo docs |
| 7 | Who owns **Meta**, **Vercel**, **Supabase** and **Google Cloud** accounts, and who can grant access? | New developers need invitations |
| 8 | Sheet Sync region (`asia-south1`) differs from the submission worker (`asia-northeast1`) and the database (Tokyo). Intentional? | Latency/cost only; not a correctness issue |
| 9 | The committed `deploy/sheet-sync-worker.env.yaml` contains production spreadsheet identifiers. Should it be replaced by a template? | Avoid accidental reuse in non-production |
| 10 | Supabase plan per environment (the earlier research says Free is not suitable for real data) | Storage and egress limits, backups, project pausing |
