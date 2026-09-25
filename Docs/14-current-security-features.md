# Current Security Features

Snapshot of the security controls in the codebase after Phase 7 and the full security remediation (SEC-001 … SEC-023, see `Docs/13-security-audit.md`). Only what is implemented and tested is listed.

## 1. Authentication

| Control | Where |
|---|---|
| Admin login issues an **HS256** JWT signed with `JWT_SECRET` (≥ 32 characters, checked at startup); verification accepts HS256 only | `src/routes/auth.js`, `src/middleware/auth.js` |
| Tokens expire after **1 hour** | `src/routes/auth.js` |
| Protected routes require `Authorization: Bearer <token>`; missing, malformed, expired, `alg: none`, wrong-secret and tampered tokens → 401 (tested) | `src/middleware/auth.js` |
| Passwords hashed with **bcrypt** (10 rounds) | `src/utils/password.js` |
| Only `ACTIVE` admins can log in; `/auth/me` re-checks the stored status, so deactivation takes effect on existing tokens | `src/routes/auth.js` |
| All login failures get the same 401 "Invalid email or password", including unknown and inactive accounts | `src/routes/auth.js` |
| Unknown emails still run a bcrypt comparison (dummy hash), so timing doesn't reveal which emails exist | `src/routes/auth.js` |
| Login input: strings only, email ≤ 254, password ≤ 128; otherwise 400 without echoing input. Email matched case-insensitively | `src/routes/auth.js` |
| **Rate limit:** 5 failed logins per 15 min per IP; successful logins not counted | `src/middleware/loginRateLimiter.js` |
| Admins are created only with `npm run admin:create` (hidden prompt, bcrypt, `ACTIVE`, refuses existing emails); no HTTP endpoint | `scripts/createAdmin.js`, `src/services/adminProvisioningService.js` |

## 2. WhatsApp Webhook Security

| Control | Where |
|---|---|
| Verification handshake: token compared in constant time; refused (403) if `WHATSAPP_VERIFY_TOKEN` is unset; challenge returned as `text/plain` | `src/routes/whatsapp.js` |
| `X-Hub-Signature-256` checked on every POST with **HMAC SHA-256** over the **raw body**, timing-safe | `src/middleware/verifyWhatsAppSignature.js` |
| Missing or invalid signature → 401, nothing processed | `src/middleware/verifyWhatsAppSignature.js` |
| **Replay protection:** message ID claimed right after the signature check, before any download or OCR; parallel duplicates stopped; 24 h TTL, at most 10,000 IDs (in memory) | `src/utils/messageIdempotency.js`, `src/routes/whatsapp.js` |
| Only `document` and `image` messages are processed | `src/utils/whatsappMedia.js` |
| Access token only sent to `https://…fbsbx.com` (exact or subdomain), no credentials/custom port; redirects re-checked; media ID format checked | `src/services/whatsappMediaService.js` |

## 3. File Upload Security

| Control | Where |
|---|---|
| Allowed types: `application/pdf`, `image/jpeg`, `image/png`; **10 MB** maximum | `src/utils/fileValidation.js` |
| Meta metadata pre-check before download; streamed download cancelled past 10 MB; 10 s / 30 s timeouts | `src/services/whatsappMediaService.js` |
| **Magic bytes** must match the declared type (`%PDF-`, JPEG `FF D8 FF`, PNG signature) | `src/utils/fileValidation.js` |
| Temporary objects named `temporary/{uuid}.{pdf,jpeg,png}`; extension from the MIME type only | `src/services/temporaryStorageService.js` |
| Extension from the MIME type for `clients/` and `pending/` copies too; original names sanitized | `src/utils/storageNaming.js` |
| IDs used in paths restricted to `[A-Za-z0-9_-]` | `src/utils/storageNaming.js` |
| Uploads and copies never overwrite | `temporaryStorageService.js`, `permanentStorageService.js` |
| **OCR limits:** image ≤ 12,000 px side and 50 MP, PDF ≤ 20 pages, 2 concurrent jobs, queue of 10, 60 s wait / 120 s job timeouts | `src/services/ocrService.js` |

## 4. Document Storage Security

| Control | Status |
|---|---|
| Bucket `emlynk-documents` is **private**, limited to **10 MB** and PDF/JPEG/PNG at bucket level | Verified live |
| `storage.objects`: RLS on, no policies | Verified live |
| No public or signed URLs generated anywhere | Verified in code |
| Client files `clients/{passport_id}/…`; pending `pending/{unique_id}/…` or `pending/unidentified/{temporary_id}/…` | Implemented + tested |
| WhatsApp numbers never appear in storage paths | Tested |
| Permanent copy removed again if its database row can't be written | Tested |

## 5. Database Security

| Control | Status |
|---|---|
| RLS on all 5 public tables, no policies; all rights revoked from `anon` / `authenticated`, including future tables | Verified live |
| Backend uses role `postgres` (owner, bypasses RLS) | Verified |
| Prisma parameterized queries; no raw SQL in the application | Implemented |
| Unique `(passport_id, file_sha256)`; required `users.first_name`, `temporary_data.whatsapp_number` | Implemented |
| Only listed `temporary_data` columns can be updated | `src/services/temporaryDataService.js` |

## 6. Identity and Conflict Protection

- Passport ID is the identity; WhatsApp is a signal. Stored numbers are never rewritten.
- Conflicts and ambiguous matches are never merged or linked.
- **Passport found but the client has no WhatsApp on record (§13 E): manual review**, file in `pending/{unique_id}`, still linked to the passport (SEC-008, needs business approval).
- Client fields are filled only for a verified match (passport + WhatsApp agree) with confidence ≥ 90; `first_name` compare-only; nothing overwritten.
- Duplicate and cross-client checksum checks run before any client record changes.
- `CONFLICT` and `MANUAL_REVIEW` documents never enter a client folder automatically.

## 7. Privacy and Logging

- `.env` ignored by Git and never committed; `.env.example` lists names only. Repository scanned: no real secret values in any file.
- Webhook logs carry `messageRef` (12-character hash of the message ID) instead of phone numbers, file names, storage paths, media IDs or message IDs (tested).
- Processing summaries hold statuses, scores and field names only; extracted text never logged.
- Errors logged as type, or as a redacted first line (quoted values, paths, emails, IDs and long numbers removed) via `src/utils/safeLog.js`.
- Auth errors logged as type only; the login input is never logged.
- Test data and fixtures are synthetic.

## 8. HTTP and Runtime Hardening

- `X-Powered-By` disabled; `helmet` sets `nosniff`, frame protection, HSTS, CSP and related headers.
- `trust proxy` off by default; `TRUST_PROXY_HOPS` sets an exact hop count when behind a known proxy.
- Error responses: generic JSON (400 / 413 / 500), no stack traces or paths.
- Startup refuses to run with missing or malformed settings; the message names variables only.

## 9. Automated Security Tests

526 tests, all passing (including the real OCR tests). Security coverage per area is listed in `Docs/13-security-audit.md` §6.

## 10. Known Limitations and Accepted Risks

| Item | Status |
|---|---|
| Replay cache is in memory: cleared on restart, not shared between instances (checksums still stop duplicate storage) | Run one instance, or add a shared store |
| SEC-017: `deepmerge-ts` advisory in the Prisma CLI (dev tooling only) | Accepted; revisit on Prisma upgrade |
| SEC-020: simultaneous different messages with the same file can create an extra pending copy or skip a version number | Accepted |
| SEC-008 business rule | Needs senior approval |
| No end-to-end test with real WhatsApp messages yet | Before production |

## 11. Current Security Status

All 23 audit findings are fixed, verified or accepted with reasons. Status: **READY FOR CONTROLLED TESTING**. Production review needs the SEC-008 decision, a first admin account, the proxy setting for the target host, and an end-to-end test on a test number.
