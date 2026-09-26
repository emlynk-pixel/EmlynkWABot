# Phase 10 — Admin Dashboard

Status: **Final Phase 10 scope implemented and verified (not yet committed). None of the five Phase 10 migrations is applied to the live database.** The standalone reference for the finished dashboard is [`15-admin-dashboard-reference.md`](15-admin-dashboard-reference.md); it also lists every decision and deviation from the proposal.

| Checkpoint | Scope | Status |
|---|---|---|
| 1 | Frontend scaffold, admin login, route guard, dashboard shell | Done (`d0d7323`) |
| 2 | Read-only admin API (`/api/admin`), Overview, Documents, Client Details | Done (`90a0d6e`) |
| 3 | Review data migration, Review Queue, read-only Review Detail with secure file preview | Done (`4572bc0`) |
| 4 | Review actions (Approve, Keep Pending) with an append-only audit log | Done (`10bf997`) |
| 5 | Police Workflow: slip submitted date stored, calculated 21-day status, Police Workflow page, client countdown, Overview counts | Done (`5615aaa`) |
| — | Remove from Review | Done (`7f927a6`) |
| Final | Clients directory, Missing Documents, configurable required documents, corrections (set document type, assign client, set police slip date), status mapping, Police search, Sync, Dark Mode, Daily Report, Overview completeness | Implemented (§4e–§4j) |

Not built (by decision): a reject action (business rule: there is none, §4c), uploads (including an admin upload of the actual police report), exports, WhatsApp messaging, reminders or warnings for police reports (Phase 11), scheduled jobs, a Settings page, global search, client editing, batch actions, roles (Phase 12).

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
    │   ├── Header.tsx        # 56px utility bar: breadcrumb, Sync, dark mode, admin, sign out
    │   └── navigation.ts     # sidebar entries
    ├── components/           # Icon, StatusBadge, Confidence, DocumentsTable, ClientTable, Dialog, States, format
    ├── pages/                # Login, Overview, Documents, Review Queue/Detail, Clients, Client Details,
    │                         # Missing Documents, Police Workflow, Daily Report, not found
    ├── sync/SyncProvider.tsx # Sync: reload the data on screen
    ├── theme/theme.ts        # light / dark mode, stored per browser
    └── test/                 # Vitest + Testing Library tests
```

Backend files for the dashboard:

| File | Purpose |
|---|---|
| `src/adminFrontend.js` | Serves `admin/dist` under `/admin` (Checkpoint 1) |
| `src/middleware/requireActiveAdmin.js` | Shared check for `/api/admin`: valid JWT + admin exists and is ACTIVE |
| `src/routes/admin.js` | `/api/admin` routes, parameter validation, JSON errors |
| `src/services/adminDashboardService.js` | Prisma queries and response shaping |
| `src/utils/businessDay.js` | Sri Lanka business-day boundaries (`Asia/Colombo`) |
| `src/services/reviewReason.js` | Review reason codes (Checkpoint 3) |
| `src/services/adminReviewService.js` | Review Queue / Review Detail queries and the file lookup (Checkpoint 3) |
| `src/services/adminReviewActionService.js` | Approve, Keep Pending, Remove from Review; locks and audit helpers |
| `src/services/adminCorrectionService.js` | Set document type, assign client, set police slip date |
| `src/services/adminClientService.js` | Required-document rule, client completeness, Clients directory, Missing Documents |
| `src/services/adminReportService.js` | Daily report |
| `src/services/adminPoliceService.js` / `policeCountdownService.js` | Police Workflow list and the calculated 21-day status |
| `src/services/statusMapping.js` | Proposal status words → implementation states (used by the daily report) |
| `src/config/requiredDocuments.js` | `REQUIRED_DOCUMENT_TYPES` configuration and validation |
| `src/utils/clientName.js` | Client display name (shared) |
| `src/createApp.js` | Mounts `/admin` and `/api/admin` (injectable routers for tests) |

`/auth/login`, `/auth/me`, the WhatsApp webhook and document processing are unchanged. The `ACTIVE_ADMIN_STATUS` constant now lives in the shared middleware and is re-exported by `src/routes/auth.js`, so existing imports keep working.

## 2. Routes

| Route | Page | Stitch screen |
|---|---|---|
| `/admin/login` | Sign in | — (built from the design system) |
| `/admin/` | Overview | Overview Dashboard |
| `/admin/documents` | Documents | Documents Directory |
| `/admin/review` | Review Queue | Review Queue |
| `/admin/review/:id` | Review detail (actions and corrections) | Document Review Detail |
| `/admin/clients` | Clients directory | — (same design language) |
| `/admin/clients/:passportId` | Client details | Client Details |
| `/admin/missing-documents` | Missing Documents | — (same design language) |
| `/admin/police` | Police Workflow | Police Workflow |
| `/admin/reports/daily` | Daily Report | — (same design language) |

Every route except `/admin/login` is behind the route guard. No page is a placeholder. Settings, global search and Export from the design are not built (not in the Phase 10 scope); Sync is (§4j).

## 3. Authentication flow

Uses the existing backend endpoints unchanged (`src/routes/auth.js`).

1. **Sign in:** the login form sends `POST /auth/login` `{ email, password }`. On success the backend returns a JWT (HS256, 1 hour).
2. **Validate:** the app immediately calls `GET /auth/me` with `Authorization: Bearer <token>`. Only then is the admin signed in; the token is stored and the admin's name and role are shown in the header.
3. **Reload / new visit in the same tab:** a stored token is checked again with `GET /auth/me`. If the backend rejects it (expired, admin deactivated, bad token) or cannot be reached, the token is removed and the login page is shown.
4. **Expiry:** the app reads the token's `exp` and signs out when it passes. An already-expired stored token is dropped without calling the backend.
5. **Sign out:** removes the token and returns to the login page. (The backend has no logout endpoint; the token simply expires.)
6. **Route guard:** while a stored token is being checked, a "Checking your session" screen is shown; without a valid session every protected route redirects to `/admin/login`, which returns to the requested page after sign-in (only paths inside the app are followed).

Error messages: the backend's own short messages are shown for 4xx responses ("Invalid email or password", the rate-limit message); 5xx and network errors show a fixed generic text, never backend details.

**Token storage:** `sessionStorage` — survives reloads of the tab, is removed when the tab closes, is not shared between tabs and is never sent automatically. If storage is blocked, an in-memory copy keeps the current tab working. Because JavaScript can read it, it relies on the Content Security Policy (scripts from the same origin only) against XSS. Moving to an httpOnly cookie is planned for **Phase 12**.

The first admin account is created with `npm run admin:create` (see `Docs/13-security-overview.md`).

## 4. Admin API (`/api/admin`)

### Authentication middleware

`createRequireActiveAdmin()` (`src/middleware/requireActiveAdmin.js`) runs before every `/api/admin` route:

1. the existing `authenticateAdmin` checks the Bearer JWT (HS256 only; missing → 401 "Authentication Token is required!", invalid/expired → 401 "Invalid or Expired Token");
2. the admin named in the token is loaded (profile fields only, never the password hash). If it no longer exists **or** its status is not `ACTIVE`, the answer is the same 401 "Invalid or Expired Token" — a deactivation takes effect on the next request, without saying why.

This is the same rule `GET /auth/me` applies; `/auth/me` itself is unchanged (a deleted admin still gets its existing 404 there). A database error is passed to the error handler (generic 500). Every `/api/admin` response has `Cache-Control: no-store`.

Errors are JSON: `{ "message": "…" }`, with `errors: [{ field, message }]` for invalid parameters (400). Review-action conflicts also carry a `code` (§4c). Unknown paths under `/api/admin` return 404 `{ "message": "Not found" }` (after authentication).

Every route is read-only except the review actions (§4c) and the corrections (§4f); each of them writes an audit entry. There is no 403: an inactive or deleted admin gets the same 401 as a bad token (existing rule above), and there are no roles yet.

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
| `police` | `dueSoon`, `dueToday`, `overdue`: clients by Police Workflow status (§4d) |
| `clients` | `total`, `complete`, `incomplete`, `withMissing`, `missingDocuments`, `missingByType`: required-document completeness of every client, now (§4e) |
| `requiredDocumentTypes` | the configured required types |

Sixteen queries run in parallel (three for the police counts, three for client completeness); the client is joined in the same query (no per-row lookups). Every Overview figure is current / all-time except `receivedToday`; one day's figures are in the Daily Report (§4i).

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
| `complete` | every required type is `VERIFIED` |
| `police` | latest stored police slip (with its `policeSubmittedDate`) and final police report, `countdown`: the client's Police Workflow status (§4d), and `dateChanges`: slip dates set or corrected by an admin (audit log) |

Required documents are `REQUIRED_DOCUMENT_TYPES` (§4e), by default **Passport, Police report, Medical** (proposal §19, §22 client view and AC-22). A police slip is shown but never counts as the police report unless it is configured as required.

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
| `DUPLICATE_OF_VERIFIED` | exact copy (same checksum) of the same client's `VERIFIED` document (M4, §4k) | Other |

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

## 4c. Review actions and audit log (Checkpoint 4)

Review workflow: `Pending → Approve | Keep Pending | Resolve/Correct (§4f) | Remove from Review`. There is **no reject workflow** (business rule): no reject endpoint, button, status or reason. Pending documents are **never removed automatically** — not because of age, expiry, inactivity or processing time; nothing in the code removes them except the manual **Remove from Review** action below.

### `POST /api/admin/review/:reviewId/approve`

Body: `{ "reason": "…" }` (optional, at most 500 characters). For a police slip also `{ "policeSubmittedDate": "YYYY-MM-DD" }` (§4d).

| Item | What happens |
|---|---|
| Waiting file (`pending-<temporary_id>`) | The file in `pending/` is copied to `clients/{passport_id}/{type}/` under the standard name (`passport.pdf`, `passport_v2.pdf`, … — the same `copyToFreeName` / `standardFileName` rules the pipeline uses). A `documents` row is created with `verification_status = VERIFIED`, `processing_status = STORED`, size and SHA-256 of the file, `temporary_id` link and the saved confidence. The submission gets `pending_storage_path = NULL` and `processing_status = VERIFIED` (its `review_reason` stays as the record of why it was reviewed). After the commit the pending original is removed, completing the move. |
| Stored document (`document-<document_id>`, `REVIEW_REQUIRED`) | The file is already in the client folder; `verification_status` becomes `VERIFIED`. No storage change. |

Approve is refused (409, nothing changed, no audit entry) when:

| `code` | When |
|---|---|
| `VERIFIED_DOCUMENT_EXISTS` | The client already has a `VERIFIED` document of the same type. Approval never replaces or changes it. |
| `CLIENT_NOT_IDENTIFIED` | The file is not linked to a client (unlinked files can't be assigned to a client yet). |
| `NO_CLIENT_FOLDER` | The type has no client folder (`UNKNOWN`). |
| `DUPLICATE_FILE` | The client already has this exact file (same SHA-256). |
| `FILE_CHANGED` | The pending file no longer matches the checksum recorded when it was received. |
| `UNSUPPORTED_FILE` | The pending file's type can't be stored. |
| `ALREADY_RESOLVED` | Another request resolved the item first. |

A storage failure (pending file unreadable, copy failed) returns 502 with `STORAGE_UNAVAILABLE`; nothing is changed.

The Review Detail response includes `actions.approve` (`available`, `code`, `message`) so the page can disable Approve and say why; the server checks again when the action runs.

### `POST /api/admin/review/:reviewId/keep-pending`

Body: `{ "reason": "…" }` — **required**, 1–500 characters after trimming (400 otherwise). The item stays exactly as it is: the file stays in `pending/` (or the stored document stays `REVIEW_REQUIRED`), it stays in the Review Queue, and nothing is moved or deleted. Only the audit entry is written; the admin's reason is kept there (the `review_reason` code on the submission is not overwritten).

### `POST /api/admin/review/:reviewId/remove` — Remove from Review

A manual admin decision after inspecting a waiting file. Distinct from rejection: nothing is classified as rejected.

- **Every review item** (H4, 2026-09-26): a file waiting in `pending/` (`pending-<temporary_id>`), or a stored `REVIEW_REQUIRED` document (`document-<document_id>`). A `VERIFIED` document is not a review item and can't be removed (404); unknown items, and `FAILED` submissions without a pending copy, answer 404.
- **Stored `REVIEW_REQUIRED` document:** its `documents` row and its file in the client folder are deleted — nothing else. The delete only matches that row *and* `verification_status = REVIEW_REQUIRED`, so the client's `VERIFIED` document (or any other document) can't be touched; the file is kept if another row still points at it. The submission it came from (`temporary_data` row, `temporary/` original) stays as the record of what was received. The audit entry has `document_id`, `previous_status = REVIEW_REQUIRED`, `new_status = REMOVED`, type and checksum. This clears items that could otherwise never leave the queue: a `REVIEW_REQUIRED` document next to a `VERIFIED` one of the same type can't be approved.
- Body: `{ "reason": "…" }` — **required**, 1–500 characters (400 otherwise). The page also asks for an explicit confirmation ("I have inspected this file and understand it will be permanently deleted") before it sends anything.
- **Permanent:** the file in `pending/`, its original in `temporary/` and its `temporary_data` row are deleted. There is no undo and no "return to review". A document stored from the same submission (rare) keeps its file; its link becomes `NULL` (`ON DELETE SET NULL`).
- **Audit:** in the same transaction as the row deletion, an entry records the admin (from the token), the submission ID, the client (if known), the previous status, `new_status = REMOVED`, the reason, and — because the row is gone — the document type and file checksum. The entry is append-only like every other.
- **Order:** lock the row, write the entry, delete the row, commit; only then delete the two files. A database failure changes nothing. If deleting a file fails after the commit, the item is still gone (the response says `filesDeleted: false` and the stray object is logged).
- Nothing else is touched: other waiting files, their records and files stay exactly as they are.
- Afterwards the same file sent again by the client is processed as new (the pending-duplicate check only sees rows that still exist).
- The detail response's `actions.remove` says whether the item can be removed.

### Consistency and duplicate protection

- Each action runs in one database transaction that first locks the reviewed row (`SELECT … FOR UPDATE`), re-reads its state and only then changes it. Approve also locks the client's `users` row, so two items of the same type for one client can't both become verified. Lock order is always reviewed row, then client.
- Storage can't join the transaction. Approve copies the file inside the transaction; if anything fails before the commit, the database rolls back and the copy is removed again. The pending original is removed only after the commit. The possible leftovers are a stray object (a copy in the client folder if the process dies before the commit, or the pending original if its removal fails, which is logged); the database is never left saying something the files don't match.
- A second Approve of the same item gets 409 `ALREADY_RESOLVED` (or 404 once the item is no longer a review item). An identical Keep Pending (same admin, item and reason) within 60 seconds gets 409 `DUPLICATE_ACTION`; a different reason or another admin is a new decision.
- The page disables both buttons and the dialog while a request runs; the server does not rely on that.
- A `FAILED` submission without a pending copy is not a review item: every action answers 404 and changes nothing.
- Two removals of the same item at once: one succeeds, the other gets 409 `ALREADY_RESOLVED` (or 404 once the item is gone).

### Error responses

| Status | When |
|---|---|
| 400 | Malformed review ID, body that is not a JSON object, missing/invalid reason |
| 401 | No/invalid token, inactive or deleted admin |
| 404 | Unknown item, or no longer a review item |
| 409 | Conflict or invalid state (`code` as above, `DUPLICATE_ACTION`) |
| 502 | Storage failure (`STORAGE_UNAVAILABLE`) |
| 500 | Unexpected error (generic message only) |

### Audit log — table `audit_logs`, migration `20260925160000_phase10_review_audit_log`

Purpose: a permanent record of every review decision — who decided what, about which item and client, from which state to which, why, and when.

| Column | Meaning |
|---|---|
| `audit_id` | Primary key (UUID) |
| `admin_id` | The admin who acted (from the token, never from the request body). Foreign key to `admins`, `ON DELETE RESTRICT`: an admin with entries can't be deleted (deactivate instead). |
| `action` | `APPROVE`, `KEEP_PENDING`, `REMOVE_FROM_REVIEW`, `SET_DOCUMENT_TYPE`, `ASSIGN_CLIENT` or `SET_POLICE_DATE` |
| `temporary_id` | The submission, when there is one |
| `document_id` | The document created (approve of a waiting file) or reviewed (stored document); for actions on an M4 duplicate, the existing document it copies (never changed, §4k) |
| `passport_id` | The client, when known |
| `previous_status` / `new_status` | Waiting file: the submission's `processing_status` → `VERIFIED` (approve) or unchanged (keep pending). Stored document: `REVIEW_REQUIRED` → `VERIFIED` or unchanged. |
| `reason` | The admin's reason (required for Keep Pending, optional for Approve) |
| `created_date` | When (database time) |

Rules:
- **Append-only.** An entry is written in the same transaction as the action, so it exists exactly when the action took effect (a refused or failed action leaves none). The API has no route that edits or deletes an entry, and a database trigger rejects any `UPDATE`, `DELETE` or `TRUNCATE` on the table, whoever runs it.
- The reviewed item is stored as plain IDs without foreign keys, so the history outlives the `temporary_data` / `documents` rows (e.g. a later clean-up).
- Same access protection as the other tables: RLS on, no rights for Supabase's `anon` / `authenticated` roles.
- The migration is additive: one new table, three indexes (`temporary_id`, `document_id`, `admin_id`, each with `created_date`), the foreign key, RLS/revoke and the trigger. No existing table, column or row is changed.
- Review Detail shows the entries for the item, newest first (a stored document also shows those made while it was pending): action, admin, reason, time.

| `police_submitted_date` | Approval of a police slip: the submitted date the admin entered or confirmed (added in Checkpoint 5, §4d) |
| `document_type` / `file_sha256` | Remove from Review: the removed submission's type and checksum, kept because its row is deleted (migration `20260926090000_phase10_audit_removal_details`). Never returned by the API except the type. The corrections also record the document type. |
| `previous_value` / `new_value` | Corrections (§4f): the value before and after — document type, passport ID or slip date (`YYYY-MM-DD`). Migration `20260926120000_phase10_audit_correction_values`. |

**Deployment dependency:** the Phase 10 backend code uses the columns and the table from all five Phase 10 migrations (`20260925150000_phase10_review_data`, `20260925160000_phase10_review_audit_log`, `20260925170000_phase10_police_submitted_date`, `20260926090000_phase10_audit_removal_details`, `20260926120000_phase10_audit_correction_values`). Apply them, in order, before deploying this code; deploying the code first breaks the review pages, the dashboard and document processing. None is applied to the live database yet. The last two are additive: nullable columns on `audit_logs`, nothing else.

## 4d. Police Workflow (Checkpoint 5)

The minimal Phase 9 data needed for the Police Workflow screen. Reminders, WhatsApp warnings, scheduled jobs and notifications are **not** part of it (Phase 11), and neither is an admin upload of the actual police report.

### Data — migration `20260925170000_phase10_police_submitted_date`

| Column | Meaning |
|---|---|
| `documents.police_submitted_date` (`DATE`, nullable) | A police slip's submitted date: the start of the 21-day wait. |
| `audit_logs.police_submitted_date` (`DATE`, nullable) | The date an admin entered or confirmed when approving a police slip. |

Additive only: existing rows get `NULL`, nothing is updated, dropped or renamed. No status, reminder or alert is stored (proposal §23): the status is calculated on every request.

Where the date comes from:
- **Pipeline:** a `POLICE_SLIP` filed under the client with a `RESOLVED` date (the existing rule of the police date reader, `policeReportDateService.js`) gets that date. Only slips; every other document keeps `NULL`. A slip in `pending/` has no stored date.
- **Approve** (§4c): a police slip without a stored date needs `policeSubmittedDate` (400 `POLICE_DATE_REQUIRED` otherwise) — every waiting slip, and stored slips from before this migration. A stored slip whose date OCR read keeps it: the approval confirms it, and a different date is refused (409 `POLICE_DATE_ALREADY_SET`). Other types take no date (400 `POLICE_DATE_NOT_APPLICABLE`). The date must be a real date from 2000-01-01 up to today in Sri Lanka (400 otherwise). The date used is written to the document and to the audit entry in the same transaction. The one-verified-document-per-type rule is unchanged.

### Status (`src/services/policeCountdownService.js`)

`due date = submitted date + 21 days`; `days left = due date − today`, counted in Sri Lanka calendar days (the day changes at midnight Asia/Colombo).

| Status | When (checked in this order) |
|---|---|
| `COMPLETED` | The client has a `VERIFIED` `POLICE_REPORT`, whenever it arrived (also before the slip). The countdown stops. A `REVIEW_REQUIRED` report does not count. |
| `PENDING` | More than 7 days left |
| `DUE_SOON` | 1–7 days left |
| `DUE_TODAY` | 0 days left |
| `OVERDUE` | The due date has passed |
| `DATE_MISSING` | A police slip exists (stored, or waiting in `pending/`) but no submitted date is known |
| `NOT_UPLOADED` | No police slip |

The countdown uses the stored slip (`VERIFIED` or `REVIEW_REQUIRED`) with the latest submitted date; a `REVIEW_REQUIRED` slip with a readable date starts it.

### `GET /api/admin/police`

| Parameter | Values | Default |
|---|---|---|
| `status` | one status above | all |
| `passportId` | letters and digits | all |
| `search` | ≤ 100 chars; every word must appear in the passport ID, unique ID or name (case-insensitive) | — |
| `page` / `pageSize` | 1–10000 / 1–100 | 1 / 25 |

Response: `businessDate`, `items` (per client: `client`, `status`, `submittedDate`, `dueDate`, `daysRemaining` — negative when overdue, `null` when completed or without a date — `slip`, `report`, `slipAwaitingReview`), `pagination`, `summary` (`total`, `byStatus` for every client, before the status filter) and `filters`. Order: most urgent first (`OVERDUE`, `DUE_TODAY`, `DUE_SOON`, `PENDING`, `DATE_MISSING`, `NOT_UPLOADED`, `COMPLETED`), then fewest days left, then passport ID. Read-only; three queries whatever the number of clients (clients, their police documents, slips waiting per client); no storage paths. The search only narrows the list; the summary then counts the clients found.

## 4e. Clients directory, Missing Documents, required documents

### Required documents — `REQUIRED_DOCUMENT_TYPES`

The third required document is configurable (proposal §19), without a Settings page: environment variable `REQUIRED_DOCUMENT_TYPES`, a comma-separated list (`src/config/requiredDocuments.js`).

- Unset or blank: `PASSPORT,POLICE_REPORT,MEDICAL`.
- Allowed names: `PASSPORT`, `POLICE_SLIP`, `POLICE_REPORT`, `MEDICAL` (case and spaces don't matter). `PASSPORT` must be included (it identifies the client).
- An unknown name, `UNKNOWN`, a duplicate, an empty entry or a list without `PASSPORT` is refused: the server doesn't start (`src/config/env.js` startup check; the configured text is not echoed). Nothing falls back silently.
- Read once at startup; changing it needs a restart.

One rule (`src/services/adminClientService.js`) decides the status per required type — `VERIFIED` > `REVIEW_REQUIRED` > `PENDING_REVIEW` > `MISSING` — for the client page, the Clients directory, the Missing Documents view, the Overview and the daily report. A client is **complete** when every required type is `VERIFIED`. A `FAILED` submission is not "received".

### `GET /api/admin/clients`

| Parameter | Values | Default |
|---|---|---|
| `search` | ≤ 100 chars; every word must match the passport ID, unique ID, first or other name, or WhatsApp number (case-insensitive). A phone number also matches in the other Sri Lankan format (`07…` / `947…`). | — |
| `completion` | `COMPLETE`, `INCOMPLETE` | all |
| `missingType` | a required type: clients that have not sent it at all | — |
| `page` / `pageSize` | 1–10000 / 1–100 | 1 / 25 |

Response: `items` (per client: `client` {passport ID, unique ID, name, WhatsApp}, `completion`, `requirements` [type, status, stored and pending counts], `missingDocumentTypes`), `pagination`, `summary` (`total`, `complete`, `incomplete`, `withMissing`, `missingDocuments`, `missingByType` — for the clients matching the search, before the completion/type filters), `requiredDocumentTypes`, `filters`. Order: unique ID. Three queries whatever the number of clients (clients; stored documents grouped by client, type and status; waiting files grouped by client and type), then in memory.

### `GET /api/admin/documents/missing`

The proposal's `GET /documents/missing`. Same loading and summary; `items` are the **incomplete** clients, most missing documents first. `documentType` (a required type) keeps only the clients that have not sent that type; `search`, `page`, `pageSize` as above. A client whose documents are all received but not all verified is incomplete with no missing type (its requirements show `REVIEW_REQUIRED` / `PENDING_REVIEW`).

## 4f. Corrections (resolve stuck review items)

`src/services/adminCorrectionService.js`. They resolve items that would otherwise stay stuck, without approving, removing or rejecting them. Same rules as the review actions: one transaction that locks the row (`SELECT … FOR UPDATE`), re-reads and then changes it; the admin from the token; a **required reason** (1–500 characters); an append-only audit entry in the same transaction with `previous_value` / `new_value`. Nothing here creates a client or a document, changes a WhatsApp number, or moves or deletes a file.

| Endpoint | Body | Applies to | Effect | Refused |
|---|---|---|---|---|
| `POST /review/:reviewId/document-type` | `{ documentType, reason }` — `PASSPORT`, `POLICE_SLIP`, `POLICE_REPORT` or `MEDICAL` | waiting files (`pending-…`) | `temporary_data.document_type` changes; the file stays in `pending/` and in the queue (its review reason stays as history). Approve then files it under the new type (a slip then needs its date). | 409 `SAME_DOCUMENT_TYPE`, 409 `NOT_CORRECTABLE` (stored document), 404, 400 |
| `POST /review/:reviewId/assign-client` | `{ passportId, reason }` | waiting files | links the file to an **existing** client: `passport_id` and that client's `unique_id`. The sender's WhatsApp number, the client record and the processing summary (the original identity result) are unchanged; the previous link is in the audit entry. Approve then works with all its checks. | 409 `CLIENT_NOT_FOUND` (nothing created), 409 `SAME_CLIENT`, 409 `NOT_CORRECTABLE`, 404, 400 |
| `POST /documents/:documentId/police-date` | `{ policeSubmittedDate, reason }` — a real date, 2000-01-01 to today in Sri Lanka (never the future) | a stored police slip (`VERIFIED` or `REVIEW_REQUIRED`) | sets or corrects `documents.police_submitted_date` — e.g. older verified slips stored without a date. No document is created, so the one-verified-slip rule is untouched. The countdown is calculated from the stored date, so the client page and the Police Workflow show the new status on their next load. | 409 `SAME_POLICE_DATE`, 409 `NOT_A_POLICE_SLIP`, 404, 400 |

A stored `REVIEW_REQUIRED` document is not corrected here: it is already in the client folder of its type (changing its type or client would mean moving the file).

The Review Detail page offers **Set Document Type** and **Assign Client** (or **Change Client**) for waiting files, when the detail's `actions.setDocumentType` / `actions.assignClient` say so. Assign Client searches existing clients (`GET /clients?search=…`), requires choosing one, a reason and the confirmation "I have checked that this file belongs to …". Client Details has **Set date** / **Correct date** on the latest police slip (date field limited to today, required reason) and lists the date changes from the audit log.

## 4g. Document status mapping (proposal → implementation)

The proposal's status words (§22, §24) and what the implementation records. `src/services/statusMapping.js` holds the submission part; the daily report counts with it (tested).

| Proposal status | Implementation |
|---|---|
| Missing | Requirement status `MISSING`: nothing of a required type received (computed, no row) |
| Received | A `temporary_data` row exists (every file that passed intake validation) |
| Processing | `temporary_data.processing_status = TEMPORARY_STORED` (set on arrival, replaced when processing ends). There is no separate `PROCESSING` value. |
| Verified | `documents.verification_status = VERIFIED` (bands VERIFIED / HIGH_CONFIDENCE / SLIGHTLY_UNCLEAR, or an admin's Approve); submission statuses `VERIFIED`, `HIGH_CONFIDENCE`, `SLIGHTLY_UNCLEAR` |
| Temporary | Every received file's original stays in `temporary/` with its row. "Temporary documents" in the dashboard = files still waiting in `pending/` (not yet in a client folder). |
| Unclear | `UNCLEAR` (40–59 %, stored as `REVIEW_REQUIRED`) and `UNDEFINED` (< 40 %, held in `pending/`) |
| Invalid | Refused at intake (unsupported type, too large, bad content): logged, **no record** is created (so not countable) |
| Rejected | **Removed from the workflow.** No reject status, action or endpoint exists. Remove from Review is a queue decision, not a rejection, and creates no status. |
| Completed | Client: every required document `VERIFIED`. Police Workflow: `COMPLETED` when a verified police report exists. |
| (not in the list) | `MANUAL_REVIEW`, `CONFLICT` (held for review), `DUPLICATE` (same file already on record; an exact copy of a *verified* document waits in `pending/` for review, §4k), `FAILED` (processing error) |

Outcome groups (`submissionOutcome`): `PROCESSING` (`TEMPORARY_STORED`), `STORED` (`VERIFIED`, `HIGH_CONFIDENCE`, `SLIGHTLY_UNCLEAR`, `UNCLEAR`), `NEEDS_REVIEW` (`UNDEFINED`, `MANUAL_REVIEW`, `CONFLICT`), `DUPLICATE`, `FAILED`. "Successfully processed" = finished without an error (everything except `FAILED` and `PROCESSING`); an unknown code never counts as success. `FAILED` stays distinct from review: a `FAILED` submission without a pending copy is not in the Review Queue.

## 4h. No automatic removal of pending items

Pending items leave the Review Queue only through an explicit admin action (Approve, or Remove from Review). Nothing removes them because of age, inactivity, processing time, expiry, a server restart, a scheduled clean-up, duplicate detection or an OCR timeout: there is no timer, schedule or clean-up job, and only `removeFromReview` deletes a `temporary_data` row. Tested by source checks (`test/adminReports.test.js`, `test/adminReviewRemove.test.js`).

## 4i. Daily report — `GET /api/admin/reports/daily`

The proposal's `GET /reports/daily` (§22 Daily Summary, §27, §35), now part of the Phase 10 scope. `date=YYYY-MM-DD` selects the business day (00:00–24:00 `Asia/Colombo`); default today in Sri Lanka. 400 for a malformed or unreal date, a date before 2000-01-01 or in the future.

**Daily figures** (`daily`) — only that business day:

| Field | Source |
|---|---|
| `totalReceived` | submissions received that day (`temporary_data.created_date`) |
| `successfullyProcessed` / `failed` / `stillProcessing` | status mapping (§4g) |
| `storedInClientFolder`, `heldForReview`, `duplicates` | outcome groups |
| `unclear` | `UNCLEAR` + `UNDEFINED` |
| `temporary` | received that day and still waiting in `pending/` |
| `byType` | passport, police slip, police report, medical, unknown |
| `adminActions` | review actions and corrections taken that day (audit log) |

**Current figures** (`current`, with `asOf`) — the state now: completed / incomplete clients, missing documents, police reports due soon / today / overdue. There is no history of these, so for a past date they are still today's state; the page says so and never presents them as that day's.

Limitations (not invented): a past day's completeness or police status would need a daily snapshot or a history of verification changes; refused (invalid) files have no record; a submission removed from review is deleted, so it no longer counts as received on its day (the removal itself counts in `adminActions`).

## 4j. Sync and Dark Mode

**Sync** (header button) means only: reload the data shown on screen from the backend. Not WhatsApp, not an external system, no background job. Every `useAdminResource` on the page reloads with its current key, so filters, search and page are kept. While it runs the button shows "Syncing…" and is disabled (a second click does nothing); afterwards the header shows "Synced HH:MM:SS" or "Sync failed — some data could not be loaded" (`admin/src/sync/SyncProvider.tsx`).

**Dark Mode** (header toggle): the Stitch design language on dark slate surfaces. Only CSS token values change (`:root[data-theme="dark"]` in `index.css`), never the components, so every page, table, badge, dialog, form control, empty/error/loading state and the preview frame follow. Fixed colours were replaced by tokens (`on-primary`, `on-critical`, `overlay`); a test forbids fixed colours in components. Light mode is unchanged (same tokens). The choice is stored per browser in `localStorage` (`emlynk.admin.theme`) and applied before the first render; without storage the dashboard opens in light mode. Contrast: every dark text token is ≥ 4.5:1 on every surface (unit test), and the headless-Chrome check measured every visible text element on every page in dark mode (all ≥ 4.5:1, or 3:1 for large text).

## 4k. M4 — Duplicate Verified-Document Policy

A WhatsApp file that is an **exact copy** (same SHA-256) of a document the **same client** already has **VERIFIED** is no longer discarded silently. It goes to admin review; the verified document is never changed.

| Case | Result |
|---|---|
| Same client, same checksum, existing document `VERIFIED` | `processing_status = DUPLICATE`, copy in `pending/{unique_id}/undefined/uncleared-docs/`, linked to the client, review reason `DUPLICATE_OF_VERIFIED`. Nothing new in the client folder (`documentStored: false`, `pendingCopy: true` in the summary). |
| Same client, same checksum, existing document not verified (`REVIEW_REQUIRED`) | Unchanged: `DUPLICATE`, nothing stored, no review (that document is already in the queue). |
| Same sender resends while the duplicate already waits in `pending/` | Unchanged: `DUPLICATE`, no second pending copy. |
| Same client, same type, **different** checksum | Not a duplicate: the existing version workflow (`passport_v2.pdf`, …; H4 B for low confidence). |
| **Another** client has the same checksum | Unchanged cross-client protection: `CONFLICT`, `pending/unidentified/…`, not linked to either client, reason `CROSS_CLIENT_DUPLICATE`. |

Representation: the spec's "verification status REVIEW_REQUIRED / document stored" is expressed with the existing pending-review model, because a second `documents` row for the same client and checksum is forbidden by the unique index (the core duplicate protection). A waiting file in `pending/` is a review item by definition; no schema change.

Admin review (existing actions only; no new action):
- **Review Queue** lists it (status *Duplicate*, reason *Duplicate of a verified document*, filterable); it counts in *Pending review*.
- **Review Detail** shows the reason ("This document is an exact duplicate of an existing verified document for this client") and a *Duplicate of* row: the existing document's type, short ID, status and received date (looked up live by client + checksum; `duplicateOf` in `GET /review/:id`). No checksums or paths are returned.
- **Approve** is refused (409 `DUPLICATE_FILE`, "exact duplicate of the client's existing verified …"): the identical file is already on record.
- **Keep Pending** keeps it (the "keep" decision); **Remove from Review** deletes only the incoming copy (pending file, temporary original, submission row). The verified document is never touched.
- **Audit:** both actions record the admin, the duplicate (`temporary_id`), the existing document that matched (`document_id`), the client, the status (`DUPLICATE` → `DUPLICATE` or `REMOVED`), the reason, the time, and the checksum.

Code: `documentChecksumService.checkClientChecksum` (`existingVerified`), `storagePlacementService.decidePlacement` (`duplicateOfVerified`), `reviewReason.js` (`DUPLICATE_OF_VERIFIED`), `adminReviewService.findDuplicateMatch`, `adminReviewActionService` (Approve blocker, audit link). Tests: `test/duplicateVerifiedPolicy.test.js`, `admin/src/test/review.test.tsx` ("M4").

## 5. Pages and data

| Page | API | Shows |
|---|---|---|
| Overview | `GET /overview` | 4 KPI cards, client documents (completed / incomplete clients and missing documents, linked to the Clients and Missing Documents views), police reports overdue / due today / due soon (each links to the filtered Police Workflow), processing-status and type breakdowns (count + share), recent documents table, review-queue summary with the latest waiting files; Refresh |
| Documents | `GET /documents` | search, type, date range, sort, verification chips with counts, table (ID, client, type, status, confidence, received, "View client"), pagination; filters are kept in the URL |
| Client details | `GET /clients/:passportId`, `POST /documents/:id/police-date` | profile card with Complete / Incomplete badge, required-document checklist with missing summary, police slip/report panel with the 21-day follow-up (status, slip submitted, report due, days left or overdue, or why no countdown runs), stored documents table, files waiting for review; **Set date** / **Correct date** for the latest police slip and the list of date changes |
| Clients | `GET /clients` | summary cards (clients, complete, incomplete — click to filter; missing documents → Missing Documents), search (passport ID, unique ID, name, WhatsApp), completion and missing-type selects, table (client, WhatsApp, status, required documents with badges, missing, "View client"), pagination; all in the URL |
| Missing Documents | `GET /documents/missing` | incomplete clients count, one card per required type with the number missing (click to filter), search, type select, table of incomplete clients, pagination |
| Daily Report | `GET /reports/daily` | date field (max today), Previous day / Next day / Today; "Received on …" figures and by type and admin actions, or an empty state; "Current status" section labelled with its time |
| Police Workflow | `GET /police` | search (passport ID, unique ID, name), status cards (overdue, due today, due soon, pending; click to filter), status select with counts for all seven statuses, table (client, status, slip submitted, report due, days, police slip, final report, "View client"), pagination; filter and page in the URL |
| Review Queue | `GET /review` | summary cards (pending reviews, identity issues, quality / OCR issues, conflicts), filters (source, reason, type, order), table (item, client, type, review reason, confidence, received, status, "Review"), pagination; filters in the URL |
| Review detail | `GET /review/:id`, `GET /review/:id/file`, `POST /review/:id/approve`, `POST /review/:id/keep-pending`, `POST /review/:id/remove` | file preview (image or PDF) on the left; review-reason banner, document information (client, sender, received, statuses, confidence), identity, processing details, audit log and the **Approve** / **Keep Pending** buttons on the right. Approve asks for confirmation ("This will move the document to permanent client storage and mark it as verified."); Keep Pending asks for a required reason. While a request runs both buttons and the dialog are disabled. Success shows a message: after Approve the page shows the item as verified with the new audit entry and a link back to the queue (which reloads without it); after Keep Pending the item is reloaded with the new entry. Errors (e.g. a 409 conflict) are shown in the dialog with the server's message and nothing is marked done. If Approve isn't possible, the button is disabled with the reason. For a police slip the Approve dialog shows the submitted date read from the slip, or asks for it (required date field, 2000-01-01 to today); the audit log shows the date. Every item also has **Remove from Review** (for a stored document the dialog says only that document and its file are deleted and the client's verified document is not changed): a dialog that says the file and its record are permanently deleted, with a required reason and a required confirmation checkbox; after removal the page shows a message and the audit entry (no preview, no actions) and a link back to the queue. **Set Document Type** and **Assign Client** for waiting files (§4f). |

The header has **Sync** and the dark-mode toggle on every page (§4j). Every page has loading, error (with "Try again") and empty states. A 401 from the API signs the admin out (session expired or admin deactivated). API calls live only in `admin/src/api/`; pages use the typed functions through `useAdminResource`.

## 6. Design system

`admin/src/index.css` defines the Stitch tokens as a Tailwind v4 `@theme`:

- **Colours:** primary `#2563eb` (hover `#1d4ed8`, active `#1e40af`); canvas `#f8fafc`; surfaces `#ffffff` with `#e2e8f0` borders; dark sidebar `#0f172a` / `#1e293b`; status sets for verified, review, pending, critical and duplicate (text / background / border). Dark mode redefines the same tokens (§4j).
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
| Backend, final scope (`node:test`) | `npm test` (`test/adminClients.test.js`, `test/adminCorrections.test.js`, `test/adminReports.test.js`) | `REQUIRED_DOCUMENT_TYPES` default, accepted sets, 6 refused values, startup check; completeness in three queries, summary, same result as the client page and the Overview; search by passport/unique ID/name/number in both formats; `/clients` filters, summary, paging, 7 invalid-parameter cases, 401; `/documents/missing` order, filter, search, paging; set type (stays pending, audit before/after, validation, 409/404, rollback); assign client (link, sender and summary unchanged, then Approve works; reassignment keeps the old link; unknown client creates nothing; same client; stored document; admin from the token; 401); police date (countdown and Police Workflow updated, correction keeps the old date in the audit log, future/unreal/pre-2000 refused, Colombo midnight, only slips, 404/400); corrections never delete, move or create; status mapping complete, no `REJECTED`, `FAILED` not in the queue; daily report date rules (Colombo midnight), daily counts only that day, current figures labelled, empty day; `/reports/daily` 200/400/401; police search; no timers or clean-up jobs, only Remove from Review deletes a submission |
| Frontend, final scope (Vitest) | `npm run admin:test` (`phase10.test.tsx`, additions in `review.test.tsx`) | Clients (rows, badges, summary, search/filters/paging sent, empty, error), Missing Documents (rows, type filter, empty), Daily Report (default today, daily vs current, date selection, empty day, loading/error/retry), Police search, Client Details police date (validation, future date refused, request, reload with history, badge), Overview completeness links, Sync (one reload, filters kept, disabled while running, result, failure), dark mode (toggle, stored, restored, blocked storage, contrast of all text tokens in both themes, light tokens unchanged, no fixed colours in components); Set Document Type and Assign Client dialogs, availability, audit values |
| Frontend (Vitest, jsdom) | `npm run admin:test` | Checkpoint 1 auth/shell tests; Overview data, loading, error + retry, empty states, 401 → sign out; Documents rows, badges, chip counts, filters/sort/search sent to the API, pagination, empty/error states, link to client; Client details data, not-found, error; protected routes never call the API without a session |
| Backend, Checkpoint 3 (`node:test`) | `npm test` (`test/adminReview.test.js`) | migration is additive and matches the schema; every review reason and its precedence; processing writes the reason, the summary and the document link (identity conflict, low confidence, stored summary = logged summary, no PII); queue auth (no token, inactive admin) incl. detail and file routes; merged queue, shared waiting definition, filters/paging/kind, 9 invalid-parameter cases, window limit, legacy `LOW_CONFIDENCE`; detail for waiting file and stored document, unknown and malformed IDs; file streaming, headers, unknown item never touches storage, storage error → 502; CSP `blob:` only for images/frames |
| Frontend, Checkpoint 3 (Vitest) | `npm run admin:test` (`review.test.tsx`) | queue rendering, loading, error + retry, empty, filters and pagination, link to detail; detail rendering (reason, identity notes, sender, processing, client link, preview via token + blob URL), item without saved data, preview error, not found; protected routes |
| Backend, Checkpoint 4 (`node:test`) | `npm test` (`test/adminReviewActions.test.js`, fake database in `test/helpers/fakeReviewDb.js`) | migration additive, RLS/revoke, trigger, schema match; request-body rules; approve of a waiting file (storage move, VERIFIED document, submission resolved, audit fields), next version name, existing verified document blocks it, rollback + copy removal when any of the three writes fails, storage copy failure, unreadable file, checksum mismatch, duplicate file, unlinked file and `UNKNOWN` type, FAILED without pending copy → 404, approved twice, two approvals at once, two items of one type at once; approve of a stored `REVIEW_REQUIRED` document and its conflict; keep pending (file stays, still in queue, audit), stored document, reason required (6 cases), repeated and concurrent identical submits, keep pending then approve; detail history order and admin names, `actions`; 401 (no/bad token, inactive, deleted admin), 400/404, invalid JSON, 500 without details, admin taken from the token, no reject route, audit entries can't be changed through the API, the router's only write routes |
| Frontend, Checkpoint 4 (Vitest) | `npm run admin:test` (`review.test.tsx`, "Review actions") | only Approve and Keep Pending, no Reject; Approve confirmation and Cancel; successful approval (message, verified status, audit entry, queue reloads without the item); buttons disabled during the request, one request only; 409 and 502 messages shown; Keep Pending requires a reason; successful Keep Pending (trimmed reason sent, item reloaded with the entry); Keep Pending error; audit entries (action, admin, reason, time); Approve disabled with its reason |
| Backend (`node:test`) | `npm test` (`test/adminFrontend.test.js`, `test/adminApi.test.js`) | `/admin` serving (Checkpoint 1); `/api/admin` auth: no/invalid/expired token, deleted and inactive admin, ACTIVE admin, no-store, DB failure → 500; overview structure, safe serialization, Sri Lanka "today", fixed query count; documents pagination, filters, search, date range, sorting, 14 invalid-parameter cases, unknown parameters; client details, required-document rules, 404, invalid ID; business-day helpers |

Checked manually for Checkpoint 2 (not in the automated suite): the service queries against the live database (read-only, shapes and counts only), and the production build in headless Chrome with the admin API reading the live database read-only and a fake admin for sign-in: login redirect, Documents total and review-required filter match the database, "View client", required-document list, Overview totals, unknown client, no CSP violations or console errors.

Checked manually for Checkpoint 3 (not in the automated suite): the migration on a throwaway PostgreSQL 16 (Docker) as described in §4a; the real pipeline and the new queries against that database (six synthetic submissions: verified, SEC-008, low-confidence medical, identity conflict, police slip without date, failed — reasons, summaries without PII, document link, queue/filters/paging, detail, file lookup, overview total = queue total, `SET NULL`); and the production build in headless Chrome against that database (login redirect, queue rows = database, image and PDF previews from `blob:` URLs, disabled actions, stored document item, unknown item, no CSP violations or console errors). The live database was not changed (checked before and after).

| Backend, Checkpoint 5 (`node:test`) | `npm test` (`test/adminPolice.test.js`; additions in `test/policeDocuments.test.js`, `test/adminApi.test.js`) | thresholds 30/8/7/3/1/0/−1/−40 days, month/year/leap-year boundaries, `NOT_UPLOADED`, `DATE_MISSING` (undated slip, slip waiting in pending/), `COMPLETED` by a verified report (also before the slip, also without a slip), `REVIEW_REQUIRED` report doesn't complete, `REVIEW_REQUIRED` slip starts the countdown, latest date wins; `/police` order, counts, filter, paging, 5 invalid-parameter cases, 401, three queries only; Overview counts; client countdown; the Colombo midnight (18:29 vs 18:31 UTC); approve body date rules; waiting slip needs the date and records it on document and audit entry; OCR date confirmed, different date refused; undated stored slip gets the entered date; no date for other types; one-verified-slip rule unchanged; migration additive, no stored status; pipeline stores the resolved slip date and never a date for reports or medicals |
| Frontend, Checkpoint 5 (Vitest) | `npm run admin:test` (`police.test.tsx`, updated `dashboard.test.tsx`) | Police Workflow rows (status, dates, days text, slip/report, link), status cards and counts; filter by select and by card, paging; loading, error + retry, empty filtered view; protected route; Overview counts and links; client countdown (overdue, waiting slip, no slip); Approve of a slip: required date field, no request without it, date sent and shown in the message and audit log; OCR date shown for confirmation without a field; server refusal shown; no date field for other types |

| Backend, Remove from Review (`node:test`) | `npm test` (`test/adminReviewRemove.test.js`) | row and both files deleted, audit entry with admin, previous status, reason, type and checksum, checksum never returned, other items untouched, gone from queue and overview, detail 404, no undo; re-sent file no longer a pending duplicate; reason required (6 cases); stored document 409, unknown/FAILED 404, malformed 400; two removals at once; rollback when the audit write or the row delete fails; file deletion failure after commit; 401 for no/bad token and inactive admin; admin from the token; `actions.remove`; only this action deletes `temporary_data` rows (source check, no timers); migration additive |
| Frontend, Remove from Review (Vitest) | `npm run admin:test` (`review.test.tsx`, "Remove from Review") | button only when offered, no Reject; reason and confirmation required before anything is sent; request body; removed view (message, audit entry, no actions or preview, link back); dialog locked while running, one request, 409 shown |

Checked manually for the final scope (not in the automated suite): the new migration `20260926120000_phase10_audit_correction_values` on a throwaway PostgreSQL 16 (Docker) on top of the other eight — both columns nullable, `migrate status` up to date, no drift. With the real Prisma client against that database (13 checks): set type, assign to an unknown client refused and nothing created, the same assignment twice at once (one succeeds, one `SAME_CLIENT`), sender and summary kept, client record untouched, police date stored as `DATE`, Police Workflow `DUE_SOON` with 3 days left and search, audit before/after values, audit entries can't be changed, clients search by name and by number in the other format, missing view statuses, daily report counts. The production build in headless Chrome (fake database, 30 synthetic clients; 65 checks): login, Overview figures, Documents, Clients paging/search/filter, error state and retry, Missing Documents filter and empty state, Review Queue without the `FAILED` submission, Approve, Keep Pending, Set Document Type, Assign Client (sender unchanged, Approve then available), Remove from Review, no "reject" text, police slip date → due soon, Police Workflow filter and search, Daily Report and previous-day empty state, Sync (one reload, filter kept, result shown), dark mode on every page after reload, contrast of every visible text element in both themes, no unexpected failed requests, no CSP violations or console errors. In light mode the only text under 4.5:1 is the unchanged Stitch status colours (verified `#059669` 3.6–3.8:1, review `#d97706` 3.1–3.2:1, critical `#dc2626` on its tint 4.4:1). The live database was not used.

Checked manually for Remove from Review (not in the automated suite): the new migration on a throwaway PostgreSQL 16 (Docker) on top of the other six: existing audit row unchanged, both columns nullable and empty, no drift. With the real Prisma client against that database: the same item removed twice at once (one succeeds, one refused), the row deleted, a linked document kept with its link set to `NULL`, one audit entry with type, checksum, previous status and reason, both files deleted and the other item's files untouched, the entry can't be deleted. The production build in headless Chrome (fake database, synthetic data): the button, reason and confirmation required, removal, record and files gone with the entry kept, queue reloaded without the item, no failed requests, no CSP violations or console errors. The live database was not used.

Checked manually for Checkpoint 5 (not in the automated suite): all three migrations on a throwaway PostgreSQL 16 (Docker): the new migration applied on top of rows in every table (including an audit entry), the original columns of every existing row unchanged, both new columns `DATE NULL` and empty, no drift, the append-only trigger still active. The new code with the real Prisma client against that database: `DATE` round trip through the pipeline's write, the `/police` queries (including the per-client group of waiting slips), a legacy verified slip without a date shown as `DATE_MISSING`, a second slip blocked by the one-verified-slip rule, approval without the date refused and with it stored on the document and the audit entry, order, Overview counts and completion by a verified report. The production build in headless Chrome (fake database, synthetic data): Police Workflow rows and card filter, Overview counts, client countdown, Approve of a waiting slip (date required, then accepted and shown), no failed requests, no CSP violations or console errors. The live database was not used.

Checked manually for Checkpoint 4 (not in the automated suite): both Phase 10 migrations on a throwaway PostgreSQL 16 (Docker): existing rows byte-identical after the new migration; RLS on and no `anon`/`authenticated` rights on `audit_logs`; `UPDATE`, `DELETE` and `TRUNCATE` rejected by the trigger; deleting an admin with entries refused; no drift between the database and `schema.prisma`. Then the action services with the real Prisma client against that database (real transactions and row locks): same item approved twice at once, two items of one type at once, existing verified passport, a failure after the copy (real rollback, copy removed), concurrent identical Keep Pending, history with admin names, stored document approved in place, FAILED without pending copy, Prisma update/delete of an entry rejected. Finally the production build in headless Chrome (fake database, synthetic data): approve with confirmation, file moved, queue without the item, Keep Pending with required reason, audit entries, Approve disabled for an unlinked file, no failed requests, no CSP violations or console errors. The live database was not used.

## 9. Decisions (2026-09-25)

| Decision | Outcome |
|---|---|
| CSP `blob:` for images and frames only (in-page preview) | Approved |
| Items processed before the migration shown as "Not recorded" (no backfill) | Approved |
| Review Queue paging window of 1000 items | Approved for now |
| Audit log and approve/reject rules designed before review actions | Approved (done in Checkpoint 4; the rules then settled on no reject action) |
| `FAILED` submissions counted as pending review | Rejected — only files in `pending/` count |
| Apply the migration to the live database | On hold |
| Review actions: Approve and Keep Pending only; no reject workflow, unclear documents stay pending and are never deleted | Business rule (Checkpoint 4) |
| Approval never replaces an existing verified document of the same type (blocked with 409) | Business rule (Checkpoint 4) |
| Checkpoint 5 includes only the minimal Phase 9 data: `documents.police_submitted_date`, storing a resolved slip date, a calculated status | Approved (Checkpoint 5) |
| The date is stored in `documents.police_submitted_date`, not in `processing_summary` | Approved (Checkpoint 5) |
| A `VERIFIED` `POLICE_REPORT` completes the workflow, also when it arrived before the slip; a `REVIEW_REQUIRED` report does not | Approved (Checkpoint 5) |
| When approving a slip the admin enters or confirms the submitted date; recorded in the audit log (`audit_logs.police_submitted_date`) | Approved (Checkpoint 5) |
| A `REVIEW_REQUIRED` slip with a readable date starts the countdown | Approved (Checkpoint 5) |
| One verified document per type also for police slips; no replacement or versioning | Approved (Checkpoint 5) |
| Thresholds in Sri Lanka calendar days: >7 `PENDING`, 1–7 `DUE_SOON`, 0 `DUE_TODAY`, <0 `OVERDUE` | Approved (Checkpoint 5) |
| Admin upload of the actual police report; reminders, WhatsApp warnings, scheduled jobs, notifications | Out of scope (Checkpoint 5) |
| Pending documents are never removed automatically; an admin can **Remove from Review** after inspection, with confirmation and a required reason; not a rejection | Business rule (2026-09-26) |
| Remove from Review applies only to files waiting in `pending/` | Approved (2026-09-26); replaced the same day by the next row |
| H4: Remove from Review also for stored `REVIEW_REQUIRED` documents (only that row and file; never a `VERIFIED` document). New `UNCLEAR` documents of a type the client already has `VERIFIED` go to `pending/` instead of the client folder | Approved (2026-09-26, option A+B) |
| A removed item is gone permanently: pending file, temporary original and database row are deleted; only the audit entry stays (with type and checksum) | Approved (2026-09-26) |
| No undo / return to review for removed items | Approved (2026-09-26) |
| Final Phase 10 scope adds Clients, Missing Documents, configurable required documents, corrections, status mapping, Police search, Sync, Dark Mode, Daily Report (proposal Phase 11 item moved into Phase 10) | Approved (2026-09-26) |
| Required documents configured with `REQUIRED_DOCUMENT_TYPES` (environment), validated at startup; no Settings page | Approved (2026-09-26) |
| Corrections apply to waiting files (type, client) and stored police slips (date); each needs a reason and is audited with before/after values; assigning never creates a client | Approved (2026-09-26) |
| Sync = explicit reload of the data on screen; nothing else | Approved (2026-09-26) |
| Dark mode through the design tokens; light mode unchanged; choice stored per browser | Approved (2026-09-26) |
| Daily report separates daily and current figures; metrics without a data source are documented, not estimated | Approved (2026-09-26) |
| Roles stay deferred to Phase 12; any ACTIVE admin can use every action | Approved (2026-09-26) |

## 10. Known limitations and dependencies

- **Migrations not applied to the live database** — `20260925150000_phase10_review_data`, `20260925160000_phase10_review_audit_log`, `20260925170000_phase10_police_submitted_date`, `20260926090000_phase10_audit_removal_details` and `20260926120000_phase10_audit_correction_values` are on hold; do not deploy the backend code before all five are applied (§4c).
- **Light-mode status colours:** the Stitch status text colours on white or their tint are 3.1–4.4:1 (below WCAG AA 4.5:1 for small text). Light mode was kept unchanged as required; darkening them would be a Stitch design change to decide there.
- **Daily report history:** completeness and police figures are current only (§4i).
- **Removed items have no screen:** their history exists only as audit entries (the detail page is gone with the item). There is no audit-log page.
- **Who may act:** every dashboard account is an admin; any ACTIVE admin can approve, remove and correct until roles exist (Phase 12).
- **Verified police slips stored before Checkpoint 5 have no date:** they show `DATE_MISSING` until an admin sets the date on Client Details (§4f). A newer slip for the same client still can't be approved (one verified slip per type). No automatic backfill.
- **A waiting slip's OCR date is not kept:** `temporary_data` has no date column and the processing summary holds no dates, so approving a waiting slip always needs the date entered from the preview.
- **What counts as a resolved date** is the existing reader's rule: a single date labelled submitted, else issued, else an unlabelled one (confidence 60). The reader decides "not in the future" by the UTC date.
- **Police statuses and client completeness are calculated over all clients on each request** (`/police`, `/clients`, `/documents/missing`, Overview, daily report: three queries each, then in memory). Fine for thousands of clients; a larger client base would need the calculation in SQL.
- **No reminders:** due-soon, due-today and overdue are only shown on the dashboard. Warnings and notifications belong to Phase 11.
- **Processing failures are not shown in the dashboard:** a `FAILED` submission without a pending copy is not a review item (decision 2026-09-25). Its reason and summary are saved on the row; a separate view for failures can be decided later.
- **Older items:** submissions processed before the migration have no saved summary or reason ("Not recorded"); older stored `REVIEW_REQUIRED` documents have no link and are shown as `LOW_CONFIDENCE`. No backfill: the missing data was never saved.
- **Stored `REVIEW_REQUIRED` documents can't be re-typed or moved to another client** (they are already in a client folder); only waiting files can be corrected.
- **Versioning:** the pipeline stores a newer file of a type under the next version name (`passport_v2.pdf`, …; each row keeps its own status, so a client can have two `VERIFIED` rows of a type). An admin's Approve never adds a second verified document of a type (409 `VERIFIED_DOCUMENT_EXISTS`). A rule for replacing a verified document is not part of Phase 10.
- **Stray storage objects:** if the process stops between the copy and the commit, or removing the pending original fails, an unreferenced object can remain (logged in the second case); records stay correct. No clean-up job exists yet.
- **Duplicate Keep Pending** is detected as the same admin, item and reason within 60 seconds.
- **403 is never returned:** inactive admins get 401 (existing authentication rule); there are no roles.
- OCR boxes, zoom, rotation and the manual field confirmation from the Stitch design depend on stored OCR geometry and are not built.
- **Queue paging window:** 1000 items per filtered view (the two sources are merged in memory).
- **PDF preview:** shown in a frame from a `blob:` URL (plus "Open PDF in a new tab"); verified without CSP violations in headless Chrome, where the PDF viewer itself cannot be inspected.

## 11. After Phase 10

Phase 10 is complete in code, tests and documentation; the remaining step is deployment (apply the five migrations, then deploy). Later phases: Phase 11 reminders and warnings for police reports (not built here), Phase 12 roles and the move of the admin token to an httpOnly cookie. Open, undecided items: a view for failed submissions, a rule for replacing a verified document, daily snapshots for historical completeness figures.
