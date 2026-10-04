# WhatsApp Integration

Consolidates the original webhook security document, corrected and extended with the durable idempotency mechanism added later (message-level duplicate protection across restarts, not just within one server session). The original is kept in full in `Docs/archive/` (`04-whatsapp-security.md`).

## Overview

The backend uses the official WhatsApp Business API (Meta Graph API) and webhook architecture. Two things must be true for every incoming request: it must genuinely come from Meta, and processing must never block the fast acknowledgement Meta expects.

## Webhook Verification (GET)

Meta verifies the webhook endpoint once, when it's registered, using `hub.mode`, `hub.verify_token` and `hub.challenge`. The backend compares the received verify token against `WHATSAPP_VERIFY_TOKEN` in constant time (`crypto.timingSafeEqual` over a hash of each side, so an unset env var can never accidentally match a missing token) and, if valid, echoes the challenge back as `text/plain`. An invalid token or malformed challenge gets `403`.

## Signature Verification (POST)

GET verification alone doesn't secure incoming POST requests — anyone who knows the URL could send one. Meta signs every webhook POST with `X-Hub-Signature-256`, an HMAC-SHA256 of the raw request body using `META_APP_SECRET`. The raw body is preserved before Express's JSON body parser runs (specifically for this check), the backend computes the same HMAC and compares it to the received signature in constant time. A mismatch is rejected before any processing.

```
Meta
  ↓
POST /whatsapp/webhook
  ↓
X-Hub-Signature-256 received
  ↓
Raw request body preserved
  ↓
HMAC SHA-256 generated using META_APP_SECRET
  ↓
Signatures compared (constant time)
  ↓
Valid → continue processing
Invalid → reject (401)
```

Files: `src/middleware/verifyWhatsAppSignature.js` (the check itself), `src/routes/whatsapp.js` (mounts it before any message handling).

## Message Idempotency

Every WhatsApp message carries a unique message ID, and Meta retries a webhook delivery it didn't get an acknowledgement for — so the same message can genuinely arrive twice. Two layers protect against processing it twice:

1. **In-process, in-memory** (`src/utils/messageIdempotency.js`): a message ID is claimed as soon as the webhook accepts it, before any download or OCR. A retry or replay that arrives while the first delivery is still being recorded waits for it (up to 10 seconds) rather than racing it; if the first fails, the second takes over. Bounded (24-hour TTL, at most 10,000 IDs), cleared on restart, and not shared between server instances.
2. **Durable, across restarts and instances** (`temporary_data.message_id`, a unique database column): the row the webhook commits is the actual source of truth. If the in-memory cache is empty (a restart, or a different instance) and the same message arrives again, the unique constraint on `message_id` catches it — the second insert fails, the duplicate upload is cleaned up, and the message is still acknowledged as handled.

The in-memory layer exists to avoid ever attempting the same download and upload twice while the first attempt is still running; the database constraint is what actually guarantees no duplicate is stored, regardless of process restarts or how many instances are running.

## Access Token Security

`WHATSAPP_ACCESS_TOKEN` (a Meta Graph API system-user token) is used only server-side, to get a media download URL and download the document itself. It is stored only in environment configuration (`.env` locally; Secret Manager in production, see `08-cloud-deployment.md`), never committed, never sent to the browser. The token is only ever attached to requests to `https://fbsbx.com` or its subdomains (checked against an allowlist before the token is attached), which prevents it from being sent anywhere else even if Meta's API ever returned an unexpected media URL.

## Message Handling Flow

```
WhatsApp Client
      │
      ▼
Meta Graph API
      │ POST /whatsapp/webhook (HMAC-SHA256 signed)
      ▼
Signature verification
      │
      ▼
Message ID claimed (idempotency)
      │
      ▼
Only document/image message types processed; others acknowledged and ignored
      │
      ▼
Media metadata fetched, then downloaded (size/type pre-checked, timeouts enforced)
      │
      ▼
File validated (MIME, magic bytes, size)
      │
      ▼
Uploaded to Supabase temporary/
      │
      ▼
temporary_data row committed (status: TEMPORARY_STORED) — this row is the durable job
      │
      ▼
HTTP 200 to Meta (processing has not started yet — see 05-ocr-document-processing.md)
```

A message with no `from` field (no sender) is acknowledged (`200`) and logged rather than causing retries — it can never be attributed to anyone, so retrying it indefinitely would only waste effort. A file that fails validation is also acknowledged as handled (Meta shouldn't keep resending something that will never process); only a failure *before* anything durable was recorded (e.g. a network failure mid-download) causes a `500`, which makes Meta retry the whole delivery — already-recorded messages within that delivery are skipped on the retry by their claimed IDs.

## Privacy in Logs

Webhook logs never include the sender's phone number, file names, storage paths, media IDs or the raw message ID. A short one-way hash of the message ID (`messageRef`, 12 characters) is used instead, just enough to connect the log lines belonging to one message.

## Files

| File | Role |
|---|---|
| `src/routes/whatsapp.js` | `GET`/`POST /whatsapp/webhook`, message claiming, orchestration |
| `src/middleware/verifyWhatsAppSignature.js` | HMAC signature check |
| `src/utils/messageIdempotency.js` | In-memory duplicate/replay protection |
| `src/services/whatsappMediaService.js` | Media URL lookup and download, host allowlist |
| `src/utils/fileValidation.js` | MIME/magic-byte/size validation |
| `src/services/temporaryStorageService.js` | Upload to `temporary/` |
| `src/services/temporaryDataService.js` | Creates the durable `temporary_data` row |
| `src/services/submissionQueue.js` | Wakes up to process what the webhook just committed — see `05-ocr-document-processing.md` and `08-cloud-deployment.md` |

## Current Status

Implemented: verify-token handshake, HMAC signature verification, durable message idempotency (in-memory fast path + database constraint), access-token host allowlisting, media validation, missing-sender handling, PII-safe logging.
