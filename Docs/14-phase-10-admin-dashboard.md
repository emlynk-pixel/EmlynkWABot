# Phase 10 — Admin Dashboard

Status: **Checkpoint 5 implemented (not yet committed). None of the three Phase 10 migrations is applied to the live database.**

| Checkpoint | Scope | Status |
|---|---|---|
| 1 | Frontend scaffold, admin login, route guard, dashboard shell | Done (`d0d7323`) |
| 2 | Read-only admin API (`/api/admin`), Overview, Documents, Client Details | Done (`90a0d6e`) |
| 3 | Review data migration, Review Queue, read-only Review Detail with secure file preview | Done (`4572bc0`) |
| 4 | Review actions (Approve, Keep Pending) with an append-only audit log | Done (`10bf997`) |
| 5 | Police Workflow: slip submitted date stored, calculated 21-day status, Police Workflow page, client countdown, Overview counts | Implemented |

Not built: a reject action (by business rule there is none, see §4c), assigning a client to an unlinked file, uploads (including the admin upload of the actual police report), exports, WhatsApp messaging, reminders or warnings for police reports (Phase 11), scheduled jobs, Settings, global search, client editing, batch actions, the Clients list page and the Missing-documents view.

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
| `/admin/review/:id` | Review detail | Document Review Detail | Real data (Checkpoint 3); Approve / Keep Pending (Checkpoint 4); police slip date (Checkpoint 5) |
| `/admin/clients` | Clients list | — | Placeholder; clients are opened from Documents/Overview |
| `/admin/police` | Police Workflow | Police Workflow | Real data (Checkpoint 5) |

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

## 4. Admin API (`/api/admin`)

### Authentication middleware

`createRequireActiveAdmin()` (`src/middleware/requireActiveAdmin.js`) runs before every `/api/admin` route:

1. the existing `authenticateAdmin` checks the Bearer JWT (HS256 only; missing → 401 "Authentication Token is required!", invalid/expired → 401 "Invalid or Expired Token");
2. the admin named in the token is loaded (profile fields only, never the password hash). If it no longer exists **or** its status is not `ACTIVE`, the answer is the same 401 "Invalid or Expired Token" — a deactivation takes effect on the next request, without saying why.

This is the same rule `GET /auth/me` applies; `/auth/me` itself is unchanged (a deleted admin still gets its existing 404 there). A database error is passed to the error handler (generic 500). Every `/api/admin` response has `Cache-Control: no-store`.

Errors are JSON: `{ "message": "…" }`, with `errors: [{ field, message }]` for invalid parameters (400). Review-action conflicts also carry a `code` (§4c). Unknown paths under `/api/admin` return 404 `{ "message": "Not found" }` (after authentication).

Every route is read-only except the two review actions in §4c. There is no 403: an inactive or deleted admin gets the same 401 as a bad token (existing rule above), and there are no roles yet.

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

Thirteen queries run in parallel (three of them for the police counts); the client is joined in the same query (no per-row lookups).

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
| `police` | latest stored police slip (with its `policeSubmittedDate`) and final police report, and `countdown`: the client's Police Workflow status (§4d) |

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

## 4c. Review actions and audit log (Checkpoint 4)

Only two review actions exist: **Approve** and **Keep Pending**. There is **no reject workflow** (business rule): no reject endpoint, button, status or reason, and nothing deletes a document because it is unclear. An unclear document stays pending until a person approves it.

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

### Consistency and duplicate protection

- Each action runs in one database transaction that first locks the reviewed row (`SELECT … FOR UPDATE`), re-reads its state and only then changes it. Approve also locks the client's `users` row, so two items of the same type for one client can't both become verified. Lock order is always reviewed row, then client.
- Storage can't join the transaction. Approve copies the file inside the transaction; if anything fails before the commit, the database rolls back and the copy is removed again. The pending original is removed only after the commit. The possible leftovers are a stray object (a copy in the client folder if the process dies before the commit, or the pending original if its removal fails, which is logged); the database is never left saying something the files don't match.
- A second Approve of the same item gets 409 `ALREADY_RESOLVED` (or 404 once the item is no longer a review item). An identical Keep Pending (same admin, item and reason) within 60 seconds gets 409 `DUPLICATE_ACTION`; a different reason or another admin is a new decision.
- The page disables both buttons and the dialog while a request runs; the server does not rely on that.
- A `FAILED` submission without a pending copy is not a review item: both actions answer 404 and change nothing.

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
| `action` | `APPROVE` or `KEEP_PENDING` |
| `temporary_id` | The submission, when there is one |
| `document_id` | The document created (approve of a waiting file) or reviewed (stored document) |
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

**Deployment dependency:** the backend code of Checkpoints 3–5 uses the columns and the table from all three Phase 10 migrations (`20260925150000_phase10_review_data`, `20260925160000_phase10_review_audit_log`, `20260925170000_phase10_police_submitted_date`). Apply them, in order, before deploying this code; deploying the code first breaks the review pages, the dashboard and document processing. None is applied to the live database yet.

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
| `page` / `pageSize` | 1–10000 / 1–100 | 1 / 25 |

Response: `businessDate`, `items` (per client: `client`, `status`, `submittedDate`, `dueDate`, `daysRemaining` — negative when overdue, `null` when completed or without a date — `slip`, `report`, `slipAwaitingReview`), `pagination`, `summary` (`total`, `byStatus` for every client, before the status filter) and `filters`. Order: most urgent first (`OVERDUE`, `DUE_TODAY`, `DUE_SOON`, `PENDING`, `DATE_MISSING`, `NOT_UPLOADED`, `COMPLETED`), then fewest days left, then passport ID. Read-only; three queries whatever the number of clients (clients, their police documents, slips waiting per client); no storage paths.

## 5. Pages and data

| Page | API | Shows |
|---|---|---|
| Overview | `GET /overview` | 4 KPI cards, police reports overdue / due today / due soon (each links to the filtered Police Workflow), processing-status and type breakdowns (count + share), recent documents table, review-queue summary with the latest waiting files; Refresh |
| Documents | `GET /documents` | search, type, date range, sort, verification chips with counts, table (ID, client, type, status, confidence, received, "View client"), pagination; filters are kept in the URL |
| Client details | `GET /clients/:passportId` | profile card, required-document checklist with missing summary, police slip/report panel with the 21-day follow-up (status, slip submitted, report due, days left or overdue, or why no countdown runs), stored documents table, files waiting for review |
| Police Workflow | `GET /police` | status cards (overdue, due today, due soon, pending; click to filter), status select with counts for all seven statuses, table (client, status, slip submitted, report due, days, police slip, final report, "View client"), pagination; filter and page in the URL |
| Review Queue | `GET /review` | summary cards (pending reviews, identity issues, quality / OCR issues, conflicts), filters (source, reason, type, order), table (item, client, type, review reason, confidence, received, status, "Review"), pagination; filters in the URL |
| Review detail | `GET /review/:id`, `GET /review/:id/file`, `POST /review/:id/approve`, `POST /review/:id/keep-pending` | file preview (image or PDF) on the left; review-reason banner, document information (client, sender, received, statuses, confidence), identity, processing details, audit log and the **Approve** / **Keep Pending** buttons on the right. Approve asks for confirmation ("This will move the document to permanent client storage and mark it as verified."); Keep Pending asks for a required reason. While a request runs both buttons and the dialog are disabled. Success shows a message: after Approve the page shows the item as verified with the new audit entry and a link back to the queue (which reloads without it); after Keep Pending the item is reloaded with the new entry. Errors (e.g. a 409 conflict) are shown in the dialog with the server's message and nothing is marked done. If Approve isn't possible, the button is disabled with the reason. For a police slip the Approve dialog shows the submitted date read from the slip, or asks for it (required date field, 2000-01-01 to today); the audit log shows the date. |

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
| Frontend, Checkpoint 3 (Vitest) | `npm run admin:test` (`review.test.tsx`) | queue rendering, loading, error + retry, empty, filters and pagination, link to detail; detail rendering (reason, identity notes, sender, processing, client link, preview via token + blob URL), item without saved data, preview error, not found; protected routes |
| Backend, Checkpoint 4 (`node:test`) | `npm test` (`test/adminReviewActions.test.js`, fake database in `test/helpers/fakeReviewDb.js`) | migration additive, RLS/revoke, trigger, schema match; request-body rules; approve of a waiting file (storage move, VERIFIED document, submission resolved, audit fields), next version name, existing verified document blocks it, rollback + copy removal when any of the three writes fails, storage copy failure, unreadable file, checksum mismatch, duplicate file, unlinked file and `UNKNOWN` type, FAILED without pending copy → 404, approved twice, two approvals at once, two items of one type at once; approve of a stored `REVIEW_REQUIRED` document and its conflict; keep pending (file stays, still in queue, audit), stored document, reason required (6 cases), repeated and concurrent identical submits, keep pending then approve; detail history order and admin names, `actions`; 401 (no/bad token, inactive, deleted admin), 400/404, invalid JSON, 500 without details, admin taken from the token, no reject route, audit entries can't be changed through the API, the router's only write routes |
| Frontend, Checkpoint 4 (Vitest) | `npm run admin:test` (`review.test.tsx`, "Review actions") | only Approve and Keep Pending, no Reject; Approve confirmation and Cancel; successful approval (message, verified status, audit entry, queue reloads without the item); buttons disabled during the request, one request only; 409 and 502 messages shown; Keep Pending requires a reason; successful Keep Pending (trimmed reason sent, item reloaded with the entry); Keep Pending error; audit entries (action, admin, reason, time); Approve disabled with its reason |
| Backend (`node:test`) | `npm test` (`test/adminFrontend.test.js`, `test/adminApi.test.js`) | `/admin` serving (Checkpoint 1); `/api/admin` auth: no/invalid/expired token, deleted and inactive admin, ACTIVE admin, no-store, DB failure → 500; overview structure, safe serialization, Sri Lanka "today", fixed query count; documents pagination, filters, search, date range, sorting, 14 invalid-parameter cases, unknown parameters; client details, required-document rules, 404, invalid ID; business-day helpers |

Checked manually for Checkpoint 2 (not in the automated suite): the service queries against the live database (read-only, shapes and counts only), and the production build in headless Chrome with the admin API reading the live database read-only and a fake admin for sign-in: login redirect, Documents total and review-required filter match the database, "View client", required-document list, Overview totals, unknown client, no CSP violations or console errors.

Checked manually for Checkpoint 3 (not in the automated suite): the migration on a throwaway PostgreSQL 16 (Docker) as described in §4a; the real pipeline and the new queries against that database (six synthetic submissions: verified, SEC-008, low-confidence medical, identity conflict, police slip without date, failed — reasons, summaries without PII, document link, queue/filters/paging, detail, file lookup, overview total = queue total, `SET NULL`); and the production build in headless Chrome against that database (login redirect, queue rows = database, image and PDF previews from `blob:` URLs, disabled actions, stored document item, unknown item, no CSP violations or console errors). The live database was not changed (checked before and after).

| Backend, Checkpoint 5 (`node:test`) | `npm test` (`test/adminPolice.test.js`; additions in `test/policeDocuments.test.js`, `test/adminApi.test.js`) | thresholds 30/8/7/3/1/0/−1/−40 days, month/year/leap-year boundaries, `NOT_UPLOADED`, `DATE_MISSING` (undated slip, slip waiting in pending/), `COMPLETED` by a verified report (also before the slip, also without a slip), `REVIEW_REQUIRED` report doesn't complete, `REVIEW_REQUIRED` slip starts the countdown, latest date wins; `/police` order, counts, filter, paging, 5 invalid-parameter cases, 401, three queries only; Overview counts; client countdown; the Colombo midnight (18:29 vs 18:31 UTC); approve body date rules; waiting slip needs the date and records it on document and audit entry; OCR date confirmed, different date refused; undated stored slip gets the entered date; no date for other types; one-verified-slip rule unchanged; migration additive, no stored status; pipeline stores the resolved slip date and never a date for reports or medicals |
| Frontend, Checkpoint 5 (Vitest) | `npm run admin:test` (`police.test.tsx`, updated `dashboard.test.tsx`) | Police Workflow rows (status, dates, days text, slip/report, link), status cards and counts; filter by select and by card, paging; loading, error + retry, empty filtered view; protected route; Overview counts and links; client countdown (overdue, waiting slip, no slip); Approve of a slip: required date field, no request without it, date sent and shown in the message and audit log; OCR date shown for confirmation without a field; server refusal shown; no date field for other types |

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

## 10. Known limitations and dependencies

- **Migrations not applied to the live database** — `20260925150000_phase10_review_data`, `20260925160000_phase10_review_audit_log` and `20260925170000_phase10_police_submitted_date` are on hold; do not deploy the backend code before all three are applied (§4c).
- **Verified police slips stored before Checkpoint 5 have no date:** they show `DATE_MISSING`, no action can set their date (they are not review items), and a newer slip for the same client can't be approved (one verified slip per type). No backfill.
- **A waiting slip's OCR date is not kept:** `temporary_data` has no date column and the processing summary holds no dates, so approving a waiting slip always needs the date entered from the preview.
- **What counts as a resolved date** is the existing reader's rule: a single date labelled submitted, else issued, else an unlabelled one (confidence 60). The reader decides "not in the future" by the UTC date.
- **Police statuses are calculated over all clients on each `/police` and Overview request** (three queries, then in memory). Fine for thousands of clients; a larger client base would need the calculation in SQL.
- **No reminders:** due-soon, due-today and overdue are only shown on the dashboard. Warnings and notifications belong to Phase 11.
- **Processing failures are not shown in the dashboard:** a `FAILED` submission without a pending copy is not a review item (decision 2026-09-25). Its reason and summary are saved on the row; a separate view for failures can be decided later.
- **Older items:** submissions processed before the migration have no saved summary or reason ("Not recorded"); older stored `REVIEW_REQUIRED` documents have no link and are shown as `LOW_CONFIDENCE`. No backfill: the missing data was never saved.
- **Unlinked files can't be approved:** a waiting file with no client (identity conflict, unknown passport, another client's file) or of type `UNKNOWN` can only be kept pending; choosing a client or type is not built.
- **One verified document per type:** approval is blocked when the client already has a `VERIFIED` document of that type, for every type (including police slips and medical reports). If a newer document should replace an older one, that needs a separate decision and action.
- **Stray storage objects:** if the process stops between the copy and the commit, or removing the pending original fails, an unreferenced object can remain (logged in the second case); records stay correct. No clean-up job exists yet.
- **Duplicate Keep Pending** is detected as the same admin, item and reason within 60 seconds.
- **403 is never returned:** inactive admins get 401 (existing authentication rule); there are no roles.
- OCR boxes, zoom, rotation and the manual field confirmation from the Stitch design depend on stored OCR geometry and are not built.
- **Queue paging window:** 1000 items per filtered view (the two sources are merged in memory).
- **PDF preview:** shown in a frame from a `blob:` URL (plus "Open PDF in a new tab"); verified without CSP violations in headless Chrome, where the PDF viewer itself cannot be inspected.

## 11. Next checkpoints

Not yet planned in detail. Open items for the complete dashboard: Clients list page, Missing-documents view, the Daily Summary figures of proposal §22 not yet shown, assigning a client or type to an unlinked waiting file, a view for failed submissions, a rule for replacing a verified document (including police slips), and Phase 11 reminders.
