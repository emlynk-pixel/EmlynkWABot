# Performance and Bug Audit (Measured)

**Date:** 2026-11-06 · **Branch:** `dev` (commit `0fe6723`) · **Code changed:** none

This audit runs every test suite, measures every important admin API against a seeded database at two sizes, and lists the bugs and the reasons the system slows down. It builds on the earlier static audit, [API_CALLS_AND_PERFORMANCE_AUDIT.md](API_CALLS_AND_PERFORMANCE_AUDIT.md). That document maps every endpoint but has no measurements. This one adds the numbers.

---

## Contents

1. [Summary](#1-summary)
2. [Test suite results](#2-test-suite-results)
3. [How the APIs were measured](#3-how-the-apis-were-measured)
4. [API measurement results](#4-api-measurement-results)
5. [Bugs found](#5-bugs-found)
6. [Why the system is slow: root causes](#6-why-the-system-is-slow-root-causes)
7. [Database: missing indexes and query problems](#7-database-missing-indexes-and-query-problems)
8. [Frontend performance](#8-frontend-performance)
9. [Production factors not measured here](#9-production-factors-not-measured-here)
10. [Prioritised fix plan](#10-prioritised-fix-plan)
11. [What was not covered](#11-what-was-not-covered)

---

## 1. Summary

**Tests:** all four test suites pass. The only failures were 2 admin tests that fail under heavy CPU load and pass when run alone (flaky, see [B-6](#b-6-two-admin-filter-tests-are-flaky-under-load)).

**Main finding:** list and detail APIs are fast and stay flat as data grows. A small group of endpoints reads **every candidate (and every related document) on each request**, then filters and pages the rows in JavaScript. Those endpoints became **4 to 5 times slower** when the data went from 2,000 to 10,000 candidates. At production size, with network latency added, they cause the slow pages users see.

### Top 10 issues

| # | Issue | Type | Measured (10k candidates, local) | Where users feel it |
|---:|---|---|---|---|
| 1 | Notification bell loads the whole review queue in a loop and **breaks above 1,000 items** | **Bug** + load | 11 requests, 101 SQL statements, final request **400** | Every page load, every bell click (ADMIN/OWNER) |
| 2 | Daily Report summary reads all candidates **and** all police documents | Slow API | **1,365 ms**, 31 SQL | Daily Report page |
| 3 | Candidate filters "Status" and "Stage" evaluate every candidate in memory | Slow API + **limit bug** | **1,117 / 1,145 ms**; refused above 20,000 candidates | Candidates, Work Allocation |
| 4 | Daily Report "incomplete" re-reads all candidates for each stage expansion | Slow API | **937 ms** | Daily Report, expanding a stage |
| 5 | Overview dashboard runs 2 whole-table scans and 20 SQL statements | Slow API | **447 ms**, 20 SQL | Overview (home page for ADMIN) |
| 6 | Documents search uses `ILIKE '%…%'` across a join with no index | Slow API | **461 ms** | Documents page search |
| 7 | Daily report (base) recomputes every client's police status | Slow API | **416 ms** | Daily Report |
| 8 | Clients, Missing Documents, Police read every candidate and page in memory | Grows linearly | 205–233 ms (5× growth) | Those three pages |
| 9 | Every admin API call makes a network call to Supabase Auth plus 2 DB statements first, and a token refresh reloads every open resource | Baseline cost | not measurable locally | Every request |
| 10 | Follow-ups API returns up to **870 KB**, and the header bell downloads it for TEAM_LEAD/ANALYST | Large payload | 78 ms, **869.5 KB** | Every page load (TEAM_LEAD, ANALYST) |

---

## 2. Test suite results

All suites were run on this machine on 2026-11-06.

| Suite | Command | Result | Duration |
|---|---|---|---|
| Backend API, services, DB (node:test, PGlite) | `npm test` | **2,434 tests: 2,412 pass, 0 fail, 22 skipped** | 291 s |
| Admin dashboard (Vitest + jsdom) | `npm --prefix admin test` | 786 tests: **784 pass, 2 fail** (flaky, see B-6) | 290 s |
| Admin typecheck | `tsc --noEmit` | Pass | 3 s |
| Admin production build | `vite build` | Pass, with a chunk-size warning (see §8) | 1.2 s |
| Candidate Form (Vitest + jsdom) | `npm --prefix candidate-form test` | **200 pass, 0 fail** | 145 s |
| Candidate Form typecheck and build | `tsc`, `vite build` | Pass | 1 s |
| OCR worker | `npm --prefix ocr-worker test` | 102 tests: **85 pass, 0 fail, 17 skipped** | 3 s |

Notes:

- The 17 OCR skips are the real-Tesseract tests, which run only with `RUN_OCR_TESTS=1`. OCR accuracy and speed with real images were therefore not tested.
- The 2 admin failures were in `admin/src/test/advancedFilters.test.tsx`. Run on its own, that file passes **17 of 17**.
- The existing import performance test reports, on PGlite: 1,000-row import preview in 656 ms (11 operations), each 100-row chunk ≤ 562 ms (≤ 14 operations), 5 Google write requests. No N+1 problem in the import.
- Builds were written to a temporary folder, so `admin/dist` and `candidate-form/dist` were not touched.

---

## 3. How the APIs were measured

There are no load-test tools or timing logs in the repository, so a benchmark was run against a local copy of the database:

- **Real code:** the real admin router (`createAdminRouter`), the real Prisma client, and **every migration** in `prisma/migrations`, the same setup the backend tests use.
- **Database:** PGlite (PostgreSQL compiled to WebAssembly, in memory). It never connects to Supabase: `DATABASE_URL` was pointed at an address that cannot be reached, so any stray real-database call would fail.
- **Synthetic data at two sizes:**

| Table | 2k run | 10k run |
|---|---:|---:|
| candidate | 2,000 | 10,000 |
| documents | 5,999 | 30,000 |
| temporary_data (WhatsApp submissions) | 3,000 | 15,000 |
| review queue items (pending + REVIEW_REQUIRED) | 1,355 | 6,765 |
| candidate_stages | 7,000 | 35,000 |
| audit_logs | 10,000 | 50,000 |
| call logs / open follow-ups | 4,000 / 250 | 20,000 / 1,250 |
| users | 1 ADMIN, 1 TEAM_LEAD, 6 ANALYST | same |

- **Per endpoint:** 1 warm-up call, then 5 timed calls (2k) or 3 (10k). The table shows the median. Every SQL statement was counted through Prisma's query log.
- **Not included:** Supabase Auth verification and the rate-limit upsert (both replaced by stubs), network latency, Storage, Meta and OCR.

**How to read the numbers.** PGlite has no network and one connection, so the times are a **lower bound** for the database and JavaScript work. Two things carry over to production: **how a time grows with data** (the 2k → 10k ratio) and **the SQL statement count**. In production each statement also pays a network round trip to Supabase (see §9).

---

## 4. API measurement results

Classes, by the 10k median: **SLOW** ≥ 400 ms · **MEDIUM** 100–400 ms or growing ≥ 3× · **FAST** below that. "Growth" is the 10k time divided by the 2k time; a ratio near 5× means the cost grows with the whole table, not with the page size.

### 4.1 Slow and growing endpoints

| Endpoint | 2k (ms) | 10k (ms) | Growth | SQL | Response size (10k) | Class |
|---|---:|---:|---:|---:|---:|---|
| GET `/reports/daily/summary` | 294 | **1,365** | 4.6× | 31 | 66.8 KB | **SLOW** |
| GET `/candidates?stage=…` (derived) | 217 | **1,145** | 5.3× | 7 | 0.2 KB | **SLOW** |
| GET `/candidates?workflowStatus=…` (derived) | 261 | **1,117** | 4.3× | 17 | 56.3 KB | **SLOW** |
| GET `/reports/daily/incomplete?stage=…` | 184 | **937** | 5.1× | 4 | 2.2 KB | **SLOW** |
| GET `/documents?search=…` | 101 | **461** | 4.6× | 5 | 8.7 KB | **SLOW** |
| GET `/overview` | 109 | **447** | 4.1× | 20 | 4.5 KB | **SLOW** |
| GET `/reports/daily` | 82 | **416** | 5.1× | 11 | 0.9 KB | **SLOW** |
| GET `/clients` | 41 | 233 | 5.7× | 4 | 11 KB | MEDIUM |
| GET `/police` | 50 | 228 | 4.6× | 4 | 8.8 KB | MEDIUM |
| GET `/documents/missing` | 42 | 205 | 4.9× | 4 | 11.4 KB | MEDIUM |
| Notification bell (all `/review` pages) | 312 total | 580 total | — | 101 | ~35 KB × 10 | MEDIUM + **bug** |
| GET `/follow-ups?status=OPEN` (admin) | 41 | 78 | 1.9× | 7 | **869.5 KB** | MEDIUM (payload) |
| GET `/follow-ups?status=OPEN` (analyst) | 20 | 66 | 3.3× | 7 | **599.2 KB** | MEDIUM (payload) |
| POST `/candidates` (registration) | 21 | 64 | 3.0× | 9 | — | MEDIUM (grows) |
| GET `/review?page=10&pageSize=100` | 39 | 75 | 1.9× | 10 | 34 KB | MEDIUM |
| GET `/candidate-suggestions` | 23 | 53 | 2.3× | 3 | 0.6 KB | FAST (grows) |
| GET `/audit-logs` page 1 | 14 | 47 | 3.4× | 6 | 26 KB | FAST (grows) |
| GET `/documents` page 1 | 12 | 37 | 3.1× | 5 | 8.7 KB | FAST (grows) |

### 4.2 Fast endpoints (flat as data grows)

These are well built: database paging, bounded queries, and relations loaded in batches (no N+1).

| Endpoint | 10k (ms) | SQL | Endpoint | 10k (ms) | SQL |
|---|---:|---:|---|---:|---:|
| `/candidates` page 1 | 31 | 10 | `/candidates/:id` | 11 | 7 |
| `/candidates` page 50 | 28 | 10 | `/candidates/:id/call-logs` | 24 | 11 |
| `/candidates?search=` (1 word) | 81 | 10 | `/candidates/:id/additional-details` | 8 | 4 |
| `/candidates?jobType=` | 61 | 11 | `/candidates/:id/form-submission` | 12 | 8 |
| `/candidates` (ANALYST scope) | 36 | 10 | `/clients/:passportId` | 16 | 6 |
| `/work-allocation/candidates` | 28 | 10 | `/review` page 1 | 38–43 | 10 |
| `/work-allocation/analysts` | 13 | 4 | `/reports/monthly` | 21 | 7 |
| `/job-candidate-options` | 28 | 9 | `/reports/daily/roles` | 19 | 5 |
| `/job-options`, `/jobs`, `/job-type-choices` | 5–9 | 2–4 | `/agents`, `/client-management` | 6 | 5–6 |
| `/candidate-filter-options` | 9 | 5 | `/audit-logs?action=` | 26 | 6 |

**Statement count matters even for fast endpoints.** The candidate list runs 10 SQL statements for one page. That is fine locally, but in production each statement costs a round trip (see §9).

---

## 5. Bugs found

### B-1 Notification bell fails when the review queue has more than 1,000 items

**Severity: HIGH (visible bug and heavy load).** Confirmed by measurement.

- `admin/src/components/NotificationBell.tsx` (`loadReviewNotifications`) requests `/review?page=1,2,3…&pageSize=100` **one page after another** until it has `summary.total` items.
- The server only allows paging up to item 1,000 (`REVIEW_QUEUE_WINDOW = 1000` in `src/services/adminReviewService.js`). Page 11 is refused with **400** *"the queue can be paged up to item 1000"*.
- **Result, measured:** with 1,355 items (2k run) and 6,765 items (10k run), the bell sent 11 requests and 101 SQL statements, and the last request failed. `fetchNotifications` then sets `error = true`, so the bell shows an error and **no notifications at all**, although the first 1,000 items were downloaded.
- **It runs often:** on every app load, on every Supabase token refresh (the `token` dependency changes), and **every time the bell is opened** (`handleToggle`).
- **Extra issue:** `handleToggle` calls `fetchNotifications()` with no abort signal. Opening the bell several times quickly starts several full loops at once, and whichever finishes last wins.
- **Each page also reads more rows:** page *n* makes the server read *n × 100* rows from each source and merge them (window merge). 10 pages read about 11,000 rows in total.
- **Fix:** one request, `GET /review?page=1&pageSize=20&order=desc`, using `summary.total` for the badge count. Or a small new endpoint that returns `{ total, newest 20 }`.

### B-2 Candidate "Status", "Stage" and job-type filters stop working above 20,000 candidates

**Severity: MEDIUM now, HIGH later (a hard failure as data grows).**

- `pageCandidates` (`src/services/candidateService.js`) evaluates these "derived" filters in JavaScript on **every** candidate that matches the database part of the query, and refuses the request with **422 TOO_MANY_TO_FILTER** above `MAX_DERIVED_FILTER_CANDIDATES = 20_000`.
- At 10,000 candidates the Status and Stage filters already take about 1.1 s locally (§4.1). Once the table passes 20,000, these filters fail unless the user also adds a date range or search.
- Affects `/candidates` and `/work-allocation/candidates`.
- **Fix:** move the Status and current-stage logic into SQL, or store a maintained `workflow_status` / `current_stage` column, updated when stages, documents, verification or jobs change.

### B-3 The Review Queue page cannot reach items after number 1,000

**Severity: MEDIUM (functional limit).**

- The same 1,000-item window applies to the Review Queue page itself. In the 10k run the queue had 6,765 items, and only the first 1,000 (by date order) can be paged. The rest are reachable only through filters.
- **Fix:** keyset paging (cursor on `created_date` / `received_date` + id) instead of merging two windowed lists in memory, or a SQL `UNION ALL` with `LIMIT/OFFSET`.

### B-4 WhatsApp-number lookup ignores the unique index that already exists

**Severity: MEDIUM (performance bug; affects the WhatsApp webhook and registration).**

- `findUsersByWhatsappNumber` (`src/services/userLookupService.js:52`) queries `whatsappNumber: { endsWith: last4digits }`, which becomes `LIKE '%1234'`. A leading `%` cannot use an index, so **every lookup scans the whole candidate table**, then filters in JavaScript.
- A unique functional index on `candidate_phone_key(whatsapp_number)` **already exists** (migration `candidate_whatsapp_number_key_normalized`). It is never used by this lookup.
- Called on every registration (`assertWhatsappFree`), on candidate updates, and during WhatsApp identity matching.
- **Fix:** `WHERE candidate_phone_key(whatsapp_number) = candidate_phone_key($1)` with raw SQL. It is then an index lookup.

### B-5 Registration reads every candidate's unique ID

**Severity: MEDIUM (grows with every candidate).** Confirmed: the SQL captured is `SELECT passport_id, unique_id FROM candidate WHERE 1=1`.

- `nextUniqueId` (`src/services/candidateService.js:955`) loads every `unique_id` to find the highest number, and does it again on each of up to 5 retries after a collision.
- Registration also checks the passport with `mode: "insensitive"` (`lower(passport_id) = lower($1)`), which cannot use the primary key index.
- Measured: 21 ms → 64 ms from 2k to 10k candidates, 9 SQL statements.
- **Fix:** a counter table with `INSERT … ON CONFLICT DO UPDATE … RETURNING`, the same pattern as `job_code_counter`, or `SELECT max(unique_id::int)` restricted to numeric IDs. Add an expression index on `lower(passport_id)`.

### B-6 Two admin filter tests are flaky under load

**Severity: LOW (developer experience).**

- `advancedFilters.test.tsx` → "UI-5..7 filters stack…" (timed out at 5,079 ms) and "UI-3b filters in the URL come back as buttons…" failed during the full run (3 suites running in parallel) but **pass 17/17 when the file runs alone**.
- Cause: the test waits on the 500 ms text debounce and many user events within vitest's 5 s default timeout. Under CPU load it runs out of time.
- **Fix:** `testTimeout: 20000` in `admin/vite.config.ts` (the Candidate Form config already does this), or fake timers for the debounce.

### B-7 Follow-ups API and bell download hundreds of KB

**Severity: MEDIUM.**

- `GET /follow-ups?status=OPEN` returns up to 500 follow-ups, each candidate group with its full document status. Measured: **869.5 KB** (admin) and **599.2 KB** (one analyst) at 1,250 open follow-ups.
- The header bell for TEAM_LEAD/ANALYST (`loadFollowUpNotifications`) downloads this whole response on every page load and bell open, but needs only names, notes and dates.
- Above 500 open follow-ups the list is cut (`truncated: true`) with no paging.
- **Fix:** a light bell endpoint (count + newest 20, no document status), and paging for the Need Attention page.

### B-8 Risk: the rate limit is shared by everyone behind one office IP

**Severity: MEDIUM (can surface as random 429 errors).**

- `/api/admin` allows **1,000 requests per 15 minutes per client IP** (`src/middleware/apiRateLimiter.js`). Staff in one office behind one internet connection share one counter.
- One ADMIN page load costs roughly 3–5 API calls, **plus the bell's up to 11 calls**, plus every token refresh reloading everything. Ten staff in one office can reach the limit in normal busy use.
- **Fix:** fixing B-1 removes most of this. Then consider keying the limiter by user ID after authentication, or raising the limit for authenticated requests.

---

## 6. Why the system is slow: root causes

### RC-1 Whole-table reads, then filtering and paging in JavaScript

Most of the slowest endpoints share one pattern: read **every** candidate (and often every document or stage), compute a status in JavaScript, then filter and page. The cost grows with the total number of candidates, not with the 25 or 100 rows shown.

| Helper | File | Used by | Reads |
|---|---|---|---|
| `readProgress` | `src/services/dailyReportService.js:131` | `/reports/daily/summary`, `/reports/daily/incomplete` (per stage, per page) | every candidate + stages + required documents |
| `loadPoliceStatuses` / `policeDueCounts` | `src/services/adminPoliceService.js:41` | `/overview`, `/reports/daily`, `/reports/daily/summary`, `/police` | every candidate + every police slip/report + pending slips |
| `loadClientCompleteness` | `src/services/adminClientService.js:107` | `/overview`, `/clients`, `/documents/missing` | every candidate + document counts + pending counts |
| `pageCandidates` (derived filters) | `src/services/candidateService.js:762` | `/candidates`, `/work-allocation/candidates` with Status / Stage / job type | up to 20,000 candidates + 4 relations |

The worst combinations:

- **`/reports/daily/summary`** runs `getDailyReport` (whole police scan) **and** `readProgress` (whole progress scan) **and** 8 other queries: **31 SQL statements, 1.37 s at 10k**.
- **`/overview`** runs `policeDueCounts` **and** `clientCompletenessCounts`, both whole-table, inside a 13-way `Promise.all`: 20 statements. In production the pool has only 3 connections per instance (`src/config/prisma.js`), so they queue.
- **`/reports/daily/incomplete`** repeats the full `readProgress` for each stage a user expands and each page they view.

### RC-2 Baseline cost on every admin request

Before any business logic, every `/api/admin/*` request:

1. Upserts a row in `rate_limits` (1 SQL statement).
2. Calls **Supabase Auth `auth.getUser(token)` over HTTPS** (`src/auth/supabaseIdentity.js`). No caching, by design.
3. Loads the `user` row (1 SQL statement).

So every API call pays **one external HTTPS round trip and two database round trips** before it starts. Pages that fire 3–5 parallel requests pay this 3–5 times.

### RC-3 The frontend repeats requests

- **Token refresh:** when Supabase refreshes the access token (`TOKEN_REFRESHED` in `admin/src/auth/AuthProvider.tsx`), `token` changes, and every `useAdminResource` (`admin/src/api/useAdminResource.ts`, its effect depends on `token`) plus the bell reload at the same moment.
- **The bell loop** (B-1) on every load, refresh and open.
- **Add selected** on the job page (`admin/src/pages/JobDetailsPage.tsx:412`) sends **one request per candidate, one after another**, and each response re-reads the whole job with every member (`getJob`). 50 selected candidates means 50 sequential round trips plus 50 full job reads.

### RC-4 Text search with `ILIKE '%…%'` and no trigram index

The candidate, document and suggestion searches use Prisma `contains` + `mode: "insensitive"` (SQL `ILIKE '%term%'`). PostgreSQL cannot use a B-tree index for that, so each search scans the table. The documents search also joins to candidate for names: **461 ms at 10k**, growing 4.6×.

### RC-5 Too many SQL statements per request

Prisma 6 without the `relationJoins` preview feature loads each `select`ed relation with **a separate query**. The candidate list does 10 statements per page, the call-log dialog 11, the overview 20, the daily summary 31. Locally each costs well under 1 ms. Over a network each costs a full round trip (§9).

Smaller contributor: `submittedFormPassportIds` (`candidateService.js:713`) runs a `to_regclass('public.candidate_form_access')` catalog check on every list request, even though the migration always creates that table.

---

## 7. Database: missing indexes and query problems

Recommended indexes. **Confirm each one with `EXPLAIN (ANALYZE, BUFFERS)` on the real Supabase data before adding it**, since the benefit depends on real row counts.

| # | Index | Helps | Why |
|---:|---|---|---|
| I-1 | `documents (received_date DESC, document_id) WHERE verification_status = 'REVIEW_REQUIRED'` (partial) | `/review`, bell, `/overview` count | The queue filters REVIEW_REQUIRED and sorts by date. Today that means a full scan + sort of `documents` |
| I-2 | `temporary_data (created_date DESC, temporary_id) WHERE pending_storage_path IS NOT NULL` (partial) | `/review`, `/overview`, `/police`, `/clients` pending counts | "Pending file" is the most common filter on this table and has no index |
| I-3 | `temporary_data (passport_id)` | `/clients/:id`, pending groupBy, FK joins | Foreign key without an index |
| I-4 | `audit_logs (action, created_date)` and `audit_logs (passport_id, created_date)` | Daily report upload counts, audit filters, police date history | Only `(admin_id, …)`, `(document_id, …)`, `(temporary_id, …)` exist; the table grows fastest (50,000 rows at 10k candidates) |
| I-5 | `candidate_stages (stage, completed_at)` | Daily summary "finalized today", "visa approved today" | Date filters on stage completion |
| I-6 | `candidate_call_logs (created_date)` | Daily summary calls list and count | Only `(passport_id, created_date)` exists |
| I-7 | `CREATE EXTENSION pg_trgm` + GIN trigram indexes on `candidate(first_name)`, `candidate(other_name)` (and optionally `nic`, `passport_id`) | All name searches, suggestions, documents search | Makes `ILIKE '%term%'` indexable |
| I-8 | `candidate (lower(passport_id))` | Registration duplicate check, `resolveCandidatePassportId` fallback | `mode: "insensitive"` equality cannot use the primary key |

Query problems that an index alone will not fix:

- **B-4:** the WhatsApp lookup should use the existing `candidate_phone_key()` index (change the query, no new index needed).
- **B-5:** `nextUniqueId` reads every row (needs a counter, not an index).
- **RC-1:** the whole-table helpers need SQL `GROUP BY` / `COUNT(*) FILTER (…)` aggregates, or one shared snapshot per request, not more indexes.

---

## 8. Frontend performance

### 8.1 Bundle sizes (production build)

| App | File | Size | Gzip | Loaded |
|---|---|---:|---:|---|
| Admin | `index-*.js` (main) | **1,113.6 KB** | **290.3 KB** | On first visit, every page |
| Admin | `exceljs.min-*.js` | 929.4 KB | 256.4 KB | Lazy (import/export only) ✓ |
| Admin | `jspdf.es.min-*.js` | 392.5 KB | 126.5 KB | Lazy (PDF export) ✓ |
| Admin | `html2canvas-*.js` | 199.5 KB | 46.8 KB | Lazy ✓ |
| Admin | `index-*.css` | 66.9 KB | 12.6 KB | First visit |
| Candidate Form | `index-*.js` | 398.0 KB | 118.2 KB | First visit (candidates on mobile data) |

- The heavy libraries are already lazy-loaded, which is good.
- **No page is code-split:** there is no `React.lazy()` anywhere in `admin/src`, so all ~30 pages ship in one 290 KB-gzip chunk, and Vite warns about chunks over 500 KB. Splitting by route (`React.lazy` per page in the router) would shrink the first load, especially for roles that use only 2–3 pages (REGISTRATION_DESK, JOB_HANDLER).
- Static assets get `Cache-Control: immutable` for one year (`vercel.json`), so repeat visits are cheap.
- The Candidate Form (opened by candidates on phones) is a single 118 KB-gzip chunk. Worth checking what makes up the 398 KB (for example the date picker) with `npx vite-bundle-visualizer`.

### 8.2 Request behaviour

| Behaviour | File | Effect | Status |
|---|---|---|---|
| Bell loads the whole review queue | `NotificationBell.tsx` | Up to 11 sequential requests per load/open; fails above 1,000 | **Bug B-1** |
| Token refresh reloads every resource | `AuthProvider.tsx`, `useAdminResource.ts` | Burst of parallel GETs about once an hour per open tab | Improve: read the latest token at call time instead of listing it as a dependency |
| Add selected is sequential | `JobDetailsPage.tsx:412` | N round trips + N full job reads | Improve: bulk endpoint with per-candidate results |
| Registration uploads 3 files one after another | `CandidateRegistrationPage.tsx` | Upload time = sum of the 3 | Improve: upload in parallel |
| Search box | `CandidateSearchBox.tsx` (250 ms), `AdvancedFilters.tsx` (500 ms), `JobDetailsPage.tsx` (300 ms) | Debounced | ✓ Good |
| Old requests are cancelled | `useAdminResource` (AbortController) | No stale overwrites | ✓ Good |

---

## 9. Production factors not measured here

These add to every number in §4 and are probably a large part of what users feel. **Measure them first on the real deployment.**

1. **Region distance.** Vercel runs the API in **`hnd1` (Tokyo)** (`vercel.json`). If the Supabase project (database **and** Auth) is in another region, every SQL statement and every `auth.getUser` call crosses that distance. Check the Supabase project region in the dashboard. If it is not Tokyo (`ap-northeast-1`), either move the Vercel function region next to Supabase or move Supabase. This is often the **single biggest speed win**, with no code change.
2. **Round trips per request.** Rough production estimate: `local time + Supabase Auth call + (SQL statements ÷ 3 connections) × database round trip`. For example, at a 50 ms round trip:
   - candidate list (10 statements + 2 baseline): about **+200 ms** plus the Auth call;
   - daily summary (31 + 2): about **+550 ms** on top of the 1.37 s measured here.

   These are estimates, not measurements.
3. **Cold starts.** Importing the app modules takes about **370 ms** locally (`src/createApp.js`), before Prisma connects and opens TLS to the database. Every new Vercel instance pays this on its first request.
4. **Connection pool.** `DATABASE_POOL_MAX` defaults to **3 per instance**. A 20-statement `Promise.all` on `/overview` runs in about 7 waves. Also check which Supavisor mode `DATABASE_URL` uses: transaction mode (port 6543) is usually the better fit for serverless than session mode (5432).
5. **Supabase Auth latency.** Not measurable locally. Log its duration for a day to see its share of each request (see §10, step 0).
6. **Background workers.** The submission worker polls every 5 s and the Sheet Sync worker every 10 s. That is light, but it is constant load on the same pooler.

---

## 10. Prioritised fix plan

Ordered by impact for effort. Behaviour for users stays the same unless noted.

| Step | Fix | Fixes | Effort | Expected gain |
|---:|---|---|---|---|
| 0 | Add a request-timing middleware (route pattern, status, duration, SQL count; no personal data) and check the Supabase region vs `hnd1` | Measurement, §9 | Small | Real production numbers; possibly a large win from co-locating regions |
| 1 | Bell: one request for `{ total, newest 20 }` | B-1, B-8, RC-3 | Small | Up to 10 requests and ~11,000 row reads removed per page load; bug fixed |
| 2 | Follow-up bell: count + newest 20, without document status | B-7 | Small | 600–870 KB → a few KB per page load |
| 3 | Daily Report: compute the progress snapshot once per request, share the police counts with the base report, and stop re-reading everything for each "incomplete" expansion | RC-1 | Medium | Summary 1.37 s → a fraction; incomplete 0.94 s → fast |
| 4 | Overview, police, clients, missing documents: SQL aggregates (`GROUP BY` / `COUNT FILTER`) instead of whole-table reads | RC-1 | Medium | Cost no longer grows with the candidate count |
| 5 | Indexes I-1 to I-8 after `EXPLAIN ANALYZE` on real data | §7, RC-4 | Small | Faster review queue, searches, reports and audit filters |
| 6 | WhatsApp lookup through `candidate_phone_key()`; unique ID counter; `lower(passport_id)` index | B-4, B-5 | Small | Registration and webhook lookups become index lookups |
| 7 | Derived Status / Stage filters in SQL or a maintained column | B-2, RC-1 | Medium–Large | 1.1 s → ~50 ms; no 20,000 limit |
| 8 | Frontend: route-level code splitting; stop reloading on token refresh; bulk "Add selected"; parallel registration uploads | §8, RC-3 | Medium | Smaller first load; fewer request bursts |
| 9 | Review queue keyset paging | B-3 | Medium | Every queue item reachable |
| 10 | Remove the per-request `to_regclass` probe; consider Prisma `relationJoins` to cut statements per request | RC-5 | Small | 1 to several fewer round trips per list request |
| 11 | `testTimeout: 20000` for admin tests | B-6 | Tiny | Stable CI |

---

## 11. What was not covered

- **Real production latency:** Supabase Auth, the network between Vercel and Supabase, and cold starts on Vercel. Step 0 above measures these.
- **Supabase Storage:** upload, finalize and review-file preview (the file is downloaded fully into memory, `adminReviewService.js`). These depend on file size and network.
- **WhatsApp webhook and OCR throughput** with real Meta deliveries and real Tesseract (`RUN_OCR_TESTS=1` was not set).
- **Concurrent load:** each request was measured alone. Several users at once, with the 3-connection pool, were not simulated.
- **Browser rendering time:** only bundle sizes and request patterns were checked; no browser profiling.
- **Write endpoints other than registration:** review approve, stage saves, work-allocation writes and job writes. The earlier static audit covers their query counts.

The benchmark script used for §4 was kept outside the repository (no code was changed). It can be added as `scripts/` tooling so the measurements can be repeated after each fix.
