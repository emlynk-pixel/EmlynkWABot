# Current Security Features

Snapshot of the security controls in the codebase after Phase 7 and the first security fixes (SEC-001, SEC-002). Based on the current code and the verified audit; nothing planned is listed as implemented.

## 1. Authentication

| Control | Where |
|---|---|
| Admin login issues a JWT signed with `JWT_SECRET` (strong random value, verified by length/character set only) | `src/routes/auth.js` |
| Tokens expire after **1 hour** | `src/routes/auth.js` |
| Protected routes require `Authorization: Bearer <token>` | `src/middleware/auth.js` |
| Missing, malformed, expired or `alg: none` tokens are rejected with 401 (verified) | `src/middleware/auth.js` |
| Passwords hashed with **bcrypt** (10 rounds) | `src/utils/password.js` |
| `/auth/me` returns profile fields only; the password hash is never returned | `src/routes/auth.js` |
| Unknown email and wrong password get the same message: "Invalid email or password" | `src/routes/auth.js` |

## 2. WhatsApp Webhook Security

| Control | Where |
|---|---|
| Meta verification handshake; refused (403) if `WHATSAPP_VERIFY_TOKEN` is not set | `src/routes/whatsapp.js` |
| `X-Hub-Signature-256` checked on every POST with **HMAC SHA-256** over the **raw request body** | `src/middleware/verifyWhatsAppSignature.js`, `src/app.js` |
| **Timing-safe** comparison (`crypto.timingSafeEqual`, length checked first) | `src/middleware/verifyWhatsAppSignature.js` |
| Missing or invalid signature → 401; missing app secret → 500; nothing is processed | `src/middleware/verifyWhatsAppSignature.js` |
| Duplicate message IDs ignored (in memory only, see §10) | `src/utils/messageIdempotency.js` |
| Only `document` and `image` messages are processed | `src/utils/whatsappMedia.js` |

## 3. File Upload Security

| Control | Where |
|---|---|
| Allowed types: `application/pdf`, `image/jpeg`, `image/png` | `src/utils/fileValidation.js` |
| **10 MB** maximum | `src/utils/fileValidation.js` |
| **Meta metadata pre-check**: reported size > 10 MB or unsupported type → rejected **before** download (SEC-002) | `src/services/whatsappMediaService.js` |
| **Bounded streaming download**: `Content-Length` checked, body read in chunks and cancelled past 10 MB (SEC-002) | `src/services/whatsappMediaService.js` |
| **Timeouts**: 10 s metadata, 30 s download (including body) (SEC-002) | `src/services/whatsappMediaService.js` |
| Size/type re-checked after download | `src/routes/whatsapp.js` |
| Extension from the validated MIME type for `clients/` and `pending/` copies | `src/utils/storageNaming.js` |
| Original filenames sanitized: no directories, `..`, slashes, control characters or leading dots; length capped | `src/utils/storageNaming.js` |
| IDs used in paths restricted to `[A-Za-z0-9_-]` (path traversal blocked) | `src/utils/storageNaming.js` |
| Copies never overwrite (`exists()` check + collision handling) | `src/services/permanentStorageService.js` |
| SHA-256 of the downloaded bytes, calculated once, never taken from the sender | `src/utils/fileChecksum.js`, `src/routes/whatsapp.js` |

## 4. Document Storage Security

| Control | Status |
|---|---|
| Bucket `emlynk-documents` is **private** | Verified (`public: false`) |
| Storage objects: RLS on, no public policies | Verified |
| No public or signed URLs are generated anywhere in the code | Verified |
| Client files: `clients/{passport_id}/…` | Implemented |
| Pending files: `pending/{unique_id}/…` or `pending/unidentified/{temporary_id}/…` | Implemented |
| WhatsApp numbers never appear in storage paths | Implemented + tested |
| Temporary uploads kept until Phase 8 | Implemented |
| A permanent copy is removed again if its database row can't be written | Implemented + tested |

## 5. Database Security

| Control | Status |
|---|---|
| **RLS enabled** on `users`, `admins`, `documents`, `temporary_data`, `_prisma_migrations`, with no policies (SEC-001) | Fixed, verified live |
| **All rights revoked** from Supabase's `anon` / `authenticated` roles; also for future tables created by our migrations (SEC-001) | Fixed, verified live |
| Backend (Prisma, role `postgres`) unaffected: owns the tables and bypasses RLS | Verified by live smoke test |
| Forward-only migration: `20260924140000_restrict_public_database_access` | Applied |
| Prisma parameterized queries; no raw SQL in the application | Implemented |
| Client-scoped checksum uniqueness: unique `(passport_id, file_sha256)` | Implemented |
| Required fields: `users.first_name`, `temporary_data.whatsapp_number` (`users.whatsapp_number` stays optional) | Implemented |
| Only listed `temporary_data` columns can be updated | `src/services/temporaryDataService.js` |

## 6. Identity and Conflict Protection

- Passport ID lookup on `users.passport_id`; `unique_id` is never used instead.
- WhatsApp lookup; stored numbers are never rewritten.
- Identity conflicts (passport and WhatsApp point at different clients) and ambiguous matches are never merged or linked.
- `first_name` is compare-only; no existing value is ever overwritten; missing fields are filled only for a verified match with confidence ≥ 90.
- Duplicate and cross-client checksum checks run **before** reconciliation, so a duplicate or another client's file never changes a client record.
- Same file under another client → `CONFLICT`, stored in `pending/unidentified/…`, no `documents` row, not linked.
- `CONFLICT` and `MANUAL_REVIEW` documents never enter a client folder automatically.

Main files: `src/services/identityVerificationService.js`, `fieldReconciliationService.js`, `documentChecksumService.js`, `storagePlacementService.js`.

## 7. Privacy and Logging

- `.env` is ignored by Git and has never been committed (history checked); documentation only contains placeholders.
- Test fixtures and test data are synthetic.
- The document-processing log summary contains statuses, scores and field names only: no passport numbers, names, phone numbers, checksums or storage paths (tested).
- Extracted document text is never logged; phone numbers in route logs are masked to the last 4 digits.
- Storage error messages never include object paths or signed media URLs.

## 8. Error and Failure Safety

- Any processing failure is recorded as `FAILED` with the stage where it happened; the webhook still answers 200.
- A pending copy stays recorded in `pending_storage_path` even if a later step fails.
- Permanent copy is rolled back if the `documents` insert fails; a parallel duplicate is detected and cleaned up.
- No temporary object is deleted in Phase 7.

## 9. Automated Security-Relevant Tests

| Area | Test file |
|---|---|
| SHA-256 correctness and format | `test/fileChecksum.test.js` |
| Same-client duplicate, cross-client conflict, pending duplicate | `test/documentChecksum.test.js`, `test/storagePlacement.test.js` |
| Filename sanitizing, path traversal, unsafe IDs | `test/storageNaming.test.js` |
| No overwrite, storage failure, rollback | `test/permanentStorage.test.js`, `test/clientDocument.test.js` |
| Identity conflicts, no merging | `test/identityVerification.test.js`, `test/documentProcessing.test.js` |
| No PII in loggable summaries | `test/documentProcessing.test.js`, `test/storagePlacement.test.js`, `test/ocrDiagnostics.test.js` |
| Size/type pre-check, streaming limit, timeouts, no URL/token in errors (SEC-002) | `test/whatsappMediaService.test.js` |
| Type and size validation | `test/whatsappMedia.test.js` |

There are **no automated tests yet** for JWT authentication, login, or webhook signature verification (behaviour was verified manually).

## 10. Known Remaining Security Work

| ID | Severity | Item |
|---|---|---|
| SEC-003 | Medium | Error responses expose stack traces and server paths |
| SEC-004 | Medium | No login rate limiting |
| SEC-005 | Medium | Inactive admins can still log in |
| SEC-006 | Medium | Duplicate-message check is in memory and set after processing (replays reprocessed) |
| SEC-007 | Medium | No OCR resource limits (image size, PDF pages, concurrency) |
| SEC-008 | Medium | Passport of a client with no WhatsApp on record is stored as `VERIFIED` from any sender |
| SEC-009 | Medium | File content not checked against the declared type |
| SEC-010 | Low | Temporary upload key still uses the sender's file extension |
| SEC-011 | Low | Original filenames and some raw error objects are logged |
| SEC-012–019 | Low | Login timing/input checks, media-host allowlist, HTTP headers, test password script, dev-dependency advisory, verify-token comparison, startup env check |
| SEC-021–023 | Info | Bucket-level limits, missing auth/webhook regression tests, admin provisioning |

Details: security audit findings (to be recorded in `Docs/13-security-audit.md`).

## 11. Current Security Status

- Webhook authenticity, file validation, private storage, safe paths, duplicate/conflict handling and PII-free processing logs are in place.
- The critical database exposure (SEC-001) and the unbounded media download (SEC-002) are fixed and verified.
- Seven Medium findings remain; error-response sanitization, login rate limiting and OCR limits should be fixed before production.
- Status: **SECURITY FIXES REQUIRED** before production.
