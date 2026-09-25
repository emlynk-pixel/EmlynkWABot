# Phase 10 — Admin Dashboard

Status: **Checkpoint 3 implemented (not yet committed; migration not yet applied to the live database).**

| Checkpoint | Scope | Status |
|---|---|---|
| 1 | Frontend scaffold, admin login, route guard, dashboard shell | Done (`d0d7323`) |
| 2 | Read-only admin API (`/api/admin`), Overview, Documents, Client Details | Done (`90a0d6e`) |
| 3 | Review data migration, Review Queue, read-only Review Detail with secure file preview | Implemented |
| 4 | Review actions (approve / reject / keep pending) with audit log | Planned |
| 5 | Police Workflow (full version needs Phase 9 data) | Planned |

Not built yet: review actions (approve / reject / keep pending — the buttons are shown disabled), audit log, uploads, exports, WhatsApp messaging, Settings, client editing, batch actions, the Clients list page, and anything from Phase 9 (21-day countdown).

Visual source of truth: Stitch project **EmlynkWABot Admin Dashboard UI** (`13688778730186190970`), design system **Precision Enterprise Console**. The Stitch project is read-only for development; nothing is generated or changed there from the code.

## 1. Structure

The dashboard is a separate frontend in `admin/` with its own `package.json`. The backend serves its build under `/admin` (same origin as the API).

```text
admin/
├── index.html                # App entry (base path /admin/)
├── vite.config.ts            # Vite + React + Tailwind; dev proxy; Vitest config
├── tsconfig.json
├── public/favicon.svg
└── src/
    ├── main.tsx              # BrowserRouter (basename /admin) + AuthProvider
    ├── App.tsx               # Routes
    ├── index.css             # Tailwind + Stitch design tokens (@theme)
    ├── api/
    │   ├── client.ts         # fetch wrapper, ApiError, safe error messages
    │   ├── auth.ts           # POST /auth/login, GET /auth/me
    │   ├── admin.ts          # typed /api/admin calls and response types
    │   └── useAdminResource.ts  # loading/error/retry; 401 -> sign out
    ├── auth/
    │   ├── AuthProvider.tsx  # session state, sign in/out, expiry timer
    │   ├── RequireAuth.tsx   # route guard
    │   └── tokenStorage.ts   # JWT in sessionStorage (+ memory fallback)
    ├── layout/
    │   ├── AdminLayout.tsx   # shell: sidebar + header + content
    │   ├── Sidebar.tsx       # dark sidebar, 240px, collapsible to 64px rail, mobile drawer
    │   ├── Header.tsx        # 56px utility bar: breadcrumb, admin, sign out
    │   └── navigation.ts     # sidebar entries
    ├── components/           # Icon, StatusBadge, Confidence, DocumentsTable, States (loading/error/empty), format
    ├── pages/                # Login, Overview, Documents, ClientDetails, placeholders, not found
    └── test/                 # Vitest + Testing Library tests
```

Backend files for the dashboard:

| File | Purpose |
|---|---|
| `src/adminFrontend.js` | Serves `admin/dist` under `/admin` (Checkpoint 1) |
| `src/middleware/requireActiveAdmin.js` | Shared check for `/api/admin`: valid JWT + admin exists and is ACTIVE |
| `src/routes/admin.js` | Read-only `/api/admin` routes, parameter validation, JSON errors |
| `src/services/adminDashboardService.js` | Prisma queries and response shaping |
| `src/utils/businessDay.js` | Sri Lanka business-day boundaries (`Asia/Colombo`) |
| `src/services/reviewReason.js` | Review reason codes (Checkpoint 3) |
| `src/services/adminReviewService.js` | Review Queue / Review Detail queries and the file lookup (Checkpoint 3) |
| `src/utils/clientName.js` | Client display name (shared) |
| `src/createApp.js` | Mounts `/admin` and `/api/admin` (injectable routers for tests) |

`/auth/login`, `/auth/me`, the WhatsApp webhook and document processing are unchanged. The `ACTIVE_ADMIN_STATUS` constant now lives in the shared middleware and is re-exported by `src/routes/auth.js`, so existing imports keep working.

## 2. Routes

| Route | Page | Stitch screen | Checkpoint 1 |
|---|---|---|---|
| `/admin/login` | Sign in | — (built from the design system) | Working |
| `/admin/` | Overview | Overview Dashboard | Real data (Checkpoint 2) |
| `/admin/documents` | Documents | Documents Directory | Real data (Checkpoint 2) |
| `/admin/clients/:passportId` | Client details | Client Details | Real data (Checkpoint 2) |
| `/admin/review` | Review Queue | Review Queue | Real data (Checkpoint 3) |
| `/admin/review/:id` | Review detail | Document Review Detail | Real data, actions disabled (Checkpoint 3) |
| `/admin/clients` | Clients list | — | Placeholder; clients are opened from Documents/Overview |
| `/admin/police` | Police Workflow | Police Workflow | Placeholder (Checkpoint 5 / Phase 9) |

Every route except `/admin/login` is behind the route guard. Settings, global search, Sync and Export from the design are not built yet.

## 3. Authentication flow

Uses the existing backend endpoints unchanged (`src/routes/auth.js`).

1. **Sign in:** the login form sends `POST /auth/login` `{ email, password }`. On success the backend returns a JWT (HS256, 1 hour).
2. **Validate:** the app immediately calls `GET /auth/me` with `Authorization: Bearer <token>`. Only then is the admin signed in; the token is stored and the admin's name and role are shown in the header.
3. **Reload / new visit in the same tab:** a stored token is checked again with `GET /auth/me`. If the backend rejects it (expired, admin deactivated, bad token) or cannot be reached, the token is removed and the login page is shown.
4. **Expiry:** the app reads the token's `exp` and signs out when it passes. An already-expired stored token is dropped without calling the backend.
5. **Sign out:** removes the token and returns to the login page. (The backend has no logout endpoint; the token simply expires.)
6. **Route guard:** while a stored token is being checked, a "Checking your session" screen is shown; without a valid session every protected route redirects to `/admin/login`, which returns to the requested page after sign-in (only paths inside the app are followed).

Error messages: the backend's own short messages are shown for 4xx responses ("Invalid email or password", the rate-limit message); 5xx and network errors show a fixed generic text, never backend details.

**Token storage (this checkpoint):** `sessionStorage` — survives reloads of the tab, is removed when the tab closes, is not shared between tabs and is never sent automatically. If storage is blocked, an in-memory copy keeps the current tab working. Because JavaScript can read it, it relies on the Content Security Policy (scripts from the same origin only) against XSS. Moving to an httpOnly cookie is planned for **Phase 12**.

The first admin account is created with `npm run admin:create` (see `Docs/13-security-overview.md`).

## 4. Admin API (`/api/admin`, read-only)

### Authentication middleware

`createRequireActiveAdmin()` (`src/middleware/requireActiveAdmin.js`) runs before every `/api/admin` route:

1. the existing `authenticateAdmin` checks the Bearer JWT (HS256 only; missing → 401 "Authentication Token is required!", invalid/expired → 401 "Invalid or Expired Token");
2. the admin named in the token is loaded (profile fields only, never the password hash). If it no longer exists **or** its status is not `ACTIVE`, the answer is the same 401 "Invalid or Expired Token" — a deactivation takes effect on the next request, without saying why.

This is the same rule `GET /auth/me` applies; `/auth/me` itself is unchanged (a deleted admin still gets its existing 404 there). A database error is passed to the error handler (generic 500). Every `/api/admin` response has `Cache-Control: no-store`.

Errors are JSON: `{ "message": "…" }`, with `errors: [{ field, message }]` for invalid parameters (400). Unknown paths under `/api/admin` return 404 `{ "message": "Not found" }` (after authentication).

### Data sources

| Table | Meaning on the dashboard |
|---|---|
| `documents` | Files stored in a client folder. `processing_status` is `STORED`; `verification_status` is `VERIFIED` or `REVIEW_REQUIRED`. |
| `temporary_data` | Every received WhatsApp submission and its pipeline outcome (`VERIFIED` … `UNDEFINED`, `MANUAL_REVIEW`, `CONFLICT`, `DUPLICATE`, `FAILED`). A row with `pending_storage_path` has a file waiting in `pending/` for review. |

Responses never contain storage paths, checksums or the sender numbers of submissions. BigInt file sizes and Decimal confidences are returned as numbers, dates as ISO strings.

### `GET /api/admin/overview`

| Field | Meaning |
|---|---|
| `businessDate` | Today in Sri Lanka (`YYYY-MM-DD`) |
| `kpis.totalClients` | `users` count |
| `kpis.totalDocuments` | `documents` count (stored files) |
| `kpis.pendingReview` | files waiting in `pending/` + stored documents marked `REVIEW_REQUIRED` |
| `kpis.receivedToday` | submissions (`temporary_data`) since midnight Sri Lanka time |
| `submissionsByStatus` / `submissionsByType` | submission counts by pipeline outcome / detected type |
| `recentDocuments` | latest 8 stored documents with client name and passport ID |
| `reviewQueue` | `total`, `pendingFiles`, `reviewRequiredDocuments`, `pendingByStatus`, latest 5 waiting files |

Ten queries run in parallel; the client is joined in the same query (no per-row lookups).

### `GET /api/admin/documents`

| Parameter | Values | Default |
|---|---|---|
| `page` | 1–10000 | 1 |
| `pageSize` | 1–100 | 25 |
| `documentType` | `PASSPORT`, `POLICE_SLIP`, `POLICE_REPORT`, `MEDICAL` | — |
| `verificationStatus` | `VERIFIED`, `REVIEW_REQUIRED` | — |
| `processingStatus` | upper-case status code | — |
| `passportId` | letters/digits, ≤ 20 (case-insensitive) | — |
| `search` | ≤ 100 chars; document ID, passport ID, file name, client name, unique ID (case-insensitive) | — |
| `receivedFrom`, `receivedTo` | `YYYY-MM-DD`, Sri Lanka days, from ≤ to | — |
| `sort` / `order` | `receivedDate`, `ocrConfidence` (no-OCR last), `documentType` / `asc`, `desc` | `receivedDate` / `desc` |

A malformed or repeated parameter gives 400 with field messages; unknown parameters are ignored. Response: `items`, `pagination { page, pageSize, total, totalPages }`, `summary { total, byVerificationStatus }` (for the status chips: current filters except verification) and the applied `filters`. Paging is stable (ties broken by document ID).

### `GET /api/admin/clients/:passportId`

400 for a malformed ID, 404 `{ "message": "Client not found" }` for an unknown one. Response:

| Field | Meaning |
|---|---|
| `client` | profile (passport ID, unique ID, names, DOB, place of birth, passport expiry, WhatsApp, contact, address, job, dates) |
| `documents` | the client's stored documents, newest first |
| `pendingItems` | the client's files waiting in `pending/` (up to 50) |
| `requiredDocuments` | per required type: `VERIFIED` > `REVIEW_REQUIRED` > `PENDING_REVIEW` > `MISSING` |
| `missingDocumentTypes` | required types with nothing received |
| `police` | latest stored police slip and final police report (no countdown — Phase 9) |

Required documents are **Passport, Police report, Medical** (proposal §22 client view and AC-22). A police slip is shown but never counts as the police report. No other requirement is assumed.

## 4a. Review data (Checkpoint 3)

### What was lost before

The pipeline computes a full, PII-free processing summary for every submission (it is what gets logged), but only `processing_status`, the document type, the client link and the pending path were saved. So for a file waiting for review nobody could see **why**: `MANUAL_REVIEW` covers identity, wrong-document and police-date problems alike, and the confidences, flags, identity notes, conflicting field names and the failing stage of a `FAILED` submission were only in the logs. A stored `REVIEW_REQUIRED` document could not be traced back to the submission it came from at all.

### Schema change — migration `20260925150000_phase10_review_data`

Additive only: three nullable columns, one index, one foreign key. No rename, no drop, no rewrite of existing rows (they keep `NULL`).

| Column | Why | Written by | Read by |
|---|---|---|---|
| `temporary_data.processing_summary` (JSONB) | The reasons behind a review: confidences and band, flags, identity status/notes, passport field status, police-slip date status, low-quality-passport conditions, checksum/placement, field names that match or conflict, failing stage and redacted error. It is exactly the summary already logged (no text, names, dates, passport or phone numbers, paths or checksums). | `processDocument` when processing completes (stage `COMPLETED`) or fails (`FAILED`, with the stage) | Review Detail (processing, identity), Review Queue (confidence of waiting files) |
| `temporary_data.review_reason` (TEXT) | One code saying why a person must look at it, so the queue can show, count and filter by reason. `NULL` = nothing to review. | `processDocument` (`deriveReviewReason`) at the same moments | Review Queue (column, filter, summary cards), Review Detail (banner) |
| `documents.temporary_id` (TEXT, FK → `temporary_data`, `ON DELETE SET NULL`, indexed) | Links a stored file to its submission, so a `REVIEW_REQUIRED` document shows its reason and summary. `SET NULL` keeps documents if submissions are ever cleaned up (Phase 8). | `storeClientDocument` (via `placeDocument`) | Review Queue / Detail for stored documents |

Not added, deliberately: a separate confidence column (it is in the summary; stored documents already have `ocr_confidence`), a "review since" timestamp (a submission enters review when processing finishes, seconds after `created_date`), MIME type/size for submissions (the stored name's extension comes from the validated MIME type, SEC-010), priority (no business rule exists), and any audit table (see limitations).

Row-level security and the revoked public-role grants apply to the new columns automatically (they are on the same tables).

**Status:** the migration file is in the repository and was verified on a throwaway PostgreSQL 16 (all five migrations with `prisma migrate deploy`, existing rows kept, new columns `NULL`, RLS still on, 0 public grants, `SET NULL` behaviour). It has **not** been applied to the live database and is on hold (decision 2026-09-25). Until it is applied, the new code must not run against the live database (it reads and writes the new columns).

### Review reasons

`deriveReviewReason()` names the existing pipeline decision, in the pipeline's own order (first match wins):

| Code | Existing rule it names | Summary card |
|---|---|---|
| `PROCESSING_FAILED` | processing `FAILED` | Other |
| `CROSS_CLIENT_DUPLICATE` | checksum `CROSS_CLIENT_CONFLICT` | Conflicts |
| `IDENTITY_CONFLICT` | identity `IDENTITY_CONFLICT` | Conflicts |
| `RECORD_CONFLICT` | reconciliation conflicts (passport values differ from the record) | Conflicts |
| `DOCUMENT_TYPE_UNCLEAR` | type `UNKNOWN`, `POLICE_TYPE_UNCLEAR` or filename-only | Quality / OCR |
| `WRONG_DOCUMENT_SUSPECTED` | `WRONG_DOCUMENT_SUSPECTED` flag | Quality / OCR |
| `IDENTITY_NOT_CONFIRMED` | identity needs review (no match, ambiguous, passport-only incl. SEC-008, provisional, unreadable passport ID) | Identity |
| `POLICE_DATE_UNRESOLVED` | police slip date `AMBIGUOUS` / `INVALID` / `NOT_FOUND` | Other |
| `LOW_CONFIDENCE` | band `UNDEFINED` or `UNCLEAR` (incl. accepted low-quality passports) | Quality / OCR |

`DUPLICATE` (same client already has the file) and clear documents get no reason. A stored `REVIEW_REQUIRED` document without a link (stored before the migration) is shown as `LOW_CONFIDENCE`, the only rule that produces that status. Submissions processed before the migration show "Not recorded".

### What is in the queue

- **Waiting files** (`PENDING`): submissions with a file in `pending/`.
- **Stored documents** (`DOCUMENT`): `documents` rows with `verification_status = REVIEW_REQUIRED`.

The Overview's "pending review" and the client page's "waiting for review" use the same definition, so all three screens count the same items. A `FAILED` submission is **not** a review item by itself (decision 2026-09-25): it appears only if a pending copy was made before the failure. Its reason (`PROCESSING_FAILED`) and summary are still saved on the row.

No priority is shown: no priority rule exists in the proposal or the code. The queue is ordered by waiting time (oldest first, switchable).

## 4b. Review API (Checkpoint 3)

All behind the same ACTIVE-admin middleware, `Cache-Control: no-store`.

### `GET /api/admin/review`

| Parameter | Values | Default |
|---|---|---|
| `page`, `pageSize` | 1–1000, 1–100 (page × pageSize ≤ 1000) | 1, 25 |
| `kind` | `ALL`, `PENDING`, `DOCUMENT` | `ALL` |
| `documentType` | `PASSPORT`, `POLICE_SLIP`, `POLICE_REPORT`, `MEDICAL`, `UNKNOWN` | — |
| `reviewReason` | a code from the table above | — |
| `passportId` | letters/digits, ≤ 20 | — |
| `order` | `asc` (oldest first), `desc` | `asc` |

Response: `items` (`reviewId`, `kind`, type, statuses, `reviewReason`, `reviewCategory`, `confidence`, `receivedDate`, `client`), `pagination`, `summary` (`total`, `pending`, `documents`, `byReason`, `byCategory` — for the whole queue) and the applied `filters`. No storage paths or sender numbers. The two sources are merged in memory, so paging is limited to the first 1000 items of a filtered view.

### `GET /api/admin/review/:reviewId`

`reviewId` is `pending-<temporary_id>` or `document-<document_id>` (400 otherwise, 404 if unknown or no longer a review item). Response: `reviewReason` and category, `document` (type, statuses, received date, confidence), `client`, `submission` (sender WhatsApp number and time — needed to judge identity problems), `processing` (the saved summary, or `null` for older items) and `file` (name, MIME type, size, location `PENDING`/`CLIENT`, `previewUrl`). Never a storage path.

### `GET /api/admin/review/:reviewId/file`

Streams the item's file from the private bucket through the backend. The object path comes from the database record, never from the request; the bucket credentials and storage URLs never reach the browser. Headers: the validated MIME type, `Content-Disposition: inline` with a sanitized name, `Cache-Control: no-store`, `Content-Security-Policy: … sandbox`, `Cross-Origin-Resource-Policy: same-origin`. Storage failure → 502 without details.

The page fetches it with the admin's token and shows it from a local `blob:` URL. For that, the site CSP allows `blob:` in `img-src` and `frame-src` only; scripts remain same-origin only and `object-src` stays `'none'`.

## 5. Pages and data

| Page | API | Shows |
|---|---|---|
| Overview | `GET /overview` | 4 KPI cards, processing-status and type breakdowns (count + share), recent documents table, review-queue summary with the latest waiting files; Refresh |
| Documents | `GET /documents` | search, type, date range, sort, verification chips with counts, table (ID, client, type, status, confidence, received, "View client"), pagination; filters are kept in the URL |
| Client details | `GET /clients/:passportId` | profile card, required-document checklist with missing summary, police slip/report panel, stored documents table, files waiting for review |
| Review Queue | `GET /review` | summary cards (pending reviews, identity issues, quality / OCR issues, conflicts), filters (source, reason, type, order), table (item, client, type, review reason, confidence, received, status, "Review"), pagination; filters in the URL |
| Review detail | `GET /review/:id`, `GET /review/:id/file` | file preview (image or PDF) on the left; review-reason banner, document information (client, sender, received, statuses, confidence), identity, processing details, audit-log placeholder and the **disabled** Approve / Reject / Keep pending buttons on the right |

Every page has loading, error (with "Try again") and empty states. A 401 from the API signs the admin out (session expired or admin deactivated). API calls live only in `admin/src/api/`; pages use the typed functions through `useAdminResource`.

## 6. Design system

`admin/src/index.css` defines the Stitch tokens as a Tailwind v4 `@theme`:

- **Colours:** primary `#2563eb` (hover `#1d4ed8`, active `#1e40af`); canvas `#f8fafc`; surfaces `#ffffff` with `#e2e8f0` borders; dark sidebar `#0f172a` / `#1e293b`; status sets for verified, review, pending, critical and duplicate (text / background / border).
- **Typography:** Inter (self-hosted via `@fontsource-variable/inter`) with tabular figures; scale `headline-xl` … `label-sm` as in Stitch.
- **Shapes and depth:** radius 2 / 4 / 6 / 8 / 12 px; hairline borders with very light shadows; focus ring `0 0 0 3px rgba(37,99,235,.15)`.
- **Layout:** sidebar 240px (rail 64px), header 56px, content max 1600px.
- **Icons:** Material Symbols Outlined, imported one SVG at a time from `@material-symbols/svg-400` (a few hundred bytes each instead of a 1–1.5 MB icon font).

No external CDN or Google Fonts request is made, so the backend's Content Security Policy (`script-src 'self'`) applies unchanged.

## 7. Running it

```bash
npm run admin:install      # once: install the admin app's dependencies

# Development (two terminals)
npm start                  # backend on http://localhost:3000
npm run admin:dev          # dashboard on http://localhost:5173/admin/
                           # (Vite proxies /auth, /api and /health to the backend;
                           #  another backend: ADMIN_API_PROXY_TARGET=http://host:port)

# Production
npm run admin:build        # type-check + build into admin/dist (git-ignored)
npm start                  # dashboard at http://localhost:3000/admin/
```

If the dashboard is not built, `/admin` answers `404 {"message":"Admin dashboard is not built. Run: npm run admin:build"}`; the API works either way.

Serving rules (`src/adminFrontend.js`): hashed files under `/admin/assets/` are cached for a year and a missing one is a plain 404; any other GET under `/admin` returns `index.html` with `Cache-Control: no-cache`, so deep links such as `/admin/review` work on reload.

## 8. Tests

| Suite | Command | Covers |
|---|---|---|
| Frontend (Vitest, jsdom) | `npm run admin:test` | Checkpoint 1 auth/shell tests; Overview data, loading, error + retry, empty states, 401 → sign out; Documents rows, badges, chip counts, filters/sort/search sent to the API, pagination, empty/error states, link to client; Client details data, not-found, error; protected routes never call the API without a session |
| Backend, Checkpoint 3 (`node:test`) | `npm test` (`test/adminReview.test.js`) | migration is additive and matches the schema; every review reason and its precedence; processing writes the reason, the summary and the document link (identity conflict, low confidence, stored summary = logged summary, no PII); queue auth (no token, inactive admin) incl. detail and file routes; merged queue, shared waiting definition, filters/paging/kind, 9 invalid-parameter cases, window limit, legacy `LOW_CONFIDENCE`; detail for waiting file and stored document, unknown and malformed IDs; file streaming, headers, unknown item never touches storage, storage error → 502; CSP `blob:` only for images/frames |
| Frontend, Checkpoint 3 (Vitest) | `npm run admin:test` (`review.test.tsx`) | queue rendering, loading, error + retry, empty, filters and pagination, link to detail; detail rendering (reason, identity notes, sender, processing, client link, preview via token + blob URL), disabled actions that never call the API, item without saved data, preview error, not found; protected routes |
| Backend (`node:test`) | `npm test` (`test/adminFrontend.test.js`, `test/adminApi.test.js`) | `/admin` serving (Checkpoint 1); `/api/admin` auth: no/invalid/expired token, deleted and inactive admin, ACTIVE admin, no-store, DB failure → 500; overview structure, safe serialization, Sri Lanka "today", fixed query count; documents pagination, filters, search, date range, sorting, 14 invalid-parameter cases, unknown parameters; client details, required-document rules, 404, invalid ID; business-day helpers |

Checked manually for Checkpoint 2 (not in the automated suite): the service queries against the live database (read-only, shapes and counts only), and the production build in headless Chrome with the admin API reading the live database read-only and a fake admin for sign-in: login redirect, Documents total and review-required filter match the database, "View client", required-document list, Overview totals, unknown client, no CSP violations or console errors.

Checked manually for Checkpoint 3 (not in the automated suite): the migration on a throwaway PostgreSQL 16 (Docker) as described in §4a; the real pipeline and the new queries against that database (six synthetic submissions: verified, SEC-008, low-confidence medical, identity conflict, police slip without date, failed — reasons, summaries without PII, document link, queue/filters/paging, detail, file lookup, overview total = queue total, `SET NULL`); and the production build in headless Chrome against that database (login redirect, queue rows = database, image and PDF previews from `blob:` URLs, disabled actions, stored document item, unknown item, no CSP violations or console errors). The live database was not changed (checked before and after).

## 9. Decisions (2026-09-25)

| Decision | Outcome |
|---|---|
| CSP `blob:` for images and frames only (in-page preview) | Approved |
| Items processed before the migration shown as "Not recorded" (no backfill) | Approved |
| Review Queue paging window of 1000 items | Approved for now |
| Audit log and approve/reject rules designed before review actions | Approved |
| `FAILED` submissions counted as pending review | Rejected — only files in `pending/` count |
| Apply the migration to the live database | On hold |

## 10. Known limitations and dependencies

- **Migration not applied to the live database** — on hold by decision (2026-09-25); do not deploy yet.
- **Processing failures are not shown in the dashboard:** a `FAILED` submission without a pending copy is not a review item (decision 2026-09-25). Its reason and summary are saved on the row; a separate view for failures can be decided later.
- **Older items:** submissions processed before the migration have no saved summary or reason ("Not recorded"); older stored `REVIEW_REQUIRED` documents have no link and are shown as `LOW_CONFIDENCE`. No backfill: the missing data was never saved.
- **Audit log:** no persistent audit model exists. The Review Detail shows a placeholder. The review-action checkpoint needs an audit design (who decided what, when, from which state) before approve / reject / keep pending can be enabled.
- **Review actions are deferred:** the buttons are rendered disabled and call nothing. OCR boxes, zoom, rotation and the manual field confirmation from the Stitch design depend on actions or stored OCR geometry and are not built.
- **Queue paging window:** 1000 items per filtered view (the two sources are merged in memory).
- **PDF preview:** shown in a frame from a `blob:` URL (plus "Open PDF in a new tab"); verified without CSP violations in headless Chrome, where the PDF viewer itself cannot be inspected.

## 11. Next checkpoints

4. Review actions (approve / reject / keep pending) with an audit log.
5. Police Workflow (full version depends on Phase 9 data).
