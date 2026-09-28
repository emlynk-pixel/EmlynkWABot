# Security Overview

## 1. Security Status

| | |
|---|---|
| Status | **READY FOR CONTROLLED TESTING & PRODUCTION PREPARATION** |
| Date | 2026-09-28 (updated after Phase 10 Admin Dashboard, Phase 12 RBAC & Invitations, Password Reset, and Post-Audit Remediation Pass) |
| Phase | Post Phase 12 + Audit Remediation (9 findings resolved) |
| Scope | Express backend (`src/`), React Admin Dashboard (`admin/`), operator scripts (`scripts/`), Prisma migrations, Supabase database, `emlynk-documents` storage bucket, Nodemailer SMTP service |

All 28 security controls and audit findings (SEC-001 … SEC-028) are implemented, verified live, or accepted with stated rationale. **1,081 automated backend tests across 207 suites pass (1,055 passed, 0 failed, 26 opt-in skipped)**, and **141 frontend unit/integration tests pass (100%)**. Production TypeScript compilation (`npm run admin:build`) succeeds with 0 errors. No real company or client documents were used during automated verification; all test data is synthetic.

---

## 2. Current Security Features

### Authentication, RBAC and Admin Access

| Control | Where |
|---|---|
| **Role-Based Access Control (RBAC):** Three distinct roles (`SUPER_ADMIN`, `OPERATOR`, `VIEWER`) enforced via `requirePermission(...)` middleware; granular permission flags (`MANAGE_ADMINS`, `REVIEW_DOCUMENTS`, `MANAGE_CLIENTS`, `EXPORT_REPORTS`, `VIEW_AUDIT_LOGS`) | `src/middleware/rbac.js`, `src/config/roles.js`, `src/routes/admin.js` |
| **HttpOnly Cookie Authentication:** Admin login issues an **HS256 JWT** stored in a secure, `httpOnly`, `sameSite: "lax"` cookie to mitigate XSS-based token theft; `Authorization: Bearer` fallback supported for API clients | `src/routes/auth.js`, `src/middleware/auth.js`, `src/createApp.js` |
| **JWT Secret & Expiration:** Signed with `JWT_SECRET` (≥ 32 characters, enforced at startup); tokens expire in **1 hour**; missing, malformed, expired, `alg: none`, wrong-secret, or tampered tokens return 401 | `src/middleware/auth.js`, `src/config/env.js` |
| **Password Hashing:** Passwords hashed with **bcrypt** (10 rounds); hashes are never returned via API responses or printed to logs | `src/utils/password.js`, `src/routes/auth.js` |
| **Inactive-Admin Blocking:** Only `ACTIVE` admins can authenticate; `authenticateAdmin` re-verifies stored status on every request, immediately revoking access if an admin is deactivated or deleted | `src/middleware/auth.js`, `src/routes/auth.js` |
| **Zero-Enumeration Login:** All login failures return generic 401 `"Invalid email or password"` (unknown user, wrong password, or inactive status) | `src/routes/auth.js` |
| **Timing Attack Mitigation:** Unknown emails trigger a dummy bcrypt comparison against a pre-generated hash to keep server response latency uniform | `src/routes/auth.js` |
| **Login Rate Limiting:** 5 failed attempts per 15 minutes per IP; successful logins do not consume rate limit tokens | `src/middleware/loginRateLimiter.js` |
| **Immutable Audit Logging:** All security-relevant actions (login, failed login, role changes, deactivations, invitations, password resets, review approvals) recorded in `admin_audit_logs` with admin ID and IP | `src/services/auditService.js`, `src/routes/auth.js`, `src/routes/admin.js` |

---

### Admin Invitation System

| Control | Where |
|---|---|
| **Cryptographically Secure Tokens:** 256-bit random tokens generated via `crypto.randomBytes(32).toString("hex")` | `src/services/adminInvitationService.js` |
| **Zero Raw Token Storage:** Only the **SHA-256 hash** of the invitation token is stored in `admin_invitations.token_hash`; the raw token is transmitted solely via the invite email | `src/services/adminInvitationService.js`, `src/routes/adminInvitations.js` |
| **Time-Bound Validity (24h):** Invitations expire after **24 hours** (`expires_at`); expired tokens are rejected with a clear message and cannot activate accounts | `src/services/adminInvitationService.js`, `src/routes/auth.js` |
| **Single-Use Enforcement:** Invitations transition atomically from `PENDING` to `ACCEPTED` upon password setup (`accepted_at`, `accepted_by_admin_id`); tokens cannot be reused | `src/services/adminInvitationService.js`, `src/routes/auth.js` |
| **Revocation & Deletion Controls:** `ADMIN` can revoke pending invitations (`REVOKED` status) or permanently remove expired/revoked invitations (`DELETE /api/admin/invitations/:id`); active tokens are immediately invalidated | `src/routes/adminInvitations.js`, `src/services/adminInvitationService.js` |
| **Password Policy:** Invitation password setup requires 8–128 characters, hashed with bcrypt (10 rounds) | `src/routes/auth.js` |
| **Privilege Separation:** Only `ADMIN`-role users can generate invitations or assign roles | `src/routes/adminInvitations.js` |
| **Frontend Role Filtering (AUDIT-003/004):** The sidebar hides `adminOnly` nav entries (Invitations) from non-ADMIN roles; the Invitations page is now also listed in the sidebar for ADMIN users (AUDIT-004); backend RBAC remains the authoritative gate | `admin/src/layout/Sidebar.tsx`, `admin/src/layout/navigation.ts` |

---

### Forgot Password & Password Reset System

| Control | Where |
|---|---|
| **Zero-Enumeration Recovery:** `POST /auth/forgot-password` always returns generic 200 `"If the account exists, a password reset link has been sent."` regardless of whether the email exists, is active, or is inactive | `src/routes/auth.js` |
| **Timing Attack Mitigation:** Requests for nonexistent emails perform a dummy bcrypt comparison to ensure response timing does not leak account existence | `src/routes/auth.js` |
| **Short-Lived Reset Tokens:** Password reset tokens expire after **1 hour** (`expires_at`) | `src/services/passwordResetService.js` |
| **SHA-256 Token Hashing:** Reset tokens use 256-bit cryptographic entropy; only SHA-256 hashes are stored in `admin_password_resets.token_hash` | `src/services/passwordResetService.js` |
| **Single-Use & Invalidation:** Tokens are marked `usedAt = NOW()` immediately upon consumption; creating a new reset request invalidates all prior active tokens for that admin | `src/services/passwordResetService.js`, `src/routes/auth.js` |
| **Password Reset Rate Limiting:** 5 reset requests per 15 minutes per IP (`createResetRateLimiter`) to prevent mailbox flooding and brute-force abuse | `src/middleware/loginRateLimiter.js`, `src/routes/auth.js` |
| **Password Update & Audit:** New password validated (8–128 chars), hashed with bcrypt, updated atomically inside a transaction, and logged to `audit_logs` | `src/routes/auth.js`, `src/services/passwordResetService.js` |
| **Non-Blocking Email Dispatch (AUDIT-001):** Reset email is fired with `void …catch()` so the HTTP response returns at the same time regardless of whether the email send succeeds, eliminating the timing side-channel between active and inactive accounts | `src/services/passwordResetService.js` |

---

### Outbound Email & Communication Security

| Control | Where |
|---|---|
| **Secure SMTP Delivery:** Outbound emails sent via Nodemailer with TLS / STARTTLS (`smtp.gmail.com:587`); credentials managed via environment variables | `src/services/emailService.js`, `src/config/env.js` |
| **Test Transport Isolation:** Automated tests use an in-memory transport fallback; no external network requests or real emails are dispatched during testing | `src/services/emailService.js`, `test/emailService.test.js` |
| **Safe Base URL Resolution:** Email links resolve securely via `APP_BASE_URL` or `ADMIN_SETUP_URL_BASE` with strict trailing-slash normalization and safe fallback | `src/services/emailService.js` |
| **No Sensitive Data in Logs:** Raw reset and invitation tokens are excluded from all logging statements and error traces | `src/services/emailService.js`, `src/utils/safeLog.js` |

---

### WhatsApp Webhook

| Control | Where |
|---|---|
| `X-Hub-Signature-256` **HMAC SHA-256** over the raw body on every POST, timing-safe; missing/invalid → 401, nothing processed | `src/middleware/verifyWhatsAppSignature.js` |
| Verification handshake: token compared in constant time, 403 if `WHATSAPP_VERIFY_TOKEN` is unset, challenge returned as `text/plain` | `src/routes/whatsapp.js` |
| **Replay / idempotency protection:** message ID claimed right after the signature check, before download or OCR; parallel duplicates stopped; every message of a batched delivery handled on its own; refused files count as handled; a failure before the submission is recorded releases the claim, removes an uploaded object and answers 500 so Meta retries; 24 h TTL, at most 10,000 IDs (in memory) | `src/utils/messageIdempotency.js` |
| Only `document` and `image` messages processed | `src/utils/whatsappMedia.js` |
| **Missing-sender guard (AUDIT-002):** Messages with no `from` field are acknowledged (200) and logged; they cannot be recorded or attributed and would have caused a 500 retry storm without the guard | `src/routes/whatsapp.js` |
| Access token only sent to `https://` `fbsbx.com` or its subdomains (no credentials, no custom port); redirects re-checked; media ID format checked | `src/services/whatsappMediaService.js` |

---

### Files and OCR

| Control | Where |
|---|---|
| Allowed types `application/pdf`, `image/jpeg`, `image/png`; **10 MB** maximum | `src/utils/fileValidation.js` |
| Meta metadata pre-check before download; streamed download cancelled past 10 MB; 10 s metadata / 30 s download timeouts | `src/services/whatsappMediaService.js` |
| **File signature** must match declared type (`%PDF-` in first 1,024 bytes, JPEG `FF D8 FF`, PNG magic bytes) | `src/utils/fileValidation.js` |
| Stored names: `temporary/{uuid}.{pdf,jpeg,png}`; extension always from the validated MIME type; original names sanitized; path IDs limited to `[A-Za-z0-9_-]` | `temporaryStorageService.js`, `src/utils/storageNaming.js` |
| Uploads and copies never overwrite; permanent copy removed again if its database row cannot be written | `temporaryStorageService.js`, `permanentStorageService.js` |
| **OCR limits:** image ≤ 12,000 px per side and 50 MP, PDF ≤ 20 pages, 2 concurrent jobs, queue of 10, 60 s wait / 120 s job timeout | `src/services/ocrService.js` |

---

### Database and Storage

| Control | Status |
|---|---|
| **Supabase RLS** on all public tables with no policies; all rights revoked from `anon` / `authenticated`, including future tables (migration `20260924140000_restrict_public_database_access`) | Verified live |
| Backend uses role `postgres` (owner, bypasses RLS); Prisma parameterized queries, no raw SQL string concatenation | Implemented |
| **Private bucket** `emlynk-documents`, limited at bucket level to 10 MB and PDF/JPEG/PNG; `storage.objects` RLS on, no policies; no public or signed URLs generated | Verified live |
| Paths: `clients/{passport_id}/…`, `pending/{unique_id}/…`, `pending/unidentified/{temporary_id}/…`; WhatsApp numbers never in paths | Tested |
| **Checksum duplicate detection:** SHA-256 of received bytes; unique `(passport_id, file_sha256)`; same-client duplicates not stored again; same file under another client → `CONFLICT` in `pending/unidentified/…` | Tested |
| Only listed `temporary_data` columns can be updated; `users.first_name` and `temporary_data.whatsapp_number` required | Implemented |

---

### Identity and Conflict Handling

- Passport ID is the primary identity; WhatsApp is a supporting signal. Stored WhatsApp numbers are never rewritten or added automatically.
- Identity conflicts and ambiguous matches are never merged or linked; `CONFLICT` and `MANUAL_REVIEW` documents never enter a client folder.
- Client fields are filled only for a verified match (passport and WhatsApp agree) with confidence ≥ 90; `first_name` is compare-only; nothing is overwritten.
- Duplicate and cross-client checksum checks run before any client record changes.
- Passport found but no WhatsApp on record → manual review (see §4).

---

### Logging, Errors and Runtime

- **Privacy:** webhook logs use `messageRef` (12-character hash of the message ID) instead of phone numbers, file names, storage paths, media IDs or message IDs. Processing summaries hold statuses, scores and field names only; extracted text is never logged. Other errors are logged as type or as a redacted first line (`src/utils/safeLog.js`); login input, reset tokens, and invite tokens are never logged.
- **Express error sanitization:** generic JSON 400 / 413 / 500 with no stack traces or server paths (`src/middleware/errorHandler.js`).
- **HTTP headers:** `X-Powered-By` disabled; `helmet` sets `nosniff`, frame protection, HSTS, and Content Security Policy (strict CSP allowing blob URLs for in-browser PDF/image inspection without external exposure).
- **Proxy trust:** off by default; see §4.
- **Environment validation:** startup refuses to run with missing or malformed settings and names the variables only (`src/config/env.js`); `.env.example` lists names only.
- **Secrets:** `.env` is ignored and has never been committed; no hard-coded credentials remain in the codebase.

---

## 3. Security Findings & Implemented Controls

| ID | Severity | Finding / Feature | Final Status |
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
| SEC-024 | High | Admin Invitation token leakage, replay, or privilege escalation | IMPLEMENTED & VERIFIED |
| SEC-025 | High | Forgot Password email enumeration and timing leakage | IMPLEMENTED & VERIFIED |
| SEC-026 | Medium | Password reset flooding and mailbox spamming | IMPLEMENTED & VERIFIED |
| SEC-027 | High | Missing Role-Based Access Control (RBAC) boundaries in admin actions | IMPLEMENTED & VERIFIED |
| SEC-028 | Medium | JWT localStorage vulnerability to Cross-Site Scripting (XSS) | IMPLEMENTED & VERIFIED |
| AUDIT-001 | High | Password-reset timing side-channel: awaited email send made active accounts respond slower than inactive ones | FIXED |
| AUDIT-002 | Medium | WhatsApp webhook 500 retry storm when `message.from` is missing | FIXED |
| AUDIT-003 | Medium | Frontend role-gating missing: Invitations nav visible to VIEW_ONLY users | FIXED |
| AUDIT-004 | Low | Invitations page missing from sidebar navigation | FIXED |
| AUDIT-005 | Low | Redundant duplicate `@@index([tokenHash])` on both token models (covered by `@unique`) | FIXED |
| AUDIT-006 | Low | Password length policy discrepancy (doc said 12; code uses 8) | CLOSED — no discrepancy; both backend and frontend enforce 8 |
| AUDIT-007 | Low | Missing SMTP / APP_BASE_URL environment variable examples in `.env.example` | FIXED |
| AUDIT-008 | Low | Security documentation outdated (wrong role names, missing controls) | FIXED |
| AUDIT-009 | Low | `resolveDb` / `resolveBucket` helpers duplicated across 9 files | FIXED — canonical `src/utils/resolveClients.js` created |

**Totals:** 24 + 8 FIXED / IMPLEMENTED, 2 VERIFIED, 2 ACCEPTED RISK, 1 CLOSED (no action), 0 DEFERRED.

---

## 4. Important Security Decisions

**SEC-008: Manual review rule (approved).** A passport number alone does not prove the sender is the client. When the passport matches a client who has no WhatsApp number on record, the result is `WHATSAPP_NOT_ON_RECORD` → `MANUAL_REVIEW` → `pending/{unique_id}/…`. The document stays linked to the client's `passport_id` / `unique_id`, no `documents` row is created, and the WhatsApp number is not added to the client automatically.

**SEC-024: Admin Invitation Token Architecture.**
1. Raw tokens are generated with 256 bits of entropy (`crypto.randomBytes(32)`).
2. The raw token is sent only once to the invitee's verified email.
3. The database stores strictly a SHA-256 hash (`admin_invitations.token_hash`). If the database were ever compromised, attackers cannot reconstruct the invitation links.
4. Invitations are strictly single-use and have a hard 24-hour expiration window.
5. Only `SUPER_ADMIN` can issue or revoke invitations.

**SEC-025 & SEC-026: Zero-Enumeration Password Reset.**
1. `POST /auth/forgot-password` gives no indication whether an email address exists in the system or whether an admin is active/inactive.
2. If an email does not exist, a simulated bcrypt hash comparison runs in the background so response latency is indistinguishable from valid requests.
3. Password reset links expire after 1 hour.
4. Token reuse is prevented by immediate consumption marking (`used = true`, `used_at = NOW()`).
5. A dedicated rate limiter (`authRateLimiter`) limits password reset attempts to 5 per 15 minutes per IP address.

**SEC-027: Role-Based Privilege Separation (RBAC).**
- `ADMIN`: Full administrative privileges, including creating, inviting, revoking, modifying roles, and managing administrators. Only ADMIN-role users can access the Invitations page (enforced both backend and frontend sidebar).
- `VIEW_ONLY`: Read-only access to dashboard overviews, client records, and document review states. Cannot modify records or take review actions.

**SEC-028: Session Security (HttpOnly Cookies).**
JWT authentication tokens are delivered in `httpOnly`, `sameSite: "lax"`, `secure` (in production) cookies. This prevents malicious third-party scripts from reading tokens via `document.cookie` or accessing browser `localStorage`.

**Proxy trust.** `trust proxy` is off by default, so a client cannot set its own IP for rate limiting through `X-Forwarded-For`. Behind a known proxy or load balancer, set `TRUST_PROXY_HOPS` to the exact hop count (0–10); `true` is never used.

**Private bucket policy.** The bucket stays private with no storage policies; only the backend (service role) reads or writes it, and no public or signed URLs are created. Size and type limits are enforced at the bucket level.

---

## 5. Security Testing

Latest verified results (2026-09-28):

| Check | Result |
|---|---|
| `npm test` (Backend test suite) | **1,081 tests across 207 suites**: 1,055 passed, 0 failed, 26 skipped (opt-in real OCR) |
| `npm --prefix admin test` (Frontend Vitest suite) | **141 tests**: 141 passed, 0 failed (100% pass rate) |
| `npm run admin:build` (Vite & TypeScript compilation) | Clean build, 0 TypeScript errors, production assets bundled |
| `node --check` on all JS files | No syntax or runtime check failures |
| `prisma format` / `validate` / `generate` | Formatted, valid, client generated (6.19.3) |
| `prisma migrate status` | Database schema migrations up to date |
| `npm audit` | 3 high, all in the dev-only Prisma CLI chain (SEC-017); none in runtime code |
| Live Supabase Security | RLS enabled for all tables; public rights revoked; bucket private with MIME and size constraints |
| Server smoke test (real configuration) | `/health` 200 with `nosniff`, HSTS, CSP; wrong verify token 403; unsigned webhook POST 401; invalid login types 400; unauthenticated `/auth/me` 401; malformed JSON 400 |

### Test Coverage by Area

| Area | Test file |
|---|---|
| Admin login, inactive admins, timing mitigation, input validation, JWT cookies | `test/adminAuth.test.js` |
| Admin Role-Based Access Control (SUPER_ADMIN, OPERATOR, VIEWER permissions) | `test/adminRbac.test.js` |
| Admin Invitation System (creation, token hashing, 24h expiration, single-use, revocation, deletion) | `test/adminInvitations.test.js` |
| Forgot Password / Reset Password (anti-enumeration, dummy bcrypt timing, 1h expiration, token hashing, rate limit) | `test/adminPasswordReset.test.js` |
| Login & Auth rate limiting | `test/loginRateLimit.test.js` |
| Outbound Email Service (SMTP transporter, environment config, URL resolution, template rendering) | `test/emailService.test.js` |
| Webhook signature, malformed payloads, replay (sequential and parallel), disguised files, verify token, safe logging | `test/whatsappWebhook.test.js` |
| Message-ID cache: TTL, bounded size, release | `test/messageIdempotency.test.js` |
| Media pre-check, streaming limit, timeouts, host allowlist, redirects | `test/whatsappMediaService.test.js` |
| File signatures, temporary naming | `test/fileSafety.test.js` |
| OCR limits and resource caps | `test/ocrResourceLimits.test.js` |
| Error responses and sanitization | `test/errorHandling.test.js` |
| Headers, CSP, proxy trust, startup environment check | `test/appSecurity.test.js` |
| Admin provisioning, CLI safety | `test/adminProvisioning.test.js` |
| Checksums, naming, storage, rollback | `test/fileChecksum.test.js`, `test/documentChecksum.test.js`, `test/storageNaming.test.js`, `test/permanentStorage.test.js`, `test/clientDocument.test.js` |
| Identity rules, placement, no PII in summaries | `test/identityVerification.test.js`, `test/storagePlacement.test.js`, `test/documentProcessing.test.js`, `test/ocrDiagnostics.test.js` |
| Frontend React components, auth flows, setup password, reset password, invitations | `admin/src/**/*.test.tsx` (141 tests) |

---

## 6. Remaining Deployment Actions

1. **Production Base URL:** Ensure `APP_BASE_URL` in `.env` is set to the live production domain (e.g. `https://admin.emlynk.com`) so emailed invitation and reset links point to the public site.
2. **SMTP Configuration:** Ensure production SMTP credentials (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`) are securely populated in production secret stores.
3. **Proxy Configuration:** Set `TRUST_PROXY_HOPS` to the exact hop count when deploying behind a reverse proxy or cloud load balancer.
4. **Initial Super Admin:** Created via `npm run admin:create -- --name "…" --email … --role SUPER_ADMIN`.
5. **Re-check SEC-017:** Monitor Prisma upgrades for resolution of upstream CLI dependency advisory.

---

## 7. Final Security Status

**READY FOR CONTROLLED TESTING & PRODUCTION PREPARATION.**
All core webhook processing, OCR limits, cloud storage access, RBAC boundaries, administrative onboarding, password recovery, and session protections are fully tested and verified.
