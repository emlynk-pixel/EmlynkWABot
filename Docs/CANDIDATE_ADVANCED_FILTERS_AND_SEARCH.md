# Candidate Advanced Filters & Search

**Feature:** Admin > Candidates and Admin > Work Allocation (Unallocated / Allocated): a **Filters** button (choose which filters to use) with each chosen filter as a dropdown under the search bar (many filters combined), improved full-name search and live search suggestions.
**Scope:** candidate lists only. Filtering is done **on the server, before paging**, always inside the user's candidate scope. One additive index migration; no column, RBAC tier or stored data changes.

---

## 1. Summary

| What | Where it runs |
|---|---|
| Quick search (name, passport, NIC, WhatsApp / contact number) | Backend (database `WHERE`) |
| Advanced filters (identity, job type, Status, stage, dates, officer, allocation, client, agent, job code) | Backend (database `WHERE`; Status / stage / exact job type derived on the server, see §5.3) |
| Search suggestions while typing | Backend (`GET /api/admin/candidate-suggestions`) |
| Filters box, filter dropdowns, URL state, debounce | Frontend (UI only; it never filters rows) |

Order of work on every list request:

```text
DB → RBAC scope → Work Allocation view (if any) → quick search → advanced filters → COUNT → sort → page → response
```

The totals and page count are always those of the whole filtered list. The browser never loads all candidates.

## 2. Architecture

One filter engine is shared by every candidate list. There is no second query path.

| Piece | File | Role |
|---|---|---|
| Filter allow-list, parser, `where` builder, role access, filter options | `src/services/candidateListFilters.js` | `parseCandidateFilters`, `candidateFilterWhere`, `derivedFilterMatch`, `filterAccess`, `listCandidateFilterOptions` |
| Shared paging (plain and derived path) | `src/services/candidateService.js` | `pageCandidates`, `CANDIDATE_LIST_ORDER`, `MAX_DERIVED_FILTER_CANDIDATES` |
| Candidates list | `src/services/candidateService.js` | `parseCandidateListQuery`, `listCandidates` |
| Work Allocation list | `src/services/workAllocationService.js` | `parseAllocationListQuery`, `listAllocationCandidates` |
| Suggestions | `src/services/candidateService.js` | `parseSuggestionQuery`, `listCandidateSuggestions`, `suggestionRank` |
| Search normalisation | `src/utils/searchText.js` | `normalizeSearchText`, `searchTokens` |
| Visibility scope (unchanged) | `src/services/candidateAccess.js` | `candidateScope`, `andWhere` |

The business filters (`candidateFilterWhere`) are built **separately** from authorisation and AND-ed with it (`andWhere(scope, view, search, filters)`), never spread into it, so a filter can only narrow a list.

## 3. API

### 3.1 Endpoints

| Endpoint | Roles | Purpose |
|---|---|---|
| `GET /api/admin/candidates` | ADMIN (OWNER), TEAM_LEAD, ANALYST, JOB_HANDLER | Candidates list, now with the advanced filters |
| `GET /api/admin/work-allocation/candidates` | ADMIN (OWNER), TEAM_LEAD | Work Allocation list, same filters (no `allocation`: the view decides) |
| `GET /api/admin/candidate-filter-options` | same as `/candidates` | Dropdown choices, limited to the filters the role may use |
| `GET /api/admin/candidate-suggestions` | same as `/candidates` | Search-box suggestions |

REGISTRATION_DESK still has no access to any of them (403).

### 3.2 Filter parameters

Flat query parameters, matching the project's existing list convention. Every filter is optional, and every one given is AND-ed with the others.

| Kind | Parameters | Values |
|---|---|---|
| Text | `name`, `surname`, `otherNames`, `passport`, `nic`, `whatsapp`, `nationality`, `jobCode` | up to 100 characters; any letter case |
| Text operator | `<field>Match` | `contains` (default), `startsWith`, `equals`. `name` takes `contains` only; `nationality` and `jobCode` take `contains` / `equals` |
| Multi-select (IN) | `jobType`, `workflowStatus`, `stage`, `sex`, `analystId`, `clientId`, `agentId` | comma-separated, at most 50 values |
| Single | `allocation` | `ALLOCATED` \| `UNALLOCATED` (Candidates only) |
| Date range | `registeredFrom`, `registeredTo`, `testFrom`, `testTo` | `YYYY-MM-DD`, inclusive; From only, To only, or both |

Examples:

```text
GET /api/admin/candidates?jobType=Steel%20Fixer,Welder&registeredFrom=2026-11-01&registeredTo=2026-11-30
GET /api/admin/candidates?surname=perera&passport=PN&passportMatch=startsWith&workflowStatus=VISA_SUBMITTED
GET /api/admin/work-allocation/candidates?status=ALLOCATED&analystId=u-1,u-2&jobType=Welder
```

### 3.3 What each filter matches

| Filter | Column / rule |
|---|---|
| `name` | every word in `first_name` (other names) **or** `other_name` (surname) |
| `surname` / `otherNames` | `other_name` / `first_name` |
| `passport`, `nic`, `nationality` | `passport_id`, `nic`, `nationality` |
| `whatsapp` | `whatsapp_number` in any stored form: `+94…`, `94…`, `0…` |
| `jobType` | one of the candidate's job types, exact name (any case). `WELDER` is not `WELDER TIG`. "No Preferred Type" is one of the choices |
| `workflowStatus` | the Candidates list's derived Status (`candidateWorkflowStatus.js`) |
| `stage` | the current stage (first not completed), or `COMPLETE` |
| `sex` | `M`, `F`, `X` |
| `registeredFrom` / `registeredTo` | `candidate.created_date`, Sri Lanka calendar days (§6) |
| `testFrom` / `testTo` | the Test details stage's `test_date` (a DATE column) |
| `allocation` / `analystId` | `candidate_allocation` (none / any / these officers) |
| `clientId`, `agentId`, `jobCode` | the candidate's **current** job (an active `job_candidate`): its client, responsible agent, job code |

**Status vs Current stage:** these are different concepts, so both are offered. Status is the workflow ladder (Registered → … → Visa Submitted → Departed, with Stopped with Test as an override). Stage is the first deployment stage not yet completed.

### 3.4 Validation

- An allow-list only: a filter name never reaches Prisma. Each condition is written against a fixed column.
- A listed filter with a bad value returns `400 { "message": "Invalid query parameters", "errors": [{ "field", "message" }] }` before anything is read. Examples: an unknown operator, an invalid date, `From` after `To`, an unknown Status or stage, a malformed ID, more than 50 values, or the parameter given twice.
- An unknown parameter is **ignored**, the list endpoints' existing convention.
- A filter the role may not use returns `400 "is not available for your role"` (§4).

### 3.5 Response

Unchanged shape (`items`, `pagination`, `filters`). `filters` echoes the applied values. Work Allocation keeps its earlier keys (`status`, `analystId`, `search`, `registeredFrom`, `registeredTo`, `jobType`, `workflowStatus`, `stage`, `null` when not set) plus any other filter given.

## 4. RBAC

The visibility scope stays authoritative and is applied in the database on every request.

| Role | Candidates it can filter | Officer / Allocation filters | Client / Agent filters |
|---|---|---|---|
| OWNER, ADMIN | all | yes | yes |
| TEAM_LEAD | all | yes | yes |
| ANALYST | **only their allocated candidates** | no (400) | no (400) |
| JOB_HANDLER | all (read only, as before) | no (400) | yes |
| REGISTRATION_DESK | no Candidates list (403) | no | no |

- An Analyst's results **and totals** come only from their own allocation. If a filter matches 300 candidates globally and 2 of theirs, they see 2.
- `/candidate-filter-options` returns officers only to ADMIN / TEAM_LEAD (id, name, active; no email), and clients / agents only to ADMIN / TEAM_LEAD / JOB_HANDLER. An Analyst gets job types only.
- The Work Allocation route also passes the user's scope. It is empty for its roles, but it is AND-ed all the same.

## 5. Backend query design

### 5.1 Plain path (most filters)

```js
// where = andWhere(scope, view, search, candidateFilterWhere(filters))
const [total, rows] = await Promise.all([
    db.candidate.count({ where }),
    db.candidate.findMany({ where, select, orderBy: CANDIDATE_LIST_ORDER, skip: (page - 1) * pageSize, take: pageSize }),
]);
```

One `COUNT`, one bounded page query, with relations batched by Prisma: no N+1, no per-row officer / job / client lookup.

### 5.2 Order

Unchanged: `created_date DESC, passport_id ASC` (`CANDIDATE_LIST_ORDER`). The order is total, so no candidate appears on two pages and none is skipped.

### 5.3 Derived path (`jobType`, `workflowStatus`, `stage`)

These values are not stored columns (job types are a comma-separated text; Status and stage are computed).

1. The database pre-filters with every other condition (and a `contains` pre-filter for job types).
2. If more than `MAX_DERIVED_FILTER_CANDIDATES` (20,000) rows remain, the request is refused with `422 TOO_MANY_TO_FILTER` ("add a date range or a search").
3. The remaining rows are read with only what the derived filters need (`passport_id, job` for a job-type-only filter; the Status signals otherwise) and matched exactly, on the server.
4. The page is cut from the matching list and read with the full row select.

The total is still that of the whole filtered list. This path was already used by Work Allocation and is now shared by both lists.

## 6. Dates and time zone

Registered date is a timestamp. A day means a **Sri Lanka calendar day** (`Asia/Colombo`, UTC+5:30; `utils/businessDay.js`):

```text
registeredFrom=2026-11-01  →  created_date >= 2026-10-31T18:30:00Z  (Nov 1 00:00 Sri Lanka)
registeredTo=2026-11-30    →  created_date <  2026-11-30T18:30:00Z  (Dec 1 00:00 Sri Lanka)
```

So a candidate registered at 23:30 on 30 November Sri Lanka time **is** included in `2026-11-01 → 2026-11-30`. UTC midnight boundaries are never used. Test date is a DATE column, compared as calendar days (`>= from`, `<= to`).

Verified boundaries: 23:59 Oct 31 is out; 00:00 Nov 1 is in; 23:30 and 23:59:59 Nov 30 are in; 00:00 Dec 1 is out. From only, To only and a single day all behave inclusively.

## 7. Full-name search

Names are stored in two columns: `first_name` (other / given names) and `other_name` (surname). The display name is `first_name + " " + other_name`.

**Normalisation** (`src/utils/searchText.js`, one helper for quick search, the Full name filter and suggestions):

```text
"  NIMAL   PERERA  "  →  "nimal perera"   (trim, collapse whitespace, lowercase)
```

Stored names are never changed. Matching is case-insensitive in the database too.

**Token logic:** the text is split into words (at most 5). Every word must match somewhere, and each word may match a **different** column, in any order. For a candidate with other names `NIMAL PERERA` and surname `SILVA`, all of these match: `nimal`, `NIMAL`, `perera`, `silva`, `nimal perera`, `Perera Silva`, `NIMAL SILVA`, `silva nimal`, `nimal perera silva`.

Quick search words also match passport ID, unique ID, NIC, WhatsApp and contact numbers (with the `0…` / `94…` phone variants), exactly as before.

## 8. Search suggestions

`GET /api/admin/candidate-suggestions?q=nim[&allocation=ALLOCATED|UNALLOCATED]`

| Rule | Value |
|---|---|
| Minimum length | 2 characters. Shorter: `{ "items": [] }`, nothing read |
| Debounce (browser) | 250 ms after the last key; the previous request is aborted |
| Result size | at most 8 (`SUGGESTION_LIMIT`) |
| Fields returned | `passportId`, `name`, `nic`: what the list already shows |
| Scope | the list's own search AND the user's scope AND (Work Allocation) the view |
| `allocation` | ADMIN / TEAM_LEAD only; an Analyst gets 400 |

**Query:** two bounded reads (50 rows each), merged:

1. candidates whose name word, passport or NIC **starts with** the first word, so a strong older match is never pushed out by many newer weak ones;
2. the newest candidates matching the search.

**Ranking** (lower first; ties by name, then passport):

| Rank | Rule | `nim` example |
|---|---|---|
| 0 | the full name starts with the text | Nimal Perera Silva, Nimesh Fernando |
| 1 | every typed word starts a word of the name | Kamal Nimalasiri |
| 2 | passport or NIC starts with the text | NIM1234567 |
| 3 | any other match (substring) | Dinim Perera |

No fuzzy-search library is used.

## 9. Frontend

| Piece | File |
|---|---|
| Filter definitions, the list of addable filters, chip text, options API | `admin/src/api/candidateFilters.ts` |
| Filters button, filter bar and dropdowns | `admin/src/components/AdvancedFilters.tsx` |
| Search box with suggestions (ARIA combobox) | `admin/src/components/CandidateSearchBox.tsx` |
| Pages | `admin/src/pages/CandidatesPage.tsx`, `admin/src/pages/WorkAllocationPage.tsx` |

### 9.1 Filters: choose, then use

1. The **Filters** button (next to the search box) opens a small box listing the filters that can be added, grouped Candidate (Job type, Status, Current stage, Sex, Nationality, Registered date, Test date) / Allocation (Allocation, Officer) / Current job (Current job code, Client, Agent). Name, passport, NIC and WhatsApp lookups are not offered: the **search box** does them. Ticking one adds it to the page; unticking removes it and clears its value. Nothing is sent to the server while choosing.
2. Each added filter is a button **under the search bar** (e.g. `Job type ▾`). Clicking it opens a dropdown with only that filter's control:
   - lists (Job type, Status, Current stage, Sex, Officer, Client, Agent): checkboxes;
   - text (Nationality, Current job code): a match type (Contains / Starts with / Is exactly) and the text;
   - dates (Registered, Test): From / To pickers;
   - Allocation (Candidates page only): a select.
3. There is **no Apply button**. A pick applies at once (one request, page 1). Typed text applies after a short pause (500 ms) or on Enter; the match type applies as soon as there is text.
4. The button shows the selection (`Job type: Steel Fixer, Welder`, `Registered: 1 Nov 2026 – 30 Nov 2026`); its × removes only that filter. **Clear all filters** removes them all (the quick search stays).
5. The identity parameters (`name`, `surname`, `otherNames`, `passport`, `nic`, `whatsapp`) are still accepted by the server and in the URL, so an older link keeps working: such a filter is shown as a button with a x (and Clear all removes it), it is just not in the box.
6. Added filters stack and wrap. A filter with a value is always shown, so a reload or a shared link restores the stack; an added filter with no value yet is only on screen (not in the URL).

Escape closes a box or dropdown (focus back on its button); so does a click outside (a click in a date picker's calendar does not).

- The Filters button shows the number of filters with a value ("Filters (3 active)").
- The box lists only what the role may use: Officer / Allocation for ADMIN and TEAM_LEAD, Client / Agent for ADMIN, TEAM_LEAD and JOB_HANDLER.
- Work Allocation: no Allocation filter (the view is the allocation). The Officer filter appears on **Allocated** only. The header's Analyst select still works and shows "N Analysts (Filters)" when several are chosen.

### 9.2 States

- "N candidates match the filters (all pages)" uses the server's total.
- With filters and no rows: **"No candidates match the selected filters."**, with a Clear filters action (not "No candidates yet").
- Loading: the current rows stay, dimmed, with "Loading page…".

### 9.3 Search box

- Suggestions appear after 2 characters. Each shows the name, then the passport and NIC.
- Arrow Down / Up move (wrapping), Enter picks, Escape closes; a mouse click works too.
- Picking a suggestion puts its name in the box and runs the **normal list search** (the list endpoint is never bypassed), keeps the advanced filters, and goes to page 1.
- Enter with nothing highlighted is a plain search, as before. If the suggestion request fails, the box still works as a plain search.

### 9.4 URL state

Search, filters and page live in the URL, so a refresh, Back and Forward keep them; paging keeps the filters. Any new search or filter change resets to page 1. Work Allocation keeps its earlier parameter names so old links still work: `from`, `to`, `wstatus`, `analyst` (= `registeredFrom`, `registeredTo`, `workflowStatus`, `analystId`).

### 9.5 Accessibility

- The Filters button has an accessible label with the active count and `aria-expanded`.
- The box and each dropdown are labelled groups of native checkboxes, selects and inputs (keyboard operable); Escape closes and returns focus to the button.
- A filter's remove button is labelled "Remove filter: …".
- The search box is a combobox with `aria-expanded` and `aria-activedescendant`.

## 10. Performance

- No full-table load: every list request is one count plus one bounded page (plain path), or the bounded derived path (§5.3).
- **New index** (migration `20261107120000_candidate_created_date_index`, additive, `IF NOT EXISTS`):

  ```sql
  CREATE INDEX IF NOT EXISTS "candidate_created_date_passport_id_idx" ON "candidate"("created_date" DESC, "passport_id" ASC);
  ```

  It serves the list order (every page) and the Registered date range. Before it, `candidate.created_date` had no index.
- Suggestions: two queries of at most 50 rows per pause in typing.
- `contains` / ILIKE over name, passport and NIC cannot use B-tree indexes. At today's size (thousands of candidates) a scan is fast; a local run with 265 candidates and every filter answered in at most about 160 ms. A trigram index (`pg_trgm` on `first_name`, `other_name`, `passport_id`, `nic`) would help at tens of thousands of candidates. It is **not** added; add it only if search response times grow.

## 11. Not filterable (by decision)

| Field | Why |
|---|---|
| Job sector | not in the schema |
| Additional Details fields | each would need an extra join; not added without a specific need |
| Preferred / Not preferred type | covered by Job type ("No Preferred Type" is one of its choices) |

## 12. Tests

| File | What it covers |
|---|---|
| `test/advancedCandidateFilters.test.js` | 30 tests, real PostgreSQL (PGlite) + real router: each filter, AND combinations, search + filters, pagination and totals, no results, validation and unknown parameters, case, inclusive date boundary, multi-select, RBAC (Analyst scope, TEAM_LEAD, ADMIN/OWNER, REGISTRATION_DESK, JOB_HANDLER), filter options per role, Work Allocation views and officer filter |
| `test/candidateNameSearch.test.js` | 18 tests: normalisation; name parts (first, surname, middle, two, three, across columns, any order); case and spacing; no match; with filters; pagination; passport / NIC / phone still found; Work Allocation; Analyst scope; suggestions (minimum length, partial names, case, limit, ranking, scope, views) |
| `admin/src/test/advancedFilters.test.tsx` | 16 tests: the Filters box and focus, adding a filter, each pick applied at once with the exact parameters, stacked filters (text pause / Enter, match type, dates), URL restore, remove one, untick, Clear all, page reset, search + filters, paging keeps filters, loading, no results, Work Allocation views, filters offered per role |
| `admin/src/test/candidateSearchSuggestions.test.tsx` | 6 tests: minimum length and debounce, dropdown content, click, keyboard, Escape, filters kept and page 1, Work Allocation view |
| `admin/src/test/adminPanelEnhancements.test.tsx` | the Work Allocation filter test, updated for the Filters box and dropdowns |

Commands: `npx prisma validate`, `npm test`, `npm --prefix admin run typecheck`, `npm run admin:test`, `npm run admin:build`.

## 13. Files

**Backend:** `src/services/candidateListFilters.js` (new), `src/utils/searchText.js` (new), `src/services/candidateService.js`, `src/services/workAllocationService.js`, `src/services/adminClientService.js`, `src/routes/admin.js`, `prisma/schema.prisma`, `prisma/migrations/20261107120000_candidate_created_date_index/migration.sql` (new).

**Frontend:** `admin/src/api/candidateFilters.ts` (new), `admin/src/components/AdvancedFilters.tsx` (new), `admin/src/components/CandidateSearchBox.tsx` (new), `admin/src/api/candidates.ts`, `admin/src/api/workAllocation.ts`, `admin/src/components/Icon.tsx`, `admin/src/pages/CandidatesPage.tsx`, `admin/src/pages/WorkAllocationPage.tsx`.

## 14. Known limitations

- Suggestions use the search text, scope and Work Allocation view only, not the other active advanced filters. A suggested candidate may therefore be excluded by those filters once picked.
- Searches use at most the first 5 words.
- A derived filter (job type, Status, stage) over more than 20,000 pre-filtered candidates is refused with a message to narrow the list.
- The UI was verified by automated tests (jsdom) and the API against a running local server. A browser pass (layout at narrow widths, console) was not part of the automated checks.
