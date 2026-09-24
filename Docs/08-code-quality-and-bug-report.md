# Code Quality and Bug Report

**Scope:** `src/`, `prisma/`, `package.json`, `package-lock.json`, installed dependency versions, `.gitignore`
**Reference:** `Docs/WhatsApp_Document_Processing_Project_Proposal_Final.md`
**Audit type:** Static code review, followed by a verification pass against the current code.
**Last updated:** After the fixes described in `Docs/09-code-optimization-review.md`.

### Status legend

| Status | Meaning |
|---|---|
| **Fixed** | Fixed in the latest review (see Docs/09) |
| **Already Fixed** | Fixed manually before the latest review |
| **Open** | Still present; small enough to fix but needs a decision or approval first |
| **Deferred** | Still present; intentionally postponed because it needs a larger or riskier change |

---

# Executive Summary

The WhatsApp document intake flow is structurally sound. Webhook signatures are verified against the raw body with a timing-safe comparison, the Supabase bucket is private and accessed only from the server, Prisma queries are parameterised, and no secrets are written to logs.

| ID | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-001 | High | Database | Migration file edited after creation; contradicts schema and proposal | **Open** (needs manual DB check) |
| BUG-002 | Medium | Webhook security | `res.Status()` is not a function in signature middleware | **Fixed** (1 of 3 calls Already Fixed) |
| BUG-003 | Medium | Webhook security | GET verification passes when `WHATSAPP_VERIFY_TOKEN` is unset | **Fixed** |
| BUG-004 | Low | OCR | Typo `mmethod` in scanned-PDF result | **Fixed** |
| BUG-005 | Low | OCR | Blank OCR output is reported as `success: true` | **Fixed** |
| BUG-006 | Low | Logging | Every processing failure logged as "media download failed" | **Fixed** |
| BUG-007 | Low | OCR | Corrupt PDFs are reported the same way as scanned PDFs | **Open** (new) |

The largest remaining risks are the **idempotency race** (processing runs before the webhook responds), **in-memory idempotency** that is lost on restart, the **migration file mismatch** (BUG-001), and the **Prisma client/adapter major-version mismatch**.

Features the proposal describes but that are not built yet are listed under [Proposal vs. Current Implementation](#proposal-vs-current-implementation). They are not treated as bugs.

---

# Confirmed Bugs

## BUG-001 — Migration file contradicts schema and proposal

**Severity:** High
**File:** `prisma/migrations/20260921064444_init_schema/migration.sql`
**Function:** n/a (SQL migration)
**Status:** Open — requires a manual check of the live database before any change

**Problem**
The migration was created in commit `f68fd0f` (2026-09-21) with nullable columns that matched `schema.prisma`. Commit `34e3bb0` (2026-09-23) later edited the same migration and changed these columns to `NOT NULL`. `schema.prisma` was not changed.

| Table | Column | `schema.prisma` | `migration.sql` (current) | Original migration (`f68fd0f`) | Proposal §9 / §40 |
|---|---|---|---|---|---|
| `temporary_data` | `passport_id` | nullable | `NOT NULL` | nullable | nullable |
| `temporary_data` | `unique_id` | nullable | `NOT NULL` | nullable | nullable |
| `temporary_data` | `whatsapp_number` | nullable | `NOT NULL` | nullable | nullable |
| `users` | `first_name` | nullable | `NOT NULL` | nullable | nullable |

**Why it matters**
- `createTemporaryDocumentRecord()` never sets `passport_id` or `unique_id`. On any database built from the current migration file, every temporary record insert fails and the uploaded file is left without a record.
- Editing an applied migration changes its checksum, so `prisma migrate` reports drift and may suggest a reset.
- Real inserts currently work against Supabase, which suggests the live tables are nullable (likely created with `db push` or from the original file). This has not been confirmed.

**How to reproduce**
1. Create an empty PostgreSQL database.
2. Run `npx prisma migrate deploy`.
3. Send a valid WhatsApp PDF.
4. The insert into `temporary_data` fails with a `NOT NULL` violation on `passport_id`.

**Recommended fix (manual — do not run `migrate reset` or `migrate dev` against Supabase)**
```bash
# 1. Check the live columns (read-only) in the Supabase SQL editor:
#    SELECT table_name, column_name, is_nullable FROM information_schema.columns
#    WHERE table_name IN ('temporary_data','users')
#      AND column_name IN ('passport_id','unique_id','whatsapp_number','first_name');

# 2. Check Prisma's view (read-only):
npx prisma migrate status

# 3. If the live columns are nullable, restore the original migration file:
git checkout f68fd0f -- prisma/migrations/20260921064444_init_schema/migration.sql

# 4. If migrate status reports the migration as not applied (DB created with db push),
#    mark it as applied without running it:
npx prisma migrate resolve --applied 20260921064444_init_schema

# 5. Confirm:
npx prisma migrate status
```

---

## BUG-002 — `res.Status()` called in signature middleware

**Severity:** Medium
**File:** `src/middleware/verifyWhatsAppSignature.js`
**Function:** `verifyWhatsappSignature`
**Status:** Fixed

**Problem**
Three branches called `res.Status(...)`, which does not exist in Express. The invalid-signature branches returned `401` only because the resulting `TypeError` was caught. The missing-secret branch fell through to Express's default error page.

**Why it matters**
Misconfiguration produced an unclear error page, and invalid signatures logged `res.Status is not a function` instead of a clear warning.

**How to reproduce (before the fix)**
Send a webhook POST with a wrong signature of the correct length, then check the logs.

**Fix applied**
- Missing-secret branch changed to `res.sendStatus(500)` — **Already Fixed** manually before the review.
- Both invalid-signature branches changed to `res.sendStatus(401)` — **Fixed**.

---

## BUG-003 — Webhook GET verification passes when verify token is unset

**Severity:** Medium
**File:** `src/routes/whatsapp.js`
**Function:** `GET /webhook` handler
**Status:** Fixed

**Problem**
`token === process.env.WHATSAPP_VERIFY_TOKEN` was true when both were `undefined`, so a misconfigured server accepted any handshake and echoed `hub.challenge` back as HTML.

**How to reproduce (before the fix)**
Unset `WHATSAPP_VERIFY_TOKEN`, then `GET /whatsapp/webhook?hub.mode=subscribe&hub.challenge=test123` → `200 test123`.

**Fix applied**
```js
const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN;
if (expectedToken && mode === "subscribe" && token === expectedToken) { ... }
```
The request now returns `403` when the token is not configured. Behaviour with a configured token is unchanged.

---

## BUG-004 — Typo `mmethod` in scanned-PDF result

**Severity:** Low
**File:** `src/services/ocrService.js`
**Function:** `extractDocumentText`
**Status:** Fixed

**Problem**
The scanned-PDF branch returned `mmethod` instead of `method`, so logs showed `method: undefined`, and future scanned-PDF handling could not match on it.

**Fix applied**
Key renamed to `method`.

---

## BUG-005 — Blank OCR output reported as success

**Severity:** Low
**File:** `src/services/ocrService.js`
**Function:** `extractTextFromImage`
**Status:** Fixed

**Problem**
The fallback text was `" "`, so `text.length > 0` was always true, even for blank images.

**Fix applied**
Fallback changed to `""`. The success rule (`text.length > 0`) was kept as is. The PDF minimum of 30 characters was not applied to images, because that would change which results count as a success.

---

## BUG-006 — All processing failures logged as "media download failed"

**Severity:** Low
**File:** `src/routes/whatsapp.js`
**Function:** `POST /webhook` handler (inner `catch`)
**Status:** Fixed

**Problem**
The inner `try` covers media lookup, download, validation, upload, database insert and OCR, but every failure was logged as a download failure, with no `messageId`.

**Fix applied**
```js
console.error("WhatsApp document processing failed:", { messageId, error: error.message });
```

---

## BUG-007 — Corrupt PDFs reported as scanned PDFs

**Severity:** Low
**File:** `src/services/ocrService.js`
**Function:** `extractDocumentText`
**Status:** Open (found during verification)

**Problem**
When `pdf-parse` fails (for example "Invalid PDF structure"), `extractTextFromPdf` returns `success: false`, and `extractDocumentText` then reports `method: "SCANNED_PDF_OCR_REQUIRED"`. A corrupt file cannot be told apart from a genuine scanned PDF.

**Why it matters**
When scanned-PDF OCR is added, corrupt files will be sent to OCR instead of being flagged as corrupt (proposal §32 treats corrupt files separately).

**How to reproduce**
Send a file with a `.pdf` name and `application/pdf` MIME type that is not a valid PDF. The log shows `method: "SCANNED_PDF_OCR_REQUIRED"`, preceded by "PDF text extraction failed: Invalid PDF structure."

**Recommended fix**
Return a distinct result (for example an `error` flag or a `PDF_PARSE_FAILED` method) from the `catch` in `extractTextFromPdf`, and pass it through in `extractDocumentText`. This should be done together with the scanned-PDF OCR work so the new value has a consumer.

---

# Potential Risks

| ID | Risk | Location | Status |
|---|---|---|---|
| RISK-001 | **Idempotency race.** `isMessageProcessed` is checked at `whatsapp.js` line 70, but `markMessageAsProcessed` is called only at line 194, after download, upload, database insert and OCR. If Meta retries during that window, the retry passes the duplicate check and the document is uploaded and recorded twice. | `src/routes/whatsapp.js` | Deferred |
| RISK-002 | **In-memory idempotency.** `processedMessageIds` is a module-level `Set`. It is cleared on restart, not shared between instances, and never shrinks. | `src/utils/messageIdempotency.js` | Deferred |
| RISK-003 | **Orphaned storage objects.** If the upload succeeds but the database insert fails, the file stays in the bucket without a record. | `src/routes/whatsapp.js` | Deferred |
| RISK-004 | **Prisma major-version mismatch.** `prisma` 6.19.3 and `@prisma/client` 6.19.3 (generated `clientVersion: 6.19.3`), but `@prisma/adapter-pg` 7.10.0 (depends on `@prisma/driver-adapter-utils` 7.10.0). | `package.json` | Open (needs approval) |
| RISK-005 | **Unused Prisma 7 config.** Prisma 6 loads `prisma.config.ts`, not `prisma7.config.ts`, so this file has no effect. | project root | Open |
| RISK-006 | **Node version dependency.** `src/config/prisma.js` imports `generated/prisma/client.ts`, which only works on Node ≥ 22.18 (native type stripping). | `src/config/prisma.js` | Open |
| RISK-007 | **Only the first message is processed.** `entry[0].changes[0].messages[0]`; further messages in a batched event are ignored. | `src/routes/whatsapp.js` | Deferred |
| RISK-008 | **No fetch timeout** on Graph API and media download calls. | `src/services/whatsappMediaService.js` | Open |
| RISK-009 | **No check that `SUPABASE_BUCKET` is set.** An unset bucket name produces an unclear Supabase error. | `src/services/temporaryStorageService.js` | Open |

---

# Security Findings

**Verified as correct**

- `.env` is ignored (`.gitignore` line 4) and no env file is tracked.
- HMAC-SHA256 is computed on the raw request body (`express.json({ verify })` in `src/app.js`).
- `crypto.timingSafeEqual` is used, guarded by a length check.
- The access token, app secret, JWT secret and Supabase service-role key are never logged. The only match logs the *name* `META_APP_SECRET` when it is missing.
- The Supabase client is server-side only with `persistSession: false`.
- No public or signed URLs are generated for stored documents.
- Prisma queries are parameterised; no SQL injection path.
- No user input is used to build regular expressions.
- Stored filenames are UUID-based, so the sender's filename cannot cause path traversal.
- Extracted document text is not logged (only its length).
- Admin login returns the same error for unknown email and wrong password.

| ID | Severity | Finding | Status |
|---|---|---|---|
| SEC-001 | Medium | BUG-002 and BUG-003 | Fixed |
| SEC-002 | Low | Full WhatsApp phone numbers were logged. Now masked to the last 4 digits in all log lines (`maskPhoneNumber` in `whatsapp.js`). The full number is still stored in `temporary_data.whatsapp_number`. | Fixed |
| SEC-003 | Low | Original filenames are logged (`whatsapp.js` lines 111, 157, 189). They can contain names or passport numbers. Kept for now because they are needed to debug filename classification. | Open |
| SEC-004 | Low | MIME type is taken from the sender (`message.document.mime_type`); file content (magic bytes) is not checked. | Deferred |
| SEC-005 | Low | Stored extension comes from the sender's filename, not the validated MIME type (`temporaryStorageService.js` line 13). `x.exe` sent as `application/pdf` is stored as `<uuid>.exe`. Changing this changes stored names. | Deferred |
| SEC-006 | Low | File size is checked after the full download; the whole file is buffered in memory first. | Deferred |
| SEC-007 | Info | `src/utils/password-test.js` contains the literal password `Admin#123`. Confirm this is not a real admin password. | Open |
| SEC-008 | Info | `docker-compose.yml` contains local development database credentials. Acceptable for local use only. | Open |
| SEC-009 | Info | Verify-token comparison is not timing-safe. Low impact (one-time handshake only). | Deferred |
| SEC-010 | Info | No rate limiting on `/auth/login` (proposal §33). | Deferred |

---

# Reliability Findings

- RISK-001 and RISK-002 are the main reliability issues.
- Processing is synchronous: download, upload, database insert and OCR complete before Meta receives `200`. Proposal §29 requires an immediate acknowledgement with background processing.
- All inner failures return `200`, so Meta does not retry them. This avoids retry storms, but failed documents are dropped without a failed-status record (proposal §32).
- PDF parser (`parser.destroy()`) and Tesseract worker (`worker.terminate()`) are cleaned up in `finally` blocks. Correct.

---

# Performance Findings

| ID | Finding | Status |
|---|---|---|
| PERF-001 | A new Tesseract worker is created and terminated for every image. | Deferred |
| PERF-002 | Tesseract downloads `eng.traineddata` at runtime unless a local `langPath` is configured. The first image after deployment is slow and needs outbound network access. | Deferred |
| PERF-003 | The full media file is held in memory (up to 10 MB after validation, more before). Acceptable at current volume. | Deferred |
| PERF-004 | `fs.mkdir(storage/temp)` ran on every upload although local storage was no longer used. | Fixed |

---

# Code Quality Findings

| ID | Finding | Status |
|---|---|---|
| CQ-001 | The route passes `documentType` to `createTemporaryDocumentRecord`, but the function stores `"UNCLASSIFIED"`. This matches Docs/05 and proposal §17 (classification happens after the temporary record), but the unused argument is misleading. | Open |
| CQ-002 | Leftover local-storage code (`fs`, `TEMP_DIRECTORY`, `mkdir`) and unused `data` in `temporaryStorageService.js`. | Fixed |
| CQ-003 | `export default router` appears before the `/me` route in `auth.js`. Works, but reads confusingly. | Open |
| CQ-004 | `//////` separator blocks and large blank gaps in the webhook handler. | Fixed |
| CQ-005 | Mixed-language comments and typos. Cleaned in `whatsapp.js`, `verifyWhatsAppSignature.js`, `ocrService.js`, `temporaryStorageService.js`. Remaining files not yet reviewed for comments. | Partly Fixed |
| CQ-006 | Log order: "WhatsApp media downloaded" is logged after the upload and database insert. Left as is to avoid changing log output. | Open |
| CQ-007 | Parameter `MediaId` uses PascalCase in `whatsappMediaService.js`. | Open |
| CQ-008 | Two unknown-type labels: filename classification returns `UNKNOWN`, the temporary record uses `UNCLASSIFIED`. Both are valid but should stay documented as separate states. | Open |
| CQ-009 | Allowed MIME list and MIME-to-extension mapping are duplicated across `fileValidation.js`, `temporaryStorageService.js` and `ocrService.js`. | Deferred |
| CQ-010 | `package.json` `"main": "index.js"` does not exist; `npm test` is a placeholder. | Open |
| CQ-011 | `Architecture.txt` is an empty tracked file. | Open |

---

# Database Findings

| ID | Finding | Status |
|---|---|---|
| DB-001 | BUG-001 (migration contradicts schema). | Open |
| DB-002 | Indexes from proposal §10 are not created: `users.whatsapp_number`, `documents.passport_id`, `temporary_data.passport_id`, `temporary_data.whatsapp_number`. | Deferred |
| DB-003 | `documents.ocr_confidence` is `DECIMAL(65,30)`. The proposal uses `DECIMAL(5,4)` (0–1 scale), while Tesseract returns 0–100. The scale must be decided before values are stored. | Open |
| DB-004 | Primary keys are `TEXT` with UUIDs generated in application code. Consistent and acceptable. | — |
| DB-005 | `temporary_data` has no updated-at or failure-detail column. Status changes must use `processing_status`. | Deferred |
| DB-006 | `src/config/prisma-test.js` and `src/utils/password-test.js` are manual scripts inside `src/`. | Open |

---

# Supabase Findings

- The bucket is private and accessed with the service-role key from the server only. Correct.
- `upsert: false` prevents silent overwrites. With UUID filenames, collisions are not a concern.
- Storage path convention is `temporary/<uuid><ext>`, persisted in `temporary_data.temporary_storage_path`. Unchanged by this review.
- Proposal §25 describes `pending/{identifier}/temporary/...`. This is a planned change, not a bug; changing it now would break existing records.
- No cleanup exists for orphaned objects (RISK-003).
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are not validated at start-up.

---

# WhatsApp Webhook Findings

- Signature verification is applied only to `POST /webhook`. Correct.
- `express.json()` default body limit (100 KB) is appropriate for webhook payloads.
- Status updates and other non-message events are acknowledged with `200` and ignored. Correct.
- Only `type: "document"` messages are processed. Photos sent as `type: "image"` are logged and ignored. This is a feature gap, not a bug.
- See BUG-002, BUG-003, BUG-006 (fixed), RISK-001, RISK-002, RISK-007.

---

# OCR Findings

| Area | Current behaviour |
|---|---|
| PDF text extraction | `pdf-parse` v2 `PDFParse.getText()`. Success requires ≥ 30 characters. Parser destroyed in `finally`. |
| Low-text / scanned PDF | Returns `success: false, method: "SCANNED_PDF_OCR_REQUIRED"`. No OCR fallback yet (roadmap). |
| Corrupt PDF | Reported the same as scanned (BUG-007). |
| Image OCR | Tesseract `eng`, JPEG/PNG only. Worker terminated in `finally`. Confidence returned (0–100). Blank images now return `success: false`. |
| Error handling | PDF errors are caught and return `success: false`. Image OCR errors go to the route's inner `catch`. |
| Large PDFs | All pages are extracted; no page limit. |
| Filename classification | Keyword match on `passport`, `travel document`, `medical`, `health`, `police`, `clearance`. Fixed confidence 50, or 0 for unknown. Random names such as `6325523527323.pdf` return `UNKNOWN`. |
| Content-based classification | Not implemented. Extracted text is available in the route but not stored or used. |
| Confidence handling | Not implemented. The filename confidence (50) is a placeholder and should not be fed into the proposal's confidence bands. |

---

# Proposal vs. Current Implementation

These are unimplemented or divergent features, not bugs.

| Area | Proposal | Current |
|---|---|---|
| Webhook route | `POST /webhooks/whatsapp` | `POST /whatsapp/webhook` (registered in Meta; do not change without updating Meta) |
| Temporary storage path | `pending/{identifier}/temporary` (§25) | `temporary/{uuid}{ext}` |
| Undefined / invalid files | Preserved under `pending/{mobile}/undefined/uncleared-docs/` (§16, AC-23) | Logged and dropped |
| Processing model | Immediate acknowledgement + background worker (§29) | Synchronous |
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
5. Duplicated MIME constants.
6. No automated tests (`npm test` is a placeholder).
7. Manual test scripts inside `src/`.
8. Unstructured `console.*` logging.

---

# Recommended Next Actions

**Needs your decision or a manual step**

1. BUG-001 — run the read-only checks above, then restore the original `migration.sql` if the live DB is nullable.
2. RISK-004 — align Prisma packages. Recommended: `npm i @prisma/adapter-pg@6.19.3 --save-exact` (keeps `src/config/prisma.js` unchanged). See Docs/09.
3. SEC-007 — confirm `Admin#123` is not a real password.

**Small follow-ups**

4. RISK-001 — mark the message as processed right after the duplicate check.
5. BUG-007 — distinguish corrupt PDFs from scanned PDFs (with the scanned-PDF OCR work).
6. RISK-008 / RISK-009 — fetch timeouts and a `SUPABASE_BUCKET` check.
7. SEC-005 — derive the stored extension from the validated MIME type.
8. DB-003 — decide the `ocr_confidence` scale.

**Before production**

9. Move document processing to a background job and acknowledge Meta immediately.
10. Persist idempotency in the database.
11. Store failed and undefined documents under the proposal's `pending/` structure.
12. Add the indexes from proposal §10.
13. Add automated tests for the signature middleware and file validation.
