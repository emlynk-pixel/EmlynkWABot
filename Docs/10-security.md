# Security

Consolidates the security overview document with the security-relevant parts of the admin authentication and WhatsApp security documents, corrected against the current code and deployment. Full original documents, including the complete dated SEC-*/AUDIT-* findings history and point-in-time test-run numbers, are kept in `Docs/archive/` (`13-security-overview.md`, `03-admin-authentication.md`). WhatsApp-specific mechanics (HMAC verification, idempotency) are in `04-whatsapp-integration.md`; this document covers admin authentication, RBAC, storage/database access control, and cross-cutting practices.

Authentication is Supabase Auth's; authorization is the application's. The design and its security decisions are in `SUPABASE_AUTH.md`.

## Authentication

- **Credentials and sessions:** Supabase Auth stores passwords (the application stores none), issues and refreshes sessions, and sends sign-in, invitation and recovery emails through the SMTP server configured in the Supabase dashboard. The application has no `JWT_SECRET` and no SMTP settings.
- **Every request:** the admin app sends `Authorization: Bearer <Supabase access token>`. The backend verifies it with Supabase (`auth.getUser`), loads `public."user"` by `auth_user_id`, and requires `status = 'ACTIVE'`, on every request. If Supabase cannot be reached the request fails closed.
- **No cookie authenticates a request**, so CSRF protection does not apply and the CSRF middleware was removed. If cookie-based auth is ever reintroduced, CSRF protection must return with it.
- **Role from the database only:** the role is read from `public."user".role` on every request, never from a token claim, request body or Supabase metadata. Deactivating a user takes effect on their next request.
- **Service-role key:** `SUPABASE_SERVICE_ROLE_KEY` is server-side only. The browser build has only `VITE_SUPABASE_URL` and the anon / publishable key, and refuses a secret key.
- **Token storage:** the Supabase session lives in `sessionStorage` (per tab). XSS is the main threat to any browser-held token; the strict CSP (`script-src 'self'`) is the mitigation.
- **Rate limiting:** sign-in, invitation and recovery limits are Supabase's (Authentication > Rate Limits). The API itself has a generic PostgreSQL-backed limiter (`postgresRateLimitStore.js`, see `08-cloud-deployment.md`) that holds across every app instance.

## Role-Based Access Control

Four roles, stored in `public."user".role` and enforced by `requireRole` middleware on every admin route:

| Action | ADMIN | MANAGER | ANALYST | REGISTRATION_DESK |
|---|:---:|:---:|:---:|:---:|
| View overview, documents, clients, review queue, police workflow, reports | ✓ | ✓ | ✓ | — |
| Candidate list, registration and details | ✓ | ✓ | ✓ | ✓ |
| Review actions, corrections, candidate work | ✓ | ✓ | ✓ | — |
| Correct a stored police slip's date | ✓ | ✓ | — | — |
| Invite, list, change role, deactivate users; Settings | ✓ | — | — | — |

A failed authorization check returns a generic `403`, without indicating which specific permission was missing. The route-by-route map is in `09a-admin-dashboard-api.md`.

## Invitations and Password Recovery

- **Invitations:** ADMIN only. The backend calls Supabase `inviteUserByEmail()` and Supabase sends the email. The redirect is built only from the required `APP_BASE_URL` (`${APP_BASE_URL}/admin/setup-password`), never from request input or headers; if `APP_BASE_URL` is missing or invalid the invitation is refused (503) before anything is sent. There is no silent fallback to Supabase's Site URL.
- **Password recovery:** Supabase's own flow (`resetPasswordForEmail`, then `updateUser` from the recovery link). The forgot-password page shows the same confirmation whether or not the email has an account. The backend stores no reset tokens.
- **Redirect allow-list:** the setup and reset URLs of each environment must be in the Supabase allowed redirect URLs, so a link can only return to a known site.

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

- Never logged: document text, names, dates of birth, passport numbers, full phone numbers, raw file paths, raw message IDs, tokens and passwords (session, recovery, invitation).
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
- **Access-token lifetime:** a Supabase access token stays cryptographically valid until it expires (default one hour), but the backend asks Supabase to verify it and checks the user's `ACTIVE` status on every request, so signing out or deactivating a user is effective on the next request.

## Full Security Findings History

The complete, dated SEC-001 through SEC-028 and AUDIT-001 through AUDIT-009 findings — including ones now fully resolved and no longer relevant to current behavior — are preserved in `Docs/archive/13-security-overview.md` for reference.
