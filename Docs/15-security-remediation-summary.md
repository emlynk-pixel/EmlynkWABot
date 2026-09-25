# Security Remediation Summary

Short summary of the security work. Full record: `Docs/13-security-audit.md`. Current controls: `Docs/14-current-security-features.md`.

## Result

- 23 findings: **18 fixed**, **2 verified live** (database access, bucket limits), **2 accepted** (dev-only dependency advisory, rare duplicate pending copies), **1 fixed but needs business approval** (SEC-008).
- 526 automated tests pass, including real OCR.
- Status: **READY FOR CONTROLLED TESTING**.

## Most Important Changes

1. **Database locked down:** Supabase's public roles can no longer reach any table (SEC-001).
2. **Downloads bounded:** size checked before and during download, with timeouts; OCR limited in size, pages, concurrency and time (SEC-002, SEC-007).
3. **Admin login hardened:** generic errors, rate limit, inactive accounts blocked, timing equalised, input validated, HS256 only (SEC-003–005, 012, 013).
4. **Webhook hardened:** replays stopped before any work is done, verify token compared in constant time, token only sent to Meta's media host (SEC-006, 014, 018).
5. **Files checked by content:** magic bytes must match the type; stored extension comes from the type, never the sender's name (SEC-009, 010).
6. **No personal data in logs** (SEC-011).
7. **Safer operations:** startup environment check, security headers, `npm run admin:create`, hard-coded test password removed (SEC-015, 016, 019, 023).

## Business-Rule Change to Approve (SEC-008)

A passport from a known client **without a WhatsApp number on record** now goes to **manual review** (`pending/{unique_id}`) instead of straight into the client's folder. It stays linked to the passport. Reason: a passport number alone doesn't prove the sender is the client. To revert, change one line in `identityVerificationService.js`.

## Before Production

1. Approve or reject the SEC-008 change.
2. Create the first admin: `npm run admin:create -- --name "…" --email …`.
3. Behind a proxy or load balancer: set `TRUST_PROXY_HOPS`.
4. Run one app instance (the replay cache is in memory).
5. Send real test messages from a test WhatsApp number end to end.
