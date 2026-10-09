# Admin Dashboard — Operator Guide

The EmlynkWABot admin dashboard is where staff check the documents clients send on WhatsApp, fix what the automatic processing could not decide, and follow each client's missing documents and police-report deadline. This page describes the finished Phase 10 dashboard: what each screen does, the rules behind every action, the settings, and where the implementation differs from the original proposal.

The development history, per-checkpoint tests and migrations are in [`09a-admin-dashboard-api.md`](09a-admin-dashboard-api.md). The visual design comes from the Stitch project *EmlynkWABot Admin Dashboard UI* (design system *Precision Enterprise Console*).

## At a glance

| | |
|---|---|
| Address | `/admin` on the backend server (e.g. `http://localhost:3000/admin/`) |
| Sign in | Email and password (Supabase Auth); the session is refreshed automatically and ends when you sign out |
| Who can use it | Any staff user with status `ACTIVE`. What each person can do depends on their role: `ADMIN`, `MANAGER`, `ANALYST` or `REGISTRATION_DESK` (section 6). |
| Screens | Overview, Documents, Review Queue, Review Detail, Candidates (Pool, Registration, Deployment Stages, Call Logs), Clients, Client Details, Missing Documents, Police Workflow, Daily Report, Invite User, Change Roles, Audit Logs, Settings |
| Actions | Approve, Keep Pending, Remove from Review, Set Document Type, Assign Client, Set Police Slip Date, Upload Candidate Document, Update Candidate Stage, Invite User, Change Roles, Deactivate User |
| Never | Reject, automatic removal of pending documents, changing a candidate's locked WhatsApp number, modifying or deleting audit logs |
| Every action | Needs confirmation, is taken by the signed-in admin, and is written to an append-only audit log |
| Time | Every date and "today" is Sri Lanka time (`Asia/Colombo`) |

## 1. Signing in

1. Open `/admin`. Without a session you are sent to the sign-in page.
2. Sign in with your email and password. Sign-in is handled by Supabase Auth, which also limits repeated failed attempts.
3. The session ends when you sign out or close the browser tab. If your account is deactivated, your next request signs you out.

**Forgot your password?** Use *Forgot password* on the sign-in page and enter your email. Supabase Auth sends a reset link (the page gives the same answer whether or not the email has an account); it opens `/admin/reset-password`, where you choose a new password and sign in again. If the link has expired or was already used, request a new one.

**First sign-in (invited users).** An `ADMIN` invites you from *Invite User*. Supabase Auth emails you an invitation link that opens `/admin/setup-password`, where you set your password and your account becomes `ACTIVE`. Outgoing auth emails use the SMTP server configured in the Supabase dashboard, not the application.

The first ADMIN is created on the server with `npm run user:create` (a Supabase Auth identity plus the application profile); everyone else is invited from the dashboard ([`SUPABASE_AUTH.md`](SUPABASE_AUTH.md)).

## 2. Screens

### Header (every page)

- **Breadcrumb** with the current section.
- **Review Queue Notification Bell**: Displays an alert bell icon in the top header with a real-time badge count of unread Review Queue submissions. Clicking the bell opens a dropdown panel listing recent pending items with quick navigation to `/admin/review/:id` and a "Mark all as read" button. Read/unread tracking is persisted in `localStorage` per staff user (`emlynk.admin.readNotifications.<userId>`).
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

**Failed processing** (Source filter, or the red "submissions failed processing" link on this page and the Overview): submissions whose processing stopped with an error, for example a PDF with too many pages or a storage outage. Nothing was stored for the client, and they are not counted as pending review. Opening one shows why it failed, the client (or *Not identified*), the sender, when it arrived and the file as received. **Retry processing** processes the original file again, like a new submission. You confirm it first, you can give a reason, and it is recorded in the audit log. It usually finishes within seconds. Afterwards the item appears where its result belongs, or again under *Failed processing* with the retry in its history. Nothing is stored twice. A file that fails for a fixed reason (for example too many pages) fails again; ask the client to send a new file instead.

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

### Candidates (Candidate Pool & Deployment)

The primary interface for managing candidate registrations and deployment workflows (`/admin/candidates`). In the dashboard sidebar, Candidates replaces the older Clients link.

- **Candidate Pool (`/admin/candidates`)**:
  - Lists candidates from `public.candidate` with server-side pagination.
  - Search by passport ID, unique ID, first or other name, NIC, or contact number.
  - Candidate summary card: passport ID, business unique ID (`0001`, `0002`...), candidate name, contact numbers, and a 6-stage deployment progress overview.
  - Action buttons: **Register Candidate** and **View/Edit Deployment**.
- **Candidate Registration (`/admin/candidates/new`)**:
  - Registers a new candidate into `public.candidate`.
  - Captures: Passport ID, NIC, First Name, Other Name, Date of Birth, Place of Birth, Passport Issue Date, Passport Expiry Date, Nationality, Sex, WhatsApp Number, Contact Number, Address, Job Experience, and initial stage notes.
  - Prevents duplicates on Passport ID, NIC, and WhatsApp number.
- **Candidate Deployment & Stage Tracking (`/admin/candidates/:passportId`)**:
  - Independent six-stage workflow for each candidate:
    1. **TEST_DETAILS**: Job ID, test result (`PASS`, `FAIL`), and test date.
    2. **CANDIDATE_DETAILS**: Bio and contact details. WhatsApp number is locked once set to maintain inbound document matching.
    3. **DOCUMENT_SUBMISSION**: Checklist of 5 required candidate documents (`PASSPORT`, `POLICE_REPORT` [SL Verified + Romania], `MEDICAL`, `AFFIDAVIT`, `SKILL_VIDEO`).
    4. **IVS_INTERVIEW**: Interview completion status and notes.
    5. **VISA_APPROVAL**: Visa processing completion status and notes.
    6. **FINALIZING_JOB**: Final deployment readiness completion status and notes.
- **Candidate Document Uploads & Removals**:
  - Direct browser-to-storage uploads via signed URLs (`POST /candidates/:passportId/documents/upload-target` and `POST /candidates/:passportId/documents/finalize`).
  - Stored documents can be removed with a mandatory reason via `POST /candidates/:passportId/documents/:documentId/remove`.
- **Candidate Call Logs**:
  - Slide-out drawer on the deployment screen.
  - Staff can record phone calls with timestamp, conversation notes, and staff attribution (`public.candidate_call_logs`).
- **Additional details step (`/admin/candidates/:passportId?tab=additional`)**:
  - The third circle of the candidate's progress stepper (after Candidate details), for every role that manages candidates (REGISTRATION_DESK included). IVS interview and Finalizing the job have no circle.
  - Sections: Passport & Personal Details, Clothing & Sizes, Father Details, Mother Details, Marital & Family Details, Employment / Skills.
  - The passport number is the candidate's own passport ID (read-only), so the details always belong to the existing candidate.
  - A new form is pre-filled from the candidate's record (name, address, date of birth). Those values are only stored when Save is pressed, and the candidate's record itself is never changed from this tab.
  - Father / mother details appear only when that parent is alive (the name is then required). Wife details appear only when married (her name is then required).
  - Pant and shoe sizes take a preset or a custom value.
  - If someone else saved the same candidate's details after you opened them, your save is refused with a message; press **Sync** to load their changes and try again (what you typed is kept until then).
  - Saved in `public.candidate_additional_details`. Every change is in Audit Logs with only the changed fields.

### Invite User (`/admin/invitations`) — ADMIN Only

- Accessible exclusively to users with the `ADMIN` role.
- Interface for inviting new console users (`/admin/invitations`).
- **Invite Form**: Enter email, display name, and select a role (`ADMIN`, `MANAGER`, `ANALYST`, `REGISTRATION_DESK`).
- Backend calls the Supabase Auth Admin API to send an invitation email with a link pointing to `${APP_BASE_URL}/admin/setup-password`.
- Displays the user list with account status: `INVITED`, `ACTIVE`, `INACTIVE`.
- Audited under `INVITE_USER` or `REACTIVATE_USER`.

### Change Roles (`/admin/roles`) — ADMIN Only

- Accessible exclusively to users with the `ADMIN` role.
- Interface for managing roles and deactivating staff users (`/admin/roles`).
- Table lists all staff accounts from `public."user"`.
- Role selector dropdown updates the user role via `PUT /api/admin/users/:userId/role` and applies immediately to the user's next request.
- Deactivate button sets user status to `INACTIVE` via `POST /api/admin/users/:userId/deactivate`.
- Self-role modification and self-deactivation are prevented.
- Audited under `UPDATE_USER_ROLE` and `DEACTIVATE_USER`.

### Audit Logs (`/admin/audit-logs`) — NEW FEATURE (ADMIN Only)

A centralized, immutable audit log viewer for all system operations, candidate modifications, document decisions, and staff lifecycle events.

- **Route**: `/admin/audit-logs`
- **Access**: Strictly **ADMIN only**. Non-admin roles (`MANAGER`, `ANALYST`, `REGISTRATION_DESK`) cannot see the navigation link in the sidebar, and direct URL access renders an `<AccessRestricted />` barrier while the backend API returns `403 { message: "Insufficient permissions" }`.
- **View-Only & Immutable**: The page provides view-only inspection. There are zero edit, delete, rollback, or clear endpoints in the system; database triggers block all row modifications.
- **Displayed Data**:
  - **Timestamp**: Exact event time formatted in Sri Lanka timezone (`Asia/Colombo`).
  - **Action**: Visual semantic badge (e.g. blue for Candidate, green for Approvals, purple for Staff, amber for Removals/Deactivations).
  - **Performed By**: Name, email, and current role of the staff member who executed the action.
  - **Candidate**: Passport ID and Candidate Name (if associated with a candidate).
  - **Category**: High-level classification (`Candidate`, `Documents`, `Staff`, `Review`).
  - **Change Summary**: Transition from `previousStatus` → `newStatus`, or detailed diff of `previousValue` → `newValue`.
  - **Reason / Notes**: Admin justification or notes entered when taking the action.
- **Comprehensive Filters**:
  - **Performed By (Staff)**: Dropdown filter by staff user.
  - **Candidate Filter**: Filter by passport ID or search query.
  - **Category Filter**: Filter by high-level category (`CANDIDATE`, `DOCUMENT`, `STAFF`, `REVIEW`).
  - **Action Filter**: Filter by specific action code (e.g., `CREATE_CANDIDATE`, `UPDATE_CANDIDATE`, `UPDATE_STAGE`, `APPROVE`, `REMOVE_DOCUMENT`, `UPDATE_USER_ROLE`).
  - **Date Range**: Date pickers for Start Date and End Date.
  - **Free-Text Search**: Searches across reason, values, passport ID, and staff details.
  - **Pagination Controls**: Selectable rows per page (10, 25, 50, 100), with Next/Previous server-side pagination.
  - **Clear Filters**: One-click reset to default view.
- **Audited Events**:
  - Candidate lifecycle: `CREATE_CANDIDATE`, `UPDATE_CANDIDATE`, `UPDATE_STAGE`.
  - Document actions: `UPLOAD_DOCUMENT`, `REMOVE_DOCUMENT`, `REPLACE_VERIFIED`, `KEEP_AS_VERSION`, `DELETE_TEMPORARY_DOCUMENT`.
  - Review queue decisions: `APPROVE`, `KEEP_PENDING`, `REMOVE_FROM_REVIEW`, `SET_DOCUMENT_TYPE`, `ASSIGN_CLIENT`, `SET_POLICE_DATE`, `RETRY_PROCESSING`.
  - Staff management: `INVITE_USER`, `REACTIVATE_USER`, `COMPLETE_INVITATION`, `UPDATE_USER_ROLE`, `DEACTIVATE_USER`.
- **API**: `GET /api/admin/audit-logs` (requires `ADMIN` role).

### Settings (`/admin/settings`) — ADMIN Only

- Dedicated console section for system integrations (`/admin/settings`).
- **Google Sheet Sync**:
  - Current sync state (`OK`, `CONFIG_ERROR`, `DATA_INTEGRITY`, `UNKNOWN`).
  - Target Hint: Last characters of the Google Spreadsheet ID and sheet tab name.
  - Write Gate Toggle: Enable or disable writing to the Google Sheet.
  - Sync Now: Immediately triggers a reconciliation run (`sheet_sync_runs`).
  - Test Connection: Verifies Google Sheets API credentials and tab headers.
  - Worker Heartbeat: Reports the last active heartbeat of the background sheet-sync worker.

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

A file sent on WhatsApp that is an exact copy of a document the same client already has **verified** is not silently discarded: it waits in the Review Queue with the reason *Duplicate of a verified document*, and Review Detail shows which verified document it copies. Approve is not possible (the identical file is already on record); choose **Keep Pending** or **Remove from Review**. Removing deletes only the incoming copy; the verified document is never changed. Both actions are audited, including which existing document matched. The same file from another client stays a cross-client conflict.

### One verified document per type (M4 Policy B)

A client never automatically ends up with two verified documents of the same type. **Different checksum + existing VERIFIED document of the same type → pending review; no automatic second VERIFIED document** — whatever the read quality, a different file of a type the client already has verified waits in pending storage instead of being filed automatically. (Before this rule, a well-read file became a further verified version automatically, `passport_v2.pdf`, …; a low-confidence one already waited, which is unchanged.)

Approve stays refused while the client's verified document exists. Two explicit actions are offered instead:
- **Replace Verified Document** — names exactly which existing verified document is being replaced, and asks for confirmation. The new file becomes the client's verified document; the old one is kept (file and history untouched) but marked *Superseded*, so it no longer counts as the client's current document of this type. Audited, with a link between the two documents.
- **Keep as Separate Version** — stores the new file in the client folder as *Review required*, alongside the existing verified one, which stays the client's current document. It can never become verified itself while the other one is verified.
- **Remove from Review** is also available, exactly as for any other waiting file.

A *Superseded* document is never deleted: its file and audit history stay, and it still appears in the Documents list, marked accordingly; it is simply no longer counted as the client's verified document of that type.

### Audit log

Every action is recorded in the same database transaction as the change itself, so an entry exists exactly when the action took effect. Each entry holds:

- the admin (always from the session, never from the request)
- the action
- the item and client
- the status before and after
- the reason and the time
- for corrections, the value before and after (type, passport ID or slip date)
- for removals, the removed file's type and checksum
- for a retry of a failed submission, the failure it replaced (reason code), with the type and client as they were

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

Other statuses: `MANUAL_REVIEW` and `CONFLICT` (held for review), `DUPLICATE` (the same file is already on record) and `FAILED` (processing error). `FAILED` stays separate from review: it is listed under *Failed processing*, never in Pending review.

## 5. Settings and running

| Setting | Where | Notes |
|---|---|---|
| `REQUIRED_DOCUMENT_TYPES` | server environment (`.env`) | Comma-separated; must include `PASSPORT`; allowed `PASSPORT`, `POLICE_SLIP`, `POLICE_REPORT`, `MEDICAL`. Default `PASSPORT,POLICE_REPORT,MEDICAL`. An invalid value stops the server at startup with a clear message; nothing falls back silently. Restart after changing it. |
| Dark / light mode | each admin's browser | Stored in the browser only (`localStorage`) |
| Google Sheet Sync | `/admin/settings` | Operational controls: Write Gate toggle, Sync Now, Test Connection |

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
6. `20260927120000_m1_async_processing` (background processing, below)
7. `20260927130000_m1_placement_path` (background processing, below)

All seven are additive (new table and columns, nothing dropped), and all were tested on a throwaway database. The first five are applied to the live database (checked 2026-09-26); the last two are not yet.

### Background processing (M1)

WhatsApp documents are processed in the background. When a document arrives, the server saves the file and records the submission, then answers WhatsApp at once (in tens of milliseconds); reading, classifying and filing the document happen right after, in a worker that runs inside the server. This answer time never depends on how long reading or filing the document takes — a slow scan or a busy text reader only slows the background work, never the acknowledgement to WhatsApp. A submission shows the status *Temporary stored* until the worker has finished, usually within seconds. If the server stops mid-way, the submission is picked up again after a restart (after at most 10 minutes); after three unfinished attempts it appears under *Failed processing*. The same WhatsApp message is never recorded twice, and a message is only confirmed to WhatsApp once it is recorded. A slow or stuck attempt can never overwrite a newer result, a retry never files a second copy of the same document, and no storage request can hang (1-minute limit). On shutdown the server finishes or hands back the running job and stops within 8 seconds.

## 6. API

All endpoints are under `/api/admin` and require a Supabase session (`Authorization: Bearer <access token>`) of an `ACTIVE` user. Role-based access control (RBAC) enforces endpoint permissions from `public."user".role` (`ADMIN`, `MANAGER`, `ANALYST`, `REGISTRATION_DESK`), always read from the database. Responses are never cached.

| Method | Path | Allowed Roles | Purpose |
|---|---|---|---|
| GET | `/overview` | ADMIN, MANAGER, ANALYST | Overview figures |
| GET | `/documents` | ADMIN, MANAGER, ANALYST | Stored documents (search, filters, sort, paging) |
| GET | `/documents/missing` | ADMIN, MANAGER, ANALYST | Incomplete clients and missing types (`documentType`, `search`, paging) |
| POST | `/documents/:documentId/police-date` | ADMIN, MANAGER | Set or correct a police slip date `{ policeSubmittedDate, reason }` |
| GET | `/clients` | ADMIN, MANAGER, ANALYST | Clients directory (`search`, `completion`, `missingType`, paging) |
| GET | `/clients/:passportId` | ADMIN, MANAGER, ANALYST | Client details |
| GET | `/candidates` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Candidate list (search, filters, paging) |
| POST | `/candidates` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Candidate registration `{ passportId, nic, firstName, ... }` |
| GET | `/candidates/:passportId` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Candidate details and stage status |
| PUT | `/candidates/:passportId` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Update candidate details |
| PUT | `/candidates/:passportId/stages/:stage` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Update candidate deployment stage `{ completed, notes, ... }` |
| POST | `/candidates/:passportId/documents/upload-target` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Issue signed upload URL for candidate document |
| POST | `/candidates/:passportId/documents/finalize` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Finalize and verify candidate document upload |
| POST | `/candidates/:passportId/documents/:documentId/remove` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Remove candidate document `{ reason }` |
| GET | `/candidates/:passportId/call-logs` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Candidate call logs |
| POST | `/candidates/:passportId/call-logs` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Record call log `{ note, createdDate }` |
| GET | `/candidates/:passportId/additional-details` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Additional details `{ passportId, details, suggested, updatedDate }` |
| PUT | `/candidates/:passportId/additional-details` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Save additional details (full replacement; audited) |
| GET | `/review`, `/review/:reviewId`, `/review/:reviewId/file` | ADMIN, MANAGER, ANALYST | Review Queue, one item, its file |
| POST | `/review/:reviewId/approve` | ADMIN, MANAGER, ANALYST | Approve `{ reason?, policeSubmittedDate? }` |
| POST | `/review/:reviewId/keep-pending` | ADMIN, MANAGER, ANALYST | Keep Pending `{ reason }` |
| POST | `/review/:reviewId/remove` | ADMIN, MANAGER, ANALYST | Remove from Review `{ reason }` |
| POST | `/review/:reviewId/document-type` | ADMIN, MANAGER, ANALYST | Set Document Type `{ documentType, reason }` |
| POST | `/review/:reviewId/assign-client` | ADMIN, MANAGER, ANALYST | Assign Client `{ passportId, reason }` |
| POST | `/review/:reviewId/retry` | ADMIN, MANAGER, ANALYST | Retry processing `{ reason? }` |
| POST | `/review/:reviewId/replace-verified` | ADMIN, MANAGER, ANALYST | Replace verified document `{ existingDocumentId, reason?, policeSubmittedDate? }` |
| POST | `/review/:reviewId/keep-as-version` | ADMIN, MANAGER, ANALYST | Keep document as version `{ reason? }` |
| GET | `/police` | ADMIN, MANAGER, ANALYST | Police Workflow (`status`, `search`, `passportId`, paging) |
| GET | `/reports/daily` | ADMIN, MANAGER, ANALYST | Daily Report (`date=YYYY-MM-DD`, default today) |
| GET | `/audit-logs` | ADMIN | View-only audit logs (search, user/candidate filters, dates, paging) |
| GET | `/users` | ADMIN | List staff users (under `/api/admin/users`) |
| POST | `/users/invite` | ADMIN | Invite a user `{ name, email, role }` |
| PUT | `/users/:userId/role` | ADMIN | Change a user's role |
| POST | `/users/:userId/deactivate` | ADMIN | Deactivate a user |
| GET | `/sheet-sync/settings` | ADMIN | Google Sheet Sync operational status |
| POST | `/sheet-sync/settings/write-gate` | ADMIN | Toggle Google Sheet writing `{ enabled }` |
| POST | `/sheet-sync/sync-now` | ADMIN | Trigger immediate reconciliation sync |
| POST | `/sheet-sync/test-connection` | ADMIN | Test Google Sheet connection |

Sign-in, sign-out, password recovery and setting a password from an invitation are Supabase Auth's, called by the dashboard directly; the backend only offers `GET /auth/me` and `POST /auth/complete-invite` (activates an invited user after they set a password).

Errors are `{ "message": "…" }`; invalid input (400) adds `errors: [{ field, message }]`, refused actions (409) add a `code` such as `ALREADY_RESOLVED`, `VERIFIED_DOCUMENT_EXISTS`, `CLIENT_NOT_FOUND`, `DUPLICATE_ACTIVE_ADMIN` or `NOT_CORRECTABLE`, and insufficient permissions (403) return `{ "message": "Insufficient permissions" }`. 401 means no or an invalid session, 404 an unknown item, 502 a storage failure, and 500 an unexpected error (no details are shown).

## 7. Security

- **Private Storage**: Documents reside in a private Supabase Storage bucket. The dashboard never receives raw storage credentials: files stream securely through the authenticated server. Direct uploads to candidate folders use time-limited, signed URLs issued by the API.
- **Supabase Auth & Bearer Tokens**: All authenticated requests pass `Authorization: Bearer <token>`. The server verifies tokens directly with Supabase Auth. Browser applications hold only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. The `SUPABASE_SERVICE_ROLE_KEY` is server-only.
- **Server-Side Authoritative RBAC**: Frontend sidebar navigation hiding is a user interface affordance only, **not** the security perimeter. The server-side `createRequireActiveUser` and `requireRole` middleware inspect the database `public."user"` row on every single request, validating `status === 'ACTIVE'` and the caller's role (`ADMIN`, `MANAGER`, `ANALYST`, `REGISTRATION_DESK`). Unauthorized requests fail closed with `403 { message: "Insufficient permissions" }`.
- **User Invitations & Password Lifecycle**: Invitations are managed through the Supabase Auth Admin API and dispatched via configured SMTP to `${APP_BASE_URL}/admin/setup-password`. Password recovery operates through Supabase Auth without disclosing email existence.
- **Immutable Audit Trail**: All administrative decisions, candidate creations, candidate updates, stage progress, document uploads/removals, role updates, and user invitations are immutably recorded in `audit_logs`, protected by database triggers.
- **Content Security Policy**: Helmet enforces strict CSP headers, preventing unauthorized script execution, frame injection, or untrusted network connections.
- **Responses contain no storage paths or checksums**: Candidate endpoints and audit endpoints strictly omit internal storage paths and credential details.

## 8. Decisions that differ from the proposal

| # | Topic | Decision |
|---|---|---|
| 1 | Reject | Removed from the workflow. No reject status, action or endpoint. |
| 2 | Remove from Review | Manual, after inspection, with a required reason and confirmation; permanently deletes the waiting file (with its original and record) or the stored *Review required* document (with its file); the audit entry stays; no undo; never a verified document. |
| 3 | Automatic removal | Pending documents are never removed automatically. |
| 4 | Audit log | Every admin action is recorded in an append-only table (`audit_logs`, protected by a database trigger). |
| 5 | Roles | Four roles (`ADMIN`, `MANAGER`, `ANALYST`, `REGISTRATION_DESK`) stored in `public."user".role`, enforced by `requireRole` middleware with safe 403 responses. |
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
| 17 | User invitations | An ADMIN invites a user; Supabase Auth sends the invitation email and the user sets their password on `/admin/setup-password`. Dashboard SMTP is configured in Supabase, and every step is audit-logged. |
| 18 | Password recovery | Handled by Supabase Auth: the reset link opens `/admin/reset-password`, and the forgot-password page never reveals whether an email has an account. |

## 9. Known limitations

- **Not deployed.** The five migrations above must be applied to the live database first.
- **Failed submissions can't be retried or closed.** They stay in the *Failed processing* list; the client has to send the file again. Files refused on arrival (wrong type, too large) leave no record at all.
- **No history for current figures.** A past day's completeness or police status can't be shown; that would need a daily snapshot or a history of verification changes.
- **Refused files aren't counted.** Invalid files are refused at intake and leave no record.
- **Removed files leave only an audit entry.** A file removed from review no longer counts as received on its day, and there is no screen listing removed files.
- **Stored documents can't be corrected.** A *Review required* document can't be re-typed or moved to another client, because it is already in a client folder.
- **Contrast in light mode.** The Stitch light status colours (green, amber and red badge text) have a contrast of 3.1–4.4:1, below the 4.5:1 guideline for small text. Light mode was kept unchanged as required; changing it would be a Stitch design decision. Dark mode meets 4.5:1 everywhere.
- **Calculated in memory.** Client completeness and police statuses are calculated over all clients on each request. That is fine for thousands of clients; a much larger client base would need the calculation moved into the database.
- **Not built here.** Reminders and warnings (Phase 11), roles (Phase 12), uploads, exports, global search and client editing.

## 10. Testing

Last full regression: 2026-09-27 (Phase 24) — WhatsApp-to-dashboard flow, security, admin actions, storage consistency, browser on three screen sizes in both themes; no product bugs found. Results and limitations: [`09a-admin-dashboard-api.md`](09a-admin-dashboard-api.md) §8.

| Command | What it runs |
|---|---|
| `npm test` | Backend tests (API, actions, corrections, audit, reports, rules) |
| `set RUN_OCR_TESTS=1&& npm test` | The same, plus the OCR tests on real files (Windows `cmd`) |
| `npm run admin:test` | Dashboard tests (screens, dialogs, Sync, dark mode and colour contrast) |
| `npm run admin:build` | Type-check and production build |

The finished dashboard was also checked on a throwaway PostgreSQL database with the real database client, and in headless Chrome against the production build: every screen and action, in light and dark mode, with the contrast of every visible text measured. Details are in [`09a-admin-dashboard-api.md`](09a-admin-dashboard-api.md) §8.
