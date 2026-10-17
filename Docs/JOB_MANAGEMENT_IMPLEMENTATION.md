# Job Management — Implementation

Admin > **Jobs**: a real Job entity (Company, Job Type, responsible Agent), a real Candidate ↔ Job relation with history, and the rule that a candidate is on **at most one PROCESSING job** at a time.

Migration: `20261018120000_job_management` (additive only). Code: `src/services/jobService.js`, `src/services/jobAssignmentReader.js`, routes in `src/routes/admin.js`, admin pages `admin/src/pages/Jobs*.tsx`. Tests: `test/jobManagement.test.js` (real PostgreSQL via PGlite), `admin/src/test/jobs.test.tsx`.

---

## 1. Current problem

`candidate_stages.job_id` was a 50-character **free-text** box on the Test details stage. It was not a relation, so it could not say which candidates belong to a job, could not stop a candidate being on two jobs, and could not authorise anything (for example a future job-group Candidate Form link). It also carried no Company, Agent, country or Job Type.

Audit (read-only, `scripts/auditLegacyJobIds.js`, at implementation time): 11 stage rows, **1** with a `job_id` (`Job12`, `TEST_DETAILS`, one candidate); no duplicates and no spelling variants. The Google Sheet does **not** read it (`TEST NUMBER` is always blank, see D-18.1).

No Agent, Company/Client or Job Type table existed (a "client" in the existing code is a candidate's document folder, not an employer). They were created, minimally.

## 2. Architecture

New tables (all snake_case, singular, like `candidate`): `job_type`, `company`, `agent`, `job_code_counter`, `job`, `job_candidate`. Nothing existing was changed.

```mermaid
erDiagram
    job_type ||--o{ job : "job_type_id"
    company  ||--o{ job : "company_id"
    agent    ||--o{ job : "responsible_agent_id"
    user     ||--o{ job : "created_by"
    job      ||--o{ job_candidate : "job_id"
    candidate ||--o{ job_candidate : "passport_id"
    user     ||--o{ job_candidate : "assigned_by"
    job_code_counter {
        int year PK
        int next_number
    }
    job {
        uuid id PK
        text job_code UK "JOB-YYYY-NNNNNN"
        uuid job_type_id FK
        uuid company_id FK
        uuid responsible_agent_id FK
        char2 country_code "copied from the agent at creation"
        int vacancies "null or > 0"
        text status "PROCESSING|COMPLETED|CANCELLED"
        text created_by FK
        timestamp completed_at
        timestamp cancelled_at
        text cancel_reason
    }
    job_candidate {
        uuid job_id PK,FK
        text passport_id PK,FK
        timestamp assigned_at
        text assigned_by FK
        bool is_active "true = on this PROCESSING job now"
        timestamp released_at "set when staff remove the candidate"
    }
    job_type { uuid id PK
        text code UK
        text name UK_lower
        bool is_active }
    company { uuid id PK
        text name UK_lower
        bool is_active }
    agent { uuid id PK
        text name
        char2 country_code
        bool is_active }
```

* **Reused:** `candidate`, `user` (staff), `audit_logs` (every Job action is audited).
* **Job Type** is a controlled list (`code` auto-derived from the name, e.g. "Tile Fitter" → `TILE_FITTER`). There is no free-text type on a Job. The Candidate Form's job categories could later read this same table (see §11); they are **not** coupled now. The existing `candidate.job` text (a candidate's own trades) is unrelated and unchanged.
* **Country:** the responsible Agent's country, copied onto the Job at creation (a later change of an Agent does not rewrite old Jobs). The responsible Agent and the country can't be edited on a job (open decision §14).
* Jobs are **never hard-deleted**: `job_candidate.job_id` is `ON DELETE RESTRICT`, and there is no delete route.

### 2.1 Three identifiers — which one is for what

| | Column | Who sets it | Mutable | Used as a key / for authorisation |
|---|---|---|---|---|
| **Internal Job ID** | `job.id` (UUID, primary key) | the database | **never** | **yes — every relation** (`job_candidate.job_id`, `candidate_form_link.job_id`) |
| **Internal Job Code** | `job.job_code` `JOB-YYYY-NNNNNN` | the system (counter, §3) | no (no route changes it) | no; a display reference for staff |
| **Company Job ID** | `job.company_job_id` (e.g. `Y26S01`, `IL-2026-44`) | ADMIN / MANAGER, any time | **yes** | **no** — a plain label |

**Why a mutable business ID is never a foreign key.** The employer may supply, correct or re-issue its ID later (or two employers may use the same string). If a relation used it, changing it would have to rewrite `job_candidate`, every Candidate Form link and the audit history, and a typo or a reused ID could attach a candidate to the wrong job — or open a form to the wrong people. Everything therefore points at `job.id`; the Company Job ID is looked at by people only.

**Company Job ID rules** (migration `20261018130000_job_company_id_and_form_job_group`): nullable; set when the job is created or later (`PUT /jobs/:jobId { companyJobId }`, ADMIN / MANAGER only, **also on a COMPLETED / CANCELLED job**, since the employer's ID can arrive late; `null` or empty clears it); normalised by the service (trimmed, repeated spaces collapsed, English letters upper-cased); 1–40 characters from `A-Z 0-9` space `. _ / # -` — control characters (tabs and line breaks too), other symbols and non-English letters are refused (API 400, and a database CHECK). A candidate can never edit it (no public route touches `job`).

**Uniqueness decision:** unique **per company** when present — `UNIQUE (company_id, company_job_id) WHERE company_job_id IS NOT NULL` — not global. Nothing in the business rules says two employers cannot use the same code (`Y26S01` is exactly the kind of string two companies might both use); a global rule would block valid data and invite workarounds. Several jobs without one are fine. A duplicate within a company is `409 COMPANY_JOB_ID_EXISTS`. Changing a job's company to one that already has that ID is the same 409.

**Changing it changes nothing else:** `job.id`, `job_code`, `job_candidate`, `candidate_form_link`, `candidate_form_access` and `candidate_form_response` are not touched; the same group link keeps working (tests JOB-ID-004 to JOB-ID-006). The audit entry `UPDATE_JOB` records the old and the new value.

## 3. Job Code

`JOB-YYYY-NNNNNN`, e.g. `JOB-2026-000001`, from the yearly counter table `job_code_counter(year, next_number)`:

```sql
INSERT INTO job_code_counter (year, next_number) VALUES ($year, 2)
ON CONFLICT (year) DO UPDATE SET next_number = job_code_counter.next_number + 1
RETURNING next_number - 1 AS number
```

One atomic statement inside the creation transaction: concurrent creations queue on the counter row's lock, so no number is handed out twice, and a failed creation rolls the increment back (no gaps from rejected requests). The year is the Asia/Colombo calendar year. Never client-generated, never `MAX()+1`, never a timestamp. The database also enforces `UNIQUE(job_code)` and the format (`CHECK`). Numbers beyond 999999 simply grow wider.

## 4. Candidate assignment

`POST /api/admin/jobs/:jobId/candidates { passportId }`, one transaction:

1. lock the job row `FOR SHARE` (blocks a concurrent complete/cancel, not other assignments);
2. job must exist → else `404 JOB_NOT_FOUND`;
3. job must be `PROCESSING` → else `409 JOB_NOT_PROCESSING`;
4. lock the candidate row `FOR UPDATE` (serialises every assignment of this candidate); must exist → `404 CANDIDATE_NOT_FOUND`;
5. already on **this** job → `409 CANDIDATE_ALREADY_IN_JOB`;
6. active on **another** PROCESSING job → `409 CANDIDATE_ON_ACTIVE_JOB` (the message names that job). The candidate is **never moved silently**;
7. insert the membership (or, if staff removed the candidate from this same job earlier, reactivate that row).

`DELETE /api/admin/jobs/:jobId/candidates/:passportId` takes the candidate off a PROCESSING job (`is_active=false`, `released_at` set; the row stays as history).

## 5. The one-PROCESSING-job rule

Enforced at three levels, so the frontend is never the only guard:

1. **Service** — step 6 above, under the candidate row lock.
2. **Partial unique index** — `CREATE UNIQUE INDEX job_candidate_one_active_per_candidate ON job_candidate(passport_id) WHERE is_active`. A second active row cannot commit however it is written (the service maps the violation to the same `409 CANDIDATE_ON_ACTIVE_JOB`).
3. **Triggers** — a membership can only be `is_active` on a PROCESSING job (`job_candidate_active_requires_processing`), and when a job leaves PROCESSING every membership of it is deactivated in the same transaction (`job_status_transition`).

`is_active` is therefore the database's own "this candidate is on this PROCESSING job now" flag. Two staff assigning the same candidate to two jobs at once: they queue on the candidate lock; the second sees the first and gets 409 (test JOB-014).

## 6. Complete and cancel

| | Complete | Cancel |
|---|---|---|
| Route | `POST /jobs/:jobId/complete` | `POST /jobs/:jobId/cancel { reason }` |
| Allowed from | PROCESSING only (else 409 `JOB_NOT_PROCESSING`) | PROCESSING only |
| Sets | `status=COMPLETED`, `completed_at` | `status=CANCELLED`, `cancelled_at`, `cancel_reason` (**required**, ≤500 chars; also a DB `CHECK`) |
| `job_candidate` rows | all kept (history) | all kept (history) |
| Candidates | released: `is_active=false` by trigger, free for another PROCESSING job | same |

The database `CHECK` constraints tie timestamps and reason to the status, and a trigger refuses any change of a COMPLETED/CANCELLED job's status. **Reopen is not implemented** (not approved) — see §14. PUT (`vacancies`, `jobTypeId`, `companyId`) works on PROCESSING jobs only.

## 7. Permissions

Backend-enforced (`requireRole`); creating, viewing and revoking a Candidate Form job-group link is ADMIN and MANAGER only, on top of the existing RBAC:

| Role | Jobs |
|---|---|
| ADMIN, MANAGER | full: create/update, add/remove candidates, complete, cancel; create Job Types / Companies / Agents |
| ANALYST | **read only**, and only jobs that hold at least one candidate **allocated to them**; the candidate list and the candidate count show only their own candidates; any other job is `404` (not `403`, so existence isn't revealed) |
| REGISTRATION_DESK | no access to the Jobs API or the Jobs sidebar entry (`403`) |

The Candidate Details page (all Candidates-area roles, within Work Allocation scope) shows the candidate's job assignment read-only, because it is part of the candidate's record, not job management. Job links there appear only for roles that can open Jobs.

## 8. API

All under `/api/admin`, JSON, `Cache-Control: no-store`, authenticated.

| Method & path | Roles | Purpose |
|---|---|---|
| `GET /jobs?view=processing\|completed\|cancelled&search=&page=` | ADMIN, MANAGER, ANALYST (scoped) | list (50/page), with tab counts |
| `GET /jobs/:jobId` | same | details + assigned candidates |
| `POST /jobs` `{ jobTypeId, companyId, responsibleAgentId, vacancies?, companyJobId? }` | ADMIN, MANAGER | create (PROCESSING, code generated) |
| `PUT /jobs/:jobId` `{ vacancies?, jobTypeId?, companyId?, companyJobId? }` | ADMIN, MANAGER | update a PROCESSING job; `companyJobId` alone also on a finished job |
| `GET/POST /jobs/:jobId/form-share`, `POST /jobs/:jobId/form-share/revoke` | ADMIN, MANAGER | Candidate Form job-group link: status, create (URL returned once), revoke |
| `POST /jobs/:jobId/candidates` `{ passportId }` | ADMIN, MANAGER | assign (§4) |
| `DELETE /jobs/:jobId/candidates/:passportId` | ADMIN, MANAGER | remove from a PROCESSING job |
| `POST /jobs/:jobId/complete` | ADMIN, MANAGER | complete |
| `POST /jobs/:jobId/cancel` `{ reason }` | ADMIN, MANAGER | cancel |
| `GET /job-options` | ADMIN, MANAGER | active job types, companies, agents |
| `POST /job-types` `{ name }`, `/companies` `{ name }`, `/agents` `{ name, countryCode }` | ADMIN, MANAGER | minimal reference-data creation |

Errors: `{ message, code }` — `JOB_NOT_FOUND`, `JOB_NOT_PROCESSING`, `CANDIDATE_NOT_FOUND`, `CANDIDATE_ALREADY_IN_JOB`, `CANDIDATE_ON_ACTIVE_JOB`, `CANDIDATE_NOT_IN_JOB`, `REFERENCE_NOT_FOUND` (400), `DUPLICATE` (409); validation `400 { errors: [{ field, message }] }`. Responses never include internal columns beyond the job's own fields.

Audit actions (category **Job** in Audit Logs): `CREATE_JOB`, `UPDATE_JOB`, `COMPLETE_JOB`, `CANCEL_JOB`, `ADD_CANDIDATE_TO_JOB`, `REMOVE_CANDIDATE_FROM_JOB`, `CREATE_JOB_TYPE`, `CREATE_COMPANY`, `CREATE_AGENT`.

## 9. Admin UI

* **Jobs** (sidebar, ADMIN/MANAGER/ANALYST): tabs **Processing / Completed / Cancelled** with counts (cancelled is a third tab, kept separate so completed history stays clean), search, paging; columns Job code, Job type, Country, Company, Responsible agent, Candidates, Vacancies, Status. ADMIN/MANAGER get **New job**: pick type, company and agent (each with an inline "Add …" for the first records, since no management screens exist), optional vacancies; the country shows from the agent.
* **Job details**: all fields, created/completed/cancelled metadata and cancel reason, the candidate table (each links to Candidate Details), and for ADMIN/MANAGER on a PROCESSING job: **Add to job** (search → Add, stays open for several; the server's 409 message is shown when the candidate is on another PROCESSING job), **Remove**, **Complete job** (confirm), **Cancel job** (reason required).
* **Candidate Details**: a **Job assignment** section — *Current processing job* (code, type, company, agent) and *Job history* (completed / cancelled / removed). The Test details stage shows the assigned job read-only; the old text appears only as a read-only **Legacy job reference**.

## 10. Migration from `candidate_stages.job_id`

Strategy: **preserve, don't fabricate.**

1. Audited the real values (above). A job reference has no Company, Agent or Job Type, and "do not invent Company/Agent references" applies, so **no Job or assignment row is created from it**. (`Job12` is not parseable into a code, and mapping it needs a business decision.)
2. The column is **not dropped and not rewritten** (test: every legacy value is byte-identical after the migration, no `job` / `job_candidate` rows appear). It is commented `DEPRECATED` in the database and in `schema.prisma`.
3. The API **stops writing it**: `PUT .../stages/TEST_DETAILS` with `jobId` now returns `400` ("assign the candidate to a Job"). The stage response no longer has `jobId`; the old text is returned as `legacyJobId` and shown read-only.
4. **Nothing reads it for assignment** (Candidate Details, Jobs, Analyst scope, the Sheet mapper — its `jobId` select was removed).
5. To migrate a legacy value later: staff create the real Job (with Company/Agent/Type) and assign the candidate; the legacy text can then be ignored. `node scripts/auditLegacyJobIds.js` re-lists what is left (read-only).
6. **Dropping the column** is a separate later migration, once no unmapped value remains (or after the values are archived). Not done here.

**Unmapped/legacy data now:** 1 value (`Job12`, `TEST_DETAILS`, one candidate) stays in `candidate_stages.job_id` and is shown on that candidate's Test details as a legacy reference.

## 11. Candidate Form — job-group link (implemented)

> **Implemented** in the second Job task: see `CANDIDATE_EXTRA_DETAILS_FORM_SHARE_LINKS_DESIGN.md` §12. The design below is what was built, with one correction: the link binds to `job.id` and membership is `job_candidate.is_active` on a PROCESSING job (not `released_at IS NULL`), so a completed or cancelled job's group link is unusable.

The schema is ready; nothing in the Candidate Form was touched. The relation the form should use later:

```
candidate_form_link ( kind = 'JOB_GROUP', job_id → job.id )      -- new nullable job_id column (+ index), passport_id stays NULL
verify:  share link → bound to job.id
         → candidate supplies Passport + NIC (existing verification)
         → backend checks   EXISTS job_candidate WHERE job_id = link.job_id
                                              AND passport_id = <verified candidate>
                                              AND released_at IS NULL
         → only candidates assigned to that exact Job continue; others get the same generic "not found" as today
```

Use `released_at IS NULL` (a member of the job, including after COMPLETED, if the business wants that) or `is_active` (only while the job is PROCESSING) — an open decision (§14). `CandidateFormLink.kind` already allows other kinds ("a job-group kind can be added later"). The Candidate Form's `job_category` answers could later be validated against / offered from `job_type`; not coupled.

## 12. Google Sheet impact

None today. The Sheet never mirrored `candidate_stages.job_id` (`TEST NUMBER` is always blank, D-18.1; the mapper selected the column but never used it — that read is removed). If the business later wants a "current job" column, map it from the real relation: `job_candidate` where `is_active` → `job.job_code`, and add the column to `sheetSchema.js` and the outbox triggers (a `job_candidate` trigger writing `sheet_sync_queue`, like the existing ones). Not done; existing columns are untouched.

## 13. Security / RLS

For every new table: `ENABLE ROW LEVEL SECURITY`, `REVOKE ALL … FROM anon, authenticated`, **no policies** — reachable only through the backend's owner/service connection (tested against the migrated schema). No new public route; every route needs a signed-in ACTIVE staff user plus the role check. The Job APIs return only the job's own fields. `audit_logs` stays append-only.

## 14. Open decisions (not inferable)

1. **Reopening** a COMPLETED/CANCELLED job — not approved, not implemented; the DB trigger currently forbids it. If approved: re-check every assigned candidate for another PROCESSING job and reject with 409.
2. **Vacancies** are informational: assigning beyond the number is allowed (shown "N candidates / M vacancies").
3. **Agent country** is the job's country, copied once; changing a job's Agent/country after creation is not offered.
4. Who may **manage Companies / Agents / Job Types** beyond the minimal create (rename, deactivate, list screens) — no management UI was built, per scope.
5. ~~Whether job-group Candidate Form access should survive a job's completion~~ **Decided:** it does not. A JOB_GROUP link works only while the job is PROCESSING.
6. What to do with the one legacy value `Job12`, and when to drop `candidate_stages.job_id`.
7. A candidate **deleted** from the system cascades away their `job_candidate` history (like the other candidate child tables).
8. Whether REGISTRATION_DESK needs any Job visibility (none today beyond the read-only section on the candidate's own page).

## 15. Tests

`test/jobManagement.test.js` (24 tests, real PostgreSQL via PGlite with every migration, real Prisma client, real router):

| ID | Covered |
|---|---|
| JOB-001 | create PROCESSING job, code, country from agent |
| JOB-002 | unique/sequential codes, concurrent creation, DB uniqueness + format check, failed creation doesn't burn a number |
| JOB-003 | required real Agent/Company/Type; free text, inactive and unknown references refused; FKs |
| JOB-004 / 005 | assignment succeeds / duplicate to same job refused |
| JOB-006 | second PROCESSING job refused, 409 `CANDIDATE_ON_ACTIVE_JOB`, nothing moved |
| JOB-007 / 008 | COMPLETED / CANCELLED jobs refuse assignment |
| JOB-009 / 011 | complete releases, history kept |
| JOB-010 / 012 | cancel releases, history kept (reason shown on the candidate page) |
| JOB-013 | cancel needs a reason (API + DB `CHECK`) |
| JOB-014 | concurrent assignments → exactly one succeeds; DB partial unique index |
| JOB-015 | ADMIN/MANAGER only; ANALYST and REGISTRATION_DESK blocked on every write and on options; DESK blocked on reads |
| JOB-016 | Analyst scope: only jobs with their candidates, only those candidates, others 404 |
| JOB-017 | Candidate Details reads the Job relation (current + history) |
| JOB-018 | legacy `candidate_stages.job_id` neither assigns nor can be written; kept read-only |
| + | migration: legacy values byte-identical, no job invented, RLS on / no grants / no policies on all 6 tables; reopen blocked by trigger; job with assignments can't be deleted; list views/search; reference data; remove/re-add |

`test/jobGroupShare.test.js` (24 tests: JOB-ID-001 to 007 and GROUP-001 to 023, on PGlite) covers the Company Job ID and the Candidate Form job-group links; `admin/src/test/jobGroupShareForm.test.tsx` the Share Form group section.

`admin/src/test/jobs.test.tsx` (20 tests): Processing view, Completed/Cancelled views, search, permission visibility (ADMIN/MANAGER/ANALYST/REGISTRATION_DESK), New job, Job details (active, completed, cancelled, Analyst read-only), Add to job incl. the active-job conflict message, Complete, Cancel (reason required), Remove. `admin/src/test/candidates.test.tsx` adds the Candidate Details Job section (current + history + legacy reference). Existing stage tests were updated for the removed `jobId` field (now rejected / `legacyJobId`).

## 16. Deployment

Do **not** run `prisma migrate dev` (known Supabase shadow-replay issue). The migration is hand-written, additive and tested by replaying all migrations on PGlite. Apply with `npx prisma migrate deploy`, then `npx prisma generate`; verify with `npx prisma migrate status`. Rollback is a manual `DROP` of the six tables, two functions and the column comment (no existing data is touched), so deploy the code and the migration together (the new candidate response reads `job_candidate`).
