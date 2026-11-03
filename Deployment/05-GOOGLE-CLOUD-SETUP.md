# 05. Google Cloud Setup

Google Cloud hosts the three background services and the supporting pieces:

| Piece | Used by |
|---|---|
| Cloud Run services | OCR worker, submission worker, Google Sheet Sync worker |
| Artifact Registry | stores the Docker images |
| Cloud Build | builds images remotely (`gcloud builds submit`) |
| Secret Manager | `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` for the workers |
| Cloud Scheduler | one job: the Sheet Sync reconcile trigger |
| IAM service accounts | runtime identities (no key files) |
| Sheets API | Sheet Sync |

Vercel and Supabase are separate; they need nothing from this page.

> **Placeholders.** `<PROJECT_ID>`, `<REGION>` etc. are yours to choose. The existing production project's IDs and URLs appear in older documents under `Docs/`. **Do not copy them**; they are not yours to reuse. Also read `--project` on every command before pressing Enter: every command below changes a real project.

## 1. Project and billing

1. Create or select a Google Cloud project (console → project picker → New Project). Note its **Project ID** (the string, not the display name).
2. **Link a billing account** (Billing → link). Cloud Run, Artifact Registry and Cloud Build need it even within free allowances.
3. Set a **budget alert** (Billing → Budgets & alerts) before deploying anything.
4. Use a **separate project per environment** (stage and production) if you can; it makes IAM and secrets naturally separate.

## 2. Install and log in to `gcloud`

```bash
gcloud --version
gcloud auth login                                  # your own Google account
gcloud config set project <PROJECT_ID>
gcloud config list                                 # confirm account and project before every session
gcloud auth configure-docker <REGION>-docker.pkg.dev   # only if you push images with Docker (not with Cloud Build)
```

Windows PowerShell and Git Bash both work; the commands below use `\` line continuation (bash). In PowerShell use the backtick `` ` `` or put each command on one line.

## 3. Enable only the APIs this project uses

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  sheets.googleapis.com \
  --project=<PROJECT_ID>
```

| API | Why | Documented in repo? |
|---|---|---|
| `run.googleapis.com` | Cloud Run services | Yes (`ocr-worker/README.md`) |
| `artifactregistry.googleapis.com` | image repositories | Yes |
| `cloudbuild.googleapis.com` | `gcloud builds submit` | Yes |
| `secretmanager.googleapis.com` | secrets | Used in `Docs/08-cloud-deployment.md` Step 3; the enable command itself is not written down |
| `cloudscheduler.googleapis.com` | Sheet Sync trigger | Yes (`Docs/EMLYNK_PROJECT_ISSUES_AND_SOLUTIONS_HISTORY.md`) |
| `sheets.googleapis.com` | Google Sheets API calls from the worker | Not written down; the worker calls the Sheets API, so the API must be enabled in the project that issues the calls (**verify** with the read-only check in [08](08-GOOGLE-SHEET-SYNC-DEPLOYMENT.md)) |

Nothing else (Compute, GKE, Pub/Sub, Cloud SQL, Drive) is needed for the base deployment.

## 4. Regions

The current layout, from the repository docs:

| Service | Region |
|---|---|
| Submission worker | `asia-northeast1` (Tokyo): next to the database and the Vercel functions |
| OCR worker | `asia-south1` (Mumbai) |
| Sheet Sync worker + Scheduler job | `asia-south1` |
| Artifact Registry `emlynk-backend` | `asia-northeast1` |
| Artifact Registry `emlynk-ocr` | `asia-south1` |
| Cloud Run Jobs (migrate, sheet check) | `asia-south1` in the documented examples |

Rule of thumb: keep the submission worker in the same area as the Supabase database. Regions are not hard-wired in code, only in the commands you run; if you choose differently, use your values consistently. Use one `REGION` variable per service in your shell to avoid mixing them.

## 5. Artifact Registry

Artifact Registry stores the container images that Cloud Run runs.

```text
Source in Git → Docker image (Cloud Build or local Docker) → Artifact Registry → Cloud Run revision
```

Create the repositories once per project:

```bash
# Images for the OCR worker
gcloud artifacts repositories create emlynk-ocr \
  --repository-format=docker --location=asia-south1 --project=<PROJECT_ID>

# Images for the backend: the submission worker and the Sheet Sync worker (same Dockerfile)
gcloud artifacts repositories create emlynk-backend \
  --repository-format=docker --location=asia-northeast1 --project=<PROJECT_ID>
```

Image names follow `<REGION>-docker.pkg.dev/<PROJECT_ID>/<REPOSITORY>/<IMAGE>:<TAG>`:

| Image | Built from | Example path |
|---|---|---|
| OCR worker | `ocr-worker/Dockerfile` (context `ocr-worker/`) | `asia-south1-docker.pkg.dev/<PROJECT_ID>/emlynk-ocr/ocr-worker:v1` |
| Submission worker | root `Dockerfile` | `asia-northeast1-docker.pkg.dev/<PROJECT_ID>/emlynk-backend/worker:<TAG>` |
| Sheet Sync worker | the **same** root `Dockerfile` | `asia-northeast1-docker.pkg.dev/<PROJECT_ID>/emlynk-backend/sheet-sync:<TAG>` |

Tag with a short Git commit (`$(git rev-parse --short HEAD)`) so every revision is traceable. Avoid deploying `:latest`.

### Build with Cloud Build (no local Docker needed)

```bash
gcloud builds submit ocr-worker \
  --tag asia-south1-docker.pkg.dev/<PROJECT_ID>/emlynk-ocr/ocr-worker:v1 --project=<PROJECT_ID>

# from the repository root:
gcloud builds submit \
  --tag asia-northeast1-docker.pkg.dev/<PROJECT_ID>/emlynk-backend/worker:$(git rev-parse --short HEAD) \
  --project=<PROJECT_ID> .
```

Notes:

- The root `Dockerfile` excludes secrets through `.dockerignore` (`.env*`, key files). It copies only `src/`, `prisma/schema.prisma`, `prisma/migrations` and `scripts/checkDatabaseConnection.js`; it runs `npm ci --omit=dev`, which triggers `prisma generate` for Linux. It builds on Node 22 (`node:22-bookworm-slim`).
- Cloud Build chooses which files to upload from `.gcloudignore`, or `.gitignore` if there is none; uncommitted new files that are git-ignored are not uploaded. Make sure the commit you want is checked out.
- If the build fails to push with a permission error, grant the identity Cloud Build runs as `roles/artifactregistry.writer` on that repository (**which identity this is depends on the project's age and settings**; check the build log).

### Or build locally with Docker

```bash
gcloud auth configure-docker asia-south1-docker.pkg.dev
docker build -t asia-south1-docker.pkg.dev/<PROJECT_ID>/emlynk-ocr/ocr-worker:v1 ocr-worker
docker push asia-south1-docker.pkg.dev/<PROJECT_ID>/emlynk-ocr/ocr-worker:v1
```

## 6. Secret Manager

Secrets that Cloud Run services read at start-up. Values that are not secret (URLs, bucket name) are plain environment variables, not secrets.

| Secret name (convention used in the project) | Used by | Env var it becomes |
|---|---|---|
| `DATABASE_URL` | submission worker, Sheet Sync worker, optional migrate job | `DATABASE_URL` |
| `SUPABASE_SERVICE_ROLE_KEY` | submission worker | `SUPABASE_SERVICE_ROLE_KEY` |

(`Docs/08-cloud-deployment.md` Step 3 also lists `META_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN` in Secret Manager. The submission worker does **not** read them, they live on Vercel for the API; see [10](10-ADMIN-AND-OPTIONAL-COMPONENTS.md#items-needing-confirmation).)

Create a secret **without leaving the value in shell history or a file**:

```bash
# Interactive: type or paste the value, then Ctrl+D (bash)
gcloud secrets create DATABASE_URL --replication-policy=automatic --project=<PROJECT_ID> --data-file=-

# Or from a password manager command, never from a file in the repo:
printf '%s' '<VALUE>' | gcloud secrets create SECRET_NAME --data-file=- --project=<PROJECT_ID>
```

(`printf` with a literal value stores the value in your shell history: prefer the interactive form, or `read -s VALUE; printf '%s' "$VALUE" | …; unset VALUE`.)

Rotate = add a **new version**:

```bash
printf '%s' '<NEW_VALUE>' | gcloud secrets versions add SECRET_NAME --data-file=- --project=<PROJECT_ID>
gcloud secrets versions list SECRET_NAME --project=<PROJECT_ID>
```

Cloud Run mounts `SECRET_NAME:latest`, so the **next new revision/instance** picks up the new version (an already-running instance keeps the old value until it restarts: redeploy or `gcloud run services update <svc> --update-secrets=…`). Disable the old version after confirming: `gcloud secrets versions disable <N> --secret=SECRET_NAME`.

Grant access **per secret**, to the specific runtime service account, never project-wide:

```bash
gcloud secrets add-iam-policy-binding DATABASE_URL --project=<PROJECT_ID> \
  --member=serviceAccount:<RUNTIME_SA_EMAIL> --role=roles/secretmanager.secretAccessor
```

## 7. Service accounts and IAM

Create one runtime service account per service that needs to be distinguished. Cloud Run uses the attached account directly; **no JSON key is ever created** for these.

| Service account (convention) | Used by | Required permissions | Why |
|---|---|---|---|
| `emlynk-backend@<PROJECT_ID>.iam.gserviceaccount.com` | submission worker (and optional migrate job) | `roles/secretmanager.secretAccessor` on `DATABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (secret level); `roles/run.invoker` on **`emlynk-ocr-worker`** (service level) | Reads its two secrets; calls the private OCR service with a Google identity token |
| `emlynk-sheet-sync@<PROJECT_ID>.iam.gserviceaccount.com` | Sheet Sync worker, optional `emlynk-sheet-sync-check` job | `roles/secretmanager.secretAccessor` on `DATABASE_URL`; **Editor on the Google Sheet itself** (shared like a user, not an IAM role) | Reads the DB secret; reads/writes the spreadsheet with keyless ADC |
| `emlynk-sheet-sync-scheduler@<PROJECT_ID>.iam.gserviceaccount.com` | Cloud Scheduler job | `roles/run.invoker` on **`emlynk-sheet-sync-worker`** (service level) | Scheduler signs an OIDC token as this account to call `/tasks/reconcile` |
| OCR runtime account, e.g. `ocr-worker-runtime@<PROJECT_ID>.iam.gserviceaccount.com` | OCR worker | **None** | It touches no database, no storage, no other Google API. `ocr-worker/README.md` recommends a dedicated account with no roles |

Create them:

```bash
gcloud iam service-accounts create emlynk-backend --display-name="Emlynk backend and workers" --project=<PROJECT_ID>
gcloud iam service-accounts create emlynk-sheet-sync --display-name="Emlynk sheet sync worker" --project=<PROJECT_ID>
gcloud iam service-accounts create emlynk-sheet-sync-scheduler --display-name="Sheet sync scheduler" --project=<PROJECT_ID>
gcloud iam service-accounts create ocr-worker-runtime --display-name="Emlynk OCR service" --project=<PROJECT_ID>
```

Least-privilege rules for this project:

- **Do not grant Owner or Editor** to a runtime account. The existing production notes state `emlynk-backend` "holds no project-level roles; only the grants below".
- Prefer **resource-level** bindings (`gcloud run services add-iam-policy-binding`, `gcloud secrets add-iam-policy-binding`) to project-level ones.
- Private Cloud Run services are created with `--no-allow-unauthenticated`. Never add `allUsers`.
- **The person deploying** needs permission to create and deploy services, build images, create secrets and bind IAM, plus `roles/iam.serviceAccountUser` on each runtime account (required to attach it to a service). Ask the project owner for the roles you need rather than asking for Owner.
- Humans calling a private service (for health checks) use `gcloud auth print-identity-token`; the caller needs `roles/run.invoker` on that service.

Reference table of the repository's own conventions: [`Docs/08-cloud-deployment.md`](../Docs/08-cloud-deployment.md) Part 2 Step 3 and [`ocr-worker/README.md`](../ocr-worker/README.md) §3.

## 8. Scheduler

One scheduled job is currently defined by the code (`SHEET_SYNC_SCHEDULE` in `src/config/sheetSync.js`):

| Job | Target | Schedule | Timezone | Purpose |
|---|---|---|---|---|
| `emlynk-sheet-sync-reconcile` | `POST <sheet-sync-worker-url>/tasks/reconcile` | `0 6,12,18 * * *` (06:00, 12:00, 18:00) | `Asia/Colombo` | Starts a reconciliation of the Google Sheet |

Created in [08](08-GOOGLE-SHEET-SYNC-DEPLOYMENT.md#cloud-scheduler). There is no other Cloud Scheduler job in the base system. (Staging may use a faster test schedule; the runbook mentions every 5 minutes for testing, once a day for production: the code constant is the three daily times.)

## 9. Where to go next

1. [06: OCR worker](06-OCR-WORKER-DEPLOYMENT.md)
2. [07: submission worker](07-SUBMISSION-WORKER-DEPLOYMENT.md)
3. [08: Sheet Sync worker and scheduler](08-GOOGLE-SHEET-SYNC-DEPLOYMENT.md)

## Google Cloud checklist

- [ ] Project created, billing linked, budget alert set
- [ ] `gcloud config list` shows the intended account and project
- [ ] APIs enabled (run, artifactregistry, cloudbuild, secretmanager, cloudscheduler, sheets)
- [ ] Artifact Registry repositories created (`emlynk-ocr`, `emlynk-backend`)
- [ ] Secrets `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` created; per-secret access granted
- [ ] Service accounts created; no keys downloaded; no Owner/Editor
