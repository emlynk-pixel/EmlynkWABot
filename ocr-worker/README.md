# Emlynk OCR service (`ocr-worker/`)

The Tesseract.js OCR of the Emlynk document pipeline, as its own service. It
runs on Google Cloud Run; the Express backend calls it from its submission
queue. It holds no state, stores nothing and has no database or storage access:
it receives a document, returns the text read from it, and forgets it.

```
WhatsApp → Express webhook → Supabase temporary/ + temporary_data → HTTP 200
                                        │
                      submission queue (PostgreSQL rows, lease, retries)
                                        │  processDocument() → extractText()
                                        ▼
                      src/services/ocrClient.js ── HTTPS + Google identity token ──▶ Cloud Run: ocr-worker
                                        ◀──────────── extraction result ─────────────  Tesseract.js, pdf-parse,
                                        │                                               image preprocessing, MRZ read selection
                classification → passport/MRZ extraction → identity → reconciliation → placement
                                        │
                            PostgreSQL + Supabase Storage → admin dashboard
```

## What runs here

`src/ocrService.js`, moved unchanged from the backend except for where
Tesseract's language data comes from:

- PDF text layer (`pdf-parse`); scanned PDFs rendered at 2x (first 3 pages) and OCR'd
- image OCR with Otsu/Sauvola thresholding and `rotateAuto` retries for weak reads
- 2x upscaling of small images, 90/180/270° orientation recovery
- passport MRZ check digits used to pick the best of several reads (`src/utils/mrz.js`)
- resource limits (image size, PDF pages, 2 concurrent jobs + 10 waiting, 60 s wait, 120 s per job)

`src/utils/mrz.js`, `dateParsing.js` and `safeLog.js` are copies of the
backend's files (the backend still uses them for passport extraction);
`test/ocrServiceBoundary.test.js` in the backend fails if they drift apart.

### Language data

`@tesseract.js-data/eng` (a pinned npm dependency) contains
`4.0.0_best_int/eng.traineddata.gz`: the same English model Tesseract.js
downloads from its CDN by default. The service loads it from disk
(`langPath`, `cacheMethod: "none"`), so the image contains it, no instance
downloads anything, and nothing is written to disk. The server refuses to
start if the file is missing.

## HTTP API

Internal only. On Cloud Run, IAM rejects any request without a valid Google
identity token of an allowed caller before it reaches the container.

```
POST /process
Content-Type: <the document's MIME type: application/pdf, image/jpeg, image/png>
Authorization: Bearer <Google identity token, audience = service URL>   (Cloud Run only)
<document bytes, ≤ 10 MB>
```

`200`: exactly what `extractDocumentText` returns:

```json
{ "success": true, "text": "…", "method": "OCR", "confidence": 88.5,
  "thresholding": "OTSU", "rotateAuto": false, "upscaled": false, "rotation": 0 }
```

(`PDF_OCR` results carry `pagesProcessed`, `totalPages` and per-page
`thresholding`/`rotateAuto` arrays; `PDF_TEXT`, `PDF_PARSE_FAILED` and
`UNSUPPORTED_DOCUMENT_TYPE` carry only `success`, `text`, `method`.)

Errors: `{ "success": false, "error": { "code": "…", "message": "…" } }`

| Status | Code | Meaning | Backend (`ocrClient.js`) |
|---|---|---|---|
| 422 | `IMAGE_TOO_LARGE`, `IMAGE_UNREADABLE`, `PDF_TOO_MANY_PAGES`, `PDF_PAGE_TOO_LARGE`, `OCR_TIMEOUT` | the document was refused | `OcrResourceError`, same message as before → FAILED, same dashboard code |
| 503 | `OCR_BUSY` (+ `Retry-After`) | all job slots and the wait queue are full | retried by the queue; `OCR_BUSY` if finally given up |
| 400 | `INVALID_REQUEST` | no/invalid Content-Type or empty body | final: FAILED (`TEXT_EXTRACTION_FAILED`) |
| 413 | `PAYLOAD_TOO_LARGE` | more than 10 MB | final: FAILED (`TEXT_EXTRACTION_FAILED`) |
| 500 | `OCR_FAILED` | unexpected failure (details only in the service log, redacted) | retried by the queue |
| 401/403/404/429/5xx from Cloud Run, timeout, unreachable | | the service could not answer | retried by the queue |

"Retried by the queue": the submission stays `TEMPORARY_STORED`, nothing is
written, and it is claimed again about 1 minute later, within the existing 3
attempts; after the last one it is recorded FAILED at `TEXT_EXTRACTION`.

`GET /health` → `{ "status": "OK" }`.

Logs hold MIME type, size, method, reason codes and timings. Never document
text, file names, passport or phone numbers, tokens or URLs with data.

## Local development

```bash
npm run ocr:install          # from the repository root, once
npm run ocr:start            # http://127.0.0.1:8080 (loopback only)
```

and in the backend's `.env`:

```
OCR_SERVICE_URL=http://127.0.0.1:8080
```

A loopback URL gets no identity token; that is the only case the backend
accepts plain `http://` (`src/config/env.js`). Locally the service listens on
127.0.0.1, so nothing else on the network can reach it.

Tests:

```bash
npm run ocr:test                       # the service (fast)
RUN_OCR_TESTS=1 npm run ocr:test       # with real Tesseract (a few minutes)
npm test                               # the backend; starts this service in-process
RUN_OCR_TESTS=1 npm test               # backend pipeline on real OCR through HTTP
```

On Windows PowerShell: `$env:RUN_OCR_TESTS="1"; npm run ocr:test`.

The backend's tests need this service's dependencies (`npm run ocr:install`):
tests that use the real text extraction start it in-process on a loopback port
(`test/helpers/localOcrService.js`). Tests that inject `extractText` never
touch it.

## Docker

```bash
cd ocr-worker
docker build -t emlynk-ocr-worker .
docker run --rm -p 127.0.0.1:8080:8080 emlynk-ocr-worker
curl -s http://127.0.0.1:8080/health
curl -s -X POST --data-binary @test/fixtures/files/image-medical.png \
     -H "Content-Type: image/png" http://127.0.0.1:8080/process
```

`docker run --network none …` works too: the image needs no network access
for OCR. The image runs as the unprivileged `node` user, listens on
`0.0.0.0:$PORT` (8080) and stops on SIGTERM within 9 s.

## Google Cloud Run deployment

Replace `PROJECT_ID`, `REGION` (e.g. `asia-south1`, close to Sri Lanka, or the
region nearest the backend) and the image tag.

### 1. Project and billing

```bash
gcloud projects create PROJECT_ID          # or use an existing project
gcloud config set project PROJECT_ID
# Link a billing account (Console → Billing), required even within the free tier.
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com
```

### 2. Build and push the image

```bash
gcloud artifacts repositories create emlynk --repository-format=docker --location=REGION
gcloud builds submit ocr-worker --tag REGION-docker.pkg.dev/PROJECT_ID/emlynk/ocr-worker:v1
```

(Or build locally: `gcloud auth configure-docker REGION-docker.pkg.dev`,
`docker build -t REGION-docker.pkg.dev/PROJECT_ID/emlynk/ocr-worker:v1 ocr-worker`,
`docker push …`.)

### 3. Service accounts

```bash
# Identity of the service itself: it needs no permissions.
gcloud iam service-accounts create ocr-worker-runtime --display-name="Emlynk OCR service"
# Identity the backend calls with.
gcloud iam service-accounts create ocr-invoker --display-name="Emlynk backend -> OCR service"
```

### 4. Deploy (private)

```bash
gcloud run deploy ocr-worker \
  --image=REGION-docker.pkg.dev/PROJECT_ID/emlynk/ocr-worker:v1 \
  --region=REGION \
  --service-account=ocr-worker-runtime@PROJECT_ID.iam.gserviceaccount.com \
  --no-allow-unauthenticated \
  --ingress=all \
  --port=8080 \
  --cpu=2 --memory=2Gi \
  --concurrency=2 \
  --timeout=300 \
  --min-instances=0 --max-instances=2 \
  --cpu-boost

gcloud run services add-iam-policy-binding ocr-worker --region=REGION \
  --member=serviceAccount:ocr-invoker@PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/run.invoker

gcloud run services describe ocr-worker --region=REGION --format='value(status.url)'
```

`--no-allow-unauthenticated` is what makes the service private: only
principals with `roles/run.invoker` on it can call it. `--ingress=all` is
needed when the backend is not on Google Cloud (the requests come from the
internet, still authenticated); if the backend runs on Google Cloud in the
same project, `--ingress=internal` with VPC egress can narrow it further.

### 5. Settings, and why

| Setting | Value | Reason |
|---|---|---|
| `--concurrency` | 2 | equals the service's own job limit (`MAX_CONCURRENT_OCR_JOBS`): Cloud Run then starts another instance instead of queueing inside one |
| `--cpu` / `--memory` | 2 / 2Gi | Tesseract is CPU-bound, one worker thread per job, two jobs; each worker 100–300 MB plus decoding a large photo (a 50 MP image is 200 MB of pixels, with copies for turning/enlarging) |
| `--timeout` | 300 s | above the service's worst case (60 s waiting for a slot + 120 s job) and the backend's 240 s request timeout |
| `--min-instances` | 0 | scale to zero: nothing is paid while idle. A cold start (≈ 2 s locally, plus image pull on Cloud Run) delays only the first document after a quiet period; the queue does not care. Raise to 1 only if that ever matters (`gcloud run services update ocr-worker --min-instances=1`; billed continuously) |
| `--max-instances` | 2 | the backend sends at most 2 requests at a time (`MAX_CONCURRENT_OCR_REQUESTS`); the second instance covers a restart or a revision rollout. A hard cap on cost |
| `--cpu-boost` | on | extra CPU during startup: shorter cold starts |
| CPU allocation | during requests (default) | request-based billing; the service does no work outside requests |

Measured with this image in Docker on a development machine, without network
access (`docker run --network none`):

| | |
|---|---|
| container start → first `/health` answer | ≈ 2 s |
| text PDF (text layer) | 40 ms |
| medical report photo | 1.4 s (first request after start: the same) |
| one-page scanned PDF | 2.7 s |
| harsh police certificate photo | 4.6 s |
| small (380 × 520) passport photo, 2x read | 12 s |
| photos received sideways/upside down (orientation search) | 9–18 s; worst seen ≈ 30 s (small passport, sideways) |
| memory, 2 jobs running + 1 waiting | ≈ 300 MiB peak (sampled) |
| SIGTERM → exit | 0.8 s, exit code 0 |

A document's first request after a cold start is not slower than later ones:
a Tesseract worker is started for every document anyway (unchanged from
before). Cloud Run vCPUs may be slower than this machine; watch the request
latency metric after deploying and raise `--cpu` if needed. The fixtures are
phone-photo sized; a full-resolution photo sent as a document (up to 50 MP)
needs far more memory while it is decoded, turned or enlarged, hence 2 GiB.

### 6. Point the backend at it

In the backend's environment:

```
OCR_SERVICE_URL=https://ocr-worker-xxxxxxxxxx-xx.a.run.app
```

and give the backend the `ocr-invoker` identity through Application Default
Credentials:

- **Backend on Google Cloud** (Cloud Run, GCE, GKE): run it as
  `ocr-invoker@PROJECT_ID.iam.gserviceaccount.com`. Nothing else to configure.
- **Backend elsewhere**: create a key and make it available to the backend
  only, outside the repository:

  ```bash
  gcloud iam service-accounts keys create ocr-invoker-key.json \
    --iam-account=ocr-invoker@PROJECT_ID.iam.gserviceaccount.com
  ```

  ```
  GOOGLE_APPLICATION_CREDENTIALS=/secure/path/ocr-invoker-key.json
  ```

  Keep the file out of git, the admin frontend and logs; store it in the
  host's secret store. The key can only invoke this one service. Rotate it by
  creating a new key, deploying it, then deleting the old one
  (`gcloud iam service-accounts keys list/delete`).

The backend (`google-auth-library`) mints a Google-signed identity token for
the service URL, caches it and renews it before it expires. Without working
credentials it sends no request at all; the submission waits and is retried.

### 7. Verify

```bash
URL=$(gcloud run services describe ocr-worker --region=REGION --format='value(status.url)')
curl -s -o /dev/null -w '%{http_code}\n' "$URL/health"                     # 403: private
curl -s -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$URL/health"
curl -s -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
     -H "Content-Type: image/png" --data-binary @test/fixtures/files/image-medical.png "$URL/process"
```

(Your own account can call it if it has `roles/run.invoker` or is a project
owner.) Then send a test document over WhatsApp and follow it in the backend
log (`Submission processed in background`) and the admin dashboard.

### Logs and monitoring

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="ocr-worker"' \
  --limit=50 --format='value(timestamp,textPayload)'
```

Cloud Console → Cloud Run → ocr-worker → Metrics: request count by status,
request latency, instance count, CPU and memory utilisation. Worth an alert
policy (Cloud Monitoring) on 5xx responses and on memory near the limit.
On the backend side, failures show up as `RETRY_LATER` outcomes in its log and,
after 3 attempts, as FAILED submissions (stage `TEXT_EXTRACTION`) in the dashboard.

### Updating

Build a new tag (`:v2`) and `gcloud run deploy ocr-worker --image=…:v2 --region=REGION`
(the other settings are kept). In-flight requests finish on the old revision.

## Cost

Cloud Run has a monthly free tier per billing account (at the time of writing
for request-based billing: 180,000 vCPU-seconds, 360,000 GiB-seconds and
2 million requests; check the current pricing page). It is not unlimited:
usage above it is charged, and Artifact Registry storage and Cloud Build have
their own allowances. With 2 vCPU / 2 GiB, one 10-second OCR request uses 20
vCPU-seconds and 20 GiB-seconds, so the free tier covers roughly 9,000 such
requests a month; an idle service costs nothing with `--min-instances=0`.

Set a budget alert before going live:

```bash
gcloud billing budgets create --billing-account=BILLING_ACCOUNT_ID \
  --display-name="Emlynk OCR" --budget-amount=5USD \
  --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0
```

`--max-instances` is the hard ceiling on how much can run at once.

## Rollback

- **A bad service revision**: send traffic back to the previous one.

  ```bash
  gcloud run revisions list --service=ocr-worker --region=REGION
  gcloud run services update-traffic ocr-worker --region=REGION --to-revisions=ocr-worker-00001-abc=100
  ```

- **Back to in-process OCR**: revert the commit that separated the OCR and
  redeploy the backend. No database migration is involved (the schema is
  unchanged), and nothing is lost meanwhile: while the service is unreachable,
  submissions stay queued and are retried; any recorded FAILED at
  `TEXT_EXTRACTION` can be retried from the dashboard (Retry processing).
  `OCR_SERVICE_URL` is then no longer needed, and the Cloud Run service can be
  deleted (`gcloud run services delete ocr-worker --region=REGION`).
