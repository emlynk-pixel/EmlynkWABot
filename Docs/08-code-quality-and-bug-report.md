# Code Quality and Bug Report

**Scope:** `src/`, `prisma/`, `package.json`, installed dependency versions, `.gitignore`
**Reference:** `Docs/WhatsApp_Document_Processing_Project_Proposal_Final.md`
**Audit type:** Static code review (read-only). No tests were executed.
**Status of fixes:** None of the items below have been fixed yet.

---

# Executive Summary

The WhatsApp document intake flow is structurally sound. Webhook signatures are verified against the raw body with a timing-safe comparison, the Supabase bucket is private and accessed only from the server, Prisma queries are parameterised, and no secrets are written to logs.

The review found **6 confirmed bugs**:

| ID | Severity | Area | Summary |
|---|---|---|---|
| BUG-001 | High | Database | Migration file edited after creation; contradicts schema and proposal |
| BUG-002 | Medium | Webhook security | `res.Status()` is not a function in signature middleware |
| BUG-003 | Medium | Webhook security | GET verification passes when `WHATSAPP_VERIFY_TOKEN` is unset |
| BUG-004 | Low | OCR | Typo `mmethod` in scanned-PDF result |
| BUG-005 | Low | OCR | Blank OCR output is reported as `success: true` |
| BUG-006 | Low | Logging | Every processing failure is logged as "media download failed" |

The largest non-bug risks are the **idempotency race** (processing runs before the webhook responds, so Meta retries can double-process a message), **in-memory idempotency** that is lost on restart, and a **Prisma client/adapter major-version mismatch**.

Unfinished features described in the proposal (confidence bands, undefined-document storage, background processing, etc.) are listed separately under [Proposal vs. Current Implementation](#proposal-vs-current-implementation) and are not treated as bugs.

---

# Confirmed Bugs

## BUG-001 — Migration file contradicts schema and proposal

**Severity:** High
**File:** `prisma/migrations/20260921064444_init_schema/migration.sql`
**Function:** n/a (SQL migration)

**Problem**
Commit `34e3bb0` edited an existing migration and changed these columns from nullable to `NOT NULL`:

| Table | Column | `schema.prisma` | `migration.sql` (current) | Proposal §9 / §40 |
|---|---|---|---|---|
| `temporary_data` | `passport_id` | nullable | `NOT NULL` | nullable |
| `temporary_data` | `unique_id` | nullable | `NOT NULL` | nullable |
| `temporary_data` | `whatsapp_number` | nullable | `NOT NULL` | nullable |
| `users` | `first_name` | nullable | `NOT NULL` | nullable |

**Why it matters**
- `createTemporaryDocumentRecord()` never sets `passport_id` or `unique_id`. On any database built from this migration (`prisma migrate deploy` / `migrate reset`), every temporary record insert fails and the document is lost after upload.
- Editing an already-applied migration changes its checksum, so `prisma migrate` reports drift and may ask to reset the database.
- The current Supabase database appears to work, which suggests it was not built from the edited file. That cannot be confirmed without checking the live schema.

**How to reproduce**
1. Create an empty PostgreSQL database.
2. Run `npx prisma migrate deploy`.
3. Send a valid WhatsApp PDF.
4. The insert into `temporary_data` fails with a `NOT NULL` violation on `passport_id`.

**Recommended fix**
Restore `migration.sql` to its content before `34e3bb0` (nullable columns), which matches both `schema.prisma` and the proposal. Then run `npx prisma migrate status` against Supabase to confirm there is no drift. Do not run `migrate reset` on the shared database.

**Status:** Open

---

## BUG-002 — `res.Status()` called in signature middleware

**Severity:** Medium
**File:** `src/middleware/verifyWhatsAppSignature.js` (lines 12, 46, 56)
**Function:** `verifyWhatsappSignature`

**Problem**
Three branches call `res.Status(...)`. Express has no `Status` method (only `status` / `sendStatus`), so each call throws a `TypeError`.

- Lines 46 and 56 are inside `try`, so the `TypeError` is caught and the catch block returns `401`. The correct status is returned only by accident.
- Line 12 (missing `META_APP_SECRET`) is outside `try`. The error falls through to Express's default error handler.

**Why it matters**
- Misconfiguration returns Express's default error page instead of a clean `500`. Outside `NODE_ENV=production` this page includes a stack trace.
- Invalid signatures log a misleading `res.Status is not a function` error instead of a clear "invalid signature" line, which hides real attacks or misconfiguration in the logs.

**How to reproduce**
1. Remove `META_APP_SECRET` from `.env` and restart.
2. `POST /whatsapp/webhook` with any `X-Hub-Signature-256` header.
3. Response is Express's default HTML error page.

Or, with the secret set, send a request with a wrong signature of the correct length and check the logs.

**Recommended fix**
Replace `res.Status(500)` with `res.sendStatus(500)` and `res.Status(401)` with `res.sendStatus(401)`.

**Status:** Open

---

## BUG-003 — Webhook GET verification passes when verify token is unset

**Severity:** Medium
**File:** `src/routes/whatsapp.js` (line 31)
**Function:** `GET /webhook` handler

**Problem**
```js
if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN)
```
If `WHATSAPP_VERIFY_TOKEN` is not configured and the request has no `hub.verify_token`, both sides are `undefined` and the check passes.

**Why it matters**
- Anyone can complete the verification handshake on a misconfigured server.
- `res.send(challenge)` echoes an attacker-controlled string with `Content-Type: text/html`, which is a reflected-content risk.

**How to reproduce**
1. Remove `WHATSAPP_VERIFY_TOKEN` from `.env` and restart.
2. `GET /whatsapp/webhook?hub.mode=subscribe&hub.challenge=test123`
3. Response is `200` with body `test123`.

**Recommended fix**
Reject the request when the env variable is missing:
```js
const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN;
if (expectedToken && mode === "subscribe" && token === expectedToken) { ... }
```
Optionally return the challenge as plain text (`res.type("text/plain")`).

**Status:** Open

---

## BUG-004 — Typo `mmethod` in scanned-PDF result

**Severity:** Low
**File:** `src/services/ocrService.js` (line 91)
**Function:** `extractDocumentText`

**Problem**
The scanned-PDF branch returns `mmethod: "SCANNED_PDF_OCR_REQUIRED"` instead of `method`.

**Why it matters**
The route logs `method: undefined` for scanned PDFs. Any future code that branches on `method === "SCANNED_PDF_OCR_REQUIRED"` (the planned scanned-PDF OCR fallback) will never match.

**How to reproduce**
Send a scanned (image-only) PDF. The log line "Document text extraction result" shows `method: undefined`.

**Recommended fix**
Rename the key to `method`.

**Status:** Open

---

## BUG-005 — Blank OCR output reported as success

**Severity:** Low
**File:** `src/services/ocrService.js` (line 59)
**Function:** `extractTextFromImage`

**Problem**
```js
const text = result.data.text?.trim() || " ";
...
success: text.length > 0,
```
The fallback is a single space, so `text.length` is always at least 1 and `success` is always `true`.

**Why it matters**
A blank, blurry or non-document image is reported as a successful extraction. When content-based classification is added, it will receive a false success signal.

**How to reproduce**
Send a plain white PNG. The log shows `success: true, textLength: 1`.

**Recommended fix**
Use `""` as the fallback. Consider also applying the same `MIN_TEXT_LENGTH` rule used for PDFs.

**Status:** Open

---

## BUG-006 — All processing failures logged as "media download failed"

**Severity:** Low
**File:** `src/routes/whatsapp.js` (line 220)
**Function:** `POST /webhook` handler (inner `catch`)

**Problem**
The inner `try` covers media URL lookup, download, validation, Supabase upload, the database insert and OCR. Any failure logs:
```js
console.error("WhatsApp media download failed:", error.message);
```
No `messageId` is included.

**Why it matters**
A Supabase upload failure, Prisma error or Tesseract crash is reported as a download failure, and the log cannot be tied back to the WhatsApp message. This slows down debugging in production.

**How to reproduce**
Set `SUPABASE_BUCKET` to a non-existent bucket and send a PDF. The log says "media download failed" although the download succeeded.

**Recommended fix**
Change the message to a neutral one (for example "WhatsApp document processing failed") and include `messageId`.

**Status:** Open

---

# Potential Risks

These are not failures today, but they can cause incorrect behaviour under realistic conditions.

| ID | Risk | Location | Likelihood | Impact |
|---|---|---|---|---|
| RISK-001 | **Idempotency race.** The message ID is marked processed only at the end. Download, upload and OCR run before the `200` is sent. If processing is slow, Meta retries and the retry passes the duplicate check, causing a duplicate upload and a duplicate `temporary_data` row. Conflicts with proposal §30 / AC-19. | `src/routes/whatsapp.js` lines 72, 234 | Medium | Medium |
| RISK-002 | **In-memory idempotency.** `processedMessageIds` is a `Set` in process memory. It is cleared on restart, not shared across instances, and grows without limit. | `src/utils/messageIdempotency.js` | High (on restart) | Medium |
| RISK-003 | **Orphaned storage objects.** If the upload succeeds but the database insert fails, the file stays in the bucket with no record pointing to it. | `src/routes/whatsapp.js` lines 141–166 | Low | Low |
| RISK-004 | **Prisma major-version mismatch.** `@prisma/client` and `prisma` are `6.19.3`, while `@prisma/adapter-pg` is `7.10.0`. Driver adapter APIs changed between majors. | `package.json` | Medium | High |
| RISK-005 | **Unused Prisma 7 config.** `prisma7.config.ts` is not a filename Prisma 6 loads (`prisma.config.ts`), so it has no effect. | project root | — | Low (confusion) |
| RISK-006 | **Node version dependency.** `src/config/prisma.js` imports `generated/prisma/client.ts`. This only works on Node ≥ 22.18 (native type stripping). Current environment is v22.18.0; older Node versions fail at startup. | `src/config/prisma.js` line 2 | Medium | High |
| RISK-007 | **Only the first message is processed.** The handler reads `entry[0].changes[0].messages[0]`. Batched events with several messages drop the rest. | `src/routes/whatsapp.js` lines 46–56 | Low | Medium |
| RISK-008 | **No fetch timeout.** Calls to the Graph API and the media URL have no timeout, so a stalled request holds the webhook open. | `src/services/whatsappMediaService.js` | Low | Medium |
| RISK-009 | **Missing env check for `SUPABASE_BUCKET`.** An unset bucket name produces an unclear Supabase error. | `src/services/temporaryStorageService.js` | Low | Low |

---

# Security Findings

**Verified as correct**

- `.env` and `.env.*` are gitignored and `.env` is not tracked.
- HMAC-SHA256 is computed on the raw request body (`express.json({ verify })` in `src/app.js`).
- `crypto.timingSafeEqual` is used and guarded by a length check.
- Access token, app secret, JWT secret and Supabase service-role key are never logged.
- The Supabase client runs server-side only with `persistSession: false`.
- No public or signed URLs are generated for stored documents.
- Prisma queries are parameterised, so there is no SQL injection path. `$queryRaw` is used only as a tagged template in `prisma-test.js`.
- No user input is used to build regular expressions.
- Stored filenames are UUID-based, so the sender's filename cannot cause path traversal.
- Extracted document text is not logged (only its length).
- Admin login returns the same error for unknown email and wrong password.

**Findings**

| ID | Severity | Finding | Location |
|---|---|---|---|
| SEC-001 | Medium | BUG-002 and BUG-003 (see above) | middleware, route |
| SEC-002 | Low | Full WhatsApp phone numbers are logged on every message (`senderNumber`, `whatsappNumber`). Proposal §34 asks for data minimisation. | `src/routes/whatsapp.js` lines 85, 170, 226 |
| SEC-003 | Low | Original filenames are logged. They can contain names or passport numbers. | `src/routes/whatsapp.js` lines 124, 184, 229 |
| SEC-004 | Low | **MIME type is sender-declared.** `validateDocumentFile` trusts `message.document.mime_type`; file content (magic bytes) is not checked. | `src/utils/fileValidation.js` |
| SEC-005 | Low | **Stored extension comes from the sender's filename**, not the validated MIME type. `invoice.exe` sent as `application/pdf` is stored as `<uuid>.exe`. | `src/services/temporaryStorageService.js` line 33 |
| SEC-006 | Low | **Size is checked after the full download.** The whole file is buffered in memory before the 10 MB limit is applied. | `src/routes/whatsapp.js` lines 106–112 |
| SEC-007 | Info | `src/utils/password-test.js` contains the literal password `Admin#123`. Confirm this is not a real admin password. | `src/utils/password-test.js` |
| SEC-008 | Info | `docker-compose.yml` contains local development database credentials. Acceptable for local use only. | `docker-compose.yml` |
| SEC-009 | Info | Verify-token comparison is not timing-safe. Low impact because it is only used during the one-time handshake. | `src/routes/whatsapp.js` line 31 |
| SEC-010 | Info | No rate limiting on `/auth/login` (proposal §33). | `src/routes/auth.js` |

---

# Reliability Findings

- RISK-001 (idempotency race) and RISK-002 (in-memory store) are the main reliability issues.
- Processing is synchronous: download, upload, database write and OCR all complete before Meta receives `200`. Proposal §29 requires an immediate acknowledgement with background processing.
- All inner failures return `200`, so Meta will not retry them. This is intended to avoid retry storms, but it also means failed documents are silently dropped. There is no failed-status record yet (proposal §32).
- `createWorker("eng")` is created outside the `try` in `extractTextFromImage`. If worker creation fails, the error still propagates correctly and there is nothing to clean up, so this is acceptable.
- `PDFParse` is destroyed in `finally`, and the Tesseract worker is terminated in `finally`. Cleanup is correct.

---

# Performance Findings

| ID | Finding | Location |
|---|---|---|
| PERF-001 | A new Tesseract worker is created and terminated for every image. Worker start-up (loading WASM and language data) dominates OCR time. | `src/services/ocrService.js` |
| PERF-002 | Tesseract downloads `eng.traineddata` at runtime on first use unless a local `langPath` is configured. The first image after deployment is slow and depends on external network access. | `src/services/ocrService.js` |
| PERF-003 | The full media file is held in memory (up to 10 MB, or more before the size check). Acceptable at current volume. | `src/services/whatsappMediaService.js` |
| PERF-004 | `fs.mkdir(storage/temp)` runs on every upload although local storage is no longer used. | `src/services/temporaryStorageService.js` lines 27–29 |

---

# Code Quality Findings

| ID | Finding | Location |
|---|---|---|
| CQ-001 | The route passes `documentType` to `createTemporaryDocumentRecord`, but the function ignores it and hardcodes `"UNCLASSIFIED"`. This matches Docs/05 and proposal §17 (classification happens after the temporary record), but the unused argument is misleading. | `src/services/temporaryDataService.js`, `src/routes/whatsapp.js` line 165 |
| CQ-002 | Leftover local-storage code (`fs`, `path`, `TEMP_DIRECTORY`, `mkdir`) remains after the Supabase migration. The destructured `data` is unused. | `src/services/temporaryStorageService.js` |
| CQ-003 | `export default router` appears in the middle of `auth.js`, before the `/me` route is registered. It works but reads as if `/me` is outside the router. | `src/routes/auth.js` line 72 |
| CQ-004 | `//////` separator blocks and large blank gaps in the webhook handler. | `src/routes/whatsapp.js` |
| CQ-005 | Mixed-language comments (Sinhala/English) and typos in comments and logs ("temmporary", "webbHook", "procssed", "Minimun"). | several files |
| CQ-006 | Log order is inconsistent: "WhatsApp media downloaded" is logged after the upload and database insert. | `src/routes/whatsapp.js` line 182 |
| CQ-007 | Parameter `MediaId` uses PascalCase. | `src/services/whatsappMediaService.js` line 3 |
| CQ-008 | Inconsistent unknown-type labels: filename classification returns `UNKNOWN`, the temporary record uses `UNCLASSIFIED`. Both are valid but should be documented as separate states. | classification service, temporary data service |
| CQ-009 | The allowed-MIME list and MIME-to-extension mapping are duplicated across `fileValidation.js`, `temporaryStorageService.js` and `ocrService.js`. | several files |
| CQ-010 | `package.json` `"main": "index.js"` does not exist; `npm test` is a placeholder. | `package.json` |
| CQ-011 | `Architecture.txt` is an empty tracked file. | project root |

---

# Database Findings

| ID | Finding |
|---|---|
| DB-001 | BUG-001 (migration contradicts schema). |
| DB-002 | Indexes listed in proposal §10 are not created: `users.whatsapp_number`, `documents.passport_id`, `temporary_data.passport_id`, `temporary_data.whatsapp_number`. Not needed at current volume; needed before dashboard queries. |
| DB-003 | `documents.ocr_confidence` is `DECIMAL(65,30)`. Proposal §40 uses `DECIMAL(5,4)`, which implies a 0–1 scale, while Tesseract returns 0–100. The scale must be decided before values are written. |
| DB-004 | Primary keys are `TEXT` with UUIDs generated in application code (`crypto.randomUUID()`), not by the database. This is consistent across the code and acceptable. |
| DB-005 | `temporary_data` has no timestamp for last update and no failure/status detail column. Status transitions will need to be handled with the existing `processing_status` column. |
| DB-006 | `src/config/prisma-test.js` and `src/utils/password-test.js` are manual scripts inside `src/`. They are not part of the app but are easy to run by mistake. |

---

# Supabase Findings

- The bucket is private and accessed with the service-role key from the server only. **Correct.**
- `upsert: false` prevents silent overwrites. Combined with UUID filenames, collisions are not a concern.
- Storage path convention is `temporary/<uuid><ext>`. It is persisted in `temporary_data.temporary_storage_path`.
- Proposal §25 describes `pending/{identifier}/temporary/...`. The current path does not match. This is a planned change, not a bug; changing it now would break existing records.
- No cleanup exists for orphaned objects (RISK-003) or finalised temporary files (proposal §18, not yet implemented).
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are not validated at start-up. `createClient` throws on a missing URL, which fails at import time with a generic error.

---

# WhatsApp Webhook Findings

- Signature verification is correctly applied only to `POST /webhook`.
- `express.json()` default body limit (100 KB) is appropriate for webhook payloads.
- Status updates (`value.statuses`) and other non-message events are acknowledged with `200` and ignored. **Correct.**
- Only `type: "document"` messages are processed. Images sent as photos (`type: "image"`) are logged and ignored. Users who send a passport photo from their camera will not have it processed. This is a feature gap, not a bug.
- See BUG-002, BUG-003, BUG-006, RISK-001, RISK-002, RISK-007.

---

# OCR Findings

| Area | Current behaviour |
|---|---|
| PDF text extraction | `pdf-parse` v2 `PDFParse.getText()`. Success requires ≥ 30 characters. Parser destroyed in `finally`. Working. |
| Low-text / scanned PDF | Returns `success: false` with (misspelled) `SCANNED_PDF_OCR_REQUIRED`. No fallback OCR yet — documented as roadmap. |
| Image OCR | Tesseract `eng`, JPEG/PNG only. Worker terminated in `finally`. Confidence returned (0–100). Blank images falsely succeed (BUG-005). |
| Error handling | PDF errors are caught and return `success: false`. Image OCR errors propagate to the route's inner `catch`. |
| Large PDFs | All pages are extracted. No page limit. |
| Filename classification | Keyword match on `passport`, `travel document`, `medical`, `health`, `police`, `clearance`. Fixed confidence 50, or 0 for unknown. Random names (e.g. `6325523527323.pdf`) correctly return `UNKNOWN`. |
| Content-based classification | Not implemented. Extracted text is available in the route but not yet used or stored. |
| Confidence handling | Not implemented. The filename confidence (50) is a fixed placeholder and should not be fed into the proposal's confidence bands. |

---

# Proposal vs. Current Implementation

These are **unimplemented or divergent features**, not bugs.

| Area | Proposal | Current |
|---|---|---|
| Webhook route | `POST /webhooks/whatsapp` | `POST /whatsapp/webhook` (configured in Meta; do not change without updating Meta) |
| Temporary storage path | `pending/{identifier}/temporary` (§25) | `temporary/{uuid}{ext}` |
| Undefined / invalid files | Preserved under `pending/{mobile}/undefined/uncleared-docs/` (§16, AC-23) | Logged and dropped |
| Processing model | Immediate ack + background worker (§29) | Synchronous |
| Idempotency | Persistent, returns existing result (§30) | In-memory `Set` |
| Duplicate files | Checksum per client (§31) | Not implemented |
| Confidence bands | > 95 / 90–95 / 60–89 / 40–59 / < 40 (§17) | Not implemented |
| Error model | Structured error codes (§28) | Log strings only |
| Failure status | Recorded with retry state (§32) | Not recorded |
| Identity matching, reconciliation, rename, permanent storage, police-report countdown, dashboard | §12–§22 | Not implemented |

---

# Technical Debt

1. Prisma client 6 / adapter 7 version mismatch and the unused `prisma7.config.ts`.
2. Runtime import of a `.ts` file from JavaScript.
3. In-memory idempotency.
4. Synchronous processing inside the webhook request.
5. Leftover local-storage code.
6. Duplicated MIME constants.
7. No automated tests (`npm test` is a placeholder).
8. Manual test scripts inside `src/`.
9. Unstructured `console.*` logging with no request or message correlation.

---

# Recommended Next Actions

**Immediate (small, low-risk)**

1. BUG-001 — restore the original `migration.sql`, then run `npx prisma migrate status` against Supabase.
2. BUG-002 — replace `res.Status` with `res.sendStatus`.
3. BUG-003 — require `WHATSAPP_VERIFY_TOKEN` to be set before accepting the handshake.
4. BUG-004 / BUG-005 — fix the `mmethod` typo and the `" "` fallback.
5. BUG-006 — use a neutral failure log message and include `messageId`.
6. RISK-001 — mark the message ID as processed immediately after the duplicate check.
7. SEC-002 — mask phone numbers in logs.

**Short term**

8. Align Prisma package versions (all 6.x or all 7.x) and remove or rename `prisma7.config.ts`.
9. Derive the stored extension from the validated MIME type.
10. Add fetch timeouts and a pre-download size check using `file_size` from the Graph API media response.
11. Remove leftover local-storage code in `temporaryStorageService.js`.
12. Decide the `ocr_confidence` scale (0–1 or 0–100).

**Before production**

13. Move document processing to a background job and acknowledge Meta immediately.
14. Persist idempotency in the database using the existing `temporary_data` / `processing_status` design.
15. Store failed and undefined documents under the proposal's `pending/` structure instead of dropping them.
16. Add indexes from proposal §10.
17. Add a basic automated test for the signature middleware and file validation.
