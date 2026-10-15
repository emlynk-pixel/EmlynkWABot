# Candidate Extra Details Form — Issues and Solutions Log

Branch: `version/candidate-extra-details-form`
Last updated: 2026-10-15 (after the Task 1 security cleanup)

Related documents:
- [CANDIDATE_EXTRA_DETAILS_FORM_SECURITY_RISKS.md](CANDIDATE_EXTRA_DETAILS_FORM_SECURITY_RISKS.md): the risk register (`R-xxx`) and preventive controls.

---

## 1. Purpose

This is the engineering log for the Candidate Extra Details Form. It records what **actually happened** while the form was designed, audited and built:

- the issue or situation, and when and where it came up
- its impact and root cause
- how it was solved, mitigated or deferred
- which tests verify the result
- what is still open

It is not the security risk document. The risk document lists what *could* go wrong and the controls that prevent it. This log lists what *did* come up and how it was handled. Where an entry matches a register risk, the risk ID is given.

### Phases referenced

| Phase | What it was |
|---|---|
| **Audit** | Repository security and data-leakage audit before implementation. Findings were recorded in the security risk document. |
| **Task 1** | Candidate form setup and secure backend API: `candidate-form/`, `POST /api/public/candidate-details/verify`, candidate token, public CORS, public rate limits, tests. |
| **Task 1 cleanup** | Fix of the two security issues left after Task 1: the timing difference and the CSP mismatch. |
| **Task 3** | Planned: the public read and save of the 19 Additional Details fields. |
| **Task 4** | Planned: load testing and release hardening. |

The Task 1 work, the Task 1 cleanup and the final audit edits are dated 2026-10-15 (file dates on the branch). The Audit phase came before Task 1 and has no separately recorded date.

### Statuses

| Status | Meaning |
|---|---|
| Solved | Fixed in the code on this branch and covered by tests. |
| Mitigated | Controlled by code or a required configuration, with a stated residual risk. |
| Open | Not yet fixed; scheduled for a named task. |
| Deferred | Intentionally moved to a later task. |
| Release Blocker | Must be resolved before the form goes live. |
| Accepted Risk | Known, left unchanged on purpose; reviewed again later. |

---

## 2. Issue Log

Test IDs refer to [test/publicCandidateDetails.test.js](../test/publicCandidateDetails.test.js) unless stated otherwise.

| ID | Date/Task | Area | Issue / Situation | Impact | Root Cause | Resolution / Decision | Verification | Status |
|---|---|---|---|---|---|---|---|---|
| ISS-001 | Audit; Task 1 | Security: input / SQL | `%` and `_` act as wildcards in the case-insensitive passport lookup (`resolveCandidatePassportId`). In an executed check, `AB%` and `A_123456` resolved `AB123456`. (R-081) | A public lookup that passed raw input could match a different candidate's passport. | Prisma `equals` with `mode: "insensitive"` is translated to `ILIKE`, where `%` and `_` are pattern characters. | Strict validation runs before any database access: the passport is trimmed, spaces and hyphens are removed, then it must match `^[A-Za-z0-9]{1,20}$`, otherwise 400. The public verify service uses the same insensitive lookup, so this validation stays mandatory. Existing staff callers already validate first. | VERIFY-006/007/009 (wildcard and SQL-like passports are a 400 with **zero** candidate queries) | Solved |
| ISS-002 | Audit | Data exposure | Existing services return more than the public form may show. `getAdditionalDetails` (`view()`) returns `passportId` and `suggested` core data. `getCandidate` returns NIC, nationality, sex, passport dates, WhatsApp, contact number, address, stages and documents. The `saveAdditionalDetails` response returns the same `view()`. (R-004) | Reusing these services in the public API would leak candidate core data. | They were written for staff screens, which are allowed to see everything. | Do not reuse their responses publicly. Task 3 must add a dedicated public DTO limited to the 19 Additional Details fields and `updatedDate`. Task 1 exposes no candidate data: the verify response is `{ token, expiresAt }` only. | Task 1: VERIFY-010, TIMING-003. Task 3: tests still to be written. | Open |
| ISS-003 | Audit | Data integrity | `saveAdditionalDetails` is a full replacement. An empty body, or one with only unknown keys, parses as all 19 fields empty and clears the stored details. (R-047, R-046) | One malformed or replayed request from the form could wipe a candidate's details. Concurrent Admin and candidate edits could overwrite each other. | The staff save writes every field and silently ignores unknown keys. | The public PUT (Task 3) must require `expectedUpdatedDate` and all fields, and reject unknown keys, an empty payload and invalid values with a 400. The existing staff save is unchanged. | Task 3: tests still to be written | Open |
| ISS-004 | Audit; Task 1 | Security: auth | A JWT-shaped (`h.p.s`) candidate token sent to staff routes is rejected (401), but each request first makes a Supabase Auth verification call. (R-084) | Wasted Supabase calls, which an attacker could amplify, and a candidate token entering the staff auth path. | `createAccessTokenVerifier` treats any three-segment token as a possible Supabase JWT. | The candidate token uses a custom format that is not JWT-shaped: `cf1~<iv>~<ciphertext>`. It is AES-256-GCM with HKDF-derived keys, has a 15-minute TTL and is bound to the WhatsApp number by an HMAC. Staff routes reject it without calling Supabase. | TOKEN-001 (not JWT-shaped), TOKEN-002, TOKEN-003, TOKEN-004 (rejected by `/api/admin/*` and `/auth/*` with **zero** Supabase calls), TOKEN-005 | Solved |
| ISS-005 | Task 1 → Task 1 cleanup | Security: enumeration | Verification timing: the passport-not-found path did one database query, while the wrong-WhatsApp path did two plus a comparison. (R-027) | Latency could hint whether a passport exists. | Verification first resolved the passport (exact `findUnique`, then insensitive `findMany`), then read the candidate's WhatsApp in a second query only when a passport was found. | `verifyCandidateDetailsAccess` now makes **exactly one** query on every path: one `findMany` (case-insensitive equals, `passportId` and `whatsappNumber` columns only, `take: 10`). It picks the exact-case row, otherwise the single match, and fails on ambiguity. It always runs the normalise-and-compare step, against a placeholder number when nothing matched. Every failure gets one generic 401. No fake rows, no writes, no sleeps. **Residual:** the database's own zero-row vs one-row difference (sub-millisecond, below network jitter), bounded by the rate limits (ISS-009). | TIMING-001 (identical status, body and headers for not-found, wrong-WhatsApp and ambiguous case variants), TIMING-002 (same single query on every path, including success), TIMING-003, VERIFY-002/003/004 | Mitigated |
| ISS-006 | Task 1 → Task 1 cleanup | Security: headers | CSP mismatch: the `candidate-form/vercel.json` header CSP had `connect-src https:`, while the build-time `<meta>` CSP was stricter. (R-039) | The header did not enforce the API boundary itself. Only the meta tag did, so a missing or altered meta tag would allow connections to any HTTPS host. | The header was written statically, before the API origin was known at build time. | [candidate-form/csp.ts](../candidate-form/csp.ts) holds both policies. The **meta** CSP owns every fetch directive, with `connect-src` set to exactly the `VITE_API_BASE_URL` origin (`'self'` only when it is empty); an invalid value fails the build. The **header** CSP carries only `frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'; upgrade-insecure-requests`. Neither contains `https:` or `*`. The header on the deployed site is not yet checked (HDR-001, section 8). | CSP-001, CSP-002, CSP-003 (built `dist/index.html`), candidate-form build with `VITE_API_BASE_URL=https://api.example.test` | Solved |
| ISS-007 | Audit; Task 1 | Deployment | The form shares this repository with the backend. A Vercel project created from the repository root uses the root `vercel.json`, which installs the Admin app and routes `/auth`, `/api`, `/whatsapp` and `/health` to the backend function. (R-083, R-021) | Project B could deploy a second copy of the backend, with backend environment variables, instead of a static form. | One repository holds two separately deployed apps. | Project B must use **Root Directory = `candidate-form/`**. That folder has its own `vercel.json` (static Vite build, SPA rewrite, security headers) and no `api/` function. Documented in the security document and `candidate-form/README.md`. | Not testable in the repository; confirmed when Project B is created | Mitigated |
| ISS-008 | Audit; Task 1 | Security: CORS | No public CORS existed: Admin is served same-origin, so the backend never granted cross-origin access. The form is on a different origin. (R-023) | Without a deliberate policy the form could not call the API. A loose policy (`*`, reflected origin, credentials) would expose the API to any site. | The new deployment topology (form on its own origin). | CORS only on the public router, for exactly `CANDIDATE_FORM_ORIGIN`, without credentials. A preflight from that origin gets 204 with `POST, OPTIONS` and `Content-Type, Authorization`; any other Origin gets 403 and no grant. Admin routes never grant CORS. CORS is not treated as authorization. | CORS-001, CORS-002 | Solved |
| ISS-009 | Audit; Task 1 | Security: abuse | The staff API limit (1000 requests per 15 minutes) is far too permissive for an unauthenticated identity check. (R-028, R-029) | Brute force or enumeration of Passport + WhatsApp pairs. | The existing limiter was sized for authenticated staff traffic. | Separate public limits in the PostgreSQL store, counting failed attempts only. **Per IP:** 10 per 15 minutes. **Per passport:** 5 per hour, keyed by a keyed hash of the passport (`passportReference`), never the raw value. | RATE-001 (limits per IP and per passport, successes not counted, keys hold no raw passport) | Solved |
| ISS-010 | Audit; Task 1 | Secrets / frontend | Project B is a public static bundle; it must not receive backend or Supabase secrets. (R-021) | A secret built into the bundle would be readable by anyone. | Vite embeds any variable matching `envPrefix` into the bundle. | `envPrefix: "VITE_API_"`; the only variable read is `VITE_API_BASE_URL`; `.env.example` lists only that; no Supabase, Prisma, `pg` or Google packages; `sourcemap: false`. The repository side is enforced by tests. The Vercel project's environment variables remain a manual setting. | SECRET-001 (scans sources, config and any built bundle for backend secret names; checks `envPrefix`, `sourcemap`, `.env.example`, dependencies and that there are no `.map` files) | Mitigated |
| ISS-011 | Task 1 | Tooling / repository | `candidate-form/public/robots.txt` did not appear in `git status`. | The `noindex` robots file would have been missing from commits and deployments. | The developer's local `.git/info/exclude` contains `public/`, which ignores every `public/` folder. | Renamed the folder to `candidate-form/static/` and set `publicDir: "static"` in `vite.config.ts`; the build copies `robots.txt` to `dist/`. Indexing is also blocked by `X-Robots-Tag` and a `noindex` meta tag. | `git status` shows `candidate-form/static/robots.txt`; build output | Solved |
| ISS-012 | Audit | Security: database | 13 of 14 application tables have explicit `ENABLE ROW LEVEL SECURITY` and revoke statements in their migrations; `candidate_allocation` has neither. (R-019, R-020) | If live privileges allow it, allocation rows could be read or changed through Supabase's PostgREST API with the public key, bypassing Express. | The allocation migration did not include the RLS and revoke statements the other tables have. Its live privileges were assumed to match, but that is unverified. | Check live privileges on `candidate_allocation`. If `anon` or `authenticated` have access, add RLS and revokes in a new migration (not by editing history). No schema change was made in Task 1. | Live check still to be done | Release Blocker |
| ISS-013 | Audit | Security: database | The repository audit cannot prove live `anon` / `authenticated` table privileges or Supabase Storage bucket policies. (R-019, R-020) | Direct Supabase access could bypass every control in this log. | Live Supabase configuration is not stored in the repository; Storage policies are not in migrations. | Before release, verify live table privileges for `anon` and `authenticated`, RLS status on all tables and Storage bucket policies. Record the evidence. | Live check still to be done | Release Blocker |
| ISS-014 | Audit; Task 1 | Availability | Public verification adds database work (rate-limit writes and a candidate lookup) to the same Express app, Vercel function and connection pool as Admin (`DATABASE_POOL_MAX` default 3). (R-057, R-058) | A burst against `verify` could exhaust the pool and slow or fail Admin requests (`P2024`). | Same-repository, shared-backend design. | Task 1 bounds the work per request: rejected input, an unusable secret and disallowed origins stop before any candidate query. The effect of load on Admin is **untested**; it moves to Task 4. | Task 4 load test still to be run | Deferred |
| ISS-015 | Task 1 | Availability: abuse | Per-passport lockout: anyone who knows a candidate's passport number can make 5 failed attempts and block verification for that passport for up to an hour. (R-030) | The real candidate cannot verify until the window passes. | The per-passport limit counts failures regardless of who made them. Once it is reached, even a correct attempt is refused. | Kept as designed for Task 1. The per-IP limit slows an attacker spreading attempts; Admin is unaffected (separate limiter, staff can still edit the details); the lockout expires. Revisit in Task 4 (for example a shorter window, or exempting a correct WhatsApp match). | RATE-001 | Accepted Risk |
| ISS-016 | Task 1 | Configuration | The form must not work partially when its configuration is missing or wrong. | A half-configured deployment could expose the endpoint with weak settings. | Both backend variables are optional for the server as a whole, so the server starts without them. | **Fails closed.** A missing or short (< 32 characters) `CANDIDATE_FORM_TOKEN_SECRET` makes `verify` and the token middleware return 503 before any counting or lookup. A missing or invalid `CANDIDATE_FORM_ORIGIN` means no browser origin is allowed (403). A value that is set but malformed is reported by the startup environment check. In the form, a missing `VITE_API_BASE_URL` shows "Not available", and an invalid one fails the build. The Admin app and API are unaffected. | Unusable-secret test (503) in the VERIFY suite; "Configuration checks" test; CORS-002; CSP-001 (invalid base URL fails the build) | Solved |
| ISS-017 | Audit; Task 1 | Security: matching | `normalizePhoneNumber` expands Sri Lankan local forms, so the inputs `+0771234567` and `+771234567` matched a stored `+94771234567` (executed). (R-043) | A number that is not the candidate's could pass verification. | The normaliser was built for comparing stored numbers (it accepts local formats), not for strictly validating public input. | The public input must be `+` followed by 8–15 digits with a non-zero first digit, and is compared as those digits **without** the local-form expansion. Only the stored number is normalised. | VERIFY-008, VERIFY-008b | Solved |
| ISS-018 | Task 1 cleanup | Testing | The first run of CSP-003 failed against the built `dist/index.html`. | One failing test; no product impact. | Vite HTML-escapes attribute values (`'` becomes `&#39;`), so the raw meta `content` did not equal the generated policy string. | The test decodes HTML entities before comparing. | CSP-003 passes; public candidate suite 27/27 | Solved |

ISS-017 and ISS-018 are not in the original list of 16. They are added because they also happened (ISS-017 in the audit, ISS-018 during the Task 1 cleanup).

---

## 3. Security Issues

| ID | Summary | Status |
|---|---|---|
| ISS-001 | Passport wildcard behaviour (`%`, `_`) | Solved |
| ISS-004 | JWT-shaped candidate token reached the Supabase verification path | Solved |
| ISS-005 | Verification timing difference | Mitigated |
| ISS-006 | Header CSP allowed `connect-src https:` | Solved |
| ISS-008 | No public CORS policy | Solved |
| ISS-009 | Staff rate limit too permissive for verification | Solved |
| ISS-010 | Secret exposure through the form bundle | Mitigated |
| ISS-012 | `candidate_allocation` RLS gap | Release Blocker |
| ISS-013 | Live Supabase privileges and Storage policies unverified | Release Blocker |
| ISS-015 | Per-passport lockout | Accepted Risk |
| ISS-017 | Phone local-form expansion matched foreign-looking input | Solved |

What these have in common: the public API cannot trust behaviour that is safe for staff. The staff routes already validated input, sent no CORS and served authenticated users, so lookup wildcards, the phone normaliser's leniency and the generous rate limit were never exposed. Each needed an explicit public-path control.

**Residual timing risk (ISS-005).** The query count is equal on every path, and the work after the lookup is equal. What remains is:
- the database returning zero rows versus one row;
- serialising one small row;
- `safeEqual`'s early return when the two lengths differ.

All are sub-millisecond, and the rate limits allow 5 attempts per passport per hour.

---

## 4. Data Integrity Issues

| ID | Summary | Status |
|---|---|---|
| ISS-002 | Existing services over-fetch candidate data | Open (Task 3) |
| ISS-003 | Additional Details save is a full replacement | Open (Task 3) |

Neither affects the code as it stands: Task 1 adds no read or save of candidate details. Both are **entry conditions for Task 3**. The public read and save must use a dedicated DTO and service. The save must use `expectedUpdatedDate` (optimistic concurrency) and reject invalid payloads.

---

## 5. Deployment / Environment Issues

| ID | Summary | Status |
|---|---|---|
| ISS-007 | Project B must use Root Directory `candidate-form/` | Mitigated |
| ISS-011 | `robots.txt` hidden by a local `public/` ignore rule | Solved |
| ISS-014 | Shared database pool and the load impact on Admin | Deferred (Task 4) |
| ISS-016 | Fail-closed behaviour when configuration is missing | Solved |

**Required deployment settings for Project B:**
- Root Directory `candidate-form/`.
- `VITE_API_BASE_URL`, set to the backend origin over https with no path. This is the only environment variable.

**Required backend settings:**
- `CANDIDATE_FORM_ORIGIN`: the form's exact origin.
- `CANDIDATE_FORM_TOKEN_SECRET`: 32 or more random characters.

---

## 6. Frontend / UX Issues

No frontend or UX defects have been recorded. Task 1 built only the verification screen; the 19-field form is Task 2.

Frontend-relevant behaviour recorded elsewhere in this log:
- An unconfigured build shows "Not available" (ISS-016).
- Every verification failure shows one generic message (ISS-005).
- A candidate whose passport is locked out sees the rate-limit message for up to an hour (ISS-015).

---

## 7. Testing / QA Issues

| ID | Summary | Status |
|---|---|---|
| ISS-018 | CSP-003 compared HTML-escaped meta content | Solved |

Test results after the Task 1 cleanup (2026-10-15):

| Suite | Result |
|---|---|
| `test/publicCandidateDetails.test.js` | 27 / 27 pass |
| Backend `npm test` | 1601 tests: 1579 pass, 0 fail, 22 skipped |
| Admin `npm test` | 448 / 448 pass |
| `candidate-form` typecheck and build | Pass; no `.map` files in `dist/` |

Coverage gaps:
- ISS-002 and ISS-003 have no tests yet (Task 3).
- ISS-007, ISS-012 and ISS-013 cannot be verified from the repository.
- ISS-014 needs the Task 4 load test.
- The deployed response headers (HDR-001) are untested.

---

## 8. Open / Deferred Items

| ID | Item | Owner phase | Status |
|---|---|---|---|
| ISS-002 | Dedicated public DTO for reading and saving Additional Details | Task 3 | Open |
| ISS-003 | Public PUT with `expectedUpdatedDate`; reject empty, unknown or invalid payloads | Task 3 | Open |
| ISS-012 | `candidate_allocation` live privileges; RLS and revokes if needed | Before release | Release Blocker |
| ISS-013 | Live Supabase table privileges, RLS and Storage policies | Before release | Release Blocker |
| ISS-014 | Load test of public verification against Admin traffic | Task 4 | Deferred |
| ISS-015 | Review the per-passport lockout window and policy | Task 4 | Accepted Risk |
| ISS-006 (follow-up) | Confirm the deployed Project B response headers match `vercel.json` (HDR-001) | First Project B deployment | Open check (the issue itself is Solved) |
| ISS-007 (follow-up) | Confirm Project B was created with Root Directory `candidate-form/` | First Project B deployment | Open check (the issue itself is Mitigated) |

---

## 9. Lessons Learned

1. **Validate before the database, every time.** Prisma's case-insensitive `equals` is `ILIKE`, so user input can carry wildcards (ISS-001). Strict allow-list validation before any lookup is required, not optional.
2. **Staff helpers are not public helpers.** Over-fetching services (ISS-002), the full-replacement save (ISS-003) and the lenient phone normaliser (ISS-017) were all correct for staff and wrong for a public caller. The public path gets its own validation, DTOs and services.
3. **Make failure paths do the same work.** Generic messages are not enough if one path does more database work than another (ISS-005). Equalise the queries, then let the rate limits bound what remains.
4. **The effective CSP is the intersection of every policy.** Keep each directive in exactly one layer and test that the other layer cannot widen it (ISS-006).
5. **Token shape matters.** A token that looks like a JWT is treated as one by middleware it should never reach (ISS-004).
6. **Fail closed on configuration.** A missing secret or origin disables the feature, not the protection (ISS-016).
7. **Local ignore rules can hide files.** Check `git status` for every new file before relying on it (ISS-011).
8. **Repository audits stop at the repository.** Live Supabase privileges and policies need their own verification and evidence (ISS-012, ISS-013).

---

## 10. Release Blockers

The form must not go live until each of these is resolved and the evidence recorded:

| ID | Blocker | Done when |
|---|---|---|
| ISS-012 | `candidate_allocation` has no RLS or revokes in its migration | Live privileges checked, and if `anon` or `authenticated` have access, a new migration adds RLS and revokes, with the result recorded. |
| ISS-013 | Live Supabase privileges and Storage policies unverified | Table privileges, RLS status and Storage bucket policies checked live, with no public access to candidate data. |

ISS-002 and ISS-003 block the **Task 3** release (the details read and save). They do not block Task 1, which reads and writes no candidate details.

Before the first production deployment, also complete the follow-up checks in section 8: deployed headers (HDR-001) and the Project B Root Directory.

---

## Summary counts

| Status | Count | IDs |
|---|---|---|
| Solved | 9 | ISS-001, 004, 006, 008, 009, 011, 016, 017, 018 |
| Mitigated | 3 | ISS-005, 007, 010 |
| Open | 2 | ISS-002, 003 |
| Deferred | 1 | ISS-014 |
| Release Blocker | 2 | ISS-012, 013 |
| Accepted Risk | 1 | ISS-015 |
| **Total** | **18** | |
