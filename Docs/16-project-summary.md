# EmlynkWABot — Technical Project Summary

## 1. Project Overview

EmlynkWABot is an automated document processing, identity reconciliation, and verification system designed for visa and immigration workflow automation. It ingests document submissions from clients via WhatsApp, securely processes them through an asynchronous pipeline, performs optical character recognition (OCR) and classification, validates client identity against records, securely archives files into private cloud storage, and provides an administrative management console with role-based access control and an audit trail.

### Main Purpose
- Ingest client documents (international passports, police clearance slips, police clearance reports, and medical clearance certificates) over WhatsApp messaging.
- Decouple webhook ingestion from compute-heavy processing to ensure WhatsApp/Meta webhooks receive prompt acknowledgements (< 1s) regardless of OCR latency.
- Extract structured metadata using OCR (Tesseract.js) and Machine Readable Zone (MRZ) parsing.
- Automatically associate submissions with existing registered clients by matching passport numbers or sender phone numbers.
- Calculate deterministic document confidence scores and classify files into confidence bands.
- Enforce duplicate detection using SHA-256 cryptographic hashes.
- Route low-confidence, ambiguous, unclassified, or conflict documents into a Review Queue for human administrator decision-making.
- Track a 21-day legal countdown for police clearance reports triggered by submitted police slips.
- Provide a secure, real-time React-based administrative console with role-based access control (RBAC), dark mode support, and an immutable audit log.

### High-Level Workflow
```
WhatsApp Client 
      │ (Document / Image)
      ▼
Meta Graph API (Cloud API)
      │ Webhook HTTP POST (HMAC-SHA256 Signed)
      ▼
Express Backend (/whatsapp/webhook)
      │ 1. Verify HMAC Signature
      │ 2. Validate MIME & Magic Bytes
      │ 3. Check Message Idempotency
      │ 4. Fetch Media URL & Download Binary
      │ 5. Upload to Supabase temporary/
      │ 6. Commit temporary_data row (status: TEMPORARY_STORED)
      ▼ (HTTP 200 OK to Meta)
Asynchronous Background Worker (submissionQueue.js)
      │ 1. Lease Claim (Compare-and-Swap lock)
      │ 2. Image Preprocessing & OCR (Tesseract.js)
      │ 3. Document Classification & MRZ Extraction
      │ 4. Identity Lookup & Field Reconciliation
      │ 5. Confidence Calculation & Review Decision
      │ 6. Placement Resolution (client_folders/ vs pending/)
      │ 7. SHA-256 Duplicate Check & Database Commit
      ▼
Supabase Private Storage Bucket + PostgreSQL Database
      │
      ▼
Admin Dashboard (/admin)
      │ Role-Based Operations (ADMIN, REVIEWER, VIEWER)
      │ Review Queue Actions (Approve, Keep Pending, Remove, Retry, Replace, Re-type, Assign)
      ▼
Immutable Audit Log (audit_logs table with database trigger)
```

---

## 2. Technology Stack

### Backend
- **Runtime Environment:** Node.js (`^22.18.0 || >=23.6.0`, ES Modules)
- **Web Framework:** Express `5.2.1`
- **Security & Headers:** Helmet `8.3.0`, Cookie-Parser `1.4.7`
- **Rate Limiting:** Express-Rate-Limit `8.7.0`
- **Authentication:** JSON Web Tokens (`jsonwebtoken` `9.0.3`), Password hashing (`bcrypt` `6.0.0`)
- **Document & PDF Parsing:** `pdf-parse` `2.4.5`
- **Image Manipulation & Canvas:** `@napi-rs/canvas` `0.1.80`, `pngjs` `7.0.0`, `jpeg-js` `0.4.4`
- **Environment Management:** `dotenv` `18.0.1`

### Database & ORM
- **Database Engine:** PostgreSQL 16 (hosted on Supabase or local Docker)
- **Database Client / Driver:** `pg` `8.23.0`, `@prisma/adapter-pg` `6.19.3`
- **ORM / Schema Tooling:** Prisma `6.19.3`

### Cloud Storage
- **Object Storage:** Supabase Storage (Private S3-compatible bucket via `@supabase/supabase-js` `2.117.1`)

### WhatsApp & External APIs
- **Messaging Provider:** Meta WhatsApp Cloud API (`v21.0`)
- **Webhook Security:** HMAC-SHA256 signature verification over raw request payloads

### Optical Character Recognition (OCR)
- **OCR Engine:** `tesseract.js` `7.0.0`
- **Training Data:** English traineddata (`eng.traineddata` packaged locally)
- **MRZ Parser:** Custom ICAO 9303 Type-3 parser with composite check digit validation

### Admin Frontend
- **Framework:** React `19.3.0` + React DOM `19.3.0`
- **Routing:** React Router `8.4.0`
- **Build Tool / Bundler:** Vite `8.3.1`
- **Styling:** Vanilla CSS design tokens with TailwindCSS `4.3.3` utilities
- **Icons & Typography:** `@material-symbols/svg-400` `0.47.5`, `@fontsource-variable/inter` `5.3.0`

### Testing & Quality Assurance
- **Backend Test Runner:** Node.js native test runner (`node:test`, `node:assert/strict`)
- **Frontend Test Runner:** Vitest `5.0.2` with JSDOM `30.1.1`
- **Component Testing:** `@testing-library/react` `16.3.3`, `@testing-library/user-event` `14.6.7`, `@testing-library/jest-dom` `7.0.1`
- **TypeScript:** `typescript` `7.0.2` (`tsc --noEmit`)

---

## 3. System Architecture

The system follows a decoupled, resilient architecture designed to maintain high availability under WhatsApp message bursts and slow OCR jobs:

```mermaid
graph TB
    subgraph External["External Clients & APIs"]
        WAC[WhatsApp Mobile Client]
        META[Meta WhatsApp Cloud API]
    end

    subgraph Ingestion["Ingestion Tier (Fast Webhook)"]
        EXPR[Express 5 Server :3000]
        HMAC[HMAC SHA-256 Verifier]
        VAL[MIME & Magic Byte Validator]
        IDEM[In-Memory Message Idempotency Cache]
    end

    subgraph Storage["Storage & Persistence Tier"]
        SUPA_ST[Supabase Storage Private Bucket]
        PG_DB[(PostgreSQL Database)]
    end

    subgraph Worker["Asynchronous Worker Tier"]
        QUEUE[Submission Queue / Lease Manager]
        OCR[Tesseract.js OCR Engine]
        CLASS[Document Classification Service]
        IDENT[Identity Verification Service]
        RECON[Field Reconciliation Service]
        PLACE[Storage Placement & Recovery]
    end

    subgraph AdminConsole["Administrative Management Console"]
        VITE_SPA[Admin SPA /admin React 19]
        API_ADM[Admin API /api/admin/*]
        RBAC[RBAC Middleware: ADMIN, REVIEWER, VIEWER]
        COOKIE[HttpOnly Strict Session Cookie]
    end

    WAC -->|Send Document| META
    META -->|POST /whatsapp/webhook| EXPR
    EXPR --> HMAC
    HMAC --> IDEM
    IDEM --> VAL
    VAL -->|Save Raw Buffer| SUPA_ST
    VAL -->|Insert TEMPORARY_STORED| PG_DB
    EXPR -->|HTTP 200 OK| META

    PG_DB -.->|Compare-and-Swap Claim| QUEUE
    QUEUE --> OCR
    OCR --> CLASS
    CLASS --> IDENT
    IDENT --> RECON
    RECON --> PLACE
    PLACE -->|Move / Copy File| SUPA_ST
    PLACE -->|Update temporary_data & Insert Document| PG_DB

    VITE_SPA -->|Credentials: Include| COOKIE
    COOKIE --> RBAC
    RBAC --> API_ADM
    API_ADM --> PG_DB
    API_ADM -->|Stream File Previews| SUPA_ST
```

### Communication Flow
1. **Webhook Ingestion:** Meta posts incoming WhatsApp events to `POST /whatsapp/webhook`. The server verifies signatures against `META_APP_SECRET`, deduplicates message IDs, downloads the media binary, verifies file safety, streams the file to `temporary/` in the private bucket, commits a record into `temporary_data`, and returns 200 OK within milliseconds.
2. **Asynchronous Background Processing:** An in-process background worker (`src/services/submissionQueue.js`) leases pending submissions using atomic compare-and-swap database locks, runs OCR, extracts MRZ lines, classifies document type, reconciles client data, checks for duplicate hashes, and places files into permanent client folders (`client_folders/{unique_id}/`) or review folders (`pending/`).
3. **Admin Operations:** Administrators interact with the single-page application served under `/admin`. All requests go through `SameSite=Strict`, `HttpOnly` cookie authentication and `requireRole` middleware. Audit logs are written on every administrative review action.

---

## 4. Backend Structure

The backend source code is organized under `src/`:

```
src/
├── app.js                     # Application entry point, runtime checks, worker bootstrap
├── createApp.js               # Express application factory, middleware, security headers
├── adminFrontend.js           # Static SPA server for built admin assets (/admin)
├── shutdown.js                # Coordinated graceful shutdown handler
├── config/
│   ├── env.js                 # Strict environment variable validation
│   ├── prisma.js              # Shared PrismaClient database connection instance
│   ├── requiredDocuments.js   # Configuration of mandatory client document types
│   ├── runtime.js             # Node version and prerequisite verification
│   └── supabase.js            # Supabase Storage client configuration
├── middleware/
│   ├── auth.js                # Admin JWT extraction (cookie first, Bearer fallback)
│   ├── errorHandler.js        # Centralized error handler; hides internal error stacks
│   ├── loginRateLimiter.js    # IP-based rate limiting for /auth/login
│   ├── requireActiveAdmin.js  # Verifies administrator status is ACTIVE in PostgreSQL
│   ├── requireRole.js         # RBAC middleware (ADMIN, REVIEWER, VIEWER)
│   └── verifyWhatsAppSignature.js # Raw-payload HMAC-SHA256 signature verification
├── routes/
│   ├── admin.js               # Admin dashboard API routes (/api/admin/*)
│   ├── auth.js                # Authentication endpoints (/auth/login, /auth/me, /auth/logout)
│   └── whatsapp.js            # Webhook verification and message ingestion routes
├── services/                  # Core domain logic and business operations
└── utils/                     # Pure helpers, cryptographics, checksums, formatters
```

### Key Modules & Responsibilities

- **`src/app.js` & `src/createApp.js`:**
  - Enforces startup checks (`assertValidRuntime`, `assertValidEnv`).
  - Sets security headers via Helmet (disables X-Powered-By, configures CSP with blob: support for file previews).
  - Mounts cookie parser and JSON body parsers with raw body retention for HMAC verification.
  - Spawns the background queue worker and registers SIGTERM/SIGINT shutdown traps.
- **`src/shutdown.js`:**
  - Manages coordinated process termination within an 8-second deadline (fitting Docker's 10-second default timeout).
  - Stops HTTP ingestion, pauses worker leasing, waits for active jobs or releases their leases, disconnects Prisma, and exits cleanly.
- **`src/middleware/requireRole.js` & `src/middleware/auth.js`:**
  - Implements role-based access control checking `req.admin.role`.
  - Supports authentication via `emlynk_admin_token` cookie or Bearer token header.
  - Returns safe 403 `{"message": "Insufficient permissions"}` without exposing internal details.
- **`src/routes/whatsapp.js`:**
  - Implements `GET /whatsapp/webhook` for Meta verification challenge handshake.
  - Implements `POST /whatsapp/webhook` with signature verification, deduplication, binary download, and temporary submission queuing.
- **`src/services/submissionQueue.js`:**
  - The durable background worker. Employs compare-and-swap database queries to acquire a 10-minute lease on `TEMPORARY_STORED` rows.
  - Limits concurrent OCR jobs to prevent CPU starvation.
  - Handles lease expiry, crashes, and automatic recovery of orphaned jobs.
- **`src/services/documentProcessingService.js`:**
  - Orchestrates the full document processing pipeline: OCR, text extraction, classification, identity resolution, field reconciliation, checksumming, placement decision, and temporary record updating.
- **`src/services/ocrService.js`:**
  - Executes Tesseract OCR across images and converted PDFs.
  - Handles auto-rotation (0°, 90°, 180°, 270°), adaptive thresholding, and image upscaling for low-resolution files.
- **`src/services/documentClassificationService.js`:**
  - Keyword and structure analysis classifying files into `PASSPORT`, `POLICE_SLIP`, `POLICE_REPORT`, `MEDICAL`, or `UNKNOWN`.
- **`src/services/storagePlacementService.js` & `src/services/placementRecovery.js`:**
  - Manages atomic movement of files from `temporary/` to permanent client folders (`client_folders/{unique_id}/`) or review staging (`pending/`).
  - Implements crash recovery to detect if a file was already placed before a server crash.
- **`src/services/policeCountdownService.js` & `src/services/adminPoliceService.js`:**
  - Calculates the 21-day police report countdown based on police slip submission dates.
  - Categorizes statuses: `OVERDUE`, `DUE_TODAY`, `DUE_SOON`, `PENDING`, `DATE_MISSING`, `NOT_UPLOADED`, `COMPLETED`.
- **`src/services/adminReviewActionService.js`:**
  - Executes audited review queue operations: Approve, Keep Pending, Remove from Review, Retry Processing, Replace Verified Document, Keep as Version, Set Document Type, Assign Client, and Set Police Date.

---

## 5. API / Routes

### Authentication Routes (`/auth`)

| Method | Path | Purpose | Authentication | Role Required |
|---|---|---|---|---|
| POST | `/auth/login` | Authenticate admin; sets HttpOnly cookie | None (Rate Limited) | Any ACTIVE admin |
| GET | `/auth/me` | Fetch authenticated admin profile | Cookie or Bearer | Any ACTIVE admin |
| POST | `/auth/logout` | Clear session cookie server-side | Cookie or Bearer | Any ACTIVE admin |

### WhatsApp Webhook Routes (`/whatsapp`)

| Method | Path | Purpose | Authentication |
|---|---|---|---|
| GET | `/whatsapp/webhook` | Meta verification challenge handshake | Hub verify token validation |
| POST | `/whatsapp/webhook` | Ingest incoming document messages | HMAC-SHA256 signature verification |

### Admin Dashboard API Routes (`/api/admin`)

| Method | Path | Purpose | Role Required |
|---|---|---|---|
| GET | `/api/admin/overview` | Overall system KPIs, status breakdowns, review summary | `ADMIN`, `REVIEWER`, `VIEWER` |
| GET | `/api/admin/documents` | List stored client documents with filters, sorting, paging | `ADMIN`, `REVIEWER`, `VIEWER` |
| GET | `/api/admin/documents/:documentId` | Retrieve single document metadata | `ADMIN`, `REVIEWER`, `VIEWER` |
| GET | `/api/admin/documents/missing` | Clients missing required documents | `ADMIN`, `REVIEWER`, `VIEWER` |
| POST | `/api/admin/documents/:documentId/police-date` | Correct stored police slip submitted date | `ADMIN` only |
| GET | `/api/admin/clients` | Clients directory with search and completion filters | `ADMIN`, `REVIEWER`, `VIEWER` |
| GET | `/api/admin/clients/:passportId` | Detailed client record, documents, countdown, audit history | `ADMIN`, `REVIEWER`, `VIEWER` |
| GET | `/api/admin/review` | List items waiting in Review Queue | `ADMIN`, `REVIEWER`, `VIEWER` |
| GET | `/api/admin/review/:reviewId` | Single review item details with processing summary | `ADMIN`, `REVIEWER`, `VIEWER` |
| GET | `/api/admin/review/:reviewId/file` | Secure sandboxed file preview stream | `ADMIN`, `REVIEWER`, `VIEWER` |
| POST | `/api/admin/review/:reviewId/approve` | Approve item and promote to client folder | `ADMIN`, `REVIEWER` |
| POST | `/api/admin/review/:reviewId/keep-pending` | Retain item in review queue with explanation reason | `ADMIN`, `REVIEWER` |
| POST | `/api/admin/review/:reviewId/remove` | Permanently purge rejected file and temporary record | `ADMIN`, `REVIEWER` |
| POST | `/api/admin/review/:reviewId/retry` | Re-queue failed submission for worker processing | `ADMIN`, `REVIEWER` |
| POST | `/api/admin/review/:reviewId/replace-verified`| Replace existing verified document of same type | `ADMIN`, `REVIEWER` |
| POST | `/api/admin/review/:reviewId/keep-as-version` | Retain document alongside existing verified document | `ADMIN`, `REVIEWER` |
| POST | `/api/admin/review/:reviewId/document-type` | Correct misclassified document type | `ADMIN`, `REVIEWER` |
| POST | `/api/admin/review/:reviewId/assign-client` | Associate unassigned submission with valid client | `ADMIN`, `REVIEWER` |
| GET | `/api/admin/police` | Police workflow status table and urgency sorting | `ADMIN`, `REVIEWER`, `VIEWER` |
| GET | `/api/admin/reports/daily` | Business-day figures (00:00–24:00 Asia/Colombo) | `ADMIN`, `REVIEWER`, `VIEWER` |

---

## 6. Database

The database uses PostgreSQL with Prisma ORM.

```mermaid
erDiagram
    Admin ||--o{ AuditLog : performs
    User ||--o{ Document : owns
    User ||--o{ TemporaryData : submits
    TemporaryData ||--o{ Document : creates

    Admin {
        string admin_id PK
        string name
        string email UK
        string password_hash
        string role
        string status
        datetime created_date
        datetime updated_date
    }

    AuditLog {
        string audit_id PK
        string admin_id FK
        string action
        string temporary_id
        string document_id
        string passport_id
        string previous_status
        string new_status
        string reason
        date police_submitted_date
        string document_type
        string file_sha256
        string previous_value
        string new_value
        datetime created_date
    }

    User {
        string passport_id PK
        string unique_id UK
        string first_name
        string other_name
        date date_of_birth
        string place_of_birth
        date passport_expiry_date
        string picture
        string whatsapp_number
        string contact_number
        string address
        string job
        datetime created_date
        datetime updated_date
    }

    Document {
        string document_id PK
        string passport_id FK
        string document_type
        string original_filename
        string stored_filename
        string storage_path
        string mime_type
        bigint file_size
        datetime received_date
        string processing_status
        string verification_status
        decimal ocr_confidence
        string file_sha256
        string temporary_id FK
        date police_submitted_date
        datetime created_date
        datetime updated_date
    }

    TemporaryData {
        string temporary_id PK
        string passport_id FK
        string unique_id
        string whatsapp_number
        string document_type
        string temporary_storage_path
        string processing_status
        string file_sha256
        string pending_storage_path
        json processing_summary
        string review_reason
        string message_id UK
        string original_filename
        datetime received_at
        int processing_attempts
        datetime processing_started_at
        string placement_path
        datetime created_date
    }
```

### Models & Flow

1. **`Admin` (`admins`):**
   - Stores back-office staff accounts.
   - Key attributes: `role` (`ADMIN`, `REVIEWER`, `VIEWER`), `status` (`ACTIVE`, `INACTIVE`), `passwordHash` (bcrypt).
2. **`User` (`users`):**
   - Registered client records.
   - Primary key is `passportId`; alternate unique identifier is `uniqueId` (4-digit string, e.g. `0001`).
   - Fields such as `whatsappNumber`, `dateOfBirth`, `placeOfBirth`, and `passportExpiryDate` are verified or enriched by the passport processing pipeline.
3. **`TemporaryData` (`temporary_data`):**
   - Acts as both the intake record and the durable background job queue.
   - Stores incoming WhatsApp message metadata (`messageId`, `whatsappNumber`), the raw object path (`temporaryStoragePath`), worker lease parameters (`processingAttempts`, `processingStartedAt`), and post-processing diagnosis (`processingSummary`, `reviewReason`).
4. **`Document` (`documents`):**
   - Permanent archive of client documents stored in `client_folders/{unique_id}/`.
   - Enforces uniqueness per client on `@@unique([passportId, fileSha256])` to prevent duplicate files.
   - Tracks `verificationStatus` (`VERIFIED`, `REVIEW_REQUIRED`, `SUPERSEDED`).
5. **`AuditLog` (`audit_logs`):**
   - Append-only audit trail protected by database triggers against updates and deletions.
   - Records every administrative action with `adminId`, before/after statuses, justification `reason`, and changed values.

---

## 7. Document Processing Pipeline

The lifecycle of an incoming document proceeds through sixteen deterministic stages:

```
[1. WhatsApp Message Reception]
           │ HTTP POST payload from Meta
[2. Signature Verification]
           │ Verify HMAC-SHA256 signature using META_APP_SECRET
[3. Metadata Extraction]
           │ Extract mediaId, MIME type, sender phone number, message timestamp
[4. Media URL Retrieval]
           │ Query Meta Graph API for temporary download URL
[5. Binary Download]
           │ Stream binary payload into memory buffer
[6. MIME/File Validation]
           │ Check allowed extensions (.pdf, .jpg, .jpeg, .png) & magic byte headers
[7. Idempotency Check]
           │ In-memory LRU cache + DB unique constraint on message_id
[8. Temporary Submission]
           │ Upload to temporary/{uuid}.ext in Supabase; insert row in temporary_data
           │ Respond HTTP 200 to Meta immediately
[9. Background Worker Queue]
           │ Worker leases row via compare-and-swap (processing_started_at)
[10. Preprocessing & OCR]
           │ PDF rendering / image rotation / thresholding / Tesseract text extraction
[11. Classification]
           │ Keyword & structure scoring (PASSPORT, POLICE_SLIP, POLICE_REPORT, MEDICAL)
[12. Identity Resolution]
           │ Match extracted passport ID or sender phone against users table
[13. Field Reconciliation]
           │ Compare OCR fields with client records; update blank fields if verified
[14. Placement & Storage]
           │ Check duplicate SHA-256; copy file to client_folders/ or pending/
[15. Status Assignment]
           │ Compute final status: VERIFIED, HIGH_CONFIDENCE, UNCLEAR, MANUAL_REVIEW, CONFLICT
[16. Admin Review & Audit]
           │ If flagged, item enters Review Queue; admin decisions logged to audit_logs
```

### Document Status Definitions

- **`TEMPORARY_STORED`:** The initial intake state. Document binary resides in `temporary/`; waiting for background worker processing.
- **`PROCESSING`:** Worker has claimed the row lease and is actively executing OCR, classification, and placement.
- **`VERIFIED`:** Document passed all quality checks (confidence >= 85), type resolved unambiguously, identity verified, placed in `client_folders/` as `VERIFIED`.
- **`HIGH_CONFIDENCE`:** Confidence score between 70 and 84; valid identity match; stored in `client_folders/` as `VERIFIED`.
- **`SLIGHTLY_UNCLEAR`:** Confidence score between 55 and 69; identity confirmed; stored in `client_folders/` as `VERIFIED`.
- **`UNCLEAR`:** Low OCR confidence (40–54) or low-quality passport image; stored in `client_folders/` but flagged as `REVIEW_REQUIRED`.
- **`UNDEFINED`:** Confidence score below 40 or unclassifiable; retained in `pending/` and listed in Review Queue.
- **`MANUAL_REVIEW`:** Document blocked by an explicit review flag (e.g. wrong document suspected, police slip awaiting submitted date); stored in `pending/`.
- **`CONFLICT`:** Identity mismatch (e.g., passport number belongs to client A, phone belongs to client B); stored in `pending/`.
- **`DUPLICATE`:** An identical file (matching SHA-256) already exists for this client; second upload discarded.
- **`SUPERSEDED`:** An existing verified document that was replaced by a newer version through an admin `REPLACE_VERIFIED` action.
- **`FAILED`:** Processing repeatedly failed (exceeded `maxAttempts = 3`); requires admin retry or file re-upload.

---

## 8. OCR & Document Intelligence

- **Supported Document Formats:** Portable Document Format (`application/pdf`), JPEG (`image/jpeg`), PNG (`image/png`).
- **Engine Execution:** Tesseract.js running locally with pre-cached English trained data (`eng.traineddata`).
- **PDF Extraction Strategy:** Evaluates text streams using `pdf-parse`. If text is insufficient or absent (scanned PDF), renders pages to high-resolution raster images via `@napi-rs/canvas` and feeds them into Tesseract.
- **Adaptive Image Preprocessing:**
  - **Auto-Rotation:** Tests page orientations at 0°, 90°, 180°, and 270° using OCR orientation diagnostics to align inverted or sideways documents.
  - **Upscaling:** Images with dimensions below OCR thresholds are proportionally upscaled using bilinear interpolation.
  - **Thresholding:** High-contrast binarization applied to wash out background noise and watermarks.
- **MRZ Parser:** Identifies 2-line ICAO 9303 Machine Readable Zones on passports. Calculates and validates check digits for document number, date of birth, and expiration date.
- **Classification Engine:** Evaluates keyword density, layout characteristics, document headers, and MRZ presence to assign a classification confidence score:
  - Minimum text threshold: documents with fewer than 10 detected words are flagged as unreadable.
- **Limitations:**
  - Handwriting recognition is limited; handwritten police slip receipt notes require manual admin confirmation.
  - Skewed, curved, or heavily folded mobile photos may fail MRZ validation and trigger `MANUAL_REVIEW`.

---

## 9. Storage Architecture

- **Supabase Storage Configuration:** Uses a single **private** bucket (`SUPABASE_BUCKET`). Public access, public URLs, and directory listing are permanently disabled.
- **Directory Hierarchy:**
  - `temporary/{uuid}.{ext}`: Ingested files awaiting worker processing. Automatically cleaned up after promotion or failure.
  - `client_folders/{unique_id}/{stored_filename}`: Permanently archived verified files organized by client `unique_id` (e.g. `client_folders/0001/passport.pdf`).
  - `pending/{unique_id}/{temporary_id}/{stored_filename}`: Staged files awaiting administrative review.
  - `pending/unidentified/{temporary_id}/{stored_filename}`: Submissions whose client could not be identified.
- **Cryptographic File Integrity:**
  - SHA-256 hash computed immediately on buffer intake.
  - Hash stored in `Document.fileSha256` and `TemporaryData.fileSha256`.
  - Database constraint `@@unique([passportId, fileSha256])` prevents identical duplicate uploads under the same client.
- **Storage Placement & Crash Recovery (`placementRecovery.js`):**
  - Before initiating a storage copy, the worker records `placement_path` in `temporary_data`.
  - If a worker crashes mid-copy, subsequent retry attempts detect the existing file at `placement_path` and verify its checksum, preventing redundant copies.
- **Storage Timeout Protection:**
  - All Supabase operations wrapped in `withStorageTimeout` with a 60-second cutoff to prevent hanging network connections from consuming worker leases.
- **Secure File Access:**
  - The dashboard never receives direct storage URLs or access keys.
  - File viewing (`GET /api/admin/review/:id/file`) streams the binary through Express with restrictive headers:
    `Content-Security-Policy: default-src 'none'; img-src 'self' data:; sandbox`

---

## 10. Security

### Implemented Protections
- **Authentication:** Signed JSON Web Tokens (`HS256`, 1-hour expiry). Transported via secure `httpOnly` cookies with `SameSite=Strict`.
- **RBAC Authorization:** Strict role enforcement on all admin routes via `requireRole` middleware (`ADMIN`, `REVIEWER`, `VIEWER`).
- **CSRF Defense:** `SameSite=Strict` cookie policy ensures cookies are not sent during cross-site requests. Authenticated `POST /auth/logout` endpoint clears sessions server-side.
- **Legacy Fallback:** Server continues to accept `Authorization: Bearer <token>` headers for CLI commands, testing scripts, and administrative automation.
- **Account Protection:** Passwords hashed with `bcrypt` (work factor 10). Failed login attempts rate-limited per IP. Dummy hash timing equalization prevents user enumeration.
- **Active Admin Verification:** On every request, `requireActiveAdmin` verifies `Admin.status === 'ACTIVE'` directly in PostgreSQL. Deactivated admins are immediately rejected with HTTP 401.
- **Webhook Security:** Webhook payloads validated against Meta application secret using constant-time HMAC-SHA256 comparison (`verifyWhatsAppSignature.js`).
- **Input & File Sanitization:** Rejects executable magic bytes (e.g., ELF, PE, Mach-O). File extensions and MIME types restricted to PDF, JPEG, PNG. File sizes capped at 16 MB.
- **Log Sanitization:** Sensitive PII (phone numbers, passport IDs, raw file paths, client names, raw message IDs) is stripped or replaced with one-way SHA-256 hashes (`messageRef`) before logging.
- **Database Immutability:** An SQL trigger rejects `UPDATE` and `DELETE` queries on the `audit_logs` table, guaranteeing an immutable audit trail.
- **Security Headers:** Express app hardened using Helmet with frame-busting, MIME sniffing prevention, and strict CSP policies.

### Security Considerations / Remaining Risks
- **Single Process In-Memory Rate Limiting:** The login rate limiter and message idempotency cache are held in process memory. If scaled across multiple cluster instances without a shared Redis store, rate limits apply per node.
- **Tesseract Process Consumption:** Heavy concurrent OCR processing can cause high CPU utilization; throttled by `MAX_CONCURRENT_OCR_JOBS = 2`.
- **JWT Revocation Delay:** If an active token is compromised, revoking it requires changing `JWT_SECRET` or deactivating the admin record in the database (`status = 'INACTIVE'`).

---

## 11. Admin Dashboard

The Admin Dashboard is a React 19 single-page application built with Vite and served by Express under `/admin`.

### Application Pages
- **Overview (`/admin`):** High-level operational dashboard displaying KPI summary cards (Total Clients, Total Documents, Pending Review, Received Today), document status breakdown charts, document type distribution, recent uploads, police report countdown status, and client completeness metrics.
- **Documents (`/admin/documents`):** Filterable, searchable table of all stored client documents with verification badges, OCR confidence indicators, and sorting controls.
- **Review Queue (`/admin/review`):** Dedicated inbox of items requiring human attention, grouped by category cards (Identity, Quality, Conflict, Other) and review kinds (`PENDING`, `DOCUMENT`, `FAILED`).
- **Review Detail (`/admin/review/:id`):** Deep inspection interface offering split-pane document preview (sandboxed PDF/image), side-by-side extracted metadata, client matching selector, and review action controls.
- **Clients (`/admin/clients`):** Directory of client profiles displaying passport IDs, unique IDs, contact details, completion badges, and requirement chips.
- **Client Details (`/admin/clients/:passportId`):** Profile view displaying verified documents, pending submissions, requirement checklist, police countdown status, and police slip date correction history.
- **Police Workflow (`/admin/police`):** Dedicated tracking console showing countdown statuses for police clearance reports, sorted by urgency (Overdue, Due Today, Due Soon).
- **Missing Documents (`/admin/documents/missing`):** Exception report highlighting incomplete clients and filtering by missing required document types.
- **Daily Report (`/admin/reports/daily`):** Formal business-day audit summary (00:00–24:00 Asia/Colombo) itemizing documents received, processing outcomes, breakdowns by type, and audit actions taken.

### Core Reusable Components
- **`AdminLayout`:** Responsive application shell featuring a collapsible sidebar, navigation links, and sticky header.
- **`AuthProvider` & `RequireAuth`:** Context provider managing authentication state, cookie-based session verification via `GET /auth/me`, and route interception.
- **`ApiClient`:** Typed Fetch wrapper enforcing `credentials: "include"` and standard error handling.
- **`ThemeToggle`:** Dark mode / light mode toggle adhering to WCAG AA contrast standards.
- **`SyncProvider`:** Synchronous data refresh bus allowing users to reload page data on demand without full browser refreshes.

---

## 12. Admin Roles & Permissions

The system implements Role-Based Access Control (RBAC) across three distinct tiers:

| Action / Resource | ADMIN | REVIEWER | VIEWER |
|---|:---:|:---:|:---:|
| View Overview KPIs & Reports | Yes | Yes | Yes |
| View Stored Documents & Clients | Yes | Yes | Yes |
| View Review Queue & File Previews | Yes | Yes | Yes |
| View Police Workflow Statuses | Yes | Yes | Yes |
| View Daily Audit Reports | Yes | Yes | Yes |
| Review Action: Approve Submission | Yes | Yes | No |
| Review Action: Keep Pending | Yes | Yes | No |
| Review Action: Remove from Review | Yes | Yes | No |
| Review Action: Retry Failed Job | Yes | Yes | No |
| Review Action: Replace Verified Document | Yes | Yes | No |
| Review Action: Keep Document as Version | Yes | Yes | No |
| Review Action: Re-classify Document Type | Yes | Yes | No |
| Review Action: Assign Client Identity | Yes | Yes | No |
| Document Correction: Set/Edit Police Date | Yes | No | No |
| Create Admin Accounts (CLI) | Yes | No | No |

---

## 13. Review & Audit System

### Review Queue Actions
- **Approve:** Promotes a pending file from `pending/` to `client_folders/{unique_id}/` as `VERIFIED`. For police slips, sets the verified submission date.
- **Keep Pending:** Leaves the document in `pending/` with an updated administrative note.
- **Remove from Review:** Permanently purges the waiting file from storage and deletes the `temporary_data` record.
- **Retry Failed Processing:** Clears failure flags on a `FAILED` submission and re-queues it for background worker processing.
- **Replace Verified Document (M4 Policy B):** Promotes a waiting document to `VERIFIED` and marks an existing verified document of the same type as `SUPERSEDED`.
- **Keep as Version (M4 Policy B):** Stores the new document in the client folder as `REVIEW_REQUIRED` alongside the existing verified document.
- **Set Document Type:** Corrects an incorrect OCR classification (e.g. changing `UNKNOWN` to `POLICE_SLIP`).
- **Assign Client:** Resolves an identity conflict or unidentified submission by linking it to a verified registered client.
- **Set Police Date:** Corrects or enters the submission date on an already stored police slip.

### Audit Trail
Every review action and correction writes an entry to `audit_logs` recording:
- `auditId`: UUID primary key.
- `adminId`: Administrator who performed the action.
- `action`: Specific operation code (`APPROVE`, `REMOVE_FROM_REVIEW`, etc.).
- `previousStatus` & `newStatus`: State transition.
- `reason`: Mandatory text justification provided by the administrator.
- `previousValue` & `newValue`: Specific before/after values for corrections.
- `createdDate`: Exact timestamp of action.

---

## 14. Police Report Workflow

The police workflow monitors the 21-calendar-day countdown between the submission of a Police Clearance Certificate Application (Police Slip) and the issuance of the Final Police Clearance Report:

- **Trigger:** A verified police slip with a valid `policeSubmittedDate`.
- **Due Date:** Exactly 21 days after the slip's submitted date:
  $$\text{DueDate} = \text{PoliceSubmittedDate} + 21 \text{ days}$$
- **Days Remaining:** Calculated against current Sri Lanka business date (Asia/Colombo).
- **Workflow Statuses:**
  - `OVERDUE`: Due date has passed ($\text{DaysRemaining} < 0$).
  - `DUE_TODAY`: Exactly 0 days remaining ($\text{DaysRemaining} = 0$).
  - `DUE_SOON`: Between 1 and 7 days remaining ($1 \le \text{DaysRemaining} \le 7$).
  - `PENDING`: More than 7 days remaining ($\text{DaysRemaining} > 7$).
  - `DATE_MISSING`: Police slip stored or awaiting approval, but submitted date could not be determined.
  - `NOT_UPLOADED`: Client has no police slip or police report on record.
  - `COMPLETED`: A verified Police Report (`POLICE_REPORT`) exists for this client, completing the requirement and suppressing further countdown warnings regardless of arrival order.

---

## 15. Reliability & Failure Handling

- **Webhook Response Guarantee:** The HTTP webhook never waits for OCR or classification. Submissions are persisted to `temporary_data` before Meta receives the HTTP 200 response, eliminating webhook timeout drops.
- **At-Least-Once Delivery & Deduplication:** Meta retries unacknowledged webhooks. Deduplication occurs in memory (LRU cache) and at the database layer via unique constraints on `message_id`.
- **Worker Lease System:** Workers acquire jobs using conditional compare-and-swap SQL updates:
  `UPDATE temporary_data SET processing_attempts = attempts + 1, processing_started_at = NOW() WHERE temporary_id = id AND processing_status = 'TEMPORARY_STORED' AND (processing_started_at IS NULL OR processing_started_at < cutoff)`
- **Crash Recovery & Orphan Handling:** If a worker node crashes mid-job, the lease expires after 10 minutes. A surviving worker claims the job, detects existing placement copies via `placementPath`, and resumes without duplicating files.
- **Fenced Database Transactions:** All database state transitions (updating client fields, inserting document records, and updating submission queue state) execute inside atomic database transactions (`$transaction`).
- **Bounded Retries:** Failed submissions are retried up to 3 times before transitioning to `FAILED`, preventing poison messages from looping indefinitely.
- **Graceful Shutdown:** On SIGTERM/SIGINT, Express stops accepting new connections, active webhook downloads finish, the queue worker pauses new claims and allows in-flight jobs up to 6 seconds to complete, Prisma disconnects cleanly, and the process terminates.

---

## 16. Configuration / Environment Variables

The server inspects all variables at startup (`src/config/env.js`) and refuses to start if any required setting is missing or malformed:

| Variable | Purpose | Required | Example / Notes |
|---|---|:---:|---|
| `DATABASE_URL` | PostgreSQL connection string | Yes | `postgresql://user:pass@host:5432/dbname` |
| `SUPABASE_URL` | Supabase project URL | Yes | `https://xyzcompany.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role secret key | Yes | Backend only; never expose in frontend |
| `SUPABASE_BUCKET` | Private storage bucket name | Yes | e.g. `emlynk-documents` |
| `JWT_SECRET` | Secret key for signing admin JWTs | Yes | Min 32 chars (e.g. random base64 string) |
| `META_APP_SECRET` | Meta Application Secret for webhook HMAC | Yes | Obtained from Meta App Dashboard |
| `WHATSAPP_VERIFY_TOKEN` | Secret token for GET /webhook challenge | Yes | Configured in Meta Webhooks dashboard |
| `WHATSAPP_ACCESS_TOKEN` | Meta Graph API system user token | Yes | Bearer token for downloading media |
| `WHATSAPP_API_VERSION` | Meta Graph API version | Yes | `v21.0` |
| `PORT` | HTTP server listening port | No | Default: `3000` |
| `TRUST_PROXY_HOPS` | Number of trusted reverse proxy hops | No | Integer (e.g. `1`); leave unset if direct |
| `REQUIRED_DOCUMENT_TYPES` | Mandatory client document types | No | Default: `PASSPORT,POLICE_REPORT,MEDICAL` |
| `RUN_OCR_TESTS` | Test flag to execute OCR on real scans | No | `1` to run; otherwise real files skipped |

---

## 17. Development Setup

### Prerequisites
- Node.js version `^22.18.0 || >=23.6.0`
- npm package manager
- Docker and Docker Compose (for local PostgreSQL database)
- Meta WhatsApp Developer account (for live webhook testing)

### Step 1: Clone & Install Dependencies
```bash
# Install backend dependencies
npm install

# Install admin frontend dependencies
npm run admin:install
```

### Step 2: Database / Docker Setup
Start the local PostgreSQL container:
```bash
docker compose up -d
```
*Creates container `emlynk-postgres` on `localhost:5432` with user `emlynk_user`, password `emlynk_password`, database `emlynk_docs`.*

Configure `.env`:
```bash
cp .env.example .env
# Edit .env with local database URL:
# DATABASE_URL="postgresql://emlynk_user:emlynk_password@localhost:5432/emlynk_docs"
```

Apply migrations and generate Prisma client:
```bash
npx prisma migrate dev
```

### Step 3: Seed Initial Administrator
```bash
npm run admin:create -- --email admin@example.com --password "SecurePassword123!" --name "System Administrator" --role ADMIN
```

### Step 4: Run the Application
In development, the backend and frontend can run concurrently:

```bash
# Terminal 1: Start Express Backend (Port 3000)
npm start

# Terminal 2: Start Admin Frontend Dev Server with Vite (Port 5173)
npm run admin:dev
```
*In development mode, Vite proxies `/api` and `/auth` requests to `http://localhost:3000`.*

### Step 5: Production-like Admin Build
To serve the React SPA directly from Express under `http://localhost:3000/admin`:
```bash
# Build the admin frontend distribution
npm run admin:build

# Start the server
npm start
```

### Step 6: WhatsApp Webhook Development with ngrok
To receive real webhook callbacks from Meta on a local machine:
```bash
ngrok http 3000
```
In Meta App Dashboard (WhatsApp > Configuration):
1. **Callback URL:** `https://<your-ngrok-subdomain>.ngrok-free.app/whatsapp/webhook`
2. **Verify Token:** Value matching `WHATSAPP_VERIFY_TOKEN` in `.env`
3. Click **Verify and Save**.
4. Subscribe to the `messages` webhook field.

---

## 18. Testing

The repository maintains an extensive automated regression test suite spanning backend logic, security controls, document pipelines, and frontend interfaces.

| Test Layer | Command | Scope & Tooling | Latest Results |
|---|---|---|:---:|
| **Backend Regression** | `npm test` | `node:test`: Unit, integration, pipeline, security, idempotency, RBAC | **189 suites, 1027 passed (0 failed)** |
| **Real File OCR** | `set RUN_OCR_TESTS=1&& npm test` | Tests OCR extraction across real scanned PDF/image fixtures | Verified passing |
| **Admin Frontend** | `npm run admin:test` | Vitest + JSDOM: Screens, authentication, RBAC guards, dark mode | **6 suites, 126 passed (0 failed)** |
| **Frontend Typecheck** | `npm run admin:typecheck` | `tsc --noEmit -p tsconfig.json` | **0 errors** |
| **Frontend Production Build** | `npm run admin:build` | Vite compilation and asset optimization | **Clean bundle (492ms)** |
| **Live Storage E2E** | `node scripts/e2e-supabase-storage.mjs`| Live verification of private bucket upload, placement, recovery | **Verified passing** |

*Total automated tests passing across the repository: **1,153 tests**.*

---

## 19. Deployment Overview

The target production deployment model centers on a containerized Node.js application deployed to a VPS (e.g. Hostinger, Hetzner, AWS EC2):

- **Server Architecture:** Linux VPS running Docker / Node.js 22 LTS behind an Nginx or Caddy reverse proxy handling TLS termination.
- **Database:** PostgreSQL 16 (hosted on Supabase or dedicated managed PostgreSQL instance). All 11 migrations applied via `npx prisma migrate deploy`.
- **Object Storage:** Private Supabase Storage bucket configured with private access controls.
- **Webhooks:** Ingress via reverse proxy forwarding to Express backend on port 3000 with `TRUST_PROXY_HOPS=1`.
- **Admin Dashboard:** Pre-compiled into `admin/dist` and served statically by Express under `/admin` with HTTP caching and security headers.
- **Process Management:** Docker container managed with restart policy `unless-stopped` and 10-second SIGTERM grace period.

---

## 20. Important Operational Notes

1. **Database Migrations:** Before deploying new application code, database migrations must be applied (`npx prisma migrate deploy`). Migrations must run sequentially.
2. **Strict Environment Checks:** The application crashes intentionally on startup if any required environment variable is missing, empty, or fails validation.
3. **Private Bucket Verification:** The Supabase Storage bucket must remain **private**. Do not enable public read access on `SUPABASE_BUCKET`.
4. **Log Privacy Compliance:** Never introduce raw log statements printing request bodies, query strings, phone numbers, or client names. Use `safeLog.js` utilities.
5. **Worker Single Instance vs Cluster:** The background queue worker runs inside the web process. If clustering across multiple processes or containers, PostgreSQL compare-and-swap queries ensure safe distributed job locking.
6. **Graceful Shutdown:** Always allow containers at least 10 seconds before issuing SIGKILL to ensure active OCR jobs can release their locks cleanly.

---

## 21. Known Limitations / Future Improvements

### Current Limitations
- **Memory-Based Status Calculations:** Client completeness and police countdown figures are calculated in memory across loaded client records. While fast for thousands of clients, scaling to hundreds of thousands will require computing summaries via SQL views.
- **Removed Items Audit Only:** When a document is removed from review, its `temporary_data` row is purged and it leaves only an append-only `audit_logs` record; there is no standalone "Trash / Bin" recovery screen.
- **Handwritten Police Slips:** Handwritten dates on informal police receipts frequently fail OCR detection and require manual admin date entry during approval.

### Planned Future Improvements
- **Admin Invitation System:** Self-service administrative invitations via email token (Phase 12, Checkpoint 2).
- **Automated Client Notifications:** Outbound WhatsApp notifications informing clients when documents are verified or need re-submission.
- **Historical Snapshots:** Scheduled daily snapshot jobs archiving completeness history for long-term reporting trends.

---

## 22. File & Module Quick Reference

| Area | Important Files | Responsibility |
|---|---|---|
| **App & Runtime** | `src/app.js`, `src/createApp.js`, `src/shutdown.js` | App bootstrap, middleware setup, graceful shutdown |
| **Configuration** | `src/config/env.js`, `src/config/prisma.js`, `src/config/supabase.js` | Environment validation, database client, storage client |
| **Authentication & RBAC** | `src/middleware/auth.js`, `src/middleware/requireRole.js`, `src/routes/auth.js` | JWT verification, cookies, role enforcement, login/logout |
| **WhatsApp Ingestion** | `src/routes/whatsapp.js`, `src/middleware/verifyWhatsAppSignature.js` | Webhook verification, HMAC validation, binary intake |
| **Queue & Worker** | `src/services/submissionQueue.js`, `src/services/placementRecovery.js` | Lease acquisition, background execution, crash recovery |
| **Document Processing**| `src/services/documentProcessingService.js`, `src/services/statusMapping.js` | Pipeline coordination, outcome computation |
| **OCR & Classification**| `src/services/ocrService.js`, `src/services/documentClassificationService.js` | Tesseract OCR, auto-rotation, type classification |
| **Identity & Extraction**| `src/services/passportExtractionService.js`, `src/services/identityVerificationService.js` | MRZ extraction, client reconciliation |
| **Storage Placement** | `src/services/storagePlacementService.js`, `src/services/permanentStorageService.js` | Bucket copying, client folders, SHA-256 duplicate checking |
| **Review & Audit** | `src/services/adminReviewActionService.js`, `src/services/adminReviewService.js` | Review queue decisions, immutable audit logging |
| **Police Workflow** | `src/services/policeCountdownService.js`, `src/services/adminPoliceService.js` | 21-day countdown calculation, urgency classification |
| **Admin API** | `src/routes/admin.js`, `src/services/adminDashboardService.js` | Admin endpoints, overview KPIs, reports |
| **Admin UI Core** | `admin/src/App.tsx`, `admin/src/auth/AuthProvider.tsx`, `admin/src/api/client.ts` | Frontend routes, auth state, HTTP client |
| **Admin UI Pages** | `admin/src/pages/OverviewPage.tsx`, `ReviewQueuePage.tsx`, `PoliceWorkflowPage.tsx` | Operational views, tables, forms, metrics |
| **Database Schema** | `prisma/schema.prisma`, `prisma/migrations/` | Prisma data models, constraints, SQL triggers |
| **Tests** | `test/adminRbacAuth.test.js`, `adminReports.test.js`, `admin/src/test/` | Backend test suites, Vitest frontend tests |

---

## 23. Current Project Status

- **Phases 1–10 (Core Foundations & Admin Dashboard):** Fully completed, verified, and regression tested.
- **Phase 11 (Reporting & Alerts):** Completed. Includes daily business-day reporting, countdown monitoring, and missing document tracking.
- **Phase 12 (Security, QA & Deployment):** Currently active final implementation phase.
  - **Checkpoint 1 (Authentication + RBAC):** **COMPLETED**. Secure `httpOnly` cookie transport implemented, `SameSite=Strict` CSRF protection active, three-tier role-based authorization (`ADMIN`, `REVIEWER`, `VIEWER`) enforced across all admin endpoints, and full test suite passing at 100%.
  - **Checkpoint 2 (Admin Invitation System):** Upcoming.
  - **Checkpoint 3 (Deployment & Container Hardening):** Upcoming. Deployment to production servers is not yet complete.
