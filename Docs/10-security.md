# Security

Consolidates the security overview document with the security-relevant parts of the admin authentication and WhatsApp security documents, corrected against the current code and deployment. Full original documents, including the complete dated SEC-*/AUDIT-* findings history and point-in-time test-run numbers, are kept in `Docs/archive/` (`13-security-overview.md`, `03-admin-authentication.md`). WhatsApp-specific mechanics (HMAC verification, idempotency) are in `04-whatsapp-integration.md`; this document covers admin authentication, RBAC, storage/database access control, and cross-cutting practices.

**Two corrections against the archived security overview**, verified directly against the running code: the session cookie's `SameSite` attribute is `strict`, not `lax` as an earlier draft of that document stated; the three admin roles are `ADMIN`, `REVIEWER`, `VIEWER` (an earlier draft's findings table inconsistently referred to `SUPER_ADMIN`/`OPERATOR` in one place — that was never the actual role model).

## Authentication

- **Password storage:** bcrypt, minimum 10 rounds. Hashes are never returned in API responses or logged.
- **Session token:** an HS256 JWT (`JWT_SECRET`, enforced ≥ 32 characters at startup), delivered in an `httpOnly`, `SameSite=Strict`, `Secure`-in-production cookie (`emlynk_admin_token`). A `Bearer` header is also accepted, kept for CLI tools and tests.
- **Why `httpOnly` + `SameSite=Strict` together:** `httpOnly` stops a cross-site script from reading the token via `document.cookie`; `SameSite=Strict` stops the cookie from being sent on a cross-site request at all, which is also what makes a separate CSRF token unnecessary — a forged request from another site simply doesn't carry the cookie.
- **Zero-enumeration login:** every login failure — unknown email, wrong password, inactive account — returns the same generic `401 Invalid email or password`. An unknown email still runs a dummy bcrypt comparison, so response timing doesn't leak whether the account exists.
- **Live active-admin check:** `requireActiveAdmin` re-verifies `Admin.status === 'ACTIVE'` directly in PostgreSQL on every request, not just at login — deactivating an admin takes effect immediately, without waiting for their token to expire.
- **Login rate limiting:** 5 failed attempts per 15 minutes per client IP; successful logins don't consume the allowance. Backed by PostgreSQL (`postgresRateLimitStore.js`, see `08-cloud-deployment.md`), so the limit holds across every app instance, not just within one process.

## Role-Based Access Control

Three roles, enforced by `requireRole` middleware on every admin route:

| Action | ADMIN | REVIEWER | VIEWER |
|---|:---:|:---:|:---:|
| View overview, documents, clients, review queue, police workflow, daily reports | ✓ | ✓ | ✓ |
| Review actions (approve, keep pending, remove, retry, replace, re-type, assign) | ✓ | ✓ | — |
| Correct a stored police slip's date | ✓ | — | — |
| Send/revoke admin invitations | ✓ | — | — |
| Create admin accounts (CLI) | ✓ | — | — |

A failed authorization check returns a generic `403`, without indicating which specific permission was missing.

## Admin Invitations and Password Reset

- **Invitations:** 256-bit random token (`crypto.randomBytes(32)`), sent once by email; only its SHA-256 hash is stored (`admin_invitations.token_hash`). 24-hour expiry, single-use (`PENDING` → `ACCEPTED`, atomically). Only `ADMIN` can send or revoke one.
- **Password reset:** same token/hashing approach, 1-hour expiry, single-use. `POST /auth/forgot-password` always returns the same generic message regardless of whether the email exists or the account is active — an unknown email still runs a dummy bcrypt comparison for the same reason as login. A new reset request invalidates any earlier active token for that admin. Rate limited to 5 requests per 15 minutes per IP, for the same reason as login.
- **Email dispatch is fire-and-forget** with respect to the HTTP response: the response returns at the same time whether or not the send has completed, so response timing can't be used to distinguish an active account (real email sent) from an inactive one.

## WhatsApp Webhook

See `04-whatsapp-integration.md` for the full mechanics. In summary: HMAC-SHA256 over the raw body on every `POST`, timing-safe comparison; the verify-token handshake compared in constant time; message-level replay/idempotency protection with a durable database backstop; the access token only ever sent to `fbsbx.com` or its subdomains.

## Files and OCR

- Allowed types: `application/pdf`, `image/jpeg`, `image/png`; 10 MB maximum.
- File content must match its declared type (`%PDF-` header, JPEG/PNG magic bytes) — a renamed executable or mismatched extension is rejected regardless of what the sender claimed.
- Media metadata is checked before download; a streamed download is cancelled the moment it exceeds the size limit, with separate timeouts for the metadata lookup and the download itself.
- Stored object names always take their extension from the *validated* MIME type, never from the sender's file name; sender-supplied names are sanitized before any other use.
- OCR resource limits (image dimensions/megapixels, PDF page count, concurrent job count, queue depth, wait/job timeouts) are enforced by the OCR service itself — see `ocr-worker/README.md`.

## Database and Storage

- **Row-level security:** every table has RLS enabled with no policies defined, and Supabase's public API roles (`anon`, `authenticated`) have had all privileges explicitly revoked — including on tables created by future migrations (`ALTER DEFAULT PRIVILEGES`). The backend connects as the table owner, which bypasses RLS, so this only restricts Supabase's own public API, not the backend.
- **Parameterized queries only:** Prisma throughout; no raw SQL string concatenation anywhere in the codebase.
- **Private bucket:** no public or signed URLs are ever created. The admin dashboard streams a file preview through an authenticated Express/Vercel route instead of handing out a storage URL.
- **Storage paths never contain a WhatsApp number** — see `06-storage-management.md` for the exact path rules.
- **Checksum-based duplicate detection:** SHA-256 of the received bytes, enforced by a database unique constraint (`(passport_id, file_sha256)`), not just application logic.

## Identity and Conflict Handling

- `passport_id` is the identity; the WhatsApp number is a signal only, never sufficient on its own to attach a document to a client's permanent record — see `03-database-design.md` (Critical Identifier Distinction) and `05-ocr-document-processing.md` (Identity Verification).
- Identity conflicts and ambiguous matches are never merged or auto-resolved; they're routed to the review queue for a person to decide.
- Client fields are only ever filled (never overwritten) for a verified match with field confidence ≥ 90.

## Logging and Error Handling

- Never logged: document text, names, dates of birth, passport numbers, full phone numbers, raw file paths, raw message IDs, tokens (session, reset, invitation).
- Webhook logs use a one-way hash of the message ID (`messageRef`) instead of the ID itself.
- Errors are logged by type or a redacted first line (`src/utils/safeLog.js`) — never a raw error object that might contain query values.
- The Express error handler returns a generic JSON error (400/413/500) with no stack trace and no server file paths, in every environment.
- Startup fails fast and by name only (never by value) on any missing or malformed required setting (`src/config/env.js`).

## HTTP Hardening

- `X-Powered-By` disabled.
- Helmet sets `nosniff`, frame protection, HSTS, and a CSP that allows `blob:` specifically for in-browser PDF/image preview, with no other relaxation.
- `trust proxy` is off by default, so a client can never spoof its own IP via `X-Forwarded-For` for rate-limiting purposes. Behind a real proxy (a production requirement — see `08-cloud-deployment.md`), `TRUST_PROXY_HOPS` must be set to the exact hop count; it is never set to `true`, which would trust an arbitrary chain length.

## Known Accepted Risks

- **Concurrent identical submissions** can, in a narrow race, create an extra pending copy or skip a version number. Accepted: the consequence is a harmless duplicate in the review queue, not data loss or a security exposure.
- **JWT revocation delay:** revoking an already-issued, unexpired token before it naturally expires requires deactivating the admin record (`status = 'INACTIVE'`, which `requireActiveAdmin` checks live) or rotating `JWT_SECRET` (which invalidates every session at once). There is no per-token revocation list.

## Full Security Findings History

The complete, dated SEC-001 through SEC-028 and AUDIT-001 through AUDIT-009 findings — including ones now fully resolved and no longer relevant to current behavior — are preserved in `Docs/archive/13-security-overview.md` for reference.
