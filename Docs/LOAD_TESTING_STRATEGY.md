# Load and Stress Testing Strategy

**Document Status:** Complete Engineering Strategy  
**Target Repository:** `EmlynkWABot` (`version/load-testing`)  
**Target System:** Express 5 Backend (Vercel Serverless), PostgreSQL (Supabase / Supavisor), React Admin Panel, Candidate Extra Details Form, Cloud Run OCR Worker, Cloud Run Google Sheet Sync Worker.

---

## 1. PURPOSE

### 1.1 Why Load Testing is Needed
The EmlynkWABot platform automates candidate onboarding, WhatsApp document intake, automated OCR extraction, multi-staff candidate allocation, job assignment, and Google Sheets reconciliation. While functional tests verify that business logic operates correctly for a single user, performance and load testing is essential to verify how the application behaves when multiple admins, analysts, managers, and candidates access the system simultaneously under varying traffic intensities.

### 1.2 Functional vs. Performance Testing
* **Functional Testing:** Validates feature correctness, boundary rules, access control (RBAC), and database invariants (e.g., verifying that assigning a candidate creates an audit log entry and updates the allocation record).
* **Performance / Load Testing:** Evaluates system throughput (Requests Per Second - RPS), response time latency percentiles ($p_{50}, p_{95}, p_{99}$), database connection pool contention, transaction lock duration, resource consumption (CPU/Memory), worker backlog drainage, and failure modes under stress.

### 1.3 Strategic Goals for EmlynkWABot
1. Ensure the candidate intake and admin workflows remain highly responsive ($p_{95} < 1000\text{ ms}$ for standard reads) during operational peaks.
2. Prevent database pool exhaustion and connection timeouts between Vercel serverless instances and Supabase PostgreSQL.
3. Validate atomic concurrency controls in Work Allocation and Job Candidate assignments without deadlocks or corrupted assignments.
4. Establish concrete baseline metrics before running production marketing campaigns or scaling operations.

### 1.4 Critical Failure Modes to Identify
* **Slow APIs:** Endpoints with unbounded $O(N)$ candidate processing (e.g., `/api/admin/overview`, `/api/admin/reports/daily/summary`) or unindexed pattern searches (`ILIKE %search%` across multiple columns).
* **Database Bottlenecks:** Supavisor session-mode pooler exhaustion, query queueing behind small per-instance pools (`DATABASE_POOL_MAX`), and long transaction hold times.
* **Connection Exhaustion:** Vercel function concurrency scaling multiplying active connections ($\text{Instances} \times \text{DATABASE\_POOL\_MAX}$) past Supabase limits.
* **Concurrency Issues:** Overlapping managers allocating the same candidate simultaneously, duplicate WhatsApp webhook deliveries, or simultaneous Candidate Form draft saves and submissions.
* **Background Worker Bottlenecks:** Saturation of Cloud Run OCR worker queues ($2\text{ active} + 10\text{ queued}$), trigger backlog accumulation in `sheet_sync_queue`, or lease lock contention in `sheet_sync_state`.
* **Application Crashes:** Process crashes, Node.js Out-Of-Memory (OOM) errors during large PDF/image parsing, and Vercel 60-second gateway timeouts (`FUNCTION_INVOCATION_TIMEOUT`).
* **High Latency & Error Rate Increases:** Latency degradation under load, rate limiting (`429 Too Many Requests`) from PostgreSQL-backed IP rate limiters, and `500` / `503` cascades.

---

## 2. SCOPE

```
┌────────────────────────────────────────────────────────────────────────┐
│                          IN-SCOPE LOAD TARGETS                         │
├──────────────────────────┬──────────────────────────┬──────────────────┤
│       Admin / API        │      Candidate Form      │ Background Tasks │
├──────────────────────────┼──────────────────────────┼──────────────────┤
│ • Auth & Identity        │ • Verify Link (/verify)  │ • OCR Worker     │
│ • Candidates (List/Read) │ • Form Prefill (/form)   │   (Isolated)     │
│ • Candidate Detail/Logs  │ • Step Drafts (/draft)   │ • Sheet Sync     │
│ • Jobs & Allocations     │ • Final Submit (/submit) │   (Isolated)     │
│ • Work Allocation Writes │ • Concurrency & Retries  │ • Webhook Ingest │
└──────────────────────────┴──────────────────────────┴──────────────────┘
```

### 2.1 Backend / API
* **Authentication & Identity:** Session verification via `GET /auth/me` and `POST /auth/complete-invite`. Note that every authenticated request calls Supabase Auth `auth.getUser(token)` and reads `public."user"`.
* **Candidate Directory & Search:** `GET /api/admin/candidates` (pagination, status filters, ILIKE search across `firstName`, `passportId`, `nic`, `contactNumber`).
* **Candidate Details & History:** `GET /api/admin/candidates/:passportId`, `GET /api/admin/candidates/:passportId/call-logs`, `GET /api/admin/candidates/:passportId/additional-details`, `GET /api/admin/follow-ups`.
* **Candidate Updates & Actions:** `POST /api/admin/candidates`, `PUT /api/admin/candidates/:passportId`, `PUT /api/admin/candidates/:passportId/stages/:stage`, `POST /api/admin/candidates/:passportId/call-logs`, `POST /api/admin/follow-ups/:followUpId/complete`.
* **Jobs Management:** `GET /api/admin/jobs`, `POST /api/admin/jobs`, `GET /api/admin/jobs/:jobId`, `PUT /api/admin/jobs/:jobId`, `POST /api/admin/jobs/:jobId/complete`, `POST /api/admin/jobs/:jobId/cancel`, `GET /api/admin/job-types`, `GET /api/admin/job-type-choices`.
* **Work Allocation Engine:** `GET /api/admin/work-allocation/candidates`, `GET /api/admin/work-allocation/analysts`, `POST /api/admin/work-allocation/assign`, `POST /api/admin/work-allocation/unassign`, `POST /api/admin/work-allocation/auto-allocate`.
* **Candidate Form Admin APIs:** `GET/POST /api/admin/candidates/:passportId/form-share`, `POST /api/admin/candidates/:passportId/form-share/revoke`, `GET /api/admin/candidates/:passportId/form-submission`.
* **Document Management:** Metadata endpoints `GET /api/admin/documents`, `GET /api/admin/documents/missing`, `GET /api/admin/review`, `GET /api/admin/review/:reviewId`.

### 2.2 Candidate Form (Public Portal)
* **Access Verification:** `POST /api/public/candidate-details/verify` with share link secret, passport ID, and NIC.
* **Form Prefill Loading:** `POST /api/public/candidate-details/form` with candidate JWT bearer token.
* **Step-by-Step Draft Saving:** `POST /api/public/candidate-details/draft` saving individual sections (`step`, `groups`, `answers`).
* **Final Form Submission:** `POST /api/public/candidate-details/submit` validating full payload and acquiring atomic form lock.

### 2.3 Jobs & Work Allocation Workflows
* Single and multi-job listing and filtering by status (`PROCESSING`, `COMPLETED`, `CANCELLED`).
* Adding candidates to jobs (`POST /api/admin/jobs/:jobId/candidates`) and removing candidates (`DELETE /api/admin/jobs/:jobId/candidates/:passportId`).
* Validating concurrency handling when candidate is evaluated for multiple jobs or when active job constraints apply.

### 2.4 Workers (Tested in Complete Isolation)
* **Cloud Run OCR Worker:** Benchmarked independently via `POST /process` using raw image/PDF buffers up to 10 MB, evaluating queue limits (2 active + 10 waiting) and `503 OCR_BUSY` responses.
* **Cloud Run Sheet Sync Worker:** Benchmarked independently by populating `sheet_sync_queue` or triggering `/tasks/reconcile`, measuring row reconciliation drain rate against dedicated test sheets.

### 2.5 External Integrations & Initial Mocking Strategy
During initial and intermediate API load tests, external dependencies must be isolated or mocked:
* **Meta WhatsApp Outbound:** Completely disabled. The system does not send bulk outbound messages in core routes; webhook load tests must submit synthetic inbound payloads directly to `/whatsapp/webhook` with mocked media download services.
* **Google Sheets API:** Set `SHEET_SYNC_ENABLED=false` or configure a dedicated scratch spreadsheet. Never sync load test candidates to the live operational spreadsheet.
* **Supabase Storage:** Storage file transfers (`/review/:id/file`, browser uploads) should be bypassed or directed to an ephemeral test bucket to isolate backend API compute from external S3/CDN throughput.
* **Cloud Run OCR:** Mock OCR responses during end-to-end webhook ingest tests to prevent saturating the OCR service during API-focused benchmarks.

---

## 3. OUT OF SCOPE / SAFETY

> [!CAUTION]
> **STRICT SAFETY ENFORCEMENT**  
> Load and stress testing must NEVER be directed at production systems or shared operational databases. Any deviation risks permanent data corruption, quota exhaustion, or operational disruption.

* **No Production Testing:** Production Vercel deployments and production Supabase databases must NEVER be used for load or stress testing.
* **Zero Production Candidate Data:** No real candidate PII (passports, phone numbers, NICs, photos) may be utilized or stored in load testing environments.
* **No Real WhatsApp Messaging:** Synthetic tests must never trigger live WhatsApp messaging to actual phone numbers.
* **No Production Google Sheets Writes:** Production operational spreadsheets must never be configured as target sync destinations during load runs.
* **No Production Destructive Actions:** Operations such as `TRUNCATE`, database restores, or disabling triggers must strictly occur on isolated, disposable test instances.
* **Strictly Synthetic Entities:** All load test data must use explicit, identifiable prefixes (e.g., `LT_` for passports, `+94770000000` series for phone numbers, and test domains for emails).

---

## 4. RECOMMENDED TOOLS

### 4.1 Primary Recommendation: Grafana k6
**Grafana k6** is the official, strongly recommended primary load testing tool for EmlynkWABot.

**Why k6 is Preferred for This Stack:**
* **JavaScript / ES6 Scripting:** Test scenarios are written in standard JS, allowing full alignment with the project's Node.js codebase.
* **High Efficiency & Low Resource Footprint:** Written in Go; a single runner instance can easily generate thousands of Virtual Users (VUs) without JVM overhead.
* **CLI-First & Headless:** Ideal for developer execution and headless CI/CD integration with exit code status mapping.
* **Advanced Workload Modeling:** Supports both closed VU models (simulating concurrent humans with think time) and open arrival-rate models (simulating constant RPS regardless of system slowdown).
* **Native Stages & Thresholds:** Built-in declarative pass/fail criteria (e.g., `http_req_duration: ['p(95)<1000']`, `http_req_failed: ['rate<0.01']`).
* **Protocol Optimized:** Perfect for REST, JSON payloads, and header-based JWT authentication.

### 4.2 Comparison of Supporting Tools

| Tool | Primary Purpose | When It is Useful | Project Recommendation |
|---|---|---|---|
| **Grafana k6** | Scenario-based API & Protocol Load Testing | Main performance, stress, spike, and soak test suites | **PRIMARY TOOL (Adopt Immediately)** |
| **k6 Studio / Cloud** | Visual scenario builder & distributed load | Multi-region geographic load generation | Optional (Use only if distributed edge traffic is required) |
| **Autocannon** | Rapid HTTP micro-benchmarking | Quick local endpoint saturation checks | Optional (Useful for isolated local Node micro-benchmarks) |
| **Apache JMeter** | Enterprise legacy protocol testing | Complex multi-protocol legacy enterprise systems | **Not Recommended** (High XML complexity, heavyweight JVM) |
| **Locust** | Python-based distributed load testing | Teams with dedicated Python QA automation | **Not Recommended** (Unnecessary language divergence from JS stack) |

**Conclusion:** Start with **k6** for all API, scenario, and concurrency tests.

---

## 5. TEST ENVIRONMENT ARCHITECTURE

The load testing architecture requires complete isolation from production:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        ISOLATED TEST TOPOLOGY                          │
└────────────────────────────────────────────────────────────────────────┘

  [ k6 Load Generator (Local / Dedicated Runner) ]
                         │
                         ▼ HTTPS (Synthetic Authorization Bearer)
  [ Vercel Staging Deployment / Preview Instance ]
    - Region: hnd1 (Tokyo) matching production
    - maxDuration: 60s
    - Express 5 + Helmet + apiLimiter (custom staging limit)
                         │
        ┌────────────────┴────────────────┐
        ▼                                 ▼
  [ Supabase Auth (Test Project) ]   [ Supabase PostgreSQL (Test Project) ]
    - auth.getUser(token) checks       - Supavisor Pooler (Session Mode)
    - Throwaway test identities        - Isolated DATABASE_URL
                                       - Disposable candidate & audit data
                                       - Test rate_limits row per IP
                                                  ▲
        ┌─────────────────────────────────────────┴───────────────┐
        │ Polling (CAS Claim)                                     │ Polling (Lease)
        ▼                                                         ▼
  [ Cloud Run Submission Worker ]              [ Cloud Run Sheet Sync Worker ]
    - Asia-northeast1 (min=max=1)                - SHEET_SYNC_ENABLED=false
    - Target: Mocked OCR Endpoint                  (or dedicated test sheet)
        │
        ▼ HTTPS + Mock Token
  [ Cloud Run OCR Worker (Test / Staging) ]
    - Asia-south1
    - Isolated mock or dedicated staging instance
```

### 5.1 Environment Isolation Principles
1. **Dedicated Database:** A distinct PostgreSQL database on a separate Supabase test project. This prevents test audit logs (`audit_logs` is append-only with delete triggers) from polluting production.
2. **Dedicated Storage Bucket:** Ephemeral bucket (e.g., `emlynk-loadtest-storage`) configured with automatic lifecycle expiration.
3. **No Production Credentials:** Environment files must contain zero production API keys or service role secrets.
4. **Mocked Side Effects:** Disable Google Sheet synchronization and inbound/outbound WhatsApp integrations during baseline runs.

---

## 6. ENVIRONMENT VARIABLES / CONFIGURATION

### 6.1 Configuration Categories
All test runners and staging deployments must configure environment variables strictly through secure environment vaults or `.env.test` files that are never committed to version control.

```bash
# ==============================================================================
# DATABASE CONFIGURATION (Isolated Test Database)
# ==============================================================================
DATABASE_URL="postgresql://postgres:[PASSWORD]@[TEST_POOLER_HOST]:5432/postgres?sslmode=require"
DATABASE_POOL_MAX="3"

# ==============================================================================
# PLATFORM & RUNTIME
# ==============================================================================
NODE_ENV="staging"
PORT="3000"
VERCEL="1"
TRUST_PROXY_HOPS="1"
APP_BASE_URL="https://staging.emlynk.example.com"

# ==============================================================================
# AUTHENTICATION & SUPABASE (Dedicated Test Project)
# ==============================================================================
SUPABASE_URL="https://[TEST_PROJECT_ID].supabase.co"
SUPABASE_SERVICE_ROLE_KEY="[TEST_SERVICE_ROLE_KEY]"
SUPABASE_BUCKET="emlynk-test-storage"

# ==============================================================================
# CANDIDATE EXTRA DETAILS FORM CONFIGURATION
# ==============================================================================
CANDIDATE_FORM_ORIGIN="https://staging-form.emlynk.example.com"
CANDIDATE_FORM_TOKEN_SECRET="[TEST_SECRET_MIN_32_CHARACTERS_LONG]"

# ==============================================================================
# WORKERS & EXTERNAL INTEGRATIONS
# ==============================================================================
SHEET_SYNC_ENABLED="false"
SHEET_SPREADSHEET_ID="[TEST_SPREADSHEET_ID]"
SHEET_TAB_NAME="LoadTest_Candidates"
OCR_SERVICE_URL="https://ocr-staging.internal.example.com"

# ==============================================================================
# WHATSAPP WEBHOOK (Synthetic Staging Settings)
# ==============================================================================
META_APP_SECRET="[TEST_META_APP_SECRET]"
WHATSAPP_VERIFY_TOKEN="[TEST_WHATSAPP_VERIFY_TOKEN]"
WHATSAPP_ACCESS_TOKEN="[TEST_WHATSAPP_ACCESS_TOKEN]"
WHATSAPP_API_VERSION="v21.0"
```

### 6.2 Test Secret Safety Rules
* **Zero Hardcoded Secrets:** Never embed secrets or database credentials within k6 test scripts.
* **Environment Variable Injection:** Pass endpoints and credentials dynamically to k6 at runtime:
  ```bash
  k6 run -e BASE_URL="https://staging.emlynk.example.com" -e ADMIN_TOKEN="[TEST_TOKEN]" smoke.js
  ```
* **Disposable Tokens:** Generate short-lived authentication tokens exclusively for load testing accounts.

---

## 7. TEST DATA STRATEGY

### 7.1 Synthetic Test Entities
All test entities must follow deterministic naming conventions allowing instant identification and safe cleanup.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        SYNTHETIC DATA SCHEMA                           │
├─────────────────────┬──────────────────────────────────────────────────┤
│ Entity              │ Synthetic Pattern / Specification                │
├─────────────────────┼──────────────────────────────────────────────────┤
│ Staff Accounts      │ lt_admin@test.local, lt_manager_[a|b]@test.local │
│                     │ lt_analyst_[1-5]@test.local, lt_jobhandler@...   │
├─────────────────────┼──────────────────────────────────────────────────┤
│ Candidate Passports │ LT1000001 to LT1099999 (Regex: ^[A-Za-z0-9]{1,20}$)│
├─────────────────────┼──────────────────────────────────────────────────┤
│ Candidate NICs      │ 199010000001 to 199010009999 (12-digit format)   │
├─────────────────────┼──────────────────────────────────────────────────┤
│ Contact Numbers     │ +94770000001 to +94770009999 (Safe Dummy Range)  │
├─────────────────────┼──────────────────────────────────────────────────┤
│ Jobs                │ LT_JOB_001 to LT_JOB_050 (Active Job Types)      │
├─────────────────────┼──────────────────────────────────────────────────┤
│ Documents           │ Synthetic 100KB JPEG & 1-page PDF Buffers        │
└─────────────────────┴──────────────────────────────────────────────────┘
```

### 7.2 Data Partitioning & Record Isolation
* **Separate Mutable Records:** During general load testing, assign distinct candidate ID blocks to each Virtual User (VU). For example:
  * VU 1: `LT1000001` - `LT1000100`
  * VU 2: `LT1000101` - `LT1000200`
* **Shared Records for Concurrency Tests:** Only target identical records when explicitly evaluating race conditions and lock contention (e.g., Section 14).

### 7.3 Post-Test Cleanup Strategy
1. **Preferred Approach (Database Reset):** Restore the database snapshot or recreate the Supabase branching instance. Because `audit_logs` enforces an append-only trigger that rejects `DELETE` and `TRUNCATE`, snapshot restore is the cleanest reset method.
2. **Selective Teardown Script (Non-Audit Entities):** Execute a targeted SQL cleanup script on the disposable database:
   ```sql
   -- Purge synthetic allocations and candidate form records
   DELETE FROM "candidate_allocation" WHERE "passport_id" LIKE 'LT%';
   DELETE FROM "candidate_form_drafts" WHERE "passport_id" LIKE 'LT%';
   DELETE FROM "candidate_form_responses" WHERE "passport_id" LIKE 'LT%';
   DELETE FROM "candidate" WHERE "passport_id" LIKE 'LT%';
   ```

---

## 8. PERFORMANCE TEST TYPES

```
VU Load Progression
 ▲
100│                                    ┌────────┐ (Stress / Spike)
   │                       ┌────────────┘        └──────────┐
 50│         ┌─────────────┘                                └───────────┐
 25│   ┌─────┘                                                          │ (Soak)
 10│┌──┘                                                                └──────────
  0└┴──────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────►
  Smoke Baseline  Load 10    Load 25    Load 50   Stress 100    Spike      Soak (Time)
```

### A. Smoke Test
* **Purpose:** Verify script syntax, environment connectivity, authentication handling, and endpoint sanity.
* **Volume:** 1–2 VUs.
* **Duration:** 1–2 minutes.
* **Target:** $100\%$ HTTP 200 responses across core routes.

### B. Baseline Test
* **Purpose:** Establish benchmark latency and resource utilization under minimal contention.
* **Volume:** 1–5 VUs.
* **Duration:** 3–5 minutes.
* **Target:** Determine uncontended baseline $p_{50}, p_{95}, p_{99}$ response times.

### C. Load Test
* **Purpose:** Simulate anticipated peak operational concurrency.
* **Progression:**
  1. Stage 1: Ramp to 10 VUs over 2 minutes; hold 5 minutes.
  2. Stage 2: Ramp to 25 VUs over 2 minutes; hold 5 minutes.
  3. Stage 3: Ramp to 50 VUs over 2 minutes; hold 5 minutes.
  4. Stage 4: Ramp to 100 VUs over 3 minutes; hold 5 minutes.
* **Target:** Verify stable throughput without connection pool exhaustion.

### D. Stress Test
* **Purpose:** Identify the system breaking point, maximum throughput ceiling, and degradation behavior.
* **Execution:** Incrementally increase load (+10 VUs every 2 minutes) until error rates exceed $5\%$, latency spikes sharply, or database connection queues fail (`P2024`).

### E. Spike Test
* **Purpose:** Assess system resilience and recovery during sudden dramatic traffic bursts.
* **Execution:** Step from 5 VUs to 100 VUs in 10 seconds; hold for 3 minutes; step back to 5 VUs. Monitor cold start recovery and error rate stabilization.

### F. Soak Test
* **Purpose:** Detect memory leaks, unclosed PostgreSQL client connections, and slow performance degradation over prolonged execution.
* **Volume:** Steady 20–30 VUs.
* **Duration:** 1 to 4 hours.

---

## 9. TEST EXECUTION ORDER

> [!IMPORTANT]
> **INCREMENTAL TESTING DISCIPLINE**  
> Never initiate load testing directly with high concurrency. Always follow this strict phased sequence to isolate bottlenecks systematically.

```
Phase 1: Basic Health & Unauthenticated Reads (/health)
   │
Phase 2: Authenticated Reads (Candidates, Jobs, Work Allocation)
   │
Phase 3: Candidate Form Ingestion (Draft Save, Final Submission)
   │
Phase 4: High-Contention Mutations (Allocation Assign, Job Candidates)
   │
Phase 5: Isolated OCR Worker Direct Benchmark (/process)
   │
Phase 6: Isolated Sheet Sync Worker Reconcile Benchmark
   │
Phase 7: Full Multi-Persona End-to-End Realistic Simulation
```

1. **Phase 1: Health & Unauthenticated Baseline:** Test `GET /health` to measure edge routing and minimal Express overhead.
2. **Phase 2: Authenticated Read APIs:** Validate `GET /api/admin/candidates`, `GET /api/admin/jobs`, `GET /api/admin/work-allocation/candidates`.
3. **Phase 3: Candidate Form Flows:** Validate public verification, prefill retrieval, draft saves, and single submission locking.
4. **Phase 4: Mutations & Concurrency:** Execute batch allocations, status updates, and call log creation.
5. **Phase 5: OCR Worker Isolation:** Direct load tests against Cloud Run OCR worker.
6. **Phase 6: Sheet Sync Worker Isolation:** Benchmark queue drainage and Google Sheets API quota limits.
7. **Phase 7: Realistic Multi-Persona Scenarios:** Execute weighted multi-role user traffic across the full application.

---

## 10. REALISTIC USER SCENARIOS

### Scenario 1: Admin Persona (System Oversight)
1. Sign in via Supabase Auth $\rightarrow$ retrieve JWT.
2. Load Dashboard Overview (`GET /api/admin/overview`).
3. Browse Candidate Directory (`GET /api/admin/candidates?page=1&pageSize=50`).
4. Perform search query (`GET /api/admin/candidates?search=LT10002`).
5. Inspect Candidate Detail (`GET /api/admin/candidates/:passportId`).
6. Review Audit Logs (`GET /api/admin/audit-logs?page=1&pageSize=50`).
*Think Time:* 3 to 8 seconds between actions.

### Scenario 2: Analyst Persona (Candidate Processing)
1. Sign in $\rightarrow$ fetch profile (`GET /auth/me`).
2. Load assigned candidates (`GET /api/admin/work-allocation/candidates` scoped to Analyst ID).
3. Open Candidate Detail (`GET /api/admin/candidates/:passportId`).
4. Read Call History (`GET /api/admin/candidates/:passportId/call-logs`).
5. Add Call Log entry (`POST /api/admin/candidates/:passportId/call-logs`).
6. Advance Candidate Stage (`PUT /api/admin/candidates/:passportId/stages/DOCUMENT_VERIFICATION`).
7. Check Priority Follow-Ups (`GET /api/admin/follow-ups`).
*Think Time:* 4 to 10 seconds between actions.

### Scenario 3: Job Handler Persona (Allocation & Matching)
1. Sign in $\rightarrow$ navigate to Jobs (`GET /api/admin/jobs`).
2. Open Job Detail (`GET /api/admin/jobs/:jobId`).
3. Search candidates matching job type (`GET /api/admin/candidates?search=...`).
4. Assign candidate to job (`POST /api/admin/jobs/:jobId/candidates`).
5. Verify updated candidate roster.
*Think Time:* 5 to 12 seconds between actions.

### Scenario 4: Candidate Persona (Self-Service Form)
1. Open Candidate Form link (`POST /api/public/candidate-details/verify`).
2. Load prefill identity and existing data (`POST /api/public/candidate-details/form`).
3. Save Section 1 Draft (`POST /api/public/candidate-details/draft` step: "personal").
4. Save Section 2 Draft (`POST /api/public/candidate-details/draft` step: "education").
5. Save Section 3 Draft (`POST /api/public/candidate-details/draft` step: "experience").
6. Submit Completed Form (`POST /api/public/candidate-details/submit`).
*Think Time:* 5 to 15 seconds per form section.

---

## 11. K6 PROJECT STRUCTURE

We recommend organizing load testing assets in a dedicated directory structure within the repository or test runner environment:

```
performance-tests/
├── README.md                      # Execution guide and environment setup
├── smoke.js                       # 1-VU sanity test across all routes
├── load.js                        # Multi-stage load test (10 -> 25 -> 50 -> 100 VUs)
├── stress.js                      # Breaking point discovery test
├── spike.js                       # Sudden traffic surge test
├── soak.js                        # Long-duration endurance test
├── scenarios/
│   ├── auth.js                    # Isolated authentication & session benchmarks
│   ├── candidates.js              # Candidate directory, search, and detail readers
│   ├── candidate-form.js          # Public form verify, draft, and submit pipeline
│   ├── jobs.js                    # Job creation, filtering, and candidate mapping
│   ├── work-allocation.js         # Allocation queries and assign/unassign actions
│   ├── allocation-concurrency.js  # Dedicated race condition tests
│   └── reports.js                 # Heavy reporting endpoints (Overview, Daily Summary)
└── helpers/
    ├── config.js                  # Environment variable parser and default options
    ├── auth.js                    # Token generation, setup hooks, and session reuse
    ├── data.js                    # Synthetic data generators and pickers
    └── metrics.js                 # Custom Trend and Rate metrics
```

### Module Responsibilities
* `helpers/config.js`: Parses CLI environment flags (`__ENV.BASE_URL`, `__ENV.POOL_MAX`).
* `helpers/auth.js`: Implements the `setup()` lifecycle hook to authenticate users once and provide JWT tokens to VUs.
* `helpers/data.js`: Manages deterministic synthetic identifiers (`LT...`), random payload selectors, and realistic think-time sleeps.
* `scenarios/*`: Modular test logic that can be executed independently or composed into composite profiles.

---

## 12. K6 BASIC SCRIPT EXAMPLE

Below is a production-grade, non-sensitive k6 script for benchmarking `GET /health` with thresholds:

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

// 1. Test Options & Thresholds
export const options = {
  stages: [
    { duration: '30s', target: 10 }, // Ramp-up to 10 VUs
    { duration: '1m', target: 10 },  // Hold at 10 VUs
    { duration: '20s', target: 0 },  // Ramp-down to 0 VUs
  ],
  thresholds: {
    // 95% of requests must complete below 500ms; 99% below 1000ms
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    // HTTP failure rate must stay below 1%
    http_req_failed: ['rate<0.01'],
  },
};

// 2. Environment Configuration
const BASE_URL = __ENV.BASE_URL || 'https://staging.emlynk.example.com';

// 3. Virtual User Test Logic
export default function () {
  const url = `${BASE_URL}/health`;
  const params = {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'k6-loadtest/1.0',
    },
    timeout: '10s',
  };

  const response = http.get(url, params);

  // Validate response status and payload integrity
  check(response, {
    'status is 200': (r) => r.status === 200,
    'status field is OK': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.status === 'OK';
      } catch (e) {
        return false;
      }
    },
  });

  // Realistic user think time
  sleep(1);
}
```

---

## 13. AUTHENTICATED TESTING

### 13.1 Authentication Architecture Constraints
In EmlynkWABot, the frontend authenticates directly against Supabase Auth to obtain a JWT. On **every** backend API request to `/api/admin/*`, the backend Express middleware (`requireActiveUser.js`) executes two operations:
1. Calls Supabase Auth (`auth.getUser(token)`) over HTTPS to validate session validity.
2. Queries PostgreSQL (`SELECT * FROM "user" WHERE auth_user_id = ...`) to establish the application role and status.

### 13.2 Session Handling Strategy
* **Token Reuse in k6 `setup()`:** Authenticate test identities (`ADMIN`, `MANAGER`, `ANALYST`) once in the k6 `setup()` lifecycle hook. Distribute the resulting JWT tokens to VUs.
* **Avoid Login-Per-Request:** Do not invoke Supabase sign-in endpoints on every iteration. Doing so tests Supabase Auth rate limits rather than the Emlynk application backend.
* **Token Refresh Handling:** For soak tests running longer than 50 minutes (access tokens expire after 1 hour), implement token refresh logic in helper utilities.
* **Separate Login Stress Suite:** Run a dedicated, small-scale test to benchmark `POST /auth/v1/token` separately if authentication ingress capacity must be evaluated.

---

## 14. CONCURRENCY TESTING

Concurrency tests must be separated from general load tests to evaluate data integrity and locking mechanisms under high contention.

```
┌────────────────────────────────────────────────────────────────────────┐
│                      CRITICAL CONCURRENCY SCENARIOS                    │
├─────────────────────────┬──────────────────────────────────────────────┤
│ Test Scenario           │ Target Invariant & Expected Behavior         │
├─────────────────────────┼──────────────────────────────────────────────┤
│ Simultaneous Allocation │ Two managers assign overlapping candidates.   │
│ Conflict                │ SELECT FOR UPDATE row locks ensure all-or-   │
│                         │ nothing; second manager gets 409 Conflict.   │
├─────────────────────────┼──────────────────────────────────────────────┤
│ Multi-Job Assignment    │ Candidate assigned to multiple active jobs;  │
│                         │ verify state consistency and job rules.      │
├─────────────────────────┼──────────────────────────────────────────────┤
│ Duplicate Form Submit   │ Twin requests submit candidate form.         │
│                         │ Idempotency key & version lock ensure only   │
│                         │ one succeeds; twin gets 409 ALREADY_SUBMITTED│
├─────────────────────────┼──────────────────────────────────────────────┤
│ Concurrent Draft Saves  │ Parallel section saves on same candidate;    │
│                         │ confirm JSON merge integrity, no data loss.  │
├─────────────────────────┼──────────────────────────────────────────────┤
│ Webhook Deduplication   │ Redelivered WhatsApp media message;          │
│                         │ messageIdCache & fileSha256 drop duplicates. │
└─────────────────────────┴──────────────────────────────────────────────┘
```

### 14.1 Database Invariant Verification Script
Following any concurrency test, execute verification queries against the test database:

```sql
-- 1. Ensure no candidate is assigned to more than one Analyst
SELECT passport_id, COUNT(*) 
FROM candidate_allocation 
GROUP BY passport_id 
HAVING COUNT(*) > 1;

-- 2. Ensure every allocation belongs to an ACTIVE ANALYST
SELECT a.passport_id, a.analyst_id 
FROM candidate_allocation a
LEFT JOIN "user" u ON u.admin_id = a.analyst_id
WHERE u.admin_id IS NULL OR u.role != 'ANALYST' OR u.status != 'ACTIVE';

-- 3. Confirm Candidate Form submission locking integrity
SELECT passport_id, COUNT(*) 
FROM candidate_form_responses 
GROUP BY passport_id 
HAVING COUNT(*) > 1;
```

---

## 15. DATABASE MONITORING

During every test execution, continuously monitor PostgreSQL and Supavisor pooler statistics:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        POSTGRESQL & POOLER METRICS                     │
├───────────────────────┬────────────────────────────────────────────────┤
│ Metric                │ Monitoring Source / Inspection Method          │
├───────────────────────┼────────────────────────────────────────────────┤
│ Connection Pool State │ pg_stat_activity (active, idle, waiting clients)│
├───────────────────────┼────────────────────────────────────────────────┤
│ Supavisor Pool Queue  │ Supabase Dashboard > Database > Connection Pool│
├───────────────────────┼────────────────────────────────────────────────┤
│ Client Pool Timeouts  │ Prisma P2024 ("Timed out fetching connection")  │
├───────────────────────┼────────────────────────────────────────────────┤
│ Transaction Timeouts  │ Prisma P2028 ("Transaction API error: timeout")│
├───────────────────────┼────────────────────────────────────────────────┤
│ Lock Contention       │ pg_locks joined with pg_stat_activity          │
├───────────────────────┼────────────────────────────────────────────────┤
│ Slow Queries          │ pg_stat_statements (sort by total_exec_time)   │
├───────────────────────┼────────────────────────────────────────────────┤
│ Hot Row Contention    │ UPDATE latency on rate_limits table row per IP │
├───────────────────────┼────────────────────────────────────────────────┤
│ Hardware Saturation   │ Supabase Compute Metrics (CPU %, Memory %, IOPS│
└───────────────────────┴────────────────────────────────────────────────┘
```

### Critical Prisma Pool Mechanics
The backend uses `@prisma/adapter-pg` with `DATABASE_POOL_MAX` (default: 3 connections per Vercel serverless instance). Under serverless autoscaling:
$$\text{Total Active Connections} = \text{Active Vercel Instances} \times \text{DATABASE\_POOL\_MAX}$$
If 25 serverless instances scale up, they attempt to open 75 session connections against Supavisor. Ensure the Supabase compute instance connection limit is configured to accommodate this multiplier.

---

## 16. BACKEND MONITORING

Monitor the Express 5 backend application metrics during testing:
* **Latency Percentiles:** Track $p_{50}, p_{90}, p_{95}, p_{99}$ across all endpoint tags.
* **HTTP Error Code Distribution:**
  * `200` / `201` / `204`: Normal operation.
  * `400` / `404`: Client errors or invalid test IDs.
  * `409 Conflict`: Expected during intentional race condition tests; unexpected during normal load tests.
  * `429 Too Many Requests`: Triggered when k6 runner exceeds IP rate limiters (see Section 17 of architecture).
  * `500 Internal Server Error`: Unhandled application errors or database failures.
  * `502 Bad Gateway` / `504 Gateway Timeout`: Vercel edge timeouts ($> 60\text{ s}$).
* **Vercel Serverless Metrics:** Invocation count, function duration, memory usage, cold start duration, and active instance count.
* **Event Loop Lag:** Node.js event loop delay during large JSON serialization (e.g., Overview/Reports).

---

## 17. CLOUD RUN MONITORING

When benchmarking the background workers (`emlynk-ocr-worker` and `emlynk-sheet-sync-worker`):
* **OCR Worker Service (`emlynk-ocr-worker`):**
  * Concurrency: Max 2 active jobs + 10 waiting per instance.
  * Rejection: `503 OCR_BUSY` when internal queue reaches capacity.
  * Compute: Monitor CPU utilization (Tesseract OCR is CPU-bound) and memory consumption (prevent OOM crashes on 10MB PDF scans).
  * Cold Starts: Measure container initialization latency.
* **Sheet Sync Worker Service (`emlynk-sheet-sync-worker`):**
  * Reconcile Duration: Measure total elapsed time to reconcile candidate records.
  * Lock Contention: Verify `sheet_sync_state` lease acquisition.
  * Google API Quotas: Monitor Google Sheets API read/write quota usage (100 requests per 100 seconds per user).

---

## 18. VERCEL TESTING CONSIDERATIONS

1. **Avoid Blindly Stressing Production:** Never target production domains. Conduct tests exclusively against a dedicated staging environment or preview deployment.
2. **Provider Load Testing Policies:** Verify Vercel Fair Use and DDoS policies before executing high-volume ($> 500\text{ RPS}$) benchmarks.
3. **Cold Starts vs. Warm Instances:** Always execute a 2-minute warm-up phase prior to recording metrics to allow serverless containers to spin up.
4. **Serverless Concurrency Limits:** Be aware of account-level concurrent function invocation limits on Vercel plans to prevent artificial throttling at the edge layer.

---

## 19. GOOGLE SHEET / WHATSAPP SAFETY

> [!WARNING]
> **EXTERNAL INTEGRATION SAFEGUARDS**  
> External third-party integrations carry real-world side effects, rate limits, and financial costs.

* **Google Sheets Protection:** Candidate inserts and edits fire the database trigger `sheet_sync_queue`. If a sheet sync worker is active with `SHEET_SYNC_ENABLED=true`, test candidates will be synchronized to Google Sheets.
  * *Enforcement:* Always set `SHEET_SYNC_ENABLED=false` during API load tests, or explicitly point `SHEET_SPREADSHEET_ID` to an isolated scratch spreadsheet.
* **WhatsApp Protection:** Inbound webhook load testing must use synthetic HMAC signatures (`x-hub-signature-256`) and mock media download services. Under no circumstances should real candidate phone numbers be targeted with automated WhatsApp messages.

---

## 20. METRICS

| Category | Metric Name | Unit | Critical Threshold / Goal |
|---|---|---|---|
| **Throughput** | Requests Per Second (RPS) | req/s | Measure maximum sustained rate |
| **Latency** | $p_{50}$ (Median Latency) | ms | $< 300\text{ ms}$ for standard APIs |
| **Latency** | $p_{95}$ (95th Percentile) | ms | $< 1000\text{ ms}$ for standard APIs |
| **Latency** | $p_{99}$ (99th Percentile) | ms | $< 2000\text{ ms}$ for standard APIs |
| **Reliability** | HTTP Failure Rate | % | $< 1.0\%$ (excluding expected 4xx) |
| **Reliability** | HTTP 5xx Count | count | **0 unexpected server errors** |
| **Reliability** | Timeout Count | count | **0 gateway or client timeouts** |
| **Database** | Pool Saturation Errors | count | **0 Prisma P2024 / P2028 errors** |
| **Database** | Database CPU Utilization | % | $< 80\%$ sustained average |
| **Workers** | OCR Queue Rejections | count | Validate graceful 503 backpressure |
| **Workers** | Sheet Sync Drain Rate | rows/s | Measure batch sync throughput |

---

## 21. INITIAL PASS/FAIL THRESHOLDS

> [!NOTE]
> These values represent **initial engineering targets** based on architectural analysis and must be calibrated following baseline testing.

```
┌────────────────────────────────────────────────────────────────────────┐
│                      INITIAL ENGINEERING THRESHOLDS                    │
├──────────────────────────────────┬─────────────────────────────────────┤
│ Endpoint Category                │ Threshold Criteria                  │
├──────────────────────────────────┼─────────────────────────────────────┤
│ Health & Light Reads             │ p95 < 500 ms, p99 < 1000 ms         │
│ (/health, /auth/me)              │                                     │
├──────────────────────────────────┼─────────────────────────────────────┤
│ Standard CRUD & Details          │ p95 < 1000 ms, p99 < 2000 ms        │
│ (/candidates, /jobs, /review)    │                                     │
├──────────────────────────────────┼─────────────────────────────────────┤
│ Heavy Reports & Overview         │ p95 < 2500 ms, p99 < 5000 ms        │
│ (/overview, /reports/daily/...)  │                                     │
├──────────────────────────────────┼─────────────────────────────────────┤
│ Standard Mutations               │ p95 < 1500 ms, p99 < 3000 ms        │
│ (Draft save, call logs, stages)  │                                     │
├──────────────────────────────────┼─────────────────────────────────────┤
│ Transactional Batch Writes       │ p95 < 3000 ms, zero reaching 5000 ms│
│ (Work Allocation assign ≤ 100)   │                                     │
├──────────────────────────────────┼─────────────────────────────────────┤
│ Overall HTTP Error Rate          │ < 1.0% failure rate                 │
├──────────────────────────────────┼─────────────────────────────────────┤
│ Database Pool Failures           │ 0 Prisma P2024 / P2028 exceptions   │
└──────────────────────────────────┴─────────────────────────────────────┘
```

---

## 22. STEP-BY-STEP TEST PLAN

Follow this structured execution plan to perform systematic performance testing:

```
[Step 1: Environment Setup]      ──► [Step 2: Seed Synthetic Data]
              │                                      │
              ▼                                      ▼
[Step 3: Install & Verify k6]    ──► [Step 4: Execute Smoke Test]
              │                                      │
              ▼                                      ▼
[Step 5: Run Baseline (1-5 VU)]  ──► [Step 6: Run 10-VU Load Test]
              │                                      │
              ▼                                      ▼
[Step 7: Run 25-VU Load Test]    ──► [Step 8: Run 50-VU Load Test]
              │                                      │
              ▼                                      ▼
[Step 9: Review & Identify]      ──► [Step 10: Apply Optimizations]
              │                                      │
              ▼                                      ▼
[Step 11: Execute Stress Test]   ──► [Step 12: Execute Spike Test]
              │                                      │
              ▼                                      ▼
[Step 13: Execute Soak Test]     ──► [Step 14: Benchmark OCR Worker]
              │                                      │
              ▼                                      ▼
[Step 15: Run Full E2E Scenario] ──► [Step 16: Publish Performance Report]
```

* **Step 1: Prepare Isolated Environment:** Stand up dedicated Vercel staging deployment and test Supabase project. Verify `SHEET_SYNC_ENABLED=false`.
* **Step 2: Seed Synthetic Data:** Populate database with throwaway staff users (`lt_admin`, `lt_manager`, `lt_analyst`) and 2,000 synthetic `LT...` candidates.
* **Step 3: Install k6:** Verify local k6 CLI installation (`k6 version`).
* **Step 4: Run Smoke Test:** Execute `smoke.js` (1 VU, 60s) to validate script routing and authentication.
* **Step 5: Run Baseline Test:** Execute `load.js` at 1–5 VUs to record baseline $p_{50}, p_{95}$ timings.
* **Step 6: Run 10-VU Load Test:** Execute 10 VUs for 5 minutes; observe database connection usage.
* **Step 7: Run 25-VU Load Test:** Execute 25 VUs for 5 minutes; monitor Vercel function concurrency.
* **Step 8: Run 50-VU Load Test:** Execute 50 VUs for 5 minutes; monitor Supavisor pooler behavior.
* **Step 9: Review Metrics:** Analyze logs for query bottlenecks, slow ILIKE scans, or rate limit 429s.
* **Step 10: Fix Bottlenecks:** Apply single targeted optimizations (e.g., query indexing or connection pool tuning) and re-verify.
* **Step 11: Run Stress Test:** Execute `stress.js` (+10 VUs every 2 minutes) to discover the saturation ceiling.
* **Step 12: Run Spike Test:** Execute `spike.js` (5 $\rightarrow$ 100 $\rightarrow$ 5 VUs) to test recovery.
* **Step 13: Run Soak Test:** Execute `soak.js` (25 VUs for 2 hours) to identify memory or connection leaks.
* **Step 14: Test OCR Worker Separately:** Execute standalone benchmark on Cloud Run OCR worker.
* **Step 15: Test Realistic E2E Scenarios:** Execute weighted multi-persona scenario simulating real operational mix.
* **Step 16: Prepare Final Report:** Compile test outputs into the standardized reporting format.

---

## 23. RESULT RECORDING TEMPLATE

Use this standardized Markdown format to record every performance test execution:

### Performance Test Run Record

**Execution Date:** `YYYY-MM-DD`  
**Git Commit / Branch:** `[COMMIT_HASH]` / `version/load-testing`  
**Target Environment:** Staging (Vercel `hnd1` + Supabase `aws-0-ap-northeast-1`)  
**Dataset Scale:** 2,000 Candidates | 50 Jobs | 10 Staff Users  

#### Quantitative Metrics Table

| Test Name | VUs | Duration | RPS | $p_{50}$ (ms) | $p_{95}$ (ms) | $p_{99}$ (ms) | Error % | Peak DB Conn | Peak CPU % | Peak Mem (MB) | Result |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Smoke Test | 1 | 1 min | 5.2 | 180 | 320 | 450 | 0.0% | 3 | 12% | 145 MB | **PASS** |
| Baseline | 5 | 3 min | 22.4 | 210 | 410 | 680 | 0.0% | 6 | 18% | 160 MB | **PASS** |
| Load-10 | 10 | 5 min | 45.1 | 240 | 580 | 920 | 0.0% | 9 | 28% | 190 MB | **PASS** |
| Load-25 | 25 | 5 min | 98.3 | 310 | 890 | 1,420 | 0.0% | 18 | 44% | 240 MB | **PASS** |
| Load-50 | 50 | 5 min | 165.0 | 520 | 1,650 | 2,890 | 0.2% | 32 | 72% | 310 MB | **PASS** |
| Stress | 120 | 15 min | 210.5 | 1,200 | 4,800 | 8,200 | 6.4% | 45 | 98% | 512 MB | **FAIL (Cap)**|
| Spike | 100 | 4 min | 180.2 | 850 | 3,200 | 6,100 | 1.1% | 42 | 89% | 460 MB | **PASS (Rec)**|
| Soak | 25 | 2 hrs | 92.0 | 320 | 920 | 1,480 | 0.0% | 18 | 42% | 255 MB | **PASS** |

#### Qualitative Analysis & Observations
* **Observed Bottlenecks:** Detail slow queries, rate limiter row contention, or pool queuing.
* **Errors & Stack Traces:** Record specific status codes (e.g., `429 Too Many Requests`, Prisma `P2024`).
* **Root Cause Analysis:** Explain why degradation occurred at specific VU thresholds.
* **Remediation & Code Fixes:** Document proposed index additions, query refactors, or config adjustments.
* **Retest Findings:** Summary of performance delta after optimizations are applied.

---

## 24. STOP CONDITIONS

> [!CAUTION]
> **EMERGENCY ABORT CRITERIA**  
> If any of the following conditions occur during a load test, the runner must **IMMEDIATELY ABORT** testing:

1. **High Error Surge:** Sustained HTTP 5xx error rate exceeds $5\%$ over a 60-second window.
2. **Database Connection Exhaustion:** Persistent Prisma `P2024` connection timeouts or database unreachable errors.
3. **Application Instability:** Continuous Vercel 60-second gateway timeouts (`504 Gateway Timeout`) or container crash-looping.
4. **Production Leakage:** Any indication that synthetic traffic, emails, or sheet updates are reaching production environments.
5. **Excessive Third-Party API Usage:** Unexpected spike in external billing or API quota warnings (Google Cloud, Supabase Auth).
6. **Data Corruption:** Detected failures in database relational integrity or invariant violations during concurrency tests.
7. **Sustained Hardware Saturation:** Database CPU or Memory remaining at $100\%$ continuously for $> 90$ seconds.

---

## 25. FINAL LOAD TESTING WORKFLOW

To execute load testing efficiently and safely, adhere to this final sequence:

```
  ┌────────────────────────────────────────────────────────┐
  │ 1. Local / Dedicated Test Environment Setup            │
  │    (Verify isolated DB, storage bucket, and configs)   │
  └──────────────────────────┬─────────────────────────────┘
                             │
  ┌──────────────────────────▼─────────────────────────────┐
  │ 2. Smoke Test Execution (1 VU)                         │
  │    (Validate connectivity, authentication, and routing)│
  └──────────────────────────┬─────────────────────────────┘
                             │
  ┌──────────────────────────▼─────────────────────────────┐
  │ 3. Baseline Performance Measurement (1–5 VUs)          │
  │    (Record initial uncontended latency benchmarks)     │
  └──────────────────────────┬─────────────────────────────┘
                             │
  ┌──────────────────────────▼─────────────────────────────┐
  │ 4. Progressive Load Testing (10 ──► 25 ──► 50 VUs)     │
  │    (Simulate expected daily and peak operational load) │
  └──────────────────────────┬─────────────────────────────┘
                             │
  ┌──────────────────────────▼─────────────────────────────┐
  │ 5. Stress, Spike, and Soak Test Execution              │
  │    (Identify breaking points, recovery, and leaks)     │
  └──────────────────────────┬─────────────────────────────┘
                             │
  ┌──────────────────────────▼─────────────────────────────┐
  │ 6. Component Worker Tests (OCR & Sheet Sync Isolation) │
  │    (Direct benchmarking of background services)        │
  └──────────────────────────┬─────────────────────────────┘
                             │
  ┌──────────────────────────▼─────────────────────────────┐
  │ 7. Controlled Staging Verification                     │
  │    (Realistic multi-persona workflow simulation)       │
  └──────────────────────────┬─────────────────────────────┘
                             │
  ┌──────────────────────────▼─────────────────────────────┐
  │ 8. Analyze, Optimize, and Retest                       │
  │    (Profile bottlenecks, tune queries, re-verify)      │
  └────────────────────────────────────────────────────────┘
```
