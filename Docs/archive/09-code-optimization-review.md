# Code Optimization Review

This document records the verification-and-fix pass carried out on the backend after the audit in `Docs/08-code-quality-and-bug-report.md`. It lists what was changed, what was left alone on purpose, and what should be tested manually.

---

# Scope

- Verify each finding from the earlier audit against the **current** code.
- Fix only small, confirmed, low-risk bugs.
- Remove confirmed dead code.
- Clean up comments only in files that were already being changed.
- Do **not** change architecture, routes, webhook URLs, environment variable names, database schema, migrations, storage paths, business rules or dependency versions.

No migrations were run, no packages were installed or upgraded, `.env` was not modified, and nothing was committed.

---

# Files Reviewed

| File | Result |
|---|---|
| `src/middleware/verifyWhatsAppSignature.js` | Modified |
| `src/routes/whatsapp.js` | Modified |
| `src/services/ocrService.js` | Modified |
| `src/services/temporaryStorageService.js` | Modified |
| `src/services/temporaryDataService.js` | Reviewed, unchanged |
| `src/services/whatsappMediaService.js` | Reviewed, unchanged |
| `src/services/documentClassificationService.js` | Reviewed, unchanged |
| `src/utils/messageIdempotency.js` | Reviewed, unchanged |
| `src/utils/fileValidation.js` | Reviewed, unchanged |
| `src/utils/whatsappMedia.js` | Reviewed, unchanged |
| `src/config/prisma.js`, `src/config/supabase.js` | Reviewed, unchanged |
| `src/routes/auth.js`, `src/middleware/auth.js` | Reviewed, unchanged |
| `prisma/schema.prisma`, `prisma/migrations/` | Reviewed, unchanged |
| `package.json`, `package-lock.json` | Reviewed, unchanged |
| `.gitignore` | Reviewed, unchanged |

---

# Safe Fixes Applied

| Ref | File | Change | Behaviour impact |
|---|---|---|---|
| BUG-002 | `verifyWhatsAppSignature.js` | Two remaining `res.Status(401)` calls changed to `res.sendStatus(401)`. | Same `401` response. Logs now show "Invalid WhatsApp webhook signature" instead of "res.Status is not a function". |
| BUG-003 | `whatsapp.js` | GET verification requires `WHATSAPP_VERIFY_TOKEN` to be set before comparing tokens. | Unset token now returns `403` (was `200`). No change when the token is configured. |
| BUG-006 | `whatsapp.js` | Inner catch logs `"WhatsApp document processing failed"` with `{ messageId, error }`. | Log text only. |
| SEC-002 | `whatsapp.js` | New local helper `maskPhoneNumber()`. Sender numbers in three log lines are masked to the last 4 digits (`*******4567`). | Log output only. The full number is still saved to `temporary_data.whatsapp_number`. |
| BUG-004 | `ocrService.js` | `mmethod` → `method` in the scanned-PDF result. | Logs now show `SCANNED_PDF_OCR_REQUIRED` instead of `undefined`. |
| BUG-005 | `ocrService.js` | Image OCR fallback text changed from `" "` to `""`. | Blank images now return `success: false`. Success rule itself unchanged. |
| CQ-002 / PERF-004 | `temporaryStorageService.js` | Removed `fs` import, `TEMP_DIRECTORY`, `fs.mkdir(...)` and unused `data`. | The local `storage/temp` folder is no longer created. Supabase upload unchanged. |
| CQ-004 / CQ-005 | all four files | Removed `////` separators and blank gaps; replaced Sinhala and verbose comments with short English ones; fixed log typos ("temmporary", "webHook", "webbHook"). | None. |

### Checks performed

These were run locally with mock requests or a stubbed `fetch`. No server, database, Supabase or Meta calls were made.

| Area | Cases checked | Result |
|---|---|---|
| Signature middleware | missing secret, missing header, missing raw body, wrong length, wrong secret, valid | `500`, `401`, `400`, `401`, `401`, `next()` |
| Webhook GET | token unset, correct token, wrong token, wrong mode | `403`, `200` + challenge, `403`, `403` |
| OCR service | invalid PDF bytes, unsupported MIME | `SCANNED_PDF_OCR_REQUIRED`, `UNSUPPORTED_DOCUMENT_TYPE` |
| Temporary storage | PDF with extension, PNG without extension, JPEG without filename | `temporary/<uuid>.pdf`, `.png`, `.jpeg` sent to the configured bucket |
| Phone masking | 11 digits, 4 digits, `undefined`, `null`, number type | `*******4567`, `****`, unchanged, unchanged, `*******4567` |
| All modified files | `node --check` | Pass |

Image OCR and the full POST document flow were **not** tested, because they need Tesseract language data, Meta, Supabase and the database. See the manual checklist below.

---

# Issues Already Fixed Before This Review

| Ref | Detail |
|---|---|
| BUG-002 (partial) | The missing-secret branch in `verifyWhatsAppSignature.js` had already been changed from `res.Status(500)` to `res.sendStatus(500)` (uncommitted at the time of review). The two `401` branches were still broken and were fixed in this review. |

---

# Issues Deferred

| Ref | Issue | Reason deferred |
|---|---|---|
| RISK-001 | Idempotency race: message marked processed only after the full flow. | Changes retry behaviour; needs a decision. |
| RISK-002 | In-memory idempotency `Set`. | Needs a persistent design (proposal §30). |
| RISK-003 | Orphaned storage objects when the DB insert fails. | Needs cleanup or retry design. |
| RISK-007 | Only the first message per event is processed. | Changes processing flow. |
| BUG-007 | Corrupt PDFs reported as scanned PDFs. | Best done together with scanned-PDF OCR. |
| SEC-003 | Original filenames logged. | Needed for debugging filename classification. |
| SEC-004 | No magic-byte MIME validation. | New feature. |
| SEC-005 | Stored extension from sender's filename. | Changes stored file names. |
| SEC-006 | Size checked after download. | Needs Graph API `file_size` handling. |
| PERF-001 / PERF-002 | Tesseract worker per image; runtime language download. | Performance work, not a bug. |
| CQ-001 | Unused `documentType` argument. | Business rule (`UNCLASSIFIED` first) is intentional; only needs a comment or cleanup later. |

---

# Database/Migration Warning

`prisma/migrations/20260921064444_init_schema/migration.sql` was **edited after it was created**:

- Created in `f68fd0f` (2026-09-21) with nullable `temporary_data.passport_id`, `unique_id`, `whatsapp_number` and `users.first_name`, matching `schema.prisma`.
- Changed to `NOT NULL` in `34e3bb0` (2026-09-23). `schema.prisma` still has them nullable.
- The current code (`createTemporaryDocumentRecord`) never sets `passport_id` or `unique_id`, so it needs them to be nullable. The proposal agrees.

A fresh database built from the current file would reject every temporary record. The live Supabase DB appears to be nullable because inserts work, but this has not been confirmed.

**Nothing was changed.** Manual steps are listed under BUG-001 in `Docs/08-code-quality-and-bug-report.md`. In short:

```bash
# Read-only checks first
npx prisma migrate status
# Then, only if the live columns are nullable:
git checkout f68fd0f -- prisma/migrations/20260921064444_init_schema/migration.sql
```

Never run `prisma migrate reset` or `prisma migrate dev` against the shared Supabase database.

---

# Prisma Version Warning

| Package | Installed | Source |
|---|---|---|
| `prisma` | 6.19.3 | `package.json`, `package-lock.json` |
| `@prisma/client` | 6.19.3 | `package.json`, `package-lock.json`; generated client reports `clientVersion: 6.19.3` |
| `@prisma/adapter-pg` | **7.10.0** | `package.json` (`^7.10.0`), `package-lock.json`; depends on `@prisma/driver-adapter-utils` 7.10.0 |

The driver adapter is one major version ahead of the client. It works today, but adapter interfaces change between major versions, so a reinstall or client regeneration could break database access.

| Option | Command / change | Risk | Keeps `src/config/prisma.js` unchanged |
|---|---|---|---|
| **A — recommended** | `npm i @prisma/adapter-pg@6.19.3 --save-exact` | Low–Medium | Yes |
| B | Upgrade all Prisma packages to 7.x | High (Prisma 7 removes `url` from `schema.prisma`, requires `prisma.config.ts`, and a client regenerate) | No |
| C | Leave as is | Mixed-major setup remains | Yes |

Also note: `prisma7.config.ts` is not loaded by Prisma 6, which looks for `prisma.config.ts`.

**No package versions were changed.**

---

# Security Notes

| Check | Result |
|---|---|
| `.env` ignored | Yes (`.gitignore` line 4); no env file tracked |
| Access token, service-role key, app secret, JWT secret logged | No. Only the variable *name* `META_APP_SECRET` is logged when it is missing |
| Webhook raw body used for HMAC | Yes |
| Timing-safe signature comparison | Yes, with a length check first |
| Unsigned / wrongly signed webhooks rejected | Yes (`401`) |
| Webhook GET with unset verify token | Rejected (`403`) after this review |
| Private bucket, no public URLs | Yes |
| Full phone numbers in logs | Masked after this review |
| Original filenames in logs | Still logged (deferred) |
| Document text in logs | No, length only |
| MIME trusted from sender | Yes (deferred; magic-byte check not implemented) |
| Extension from sender filename | Yes (deferred) |
| SQL injection | No path found; Prisma is parameterised |
| Path traversal | No; stored names are UUID-based |

---

# Regression Risks

| Change | What could go wrong | How to spot it |
|---|---|---|
| Verify-token check | If `WHATSAPP_VERIFY_TOKEN` is missing in an environment, Meta re-verification now fails with `403`. | Meta dashboard reports verification failure. Set the variable. |
| Signature `401` responses | None expected; the status code was already `401`. | Invalid-signature log line text changed. |
| Blank OCR result | Anything relying on image OCR always succeeding now sees `success: false`. Nothing consumes this yet. | "Document text extraction result" log. |
| Local storage removal | Anything expecting `storage/temp` to exist. Nothing in `src/` uses it. | Error mentioning `storage/temp`. |
| Phone masking | Anyone searching logs by full phone number will not find matches. | Search by `messageId` or `temporaryId` instead. |

---

# Manual Test Checklist

Mark each item only after running it.

**Server and auth**
- [ ] `GET /health` returns `200` with `status: "OK"`.
- [ ] `POST /auth/login` with valid credentials returns a token.
- [ ] `POST /auth/login` with a wrong password returns `401 Invalid email or password`.
- [ ] `GET /auth/me` with a valid token returns the admin profile.
- [ ] `GET /auth/me` with no token or an invalid token returns `401`.

**Webhook verification**
- [ ] `GET /whatsapp/webhook?hub.mode=subscribe&hub.verify_token=<correct>&hub.challenge=abc` returns `200 abc`.
- [ ] Same request with a wrong token returns `403`.
- [ ] With `WHATSAPP_VERIFY_TOKEN` temporarily removed, the request returns `403`.

**Webhook signature**
- [ ] A real WhatsApp message is accepted (no "Invalid WhatsApp webhook signature" log).
- [ ] A POST with a wrong `X-Hub-Signature-256` returns `401` and logs "Invalid WhatsApp webhook signature".
- [ ] A POST with no signature header returns `401`.

**Messages and documents**
- [ ] A text message logs "WhatsApp Message Parsed" with a masked `senderNumber`.
- [ ] A text-based PDF is downloaded, passes validation, and logs "WhatsApp document validation passed".
- [ ] The PDF appears in the Supabase bucket under `temporary/<uuid>.pdf`.
- [ ] A `temporary_data` row is created with `document_type = UNCLASSIFIED`, `processing_status = TEMPORARY_STORED`, and the full WhatsApp number.
- [ ] The "Temporary document record created" log shows a masked `whatsappNumber`.
- [ ] The filename classification log shows the expected type for a named file (e.g. `passport.pdf` → `PASSPORT`) and `UNKNOWN` for a random name.
- [ ] A text-based PDF logs `method: "PDF_TEXT", success: true`.
- [ ] A scanned PDF logs `method: "SCANNED_PDF_OCR_REQUIRED", success: false`.
- [ ] A JPEG with visible text logs `method: "OCR", success: true` with a confidence value.
- [ ] A blank white PNG logs `method: "OCR", success: false`.
- [ ] An unsupported file type (e.g. `.docx`) logs "WhatsApp document validation failed" with `UNSUPPORTED_FILE_TYPE`.
- [ ] A file larger than 10 MB logs `FILE_TOO_LARGE`.
- [ ] No `storage/temp` folder is created in the project directory.

**Duplicates and errors**
- [ ] Re-sending the same webhook payload (same `messageId`) after it finished logs "Duplicate WhatsApp message ignored".
- [ ] With `SUPABASE_BUCKET` set to a wrong value, a PDF logs "WhatsApp document processing failed" with the `messageId`, and the webhook still returns `200`.

---

# Suggested Next Actions

1. Run the manual checklist above, at least the webhook and PDF sections.
2. The code fixes are committed as `2900e50`, `ffb770b`, `69d7adc` and `4917155`. Commit these two documents as:
   ```
   docs: update code quality and optimization reports
   ```
3. Resolve BUG-001 using the read-only checks in Docs/08.
4. Decide on Prisma version alignment (Option A recommended).
5. Decide whether to move `markMessageAsProcessed` to just after the duplicate check (RISK-001).
