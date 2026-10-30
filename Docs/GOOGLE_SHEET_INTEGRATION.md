# Google Sheet Integration: Operational Mirror & Candidate Form Submissions

**Contents:** Part A — Integration architecture, operations and troubleshooting (both tabs: Operational Mirror and Candidate Form Submissions) · Part B — Operational Mirror feature reference (formerly `GOOGLE_SHEET_SYNC_FEATURE.md`). The design specification, decisions and runbook are in [`GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md`](GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md); the bulk import and the current 83-column mirror mapping in [`CANDIDATE_BULK_IMPORT.md`](CANDIDATE_BULK_IMPORT.md).

> **Current column layout.** The Operational Mirror uses the approved **83-column** layout (`A–CE`, see `CANDIDATE_BULK_IMPORT.md` §3). The 40- and 41-column figures that appear below (and in Part B) are earlier layouts, kept as history.

# Part A — Integration Architecture, Operations & Troubleshooting

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
  - Operational Mirror Feature Doc (formerly `GOOGLE_SHEET_SYNC_FEATURE.md`): [Part B of this document](#part-b--operational-mirror-feature-reference)
  - Candidate Sync Architecture Spec: [Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md](GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md)
  - Outbox Migration (Mirror): [prisma/migrations/20261006120000_sheet_sync_outbox/migration.sql](../prisma/migrations/20261006120000_sheet_sync_outbox/migration.sql)
  - Outbox Migration (Form Submissions): [prisma/migrations/20261028120000_candidate_form_sheet_sync/migration.sql](../prisma/migrations/20261028120000_candidate_form_sheet_sync/migration.sql)
  - Issues & Debugging History: [Docs/EMLYNK_PROJECT_ISSUES_AND_SOLUTIONS_HISTORY.md](EMLYNK_PROJECT_ISSUES_AND_SOLUTIONS_HISTORY.md)

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
| **Form Sheet Schema** | [src/services/formSubmissionSheetSchema.js](../src/services/formSubmissionSheetSchema.js) | Defines the 74 required columns, exact header text, A1 range builders, and row mapper for candidate form submissions. |
| **Form Sheets Adapter** | [src/services/formSubmissionSheetAdapter.js](../src/services/formSubmissionSheetAdapter.js) | Interacts with Google Sheets API v4 for the form tab. Reads headers, validates layout, reads submission IDs, and writes raw row updates/appends. |
| **Form Sync Store** | [src/services/formSubmissionSyncStore.js](../src/services/formSubmissionSyncStore.js) | Outbox persistence layer for `candidate_form_sheet_sync`. Handles optimistic CAS batch claiming, completion marks, retry backoffs, and dead-letter failures. |
| **Form Sync Engine** | [src/services/formSubmissionSync.js](../src/services/formSubmissionSync.js) | Orchestrates `processDue`. Claims batches under the shared writer lease, builds mapped cells, calls the adapter, and settles outbox rows. |
| **Sync Worker Service** | [src/services/sheetSyncWorker.js](../src/services/sheetSyncWorker.js) | Central worker loop. Runs heartbeat, processes durable runs (`TEST_CONNECTION`, `RECONCILE`), claims writer lease, and invokes `formSubmissions.processDue` if writes are enabled. |
| **Executable Entrypoint** | [src/sheetSyncWorker.js](../src/sheetSyncWorker.js) | The standalone executable script (`node src/sheetSyncWorker.js`). Validates environment, initializes Prisma, sets up Google ADC, binds HTTP server, and starts worker loop. |
| **Worker Process Helper** | [src/sheetSyncWorkerProcess.js](../src/sheetSyncWorkerProcess.js) | Module helper defining `createSheetSyncHttpServer`, OIDC verifier, and `startSheetSyncWorkerProcess` graceful shutdown handlers. |
| **Sheet Config Loader** | [src/config/sheetSync.js](../src/config/sheetSync.js) | Reads and validates environment variables for both tabs, destination mappings, pilot filters, tuning parameters, and schedule definitions. |
| **Form Data Service** | [src/services/candidateFormDataService.js](../src/services/candidateFormDataService.js) | Implements `submitCandidateForm`, creating `candidate_form_response` and `candidate_form_sheet_sync` in the same database transaction. |
| **Deployment Config** | [deploy/sheet-sync-worker.env.yaml](../deploy/sheet-sync-worker.env.yaml) | Cloud Run service environment definition file. |
| **Database Migrations** | `prisma/migrations/20261006120000_sheet_sync_outbox`<br>`prisma/migrations/20261028120000_candidate_form_sheet_sync` | Additive SQL migrations creating outbox tables, indexes, triggers, and RLS policies. |

---

## 4. Database & Outbox Design

### `candidate_form_sheet_sync` Table Schema

Defined in [prisma/schema.prisma](../prisma/schema.prisma#L326-L346):

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

> **Superseded column table (2026-10-28).** The live mirror now uses the latest approved *Emlynk Candidate Operational Mirror* headers and order (83 columns, `_SYSTEM_CANDIDATE_ID` in B, `SURNAME`/`OTHER NAME` by stored meaning, ONE `POLICE REP SRI LANKA` column: the duplicate SL Normal column was removed). The authoritative table, the deployment header renames and each column's kind are in [CANDIDATE_BULK_IMPORT.md](CANDIDATE_BULK_IMPORT.md) §3–§4 and in `src/services/sheetSchema.js`. The table below is kept as history.

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

The root [Dockerfile](../Dockerfile#L40) serves the primary Express backend API:
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

- [src/sheetSyncWorker.js](../src/sheetSyncWorker.js) is the **actual executable**.
- [src/sheetSyncWorkerProcess.js](../src/sheetSyncWorkerProcess.js) is a module export library. Pointing Cloud Run args to `src/sheetSyncWorkerProcess.js` causes the container to exit immediately with code 0.

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

Environment variables defined in [deploy/sheet-sync-worker.env.yaml](../deploy/sheet-sync-worker.env.yaml):

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
- **Root Cause:** In [src/sheetSyncWorkerProcess.js](../src/sheetSyncWorkerProcess.js#L52), the route was conditionally gated by `&& verifyScheduler`. When `SHEET_SYNC_SCHEDULER_AUDIENCE` and `SHEET_SYNC_SCHEDULER_INVOKER` were commented out in the env file, `verifyScheduler` was `null`, causing the server to return 404.
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

---

# Part B — Operational Mirror Feature Reference

*Formerly `GOOGLE_SHEET_SYNC_FEATURE.md` (Google Sheet Candidate Sync Feature Documentation, v1.0.0). Its status line describes the feature at the time it was written; for the current state see Part A and the architecture specification.*

### Document Metadata

- **Feature Name:** Google Sheet Candidate Operational Mirror (Candidate Sync)
- **Document Version:** 1.0.0
- **Status:** Implemented on branch `version/google-sheet-sync` (Phases 1–7 complete; database migration deployed; Cloud Run worker deployed and verified via controlled pilot; write gate enabled; full reconciliation pending final production sign-off)
- **Target Spreadsheet ID:** `1-11g-0tQruJbgVslH0nzCzG_JRr-4LahSCU8ZJirMpE`
- **Target Tab Name:** `Emlynk Candidate Operational Mirror`
- **Target Service Account:** `emlynk-sheet-sync@project-aa11e15e-a951-4e1b-a65.iam.gserviceaccount.com`
- **Target Cloud Run Worker:** `emlynk-sheet-sync-worker` (Region: `asia-south1`)
- **Primary References:**
  - Architecture Specification: [Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md](GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md)
  - Outbox Migration: [prisma/migrations/20261006120000_sheet_sync_outbox/migration.sql](../prisma/migrations/20261006120000_sheet_sync_outbox/migration.sql)
  - Sheet Schema: [src/services/sheetSchema.js](../src/services/sheetSchema.js)
  - Candidate Sheet Mapper: [src/services/candidateSheetMapper.js](../src/services/candidateSheetMapper.js)
  - Google Sheets Adapter: [src/services/googleSheetsAdapter.js](../src/services/googleSheetsAdapter.js)
  - Aggregate Reader: [src/services/candidateAggregateReader.js](../src/services/candidateAggregateReader.js)
  - Sync Store: [src/services/sheetSyncStore.js](../src/services/sheetSyncStore.js)
  - Sync Engine: [src/services/sheetSyncEngine.js](../src/services/sheetSyncEngine.js)
  - Worker Service: [src/services/sheetSyncWorker.js](../src/services/sheetSyncWorker.js)
  - Admin UI: [admin/src/pages/SettingsPage.tsx](../admin/src/pages/SettingsPage.tsx)

---

### 1. Feature Overview

The Google Sheet Candidate Sync feature provides an automated, one-way operational mirror of candidate operational data from the core PostgreSQL database into a private Google Spreadsheet (`Emlynk Candidate Operational Mirror`). 

Its primary purpose is operational resilience: enabling staff to view, filter, and reference current candidate statuses, document progress, and stage milestones in Google Sheets even if the primary web application, admin console, or portal infrastructure experiences downtime or maintenance.

```
PostgreSQL Database
       │
       ▼ (Atomic DB Change-Capture Triggers)
Sheet Sync Outbox Queue (`sheet_sync_queue`)
       │
       ▼ (Long-polling / Lease Claims)
Sheet Sync Worker (`emlynk-sheet-sync-worker` on Cloud Run)
       │
       ▼ (Google Sheets API v4 with ADC)
Google Sheet (`Emlynk Candidate Operational Mirror`)
```

#### Core Operating Principles

> **Current synchronization model:** there is **no real-time synchronization**. Database changes are only recorded in `sheet_sync_queue`; the Sheet is written by a full reconciliation of the current database at **06:00, 12:00 and 18:00 Asia/Colombo** (one Cloud Scheduler job, Section 12) and by an ADMIN's **Sync Now**. Statements below about incremental / near-real-time sync, queue claims and per-item retries describe the original design and are kept as history.

1. **Database is the single source of truth:** PostgreSQL (Supabase) is authoritative for all candidate data, stages, and documents. Document columns show each current document's submission date (`documents.received_date`, Sri Lanka calendar date `YYYY-MM-DD`) or exactly `Not Submitted`; nothing in the Sheet is read back, and `Not Submitted` never deletes anything.
2. **Google Sheet is an operational mirror / fallback view:** The Sheet is purely a downstream representation for human viewing and operational fallback.
3. **Strictly one-way synchronization:** Changes in the Google Sheet are **NEVER** read back or synchronized into PostgreSQL. Any manual edit made inside the Sheet will be overwritten by the next scheduled or manual reconciliation.
4. **Asynchronous background processing:** Candidate registrations, document uploads, review actions, and stage updates trigger database triggers that record a queue row atomically. Nothing is written to the Sheet at that moment; the next scheduled (06:00, 12:00, 18:00 Asia/Colombo) or manual reconciliation mirrors the change. Neither candidate users nor admin users wait for Google API responses.
5. **Decoupled system availability:** A Google Cloud outage, Sheets API rate limit, quota exhaustion, or network failure **CANNOT** cause a candidate database transaction to fail or roll back.
6. **Reconciliation as a repair mechanism:** Admin "Sync Now" and automated Cloud Scheduler reconciliation perform full snapshot-to-sheet drift detection, repairing missing, stale, or manually altered rows. They are the only way the Sheet is written; there is no real-time incremental sync.

---

### 2. Architecture

#### Implemented Components and Responsibilities

| Component | Repository Path | Core Responsibilities |
| :--- | :--- | :--- |
| **Sheet Schema** | [src/services/sheetSchema.js](../src/services/sheetSchema.js) | Defines the 41 required headers (canonical layout `A:AO`) and resolves columns **by header name** (`readSheetLayout`: any order, extra operator columns allowed, missing or duplicate required headers give `SCHEMA_INVALID`). Exports the single column-letter helper, A1 range builders (one write range per contiguous run of system columns), `validateHeaderRow` and `assertSheetRow`. |
| **Candidate Mapper** | [src/services/candidateSheetMapper.js](../src/services/candidateSheetMapper.js) | Pure mapper turning candidate aggregates into 41 deterministic string cells in canonical field order (position-free; the adapter translates to the live Sheet order). Enforces identical business logic as Admin UI for document currentness and stage completeness. |
| **Sheets Adapter** | [src/services/googleSheetsAdapter.js](../src/services/googleSheetsAdapter.js) | The only module communicating with Google Sheets API v4. Implements narrow read/write methods (`readHeader`, `validateSchema`, `readLayout`, `readCandidateIds`, `readRows`, `readRowsByNumber`, `writeRows`, `appendRow`, `updateRow`). Enforces write gating, keyless ADC authentication, and error sanitation. Contains **zero** clear or row-deletion methods. |
| **Aggregate Reader** | [src/services/candidateAggregateReader.js](../src/services/candidateAggregateReader.js) | Reads candidate aggregates (`users`, `candidate_stages`, `documents`) in single queries by `unique_id`. Supports keyset pagination and transactional `readSnapshot` (`REPEATABLE READ`) verified against exact record counts. |
| **Sync Planner** | [src/services/sheetSyncPlanner.js](../src/services/sheetSyncPlanner.js) | Read-only planning module. Indexes Sheet candidate IDs from the `_SYSTEM_CANDIDATE_ID` column, detects duplicate system IDs (`SheetDuplicateCandidateIdError`), diffs expected cells against actual cells (`changedColumns`), and classifies operations (`APPEND`, `UPDATE`, `UNCHANGED`, `NOT_IN_DATABASE`). |
| **Health Check** | [src/services/sheetHealthCheck.js](../src/services/sheetHealthCheck.js) | Read-only connection and schema probe (row 1). Validates Google API connectivity and the header-name schema (reports missing / duplicated required headers) using `spreadsheets.readonly` scope without writing. |
| **Sync Store** | [src/services/sheetSyncStore.js](../src/services/sheetSyncStore.js) | PostgreSQL persistence layer: atomic compare-and-swap (CAS) queue claiming, leases, fenced settlements, bounded exponential backoff (`15s * 4^(attempt-1)` ±20% jitter), durable run tracking (`sheet_sync_runs`), single-row integration state (`sheet_sync_state`), and distributed writer lease acquisition. |
| **Sync Engine** | [src/services/sheetSyncEngine.js](../src/services/sheetSyncEngine.js) | Implements incremental sync (`syncCandidates`) and full reconciliation (`reconcile`). Handles chunked writing (200 rows/batch), pre-write schema validation, duplicate detection, dry-run mode, and deletion guard verification. |
| **Sync Worker** | [src/services/sheetSyncWorker.js](../src/services/sheetSyncWorker.js) | Core worker loop: reports heartbeat, processes claimed runs (`TEST_CONNECTION` or `RECONCILE`), claims incremental queue batches, enforces writer lease, manages halting on configuration/data errors, and prunes aged completed queue rows. |
| **Status Service** | [src/services/sheetSyncStatusService.js](../src/services/sheetSyncStatusService.js) | Read-only service for Admin UI: gathers worker heartbeat, write gate status, queue counts, run history, and integration health from PostgreSQL. Never communicates with Google. |
| **Settings Routes** | [src/routes/sheetSyncSettings.js](../src/routes/sheetSyncSettings.js) | Express router mounted at `/api/admin/settings/sheet-sync`. Protected by `requireRole([ADMIN])`. Provides `GET /status`, `POST /test`, `POST /run`, and `GET /runs/:runId`. |
| **Admin Settings UI** | [admin/src/pages/SettingsPage.tsx](../admin/src/pages/SettingsPage.tsx) | React Admin console page at `/admin/settings`. Displays connection status, integration state, write gate, target hint, queue counts, run summaries, and triggers background runs via "Test Connection" and "Sync Now". |
| **Admin API Client** | [admin/src/api/sheetSync.ts](../admin/src/api/sheetSync.ts) | TypeScript API client for settings endpoints. |
| **Database Migration** | [prisma/migrations/20261006120000_sheet_sync_outbox/migration.sql](../prisma/migrations/20261006120000_sheet_sync_outbox/migration.sql) | Additive migration creating `sheet_sync_queue`, `sheet_sync_runs`, `sheet_sync_state`, partial unique indexes, RLS policies, and database triggers on `users`, `candidate_stages`, and `documents`. |
| **Worker Process** | [src/sheetSyncWorker.js](../src/sheetSyncWorker.js), [src/sheetSyncWorkerProcess.js](../src/sheetSyncWorkerProcess.js) | Dedicated Cloud Run process entrypoint (`npm run sheet:worker`). Validates environment, binds HTTP server on `$PORT` with `/health` and OIDC-protected `POST /tasks/reconcile`, and handles graceful shutdown via SIGTERM/SIGINT. |
| **Operator CLI** | [src/sheetSyncRequest.js](../src/sheetSyncRequest.js) | Operator CLI command (`npm run sheet:request -- reconcile\|test`) to enqueue durable runs directly via database without HTTP. |
| **Health Check CLI** | [src/sheetSyncCheck.js](../src/sheetSyncCheck.js) | Standalone read-only CLI check (`npm run sheet:check`) printing sanitized JSON results. |
| **Deployment Config** | [deploy/sheet-sync-worker.env.yaml](../deploy/sheet-sync-worker.env.yaml) | Cloud Run environment variable definition with non-secret defaults. |

---

#### End-to-End System Architecture Diagram

```mermaid
flowchart TD
    subgraph CoreApplication["PostgreSQL Database"]
        CAND["Candidate Change\n(Registration / Edit / Document)"]
        TRIG["Triggers:\nusers_sheet_sync_capture\ncandidate_stages_sheet_sync_capture\ndocuments_sheet_sync_capture"]
        QUEUE[("sheet_sync_queue\n(Outbox, Coalesced)")]
        STATE[("sheet_sync_state\n(Heartbeat, Writer Lease)")]
        RUNS[("sheet_sync_runs\n(Durable Run Requests)")]
        
        CAND -->|Atomic Transaction| TRIG
        TRIG -->|sheet_sync_enqueue| QUEUE
    end

    subgraph SheetWorker["Cloud Run Worker (emlynk-sheet-sync-worker)"]
        LOOP["Worker Loop (Heartbeat & Tick)"]
        CLAIM["Claim Due Queue Batch\n(CAS + 2-min lease)"]
        READ_AGG["Candidate Aggregate Reader\n(findByUniqueIds)"]
        MAPPER["Candidate Sheet Mapper\n(assertSheetRow 40 Cells)"]
        ENGINE["Sheet Sync Engine\n(changedColumns Diffing)"]
        HTTP_SVC["Worker HTTP Server\n(/health & /tasks/reconcile)"]
        
        LOOP -->|Heartbeat & Lease| STATE
        LOOP -->|Poll Batches| CLAIM
        CLAIM --> READ_AGG
        READ_AGG --> MAPPER
        MAPPER --> ENGINE
    end

    subgraph ExternalGoogle["Google Sheets API v4"]
        G_AUTH["Keyless ADC Token\n(Runtime Service Account)"]
        G_API["spreadsheets.values\n(batchGet / batchUpdate / append)"]
        SHEET[("Google Sheet\nEmlynk Candidate Operational Mirror")]
        
        ENGINE --> G_AUTH
        G_AUTH --> G_API
        G_API -->|Update / Append| SHEET
    end

    subgraph AdminUI["Admin Console (Vercel Frontend & Express API)"]
        ADMIN_USER["Admin User"]
        SETTINGS_PAGE["Admin UI (/admin/settings)\nGoogle Sheet Sync Card"]
        SETTINGS_API["Express Router\n/api/admin/settings/sheet-sync"]
        
        ADMIN_USER -->|Click Sync Now / Test Connection| SETTINGS_PAGE
        SETTINGS_PAGE -->|POST /run or POST /test| SETTINGS_API
        SETTINGS_API -->|Insert QUEUED Run| RUNS
        LOOP -->|Claim Run| RUNS
    end

    subgraph Scheduler["Google Cloud Scheduler"]
        CRON["Cloud Scheduler Job\n(Periodic Daily / Testing)"]
        CRON -->|POST /tasks/reconcile\nOIDC Bearer Token| HTTP_SVC
        HTTP_SVC -->|Record Reconcile Run| RUNS
    end
```

---

### 3. Candidate Row Identity

#### Technical Identity: `_SYSTEM_CANDIDATE_ID` (Position-Independent)

The operational mirror links database candidates to Sheet rows exclusively through an immutable technical key:

- **Header Text:** `_SYSTEM_CANDIDATE_ID`
- **Position Independence:** Resolved dynamically by header name. May be placed in Column A, in the middle, or at the end of the Sheet.
- **Database Source Field:** `candidate.unique_id` (e.g., `"0001"`, `"0002"`, `"0003"`)

```
+---+-----------------------+-----+-------------------+
| A | _SYSTEM_CANDIDATE_ID  | ... | ANY OTHER COLUMN  |
+---+-----------------------+-----+-------------------+
| 1 | _SYSTEM_CANDIDATE_ID  | ... | PASSPORT NUMBER   |
| 2 | 0001                  | ... | N1000001          |
| 3 | 0003                  | ... | N1000003          |
+---+-----------------------+-----+-------------------+
```

#### Why Other Identifiers Must NOT Be Used as Row Keys

| Identifier | Why Rejected as Row Key |
| :--- | :--- |
| **Passport Number (`passport_id`)** | While currently the primary key in `users`, passport numbers can undergo normalization corrections, typo fixes, or renewal updates (supported via `ON UPDATE CASCADE`). Changing a passport ID would detach historical row identity if used as the key. |
| **National ID (`nic`)** | Optional during early onboarding, can be absent, and is subject to manual correction during verification. |
| **Phone / WhatsApp Number** | Candidates may update contact details or share phone lines across family members. |
| **Sheet Row Number** | Row positions change if rows are sorted or if blank lines are introduced. Positional matching causes destructive overwrites of unrelated candidates. |

#### Strict Duplicate Prevention and Matching Rules

1. **Exact string matching:** `users.unique_id` is matched against Column `AN` cells as exact text.
2. **Blank IDs are ignored:** Any row in the Sheet where Column `AN` is empty or whitespace is treated as unmanaged. It is never overwritten, matched, or deleted.
3. **Duplicate System IDs cause a hard stop:** If the same `_SYSTEM_CANDIDATE_ID` appears in more than one row of the Sheet:
   - The worker immediately halts with `SheetDuplicateCandidateIdError` (`DATA_INTEGRITY`).
   - Integration state transitions to `DATA_INTEGRITY`.
   - **Zero writes occur** to the Sheet (neither to the duplicate rows nor any other rows in the batch).
   - No automatic guess is made regarding which row is "correct".
   - The condition requires manual deduplication in the Google Sheet by an authorized administrator before sync resumes.

---

### 4. Google Sheet Schema

> **Superseded column table (2026-10-28).** The live mirror now uses the latest approved *Emlynk Candidate Operational Mirror* headers and order (83 columns, `_SYSTEM_CANDIDATE_ID` in B, `SURNAME`/`OTHER NAME` by stored meaning, ONE `POLICE REP SRI LANKA` column: the duplicate SL Normal column was removed). The authoritative table, the deployment header renames and each column's kind are in [CANDIDATE_BULK_IMPORT.md](CANDIDATE_BULK_IMPORT.md) §3–§4 and in `src/services/sheetSchema.js`. The table below is kept as history.

The operational mirror implements **41 required headers** (40 human-facing operational columns plus the technical identity `_SYSTEM_CANDIDATE_ID`), resolved dynamically **by header name**. Operators may reorder columns and add their own; order is irrelevant.

> [!NOTE]
> The column letters in the table below are the **canonical** layout of an earlier revision (before `VISA SUBMISSION STATUS` was added) and are kept for reference only. The authoritative, current layout and mapping is Section 6.1 of [GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md](GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md); the code never relies on a letter.

#### Operator guide: what is safe in the Sheet

**Safe at any time:** reorder system columns; move `_SYSTEM_CANDIDATE_ID` (column A, the middle or last), `VISA SUBMISSION STATUS` and `VISA APPROVAL STATUS`; add custom columns anywhere (their values are never written, cleared or overwritten); change widths, formatting, filters, freeze panes; hide columns.

**Not safe (sync halts with `SCHEMA_INVALID` / a data-integrity error):** rename, delete or duplicate a required header (text must match exactly; the only intentional duplicate is `POLICE REP SRI LANKA`, whose two columns keep their order relative to each other: left = SL Verified, right = SL Normal); edit or clear `_SYSTEM_CANDIDATE_ID` values; duplicate a candidate ID across rows; replace system IDs with passport numbers or NICs. The sync never reorders the Sheet for you and never writes while the header mapping is ambiguous.

#### Complete 40-Column Field Mapping Specification

| Col | Header | Source / Aggregate Mapping | Notes & Formatting |
| :-: | :--- | :--- | :--- |
| **A** | `TEST NUMBER` | Unmapped / Empty (`""`) | Legacy operational column; no authoritative source exists. Always empty string. |
| **B** | `PASSPORT NUMBER` | `users.passport_id` | Uppercase normalized passport identifier. |
| **C** | `FIRST NAME` | `users.first_name` | String text. |
| **D** | `OTHER NAME` | `users.other_name` | String text (surname / other names). |
| **E** | `TEST DATE` | `stages["TEST_DETAILS"].testDate` | Date string as entered in candidate deployment test details. |
| **F** | `BIRTHDAY` | `users.date_of_birth` | Date-only formatted: `YYYY-MM-DD`. |
| **G** | `PP EX DATE` | `users.passport_expiry_date` | Date-only formatted: `YYYY-MM-DD`. |
| **H** | `JOB` | `users.job` | Target job category / trade. |
| **I** | `ID NUMBER` | `users.nic` | National Identity Card number. |
| **J** | `ADDRESS` | `users.address` | Residential address string. |
| **K** | `WHATSAPP NUM` | `users.whatsapp_number` | WhatsApp contact phone number. |
| **L** | `CONTACT NUM` | `users.contact_number` | Alternate contact phone number. |
| **M** | `PASSPORT COPY` | `documents` type `PASSPORT` | Submission date (`YYYY-MM-DD`, Sri Lanka date) of the current document, or `Not Submitted`. |
| **N** | `POLICE REP SRI LANKA` | `documents` type `POLICE_REPORT`, variant `SL_VERIFIED` | Submission date (`YYYY-MM-DD`, Sri Lanka date) of the current document, or `Not Submitted`. (One of two identical headers; the left one is SL Verified, the right one SL Normal, by relative order). |
| **O** | `POLICE REP ROMANIA` | `documents` type `POLICE_REPORT`, variant `ROMANIA` | Submission date (`YYYY-MM-DD`, Sri Lanka date) of the current document, or `Not Submitted`. |
| **P** | `MEDICAL` | `documents` type `MEDICAL` | Submission date (`YYYY-MM-DD`, Sri Lanka date) of the current document, or `Not Submitted`. |
| **Q** | `SCAN` | `documents` type `SCAN` | Submission date (`YYYY-MM-DD`, Sri Lanka date) of the current document, or `Not Submitted`. **Exactly one SCAN column** exists. |
| **R** | `DRIVING LICIAN` | No document type (Sheet output only) | Legacy spelling preserved intentionally from manual Sheet; always `Not Submitted`. |
| **S** | `NATIONAL ID` | `documents` type `NIC` | Submission date (`YYYY-MM-DD`, Sri Lanka date) of the current document, or `Not Submitted`. |
| **T** | `POLICE REPORT APPLIED` | `documents` type `POLICE_SLIP` | Submission date (`YYYY-MM-DD`, Sri Lanka date) of the current document, or `Not Submitted`. |
| **U** | `SUBMIT DATE` | `policeSlip.policeSubmittedDate` | Submission date of active `POLICE_SLIP`: `YYYY-MM-DD`. |
| **V** | `POLICE REP SRI LANKA` | `documents` type `POLICE_REPORT`, variant `SL_NORMAL` | Submission date (`YYYY-MM-DD`, Sri Lanka date) of the current document, or `Not Submitted`. Standard unverified Sri Lankan report. |
| **W** | `POLICE REP FM` | No document type (Sheet output only) | Foreign Ministry police report column; always `Not Submitted`. |
| **X** | `VIDEOS` | `documents` type `SKILL_VIDEO` | Submission date (`YYYY-MM-DD`, Sri Lanka date) of the current document, or `Not Submitted`. |
| **Y** | `PLACE OF BIRTH` | `users.place_of_birth` | String text. |
| **Z** | `SEX` | `users.sex` | Candidate sex / gender string. |
| **AA** | `NATIONALITY` | `users.nationality` | Nationality string. |
| **AB** | `PASSPORT ISSUE DATE` | `users.passport_issue_date` | Date-only formatted: `YYYY-MM-DD`. |
| **AC** | `JOB EXPERIENCE` | `users.job_experience` | Experience summary string. |
| **AD** | `CANDIDATE DETAILS NOTE`| `stages["CANDIDATE_DETAILS"].notes` | Operator deployment notes for Candidate Details stage. |
| **AE** | `TEST DETAILS STATUS` | `stages["TEST_DETAILS"]` | Stage status: `COMPLETED` or `INCOMPLETE`. |
| **AF** | `CANDIDATE DETAILS STATUS` | `stages["CANDIDATE_DETAILS"]` | Stage status: `COMPLETED` or `INCOMPLETE`. |
| **AG** | `DOCUMENT SUBMISSION STATUS` | `stages["DOCUMENT_SUBMISSION"]` | Stage status: `COMPLETED` or `INCOMPLETE`. |
| **AH** | `IVS INTERVIEW STATUS` | `stages["IVS_INTERVIEW"]` | Stage status: `COMPLETED` or `INCOMPLETE`. |
| **AI** | `VISA APPROVAL STATUS` | `stages["VISA_APPROVAL"]` | Stage status: `COMPLETED` or `INCOMPLETE`. |
| **AJ** | `FINALIZING JOB STATUS` | `stages["FINALIZING_JOB"]` | Stage status: `COMPLETED` or `INCOMPLETE`. |
| **AK** | `RECORD STATUS` | Operational status | `ACTIVE` for active candidates; `DELETED / INACTIVE` for candidates removed from database. |
| **AL** | `REGISTERED AT` | `users.created_date` | UTC ISO timestamp: `YYYY-MM-DDTHH:mm:ssZ`. |
| **AM** | `LAST MIRRORED AT` | Mirror execution timestamp | UTC ISO timestamp: `YYYY-MM-DDTHH:mm:ssZ`. Updated only when row is written. |
| **AN** | `_SYSTEM_CANDIDATE_ID` | `users.unique_id` | Technical identity key. Never empty for valid candidate rows. |

#### Schema Invariants

- **No arbitrary columns:** No columns exist for Agreements, Affidavits, Contracts, or secondary Scan documents.
- **Relative-order identity:** The two `POLICE REP SRI LANKA` columns have identical header text; they are assigned by their order relative to each other (left = SL Verified, right = SL Normal), and may be moved anywhere in the Sheet as long as that order is kept. A different count of that header is a MISSING / DUPLICATE schema problem.
- **Header validation:** Row 1 is read once per operation (never cached across runs) and validated by name before every write batch: every required header exactly once, any order, extra columns allowed. A missing, duplicated or renamed required header aborts with `SheetSchemaMismatchError` (`SCHEMA_INVALID`). If row 1 changes between the read and the write, the write is refused (`SheetLayoutChangedError`, retried next run).

---

### 5. Incremental Automatic Sync

The normal path for candidate synchronization is completely automated and event-driven.

```mermaid
sequenceid
autonumber
actor Operator as User / Admin / Webhook
participant DB as PostgreSQL
participant Queue as sheet_sync_queue
participant Worker as Cloud Run Worker
participant Google as Google Sheets API

Operator->>DB: Candidate Created / Edited / Document Stored
DB->>DB: Fire Trigger (users / stages / documents)
DB->>Queue: INSERT ... ON CONFLICT (unique_id) WHERE status='PENDING' DO UPDATE
Note over Operator,DB: DB Transaction Commits Immediately (Google not called)

loop Every 10 Seconds (Worker Polling)
    Worker->>Queue: Claim PENDING batch (CAS, 2-min lease)
    Queue-->>Worker: Return claimed batch
    Worker->>DB: Read Aggregates (findByUniqueIds)
    Worker->>Google: Read header row 1:1 (build the header-name column map)
    Worker->>Google: Read Candidate IDs (the _SYSTEM_CANDIDATE_ID column)
    Worker->>Google: batchGet Existing Rows for Batch Candidates
    Worker->>Worker: Map Candidates & Diff Cells (changedColumns)
    alt Candidate Missing in Sheet
        Worker->>Google: append (INSERT_ROWS, RAW)
    else Cells Differ
        Worker->>Google: batchUpdate (RAW)
    else Unchanged
        Note over Worker: Skip write; preserve LAST MIRRORED AT
    end
    Worker->>Queue: Complete Item (status=COMPLETED, last_result)
    Worker->>DB: Update last_sync_success_at in sheet_sync_state
end
```

#### Key Incremental Sync Mechanisms

1. **Atomic Trigger Enqueue:** Database triggers (`users_sheet_sync_capture`, `candidate_stages_sheet_sync_capture`, `documents_sheet_sync_capture`) execute inside the candidate write transaction.
2. **Pending Row Coalescing:** The trigger calls `sheet_sync_enqueue(unique_id, deleted)`, which inserts or updates `sheet_sync_queue` using:
   ```sql
   INSERT INTO "sheet_sync_queue" ("unique_id", "candidate_deleted")
   VALUES (p_unique_id, p_candidate_deleted)
   ON CONFLICT ("unique_id") WHERE "status" = 'PENDING'
   DO UPDATE SET
       "candidate_deleted" = "sheet_sync_queue"."candidate_deleted" OR EXCLUDED."candidate_deleted",
       "updated_at" = CURRENT_TIMESTAMP;
   ```
   At most **one pending row exists per candidate**, preventing queue explosion during rapid edits or bulk imports.
3. **Optimistic Leases and Worker Claims:** The worker polls every 10 seconds (configurable via `SHEET_SYNC_POLL_INTERVAL_MS`). Claiming uses compare-and-swap (CAS) setting `status = 'PROCESSING'` and `lease_expires_at = now + 2 minutes`.
4. **Fresh Aggregate Re-reading:** The worker re-reads the full candidate aggregate directly from PostgreSQL at processing time. This ensures that the Sheet always receives the latest committed database state regardless of queue latency.
5. **Selective Cell Diffs:** The engine compares expected cells against actual cells across columns `A` through `AK` and `AN`. Column `AM` (`LAST MIRRORED AT`) is intentionally ignored during diffing. Unchanged rows are skipped, avoiding unnecessary Google API quota consumption and preserving the authentic timestamp of when data last changed.
6. **Browser Disconnection Safety:** The process is entirely decoupled from the frontend. The operator or candidate can close their browser immediately; the worker runs asynchronously on Cloud Run.

---

### 6. Reconciliation / Sync Now

Reconciliation provides a full-state repair mechanism to audit and heal drift between PostgreSQL and Google Sheets.

#### Distinctions Across Sync Modes

> The "Incremental Auto-Sync" column describes the original real-time path, which the worker no longer runs. Only Scheduled Reconciliation (06:00, 12:00, 18:00 Asia/Colombo) and Sync Now write to the Sheet.

| Characteristic | Incremental Auto-Sync | Scheduled Reconciliation | Admin "Sync Now" |
| :--- | :--- | :--- | :--- |
| **Trigger Mechanism** | Event-driven (DB triggers) | Google Cloud Scheduler | Admin UI button click |
| **Scope** | Claimed queue candidates | Entire database & Sheet | Entire database & Sheet |
| **Data Consistency** | Point-in-time aggregate read | `REPEATABLE READ` snapshot | `REPEATABLE READ` snapshot |
| **Missing Candidate Action** | Appends claimed candidate | Appends all missing DB candidates | Appends all missing DB candidates |
| **Stale Row Action** | Updates claimed candidate | Rewrites any differing row | Rewrites any differing row |
| **Sheet-Only Candidate Action** | Handled only if delete-flagged | Marks `DELETED / INACTIVE` (within guard) | Marks `DELETED / INACTIVE` (within guard) |
| **Writes Disabled Behavior** | Queue items remain `PENDING` | Executes as Dry Run | Executes as Dry Run |

#### Detailed Reconciliation Algorithm

1. **Header-name Validation:** Reads row 1 once and maps every required header by name (any order; extra columns allowed).
2. **Full Sheet Scan:** Reads all data rows across the live width. Builds the candidate row index from the `_SYSTEM_CANDIDATE_ID` column.
3. **Duplicate Check:** If any duplicate candidate ID is found in the `_SYSTEM_CANDIDATE_ID` column, the run halts immediately with `DUPLICATE_CANDIDATE_ID`.
4. **Complete Database Snapshot:** Opens a single `REPEATABLE READ` transaction with `SNAPSHOT_TRANSACTION_TIMEOUT_MS = 120_000`. The reader executes `tx.user.count()` and reads all candidate aggregates, asserting:
   - `aggregates.length === expectedCount`
   - `uniqueIds` are distinct
   If the transaction fails this check, it aborts with `IncompleteSnapshotError` (`SNAPSHOT_INCOMPLETE`) to prevent marking valid rows inactive due to a partial read.
5. **Comparison & Chunked Writing:**
   - Database candidates missing from the Sheet are appended.
   - Database candidates whose cells differ from Sheet rows are updated.
   - Matching rows are counted as `unchanged` and left untouched.
   - Writes execute in chunks of 200 rows (`DEFAULT_WRITE_CHUNK`), renewing the distributed writer lease before each chunk.
6. **Sheet-Only Candidates & Deletion Guard:** Identified Sheet rows whose Column `AN` is absent from the database snapshot are evaluated against the deletion guard (see Section 7).
7. **Resolution of Dead Letters:** A successful reconciliation automatically updates older `FAILED` queue items to `COMPLETED` (`last_result = 'RESOLVED'`), clearing stale operational errors.
8. **Idempotence:** Repeatedly triggering Sync Now against a healthy Sheet results in zero writes: summary reports `appended: 0`, `updated: 0`, `unchanged: N`.

---

### 7. Candidate Deletion Behavior

Operational requirements dictate that **candidate rows must never disappear from the operational Google Sheet**. Deleting rows destructively removes historical records, invalidates row references, and risks losing operational context.

#### Preservation and Inactive Marking

When a candidate is deleted or removed from the database:
1. The row **remains in the Google Sheet**.
2. Column `AK` (`RECORD STATUS`) transitions from `ACTIVE` to:
   ```
   DELETED / INACTIVE
   ```
3. Column `AM` (`LAST MIRRORED AT`) is updated to the timestamp of the deactivation write.
4. All other columns (demographics, passport number, notes, document statuses, timestamps) remain untouched.
5. If the same candidate unique ID is ever re-created or restored in the database, subsequent sync updates Column `AK` back to `ACTIVE` and refreshes the data.

#### Deletion Guard Safeguards

Absence of a candidate from the database only triggers `DELETED / INACTIVE` marking under strict verification:

- **Incremental Sync Guard:** An incremental item will only mark a row inactive if the trigger explicitly flagged `candidate_deleted = true` **and** a fresh database read confirms the record no longer exists.
- **Reconciliation Deletion Guard:** During full reconciliation, the number of Sheet rows eligible to be marked `DELETED / INACTIVE` must satisfy:
  $$\text{toMarkCount} \le \text{SHEET\_SYNC\_DELETION\_GUARD\_MAX (default: 10)}$$
  $$\text{toMarkCount} \le \lfloor \text{SHEET\_SYNC\_DELETION\_GUARD\_FRACTION (default: 0.05)} \times \text{identifiedSheetRows} \rfloor$$
  $$\text{snapshotCount} > 0 \quad (\text{an empty DB snapshot never marks anything})$$

If the threshold is breached (for example, if a database filter bug or accidental truncate occurs):
- Zero rows are marked inactive.
- The summary records `deletionGuardTriggered: true`.
- Affected rows are reported under `notInDatabase` count.
- A warning event `sheet_sync.reconcile_deletion_guard` is emitted to Cloud Logging.

---

### 8. Admin Settings UI

The admin interface is accessible at:
```
/admin/settings
```
Inside the Settings view, the **Google Sheet Sync** card provides real-time observability and manual controls.

#### Displayed Status Items

| UI Item | Source Field | Description / States |
| :--- | :--- | :--- |
| **Connection** | `lastConnectionTest` | ToneBadge indicator: `Connected · schema valid` (green), `Not tested yet` (neutral), or `Failed` (critical). |
| **Integration state** | `integration.state` | ToneBadge indicator: `OK` (green), `Not checked yet` (neutral), `Configuration error: sync halted` (critical), or `Duplicate candidate IDs in the Sheet: sync halted` (critical). |
| **Write sync** | `writeGate` | ToneBadge indicator: `Enabled` (green) when active; `Disabled` (neutral) when in safety/dry-run mode. |
| **Target** | `target` | Safe target hint showing the spreadsheet ID suffix and tab name: `…JirMpE / Emlynk Candidate Operational Mirror`. |
| **Last successful sync** | `lastSuccessfulSyncAt` | Timestamp of the most recent successful live write. |
| **Last reconciliation** | `lastReconciliation` | Status badge (`QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `SKIPPED`), dry-run indicator, finished timestamp, and counts summary (e.g., `6 appended · 0 updated · 0 unchanged`). |
| **Last successful reconciliation** | `lastSuccessfulReconciliationAt` | Timestamp of the most recent successful reconciliation. |
| **In progress** | `activeRuns` | Active execution indicators for running or queued syncs / connection tests. |
| **Pending / failed candidate syncs** | `queue` | Formatted count: `(pending + processing) / failed` (e.g., `0 / 0`). |
| **Last failure** | `integration.lastError*` | Error class, error code, and error timestamp if an error has occurred. |
| **Worker Warning Banner** | `worker.online` | Displayed if `workerHeartbeatAt` is older than 2 minutes: *"The sheet-sync worker is not reporting. Requests stay queued until it runs."* |
| **Dry-Run Notice** | `writeGate` | Displayed when write gate is `DISABLED`: explains that Sync Now executes a dry run without modifying the Sheet. |

#### UI Action Buttons

1. **Test Connection:**
   - Triggers `POST /api/admin/settings/sheet-sync/test`.
   - Records a durable `TEST_CONNECTION` run in PostgreSQL.
   - Disabled while a connection test run is active.
   - Worker runs the read-only health check and records the result.
2. **Sync Now:**
   - Triggers `POST /api/admin/settings/sheet-sync/run`.
   - Records a durable `RECONCILE` run in PostgreSQL.
   - Disabled while a reconciliation run is active.
   - Polling interval automatically switches to 5 seconds while a run is active.

#### Role-Based Access Control (RBAC)

- **ADMIN Role Only:** The Settings page and all underlying API endpoints are strictly restricted to users with the `ADMIN` role (`requireRole([ADMIN_ROLES.ADMIN])`).
- **Forbidden Roles:** `ANALYST`, `REGISTRATION_DESK` and `JOB_HANDLER` (and an account still holding the retired `MANAGER` role) receive `403 Forbidden` from the backend API.
- **Client Enforcement:** In the Admin UI, non-ADMIN users see an "Access Restricted" message and no settings API requests are issued.
- **Candidate Pool Isolation:** The Candidate Pool UI (`/admin/candidates`) was **intentionally not changed** by this feature.

---

### 9. Security

#### Keyless Authentication via Application Default Credentials (ADC)

The implementation strictly avoids static service account JSON private key files:
- **Cloud Run Runtime Identity:** The worker runs under the dedicated Google Cloud service account `emlynk-sheet-sync@project-aa11e15e-a951-4e1b-a65.iam.gserviceaccount.com`.
- **ADC Resolution:** Authentication resolves automatically via the Cloud Run instance metadata server.
- **Explicit Key Rejection:** If `GOOGLE_APPLICATION_CREDENTIALS` is set in the environment, the worker **refuses to start** (`assertValidEnv` / `readSheetSyncConfig`), preventing accidental use of key files.
- **Zero Frontend Credentials:** The Vercel frontend holds no Google credentials, tokens, or SDKs. All Google access occurs in the private Cloud Run worker.

#### Least-Privilege Access Controls

| Boundary | Privilege Level | Implementation |
| :--- | :--- | :--- |
| **Google Sheet Access** | Editor on Target Sheet only | The target spreadsheet is shared directly with `emlynk-sheet-sync@...`. Staff maintain Viewer rights. |
| **Secret Manager** | Secret Accessor on `DATABASE_URL` only | Service account has `roles/secretmanager.secretAccessor` bound specifically to the `DATABASE_URL` secret. |
| **Cloud Run Ingress** | Private / Authenticated Only | Deployed with `--no-allow-unauthenticated`. Cloud Run IAM denies unauthorized traffic. |
| **Scheduler Ingress** | OIDC Token Invoker Only | Cloud Scheduler uses a dedicated service account `emlynk-sheet-sync-scheduler@...` with `roles/run.invoker`. |
| **Database RLS** | Revoked from Supabase Public API | Migration executes `REVOKE ALL PRIVILEGES ON TABLE sheet_sync_queue, sheet_sync_runs, sheet_sync_state FROM anon, authenticated;`. Only the backend connection can access tables. |
| **PII Redaction in Logs** | Code-Only JSON Logging | Cloud Logging receives structured JSON logs with event names (`sheet_sync.*`), run IDs, and candidate unique IDs (`candidateRef`). Candidate names, passport numbers, NICs, phone numbers, cell values, and Google error text are never logged. |

---

### 10. Environment Variables

All configuration is managed through environment variables without hardcoded secrets.

| Variable | Required | Purpose | Safe Example / Default |
| :--- | :---: | :--- | :--- |
| `SHEET_SPREADSHEET_ID` | **Yes** | Google Spreadsheet ID of the target operational Sheet. | `1-11g-0tQruJbgVslH0nzCzG_JRr-4LahSCU8ZJirMpE` |
| `SHEET_TAB_NAME` | **Yes** | Exact name of the operational tab. | `Emlynk Candidate Operational Mirror` |
| `SHEET_SYNC_ENABLED` | No | Master safety write switch. Must be `"true"` (case-insensitive) to enable writing. Any other value disables writes. | `false` (default) / `true` |
| `SHEET_SYNC_PILOT_CANDIDATE_IDS` | No | Comma-separated list of candidate unique IDs for controlled pilot writes. If set, only these candidates are written; all others wait, and reconciliations run as dry runs. | `0003` (pilot only) |
| `SHEET_SYNC_POLL_INTERVAL_MS` | No | Polling interval between worker loop ticks in milliseconds (1,000 to 600,000). | `10000` |
| `SHEET_SYNC_BATCH_SIZE` | No | Maximum number of queue items claimed per tick (1 to 200). | `25` |
| `SHEET_SYNC_MAX_RETRIES` | No | Maximum retry attempts for transient errors before dead-lettering (0 to 20). | `5` (yielding 6 total attempts) |
| `SHEET_SYNC_DELETION_GUARD_MAX` | No | Maximum candidate rows that can be marked `DELETED / INACTIVE` in a single reconciliation (0 to 100,000). | `10` |
| `SHEET_SYNC_DELETION_GUARD_FRACTION` | No | Maximum fraction of identified Sheet rows that can be marked inactive in a reconciliation (0.0 to 1.0). | `0.05` (5%) |
| `SHEET_SYNC_SCHEDULER_AUDIENCE` | No | Expected OIDC token audience for Cloud Scheduler HTTP trigger. | `https://emlynk-sheet-sync-worker-....run.app` |
| `SHEET_SYNC_SCHEDULER_INVOKER` | No | Expected service account email for Cloud Scheduler OIDC token. | `emlynk-sheet-sync-scheduler@project-aa11e15e-a951-4e1b-a65.iam.gserviceaccount.com` |
| `DATABASE_POOL_MAX` | No | PostgreSQL connection pool size for the worker process. | `2` |
| `GOOGLE_APPLICATION_CREDENTIALS` | **Forbidden** | Static service account JSON path. **Must NOT be set.** | *Leave unset* |

> [!IMPORTANT]
> `SHEET_SYNC_ENABLED=false` is the primary emergency kill switch. Setting it to `false` halts all writes to Google Sheets immediately while allowing candidate database operations to proceed normally.

---

### 11. Google Cloud Deployment

The Sheet Sync Worker runs as a dedicated, private microservice on Google Cloud Run.

#### Service Configuration

- **Cloud Run Service Name:** `emlynk-sheet-sync-worker`
- **Region:** `asia-south1` (Mumbai)
- **Runtime Service Account:** `emlynk-sheet-sync@project-aa11e15e-a951-4e1b-a65.iam.gserviceaccount.com`
- **CPU & Memory:** 1 vCPU, 512 MiB RAM
- **Instance Scaling:** `min-instances = 1`, `max-instances = 1` (strict singleton process)
- **CPU Allocation:** `--no-cpu-throttling` (CPU is always allocated to support background polling between HTTP requests)
- **Ingress Security:** `--no-allow-unauthenticated` (IAM authentication strictly enforced)
- **Database Connection:** `DATABASE_URL` injected directly from Secret Manager via `--set-secrets=DATABASE_URL=DATABASE_URL:latest` (connecting via Supabase transaction pooler)
- **Container Image:** Built from project root `Dockerfile` and executed with command `node src/sheetSyncWorker.js`

---

### 12. Scheduler

The Cloud Run worker exposes an authenticated HTTP endpoint for scheduled triggers:
```
POST /tasks/reconcile
```

#### Trigger Verification

1. **Cloud Run IAM:** Cloud Run rejects any request that lacks `roles/run.invoker` permission.
2. **OIDC Token Defense-in-Depth:** The worker's internal HTTP server ([src/sheetSyncWorkerProcess.js](../src/sheetSyncWorkerProcess.js)) verifies the Google-signed OIDC bearer token:
   - Token signature validated against Google certs.
   - Token audience matches `SHEET_SYNC_SCHEDULER_AUDIENCE`.
   - Token email matches `SHEET_SYNC_SCHEDULER_INVOKER`.
   - `email_verified === true`.
3. **Durable Request Enqueue:** A valid request records a `RECONCILE` run with trigger `SCHEDULER` and responds immediately with `202 Accepted`. The worker loop processes the reconciliation asynchronously.

#### Schedule

| Setting | Value |
| :--- | :--- |
| Job | `emlynk-sheet-sync-reconcile` (one Cloud Scheduler HTTP job) |
| Schedule | `0 6,12,18 * * *`: 06:00, 12:00 and 18:00 |
| Time zone | `Asia/Colombo` (the project's operational time zone, `src/utils/businessDay.js`; applied by Cloud Scheduler, so the server's time zone never matters) |
| Target | `POST <worker URL>/tasks/reconcile` |
| Authentication | OIDC token of `emlynk-sheet-sync-scheduler@…` (`roles/run.invoker` on the worker only); audience = the worker URL (`SHEET_SYNC_SCHEDULER_AUDIENCE`); invoker e-mail = `SHEET_SYNC_SCHEDULER_INVOKER` |

These values are declared once in `SHEET_SYNC_SCHEDULE` (`src/config/sheetSync.js`); the exact `gcloud` commands are in `GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md`, Section 24.9. The scheduled runs (and Sync Now) are the **only** automatic Sheet writes: there is no real-time sync. Each run mirrors the database as it is at that moment, so several changes between runs appear once, in their latest state.

---

### 13. Failure Handling and Retry Strategy

#### Failure Classification and Behavior

| Error Condition | Error Class | Integration State | Queue / Worker Behavior |
| :--- | :--- | :--- | :--- |
| **Rate Limit / 429 / 5xx / Network** | `GOOGLE_UNAVAILABLE` | Retains current state | Exponential backoff: `15s * 4^(attempt-1)` ±20% jitter (max 15 min). Dead-letters to `FAILED` after 6 attempts. Healed by next reconciliation. |
| **Snapshot Incomplete** | `SNAPSHOT_INCOMPLETE` | Retains current state | Reconcile run fails safely. Queue items retry. Zero writes occur. |
| **Schema Mismatch (Columns altered)** | `SCHEMA_INVALID` | `CONFIG_ERROR` (Halted) | Worker halts incremental processing. Queue items return to `PENDING` without using attempts. Worker re-checks Sheet read-only every 5 min. |
| **Google Permission / 401 / 403** | `ACCESS_DENIED` | `CONFIG_ERROR` (Halted) | Worker halts incremental processing. No retry loop against Google. Re-checks read-only every 5 min. |
| **Spreadsheet / Tab Not Found (404)** | `NOT_FOUND` | `CONFIG_ERROR` (Halted) | Worker halts incremental processing. Re-checks read-only every 5 min. |
| **Duplicate System Candidate ID** | `DUPLICATE_CANDIDATE_ID` | `DATA_INTEGRITY` (Halted) | Worker halts all processing. Zero writes occur. Re-checks read-only every 5 min until duplicate row is manually resolved in Sheet. |
| **Writer Lease Conflict** | `WRITER_BUSY` | Retains current state | Run skipped. Protects against multiple worker processes attempting concurrent writes to the same Sheet. |
| **Worker Crash / Sudden Kill** | N/A | Retains current state | Leases expire automatically after 2 minutes (queue) or 10 minutes (runs). Surviving worker re-claims and finishes work safely. |

#### The Core Invariant

> **A Google Sheet outage or API failure MUST NEVER cause an otherwise valid candidate database write to fail.**
> 
> Because database change capture occurs entirely via local PostgreSQL triggers writing to `sheet_sync_queue`, the candidate registration or update transaction succeeds unconditionally. If Google is down, the run fails with a code and the next scheduled (or manual) run mirrors the then-current database.

---

### 14. Operational Safety

The system implements multiple overlapping layers of operational defense:

1. **Environment Write Gate (`SHEET_SYNC_ENABLED`):** Disabled by default everywhere. Unless explicitly set to `"true"`, all writes are blocked at the adapter layer before calling Google APIs.
2. **Pilot Candidate Restriction (`SHEET_SYNC_PILOT_CANDIDATE_IDS`):** Permits write operations solely for explicitly listed candidate unique IDs during activation testing.
3. **Dry-Run Mode:** Full diffing and drift reporting can be run safely with writes disabled, reporting exact counts of what would be changed.
4. **Duplicate AN Detection:** Prevents destructive cross-candidate overwrites if a user duplicates a system ID in the Sheet.
5. **Deletion Guard:** Prevents mass deactivation of candidate rows in the Sheet if a database glitch returns an incomplete candidate set.
6. **Distributed Writer Lease:** Single-writer concurrency control held in `sheet_sync_state`, renewed before every 200-row chunk.
7. **No Sheet Row Deletions:** Rows are never removed from the operational spreadsheet.

---

### 15. Real Deployment Verification Performed

The following verification steps have been **confirmed and completed**:

- [x] **Database Migration Deployed:** Migration `20261006120000_sheet_sync_outbox` successfully applied to the target database. Outbox tables and triggers are active.
- [x] **Cloud Run Worker Deployed:** Dedicated service `emlynk-sheet-sync-worker` deployed in `asia-south1`.
- [x] **ADC Authentication Verified:** Dedicated service account `emlynk-sheet-sync@...` authenticated successfully using keyless Application Default Credentials.
- [x] **Live Test Connection Succeeded:** Read-only health check connected to the live Google Sheet and verified exact header schema match (`CONNECTED`, `SCHEMA_VALID`).
- [x] **Dry-Run Reconciliation Succeeded:** Write-disabled reconciliation executed against the real database and Sheet, successfully identifying candidate drift without modifying any cells.
- [x] **Initial Candidate Count Confirmed:** Dry-run reconciliation accurately detected 6 existing database candidates prior to first write.
- [x] **Controlled Single-Candidate Pilot Executed:** Controlled pilot candidate `0003` was specified via `SHEET_SYNC_PILOT_CANDIDATE_IDS=0003`.
- [x] **Pilot Write Appended Exactly One Candidate:** Pilot write successfully appended candidate `0003` to the real operational Sheet.
- [x] **Column `AN` Technical Identity Verified:** Confirmed `_SYSTEM_CANDIDATE_ID` in Column `AN` was stamped with `0003`.
- [x] **Pilot Queue Item Completed:** Queue record for candidate `0003` transitioned to `COMPLETED` with `last_result = 'APPENDED'`.
- [x] **Write Gate Enabled:** `SHEET_SYNC_ENABLED` was set to `true`.
- [x] **Pilot Restriction Removed:** `SHEET_SYNC_PILOT_CANDIDATE_IDS` was removed, allowing normal multi-candidate processing.
- [x] **Production Cloud Run Revision Healthy:** Deployed Cloud Run revision with write gate enabled and pilot restriction removed became healthy and served 100% traffic.

#### Remaining Release Verification

The following release verification steps have **not yet been confirmed** in the current environment:

- [ ] **Full Multi-Candidate Reconciliation:** Execution of the first full live reconciliation with writes enabled across all 6 database candidates.
- [ ] **Scheduled End-to-End Candidate Update:** Verification that a candidate created or edited in the live application appears in the Sheet after the next scheduled run (06:00, 12:00 or 18:00 Asia/Colombo) or Sync Now, and not before.
- [ ] **Production Cloud Scheduler Lock:** Cloud Scheduler job `emlynk-sheet-sync-reconcile` (`0 6,12,18 * * *`, `Asia/Colombo`) created, tested with OIDC authentication, and locked into production.

---

### 16. Testing

The feature is covered by comprehensive automated test suites covering backend services, data migrations, integration engines, and admin UI components.

#### Automated Test Suite Summary

| Test File | Component Under Test | Test Count | Status |
| :--- | :--- | :---: | :---: |
| [test/sheetSchema.test.js](../test/sheetSchema.test.js) | Header-name layout (any order, extra columns, missing / duplicate / renamed headers), column-letter helper, A1 ranges and write runs, assertSheetRow. | 25 | **PASS** |
| [test/candidateSheetMapper.test.js](../test/candidateSheetMapper.test.js) | Aggregate mapping, date formatting, document/stage statuses, record status, pure mapping invariants. | 21 | **PASS** |
| [test/googleSheetsAdapter.test.js](../test/googleSheetsAdapter.test.js) | Narrow adapter methods, write gate enforcement, error classification, range quoting, header-name reads and writes (operator columns never written), live client test runner guard. | 35 | **PASS** |
| [test/sheetSyncPhase2.test.js](../test/sheetSyncPhase2.test.js) | Aggregate reader batching, planning actions, duplicate ID detection, read-only health checks. | 30 | **PASS** |
| [test/sheetSyncOutbox.test.js](../test/sheetSyncOutbox.test.js) | Additive PostgreSQL migration on PGlite, atomic triggers, coalescing, delete hint stickiness, passport cascade. | 14 | **PASS** |
| [test/sheetSyncEngine.test.js](../test/sheetSyncEngine.test.js) | Incremental sync, reconciliation drift repair, deletion guard logic, duplicate stops, dry-run mode. | 13 | **PASS** |
| [test/sheetSyncReordering.test.js](../test/sheetSyncReordering.test.js) | Dynamic column mapping regression suite: canonical, reversed and unusual layouts; identity in A / middle / last; moved VISA columns; custom columns preserved; missing, duplicate and renamed headers; no wrong-column writes; layout re-read on a later run; mid-run layout change; idempotent recovery. | 23 | **PASS** |
| [test/sheetSyncWorker.test.js](../test/sheetSyncWorker.test.js) | Worker loop, lease management, writer lease fencing, exponential backoff, dead lettering, pilot restrictions, halted states, schema problem codes, PII redaction. | 37 | **PASS** |
| [test/sheetSyncSettingsApi.test.js](../test/sheetSyncSettingsApi.test.js) | Express Settings API routes, RBAC (403 for non-admin roles), token claim validation, deduplication of active runs. | 13 | **PASS** |
| [test/sheetSyncWorkerProcess.test.js](../test/sheetSyncWorkerProcess.test.js) | Worker HTTP server, `/health`, Cloud Scheduler OIDC verification, operator CLI command, shutdown signals. | 7 | **PASS** |
| [admin/src/test/settings.test.tsx](../admin/src/test/settings.test.tsx) | Admin UI Settings page, sidebar navigation, breadcrumbs, status badge rendering, action buttons, RBAC restricted card. | 12 | **PASS** |
| **Total Verified Sheet Sync Tests** | **All core sheet sync backend & frontend suites** | **230** | **100% PASS** |

#### Additional Validations

- **Admin Frontend Suite:** Full Vitest test suite (`npm --prefix admin test`) passes with **223 tests passing across 14 test files**.
- **Admin TypeScript Check:** `npm --prefix admin run typecheck` passes with **0 errors**.
- **Admin Production Build:** `npm --prefix admin run build` compiles successfully without errors.

---

### 17. Troubleshooting

#### Incident Record: Windows PowerShell Argument Parsing

During deployment configuration on Windows PowerShell, passing comma-separated environment variables to `gcloud run services update` caused an unexpected parsing error:

- **Symptom:** Cloud Run revision failed startup validation with:
  ```
  Invalid Google Sheet sync configuration:
  - SHEET_SYNC_ENABLED must be true or false
  ```
- **Root Cause:** PowerShell split arguments unexpectedly on commas or spaces, resulting in:
  ```powershell
  SHEET_SYNC_ENABLED="true SHEET_SYNC_PILOT_CANDIDATE_IDS=0003"
  ```
- **Safety System Outcome:** The fail-closed configuration validator in [src/config/sheetSync.js](../src/config/sheetSync.js) recognized the value as invalid (`INVALID`), defaulted `enabled = false`, and refused to boot, successfully preventing unauthorized writes.
- **Resolution:** When using Windows PowerShell, update variables individually or use the stop-parsing symbol `--%`:
  ```powershell
  # Safe Method: Update variables separately
  gcloud run services update emlynk-sheet-sync-worker --region=asia-south1 --update-env-vars=SHEET_SYNC_ENABLED=true
  gcloud run services update emlynk-sheet-sync-worker --region=asia-south1 --update-env-vars=SHEET_SYNC_PILOT_CANDIDATE_IDS=0003
  ```

#### Common Diagnostic Scenarios

| Issue Observed | Likely Cause | Investigation & Remediation |
| :--- | :--- | :--- |
| **Connected but no rows written** | Write sync is disabled. | Check Admin UI "Write sync" badge or `SHEET_SYNC_ENABLED` env var. If `false`, Sync Now runs as a dry run. Enable via `SHEET_SYNC_ENABLED=true`. |
| **Integration state: Configuration error: sync halted** | Header modified or access denied. | Run "Test Connection" in Admin UI. Review Cloud Logging for `sheet_sync.config_error`. If `SCHEMA_INVALID`, compare Sheet header against [src/services/sheetSchema.js](../src/services/sheetSchema.js). If `ACCESS_DENIED`, verify service account has Editor role on the Sheet. |
| **Integration state: Duplicate candidate IDs: sync halted** | Duplicate ID in Column `AN`. | Inspect Google Sheet Column `AN`. Filter for duplicate values. Remove or fix duplicate technical IDs. Once fixed, run "Test Connection" or wait 5 minutes for automatic resume. |
| **Worker banner: Worker is not reporting** | Cloud Run instance stopped or crashing. | Verify Cloud Run service `emlynk-sheet-sync-worker` in GCP console. Check Cloud Run logs for startup validation failures or database connection errors. Verify Secret Manager `DATABASE_URL` binding. |
| **Queue items accumulating in FAILED** | Repeated transient errors exceeded max retries. | Check `sheet_sync_queue` table or Admin UI pending/failed count. Triggering "Sync Now" reconciles all candidates and resolves older failed queue items upon successful write. |

---

### 18. Emergency Disable

If anomalous behavior, Sheet corruption, or operational concerns arise, execute the emergency write disable procedure immediately:

#### Step 1: Disable Cloud Run Worker Writes

Update the Cloud Run service environment variable:
```bash
gcloud run services update emlynk-sheet-sync-worker \
  --project=project-aa11e15e-a951-4e1b-a65 \
  --region=asia-south1 \
  --update-env-vars=SHEET_SYNC_ENABLED=false
```

**Operational Impact:**
- The worker immediately ceases all Google Sheet write calls.
- Subsequent Google API requests use the `spreadsheets.readonly` scope.
- `sheet_sync_queue` items remain in `PENDING` status.
- Candidate database operations in the core application proceed **completely unaffected**.

#### Step 2: Pause Cloud Scheduler Job

```bash
gcloud scheduler jobs pause emlynk-sheet-sync-reconcile-daily \
  --project=project-aa11e15e-a951-4e1b-a65 \
  --location=asia-south1
```

#### Step 3: Absolute External Revocation (If Necessary)

If immediate external access revocation is required without touching Cloud Run:
1. Open the Google Spreadsheet in Google Drive.
2. Open the **Share** dialog.
3. Remove `emlynk-sheet-sync@project-aa11e15e-a951-4e1b-a65.iam.gserviceaccount.com` from the shared users list.

---

### 19. Rollback

#### Application and Worker Rollback

1. Disable writing immediately via `SHEET_SYNC_ENABLED=false`.
2. Pause all Cloud Scheduler jobs invoking the worker.
3. If necessary, redeploy the previous Cloud Run revision or scale worker instances to 0:
   ```bash
   gcloud run services update emlynk-sheet-sync-worker \
     --project=project-aa11e15e-a951-4e1b-a65 \
     --region=asia-south1 \
     --min-instances=0 --max-instances=0
   ```

#### Google Sheet Data Restoration

1. In Google Sheets, navigate to **File → Version History → See version history**.
2. Locate the timestamp recorded immediately prior to write activation.
3. Select **Restore this version** (or restore from the offline `.xlsx` backup taken prior to deployment).

#### Database Schema Considerations

The database migration [prisma/migrations/20261006120000_sheet_sync_outbox/migration.sql](../prisma/migrations/20261006120000_sheet_sync_outbox/migration.sql) is **strictly additive**:
- It adds new tables (`sheet_sync_queue`, `sheet_sync_runs`, `sheet_sync_state`) and triggers.
- It does **NOT** modify or drop any existing columns, constraints, or relationships in `users`, `documents`, or `candidate_stages`.

> [!CAUTION]
> **Do not perform destructive database rollbacks casually.**
> Leaving the outbox tables in place causes zero disruption to normal application features even if the worker is stopped.
> If triggers must be stopped without dropping tables, run:
> ```sql
> DROP TRIGGER IF EXISTS "users_sheet_sync_capture" ON "users";
> DROP TRIGGER IF EXISTS "candidate_stages_sheet_sync_capture" ON "candidate_stages";
> DROP TRIGGER IF EXISTS "documents_sheet_sync_capture" ON "documents";
> ```

---

### 20. Git / Release Workflow

To preserve release stability and governance across environments, the project follows this branch progression:

```
dev ──> version/google-sheet-sync ──> stage ──> main
```

1. **Development (`dev`):** All feature development and initial automated testing take place on `dev`.
2. **Feature Snapshot (`version/google-sheet-sync`):** The fully tested, verified feature implementation is preserved on `version/google-sheet-sync`.
3. **Integration / Preview (`stage`):** Used for Vercel preview builds, end-to-end integration tests, and operational verification before production.
4. **Production (`main`):** Production releases require senior developer review and pull request approval. Direct commits to `main` are strictly forbidden.

---

### 21. Definition of Done

Use this checklist to track the final completion status for production release:

- [x] Backend Sheet Sync unit and integration tests passing (`167/167` tests passing)
- [x] Admin Settings frontend tests passing (`12/12` tests passing)
- [x] Full Admin test suite passing (`223/223` tests passing)
- [x] Admin frontend TypeScript typecheck passing (`0` errors)
- [x] Admin production bundle builds cleanly
- [x] Additive database migration deployed to target database
- [x] Dedicated service account configured with keyless ADC (no JSON keys stored)
- [x] Cloud Run worker service deployed in `asia-south1`
- [x] Live Test Connection verified (`CONNECTED`, `SCHEMA_VALID`)
- [x] Dry-run reconciliation verified against live database (identified 6 candidates)
- [x] Single-candidate pilot write verified for candidate `0003` with Column `AN` confirmation
- [x] Write gate enabled (`SHEET_SYNC_ENABLED=true`)
- [x] Pilot restriction removed (`SHEET_SYNC_PILOT_CANDIDATE_IDS` cleared)
- [x] Cloud Run revision healthy and serving 100% traffic
- [x] No secrets, private keys, database URLs, or candidate PII committed
- [x] Feature branch `version/google-sheet-sync` created, up to date, and pushed
- [ ] **Full multi-candidate live reconciliation completed successfully**
- [ ] **Expected candidate count present in operational Google Sheet**
- [ ] **Column `AN` IDs unique across all rows in the operational Sheet**
- [ ] **Normal candidate update reaches the Sheet at the next scheduled run (06:00 / 12:00 / 18:00 Asia/Colombo) or Sync Now, not in real time**
- [ ] **Zero duplicate rows generated after repeated reconciliations**
- [ ] **Deleted/inactive candidate row behavior verified live**
- [ ] **Production Cloud Scheduler job configured, tested, and verified**
- [ ] **Stage preview deployment verified**
- [ ] **Pull Request prepared and approved by senior developers**

---

### Candidate Form submissions tab (`Candidate Form Submissions`)

A second, independent sync in the same worker process and spreadsheet. The operational mirror above
(41 columns, scheduled reconciliations, `sheet_sync_queue`) is untouched.

- **Flow:** a successful Candidate Form submit writes `candidate_form_response` and one
  `candidate_form_sheet_sync` row in the same transaction. The sheet-sync worker takes due rows every
  tick (only while `SHEET_SYNC_ENABLED=true`, under the same writer lease) and writes each submission to
  the `Candidate Form Submissions` tab of the active destination's spreadsheet. The public submit never
  calls or waits for Google.
- **Tab:** `SHEET_FORM_SUBMISSIONS_TAB_NAME` (default `Candidate Form Submissions`); it must not be the
  mirror's tab (refused). Row 1 is created only when the tab is completely empty; otherwise every column
  of `src/services/formSubmissionSheetSchema.js` must be present exactly once (any order, operator columns
  allowed); anything else stops the sync (`SCHEMA_INVALID`) and nothing is repaired or written.
- **Keys:** `_SYSTEM_CANDIDATE_ID` (candidate unique ID) and `_SUBMISSION_ID` (the outbox row's stable ID).
  The `_SUBMISSION_ID` column is read before every write: a submission already in the tab is rewritten in
  place, never appended again.
- **Failures:** retryable errors back off (15 s, x4, capped at 15 min) without limit; configuration
  problems are re-checked every 15 min without using up attempts; any other error is dead-lettered after
  5 attempts (`status = 'FAILED'`; `requeueFailed` or an `UPDATE ... SET status = 'PENDING'` puts it back).
- **Existing submissions** (submitted before this feature) are not sent automatically. To send them, insert
  one outbox row each: `INSERT INTO candidate_form_sheet_sync (passport_id) SELECT passport_id FROM candidate_form_response ON CONFLICT DO NOTHING;`
