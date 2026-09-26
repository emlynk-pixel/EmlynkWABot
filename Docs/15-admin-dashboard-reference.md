# Admin Dashboard — Reference

The EmlynkWABot admin dashboard is where staff check the documents clients send on WhatsApp, fix what the automatic processing could not decide, and follow each client's missing documents and police-report deadline. This page describes the finished Phase 10 dashboard: what each screen does, the rules behind every action, the settings, and where the implementation differs from the original proposal.

The development history, per-checkpoint tests and migrations are in [`14-phase-10-admin-dashboard.md`](14-phase-10-admin-dashboard.md). The visual design comes from the Stitch project *EmlynkWABot Admin Dashboard UI* (design system *Precision Enterprise Console*).

## At a glance

| | |
|---|---|
| Address | `/admin` on the backend server (e.g. `http://localhost:3000/admin/`) |
| Sign in | Admin email and password; the session lasts 1 hour |
| Who can use it | Any admin account with status `ACTIVE`. There are no roles yet (Phase 12). |
| Screens | Overview, Documents, Review Queue, Review Detail, Clients, Client Details, Missing Documents, Police Workflow, Daily Report |
| Actions | Approve, Keep Pending, Remove from Review, Set Document Type, Assign Client, Set Police Slip Date |
| Never | Reject, automatic removal of pending documents, creating clients, changing a client's WhatsApp number |
| Every action | Needs confirmation, is taken by the signed-in admin, and is written to an append-only audit log |
| Time | Every date and "today" is Sri Lanka time (`Asia/Colombo`) |

## 1. Signing in

1. Open `/admin`. Without a session you are sent to the sign-in page.
2. Sign in with your admin email and password. After too many failed attempts the login is rate-limited for a while.
3. The session ends after 1 hour, when you sign out, or when you close the browser tab. If your account is deactivated, your next request signs you out.

The first admin account is created on the server with `npm run admin:create` ([`13-security-overview.md`](13-security-overview.md)).

## 2. Screens

### Header (every page)

- **Breadcrumb** with the current section.
- **Sync** reloads the data on the current page from the server. Your filters, search and page are kept. While it runs the button shows *Syncing…* and can't be pressed again; afterwards the header shows *Synced HH:MM:SS* or *Sync failed*. Sync only reloads the page's data. It does not talk to WhatsApp or any other system.
- **Dark mode** toggle (moon / sun icon). The choice is remembered in this browser. Light mode is the default.
- Your name and role, and **Sign out**.

### Overview

Current figures for the whole system:

- **Total clients**, **Total documents** (stored in client folders), **Pending review** (waiting files plus stored documents marked *Review required*), **Received today** (WhatsApp submissions since midnight).
- **Client documents:** completed clients, incomplete clients and missing documents, linking to the Clients and Missing Documents screens.
- **Police reports:** overdue, due today and due soon (1–7 days), linking to the Police Workflow.
- Processing outcomes and document types of all submissions, recent documents, and the latest files waiting for review.

For one day's figures, use the **Daily Report**.

### Documents

Every file stored in a client folder. Search by document ID, client name, passport ID or unique ID; filter by type, verification status and received dates; sort by date, confidence or type. **View client** opens the client.

### Review Queue

Everything that needs a person:

- **Waiting files** in pending storage, which the automatic processing could not place (unclear, unknown type, identity not confirmed, conflicts).
- **Stored documents** marked *Review required* (read with low confidence).

Each row shows the reason, the confidence and when it was received. Filter by source, reason and type; the oldest items come first by default. **Review** opens the item. A submission whose processing *failed* is not listed unless a copy of its file is waiting in pending storage.

### Review Detail

A preview of the file (image or PDF, loaded privately through the server) with the review reason, document information, identity check, processing details and the item's **audit log**. The actions:

| Action | Available for | What it does |
|---|---|---|
| **Approve** | every item, unless blocked (the reason is shown) | A waiting file is copied into the client folder under the standard name and becomes a *Verified* document; the pending copy is removed. A stored document is marked *Verified*. A police slip needs its submitted date (entered, or confirmed if it was read from the slip). |
| **Keep Pending** | every item | Records your decision and reason; the item stays in the queue unchanged. |
| **Set Document Type** | waiting files | Changes the type (Passport, Police slip, Police report or Medical). The file stays pending; approve it afterwards. |
| **Assign Client** / **Change Client** | waiting files | Links the file to an **existing** client found by search. You must tick "I have checked that this file belongs to …". The file stays pending; approve it afterwards. |
| **Remove from Review** | waiting files and stored *Review required* documents | After you have inspected it: a waiting file is permanently deleted with its original copy and submission record; a stored *Review required* document is permanently deleted with its file in the client folder (the client's verified document and other documents are never touched). Needs a reason and the tick "I have inspected this file and understand it will be permanently deleted". There is no undo. The audit entry is kept. A *Verified* document can't be removed. |

Every action asks for confirmation. Keep Pending, Remove from Review and every correction need a reason (up to 500 characters). While a request runs the buttons are disabled, so a double click does nothing. If the server refuses an action, its message is shown and nothing changes.

**Approve is blocked** (and explains why) when the file has no client, the type has no client folder (Unknown), the client already has a verified document of that type, the same file is already stored for the client, or the file changed since it arrived.

### Clients

Every client with the status of their required documents.

- Cards: clients, complete, incomplete (click to filter) and missing documents (opens Missing Documents).
- **Search** by passport ID, unique ID, name (words in any order) or WhatsApp number. A number matches in either Sri Lankan format (`077…` or `9477…`).
- Filters: complete or incomplete, and a missing document type.
- Each row shows every required document as a badge, what is missing, and **View client**.

### Client Details

Profile, a *Complete* / *Incomplete* badge, the required-document checklist, stored documents and files waiting for review. The police panel shows the latest slip and final report and the **21-day follow-up** (status, slip submitted, report due, days left or overdue).

**Set date** / **Correct date** sets the submitted date of the latest stored police slip, for example for older verified slips that were stored without one. The date can't be in the future, and a reason is required. The countdown and the Police Workflow use the new date immediately, and the list of **date changes** shows who changed it, when and why.

### Missing Documents

Clients whose required documents are not all verified, with the most missing documents first. There is one card per required type with the number of clients missing it; click one to filter. Search works as on Clients.

*Missing* means nothing of that type has been received at all. A client whose files are received but still under review is incomplete, and their badges show *Review required* or *Pending review*.

### Police Workflow

The final police report is due **21 days after the police slip was submitted** (Sri Lanka calendar days).

| Status | Meaning |
|---|---|
| Overdue | the due date has passed |
| Due today | 0 days left |
| Due soon | 1–7 days left |
| Pending | more than 7 days left |
| Date missing | a slip exists, but its submitted date is not known (set it on Client Details) |
| Not uploaded | no police slip received |
| Completed | a verified police report is on file; the countdown stops (even if the report came before the slip) |

The status is calculated every time from the stored documents, and nothing about it is saved. Search by passport ID, unique ID or name, and filter by status. Reminders and WhatsApp warnings are not part of the dashboard (Phase 11).

### Daily Report

Figures for one **business day** in Sri Lanka (00:00–24:00). Pick a date (not in the future) or use *Previous day*, *Next day* and *Today*.

**Received on the chosen day:**

| Figure | Meaning |
|---|---|
| Documents received | WhatsApp submissions that passed the intake checks that day |
| Successfully processed | finished without an error: stored, held for review, or recognised as a duplicate |
| Failed processing | processing stopped with an error (and how many are still processing) |
| Unclear documents | read with low confidence (40–59 %) or unreliably (below 40 %) |
| Temporary documents | received that day and still waiting in pending storage |
| By document type | passport, police slip, police report, medical, unknown |
| Admin actions this day | approvals, keep-pending decisions, removals and corrections |

**Current status**, labelled with the time it was taken: completed and incomplete clients, missing documents, and police reports due soon, due today and overdue. These are always *now*, because no history of them is kept. For a past date the page says so rather than pretending they were that day's figures.

## 3. Rules

### No reject

The implemented workflow has no reject action, status, button or endpoint:

```text
Pending → Approve | Keep Pending | Set Document Type / Assign Client | Remove from Review
```

**Remove from Review** is an administrative decision to take one inspected file out of the queue. It is not a rejection, and it creates no status.

### Pending documents are never removed automatically

A pending item leaves the queue only when an admin approves or removes it. Nothing removes it because of age, inactivity, processing time, expiry, a server restart, a scheduled clean-up, duplicate detection or an OCR timeout. There is no timer or clean-up job, and automated tests check that this stays so.

### Required documents

A client is **complete** when every required document type has a *Verified* document. By default the required types are **Passport, Police report and Medical**. A police slip starts the 21-day countdown but does not replace the police report.

For each required type the status is *Verified* > *Review required* (stored, not yet verified) > *Pending review* (a file waits in pending storage) > *Missing* (nothing received). The same rule is used on every screen.

### Identity and client assignment

- A file is linked to a client automatically only when the processing is sure. Otherwise it waits for review.
- An admin can assign a waiting file only to an **existing** client. The dashboard never creates clients, never edits client records and never changes a WhatsApp number.
- The sender's number and the original identity check stay on the submission. The previous link, if any, is kept in the audit log.

### M4 — Duplicate Verified-Document Policy

A file sent on WhatsApp that is an exact copy of a document the same client already has **verified** is not silently discarded: it waits in the Review Queue with the reason *Duplicate of a verified document*, and Review Detail shows which verified document it copies. Approve is not possible (the identical file is already on record); choose **Keep Pending** or **Remove from Review**. Removing deletes only the incoming copy; the verified document is never changed. Both actions are audited, including which existing document matched. A different file of the same type follows the normal version rules; the same file from another client stays a cross-client conflict.

### One verified document per type

A new low-confidence (*Review required*) document of a type the client already has verified is not filed in the client folder: it waits in pending storage, where it can be approved (blocked while the verified one exists) or removed. Before this rule such documents could get stuck in the queue; those can now be removed.

An admin's approval never adds a second verified document of the same type for a client, and never replaces one; it is refused instead. The automatic processing names a newer file of a type with the next version (`passport_v2.pdf`, …) and keeps each file's own status. A rule for replacing a verified document is not part of Phase 10.

### Audit log

Every action is recorded in the same database transaction as the change itself, so an entry exists exactly when the action took effect. Each entry holds:

- the admin (always from the session, never from the request)
- the action
- the item and client
- the status before and after
- the reason and the time
- for corrections, the value before and after (type, passport ID or slip date)
- for removals, the removed file's type and checksum

The log is **append-only**: the API has no way to edit or delete an entry, and a database trigger rejects any change or deletion. Review Detail shows an item's history; Client Details shows police slip date changes.

## 4. Status words: proposal and implementation

| Proposal | In the dashboard and database |
|---|---|
| Missing | Requirement status *Missing*: nothing of a required type received |
| Received | A submission record exists (the file passed the intake checks) |
| Processing | Submission status `TEMPORARY_STORED` until processing ends |
| Verified | Document status `VERIFIED` (high-confidence read or an admin's Approve) |
| Temporary | Files still waiting in pending storage (every original is also kept in temporary storage) |
| Unclear | `UNCLEAR` (40–59 %, stored as *Review required*) or `UNDEFINED` (below 40 %, waiting for review) |
| Invalid | Refused at intake (unsupported type, too large, bad content); no record is created |
| Rejected | **Not implemented, by decision.** Use Keep Pending or Remove from Review. |
| Completed | Client: all required documents verified. Police Workflow: a verified police report exists. |

Other statuses: `MANUAL_REVIEW` and `CONFLICT` (held for review), `DUPLICATE` (the same file is already on record) and `FAILED` (processing error). `FAILED` stays separate from review.

## 5. Settings and running

| Setting | Where | Notes |
|---|---|---|
| `REQUIRED_DOCUMENT_TYPES` | server environment (`.env`) | Comma-separated; must include `PASSPORT`; allowed `PASSPORT`, `POLICE_SLIP`, `POLICE_REPORT`, `MEDICAL`. Default `PASSPORT,POLICE_REPORT,MEDICAL`. An invalid value stops the server at startup with a clear message; nothing falls back silently. Restart after changing it. |
| Dark / light mode | each admin's browser | Stored in the browser only |

There is no Settings page.

```bash
npm run admin:install   # once
npm run admin:build     # build the dashboard into admin/dist
npm start               # dashboard at http://localhost:3000/admin/
npm run admin:dev       # development server with live reload (backend must run too)
```

**Before deploying Phase 10**, apply the five Phase 10 database migrations to the live database, in this order. The new code needs them.

1. `20260925150000_phase10_review_data`
2. `20260925160000_phase10_review_audit_log`
3. `20260925170000_phase10_police_submitted_date`
4. `20260926090000_phase10_audit_removal_details`
5. `20260926120000_phase10_audit_correction_values`

All five are additive (new table and columns, nothing dropped), and all were tested on a throwaway database. None has been applied to the live database yet.

## 6. API

All endpoints are under `/api/admin` and need `Authorization: Bearer <token>` of an ACTIVE admin. Responses are never cached.

| Method | Path | Purpose |
|---|---|---|
| GET | `/overview` | Overview figures |
| GET | `/documents` | Stored documents (search, filters, sort, paging) |
| GET | `/documents/missing` | Incomplete clients and missing types (`documentType`, `search`, paging) |
| POST | `/documents/:documentId/police-date` | Set or correct a police slip date `{ policeSubmittedDate, reason }` |
| GET | `/clients` | Clients directory (`search`, `completion`, `missingType`, paging) |
| GET | `/clients/:passportId` | Client details |
| GET | `/review`, `/review/:reviewId`, `/review/:reviewId/file` | Review Queue, one item, its file |
| POST | `/review/:reviewId/approve` | Approve `{ reason?, policeSubmittedDate? }` |
| POST | `/review/:reviewId/keep-pending` | Keep Pending `{ reason }` |
| POST | `/review/:reviewId/remove` | Remove from Review `{ reason }` |
| POST | `/review/:reviewId/document-type` | Set Document Type `{ documentType, reason }` |
| POST | `/review/:reviewId/assign-client` | Assign Client `{ passportId, reason }` |
| GET | `/police` | Police Workflow (`status`, `search`, `passportId`, paging) |
| GET | `/reports/daily` | Daily Report (`date=YYYY-MM-DD`, default today) |

Errors are `{ "message": "…" }`; invalid input (400) adds `errors: [{ field, message }]`, and refused actions (409) add a `code` such as `ALREADY_RESOLVED`, `VERIFIED_DOCUMENT_EXISTS`, `CLIENT_NOT_FOUND` or `NOT_CORRECTABLE`. 401 means no or an invalid session, 404 an unknown item, 502 a storage failure, and 500 an unexpected error (no details are shown).

## 7. Security

- Documents are in a **private** storage bucket. The dashboard never receives a storage link or credential: files are streamed through the server to signed-in admins only and shown from a local browser copy.
- The session token lives in the browser tab's session storage and expires after 1 hour; the server checks on every request that the admin still exists and is ACTIVE. Moving it to an httpOnly cookie is planned for Phase 12.
- The server's Content Security Policy allows scripts only from the dashboard itself; the dashboard loads no external fonts or scripts.
- Responses contain no storage paths or checksums.

## 8. Decisions that differ from the proposal

| # | Topic | Decision |
|---|---|---|
| 1 | Reject | Removed from the workflow. No reject status, action or endpoint. |
| 2 | Remove from Review | Manual, after inspection, with a required reason and confirmation; permanently deletes the waiting file (with its original and record) or the stored *Review required* document (with its file); the audit entry stays; no undo; never a verified document. |
| 3 | Automatic removal | Pending documents are never removed automatically. |
| 4 | Audit log | Every admin action is recorded in an append-only table (`audit_logs`, protected by a database trigger). |
| 5 | Roles | Deferred to Phase 12; every ACTIVE admin can use every action; no 403 responses. |
| 6 | Identity assignment | Admins may link a waiting file to an existing client only; no client is created; the sender's number and the original identity result are kept. |
| 7 | Police report completion | A verified police report completes the workflow, whenever it arrived. Admins enter or confirm the slip's submitted date when approving, and can set or correct it later. There is no admin upload of the police report. |
| 8 | Required documents | Configured with `REQUIRED_DOCUMENT_TYPES` (environment, validated at startup); no document-type table and no Settings page. |
| 9 | Status words | Mapped to the implementation's states (§4); there is no separate FAILED directory. |
| 10 | Versioning | The pipeline stores newer files as `_v2`, `_v3`, …; admin approval never adds a second verified document of a type. |
| 11 | Error format | `{ message, errors?, code? }` instead of the proposal's `{ error: { code, message, reference } }`. |
| 12 | File access | Files are streamed through the authenticated server instead of short-lived signed URLs. |
| 13 | Pending storage naming | `pending/{unique_id}/undefined/uncleared-docs/`, or `pending/unidentified/{temporary_id}/…` when no client is known, instead of `pending/{mobile_number}/…`, so storage keys contain no phone numbers. |
| 14 | Daily reporting | Moved from Phase 11 into Phase 10. Daily and current figures are kept apart; figures without a data source are not estimated. |
| 15 | Sync | Means an explicit reload of the dashboard data only. |
| 16 | Dark mode | Added on top of the Stitch design through its colour tokens; light mode unchanged. |

## 9. Known limitations

- **Not deployed.** The five migrations above must be applied to the live database first.
- **No history for current figures.** A past day's completeness or police status can't be shown; that would need a daily snapshot or a history of verification changes.
- **Refused files aren't counted.** Invalid files are refused at intake and leave no record.
- **Removed files leave only an audit entry.** A file removed from review no longer counts as received on its day, and there is no screen listing removed files.
- **Stored documents can't be corrected.** A *Review required* document can't be re-typed or moved to another client, because it is already in a client folder.
- **Contrast in light mode.** The Stitch light status colours (green, amber and red badge text) have a contrast of 3.1–4.4:1, below the 4.5:1 guideline for small text. Light mode was kept unchanged as required; changing it would be a Stitch design decision. Dark mode meets 4.5:1 everywhere.
- **Calculated in memory.** Client completeness and police statuses are calculated over all clients on each request. That is fine for thousands of clients; a much larger client base would need the calculation moved into the database.
- **Not built here.** Reminders and warnings (Phase 11), roles (Phase 12), uploads, exports, global search and client editing.

## 10. Testing

| Command | What it runs |
|---|---|
| `npm test` | Backend tests (API, actions, corrections, audit, reports, rules) |
| `set RUN_OCR_TESTS=1&& npm test` | The same, plus the OCR tests on real files (Windows `cmd`) |
| `npm run admin:test` | Dashboard tests (screens, dialogs, Sync, dark mode and colour contrast) |
| `npm run admin:build` | Type-check and production build |

The finished dashboard was also checked on a throwaway PostgreSQL database with the real database client, and in headless Chrome against the production build: every screen and action, in light and dark mode, with the contrast of every visible text measured. Details are in [`14-phase-10-admin-dashboard.md`](14-phase-10-admin-dashboard.md) §8.
