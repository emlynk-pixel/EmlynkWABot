# Security Overview

## 1. Security Status

| | |
|---|---|
| Status | **READY FOR CONTROLLED TESTING** |
| Date | 2026-09-25 (audit 2026-09-24, remediation completed 2026-09-25) |
| Phase | After Phase 7 (permanent storage) and the full security remediation |
| Scope | Express backend (`src/`), operator scripts (`scripts/`), Prisma migrations, Supabase database, `emlynk-documents` storage bucket |

All 23 audit findings (SEC-001 … SEC-023) are fixed, verified live, or accepted with a stated reason. 526 automated tests pass, including the real OCR tests. No real company documents were used during verification; all test data is synthetic.

## 2. Current Security Features

### Authentication and Admin Access

| Control | Where |
|---|---|
| Admin login issues an **HS256 JWT** signed with `JWT_SECRET` (≥ 32 characters, checked at startup); verification accepts HS256 only | `src/routes/auth.js`, `src/middleware/auth.js` |
| Tokens expire after **1 hour**; missing, malformed, expired, `alg: none`, wrong-secret and tampered tokens → 401 | `src/middleware/auth.js` |
| Passwords hashed with **bcrypt** (10 rounds); the hash is never returned | `src/utils/password.js`, `src/routes/auth.js` |
| **Inactive-admin blocking:** only `ACTIVE` admins can log in; `/auth/me` re-checks the stored status, so deactivation also stops existing tokens | `src/routes/auth.js` |
| All login failures get the same 401 "Invalid email or password" (unknown, wrong password, inactive) | `src/routes/auth.js` |
| Unknown emails still run a bcrypt comparison against a random dummy hash, so timing doesn't reveal which emails exist | `src/routes/auth.js` |
| Login input: strings only, email ≤ 254, password ≤ 128, otherwise 400 without echoing input; email matched case-insensitively | `src/routes/auth.js` |
| **Login rate limit:** 5 failed attempts per 15 min per IP; successful logins not counted | `src/middleware/loginRateLimiter.js` |
| **Admin provisioning** only via `npm run admin:create`: hidden password prompt (or `ADMIN_PASSWORD`), 12–128 characters, bcrypt, `ACTIVE`, existing emails refused, only the new ID printed; no HTTP endpoint | `scripts/createAdmin.js`, `src/services/adminProvisioningService.js` |

### WhatsApp Webhook

| Control | Where |
|---|---|
| `X-Hub-Signature-256` **HMAC SHA-256** over the raw body on every POST, timing-safe; missing/invalid → 401, nothing processed | `src/middleware/verifyWhatsAppSignature.js` |
| Verification handshake: token compared in constant time, 403 if `WHATSAPP_VERIFY_TOKEN` is unset, challenge returned as `text/plain` | `src/routes/whatsapp.js` |
| **Replay / idempotency protection:** message ID claimed right after the signature check, before download or OCR; parallel duplicates stopped; refused files count as handled; claim released if handling crashes; 24 h TTL, at most 10,000 IDs (in memory) | `src/utils/messageIdempotency.js` |
| Only `document` and `image` messages processed | `src/utils/whatsappMedia.js` |
| Access token only sent to `https://` `fbsbx.com` or its subdomains (no credentials, no custom port); redirects re-checked; media ID format checked | `src/services/whatsappMediaService.js` |

### Files and OCR

| Control | Where |
|---|---|
| Allowed types `application/pdf`, `image/jpeg`, `image/png`; **10 MB** maximum | `src/utils/fileValidation.js` |
| Meta metadata pre-check before download; streamed download cancelled past 10 MB; 10 s metadata / 30 s download timeouts | `src/services/whatsappMediaService.js` |
| **File signature** must match the declared type (`%PDF-` in the first 1,024 bytes, JPEG `FF D8 FF`, PNG signature) | `src/utils/fileValidation.js` |
| Stored names: `temporary/{uuid}.{pdf,jpeg,png}`; extension always from the validated MIME type; original names sanitized; path IDs limited to `[A-Za-z0-9_-]` | `temporaryStorageService.js`, `src/utils/storageNaming.js` |
| Uploads and copies never overwrite; a permanent copy is removed again if its database row can't be written | `temporaryStorageService.js`, `permanentStorageService.js` |
| **OCR limits:** image ≤ 12,000 px per side and 50 MP, PDF ≤ 20 pages, 2 concurrent jobs, queue of 10, 60 s wait / 120 s job timeout | `src/services/ocrService.js` |

### Database and Storage

| Control | Status |
|---|---|
| **Supabase RLS** on all 5 public tables with no policies; all rights revoked from `anon` / `authenticated`, including future tables (migration `20260924140000_restrict_public_database_access`) | Verified live |
| Backend uses role `postgres` (owner, bypasses RLS); Prisma parameterized queries, no raw SQL in the application | Implemented |
| **Private bucket** `emlynk-documents`, limited at bucket level to 10 MB and PDF/JPEG/PNG; `storage.objects` RLS on, no policies; no public or signed URLs generated | Verified live |
| Paths: `clients/{passport_id}/…`, `pending/{unique_id}/…`, `pending/unidentified/{temporary_id}/…`; WhatsApp numbers never in paths | Tested |
| **Checksum duplicate detection:** SHA-256 of the received bytes; unique `(passport_id, file_sha256)`; same-client duplicates not stored again; same file under another client → `CONFLICT` in `pending/unidentified/…` | Tested |
| Only listed `temporary_data` columns can be updated; `users.first_name` and `temporary_data.whatsapp_number` required | Implemented |

### Identity and Conflict Handling

- Passport ID is the identity; WhatsApp is a signal. Stored WhatsApp numbers are never rewritten or added automatically.
- Identity conflicts and ambiguous matches are never merged or linked; `CONFLICT` and `MANUAL_REVIEW` documents never enter a client folder.
- Client fields are filled only for a verified match (passport and WhatsApp agree) with confidence ≥ 90; `first_name` is compare-only; nothing is overwritten.
- Duplicate and cross-client checksum checks run before any client record changes.
- Passport found but no WhatsApp on record → manual review (see §4).

### Logging, Errors and Runtime

- **Privacy:** webhook logs use `messageRef` (12-character hash of the message ID) instead of phone numbers, file names, storage paths, media IDs or message IDs. Processing summaries hold statuses, scores and field names only; extracted text is never logged. Other errors are logged as type or as a redacted first line (`src/utils/safeLog.js`); login input is never logged.
- **Express error sanitization:** generic JSON 400 / 413 / 500 with no stack traces or paths (`src/middleware/errorHandler.js`).
- **HTTP headers:** `X-Powered-By` disabled; `helmet` sets `nosniff`, frame protection, HSTS, CSP and related headers.
- **Proxy trust:** off by default; see §4.
- **Environment validation:** startup refuses to run with missing or malformed settings and names the variables only (`src/config/env.js`); `.env.example` lists names only.
- **Secrets:** `.env` is ignored and has never been committed; no hard-coded credentials remain in the code.

## 3. Security Findings Summary

| ID | Severity | Finding | Final Status |
|---|---|---|---|
| SEC-001 | Critical | Public Supabase roles could read and write every table | VERIFIED |
| SEC-002 | High | Media downloaded in full before the size check; no timeouts | FIXED |
| SEC-003 | Medium | Error responses exposed stack traces and server paths | FIXED |
| SEC-004 | Medium | No login rate limiting | FIXED |
| SEC-005 | Medium | Inactive admins could log in and keep using tokens | FIXED |
| SEC-006 | Medium | Duplicate check set after processing; replays reprocessed; unbounded memory | FIXED |
| SEC-007 | Medium | No OCR resource limits | FIXED |
| SEC-008 | Medium | Passport of a client without WhatsApp on record stored as `VERIFIED` from any sender | FIXED / APPROVED BUSINESS RULE |
| SEC-009 | Medium | File content not checked against the declared type | FIXED |
| SEC-010 | Low | Temporary object extension taken from the sender's file name | FIXED |
| SEC-011 | Low | File names, phone numbers and raw error objects in logs | FIXED |
| SEC-012 | Low | Email enumeration by login timing | FIXED |
| SEC-013 | Low | Login input types unchecked (500s, input logged) | FIXED |
| SEC-014 | Low | Access token sent to any media URL returned by the Graph API | FIXED |
| SEC-015 | Low | `X-Powered-By` sent, no security headers, proxy trust undefined | FIXED |
| SEC-016 | Low | Hard-coded test password and manual scripts in `src/` | FIXED |
| SEC-017 | Low | `npm audit`: `deepmerge-ts` advisory via the Prisma CLI | ACCEPTED RISK (dev-only) |
| SEC-018 | Low | Verify token compared with input-dependent timing; challenge echoed as HTML | FIXED |
| SEC-019 | Low | No environment check at startup | FIXED |
| SEC-020 | Low | Concurrent identical submissions can create an extra pending copy or skip a version number | ACCEPTED RISK |
| SEC-021 | Info | Bucket had no size or type limits of its own | VERIFIED |
| SEC-022 | Info | No automated tests for JWT, login, signature or webhook route | FIXED |
| SEC-023 | Info | No approved way to create an admin | FIXED |

Totals: 19 FIXED (including SEC-008), 2 VERIFIED, 2 ACCEPTED RISK, 0 DEFERRED.

## 4. Important Security Decisions

**SEC-008: manual review rule (approved).** A passport number alone does not prove the sender is the client. When the passport matches a client who has no WhatsApp number on record, the result is `WHATSAPP_NOT_ON_RECORD` → `MANUAL_REVIEW` → `pending/{unique_id}/…`. The document stays linked to the client's `passport_id` / `unique_id` (proposal §13 E), no `documents` row is created, and the WhatsApp number is not added to the client automatically. This holds in every confidence band: a document with an explicit review reason (identity review, wrong-document suspicion, unresolved police-slip date) stays in `pending/` even in the `UNCLEAR` band, where it previously could reach the client folder.

**SEC-017: dev-only dependency advisory.** GHSA-ggr8-5vv4-36mx (stack exhaustion in `deepmerge-ts` < 8) reaches the project only through `prisma` (CLI, devDependency) → `@prisma/config` → `deepmerge-ts@7.1.5`. `@prisma/client` has no runtime dependencies (the CLI is only an optional peer, which is why `npm audit --omit=dev` still lists it), and nothing in `src/` or `generated/` imports the affected packages. Its input is our own schema/config, never user data. The only automatic fix is `npm audit fix --force`, a breaking Prisma version change, so it was not applied.

**SEC-020: accepted race condition.** Retries of the same WhatsApp message are stopped by the message-ID claim. Two *different* messages carrying the same file at the same moment can still create an extra pending copy or skip a version number (e.g. `passport_v3` without `v2`). Overwriting a file, storing under the wrong client, or duplicate `documents` rows remain impossible. Impact: an extra pending file for a reviewer to discard.

**Proxy trust.** `trust proxy` is off by default, so a client cannot set its own IP for the login rate limit through `X-Forwarded-For`. Behind a known proxy or load balancer, set `TRUST_PROXY_HOPS` to the exact hop count (0–10); `true` is never used. Without it, all users behind a proxy share one rate-limit count.

**Private bucket policy.** The bucket stays private with no storage policies; only the backend (service role) reads or writes it, and no public or signed URLs are created. Size and type limits are set at bucket level too (applied through the API without recreating the bucket or touching objects).

**Replay cache scope.** The message-ID cache is in memory: cleared on restart and not shared between instances. The checksum checks still prevent storing the same file twice. Run a single instance until a shared store exists.

## 5. Security Testing

Latest verified results (2026-09-25):

| Check | Result |
|---|---|
| `npm test` | 526 tests: 520 passed, 0 failed, 6 skipped (the opt-in real OCR tests) |
| `RUN_OCR_TESTS=1 npm test` | 526 tests: 526 passed, 0 failed |
| `node --check` on all JS files | No failures |
| `prisma format` / `validate` / `generate` | Formatted, valid, client generated (6.19.3) |
| `prisma migrate status` | 4 migrations found, schema up to date |
| `npm audit` | 3 high, all in the dev-only Prisma CLI chain (SEC-017); none in runtime code |
| Live Supabase (read-only, counts and settings only) | RLS on for all 5 public tables; 0 table rights for `anon`/`authenticated`; `storage.objects` RLS on with 0 policies; bucket private, 10 MB, PDF/JPEG/PNG; 0 admin accounts |
| Server smoke test (real configuration) | `/health` 200 with `nosniff` and HSTS, no `X-Powered-By`; wrong verify token 403; unsigned webhook POST 401; invalid login types 400 "Invalid login request"; `/auth/me` without token 401; malformed JSON 400 "Invalid request body" |
| Secret scan (real `.env` values vs. all tracked and new files) | No matches; `.env` not tracked |

Test coverage by area:

| Area | Test file |
|---|---|
| Login, inactive admins, input validation, timing, email case, JWT tokens | `test/adminAuth.test.js` |
| Login rate limit | `test/loginRateLimit.test.js` |
| Webhook signature, malformed payloads, replay (sequential and parallel), disguised files, verify token, no PII in logs | `test/whatsappWebhook.test.js` |
| Message-ID cache: TTL, bounded size, release | `test/messageIdempotency.test.js` |
| Media pre-check, streaming limit, timeouts, host allowlist, redirects | `test/whatsappMediaService.test.js` |
| File signatures, temporary naming | `test/fileSafety.test.js` |
| OCR limits | `test/ocrResourceLimits.test.js` |
| Error responses | `test/errorHandling.test.js` |
| Headers, proxy trust, startup environment check | `test/appSecurity.test.js` |
| Admin provisioning, no hard-coded credentials | `test/adminProvisioning.test.js` |
| Checksums, naming, storage, rollback | `test/fileChecksum.test.js`, `test/documentChecksum.test.js`, `test/storageNaming.test.js`, `test/permanentStorage.test.js`, `test/clientDocument.test.js` |
| Identity rules, placement, no PII in summaries | `test/identityVerification.test.js`, `test/storagePlacement.test.js`, `test/documentProcessing.test.js`, `test/ocrDiagnostics.test.js` |

## 6. Remaining Manual / Deployment Actions

1. Create the first admin account: `npm run admin:create -- --name "…" --email …` (0 admins exist).
2. Set `TRUST_PROXY_HOPS` if production runs behind a proxy or load balancer.
3. Run a single app instance, or add a shared message-ID store before scaling out.
4. Controlled end-to-end verification with real messages from a test WhatsApp number (not yet done).
5. Production deployment review (hosting, HTTPS, secret management).
6. Re-check SEC-017 when upgrading Prisma.

## 7. Final Security Status

**READY FOR CONTROLLED TESTING.** Production use follows once the deployment actions in §6 are complete.
