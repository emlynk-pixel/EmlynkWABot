# Candidate Extra Details Form — Issues and Solutions Log

Branch: `version/candidate-extra-details-form`
Last updated: 2026-10-17 (job management and job-group links, four-step form, Admin review workflow, modern date picker; documentation update, not committed)

Related documents:
- [CANDIDATE_EXTRA_DETAILS_FORM_SECURITY_RISKS.md](CANDIDATE_EXTRA_DETAILS_FORM_SECURITY_RISKS.md): the risk register (`R-xxx`) and preventive controls.
- [CANDIDATE_EXTRA_DETAILS_FORM_SHARE_LINKS_DESIGN.md](CANDIDATE_EXTRA_DETAILS_FORM_SHARE_LINKS_DESIGN.md): the Task 3 design (share links, verification, lock, storage, field mapping).

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
| **Task 2** | The candidate-facing form UI: verification and Additional Details screens, English / Sinhala, field components, validation messages, mobile layout, frontend tests. No backend read or save. |
| **Task 2 redesign** | The 19-field screen replaced by the guided Candidate Form (6 sections plus Review, new fields, job categories, English knowledge, guardian), auto-uppercase, Light / Dark theme. Frontend only; no read or save. Checked by the automated suites and by manual UI testing (section 7); no blocking UI issue was found before Task 3. |
| **Task 3** | Share links and the secure read and single submission of the Candidate Form (2026-10-16): staff create a personal link (Admin **Share Form**); the candidate verifies with the link, Passport Number and NIC Number; the form is prefilled from the record; the answers are submitted once into a separate table (`candidate_form_response`). The main candidate tables are never written by the public path. Job-group links, Google Sheet sync and an Admin approve/merge screen are not part of it. |
| **Job management and job-group links** | Job table, Company Job ID, one shared link per job (`JOB_GROUP`), Assign to Job in Admin (ISS-043 to ISS-046, ISS-051 to ISS-053). |
| **Four-step form** | The Candidate Form reduced from seven steps to four with no field or rule removed (ISS-055). |
| **Admin review workflow** | Submitted answers shown inline in Admin, per-field Confirm and Revoke (ISS-047 to ISS-049, ISS-054). |
| **Modern date picker** | One calendar date field for the Candidate Form and Admin (ISS-050). |
| **Task 4** | Planned: load testing and release hardening. |

The Task 1 work, the Task 1 cleanup and the final audit edits are dated 2026-10-15 (file dates on the branch). Task 2 is dated 2026-10-16. The Audit phase came before Task 1 and has no separately recorded date.

### Statuses

| Status | Meaning |
|---|---|
| Solved | Fixed in the code on this branch and covered by tests. |
| Mitigated | Controlled by code or a required configuration, with a stated residual risk. |
| Open | Not yet fixed; scheduled for a named task. |
| Deferred | Intentionally moved to a later task. |
| Release Blocker | Must be resolved before the form goes live. |
| Verified | Checked and found correct; no change was needed. |
| Accepted Risk | Known, left unchanged on purpose; reviewed again later. |

---

## 2. Issue Log

Test IDs refer to [test/publicCandidateDetails.test.js](../test/publicCandidateDetails.test.js) unless stated otherwise.

| ID | Date/Task | Area | Issue / Situation | Impact | Root Cause | Resolution / Decision | Verification | Status |
|---|---|---|---|---|---|---|---|---|
| ISS-001 | Audit; Task 1 | Security: input / SQL | `%` and `_` act as wildcards in the case-insensitive passport lookup (`resolveCandidatePassportId`). In an executed check, `AB%` and `A_123456` resolved `AB123456`. (R-081) | A public lookup that passed raw input could match a different candidate's passport. | Prisma `equals` with `mode: "insensitive"` is translated to `ILIKE`, where `%` and `_` are pattern characters. | Strict validation runs before any database access: the passport is trimmed, spaces and hyphens are removed, then it must match `^[A-Za-z0-9]{1,20}$`, otherwise 400. The public verify service uses the same insensitive lookup, so this validation stays mandatory. Existing staff callers already validate first. | VERIFY-006/007/009 (wildcard and SQL-like passports are a 400 with **zero** candidate queries) | Solved |
| ISS-002 | Audit | Data exposure | Existing services return more than the public form may show. `getAdditionalDetails` (`view()`) returns `passportId` and `suggested` core data. `getCandidate` returns NIC, nationality, sex, passport dates, WhatsApp, contact number, address, stages and documents. The `saveAdditionalDetails` response returns the same `view()`. (R-004) | Reusing these services in the public API would leak candidate core data. | They were written for staff screens, which are allowed to see everything. | Do not reuse their responses publicly. Task 3 must add a dedicated public DTO limited to the Candidate Form's own fields and `updatedDate` (the 19-field Additional Details model was replaced, see ISS-030). Task 1 exposes no candidate data: the verify response is `{ token, expiresAt }` only. **Task 3:** `loadCandidateForm` (`src/services/candidateFormDataService.js`) builds its own whitelist DTO: the identity (passport, NIC, WhatsApp) and the Candidate Form answers only. No staff service response is reused. | Task 1: VERIFY-010, TIMING-003. Task 3: tests still to be written.; Task 3: "DTO whitelist" in test/candidateFormShare.test.js | Solved |
| ISS-003 | Audit | Data integrity | `saveAdditionalDetails` is a full replacement. An empty body, or one with only unknown keys, parses as all 19 fields empty and clears the stored details. (R-047, R-046) | One malformed or replayed request from the form could wipe a candidate's details. Concurrent Admin and candidate edits could overwrite each other. | The staff save writes every field and silently ignores unknown keys. | The public PUT (Task 3) must require `expectedUpdatedDate` and all fields, and reject unknown keys, an empty payload and invalid values with a 400. The existing staff save is unchanged. **Task 3:** the public path never calls the staff save. Answers go to `candidate_form_response` (one insert, once); `parseSubmission` refuses unknown keys and invalid values; there is no PUT and no partial overwrite. | Task 3: tests still to be written; Task 3: "main tables unchanged", "server validation" (candidateFormShare.test.js) | Solved (not used by the public path) |
| ISS-004 | Audit; Task 1 | Security: auth | A JWT-shaped (`h.p.s`) candidate token sent to staff routes is rejected (401), but each request first makes a Supabase Auth verification call. (R-084) | Wasted Supabase calls, which an attacker could amplify, and a candidate token entering the staff auth path. | `createAccessTokenVerifier` treats any three-segment token as a possible Supabase JWT. | The candidate token uses a custom format that is not JWT-shaped: `cf1~<iv>~<ciphertext>`. It is AES-256-GCM with HKDF-derived keys. In Task 1 it lasted 15 minutes and was bound to the WhatsApp number by an HMAC; since Task 3 it lasts 60 minutes (a seven-section form) and carries the share link ID and the access version instead, re-checked on every request. Staff routes reject it without calling Supabase. | TOKEN-001 (not JWT-shaped), TOKEN-002, TOKEN-003, TOKEN-004 (rejected by `/api/admin/*` and `/auth/*` with **zero** Supabase calls), TOKEN-005 | Solved |
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
| ISS-019 | Task 2 | Testing | SECRET-001 failed in this checkout before any Task 2 change (confirmed with the Task 2 changes stashed: public suite 26/27). | The Task 1 public suite did not pass on Windows; no product impact. | `candidate-form/.env.example` has CRLF line endings (the committed file has them, and `core.autocrlf` is on). The test split lines on `"\n"`, so the line read as `VITE_API_BASE_URL=\r`. | The test splits on `/\r?\n/`. What it checks is unchanged: the file still must list exactly `VITE_API_BASE_URL=`. | SECRET-001 passes; public candidate suite 27/27 | Solved |
| ISS-020 | Task 2 | Testing | The new layout test (FORM-004) first read an empty stylesheet. | One failing test; no product impact. | With `css: false` in the Vitest settings, every CSS import is replaced, including `styles.css?raw`. | `css: true` in the `candidate-form` test settings. | FORM-004 passes | Solved |
| ISS-021 | Task 2 | Testing / mobile | Real-browser checks at 320, 375 and 390 px were not possible by resizing headless Edge: its window has a minimum width, and all three rendered at 492 px. | Phone widths could not be checked that way. | Headless browser window minimum. | A temporary page (not committed) loaded the form in iframes of exactly 320, 375, 390, 768 and 1280 px and compared `scrollWidth` with `clientWidth`. All 20 cases matched (verification and details screens, wife fields shown, English and Sinhala): no horizontal scrolling. Screenshots were checked by eye. The committed suite keeps a static CSS check (FORM-004). **Residual:** no automated real-browser width test in the repository. | FORM-004; the one-off measurement above | Mitigated |
| ISS-022 | Task 2 (updated for the redesign) | Frontend / UX | The Candidate Form has nothing to read from or save to: the secure GET and PUT are Task 3. | The candidate could think their details were saved. | Task order: the UI comes before the secure endpoints. | **Intentional, so that nothing pretends to persist.** The form starts empty and says plainly that saving is not connected. **Save Details** checks the answers with the form's own checks, then shows "Saving will be enabled when the secure database integration is connected." and "Nothing has been saved yet."; it sends no request (no PUT). Nothing is kept in the browser either (the theme is the only thing stored). Hidden entries (spouse unless Married, Other Job Category unless OTHER) stay in the form but are left out of what would be sent (`toPayload`); the request shape is typed for Task 3 (`CandidateFormPayload`). The server will check the answers again in Task 3. **Task 3:** the form loads its prefill (`POST /form`) and submits once (`POST /submit`) after a confirmation. The "not connected" notices are gone. A failed send says so plainly, keeps the answers and retries with the same submission key. | FORM-NEW-012 (Save sends no persistence request), THEME-005 (nothing but the theme is stored); SUBMIT-001..006 (candidate-form), share suite | Solved |
| ISS-023 | Task 2 | Frontend / UX | On the Sinhala form at 320 px, section headings looked like one more field label. | Harder to scan the form on a phone. | The heading was barely larger than a label and sat directly on the first label. | Larger section headings with more space under them. | Screenshot check after the change | Solved |
| ISS-024 | Task 2 redesign | Frontend / data | The form must show the verified Passport Number and WhatsApp Number read-only, but the verify response carries only `{ token, expiresAt }`. | Without them the read-only fields would be empty. | Task 1 deliberately returns no candidate data from `verify`. | The in-memory session also keeps the passport (in the server's comparison form: capitals, no spaces or hyphens) and the WhatsApp number the candidate verified with. Nothing extra is requested from the server, and nothing is stored in the browser. These values are display-only and never part of the answers sent. **Residual:** the form shows what the candidate typed (and the server matched), not the stored record's own formatting. Task 3's read can return the server's values. **Task 3:** the identity (passport, NIC, WhatsApp) now comes from the server in the `POST /form` response. The session keeps only the token. | UI-004, UI-005, FORM-NEW-003, FORM-NEW-004; UI-004, PREFILL-002 | Solved |
| ISS-025 | Task 2 redesign | Testing | UI-002 failed on the developer machine: the request went to `http://localhost:3000/...` instead of the same-origin path the test expected. | One failing test locally; no product impact. | A local, git-ignored `candidate-form/.env.local` sets `VITE_API_BASE_URL` for development, and Vite loads it in tests too. | The test compares with `apiUrl("/api/public/candidate-details/verify")`, the configured origin, so it passes with or without a local `.env.local`. | UI-002 | Solved |
| ISS-026 | Task 2 redesign | Accessibility | In the passport step the **Job Category** select and its section were both named "Job Category", so a label lookup found two elements. A screen reader would also announce the same name twice. | Confusing names; failing tests. | A section titled with the same text as a field inside it. | The section is now "Work & Skills" / "රැකියාව සහ කුසලතා". | FORM-NEW-005, FORM-NEW-006 | Solved |
| ISS-027 | Task 2 redesign | Frontend / UX | In Sinhala at 320 px, review section titles broke in the middle of words ("මූලික / තොරතු / රු"). | Hard to read on small phones. | The global `overflow-wrap: anywhere` let the flex header shrink a heading below one word's width to make room for **Edit**. | Headings and labels use `overflow-wrap: break-word` (wrap between words first). Values that can be one long word (emails, addresses) keep `anywhere`. The review header row may wrap. | Screenshot check at 320 px; 160-case width check (ISS-021 method) | Solved |
| ISS-028 | Task 2 redesign | Frontend / i18n | Review dates in Sinhala came out as "1990 වෙසක් 1". | A candidate could misread the month: Vesak is a traditional month name, not the calendar month most people use. | The browser's `si-LK` date format uses traditional month names for some months. | Sinhala shows dates as `1990-05-01`; English keeps "1 May 1990". | Screenshot check | Solved |
| ISS-029 | Task 2 redesign | Frontend / UX | In Sinhala at phone widths, the language and theme switches wrapped onto two lines in the header. | Less of the form visible on small screens. | The Sinhala theme labels are longer than the English ones. | Below 480 px the theme switch shows its icons only; each button keeps its name for screen readers. | Screenshot check at 320, 375 and 390 px | Solved |
| ISS-030 | Task 2 redesign | Requirements | The original 19-field Additional Details UI was no longer the final business requirement: the Candidate Form needs six sections plus a review, with many more fields (identification, contact and location, passport and qualifications, measurements, family, guardian). | The Task 2 UI, its data model and its tests no longer matched what the business needs. | The requirement grew after Task 2 was first built. | The old UI, model and tests were **replaced**, not kept beside the new ones, so there is one candidate form. The language system, field components, validation helpers and size field were reused; Task 1 verification is unchanged. The old 19-field names were not carried over. | `candidate-form` 51 / 51; Task 1 public suite 27 / 27 | Solved (UI). Storage and save: ISS-032, ISS-022 |
| ISS-031 | Task 2 redesign | Data / configuration | Job Category is a typed frontend list (18 values including OTHER) in `src/form/options.ts`. Database-backed category storage does not exist. | Changing the categories needs a frontend release, and a category typed under OTHER goes into no list, so there is no master list to report on. | The list was needed for the UI before the data model was decided. | The step reads the list through `useJobCategories()`, so it can come from an API later without changing the component. "Other Job Category" is a separate free-text answer and is never added to the list. **Task 3:** the server now validates Job Category against its own copy of the same list (`JOB_CATEGORIES` in `candidateFormDataService.js`). Two copies must be kept equal until the list moves to the database. | FORM-NEW-005, FORM-NEW-006; share suite: server validation | Open |
| ISS-032 | Task 2 redesign | Data integrity | The Candidate Form's fields are not mapped to storage. Some match the core candidate record (name, NIC, address, birth date and place, contact numbers, passport dates, job and experience), some match `candidate_additional_details` (sizes, children, marital status), and some have no storage today (for example email, district, DS and GN division, English knowledge, parent and spouse surnames and passport numbers, guardian). Some values also differ: Sex is MALE / FEMALE / OTHER in the form but `M` / `F` / `X` in the candidate record, and Civil Status has four values in the form but five (including SEPARATED) in the additional details. | Saving without a mapping could add duplicate columns, or let a public submission overwrite staff-maintained core data. | The UI was built from the business form before the data model was decided. | Nothing is saved yet (ISS-022). Task 3 must decide field by field where each value lives, reuse existing columns where they exist, add storage only for what has none, and decide how a candidate's answer relates to staff-maintained values (with ISS-002 and ISS-003). **Task 3 decision:** a candidate's answers are stored in a **separate** table, `candidate_form_response` (one nullable typed column per answer), never in the core tables, so a public submission cannot overwrite staff data. The prefill reads the core and additional-details values (mapping in the design document §8, including Sex M/F/X and Civil Status, SEPARATED not prefilled). What the form showed is kept in `candidate_form_prefill_snapshot`. Merging into the core record is a later, staff-side decision. | Task 3 tests still to be written; share suite: prefill mappings, snapshot, submission stored | Solved |
| ISS-033 | Task 2 redesign | Integration | Google Sheet sync for the new Candidate Form fields is not implemented. | Candidate-submitted values would not reach the operational Sheet. | The form does not save yet, so there is nothing in the database for the sync to mirror. | Not started. Rule: a candidate save updates the database first, and the existing one-way Database → Sheet sync (outbox and worker) mirrors it. The browser never writes to a Sheet, and the Sheet never writes back. Which Sheet columns the new fields use is decided with the storage design (ISS-032). | Not applicable yet | Open (Task 3 or 4, per the final plan) |
| ISS-034 | Task 2 redesign | Integration | The Admin Dashboard does not show the Candidate Form's values yet. | Staff could not see what candidates submitted. | The form did not save yet, and the Admin candidate screens work on the existing records. | **Superseded and solved by ISS-047, ISS-048 and ISS-049.** Submitted values are stored (Task 3) and shown to authorised staff only, inline under the matching Admin field, with per-field Confirm and Revoke. Answers that have no Admin field yet (see ISS-047 and ISS-048) are still not displayed; that is a deliberate scope limit, not an open defect. | See ISS-047, ISS-048, ISS-049 | Solved |
| ISS-035 | Task 3 | Testing | After the verification contract changed (link + Passport + NIC instead of Passport + WhatsApp), 15 tests in the Task 1 public suite failed. | The suite no longer described the API. | The tests posted `{ passportNumber, whatsappNumber }`. | The verify, token, timing and rate-limit tests were rewritten for the new contract, keeping every Task 1 property (generic 401, equal work, 400 before any query, rate limits, CORS). New cases: a candidate without a NIC, a NIC in the wrong format, a replaced or revoked link. | test/publicCandidateDetails.test.js 28 / 28 | Solved |
| ISS-036 | Task 3 | Backend | A retried submit after a success (lost response) got 409 instead of the success it should have been. | The candidate would see "already submitted" after their own successful but unconfirmed submission. | The session middleware refused every request for a `SUBMITTED` candidate before the submit handler could recognise the same idempotency key. | `createRequireCandidateFormToken({ allowSubmitted: true })` for `/submit` only; the handler answers 200 for the same key and 409 for any other. `/form` still refuses. | share suite: idempotent retry; SUBMIT-003 | Solved |
| ISS-037 | Task 3 | Data / audit | The candidate's submission cannot be written to `audit_logs`. | No audit row for a submission. | `audit_logs.admin_id` is a required foreign key to a staff user, and a candidate is not one. | Link creation and revocation are audited (`CREATE_FORM_LINK`, `REVOKE_FORM_LINK`, no secret). The submission is recorded on `candidate_form_access` (`submitted_at`, `submitted_via_link_id`) and on the immutable response row. **Residual:** submissions are not in the Audit Logs page. | share suite: link creation audit; after-submit state | Mitigated |
| ISS-038 | Task 3 | Tooling | `npx prisma generate` failed with `EPERM` renaming the query engine DLL on Windows. | The generate step reported an error. | A running Node process (the dev server) held the engine DLL open. | The TypeScript client was generated; the temporary file was removed. Stop the dev server before `prisma generate` on Windows. | `prisma validate`; backend suite | Mitigated |
| ISS-039 | Task 3 | Testing | The admin route inventory test failed: it lists every write route, and two were new. | One failing test. | Intended: the test exists so that a new write route is a deliberate change. | Added `POST /candidates/:passportId/form-share` and `.../form-share/revoke` to the list, with a comment pointing to the share tests. | test/adminReviewActions.test.js | Solved |
| ISS-040 | Task 3 | Testing | The Admin "Copy link" test could not see what was copied. | One failing test. | `userEvent.setup()` installs its own clipboard on `navigator.clipboard`, replacing the test's spy. | The test reads the result with `navigator.clipboard.readText()`. | admin/src/test/shareForm.test.tsx | Solved |
| ISS-041 | Task 3 | Testing | Ten Admin tests timed out (5 s) when the Admin suite ran at the same time as the backend suite. | False failures. | CPU contention on the developer machine. | Run the suites one after another: Admin 453 / 453 alone. | Admin `npm test` | Mitigated |
| ISS-042 | Task 3 | Frontend | The first Share Form dialog loaded the link state during render. | A request per render, and React warnings. | Data loading placed in the render path. | Moved to `useEffect` with an `AbortController`. | admin/src/test/shareForm.test.tsx | Solved |
| ISS-043 | Job group | Frontend | The Share Form's job-group section fetched the group status for every role, before checking the role. | An Analyst or Registration Desk user triggered a request that the API answers with 403. | The permission check came after the `useEffect` that loads the data. | The effect now runs only for roles that manage jobs; the section renders nothing otherwise. Test: "only ADMIN and MANAGER see the group action" asserts no `/jobs/` request is made. | admin/src/components/candidate/ShareFormButton.tsx, admin/src/test/jobGroupShareForm.test.tsx | Solved |
| ISS-044 | Job group | Validation | The first Company Job ID normaliser collapsed all whitespace, so `AB<newline>CD` was accepted as `AB CD`. | A control character slipped through as a space. | Whitespace collapsing ran before the control-character check. | Control characters (including tabs and line breaks) are refused before any normalisation; only repeated spaces are collapsed. A database CHECK repeats the allow-list. | src/services/jobService.js, test/jobGroupShare.test.js | Solved |
| ISS-045 | Job group | Design | A personal-link limit of 10 wrong attempts per link would let a few typos lock a shared group link for everyone. | A whole job locked out for an hour. | Per-link counters assume one person per link. | Group links lock after 100 failures; the per-IP and per-passport limits (unchanged) remain the brute-force control. Documented as a residual risk. | src/services/candidateFormJobGroupService.js | Mitigated |
| ISS-049 | Admin workflow | Design / Admin | Confirm was the only decision available on a candidate-submitted value, so a proposal Admin did not accept stayed pending forever (the hint never went away) or had to be ignored. | Admin screens kept showing "Candidate submitted" for values staff had already decided against; no record of that decision. | The first workflow modelled only "apply this value". | **Final review workflow:** the candidate submits proposed values -> Admin sees the inline hint -> Admin chooses **Confirm** or **Revoke** -> Confirm updates the canonical record, Revoke keeps the canonical record unchanged -> the candidate's submission stays immutable in `candidate_form_response` -> the decision is stored separately. One review model for both: table `candidate_form_field_review` (migration `20261018140000_candidate_form_field_review`), one row per candidate and field with status `CONFIRMED` or `REJECTED`; **PENDING is the absence of a row**. The primary key makes "both confirmed and rejected" impossible and a trigger makes a decision final (no undo). Revoke is **not** an undo of a Confirm; it rejects a pending proposal before it is applied. Endpoint `POST /api/admin/candidates/:passportId/form-submission/reject-field` (same body, allowlist, roles and stale checks as confirm-field): the server re-reads the submitted value, checks it is still pending, and records REJECTED without touching the record; `409 FORM_FIELD_REVIEW_STALE` when someone already decided the field, `409 FORM_FIELD_STALE` when the record changed since the screen loaded. Audit `CANDIDATE_FORM_FIELD_REJECTED` (actor, candidate, field, current value, rejected submitted value). UI: `Candidate submitted: VALUE [Confirm] [Revoke]`; after Revoke the buttons give way to a small read-only note "Candidate change rejected". ADMIN and MANAGER only; Analysts and the Registration Desk see the hint without buttons. No bulk action. A decided field never returns to pending, even if the record is edited again. | `test/candidateFormFieldReject.test.js` (8), `admin/src/test/rejectCandidateChange.test.tsx` (7); all Confirm tests unchanged and passing. Backend 1690 passed; Admin 514 / 514. Note: the existing guard "no REJECTED status in the implementation" (`adminReports.test.js`) protects the document review-queue vocabulary and now excludes only the field-review service. | Solved |
| ISS-048 | Admin workflow | Design / Admin | After a Candidate Form submission, Admin could see what the candidate sent but had no safe way to apply an accepted correction to the candidate's record, short of retyping it. | Accepted corrections (for example a corrected birth date) had to be re-entered by hand; there was no audit link between the submission and the change. | The submission is intentionally stored apart from the record (`candidate_form_response`) and never merged, and no per-field apply path existed. | Per-field Confirm. Workflow: the candidate submits proposed values -> Admin sees "Candidate submitted: <value> [Confirm]" directly under that field (only where the value differs) -> Admin or Manager confirms ONE field after a confirmation step -> only that canonical column is updated -> the original submission stays unchanged and the change is audited (`CANDIDATE_FORM_FIELD_CONFIRMED`, old and new value). The server owns a strict allowlist (`candidateFormFieldConfirmService.js`): the browser sends only a stable field key plus the values it saw, never a table, column or new value; the new value is read from `candidate_form_response` and validated again. A stale screen (the record changed since it was loaded) gets 409 and nothing is overwritten; the row is locked for the check and the update. There is no bulk confirmation. **The hint is the only place a submitted value appears** (never also in a separate panel). After a Confirm the forms are not rebuilt: refreshed data is merged field by field, the confirmed field takes its new value and anything else the Admin is typing is kept (regression-tested for Candidate details and Additional details). **Confirmable (16):** surname, other names, sex, date and place of birth, address, alternative contact, passport issue and expiry dates, job experience (core record); full name (name according to passport), shirt, waist and shoe size, father's and mother's birthday (additional details). **Not confirmable, shown read only:** email, city, district, DS and GN division, job category and other category, English knowledge, other skills, civil status, spouse and children (they depend on each other's rules), parents' names and passport numbers (the form splits name and surname, the record keeps one full name), and every Guardian field (no Guardian storage exists). Roles: ADMIN and MANAGER confirm; Analysts and the Registration Desk see the submitted change without a button. | `test/candidateFormFieldConfirm.test.js` (13) and `admin/src/test/confirmCandidateChange.test.tsx` (15, incl. unsaved-edit preservation). Backend and Admin suites pass. | Solved |
| ISS-047 | Admin display | Admin / Frontend | Everything the candidate submitted through the Candidate Form, including all six Guardian fields, was stored correctly in `candidate_form_response` but was not visible anywhere in Admin. | Admin could not see any submitted answer (the 46 form answers plus the verified NIC); Guardian Details looked like they had not been collected. | The Admin Additional Details panel still reflected the older `candidate_additional_details` field set, and no Admin API returned `candidate_form_response` or `candidate_form_prefill_snapshot` at all. | New read-only Admin endpoint `GET /api/admin/candidates/:passportId/form-submission` (same roles and Analyst scope as the other candidate routes; nothing added to the public API) returns the form status, submitted time, the submitted values keyed by the form's own paths, the original prefill and the list of changed answers. **Final UI decision:** the first version rendered a full read-only "Candidate Form submission" panel (one card per form section). That was removed as repetitive and busy: the existing Admin fields stay the primary UI, and only a value the candidate changed appears, as a small inline hint under that field (see ISS-048). Fields with no existing Admin field are deliberately not displayed for now (they can get proper Admin fields later). The endpoint and the stored `candidate_form_response` / prefill snapshot are unchanged; a single small line "Candidate Form submitted: <date/time>" shows on the Additional details tab. | `test/candidateFormSubmissionView.test.js` (7: all 46 answers + NIC returned, Guardian values, null handling, changed list, candidate row untouched, roles and scope, public API unchanged) and the full-panel tests were replaced by `admin/src/test/confirmCandidateChange.test.tsx` (CLEAN-001 to 012: no panel, no section cards, no duplicated values, inline hints only). Backend 1669 passed; Admin 507 / 507. | Solved |
| ISS-046 | Job group | Deployment | The candidate session token gained the link kind and job id, so token version 2 sessions are no longer valid. | Candidates mid-form at deploy time (at most 60 minutes) must verify again. | Token payload changed from version 2 to 3. | Accepted: tokens are short-lived and nothing is lost (answers are only saved on submit). Deploy outside busy hours if possible. | src/services/candidateFormTokenService.js | Accepted Risk |
| ISS-050 | Date picker | Frontend / UX | Date fields used the browser's native date input, which looks and behaves differently in every browser, has no month or year lists (a birth date takes many clicks), ignores the Light / Dark theme and the form's language, and accepts typed values in a browser-specific format. 7 Candidate Form date fields and 14 Admin date inputs were affected. During testing a second defect appeared: **Today** was missing on fields capped at today. | Inconsistent look, slow entry of old dates, risk of a locale-shaped or shifted date. | No shared date component; the native control was used directly. | One calendar component per app (`DatePicker.tsx`, built on `react-day-picker` 10.0.2), used by every date field. The stored value is unchanged: a date-only `YYYY-MM-DD` string (or empty), built from local calendar days so no timezone shift is possible. Text input accepts `YYYY-MM-DD` only; a calendar with separate month and year dropdowns, Today / Clear / Close, and minimum / maximum days disabled. Light / Dark through the existing colour variables; English and Sinhala labels (Sinhala months shown as numbers, ISS-028); keyboard and screen-reader support (Alt+Down opens, Escape closes only the calendar and returns focus, labelled dialog); on phones (up to 520 px) the calendar is a bottom sheet, otherwise a popover rendered in the page body so no card clips it. **Bug found by the tests and fixed:** with a maximum of today, Today was hidden because the code compared a time with midnight; it now compares calendar days. Four existing Admin tests that asserted the native `type="date"` and `max` were rewritten for the calendar. | `candidate-form/src/test/datePicker.test.tsx`, `admin/src/test/datePicker.test.tsx` (DATE-001 to DATE-018), updated Admin candidate, daily report, phase 10 and police tests; responsive harness checks at phone widths. Candidate Form 84, Admin 526, backend 1690 passed (22 skipped). | Solved |
| ISS-051 | Assign to Job | Admin / Frontend | The backend could assign a candidate to a job, but Candidate Details had no way to do it. | Staff could not link a candidate to a job from the screen. | The job assignment endpoint was built before its UI. | An **Assign to Job** panel on Candidate Details (`JobAssignmentPanel.tsx`) reuses the existing assignment endpoint; no new endpoint and no new rule. It shows the current job and offers only valid choices. The one-PROCESSING-job rule stays enforced by the server (partial unique index and triggers). | `admin/src/test/assignToJob.test.tsx` (ASSIGN-UI-001 to 011); existing job assignment backend tests unchanged. | Solved |
| ISS-052 | Job group | Feature | Candidates of one job could only be sent personal links one by one. | Slow for a batch; no link tied to a job. | Share links were bound to a single candidate. | A `JOB_GROUP` link bound to the job's immutable `job.id` (UUID), not to the display code. It works only while the job is PROCESSING; membership is the live `job_candidate` list, so a candidate added later can use the link and a removed one cannot. Locks, access state and single submission stay per candidate; the candidate still proves Passport and NIC. Revoke and regenerate are supported. Related fixes: ISS-043, ISS-044, ISS-045, ISS-046. | `test/jobGroupShare.test.js` (GROUP-001 to 023, JOB-ID-001 to 007), `admin/src/test/jobGroupShareForm.test.tsx` | Solved |
| ISS-053 | Job identity | Audit | Question: does the Job ID already use a GUID / UUID? | None found. | Not applicable. | **Verified, no change required.** `job.id` is `UUID` with `gen_random_uuid()` (migration `20261018120000_job_management`), is the primary key and the only value used by relations, links and assignments. `job_code` (JOB-YYYY-NNNNNN) is a display value and `company_job_id` an editable label. The legacy `candidate_stages.job_id` text ("Job12") is separate, kept read-only. | Read-only audit of the migration, Prisma schema and services; JOB-ID tests (ISS-052). | Verified |
| ISS-054 | Admin review workflow | Environment | The Admin form-submission endpoint answered with a Prisma `P2021` (table does not exist). | Admin could not load submitted values locally. | The migration `20261018140000_candidate_form_field_review` (ISS-049) had not been applied to the local database, so the code expected a table that was missing. **Not** a frontend Sync defect. | Applying the pending migration fixed it. Migrations were always run in order with `migrate deploy` (never `migrate dev`). The shared Supabase database is not touched by this work, so every `20261018*` migration (and `20261017120000`) must be applied there before release. | The endpoint works after the migration; `test/candidateFormFieldReject.test.js` and `test/candidateFormSubmissionView.test.js` (the test database replays every migration). | Solved |
| ISS-055 | Candidate Form | Frontend / UX | The Candidate Form had seven steps, which felt long on a phone. | More taps and more chances to abandon the form. | One section per step. | Reduced to four steps: **Verify**, **Personal Details**, **Work & Family Details**, **Review & Submit**. No field, validation, language text, storage or rule was removed. Each step is validated before Next, and Review & Submit keeps Edit for every part. | `candidate-form/src/test/form.test.tsx` (STEP-001 to 013); suite 84 passed. | Solved |

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
| ISS-002 | Existing services over-fetch candidate data | Solved (Task 3 DTO) |
| ISS-003 | Additional Details save is a full replacement | Solved (not used by the public path) |
| ISS-031 | Job Category is a code list (form and server), not database-backed | Open |
| ISS-032 | Storage of the Candidate Form's answers | Solved (separate response table) |
| ISS-037 | Submissions cannot be in `audit_logs` (no staff actor) | Mitigated |
| ISS-033 | Google Sheet sync for the new fields is not implemented | Open (Task 3 or 4) |
| ISS-034 | The Admin Dashboard does not show the new fields yet | Solved (ISS-047 to 049) |

**Task 3:** the public read uses its own DTO (ISS-002) and the public save writes only the new response table, once (ISS-003, ISS-032). Before Task 3 neither affected the code, because nothing was read or saved (ISS-022). ISS-002 and ISS-003 are **entry conditions for Task 3**. ISS-031 to ISS-034 are Task 3 (and later) **implementation work, not security findings**: the form never claims to have saved anything. The public read and save must use a dedicated DTO and service. The save must use `expectedUpdatedDate` (optimistic concurrency) and reject invalid payloads.

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

| ID | Summary | Status |
|---|---|---|
| ISS-022 | The form loads its prefill and submits once (Task 3) | Solved |
| ISS-023 | Section headings looked like labels on the Sinhala form at 320 px | Solved |
| ISS-024 | The verified identity now comes from the server | Solved |
| ISS-042 | Share Form dialog loaded data during render | Solved |
| ISS-043 | Job-group status fetched before the role check | Solved |
| ISS-044 | Company Job ID normaliser turned a line break into a space | Solved |
| ISS-045 | Per-link lock too tight for a shared group link | Mitigated |
| ISS-046 | Token version change ends sessions at deploy | Accepted Risk |
| ISS-047 | Submitted Candidate Form answers (Guardian included) not visible in Admin | Solved |
| ISS-048 | No safe per-field way to apply a candidate-submitted correction | Solved |
| ISS-049 | No way to reject a pending candidate-submitted change | Solved |
| ISS-050 | Native date inputs replaced by one modern date picker (7 form fields, 14 Admin inputs) | Solved |
| ISS-051 | No Assign to Job action on Candidate Details | Solved |
| ISS-052 | Job-group share links | Solved |
| ISS-053 | Job ID is already a UUID | Verified |
| ISS-054 | Missing `candidate_form_field_review` table (Prisma P2021) | Solved |
| ISS-055 | Seven-step form reduced to four steps | Solved |
| ISS-030 | The 19-field form replaced by the guided Candidate Form (old UI, model and tests removed) | Solved (UI) |
| ISS-026 | A section and its field shared the name "Job Category" | Solved |
| ISS-027 | Review titles broke mid-word in Sinhala at 320 px | Solved |
| ISS-028 | Sinhala review dates used a traditional month name | Solved |
| ISS-029 | Header switches wrapped onto two lines in Sinhala on phones | Solved |

**The Task 2 UI as it stands (final state before Task 3).**

| Area | State |
|---|---|
| Flow | Verify, then a guided Candidate Form: **Basic & Identification**, **Contact & Location**, **Passport & Qualifications** (with the Work & Skills group), **Physical Measurements**, **Family Background**, **Guardian Details**, then **Review**. Next / Previous, a progress bar and a section list; each section is checked before Next. |
| Languages | English and Sinhala for every text, including validation and the review. Switching keeps every answer, the validation state and the session. |
| Theme | Light and Dark. Only the theme preference is stored in the browser. |
| Uppercase | Eligible English free text is capitalised in the value itself as it is typed; Sinhala, email, phone numbers, dates and choices are not changed. |
| Identity | The verified Passport Number and WhatsApp Number are shown read-only (ISS-024). There is **no Register Number** field (staff-only). |
| Family | Spouse fields only when Civil Status is Married; hidden entries are kept in the form but not sent. Child 1-3 are optional. |
| Work | Job Category from the frontend list, with **OTHER** opening a required free-text category (ISS-031). English Knowledge is one of six choices, stored as an English code. |
| Review | The candidate's answers by section, with Edit for each, and **Save Details**. |
| Save | **No persistence request is sent** (ISS-022). The form says so. |
| Not yet | Read and save, field storage (ISS-032), Sheet sync (ISS-033), Admin display (ISS-034). |

**Since Task 3** the table above is history for Identity, Review and Save: the form opens only from a share link, verifies with Passport + NIC, shows the identity from the server (passport, NIC, WhatsApp), prefills known answers (marked *From your record*), and **Submit** sends the answers once after a confirmation. Sheet sync (ISS-033) and Admin display (ISS-034) are still not done.

Frontend-relevant behaviour recorded elsewhere in this log:
- An unconfigured build shows "Not available" (ISS-016).
- Every verification failure shows one generic message (ISS-005).
- A candidate whose passport is locked out sees the rate-limit message for up to an hour (ISS-015).

---

## 7. Testing / QA Issues

| ID | Summary | Status |
|---|---|---|
| ISS-018 | CSP-003 compared HTML-escaped meta content | Solved |
| ISS-019 | SECRET-001 failed on CRLF line endings in `.env.example` | Solved |
| ISS-020 | Vitest `css: false` blanked the stylesheet the layout test reads | Solved |
| ISS-021 | Phone widths could not be checked by resizing headless Edge | Mitigated |
| ISS-025 | UI-002 assumed the same-origin API while a local `.env.local` set one | Solved |
| ISS-035 | Task 1 public suite rewritten for the link + Passport + NIC contract | Solved |
| ISS-038 | `prisma generate` EPERM on Windows | Mitigated |
| ISS-039 | Route inventory test listed the new write routes | Solved |
| ISS-040 | Clipboard spy replaced by user-event | Solved |
| ISS-041 | Admin tests timed out while the backend suite ran | Mitigated |
| ISS-050 | Today hidden on date fields capped at today (found by tests, fixed) | Solved |

Test results after the Task 1 cleanup (2026-10-15):

| Suite | Result |
|---|---|
| `test/publicCandidateDetails.test.js` | 27 / 27 pass |
| Backend `npm test` | 1601 tests: 1579 pass, 0 fail, 22 skipped |
| Admin `npm test` | 448 / 448 pass |
| `candidate-form` typecheck and build | Pass; no `.map` files in `dist/` |

Test results after Task 2 (2026-10-16):

| Suite | Result |
|---|---|
| `test/publicCandidateDetails.test.js` | 27 / 27 pass |
| Backend `npm test` | 1601 tests: 1579 pass, 0 fail, 22 skipped |
| `candidate-form` `npm test` (new) | 31 / 31 pass |
| `candidate-form` typecheck and build | Pass |

Test results after the Task 2 redesign (2026-10-16):

| Suite | Result |
|---|---|
| `test/publicCandidateDetails.test.js` | 27 / 27 pass |
| `candidate-form` `npm test` | 51 / 51 pass |
| `candidate-form` typecheck and build | Pass |
| Width check (temporary harness, ISS-021 method) | 160 cases: 8 views x 320 / 375 / 390 / 768 / 1280 px x English / Sinhala x Light / Dark, no horizontal scroll |
| Manual UI verification (developer) | Completed; no blocking UI issue found (below) |
| Backend full suite, Admin suite | Not rerun for the redesign: no backend or shared Admin code changed |

**Manual UI verification (after the redesign, before Task 3).** The developer checked the redesigned form by hand and confirmed:
- the verification screen works: the correct Passport Number and WhatsApp Number open the form, and incorrect details are rejected;
- moving between the sections works;
- switching language works;
- switching between Light and Dark works;
- the form stays readable, and the mobile layout was reviewed.

No blocking UI issue was found, so Task 3 can start. This is a manual check of the UI against the development setup: it does not cover the deployed site (HDR-001, ISS-007) or the secure read and save, which do not exist yet. The automated responsive check (160 combinations of screen width, language and theme, all without horizontal scrolling) stays green.

Test results after Task 3 (2026-10-16):

| Suite | Result |
|---|---|
| `test/publicCandidateDetails.test.js` | 28 / 28 pass |
| `test/candidateFormShare.test.js` (new) | 19 / 19 pass |
| Backend `npm test` | 1621 tests: 1599 pass, 0 fail, 22 skipped |
| Admin `npm test` | 453 / 453 pass (run alone, ISS-041); typecheck and build pass |
| `candidate-form` `npm test` | 62 / 62 pass; typecheck and build pass |

Test results after the date picker and the Admin review workflow (2026-10-17):

| Suite | Result |
|---|---|
| Backend `npm test` | 1712 tests: 1690 pass, 0 fail, 22 skipped |
| Admin `npm test` | 526 / 526 pass; typecheck and build pass |
| `candidate-form` `npm test` | 84 / 84 pass; typecheck and build pass |
| New in this period | Confirm 13 + 15, Revoke 8 + 7, submission view 7, inline hints (CLEAN) 12, Assign to Job 11, job group (GROUP, JOB-ID), four steps (STEP) 13, date picker (DATE) 18 |
| Responsive check | Date picker rendered in width harnesses at phone widths, English / Sinhala, Light / Dark; not every real page was re-checked |

Coverage gaps:
- No browser end-to-end test of the whole flow (Admin link → form → submit) against a real server; each side is tested against the other's contract.
- Submitted answers without an Admin field are not displayed (ISS-047); the rest is shown inline (ISS-034 solved).
- No automated real-browser width test (ISS-021).
- ISS-007, ISS-012 and ISS-013 cannot be verified from the repository.
- ISS-014 needs the Task 4 load test.
- The deployed response headers (HDR-001) are untested.

---

## 8. Open / Deferred Items

| ID | Item | Owner phase | Status |
|---|---|---|---|
| ISS-012 | `candidate_allocation` live privileges; RLS and revokes if needed | Before release | Release Blocker |
| ISS-013 | Live Supabase table privileges, RLS and Storage policies | Before release | Release Blocker |
| ISS-014 | Load test of public verification against Admin traffic | Task 4 | Deferred |
| ISS-031 | Job categories from the database instead of two code lists (form and server) | Later | Open |
| ISS-013 (Task 3) | After applying migration `20261017120000_candidate_form_share_and_response`, check live RLS and privileges of the four new tables | Before release | Release Blocker (part of ISS-013) |
| ISS-033 | Google Sheet sync for the new fields (database first, then the existing one-way sync) | Task 3 or 4 | Open |
| ISS-015 | Review the per-passport lockout window and policy | Task 4 | Accepted Risk |
| ISS-046 | Candidate sessions end at the token version 3 deploy | At deploy | Accepted Risk |
| ISS-054 (follow-up) | Apply the pending `20261017120000` and `20261018*` migrations to every shared database (not done by this work) | Before release | Open check (the issue itself is Solved) |
| ISS-047 / ISS-048 (follow-up) | Answers with no Admin field or canonical column (Guardian, email, city, district, DS / GN, English knowledge, other skills, civil status, spouse, children, parents' names and passports, job category) | Later | Open (scope limit) |
| Note | `candidate_stages.job_id` (legacy text, read-only) and the `candidate_form_access` DELETE not blocked by a trigger (accepted) | Later | Accepted |
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

ISS-002 and ISS-003 blocked the Task 3 release; both are solved in Task 3. ISS-013 now also covers the four new form tables (live privileges after the migration is applied).

ISS-031 and ISS-033 are unfinished **implementation work** (ISS-034 is solved). They are not release blockers of their own: no data is exposed by their absence.

Before the first production deployment, also complete the follow-up checks in section 8: deployed headers (HDR-001) and the Project B Root Directory.

---

## Summary counts

| Status | Count | IDs |
|---|---|---|
| Solved | 39 | ISS-055, ISS-054, ISS-052, ISS-051, ISS-050, ISS-049, ISS-048, ISS-047, ISS-034, ISS-001, 002, 003, 004, 006, 008, 009, 011, 016, 017, 018, 019, 020, 022, 023, 024, 025, 026, 027, 028, 029, 030, 032, 035, 036, 039, 040, 042, 043, 044 |
| Mitigated | 8 | ISS-005, 007, 010, 021, 037, 038, 041, 045 |
| Open | 2 | ISS-031, 033 |
| Deferred | 1 | ISS-014 |
| Release Blocker | 2 | ISS-012, 013 |
| Accepted Risk | 2 | ISS-015, 046 |
| Verified (no change) | 1 | ISS-053 |
| **Total** | **55** | |
