# Candidate Page — Pagination & Performance

**Feature:** Admin > Candidates list, server-side pagination at 100 candidates per page
**Commit:** `99c2d95 feat(candidates): add server-side pagination` (merged into `dev` by `f65fa08`)
**Scope:** the Candidates list only. No schema, migration, RBAC, Call Log, Priority Follow-Up, Google Sheet Sync or document-logic change.

---

## 1. Why

The Candidates page is the main working list for registration, document collection and stage tracking, and the candidate table only grows. Each list row also needs the candidate's stage progress, which is computed from their stages and required documents. The list therefore has to:

- return a bounded number of candidates per request, whatever the table size;
- compute the count in the database, not by loading rows;
- avoid one query per candidate for stages and documents (N+1);
- keep a stable order, so moving between pages never shows a candidate twice or skips one.

## 2. What existed before

The endpoint **already paginated on the server** before this change:

| Aspect | Before | After |
|---|---|---|
| Endpoint | `GET /api/admin/candidates?page=&pageSize=&search=` | unchanged |
| Database paging | `count()` + `findMany({ skip, take })` | unchanged strategy |
| Default page size | 25 | **100** |
| Maximum page size | 100 (400 above) | 100 (400 above), now a named constant `CANDIDATE_LIST_PAGE_SIZE` |
| Page size requested by the page | 25 | **100** |
| Order | `createdDate desc, passportId asc` | unchanged |
| Pagination metadata | `page, pageSize, total, totalPages` | adds `totalItems, hasNextPage, hasPreviousPage` |
| Columns read per candidate | the full candidate detail field set (`userSelect`) | only the 10 fields a row needs (`listSelect`) |
| Previous / Next controls, `?page=` in the URL | yes | yes (unchanged component) |
| Loading while changing page | previous rows stayed, no indicator | rows dimmed + "Loading page…" |
| Page number past the last page | empty list ("No candidates yet") | moves to the last page |
| Scroll on page change | unchanged position | back to the top of the list |

So the change is: 100 per page, explicit pagination metadata, a smaller per-row query, and the edge cases around changing pages. The candidate table was never fetched in full.

## 3. Backend

Files: `src/services/candidateService.js` (`parseCandidateListQuery`, `listCandidates`, `listPagination`), `src/routes/admin.js` (route, unchanged).

### 3.1 Route and roles (unchanged)

```js
router.get("/candidates", requireRole(CANDIDATE_STAFF), ...)
```

`CANDIDATE_STAFF` = ADMIN, MANAGER, ANALYST, REGISTRATION_DESK. Any other role gets `403 { "message": "Insufficient permissions" }`. The role is the signed-in user's, read from the database by the existing middleware.

### 3.2 Query parameters

| Parameter | Default | Valid values | Invalid |
|---|---|---|---|
| `page` | 1 | whole number 1–10000 | `400` `must be a whole number from 1 to 10000` |
| `pageSize` | 100 (`CANDIDATE_LIST_PAGE_SIZE`) | whole number 1–100 | `400` `must be a whole number from 1 to 100` |
| `search` | none | trimmed, at most 100 characters | `400` `must be at most 100 characters` |

- An empty value (`?page=`) counts as not given, so the default applies.
- A parameter given twice (`?page=1&page=2`) is `400` `must be given once`.
- Rejected: `0`, negatives, decimals (`1.5`), non-numbers (`abc`), `pageSize` above 100.
- The error response follows the project's convention: `400 { "message": "Invalid query parameters", "errors": [{ "field", "message" }] }`. Nothing is read from the database for a rejected request.
- A `pageSize` below 100 is still accepted (the Candidates page always sends 100).

### 3.3 Query strategy

```js
const [total, users] = await Promise.all([
    db.candidate.count({ where }),
    db.candidate.findMany({
        where,
        select: {
            ...listSelect,
            stages: { select: { stage: true, completed: true } },
            documents: {
                where: { documentType: { in: REQUIRED_SUBMISSION_DOCUMENTS } },
                select: { documentType: true, verificationStatus: true },
            },
        },
        orderBy: [{ createdDate: "desc" }, { passportId: "asc" }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
    }),
]);
```

- **One `COUNT`** for the total (with the same `where` as the list), run in parallel with
- **one bounded list query**: `LIMIT pageSize OFFSET (page - 1) * pageSize`, at most 100 candidate rows.
- `stages` and `documents` are relations in the same `findMany`. Prisma loads each with **one batched query** (`... WHERE passport_id IN (<this page's IDs>)`), not one per candidate. Per request: 1 count + 1 candidate page + 1 stages batch + 1 documents batch = **4 queries, independent of the number of candidates**.
- Only the required submission document types are read for the progress calculation (`REQUIRED_SUBMISSION_DOCUMENTS`), with two columns each.

**Order.** Newest registration first (`createdDate desc`), with `passportId asc` as the tiebreaker. `passport_id` is the primary key, so the order is total: when the data does not change between requests, adjacent pages never share a candidate and never skip one, including candidates registered at the same instant.

| Page | Rows returned (247 candidates) |
|---|---|
| 1 | positions 1–100 |
| 2 | positions 101–200 |
| 3 | positions 201–247 (47 rows) |
| 4 or more | none (empty `items`, real totals) |

### 3.4 Fields read per candidate (`listSelect`)

```js
const listSelect = {
    passportId: true, uniqueId: true, firstName: true, otherName: true, nic: true, job: true, jobExperience: true,
    whatsappNumber: true, passportIssueDate: true, passportExpiryDate: true,
};
```

These are what a row shows (`candidateSummary`: passport ID, unique ID, name, NIC, job types) and what the stage-progress calculation reads (`automaticStageMissing`). Previously the list read the full detail field set; it no longer reads `address`, `dateOfBirth`, `placeOfBirth`, `contactNumber`, `nationality` or `sex`. The response is unchanged: those fields were never part of a list row. The candidate's own page (`GET /api/admin/candidates/:passportId`) still reads the full record.

### 3.5 Search

`search` is applied in the database `where` (both the count and the page): each word must match passport ID, unique ID, first name, other name, WhatsApp number (with `0…` / `94…` variants for phone-like words) or NIC, case-insensitively. Paging then applies to the matching candidates only, and `totalItems` / `totalPages` count matches.

## 4. API response

```json
{
  "items": [
    {
      "passportId": "N1023757",
      "uniqueId": "0042",
      "name": "Anusha De Soysa",
      "nic": "965404378V",
      "jobTypes": ["Caregiver"],
      "stages": [{ "stage": "TEST_DETAILS", "completed": false }, "... all 7 stages"]
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 100,
    "total": 247,
    "totalItems": 247,
    "totalPages": 3,
    "hasNextPage": true,
    "hasPreviousPage": false
  },
  "filters": {
    "search": null
  }
}
```

| Field | Meaning |
|---|---|
| `page`, `pageSize` | the request's values (after defaults) |
| `total` | number of candidates matching the request; **kept for existing callers** (the shared `Pager` component reads it) |
| `totalItems` | same value as `total` |
| `totalPages` | `max(1, ceil(totalItems / pageSize))`, so an empty list is page 1 of 1 |
| `hasNextPage` | `page < totalPages` |
| `hasPreviousPage` | `page > 1` |

The change is additive: no field was removed or renamed. The only consumer of this endpoint is the Candidates page (`admin/src/api/candidates.ts` `listCandidates`).

**A page past the last one** returns `200` with `items: []` and the real totals (for 247 candidates, `?page=4` gives `totalPages: 3`, `hasNextPage: false`, `hasPreviousPage: true`), so the client can move back.

## 5. Frontend

Files: `admin/src/pages/CandidatesPage.tsx`, `admin/src/api/candidates.ts` (type only). The table, its columns, the search box, *Add candidate* and row behaviour are unchanged.

| Behaviour | Implementation |
|---|---|
| Page size | `PAGE_SIZE = 100`; every request sends `page` and `pageSize=100` |
| Controls | the existing shared `Pager` (`components/ClientTable.tsx`, also used by Clients and Missing Documents, not modified): "N candidates", **Previous**, **Page X of Y**, **Next**. Previous is disabled on page 1, Next on the last page |
| URL state | the page lives in the query string (`/admin/candidates?page=2`); reload, Back and Forward keep it. An invalid `?page=` value in the URL is read as page 1 |
| Search | submitting a search replaces the query string with `?search=…` only, so it starts at page 1; search stays server-side |
| First load | the existing `LoadingState` ("Loading candidates…") |
| Changing page | the current rows stay visible, dimmed (`opacity-60`, `aria-busy="true"`), with a "Loading page…" status line until the next page arrives; then the list scrolls back to its top |
| Error | the existing `ErrorState` with **Try again**; rows from an earlier page or search are never shown under an error (also while retrying) |
| Empty | the existing `EmptyState`: "No candidates yet", or "No candidates match this search" with *Clear search* |
| Page past the last one | when the server returns no rows for a page greater than `totalPages` while candidates exist (a stale link, or the last page emptied by a removal), the page replaces the URL with the last existing page (`replace: true`, so Back doesn't return to the empty page) and shows the loading state meanwhile, never "No candidates yet" |
| Rows | link and row click still open `/admin/candidates/:passportId` from any page |
| Roles | unchanged: *Add candidate* for ADMIN, MANAGER, ANALYST, REGISTRATION_DESK; the backend remains the authority |

The page holds only the current page's rows; no part of it assumes the whole list is loaded.

## 6. Performance

| Measure | Value |
|---|---|
| Candidates read for page 1 | 100 (or fewer if fewer exist) |
| Candidates read for page 2 | the next 100 (`skip: 100, take: 100`) |
| Total count | one database `COUNT(*)` with the same filter; no rows loaded to count |
| Queries per request | 4 (count, candidate page, stages batch, documents batch), constant |
| N+1 | none: stages and documents are loaded once per page with `IN (...)` |
| Columns per candidate row | 10 candidate columns, plus stage (2 columns) and required-document (2 columns) rows |
| Rows per request (before → after) | up to 25 → up to 100 per page; fewer page changes for the same list |

No index was added. Ordering by `candidate.created_date` (with the primary key as tiebreaker) sorts within PostgreSQL. At the current table size that is not a demonstrated bottleneck; see §9.

## 7. Edge cases

| Case | Behaviour |
|---|---|
| 0 candidates | `items: []`, `totalItems: 0`, `totalPages: 1`, no next/previous; page shows "No candidates yet" |
| Exactly 100 | one page; Next disabled |
| 101 | two pages; page 2 holds one candidate (the oldest) |
| Last page with fewer than 100 | only the remaining rows (e.g. 47 of 247) |
| Page past the last one | API: empty page with real totals; UI: moves to the last page |
| Last page emptied by a removal | same as above (e.g. 101 → 100 candidates while on page 2 → page 1) |
| Invalid / repeated / too-large parameters | `400 Invalid query parameters` with field errors; no database read |
| Network or API error | error state with Try again; no stale rows |
| Candidates registered at the same instant | ordered by passport ID; still no overlap between pages |

## 8. Tests

**Backend** — `test/candidateListPagination.test.js` (12 tests). On a real PostgreSQL (PGlite with every migration) through the real Prisma client and admin router, with **247 generated candidates** (every tenth shares its predecessor's registration time, to exercise the tiebreaker):

- default request = page 1 = the first 100, newest first;
- pages 1/2/3 return 100/100/47; no candidate on two pages; together exactly the full list in order;
- pagination metadata for each page (`total`, `totalItems`, `totalPages`, `hasNextPage`, `hasPreviousPage`);
- a page past the last one: empty with real totals;
- `page=0`, `-1`, `abc`, `1.5`, `10001`, `pageSize=101`, `1000`, `0`, repeated `page` → 400; blank values fall back to the defaults;
- search pages over matches only;
- the service issues exactly one `count` and one `findMany` with `take: 100`, `skip: 100` for page 2, reads 100 rows, keeps the order, and does not select detail-only fields;
- list rows keep their shape (name, NIC, job types, all 7 stages);
- roles: the four candidate roles get 200; others 403;
- 0, exactly 100, 101 candidates; a last page emptied by a removal.

Existing `test/candidates.test.js` (list, search, stage progress) passes unchanged.

**Frontend** — `admin/src/test/candidatePagination.test.tsx` (12 tests), with a stub backend that pages like the real one:

- page 1 loads only the first 100; "Page 1 of 3", "247 candidates"; Previous disabled;
- Next loads page 2 and page 3 (47 rows, Next disabled); Previous returns to page 1; each step requests only that page;
- `?page=2` opens page 2 directly;
- the dimmed "Loading page…" state while a page loads; the first-load loading state;
- API error state without stale rows, then Try again;
- empty state; exactly 100 and 101 candidates;
- a page past the last one moves to the last page;
- search requests page 1 with `pageSize=100`;
- from page 2, the name link and a row click open the candidate;
- *Add candidate* shown for a candidate role, not for the retired VIEWER role.

`admin/src/test/candidates.test.tsx` was updated only where it asserted the old page size (`pageSize=25` → `100`).

At the time of the commit: backend suite 1455 passed / 0 failed; frontend 350 passed (19 files); typecheck and production build clean; `prisma validate` clean (schema unchanged).

## 9. Known limitations

- **List progress for Document submission (pre-existing, not changed here).** The list's documents relation does not select `documentVariant`, so the police-report variant check in `automaticStageMissing` never matches in the list. A candidate's *Document submission* stage can therefore show as incomplete in the list while their own page (which reads the variant) shows it complete. Fixing it is one field in the list's `documents.select`; it was left out because it changes what the list displays.
- **Offset paging.** `OFFSET` cost grows with the page number, and if candidates are registered or removed between two page requests, a row can shift across the page boundary (seen twice, or not at all, while paging). Within a stable dataset the order is exact.
- **No index on `candidate.created_date`.** PostgreSQL sorts the (filtered) candidate table for each page. Fine at the current size.
- **Count on every request.** `COUNT(*)` scans the matching candidates each time; cheap at the current size.
- **Fixed page size.** There is no page-size selector (by design); the API accepts 1–100 but the page always asks for 100.
- **Search is `contains` / case-insensitive** (`ILIKE '%…%'`), which can't use a normal B-tree index; it is unchanged by this feature.

## 10. Future optimisations

Only if the candidate count or response times show a need:

1. **Index for the list order:** `CREATE INDEX ON candidate (created_date DESC, passport_id ASC)` (a Prisma migration with `@@index([createdDate(sort: Desc), passportId])`) lets PostgreSQL read a page in order instead of sorting.
2. **Keyset (cursor) pagination:** `WHERE (created_date, passport_id) < (:lastCreated, :lastPassport) ORDER BY ... LIMIT 100` makes every page equally cheap and immune to inserts between requests (would replace page numbers with next/previous cursors).
3. **Trigram index for search:** `pg_trgm` GIN indexes on the searched columns make `ILIKE '%…%'` indexable.
4. **Cheaper total:** cache or estimate the total for very large unfiltered lists.
5. **Fix the list's document-submission progress** (§9) by adding `documentVariant: true` to the list's documents select.

## 11. Files

| File | Change |
|---|---|
| `src/services/candidateService.js` | `CANDIDATE_LIST_PAGE_SIZE = 100`, default page size 100, `listSelect`, `listPagination` (adds `totalItems`, `hasNextPage`, `hasPreviousPage`) |
| `admin/src/pages/CandidatesPage.tsx` | `PAGE_SIZE = 100`, page-change loading state, scroll to list top, move past-the-end pages to the last page |
| `admin/src/api/candidates.ts` | `CandidateList.pagination` type gains the optional new fields |
| `test/candidateListPagination.test.js` | new backend tests (PGlite, 247 candidates) |
| `admin/src/test/candidatePagination.test.tsx` | new frontend tests |
| `admin/src/test/candidates.test.tsx` | page size expectations 25 → 100 |
