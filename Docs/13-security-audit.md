# Security Audit and Remediation Record

Final record of the security audit (SEC-001 … SEC-023) and what was done about each finding. Written for the developers and the senior reviewer who will approve production use.

- Audit date: 2026-09-24. Remediation completed: 2026-09-25.
- Scope: the Express backend (`src/`), operator scripts (`scripts/`), Prisma migrations, the Supabase database and the `emlynk-documents` storage bucket.
- Verification: automated tests (526 passing, including the real OCR tests), a server smoke test, and read-only checks against the live Supabase project. No real company documents were used; all test data is synthetic.

Status meanings:

| Status | Meaning |
|---|---|
| **FIXED** | Code or configuration changed, and covered by automated tests |
| **VERIFIED** | Fixed and also confirmed against the live system |
| **ACCEPTED RISK** | Reviewed; the remaining risk is small and understood. No change made |
| **DEFERRED** | Real, but out of scope now; tracked for later |
| **NEEDS BUSINESS APPROVAL** | Changes a business rule; the fix is in place but needs a senior decision to keep |

## 1. Final Status Table

| ID | Severity | Finding | Status | Fix / reason |
|---|---|---|---|---|
| SEC-001 | Critical | Public Supabase roles (`anon`, `authenticated`) could read and write every table through the REST API | **VERIFIED** | Migration `20260924140000_restrict_public_database_access`: RLS on all 5 tables, all rights revoked from `anon`/`authenticated`, default privileges too. Live: RLS on, 0 grants |
| SEC-002 | High | Media downloaded in full before the 10 MB check; no timeouts | **FIXED** | Meta metadata pre-check, streamed download cancelled past 10 MB, 10 s / 30 s timeouts |
| SEC-003 | Medium | Error responses exposed stack traces and server paths | **FIXED** | Central `errorHandler`: generic JSON 400/413/500, logs method/path/status/type only |
| SEC-004 | Medium | No login rate limiting | **FIXED** | 5 failed logins per 15 min per IP (`express-rate-limit`), successful logins not counted |
| SEC-005 | Medium | Inactive admins could log in and keep using tokens | **FIXED** | Only `ACTIVE` may log in; `/auth/me` re-checks the stored status; same generic 401 |
| SEC-006 | Medium | Duplicate-message check set after processing, so replays and retries were reprocessed; unbounded memory | **FIXED** | Message ID claimed right after signature check, before download/OCR; 24 h TTL, max 10,000 IDs. See §3 for limits |
| SEC-007 | Medium | No OCR resource limits | **FIXED** | Image ≤ 12,000 px side / 50 MP, PDF ≤ 20 pages, 2 concurrent jobs, queue of 10, 60 s queue and 120 s job timeouts |
| SEC-008 | Medium | A passport of a client with no WhatsApp on record was stored as `VERIFIED` in the client folder, whoever sent it | **FIXED — NEEDS BUSINESS APPROVAL** | Now `MANUAL_REVIEW` → `pending/{unique_id}`; still linked to the passport. See §2 |
| SEC-009 | Medium | File content not checked against the declared MIME type | **FIXED** | Magic bytes checked: `%PDF-` in the first 1,024 bytes, JPEG `FF D8 FF`, PNG 8-byte signature. Mismatch → `FILE_SIGNATURE_MISMATCH`, nothing stored |
| SEC-010 | Low | Temporary object extension came from the sender's file name (`x.exe` → `<uuid>.exe`) | **FIXED** | Extension from the validated MIME type only: `.pdf`, `.jpeg`, `.png` |
| SEC-011 | Low | Personal data in logs: file names, phone numbers, raw error objects | **FIXED** | Webhook logs use `messageRef` (12-char hash of the message ID); no numbers, file names, paths, media IDs. Errors logged as type or redacted first line (`src/utils/safeLog.js`) |
| SEC-012 | Low | Unknown email answered faster than a wrong password (email enumeration by timing) | **FIXED** | A bcrypt comparison against a random dummy hash runs for unknown emails |
| SEC-013 | Low | Login input types unchecked: objects/arrays caused 500s and were logged | **FIXED** | Strings only, email ≤ 254, password ≤ 128 → otherwise 400 "Invalid login request", input never echoed |
| SEC-014 | Low | Access token sent to whatever media URL the Graph API returned | **FIXED** | HTTPS + `fbsbx.com` or a subdomain only, no credentials or custom port, checked before fetch. Redirects followed by hand and re-checked. Media ID format checked |
| SEC-015 | Low | `X-Powered-By` sent; no security headers; proxy trust undefined | **FIXED** | `x-powered-by` off, `helmet` headers. `trust proxy` off by default; optional `TRUST_PROXY_HOPS` (exact hop count, never `true`) |
| SEC-016 | Low | Hard-coded test password `Admin#123` and manual scripts in `src/` | **FIXED** | `src/utils/password-test.js` deleted (the password matched no admin; there are 0 admins). `prisma-test.js` → `scripts/checkDatabaseConnection.js` |
| SEC-017 | Low | `npm audit`: 3 high in `deepmerge-ts` via the Prisma CLI | **ACCEPTED RISK (dev-only)** | See §4 |
| SEC-018 | Low | Webhook verify token compared with input-dependent timing; challenge echoed as HTML | **FIXED** | SHA-256 both sides + `timingSafeEqual`; challenge returned as `text/plain` |
| SEC-019 | Low | No environment check at startup | **FIXED** | `src/config/env.js`: required names, JWT secret ≥ 32 chars, URL formats, `TRUST_PROXY_HOPS`. Exits with names only |
| SEC-020 | Low | Races: two identical pending submissions at the same moment can make two pending copies; version numbers can skip | **ACCEPTED RISK** | See §5 |
| SEC-021 | Info | Bucket had no size or type limits of its own | **VERIFIED** | Updated by API (not recreated, no objects touched): private, 10 MB, PDF/JPEG/PNG only. Read back live |
| SEC-022 | Info | No automated tests for JWT, login, signature, webhook route | **FIXED** | See §6 |
| SEC-023 | Info | No approved way to create an admin (0 admins exist) | **FIXED** | `npm run admin:create`: hidden password prompt, bcrypt, `ACTIVE`, refuses existing emails, prints only the new ID |

Count (23): 18 FIXED, 2 VERIFIED (SEC-001, SEC-021), 2 ACCEPTED RISK (SEC-017, SEC-020), 1 FIXED but NEEDS BUSINESS APPROVAL (SEC-008). None DEFERRED.

## 2. SEC-008: Business-Rule Change (needs approval)

**Before:** proposal §13 scenario E (passport found, the client has no WhatsApp number on record) was treated as fully verified. The document went straight into `clients/{passport_id}/…` as `VERIFIED`, whoever sent it.

**Risk:** a passport number alone does not prove the sender is the client. Anyone with a photo or copy of someone's passport could add documents to that client's folder.

**Now:**

- Status `PASSPORT_MATCH_ONLY` with note `WHATSAPP_NOT_ON_RECORD` and `reviewRequired: true`.
- `processing_status = MANUAL_REVIEW`; the file goes to `pending/{unique_id}/…`, not the client folder; no `documents` row.
- The temporary record is **still linked** to the client's `passport_id` / `unique_id`, as §13 E asks ("associate the document with the Passport ID").
- The WhatsApp number is still **not** added to the client automatically (unchanged).

**Why it needs approval:** no senior-confirmed rule covered this case (the only senior rule on record concerns required columns, Docs/11). This change makes more documents wait for a person. If the business prefers the old behaviour, revert the single `reviewRequired` line in `src/services/identityVerificationService.js` and the tests that assert it.

## 3. SEC-006: What the Replay Protection Does and Doesn't Cover

- Covers Meta retries and replays of a signed request, including one that arrives while the first is still being processed (tested in parallel).
- A file refused for size, type or signature counts as handled; a replay is not downloaded again.
- If handling crashes before recording anything, the claim is released so Meta's retry can try again.
- **Limits:** the cache is in memory, so it is cleared on restart and not shared between several app instances. Within those gaps, the per-client checksum (unique `passport_id, file_sha256`) and the pending-duplicate check still stop the same file from being stored twice. A shared store (e.g. a `processed_messages` table) is needed before running more than one instance.

## 4. SEC-017: Dependency Advisory

- Advisory: GHSA-ggr8-5vv4-36mx, stack exhaustion in `deepmerge-ts` < 8 when merging recursive objects.
- Chain: `prisma` (CLI, devDependency) → `@prisma/config` → `deepmerge-ts@7.1.5`.
- Not in the running server: `@prisma/client` has **no** runtime dependencies (the CLI is only an optional peer, which is why `npm audit --omit=dev` still lists it), and nothing in `src/` or `generated/` imports `@prisma/config` or `deepmerge-ts`.
- Input is our own `schema.prisma` / config, never user data.
- The only automatic fix is `npm audit fix --force`, which changes the Prisma version (breaking). Not applied.
- **Action:** re-check when upgrading Prisma; the fixed `@prisma/config` ships with a later major version.

## 5. SEC-020: Races (re-reviewed)

Re-reviewed after SEC-006:

- Same WhatsApp message delivered twice at once: now stopped by the message-ID claim.
- Two *different* messages carrying the same file at the same moment: can still create two pending copies, or skip a version number (`passport_v3` without `passport_v2`).
- Never possible: overwriting a file (copies never overwrite), storing a file under the wrong client, or two `documents` rows for the same client and file (unique index).
- Impact: an extra pending file for a reviewer to discard. Accepted.

## 6. Security Regression Tests

| Area | Tests |
|---|---|
| Login: generic failures, inactive admins, input types/lengths, no echo, timing of unknown emails, email case | `test/adminAuth.test.js` |
| Login rate limit | `test/loginRateLimit.test.js` |
| Tokens: expired, `alg: none`, wrong secret, other algorithm, tampered payload, malformed headers | `test/adminAuth.test.js` |
| Webhook: missing/invalid/tampered signature, malformed JSON, missing IDs, replay (sequential and parallel), disguised file, verify token, `text/plain` challenge, no PII in logs | `test/whatsappWebhook.test.js` |
| Message-ID cache: claim/complete/release, TTL, bounded size | `test/messageIdempotency.test.js` |
| Media: size/type pre-check, streaming limit, timeouts, host allowlist, redirects, media ID | `test/whatsappMediaService.test.js` |
| Files: magic bytes, MIME-based temporary extension, no overwrite | `test/fileSafety.test.js` |
| OCR limits | `test/ocrResourceLimits.test.js` |
| Error responses | `test/errorHandling.test.js` |
| Headers, proxy trust, startup environment check | `test/appSecurity.test.js` |
| Admin provisioning, no hard-coded credentials | `test/adminProvisioning.test.js` |
| Identity scenario E, storage placement, no PII in summaries | `test/identityVerification.test.js`, `test/storagePlacement.test.js`, `test/documentProcessing.test.js` |

## 7. Live Checks (read-only, 2026-09-25)

| Check | Result |
|---|---|
| RLS on `users`, `admins`, `documents`, `temporary_data`, `_prisma_migrations` | On for all 5 |
| Table rights for `anon` / `authenticated` | 0 |
| `storage.objects` RLS / policies | On / 0 policies |
| Bucket `emlynk-documents` | private, 10 MB, `application/pdf`, `image/jpeg`, `image/png` |
| Migrations | 4 found, schema up to date |
| Admin accounts | 0 (create the first with `npm run admin:create`) |

Only counts and settings were read; no data rows were printed.

## 8. Remaining Work Before Production

1. Senior decision on SEC-008 (§2).
2. Create the first admin with `npm run admin:create`.
3. If deployed behind a proxy or load balancer, set `TRUST_PROXY_HOPS` to the exact hop count, or the login rate limit will count all users as one IP.
4. Run one instance only, or add a shared message-ID store (§3).
5. End-to-end test with real WhatsApp messages on a test number (not done during development).
