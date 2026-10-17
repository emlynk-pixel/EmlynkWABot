# Candidate Form — Share Links, Verification, Single Submission

Branch: `version/candidate-extra-details-form`
Date: 2026-10-16 (Task 3)
Status: implemented on the branch, not committed. Migration `20261017120000_candidate_form_share_and_response` is not applied to any shared database yet.

Related documents:
- [CANDIDATE_EXTRA_DETAILS_FORM_SECURITY_RISKS.md](CANDIDATE_EXTRA_DETAILS_FORM_SECURITY_RISKS.md), section 29 (new risks R-085 to R-094)
- [CANDIDATE_EXTRA_DETAILS_FORM_ISSUES_AND_SOLUTIONS.md](CANDIDATE_EXTRA_DETAILS_FORM_ISSUES_AND_SOLUTIONS.md) (ISS-035 onwards)
- [candidate-form/README.md](../candidate-form/README.md), [20-candidate-management.md](20-candidate-management.md) §4.6, [09a-admin-dashboard-api.md](09a-admin-dashboard-api.md) §4q, [DATABASE_IMPLEMENTATION.md](DATABASE_IMPLEMENTATION.md) §2.13–2.16

---

## 1. What this adds

1. Staff open a candidate in Admin and press **Share Form**. That creates a personal link for that one candidate, valid for **3 days**. The link is shown once, to copy or send by WhatsApp.
2. The candidate opens the link and enters their **Passport Number and NIC Number**. The link and both numbers must belong to the same candidate.
3. The form opens with what is already known about the candidate filled in and marked *From your record*.
4. The candidate submits **once**. After that the form is closed for good. Opening the link again with the right details shows a neutral "already submitted" screen.
5. The answers are stored in a **separate table** (`candidate_form_response`) with one nullable column per answer. The main candidate tables are **never** changed by a public submission.

Not built, on purpose:
- job-group links (one link for many candidates); the schema leaves room (`kind`)
- Google Sheet sync
- an Admin approve/merge workflow, and a diff screen
- server-side drafts

## 2. Decisions (with the product owner, 2026-10-16)

| Question | Decision |
|---|---|
| Second factor at verification | **NIC replaces WhatsApp.** Passport + NIC. |
| Who can create or revoke a link | ADMIN, MANAGER and REGISTRATION_DESK for any candidate; ANALYST only for candidates allocated to them (the existing `candidateAccess` scope). VIEWER: no. |
| Link lifetime | 3 days. |
| After submission | Correct Passport + NIC: neutral "already submitted" screen. Wrong details: the same generic failure as always. |
| Drafts | None on the server. Answers stay in the page's memory until submitted. |
| Job-group links, new-link UX beyond one button | Not now. Only single-candidate links, done correctly. |

## 3. Audit findings that shaped the design

| Finding | Consequence |
|---|---|
| Task 1 verification was knowledge-only (Passport + WhatsApp). Both are widely known (R-028). | Add something only the intended recipient has: a random link secret. |
| `audit_logs.admin_id` is a required foreign key to a staff user. | Link creation and revocation are audited (staff actor). The candidate's submission has no staff actor, so it is recorded on the access row (`submitted_at`, `submitted_via_link_id`) and the response row, not in `audit_logs`. |
| Core naming trap: `candidate.other_name` is the **surname** and `first_name` holds the **other names**. | Prefill maps them explicitly (§8); a test checks it. |
| Sex codes differ: core `M`/`F`/`X`, form `MALE`/`FEMALE`/`OTHER`. Civil status: additional details have 5 values (incl. `SEPARATED`), the form 4. | Mapped on prefill; `SEPARATED` is not prefilled (the candidate chooses). |
| The staff Additional Details save is a full replacement (ISS-003). | Not used. Public answers go only to the new response table. |
| Existing services over-fetch (ISS-002). | A dedicated whitelist DTO (`loadCandidateForm`). |
| Task 1's single-query, equal-work verification (ISS-005). | Kept: one lookup by link hash, always two constant-time comparisons. |

## 4. Research and mechanisms

Sources consulted (2026-10-16):
- OWASP Forgot Password Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html (URL tokens: CSPRNG, long enough, stored securely, single use and expiring, `Referrer-Policy: no-referrer`, rate limiting, build the URL from a trusted origin and not the `Host` header, uniform responses and timing).
- NIST SP 800-63B rev. 4 — https://pages.nist.gov/800-63-4/sp800-63b.html (look-up secrets: at least 64 bits of entropy from an approved RBG, stored hashed, used once; limit consecutive failed attempts (no more than 100); a new secret must not reset the failure count).
- RFC 3986 §3.5 — the fragment is not sent to the server, so it does not reach server logs, proxies or `Referer`.

| Mechanism | How |
|---|---|
| Link secret | 32 bytes from `crypto.randomBytes` (256 bits), base64url, 43 characters. |
| Where the secret travels | URL **fragment**: `<CANDIDATE_FORM_ORIGIN>/#k=<secret>`. The origin comes from configuration, never from the request. The form reads it once, keeps it in memory and removes it from the address bar (`history.replaceState`). It is sent only in the `POST /verify` body. |
| Storage | Only `SHA-256(secret)` (`token_hash`, unique). The secret is returned once in the create response and is never stored, logged or audited. A 256-bit random secret needs no slow hash or salt. |
| One active link | Creating a link revokes the previous one in the same transaction. Revoke stops it at once. |
| Second factor | Passport + NIC must both match the candidate the link belongs to. |
| Failure cap | Each failed verify on a usable link counts on the link; at 10 the link is locked for 1 hour (`locked_until`). A new link is a new row with its own count, but only staff can create one (audited), and the Task 1 per-passport (5 per hour) and per-IP (10 per 15 minutes) limits are not reset by a new link, so the overall failure budget is not reset either. |
| Equal work | One `findUnique` by `token_hash` on every path. Passport and NIC are always compared with `safeEqual`, against placeholders when the link is unknown. Every failure is the same 401 and message. |
| Session | The Task 1 token (AES-256-GCM, `cf1~iv~ct`, not JWT-shaped), now v2: `{ sub: passportId, lnk: linkId, ver: accessVersion }`, 60-minute TTL (was 15; a long form). Every request re-checks that the link is still active and the access version unchanged, so revoke or a new link ends existing sessions. |

Alternatives considered and not used:
- **Secret in the path or query** (`/f/<secret>`): reaches server and CDN logs and `Referer`. Rejected.
- **Signed self-contained link (no table)**: cannot be revoked one by one or replaced. Rejected.
- **OTP to WhatsApp**: stronger, but needs the WhatsApp send path for public use and template approval. Possible later.
- **Store the secret encrypted to show it again**: "shown once" is simpler and safer; staff create a new link if they lose it.

## 5. Data model

Migration: `prisma/migrations/20261017120000_candidate_form_share_and_response/migration.sql`. Additive only. Every new table has RLS enabled and all privileges revoked from `anon` and `authenticated`.

| Table | Purpose | Key points |
|---|---|---|
| `candidate_form_link` | One row per link ever created | `link_id` UUID; `kind` (`SINGLE` only, by CHECK); `passport_id` (required for SINGLE); `token_hash` CHAR(64), unique, hex; `created_by`, `expires_at`; `revoked_at` / `revoked_by` (both or neither); `failed_attempts`, `locked_until`, `last_verified_at` |
| `candidate_form_access` | The lock, one row per candidate | `status` `LOCKED` / `UNLOCKED` / `SUBMITTED`; `version` (bumped by every link change); `unlocked_at/by/via_link_id`; `submitted_at`, `submitted_via_link_id`, `submit_key`. CHECK: `SUBMITTED` exactly when `submitted_at` is set. Trigger: `SUBMITTED` is final. |
| `candidate_form_prefill_snapshot` | What the form showed as prefill, captured once on the first load | Same answer columns as the response, plus `nic`; `captured_at`, `captured_via_link_id`. Values immutable by trigger. |
| `candidate_form_response` | The submitted answers | One row per candidate; 47 nullable typed columns (TEXT, DATE); `submitted_at`, `submitted_via_link_id`. CHECKs on the code columns (sex, civil status, English knowledge, shirt size). Values immutable by trigger. |

Foreign keys: to `candidate` `ON DELETE CASCADE ON UPDATE CASCADE` (a passport correction follows); to `"user"` `RESTRICT`; to `candidate_form_link` `SET NULL`. The immutability triggers ignore `passport_id` and the link IDs, so those cascades still work.

### Lock state machine

```
            create link                submit (once)
 LOCKED ───────────────► UNLOCKED ─────────────────► SUBMITTED (final)
    ▲                       │
    └──── revoke ───────────┘   (expiry: the link stops working; the row stays UNLOCKED but no session can be opened)
```

- Creating a link on a `SUBMITTED` candidate: 409 `FORM_SUBMITTED`.
- Submit is a compare-and-set: `UPDATE ... WHERE status = 'UNLOCKED' AND version = <session version>`. Only one request can win. The response row is written in the same transaction.
- Idempotency: the form sends a random `idempotencyKey`. A retry with the same key after a success is answered 200 with the stored time; any other request gets 409 `ALREADY_SUBMITTED`.

## 6. Link and verification flow

1. Staff: `POST /api/admin/candidates/:passportId/form-share` → `201 { url, linkId, expiresAt, status }`. Audit `CREATE_FORM_LINK` (link ID and expiry only).
2. Candidate opens `https://<form>/#k=<secret>`. The form keeps the secret in memory, clears the fragment. No secret → "Open your link" screen, no verification offered.
3. `POST /api/public/candidate-details/verify { linkSecret, passportNumber, nic }`:
   - 400 for malformed input, before any database access;
   - 401 generic for every mismatch (unknown, expired, revoked or locked link, wrong passport, wrong NIC, link of another candidate);
   - 409 `ALREADY_SUBMITTED` only when the link, passport and NIC all match and the form is submitted;
   - 200 `{ token, expiresAt }` otherwise.
4. `POST /form` (Bearer token) → `{ identity: { passportNumber, nic, whatsappNumber }, answers, prefilled, expiresAt }`.
5. `POST /submit { answers, idempotencyKey }` → 200 `{ submittedAt }`, 400 `{ message, errors: [{ field, code }] }`, 401, 409.

All three public routes are POST only, behind the Task 1 CORS allow-list, rate limits and fail-closed configuration.

## 7. Server validation

`parseSubmission` (`src/services/candidateFormDataService.js`):
- only `answers` and `idempotencyKey`; unknown keys at any level are refused;
- every field by type: text (trimmed, English letters uppercased, length limits), code (exact list), date (real, from 1900; birth and issue dates not in the future; expiry after issue), phone, email, NIC (guardian), sizes;
- required fields as in the form; `jobCategoryOther` required with `OTHER` and dropped otherwise; spouse dropped unless `MARRIED`;
- the candidate's NIC is **not** an answer: it is the verified identity and is copied from the record;
- body limit 64 KB on `/submit` (16 KB on the others).

## 8. Field mapping (prefill)

| Form field | Source | Notes |
|---|---|---|
| Full Name | `candidate_additional_details.name_as_in_passport` | |
| Surname | `candidate.other_name` | core naming: other_name is the surname |
| Other Names | `candidate.first_name` | |
| NIC (identity, read-only) | `candidate.nic` | |
| Sex | `candidate.sex` | M→MALE, F→FEMALE, X→OTHER |
| Civil Status | `candidate_additional_details.marital_status` | SEPARATED is not prefilled |
| Birth Date | `additional_details.birthday`, else `candidate.date_of_birth` | |
| Birth Place | `candidate.place_of_birth` | |
| Address | `additional_details.permanent_address`, else `candidate.address` | |
| Alternative Phone | `candidate.contact_number` | |
| Passport Issue / Expiry | `candidate.passport_issue_date` / `passport_expiry_date` | |
| Job Category | `candidate.job` | only an exact match in the list |
| Experience | `candidate.job_experience` | |
| Other Skills 1 | `additional_details.other_job_skills` | only when it fits (≤ 150) |
| Shirt / Waist / Shoe size | `tshirt_size` / `pant_size` / `shoe_size` | |
| Father / Mother name, birth date | `father_full_name` / `father_birthday`, `mother_…` | |
| Spouse name, birth date | `wife_full_name` / `wife_birthday` | |
| Child 1–3 | `child_1_name` … `child_3_name` | |
| City, District, DS/GN Division, Email, English Knowledge, Other Skills 2, parents' and spouse's surnames and passport numbers, Guardian | none | empty, for the candidate |

The first load stores this prefill in `candidate_form_prefill_snapshot`; later loads return the snapshot, so the form shows the same prefill even if staff change the record in between, and staff can later compare what was shown with what was submitted.

## 9. Admin Share Form

On the candidate page, Additional Details panel, for staff who can edit: **Share Form** opens a dialog with the state (*No active link*, *Link active until …*, *Link locked after failed attempts*, *Submitted on …*), and:
- **Create share link** (or *Create a new link (replaces the current one)*): shows the URL once, read-only, with **Copy link** and **Share on WhatsApp** (`wa.me`, `noopener noreferrer`);
- **Revoke link**, with a confirmation;
- no actions once submitted.

## 10. Security checklist

| Check | Result | Test |
|---|---|---|
| Secret 256-bit, in the fragment, hash-only storage, shown once | Pass | share: link creation |
| No secret, passport or NIC in logs or audit rows | Pass | share: logs |
| One generic 401 and equal work on every failure path | Pass | VERIFY-001..010, TIMING-001..003 |
| Malformed input refused before the database | Pass | VERIFY-008, 008b |
| Link lock after 10 failures | Pass | share: link lock |
| Replace / revoke ends existing sessions | Pass | TOKEN-005, share |
| Roles and Analyst scope | Pass | share: roles; admin shareForm tests |
| Fail closed without `CANDIDATE_FORM_ORIGIN` (503) | Pass | share: no origin |
| DTO whitelist (no staff-only data) | Pass | share: DTO |
| Snapshot and response immutable; SUBMITTED final | Pass | share; database triggers |
| Concurrent submits: one 200, one 409 | Pass | share: concurrent |
| Idempotent retry | Pass | share; SUBMIT-003 |
| Main candidate tables unchanged by a submission | Pass | share: submission stored |
| Only the theme in browser storage; token and secret in memory | Pass | UI-005 |

## 11. Residual risks

- Whoever has the link **and** knows the Passport and NIC numbers can submit for the candidate. The link is sent to the candidate's WhatsApp by staff; forwarding it is outside the system's control.
- A lost or stolen phone with the WhatsApp message is the same as having the link until it expires (3 days) or is revoked.
- An attacker with the link can lock it (10 failures, 1 hour). Staff can create a new one.
- A submission cannot be corrected by the candidate; staff use the existing Admin screens.
- Submitted answers are not yet shown in Admin, not merged into the main tables and not synced to the Sheet (ISS-033, ISS-034).
- Live Supabase privileges for the new tables must be checked after the migration is applied (ISS-013).

---

## 12. Job-group links (JOB_GROUP)

One link for everyone assigned to one job. Migration `20261018130000_job_company_id_and_form_job_group`; code `src/services/candidateFormJobGroupService.js`, `candidateFormVerificationService.js`, `middleware/requireCandidateFormToken.js`.

### 12.1 Schema

`candidate_form_link` gains `job_id UUID → job.id` (`ON DELETE RESTRICT`, indexed) and the kinds are `SINGLE` and `JOB_GROUP`. CHECK: **exactly one valid target** — `SINGLE`: `passport_id` set, `job_id` NULL; `JOB_GROUP`: `job_id` set, `passport_id` NULL. Partial unique index: **at most one active (unrevoked) group link per job**. RLS stays on, no policies, `anon` / `authenticated` have no privileges (unchanged, re-tested). The link is bound to the **immutable `job.id`** — never the job code, never the Company Job ID, never the legacy `candidate_stages.job_id`.

### 12.2 Creating a group link (Admin)

Candidate page → Additional details → **Share Form** → *Share link for the job group* (ADMIN and MANAGER only; Analyst and Registration Desk keep only the personal link and the section is not shown or fetched). The section uses the candidate's current PROCESSING job from `job_candidate`: with none it is disabled with a short explanation; otherwise it shows the job code, Company Job ID (or "Not assigned"), company, job type, the number of candidates on the job and how many have submitted. Creating asks for confirmation. `POST /api/admin/jobs/:jobId/form-share`:

1. lock the job row `FOR SHARE`; the job must be PROCESSING (else `409 JOB_NOT_PROCESSING`; a completion cannot interleave);
2. **regeneration rule:** revoke the job's previous active group link, create the new one (same secret rules as a personal link: 256-bit CSPRNG, only a SHA-256 stored, shown once, fragment URL `<form origin>/#k=…`, 3 days);
3. unlock each current member whose form is LOCKED (`candidate_form_access` row created if missing, `UNLOCKED`, version + 1). Members already UNLOCKED (e.g. by a personal link) are left alone so their open sessions survive; SUBMITTED members are never touched (also enforced by the existing trigger);
4. audit `CREATE_JOB_FORM_LINK` (job, link id, expiry, how many were unlocked — never the secret).

`GET .../form-share` returns the state and counts; `POST .../form-share/revoke` revokes (see 12.6). The secret exists only in the create response and the dialog's state: closing the dialog discards it, and nothing can read it back.

### 12.3 Verification (public, unchanged inputs)

`POST /api/public/candidate-details/verify { linkSecret, passportNumber, nic }` — same strict validation, rate limits and constant-time comparisons as a personal link. For a JOB_GROUP link the candidate comes from the **typed passport** and must then satisfy **all** of:

* link not revoked / expired / locked, and **its job is PROCESSING**;
* the candidate has an active `job_candidate` row for **that exact `job.id`** (live, at this moment — membership is not copied into the link);
* Passport **and** NIC match;
* the candidate's form is not SUBMITTED. A LOCKED member (added after the link was made) is unlocked now, for them alone.

Every failure — unknown / revoked / expired link, wrong passport, wrong NIC, not on this job, on another job, job completed or cancelled — is the **same generic 401** (`VERIFICATION_FAILED`, byte-identical body), so membership is never disclosed. Only after link + passport + NIC + membership matched can an already-submitted candidate be told so (neutral 409). Wrong attempts count against the link; a group link locks after 100 failures (a personal link after 10), because a typo-prone group would otherwise lock itself for everyone; the per-IP and per-passport limits still apply.

### 12.4 Session binding and per-request re-checks

The candidate token (`cf1~…`, AES-256-GCM, 60 minutes) is now version 3: it carries the candidate, the **link id**, the **link kind**, the **job id** (group links) and the candidate's **access version**. On **every** protected request (`/form`, `/submit`) the middleware reloads the link from the database and requires: the kind equals the token's; for `SINGLE` the link's passport equals the token's; for `JOB_GROUP` the link's `job_id` equals the token's **and** the link is not revoked / expired, the job is still PROCESSING and the candidate still has an active row for that job. Then the usual lock checks (SUBMITTED → 409; otherwise UNLOCKED at the token's version). The job id is never taken from the request. `/submit` repeats the job / membership check inside its transaction (job row `FOR SHARE`) before the compare-and-set, so a completion or removal between the middleware and the write cannot let a submission through.

### 12.5 PROCESSING-only behaviour (decision)

A JOB_GROUP link works **only while `job.status = PROCESSING`**. When the job becomes COMPLETED or CANCELLED: no new verification; open sessions get `401 VERIFICATION_REQUIRED` on their next request; SUBMITTED candidates stay SUBMITTED and all responses / history stay. Group links are not deleted or auto-revoked — they simply stop being usable (the admin status shows "No active group link"). Personal SINGLE links follow their own rules and are unaffected unless revoked. Removing a candidate from the job ends their access through the group link on their next request, and does not touch their submission if they already submitted.

### 12.6 Per-candidate locks, SINGLE ↔ GROUP, revoke

* The lock stays **per candidate** (`LOCKED → UNLOCKED → SUBMITTED`, terminal, trigger-enforced). A's submission changes only A; B and C stay UNLOCKED.
* Submission is candidate-level, not link-level: submitted through SINGLE → a group link answers "already submitted" and creating a personal link is `409 FORM_SUBMITTED`, and vice versa. A new browser, Incognito or another phone changes nothing; the state is in the database.
* **Revoke** a group link: it and every session bound to it stop at once; members it had unlocked and who have not submitted are locked again (version + 1); submitted answers, assignments and other jobs' links are untouched; audit `REVOKE_JOB_FORM_LINK`.
* Regenerating never reopens a SUBMITTED candidate.

### 12.7 Company Job ID independence

Changing `job.company_job_id` touches no row in `job_candidate`, `candidate_form_link`, `candidate_form_access` or `candidate_form_response`; the existing group link keeps verifying (tests JOB-ID-004 to JOB-ID-006).

### 12.8 Candidate Form (public app)

Unchanged: open link → Passport + NIC → form → submit → done. The page never receives the job id, job code, Company Job ID, member count or any other candidate; the `/form` response carries only the caller's own identity and answers (tested).

### 12.9 Residual risks (group links)

* Anyone holding the group link who also knows another member's Passport **and** NIC can submit for them — the same trust model as a personal link, with a bigger audience for the link. Staff should send it through the intended channel only; revoke if it leaks.
* A job's members can all use the same link for up to 3 days; revoke or complete the job to stop it earlier.
* Deploying the new token format (version 3) invalidates sessions issued before the deploy (at most 60 minutes old): those candidates verify again.
* The group-link failure lock (100) is looser than the personal one (10) by design; the per-passport (5 / hour) and per-IP limits remain the main brute-force control.
