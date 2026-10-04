# 18 — OCR Worker on Google Cloud Run: status and handoff

Where the OCR separation stands, and how to continue it on another machine.

- Branch: `dev`
- Commits: `c33a9e7` feat: separate OCR into an independently deployable Cloud Run service, `4743bcf` chore: ignore the local env file
- Full service reference (API, Docker, deployment commands, costs, rollback): [`ocr-worker/README.md`](../ocr-worker/README.md)

## Goal

Take the CPU-heavy Tesseract.js OCR out of the Express app and run it as its own
service on Google Cloud Run. Nothing else moves: the webhook, queue, Supabase
storage, PostgreSQL/Prisma, classification, passport/MRZ extraction, identity,
reconciliation, placement, police workflow and admin dashboard stay in Express,
with unchanged behaviour.

```
WhatsApp → Express webhook → Supabase temporary/ + temporary_data → HTTP 200
                    │
          submission queue (lease, retries) → processDocument() → extractText()
                    │
          src/services/ocrClient.js ── HTTPS + Google identity token ──▶ Cloud Run: ocr-worker
                    ◀──────────────── extraction result ─────────────────  (Tesseract.js, pdf-parse,
                    │                                                        preprocessing, MRZ read selection)
          classification → passport/MRZ → identity → reconciliation → placement → DB/storage → dashboard
```

## Status

| Step | What | Status |
|---|---|:---:|
| 1 | Inspect and trace the current OCR path | ✅ Done |
| 2 | Report the OCR boundary | ✅ Done |
| 3 | Extract OCR into `ocr-worker/` (ocrService.js, image/PDF processing, limits, MRZ read selection) | ✅ Done |
| 4 | Local integration: Express → OCR client → local worker → result | ✅ Done |
| 5 | Tests (backend, worker, real OCR, admin) | ✅ Done — see results below |
| 6 | Docker image built and tested locally | ✅ Done |
| 7 | Deploy to Google Cloud Run | ⏳ **Next** — needs a GCP project with billing and the `gcloud` CLI |
| 8 | Point the production backend at Cloud Run (`OCR_SERVICE_URL` + credentials) | ⏳ Pending |
| 9 | End-to-end check with real WhatsApp, Supabase and Cloud Run | ⏳ Pending |

### What was built

- **`ocr-worker/`** — independent Node service: `POST /process` (raw document body, `Content-Type` = MIME type) returns exactly the old `extractDocumentText` result; `GET /health`. English language data (`@tesseract.js-data/eng`, same `4.0.0_best_int` model as before) is bundled, so no instance downloads it. Runs as non-root, stops cleanly on SIGTERM.
- **`src/services/ocrClient.js`** — the pipeline's default `extractText`. Sends the buffer, attaches a Google identity token (Cloud Run IAM) unless the URL is loopback.
- **`src/services/ocrContract.js`** — result methods and errors (`OcrResourceError`, `OcrServiceUnavailableError`, `OcrRequestRejectedError`).
- **Queue** (`submissionQueue.js`) — own concurrency constant `MAX_CONCURRENT_OCR_REQUESTS = 2`; an unreachable/overloaded OCR service uses the existing retry-later path (1 min, max 3 attempts, then FAILED at `TEXT_EXTRACTION`). Lease, claims and orphan recovery unchanged.
- **Config** — `OCR_SERVICE_URL` is required at startup; plain `http://` allowed only for loopback.

### Error behaviour across HTTP

| Service answer | Backend result |
|---|---|
| 422 `IMAGE_TOO_LARGE` / `IMAGE_UNREADABLE` / `PDF_TOO_MANY_PAGES` / `PDF_PAGE_TOO_LARGE` / `OCR_TIMEOUT` | same `OcrResourceError` as before → FAILED, same dashboard code |
| 503 `OCR_BUSY`, 401/403/404/429/5xx, timeout, unreachable | retried by the queue; FAILED after 3 attempts (`OCR_BUSY` keeps its code) |
| 400 / 413 | final → FAILED (`TEXT_EXTRACTION_FAILED`) |

### Test results at handoff (2026-09-29)

| Suite | Result |
|---|---|
| Backend `npm test` | 1035 tests: 1013 pass, 0 fail, 22 skipped (opt-in real OCR) |
| Backend real OCR through HTTP (`RUN_OCR_TESTS=1`) | 25/25 pass |
| Worker `npm run ocr:test` with real Tesseract | 101/102 pass (SIGTERM test skipped on Windows; verified in Docker) |
| `npm run admin:test` | 144/144 pass |
| Admin typecheck / `npm run admin:build` | ❌ fails — **pre-existing, unrelated**: `admin/src/pages/ReviewDetailPage.tsx` uses `deleteTemporaryDocument` without importing it |
| Docker | builds (554 MB); OCR works with `--network none`; start → first answer ≈ 2 s; peak ≈ 300 MiB with 2 jobs; SIGTERM exit 0 in 0.8 s |

## Workflow: continue on another machine

### 1. Prerequisites

- Node.js 22.18+ (or 23.6+), npm, Git
- Docker Desktop (for the image)
- Google Cloud SDK (`gcloud`) — for Steps 7–9 only

### 2. Get the code

```bash
git clone https://github.com/emlynk-pixel/EmlynkWABot.git
cd EmlynkWABot
git checkout dev
git pull
```

### 3. Bring the local secrets (not in git)

`.env` and the root `env` file are git-ignored on purpose. Copy them from the
old machine by a private channel (password manager, encrypted USB) — never
commit them, never send them through chat or email.

Make sure `.env` contains:

```
OCR_SERVICE_URL=http://127.0.0.1:8080
```

The backend refuses to start without it.

### 4. Install

```bash
npm install              # backend (also generates the Prisma client)
npm run ocr:install      # OCR worker — also required by the backend tests
npm --prefix admin ci    # admin dashboard
```

Use `npm --prefix admin ci` rather than `npm run admin:install`: with npm 11,
`npm --prefix admin install` adds `"emlynkwabot": "file:.."` to
`admin/package.json`. If that happens, revert it with
`git checkout -- admin/package.json admin/package-lock.json`.

### 5. Check everything still passes

```bash
npm test                                  # backend (starts the worker in-process)
npm run ocr:test                          # worker
RUN_OCR_TESTS=1 npm test                  # optional: real OCR through HTTP (a few minutes)
RUN_OCR_TESTS=1 npm run ocr:test          # optional: worker with real Tesseract
npm run admin:test
```

Windows PowerShell: `$env:RUN_OCR_TESTS="1"; npm test`.

### 6. Run locally

Two terminals:

```bash
npm run ocr:start        # OCR service on http://127.0.0.1:8080
npm start                # backend on http://localhost:3000
```

Or the container instead of `ocr:start`:

```bash
cd ocr-worker
docker build -t emlynk-ocr-worker .
docker run --rm -p 127.0.0.1:8080:8080 emlynk-ocr-worker
```

### 7. Next: deploy to Cloud Run (Step 7)

Full commands are in [`ocr-worker/README.md`](../ocr-worker/README.md#google-cloud-run-deployment). In short:

1. Create/choose a GCP project, link billing, enable `run`, `artifactregistry`, `cloudbuild` APIs.
2. Create an Artifact Registry repo; `gcloud builds submit ocr-worker --tag …/ocr-worker:v1`.
3. Create service accounts `ocr-worker-runtime` (no permissions) and `ocr-invoker`.
4. Deploy private: `--no-allow-unauthenticated --cpu=2 --memory=2Gi --concurrency=2 --timeout=300 --min-instances=0 --max-instances=2 --cpu-boost`.
5. Grant `roles/run.invoker` on the service to `ocr-invoker`.
6. Verify: unauthenticated `/health` → 403; with `gcloud auth print-identity-token` → 200; POST a fixture to `/process`.
7. Set a budget alert (free tier has monthly limits; usage above it is charged).

### 8. Then: switch the backend to Cloud Run (Step 8)

In the production backend environment:

```
OCR_SERVICE_URL=https://ocr-worker-xxxxxxxxxx-xx.a.run.app
GOOGLE_APPLICATION_CREDENTIALS=/secure/path/ocr-invoker-key.json   # only if the backend is not on Google Cloud
```

On Google Cloud, run the backend as `ocr-invoker` instead of using a key file.
Keep the key out of git and logs.

### 9. Then: end-to-end check (Step 9)

Send test documents over WhatsApp (a passport, a police slip, an unclear photo)
and confirm for each: webhook answers 200 at once → backend log shows
`Submission processed in background` → Cloud Run log shows `OCR done` →
the document appears in the admin dashboard with the expected status. Also
confirm a failure path: stop/undeploy the service briefly and check the
submission is retried (`RETRY_LATER`) and processed once it is back.

## Open points

- Admin typecheck/build error in `ReviewDetailPage.tsx` (pre-existing, not OCR related) — fix separately.
- `admin:install` script: consider changing to `npm --prefix admin ci` (npm 11 behaviour above).
- Confidence bands in code are `>95 / 90–95 / 60–89 / 40–59 / <40` (unchanged by this work); the OCR task description listed different numbers — the `40` routing boundary matches.
- Latency and cold-start figures are local measurements; confirm on Cloud Run after deploying and adjust `--cpu` if needed.
- Calling Cloud Run from a backend outside Google Cloud is documented with a service-account key; keyless workload identity federation has not been verified.

## Rollback

- Bad Cloud Run revision: `gcloud run services update-traffic ocr-worker --to-revisions=<previous>=100`.
- Back to in-process OCR: `git revert c33a9e7`, then `npm install` and redeploy the backend. No database migration is involved.
