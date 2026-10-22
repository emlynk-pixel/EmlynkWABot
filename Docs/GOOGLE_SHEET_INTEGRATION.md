# Google Sheet Integration: Operational Mirror & Candidate Form Submissions

## Document Metadata

- **Document Name:** Google Sheet Integration Architecture, Operations & Troubleshooting Guide
- **Repository Branch:** `dev`
- **Cloud Run Service:** `emlynk-sheet-sync-worker` (Region: `asia-south1`)
- **Target Spreadsheet ID:** `1-11g-0tQruJbgVslH0nzCzG_JRr-4LahSCU8ZJirMpE`
- **Target Tabs:**
  - `Emlynk Candidate Operational Mirror` (Canonical Database Mirror)
  - `Candidate Form Submissions` (Staged Candidate Form Submissions)
- **Runtime Identity:** `emlynk-sheet-sync@project-aa11e15e-a951-4e1b-a65.iam.gserviceaccount.com` (Keyless Application Default Credentials)
- **Primary References:**
  - Operational Mirror Feature Doc: [Docs/GOOGLE_SHEET_SYNC_FEATURE.md](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/Docs/GOOGLE_SHEET_SYNC_FEATURE.md)
  - Candidate Sync Architecture Spec: [Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md)
  - Outbox Migration (Mirror): [prisma/migrations/20261006120000_sheet_sync_outbox/migration.sql](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/prisma/migrations/20261006120000_sheet_sync_outbox/migration.sql)
  - Outbox Migration (Form Submissions): [prisma/migrations/20261028120000_candidate_form_sheet_sync/migration.sql](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/prisma/migrations/20261028120000_candidate_form_sheet_sync/migration.sql)
  - Issues & Debugging History: [Docs/EMLYNK_PROJECT_ISSUES_AND_SOLUTIONS_HISTORY.md](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/Docs/EMLYNK_PROJECT_ISSUES_AND_SOLUTIONS_HISTORY.md)

---

## 1. Feature Overview

The Google Sheet integration provides an automated, resilient, downstream export from the core PostgreSQL database (hosted on Supabase) into a private Google Spreadsheet. The integration manages **two distinct and strictly isolated synchronizations** within the same Google Spreadsheet:

```
Google Spreadsheet (Target ID: 1-11g-0tQruJbgVslH0nzCzG_JRr-4LahSCU8ZJirMpE)
├── Tab 1: "Emlynk Candidate Operational Mirror"  (41 columns: Canonical Admin-Approved Data)
└── Tab 2: "Candidate Form Submissions"          (74 columns: Staged Candidate Self-Submissions)
```

### Why the Tabs Are Strictly Isolated

1. **Emlynk Candidate Operational Mirror:**
   - Represents canonical, verified, and administrative-approved candidate records, operational stage progressions, and document verification timestamps.
   - Sourced from authoritative tables (`candidate`, `users`, `candidate_stages`, `documents`).
   - Serves as an operational read-only mirror and emergency fallback for staff if portal infrastructure is temporarily inaccessible.
2. **Candidate Form Submissions:**
   - Represents raw, staged submissions provided directly by candidate self-service via the Candidate Extra Details Form wizard.
   - Sourced from `candidate_form_response` and the outbox `candidate_form_sheet_sync`.
   - **Crucial Rule:** Candidate self-submissions **never overwrite canonical candidate data**. They are placed in this dedicated staging tab so administrators can review, inspect, and selectively confirm candidate-supplied changes inside the Admin Console before canonical records update.

---

## 2. Architecture & Data Flow

Both flows operate asynchronously and independently through the dedicated Cloud Run background worker (`emlynk-sheet-sync-worker`).

```mermaid
flowchart TD
    subgraph ClientFlows["Public & Admin Actions"]
        ADMIN["Admin Edits / Registrations / Reviews"]
        FORM["Candidate Submits Extra Details Form"]
    end

    subgraph PostgreSQL["PostgreSQL Database (Authoritative)"]
        DB_CAND[("candidate, documents, stages")]
        TRIG["DB Change-Capture Triggers"]
        MIRROR_QUEUE[("sheet_sync_queue")]
        
        FORM_RESP[("candidate_form_response")]
        FORM_QUEUE[("candidate_form_sheet_sync (Outbox)")]
        
        ADMIN -->|Direct DB Write| DB_CAND
        DB_CAND -->|Atomic Trigger| TRIG
        TRIG -->|sheet_sync_enqueue| MIRROR_QUEUE
        
        FORM -->|Atomic Transaction| FORM_RESP
        FORM -->|Atomic Transaction| FORM_QUEUE
    end

    subgraph CloudRunWorker["Cloud Run Worker (emlynk-sheet-sync-worker)"]
        WORKER_LOOP["Worker Polling Loop & Writer Lease"]
        RECONCILE["Reconciliation Engine (Mirror Sync)"]
        FORM_SYNC["Form Submission Sync Engine"]
        
        WORKER_LOOP -->|Scheduled / Manual Trigger| RECONCILE
        WORKER_LOOP -->|Tick Polling| FORM_SYNC
    end

    subgraph GoogleSheets["Target Google Spreadsheet"]
        TAB_MIRROR["Tab: Emlynk Candidate Operational Mirror"]
        TAB_FORM["Tab: Candidate Form Submissions"]
    end

    MIRROR_QUEUE -.->|Batch Snapshot Comparison| RECONCILE
    FORM_QUEUE -->|Compare-and-Swap Lease Claim| FORM_SYNC
    
    RECONCILE -->|Google Sheets API v4 (ADC)| TAB_MIRROR
    FORM_SYNC -->|Google Sheets API v4 (ADC)| TAB_FORM
```

### Flow 1: Operational Mirror Flow
1. Canonical candidate changes, document approvals, or stage changes occur via the Admin API.
2. PostgreSQL database triggers (`users_sheet_sync_capture`, `candidate_stages_sheet_sync_capture`, `documents_sheet_sync_capture`) atomically record changes into `sheet_sync_queue`.
3. The Sheet Sync Worker executes a scheduled reconciliation (or Admin "Sync Now" request).
4. The worker takes a transactional `REPEATABLE READ` snapshot of the database, diffs expected cells against the live Sheet, repairs drift, writes chunked updates, and settles the queue items (`RECONCILED`).
5. The Google Sheet `Emlynk Candidate Operational Mirror` tab is updated.

### Flow 2: Candidate Form Submissions Flow
1. Candidate completes the 4-step wizard and clicks **Submit**.
2. The backend service (`submitCandidateForm` in `src/services/candidateFormDataService.js`) validates answers.
3. In a **single atomic database transaction**:
   - `candidate_form_response` is saved.
   - `candidate_form_draft` is deleted.
   - `candidate_form_sheet_sync` outbox row is inserted with `status: 'PENDING'`.
4. The HTTP response immediately returns `200 OK` to the candidate's browser.
5. In the background, the Cloud Run Sheet Sync Worker claims the pending outbox row, reads the target tab layout, looks up existing `_SUBMISSION_ID` values, and writes/updates the row in the `Candidate Form Submissions` tab.

### Asynchronous Decoupling Benefits
- **Zero Candidate Blocking:** Form submissions never wait for Google Sheets API requests, eliminating latency and timeout failures on public links.
- **Outage Resilience:** A Google API outage or quota exhaustion cannot fail or roll back a candidate form submission.
- **Zero Browser Credential Exposure:** Google Cloud Service Account identities and OAuth tokens remain isolated in the private Cloud Run environment.
- **Failure Isolation:** An issue syncing the candidate form tab cannot halt or corrupt the operational mirror sync, and vice-versa.

---

## 3. Components & Code Map

| Component | Path | Responsibility |
| :--- | :--- | :--- |
| **Form Sheet Schema** | [src/services/formSubmissionSheetSchema.js](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/src/services/formSubmissionSheetSchema.js) | Defines the 74 required columns, exact header text, A1 range builders, and row mapper for candidate form submissions. |
| **Form Sheets Adapter** | [src/services/formSubmissionSheetAdapter.js](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/src/services/formSubmissionSheetAdapter.js) | Interacts with Google Sheets API v4 for the form tab. Reads headers, validates layout, reads submission IDs, and writes raw row updates/appends. |
| **Form Sync Store** | [src/services/formSubmissionSyncStore.js](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/src/services/formSubmissionSyncStore.js) | Outbox persistence layer for `candidate_form_sheet_sync`. Handles optimistic CAS batch claiming, completion marks, retry backoffs, and dead-letter failures. |
| **Form Sync Engine** | [src/services/formSubmissionSync.js](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/src/services/formSubmissionSync.js) | Orchestrates `processDue`. Claims batches under the shared writer lease, builds mapped cells, calls the adapter, and settles outbox rows. |
| **Sync Worker Service** | [src/services/sheetSyncWorker.js](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/src/services/sheetSyncWorker.js) | Central worker loop. Runs heartbeat, processes durable runs (`TEST_CONNECTION`, `RECONCILE`), claims writer lease, and invokes `formSubmissions.processDue` if writes are enabled. |
| **Executable Entrypoint** | [src/sheetSyncWorker.js](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/src/sheetSyncWorker.js) | The standalone executable script (`node src/sheetSyncWorker.js`). Validates environment, initializes Prisma, sets up Google ADC, binds HTTP server, and starts worker loop. |
| **Worker Process Helper** | [src/sheetSyncWorkerProcess.js](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/src/sheetSyncWorkerProcess.js) | Module helper defining `createSheetSyncHttpServer`, OIDC verifier, and `startSheetSyncWorkerProcess` graceful shutdown handlers. |
| **Sheet Config Loader** | [src/config/sheetSync.js](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/src/config/sheetSync.js) | Reads and validates environment variables for both tabs, destination mappings, pilot filters, tuning parameters, and schedule definitions. |
| **Form Data Service** | [src/services/candidateFormDataService.js](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/src/services/candidateFormDataService.js) | Implements `submitCandidateForm`, creating `candidate_form_response` and `candidate_form_sheet_sync` in the same database transaction. |
| **Deployment Config** | [deploy/sheet-sync-worker.env.yaml](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/deploy/sheet-sync-worker.env.yaml) | Cloud Run service environment definition file. |
| **Database Migrations** | `prisma/migrations/20261006120000_sheet_sync_outbox`<br>`prisma/migrations/20261028120000_candidate_form_sheet_sync` | Additive SQL migrations creating outbox tables, indexes, triggers, and RLS policies. |

---

## 4. Database & Outbox Design

### `candidate_form_sheet_sync` Table Schema

Defined in [prisma/schema.prisma](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/prisma/schema.prisma#L326-L346):

```prisma
model CandidateFormSheetSync {
  submissionId   String    @id @default(dbgenerated("(gen_random_uuid())::text")) @map("submission_id")
  passportId     String    @unique @map("passport_id")
  status         String    @default("PENDING")
  attempts       Int       @default(0)
  nextAttemptAt  DateTime  @default(now()) @map("next_attempt_at") @db.Timestamptz(3)
  leaseOwner     String?   @map("lease_owner")
  leaseExpiresAt DateTime? @map("lease_expires_at") @db.Timestamptz(3)
  lastResult     String?   @map("last_result")
  lastErrorClass String?   @map("last_error_class")
  lastErrorCode  String?   @map("last_error_code")
  createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt      DateTime  @default(now()) @map("updated_at") @db.Timestamptz(3)
  completedAt    DateTime? @map("completed_at") @db.Timestamptz(3)

  candidate Candidate @relation(fields: [passportId], references: [passportId], onDelete: Cascade, onUpdate: Cascade)

  @@index([status, nextAttemptAt])
  @@map("candidate_form_sheet_sync")
}
```

### Outbox Lifecycle State Machine

```
      [Candidate Submits Form]
                 │
                 ▼
         ┌───────────────┐
         │    PENDING    │◄─────────────────────────────┐
         └───────┬───────┘                              │
                 │ (claimBatch: CAS lock + lease)       │ (Retryable Error /
                 ▼                                      │  Config Error)
         ┌───────────────┐                              │
         │  PROCESSING   │──────────────────────────────┘
         └───────┬───────┘
                 │
        ┌────────┴────────┐
        ▼                 ▼
 ┌─────────────┐   ┌────────────┐
 │  COMPLETED  │   │   FAILED   │ (Dead-letter after 5 fatal attempts)
 └─────────────┘   └────────────┘
```

1. **`PENDING`:** Initial state upon insertion by `submitCandidateForm`. Holds `attempts: 0`, `nextAttemptAt: now()`.
2. **`PROCESSING`:** Claimed by the worker process via `claimBatch`. Sets `leaseOwner: <worker-id>`, `leaseExpiresAt: now() + 2min`, increments `attempts`.
3. **`COMPLETED`:** Written to Google Sheets successfully. Stores `lastResult` (`APPENDED` or `UPDATED`), sets `completedAt: now()`, and releases lease. Completed rows remain indefinitely to record the submission's stable ID.
4. **`FAILED` (Dead Letter):** If a non-retryable fatal error occurs after 5 attempts (`permanentMaxAttempts = 5`), the row is marked `FAILED` for operator investigation. It can be requeued by resetting status to `PENDING`.

---

## 5. Google Sheet Schemas

### Tab 1: `Emlynk Candidate Operational Mirror` (41 Columns)
- **Header Row:** Row 1 (exact matching, position-independent).
- **Columns (Canonical `A:AO`):**
  `TEST NUMBER`, `PASSPORT NUMBER`, `FIRST NAME`, `OTHER NAME`, `TEST DATE`, `BIRTHDAY`, `PP EX DATE`, `JOB`, `ID NUMBER`, `ADDRESS`, `AGE`, `SEX`, `EXPERIENCE`, `CONTACT NUMBER`, `WEIGHT`, `HEIGHT`, `CALL LOGS`, `STAGE`, `STATUS`, `STAGE DATE`, `SUB STAGE DATE`, `ACTIVE / INACTIVE`, `LAST UPDATE`, `REGISTRATION DATE`, `ASSIGNED AGENT`, `EMPLOYER / CLIENT`, `MEDICAL`, `POLICE REP SRI LANKA` (SL Verified), `POLICE REP SRI LANKA` (SL Normal), `POLICE REP FM (W)`, `DRIVING LICIAN` (SL), `DRIVING LICIAN (R)`, `APPOINTMENT SL`, `VISA NUMBER`, `VISA SL`, `VISA CANCEL`, `INSURANCE DATE`, `AGREEMENT NUMBER`, `SLBFE SUBMISSION DATE`, `LAST REMARK`, `_SYSTEM_CANDIDATE_ID`.

### Tab 2: `Candidate Form Submissions` (74 Columns)
- **Tab Name:** `Candidate Form Submissions` (overrideable via `SHEET_FORM_SUBMISSIONS_TAB_NAME`).
- **Initialization Behavior:** Row 1 headers are created automatically **only if the tab is completely blank** (row 1 has 0 cells).
- **Schema Validation:** If headers exist, all 74 required columns must be present exactly once. Extra operator-added columns (e.g., notes, tags, internal review formulas) are tolerated and preserved.
- **Key System Identifiers:**
  - `_SYSTEM_CANDIDATE_ID` (Column 1): The candidate's immutable database unique ID (e.g. `0006`).
  - `_SUBMISSION_ID` (Column 2): The stable outbox row key (`candidate_form_sheet_sync.submission_id`). **This is the row lookup and idempotency key.**
  - `Passport Number` & `Candidate Name`: Human-readable identifiers.
  - `Submitted At`: ISO timestamp of form submission.
  - `Submission Status`: Static value `SUBMITTED`.
  - Columns 7 to 74: Candidate-submitted answers mapped directly from `candidate_form_response` (including personal data, contact, passport dates, job preferences, measurements, family, guardian details, and `WhatsApp Number`).

---

## 6. Idempotency & Duplicate Protection

1. **Submission Keying by `_SUBMISSION_ID`:**
   - Neither passport numbers nor NIC numbers are used as the Sheet row key, because a candidate's passport number can be legally renewed or corrected.
   - The worker locates existing rows strictly by reading the `_SUBMISSION_ID` column.
2. **In-Place Updates vs. Appends:**
   - Before writing, `readSubmissionIds(layout)` scans the live tab's `_SUBMISSION_ID` column.
   - If `_SUBMISSION_ID` is found at row $N$, the worker **rewrites row $N$ in place** (`UPDATED`).
   - If `_SUBMISSION_ID` is not found, the row is appended (`APPENDED`).
   - A network glitch, container crash, or timeout after Google wrote the row will therefore update the existing row upon retry rather than creating a duplicate.
3. **Accidental Manual Duplicates:**
   - If an operator manually duplicates a row in Google Sheets, the worker detects this, logs `sheet_sync.form_duplicate_rows`, and safely updates only the first occurrence.

---

## 7. Error Handling & Retry Policies

Sync errors are classified automatically by `classifySyncError` in `src/services/sheetSyncWorker.js`:

| Error Category | Examples | Retry Policy | Attempt Counter |
| :--- | :--- | :--- | :--- |
| **`RETRYABLE`** | HTTP 429 (rate limit), 500, 502, 503, connection reset | Bounded exponential backoff: $15\text{s} \times 4^{(\text{attempt}-1)} \pm 20\%$, capped at 15 minutes. | Incremented |
| **`CONFIG` / `DATA_INTEGRITY`** | Missing tab, wrong permissions (403), missing header columns | Checked again every 15 minutes. Retried indefinitely until Sheet configuration is corrected. | **Not incremented** (does not burn attempts) |
| **`DISABLED`** | `SHEET_SYNC_ENABLED=false` | Worker skips processing. Outbox rows remain in `PENDING`. | **Not incremented** |
| **Unclassified / Bugs** | Data serialization errors | Retried with backoff; dead-lettered to `FAILED` after 5 attempts. | Incremented |

> [!IMPORTANT]
> **Candidate Form Submission Availability:**  
> The candidate-facing submission API (`POST /api/candidate-form/submit`) interacts solely with PostgreSQL. It **never calls Google APIs**. If Google Sheets is down, deleted, out of quota, or misconfigured, candidate submissions continue to succeed without interruption.

---

## 8. Write Gate (`SHEET_SYNC_ENABLED`)

The `SHEET_SYNC_ENABLED` environment variable governs whether the worker is authorized to make live writes to Google Sheets:

- `SHEET_SYNC_ENABLED="false"` (**Safe Default**):
  - Google OAuth token is acquired with the read-only scope (`spreadsheets.readonly`).
  - Operational Mirror reconciliations run in **dry-run mode** (`dryRun: true`), computing diffs and logging drift without writing to the Sheet.
  - Candidate Form sync is **completely disabled**: `formSubmissions.processDue()` is bypassed in `src/services/sheetSyncWorker.js:357`, leaving outbox rows in `PENDING` with `attempts: 0`.
- `SHEET_SYNC_ENABLED="true"` (**Live Mode**):
  - Google OAuth token is acquired with read-write scope (`spreadsheets`).
  - Reconciliations apply writes to the Operational Mirror.
  - Candidate Form submissions are processed every worker tick.

> [!WARNING]
> **Cloud Run Environment Immutability:**  
> Cloud Run service revisions capture a static snapshot of environment variables at deployment time. Modifying `deploy/sheet-sync-worker.env.yaml` on disk **does not affect running Cloud Run revisions** until a new revision is deployed via `gcloud run deploy`.

---

## 9. Cloud Run Worker Architecture

The Cloud Run service `emlynk-sheet-sync-worker` runs in region `asia-south1`.

### Dockerfile Entrypoint vs. Worker Entrypoint

The root [Dockerfile](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/Dockerfile#L40) serves the primary Express backend API:
```dockerfile
# Default CMD in root Dockerfile (Express Web API):
CMD ["node", "src/app.js"]
```

Because the same container image is used across Cloud Run services, the Sheet Sync Worker **must override the container command**:

```text
Container Entrypoint Override:
  Command: node
  Args:    src/sheetSyncWorker.js
```

- [src/sheetSyncWorker.js](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/src/sheetSyncWorker.js) is the **actual executable**.
- [src/sheetSyncWorkerProcess.js](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/src/sheetSyncWorkerProcess.js) is a module export library. Pointing Cloud Run args to `src/sheetSyncWorkerProcess.js` causes the container to exit immediately with code 0.

---

## 10. HTTP Endpoints

The worker process binds an HTTP server to `process.env.PORT` (defaults to 8080):

### 1. `GET /health` (or `HEAD /health`)
- **Status:** `200 OK`
- **Body:** `{"status": "OK"}`
- **Purpose:** Cloud Run liveness probe. Reveals no operational secrets or state.

### 2. `POST /tasks/reconcile`
- **Status:** `202 Accepted`
- **Body:** `{"runId": "<uuid>", "status": "QUEUED", "created": true}`
- **Purpose:** Enqueues a durable `RECONCILE` run in `sheet_sync_runs` and triggers immediate reconciliation.
- **Security & Authorization:**
  - **Outer Boundary:** The service is deployed with `--no-allow-unauthenticated`. Cloud Run IAM rejects unauthenticated callers with HTTP 403.
  - **Inner Boundary (Defence in Depth):** If `SHEET_SYNC_SCHEDULER_AUDIENCE` and `SHEET_SYNC_SCHEDULER_INVOKER` are configured, the worker verifies the Google-signed OIDC ID token. If unconfigured, Cloud Run IAM acts as the perimeter and the route responds with 202.

---

## 11. Deployment Configuration

Environment variables defined in [deploy/sheet-sync-worker.env.yaml](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/deploy/sheet-sync-worker.env.yaml):

| Variable | Default Value | Purpose |
| :--- | :--- | :--- |
| `SHEET_SPREADSHEET_ID` | `1-11g-0tQruJbgVslH0nzCzG_JRr-4LahSCU8ZJirMpE` | Target Google Spreadsheet ID. |
| `SHEET_TAB_NAME` | `Emlynk Candidate Operational Mirror` | Target tab for the Operational Mirror. |
| `SHEET_SYNC_ENABLED` | `"true"` | Write gate (`"true"` = live writes, `"false"` = dry run / disabled). |
| `DATABASE_POOL_MAX` | `"2"` | Database connection pool size for the worker instance. |
| `SHEET_SYNC_POLL_INTERVAL_MS` | `"10000"` | Worker tick loop frequency (10 seconds). |
| `SHEET_SYNC_BATCH_SIZE` | `"25"` | Batch size for queue processing. |
| `SHEET_SYNC_MAX_RETRIES` | `"5"` | Maximum retry threshold for retryable failures. |
| `SHEET_SYNC_DELETION_GUARD_MAX` | `"10"` | Maximum inactive candidates allowed to be marked in one run. |
| `SHEET_SYNC_DELETION_GUARD_FRACTION` | `"0.05"` | Maximum fraction of candidate base allowed to be marked inactive (5%). |
| `SHEET_FORM_SUBMISSIONS_TAB_NAME` | *(Optional, default: `"Candidate Form Submissions"`)* | Override tab name for Candidate Form Submissions. |
| `DATABASE_URL` | *(Via Secret Manager)* | PostgreSQL database connection string (`--set-secrets`). |

### Exact Deployment Command (Windows CMD)

```cmd
gcloud run deploy emlynk-sheet-sync-worker ^
  --project=project-aa11e15e-a951-4e1b-a65 ^
  --region=asia-south1 ^
  --image=asia-south1-docker.pkg.dev/project-aa11e15e-a951-4e1b-a65/emlynk-ocr/sheet-sync-worker:latest ^
  --service-account=emlynk-sheet-sync@project-aa11e15e-a951-4e1b-a65.iam.gserviceaccount.com ^
  --command=node ^
  --args=src/sheetSyncWorker.js ^
  --no-allow-unauthenticated ^
  --min-instances=1 ^
  --max-instances=1 ^
  --no-cpu-throttling ^
  --cpu=1 ^
  --memory=512Mi ^
  --env-vars-file=deploy/sheet-sync-worker.env.yaml ^
  --set-secrets=DATABASE_URL=DATABASE_URL:latest
```

---

## 12. Vercel Responsibilities

- **Candidate Form Frontend (Vercel Project B):** Public Vite SPA. Requires **zero Google credentials** and zero Google environment variables. Communicates exclusively with the backend API via HTTPS.
- **Admin Frontend (Vercel Project A):** Admin React SPA. Displays integration state and queue statistics queried from `sheet_sync_state` and `sheet_sync_runs` via backend REST endpoints.
- **Backend API Serverless Functions (Vercel / Cloud Run):** Writes outbox records (`candidate_form_sheet_sync` and `sheet_sync_queue`) directly into PostgreSQL. Holds no Google Sheets API access.

---

## 13. Cloud Scheduler Status

- **Current Operational State:** **Not currently provisioned**.
- **Audit Finding:** Executing `gcloud scheduler jobs list --location asia-south1` returned `Listed 0 items`. The Cloud Scheduler API was initially disabled and was enabled during recent operations.
- **Worker Execution:** The worker runs autonomously via its internal polling loop because the Cloud Run service is configured with `--min-instances=1` and `--no-cpu-throttling`.
- **Intended Schedule Specification:** When Cloud Scheduler is provisioned in the future, it should invoke `POST /tasks/reconcile` at **06:00, 12:00, and 18:00 Asia/Colombo** (`0 6,12,18 * * *`) using an OIDC token signed by `emlynk-sheet-sync-scheduler@project-aa11e15e-a951-4e1b-a65.iam.gserviceaccount.com`.

---

## 14. Testing & Verification

The Google Sheet sync integration has automated test coverage across 6 dedicated test suites (116 tests total, 100% passing):

```bash
# 1. Worker HTTP server & process lifecycle (7 tests)
node --test test/sheetSyncWorkerProcess.test.js

# 2. Worker process management & health listener (12 tests)
node --test test/workerProcess.test.js

# 3. Sheet sync engine, drift repair, and reconciliation (37 tests)
node --test test/sheetSyncWorker.test.js

# 4. Schedule constants & cron formatting (6 tests)
node --test test/sheetSyncSchedule.test.js

# 5. Candidate Form Sheet sync outbox & tab layout (28 tests)
node --test test/candidateFormSheetSync.test.js

# 6. Candidate Form submission & share link flows (26 tests)
node --test test/candidateFormSubmissionView.test.js test/candidateFormShare.test.js
```

---

## 15. Operational Troubleshooting Guide

### 1. `POST /tasks/reconcile` returns 404 (Initial Deployment)
- **Symptom:** Invoking `POST /tasks/reconcile` against the Cloud Run URL returns `404 Not Found`.
- **Root Cause:** Cloud Run defaulted to the root Dockerfile command `node src/app.js` (Express API) instead of the worker entrypoint.
- **Fix:** Deploy with `--command=node --args=src/sheetSyncWorker.js`.

### 2. `POST /tasks/reconcile` returns 404 even after Command Override
- **Symptom:** Worker process starts, `/health` returns 200, but `/tasks/reconcile` returns 404.
- **Root Cause:** In [src/sheetSyncWorkerProcess.js](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/src/sheetSyncWorkerProcess.js#L52), the route was conditionally gated by `&& verifyScheduler`. When `SHEET_SYNC_SCHEDULER_AUDIENCE` and `SHEET_SYNC_SCHEDULER_INVOKER` were commented out in the env file, `verifyScheduler` was `null`, causing the server to return 404.
- **Fix:** Modified route handling to always register `/tasks/reconcile`, making token verification optional while relying on Cloud Run IAM authentication.

### 3. Cloud Run returns 411 Length Required
- **Symptom:** `curl -X POST https://<worker-url>/tasks/reconcile` returns `411 Length Required`.
- **Root Cause:** Google Cloud Run frontend proxy rejects `POST` requests without a `Content-Length` or body.
- **Fix:** Pass an empty JSON body:
  ```cmd
  curl -i -X POST -H "Authorization: Bearer %GCLOUD_TOKEN%" -H "Content-Type: application/json" -d "{}" https://<worker-url>/tasks/reconcile
  ```

### 4. Candidate Form Outbox row stays `PENDING` with `attempts = 0`
- **Symptom:** Candidate Form submit succeeds, but row in `candidate_form_sheet_sync` remains in `PENDING` indefinitely with `attempts = 0`.
- **Root Cause:** `SHEET_SYNC_ENABLED` is set to `"false"`. The worker skips form submission processing when the write gate is disabled.
- **Fix:** Set `SHEET_SYNC_ENABLED: "true"` in `deploy/sheet-sync-worker.env.yaml` and redeploy the Cloud Run service.

### 5. Reconcile Run succeeds but `dryRun = true`
- **Symptom:** `sheet_sync_runs` record shows `status: "SUCCEEDED"`, but `dryRun: true` and 0 rows updated/appended in Google Sheets.
- **Root Cause:** The write gate is disabled (`SHEET_SYNC_ENABLED="false"`).
- **Fix:** Set `SHEET_SYNC_ENABLED: "true"` and redeploy.

### 6. Local Env shows `true` but Cloud Run shows `false`
- **Symptom:** `deploy/sheet-sync-worker.env.yaml` has `SHEET_SYNC_ENABLED: "true"`, but worker logs show `writeGate: "DISABLED"`.
- **Root Cause:** Cloud Run revisions are immutable. Changing local files does not update the active Cloud Run revision.
- **Fix:** Redeploy the service with `gcloud run deploy ... --env-vars-file=deploy/sheet-sync-worker.env.yaml`. Verify active revision env via:
  ```cmd
  gcloud run services describe emlynk-sheet-sync-worker --project=project-aa11e15e-a951-4e1b-a65 --region=asia-south1 --format="yaml(spec.template.spec.containers[0].env)"
  ```

### 7. Google Sheet remains completely empty
- **Diagnosis Checklist:**
  1. Check database outbox: `SELECT status, attempts, last_error_class, last_error_code FROM candidate_form_sheet_sync;`.
  2. Check write gate: `SELECT write_gate FROM sheet_sync_state;` (must be `ENABLED`).
  3. Verify Google Sheet permissions: Ensure `emlynk-sheet-sync@project-aa11e15e-a951-4e1b-a65.iam.gserviceaccount.com` has **Editor** access to spreadsheet ID `1-11g-0tQruJbgVslH0nzCzG_JRr-4LahSCU8ZJirMpE`.
  4. Verify Tab Name: Ensure the tab name in Google Sheets exactly matches `Candidate Form Submissions`.
  5. Check Worker Heartbeat: `SELECT worker_heartbeat_at FROM sheet_sync_state;` (timestamp should be within the last 30 seconds).

### 8. `gcloud scheduler jobs list` returns 0 items
- **Symptom:** Attempting to run scheduler jobs shows no configured jobs.
- **Root Cause:** Automated Cloud Scheduler cron jobs have not yet been provisioned in the GCP project.
- **Current Operational Reality:** The worker processes form submissions autonomously via tick polling. Scheduled full reconciliations can be triggered via Admin "Sync Now" or operator CLI until Cloud Scheduler is provisioned.
