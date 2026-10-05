# System Architecture

Consolidates and corrects the architecture sections of the earlier project-summary document against the deployment work actually completed (`08-cloud-deployment.md`) and the storage/OCR documents written from source code (`05-ocr-document-processing.md`, `06-storage-management.md`). Where an earlier document's figures disagreed with the verified source — storage paths, confidence-band boundaries — this document uses the verified figures.

## Components

| Component | Role |
|---|---|
| Express backend | Webhook ingestion, admin API, authentication. Runs as a Vercel function (`api/index.js` → `src/httpHandler.js`) in production; as a normal Node process (`src/app.js`) locally and in Docker. |
| Submission worker | Polls PostgreSQL, claims and processes submissions (OCR → classification → identity → placement). A separate Cloud Run service in production (`node src/worker.js`); runs inside the same process as the backend locally (`src/app.js` starts both). |
| OCR worker | Tesseract.js OCR and PDF text extraction, as its own Cloud Run service, called over HTTPS with a Google identity token. |
| PostgreSQL (Supabase) | The database, and the durable job queue (`temporary_data` rows are the jobs; see `03-database-design.md`). |
| Supabase Storage | Private object storage bucket for documents — temporary, pending-review, and permanent client folders. |
| Admin SPA | React 19 + Vite, served under `/admin` — statically on Vercel, or by Express locally/in Docker. |

## High-Level Workflow

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
      │ 3. Check Message Idempotency (in-memory + durable unique message_id)
      │ 4. Fetch Media URL & Download Binary
      │ 5. Upload to Supabase temporary/
      │ 6. Commit temporary_data row (status: TEMPORARY_STORED)
      ▼ (HTTP 200 OK to Meta — the worker below is not on this request's critical path)
Submission Worker (submissionQueue.js, its own Cloud Run service in production)
      │ 1. Lease Claim (Compare-and-Swap)
      │ 2. Text extraction / OCR (calls the separate OCR Cloud Run service)
      │ 3. Document Classification & MRZ Extraction
      │ 4. Identity Lookup & Field Reconciliation
      │ 5. Confidence Calculation & Review Decision
      │ 6. Placement Resolution (clients/{passport_id}/{type}/ vs pending/)
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

## Production Deployment Topology

See `08-cloud-deployment.md` for the full, step-by-step record. In summary:

```
                    Vercel
        ┌──────────────────────────┐
        │  React Admin (/admin)     │
        │  Express API/Webhook      │  ← api/index.js → src/httpHandler.js
        └──────────────┬────────────┘
                        │ same-origin rewrites
                        ▼
              Supabase PostgreSQL (session pooler)
                        ▲
                        │ polls, claims (compare-and-swap)
              Cloud Run: emlynk-submission-worker
              (asia-northeast1, node src/worker.js)
                        │
                        ▼
              Cloud Run: emlynk-ocr-worker
              (asia-south1, Tesseract.js OCR)
                        │
                        ▼
              Supabase Storage (private bucket)
```

This is a deliberate split, not the original design: the webhook/API needed to become a stateless function (Vercel), but the submission worker is a polling loop that must keep a claim (lease) open for up to 10 minutes and wait up to 4 minutes for one OCR call — incompatible with a function that only runs per-request. It therefore runs as its own always-on Cloud Run service, and PostgreSQL (not a new queue technology) remains the coordination point between the two: the webhook writes a row, the worker polls for it.

Locally and in a plain Docker container, this split doesn't exist: `src/app.js` runs the Express server and starts the submission worker in the same process, as a single unit.

## Communication Flow

1. **Webhook ingestion.** Meta posts incoming WhatsApp events to `POST /whatsapp/webhook`. The server verifies signatures against `META_APP_SECRET`, deduplicates message IDs, downloads the media binary, validates file safety, streams the file to `temporary/` in the private bucket, commits a record into `temporary_data`, and returns 200 within milliseconds — none of this waits for OCR.
2. **Background processing.** The submission worker leases pending submissions using atomic compare-and-swap database locks, runs OCR (via the separate OCR service), classifies the document, reconciles client data, checks for duplicate hashes, and places files into permanent client folders (`clients/{passport_id}/{document type}/`) or review folders (`pending/`). See `05-ocr-document-processing.md` and `06-storage-management.md` for the exact rules.
3. **Admin operations.** Administrators interact with the single-page application served under `/admin`. All requests go through `SameSite=Strict`, `HttpOnly` cookie authentication and role-based middleware. Audit log entries are written on every administrative review action, immutably (a database trigger rejects `UPDATE`/`DELETE` on `audit_logs`).

## Confidence Bands (authoritative — see `05-ocr-document-processing.md` for the full rules)

| Confidence | Band | Storage outcome |
|---|---|---|
| > 95 | `VERIFIED` | `clients/{passport_id}/{type}/`, renamed |
| 90–95 | `HIGH_CONFIDENCE` | `clients/{passport_id}/{type}/`, renamed |
| 60–89 | `SLIGHTLY_UNCLEAR` | `clients/{passport_id}/{type}/`, renamed |
| 40–59 | `UNCLEAR` | `clients/{passport_id}/{type}/` if a client is identified (else `pending/`), original name kept, `REVIEW_REQUIRED` |
| < 40 | `UNDEFINED` | `pending/`, never a client folder |

## Why This Architecture

- **Decoupled ingestion and processing:** the webhook never waits for OCR, so Meta always gets a fast acknowledgement regardless of OCR latency, and a slow or unreachable OCR service only delays processing, never message receipt.
- **PostgreSQL as the durable queue:** no separate queue technology. The `temporary_data` row committed by the webhook *is* the job; a compare-and-swap claim and lease make it safe for exactly one worker attempt to own a submission at a time, safe across process restarts and across multiple worker instances.
- **OCR as its own service:** Tesseract.js is CPU- and memory-heavy; running it as a separate Cloud Run service keeps those spikes off the backend/worker process and lets it scale independently.
- **Private storage only:** the bucket has no public or signed URLs anywhere in the system; the admin dashboard streams file previews through an authenticated Express/Vercel route instead.
