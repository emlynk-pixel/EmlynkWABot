# Admin Dashboard — Operator Guide

The EmlynkWABot admin dashboard is where staff check the documents clients send on WhatsApp, fix what the automatic processing could not decide, and follow each client's missing documents and police-report deadline. This page describes the finished Phase 10 dashboard: what each screen does, the rules behind every action, the settings, and where the implementation differs from the original proposal.

The development history, per-checkpoint tests and migrations are in [`09a-admin-dashboard-api.md`](09a-admin-dashboard-api.md). The visual design comes from the Stitch project *EmlynkWABot Admin Dashboard UI* (design system *Precision Enterprise Console*).

## At a glance

| | |
|---|---|
| Address | `/admin` on the backend server (e.g. `http://localhost:3000/admin/`) |
| Sign in | Email and password (Supabase Auth); the session is refreshed automatically and ends when you sign out |
| Who can use it | Any staff user with status `ACTIVE`. What each person can do depends on their role: `ADMIN`, `MANAGER`, `ANALYST` or `REGISTRATION_DESK` (section 6 and 7). |
| Screens | Overview, Documents, Review Queue, Review Detail, Candidates (Pool, Registration, Deployment Stages, Call Logs), Need Attention (formerly Priority Follow-Ups), Jobs, Agents, Client Management (`/client-management`), Work Allocation, Clients (`/clients` — candidate documents), Client Details, Missing Documents, Police Workflow, Daily Report, Audit Logs, Settings (tabs: Change Roles, Invite User, Google Sheet Sync) |
| Actions | Approve, Keep Pending, Remove from Review, Set Document Type, Assign Client, Set Police Slip Date, Upload Candidate Document, Update Candidate Stage, Assign Candidates (Manual & Equal Distribution), Create / Manage Jobs, Assign / Release Candidates to Jobs, Manage Agents, Manage Employer Clients, Invite User, Change Roles, Deactivate User |
| Never | Reject, automatic removal of pending documents, changing a candidate's locked WhatsApp number, hard-deleting Agents / Clients / Jobs, silent overwrite of candidate allocations, modifying or deleting audit logs |
| Every action | Needs confirmation, is taken by the signed-in admin, and is written to an append-only audit log |
| Time & Dates | Every date and "today" is Sri Lanka time (`Asia/Colombo`). All date inputs use the modern reusable DatePicker (`react-day-picker`, `YYYY-MM-DD`, zero timezone shifting) |

## 1. Signing in

1. Open `/admin`. Without a session you are sent to the sign-in page.
2. Sign in with your email and password. Sign-in is handled by Supabase Auth, which also limits repeated failed attempts.
3. The session ends when you sign out or close the browser tab. If your account is deactivated, your next request signs you out.

**Forgot your password?** Use *Forgot password* on the sign-in page and enter your email. Supabase Auth sends a reset link (the page gives the same answer whether or not the email has an account); it opens `/admin/reset-password`, where you choose a new password and sign in again. If the link has expired or was already used, request a new one.

**First sign-in (invited users).** An `ADMIN` invites you from *Settings → Invite User*. Supabase Auth emails you an invitation link that opens `/admin/setup-password`, where you set your password and your account becomes `ACTIVE`. Outgoing auth emails use the SMTP server configured in the Supabase dashboard, not the application.

The first ADMIN is created on the server with `npm run user:create` (a Supabase Auth identity plus the application profile); everyone else is invited from the dashboard ([`SUPABASE_AUTH.md`](SUPABASE_AUTH.md)).

## 2. Screens

### Header (every page)

- **Breadcrumb** with the current section.
- **Review Queue Notification Bell**: Displays an alert bell icon in the top header with a real-time badge count of unread Review Queue submissions. Clicking the bell opens a dropdown panel listing recent pending items with quick navigation to `/admin/review/:id` and a "Mark all as read" button. Read/unread tracking is persisted in `localStorage` per staff user (`emlynk.admin.readNotifications.<userId>`).
- **Register Candidate** quick access (`/admin/candidates/new`): a button on every page, left of Sync, for the roles that can register candidates (ADMIN, MANAGER, REGISTRATION_DESK). It is the same registration form the Candidates page's *Add candidate* button opens; no other role sees it. On small screens it shows the icon only.
- **Sync** reloads the data on the current page from the server. Your filters, search and page are kept. While it runs the button shows *Syncing…* and can't be pressed again; afterwards the header shows *Synced HH:MM:SS* or *Sync failed*. Sync only reloads the page's data. It does not talk to WhatsApp or any other system.
- **Dark mode** toggle (moon / sun icon). The choice is remembered in this browser. Light mode is the default. See *Light and dark theme* below for how the colours work.
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

The Daily Report (`/admin/reports/daily`) provides operational transparency into daily recruitment and intake throughput for one **business day** in Sri Lanka (`00:00:00.000`–`24:00:00.000` `Asia/Colombo`), strictly avoiding UTC or server-local boundaries. Wording uses *Candidates* throughout.

#### Access & Role-Based Permissions (RBAC)

Daily Report access is strictly enforced by the backend (`requireRole` middleware) and reflected in the user interface:

- **Summary View (`GET /api/admin/reports/daily/summary`)**: Accessible to `ADMIN`, `MANAGER`, and `ANALYST`.
- **Summary by Roles View (`GET /api/admin/reports/daily/roles`)**: Accessible to `ADMIN` and `MANAGER` only. Other roles receive `403 { message: "Insufficient permissions" }` from the server, and the UI hides the tab.
- **`REGISTRATION_DESK`**: Has **NO access** to the Daily Report. Direct API requests fail closed with `403`, and no navigation link is rendered in the dashboard.
- Legacy endpoint `GET /api/admin/reports/daily` remains available for backwards compatibility (`ADMIN`, `MANAGER`, `ANALYST`).

#### Date Navigation & Reporting Window

The reporting window strictly encompasses **00:00 to 24:00 Sri Lanka time (`Asia/Colombo`)**.

The interface provides agile date navigation:
- **Today**: Quick button jumping to the current date in Sri Lanka.
- **Previous day**: Shifts the reporting window backward by 1 day.
- **Next day**: Shifts the reporting window forward by 1 day (disabled when viewing today; future dates are blocked).
- **Date picker**: A calendar field (`components/DatePicker.tsx`, built on `react-day-picker`): type a date as `YYYY-MM-DD` or open the calendar and use its month and year lists. Days after today are disabled. Admin date fields all use this one component; the stored value is always `YYYY-MM-DD`.

State synchronization: The chosen date (`date=YYYY-MM-DD`), active view tab (`view=summary` or `view=roles`), and selected role filter (`role=ANALYST|MANAGER|ADMIN|REGISTRATION_DESK`) are continuously synchronized with browser URL query parameters, preserving context across reloads and shares.

The selected date controls:
- Summary KPI metrics
- Registered candidates list
- Completed candidates list
- Visa completions count
- Calls taken list
- Documents submitted table and type breakdown
- Role-based activity and staff breakdown
- Structured PDF export

> [!IMPORTANT]
> **True Historical Activity vs. Current Snapshot Data**
> The Daily Report strictly differentiates between two data paradigms:
> 1. **True Daily Historical Activity**: What actually occurred during the selected Sri Lanka business day, based on authoritative event timestamps created at execution time (candidate record creation, final stage completion timestamp, visa approval stage completion timestamp, call log creation timestamp, WhatsApp intake reception, and staff document upload audit logs).
> 2. **Current State Snapshot**: Metrics describing the candidate pipeline *right now* as of the request time (`asOf`), specifically the **Incomplete Candidates** stage breakdown and the **Police Report Status** breakdown. Because the system does not maintain daily historical snapshots of incomplete candidate reasons or 21-day countdown timers, viewing a past date clearly labels these sections as describing the state *now*, not on the selected historical date.

---

#### Summary View

The Summary view presents five high-level KPI tiles, detailed activity tables, document breakdowns, and the current pipeline health.

##### 1. Summary KPI Metrics

| Figure | Source & Definition |
|---|---|
| **Candidates registered** | Authoritative candidate record creation timestamp (`candidate.created_date`) falling within the selected Sri Lanka business day. Set when the record is created via `createCandidate`. Documents are **not** required: a candidate registered without any document counts. |
| **Candidates completed** | Authoritative stage completion timestamp (`candidate_stages.completed_at`) for the final deployment stage, *Finalizing the job* (`FINALIZING_JOB`), falling within the selected day. |
| **Visa completed** | Authoritative stage completion timestamp (`candidate_stages.completed_at`) for the *Visa approval* stage (`VISA_APPROVAL`) falling within the selected day. |
| **Calls taken** | Phone call logs logged within the selected day (`candidate_call_logs.created_date`). |
| **Documents submitted** | Combined total of WhatsApp files received on that day (`temporary_data.created_date`) plus candidate documents uploaded by staff on that day (`audit_logs.action = 'UPLOAD_DOCUMENT'`). |

##### 2. Candidates Registered Detail

- **Business Rule: Candidate Registration != Document Submission**  
  Candidate registration and document submission are independent activities. Registering a candidate increments *Candidates registered* by 1 and adds 0 to *Documents submitted*. A candidate registered with zero documents is fully visible in both the count and the registered candidates detail list.
- **Displayed Table Fields**:
  - **Passport number**: Clickable link navigating to `/admin/candidates/:passportId`.
  - **Name**: Formatted candidate name (`firstName otherName` / surname).
  - **Registered**: Exact registration time in Sri Lanka timezone (`HH:mm`).
  - **Registered by**: Staff member who created the record, extracted from the `CREATE_CANDIDATE` audit log entry. Shows *—* when no audit entry exists (e.g. registered before registration auditing was introduced, or if passport ID was later corrected).
  - **Documents now**: Number of active documents currently on record (verified or pending review; superseded documents are excluded). Displays *No documents* when count is 0.
  - **Progress now**: Number of deployment stages complete now (e.g. *2 of 8 stages*).
- **List bounding**: Displays the first 10 rows with an expandable *Show all* toggle. The server caps the list at 200 items (`DAILY_LIST_LIMIT = 200`); if truncated, a note displays *Showing the first N of M*.

##### 3. Candidates Completed Detail

- Candidates whose final deployment stage (*Finalizing the job* / `FINALIZING_JOB`) was marked complete on the selected day (`completed_at`).
- **Displayed Table Fields**:
  - **Passport number**: Clickable link to candidate details.
  - **Name**: Candidate name.
  - **Completed**: Completion time (`HH:mm`).
  - **All stages now**: Badge showing *Complete* (if every stage is complete now) or *Some stages open* (because deployment stages are non-linear, a candidate may have finalized the job while another stage remains open).
- **List bounding**: Expandable preview (first 10 rows, then *Show all*), capped at 200 items with truncation notice.
- **Historical Limitation**: Stage completions rely on the stored `completed_at` timestamp. If a stage completion is later unticked or reversed by staff, no historical record of the previous completion is preserved, so the earlier day will no longer count it.

##### 4. Visa Completed Metric

- Derived from `candidate_stages.completed_at` where `stage = 'VISA_APPROVAL'` and `completed = true` within the selected business day. Reflects official visa clearance operations.

##### 5. Calls Taken Detail

- Phone call logs recorded during the reporting day (`candidate_call_logs.created_date`).
- **Displayed Table Fields**:
  - **Time**: Exact call timestamp (`HH:mm`).
  - **Candidate**: Candidate name (or *—*).
  - **Passport number**: Candidate passport ID.
  - **Handled by**: Staff member who recorded the call.
  - **Role**: Staff member's *current* role (e.g. Analyst, Manager, Admin, Registration Desk).
- Only stored fields are shown; call duration is not recorded in the database and is never estimated. A **No Answer** attempt is a call row like any other, so it is listed and counted here (it has no note, and the report never shows one). Expandable list, capped at 200 items.

##### 6. Documents Submitted & Type Breakdown

- Combines both intake pipelines:
  - **WhatsApp intake**: All inbound candidate files received on that day (`temporary_data.created_date`), regardless of processing outcome.
  - **Manual uploads**: Staff uploads performed via the candidate dashboard on that day (`audit_logs.action = 'UPLOAD_DOCUMENT'`), attributed to the uploading staff member.
- **Type Breakdown Table**:
  - Displays each supported candidate document type: `Passport`, `Police report` (Sri Lanka verified and Romania variants), `Medical`, `Affidavit`, `Skill video`, and `Scan` (strictly preserving the **ONE SCAN** policy; agreements and affidavits are not duplicated).
  - Columns: **Document type**, **Total**, **WhatsApp**, and **Manual**.
  - **Unclassified (`UNKNOWN`)**: Displays files received via WhatsApp that automatic classification could not type. This row is only displayed when unclassified files exist for that day.
- **WhatsApp Processing Outcome Line**:
  A summary line under the table details processing state: processed (*stored in candidate folder*, *held for review*, *duplicates*), failed, still processing, unclear, and still in temporary storage.

##### 7. Review and Admin Actions

- Collapsible section summarizing all administrative audit actions executed during the day (e.g. document approvals, corrections, stage updates, follow-up flags).

---

#### Current Pipeline Snapshot (Not Historical)

Clearly grouped under the *Current state* header with an exact generation timestamp (`As of DD Month YYYY, HH:mm. These show the state now, not on [selected date]: no history of them is kept`):

##### 1. Incomplete Candidates Breakdown

Evaluates actual candidate deployment progress across all 7 independent stages:
`TEST_DETAILS`, `JOB_DETAILS`, `CANDIDATE_DETAILS`, `DOCUMENT_SUBMISSION`, `IVS_INTERVIEW`, `VISA_SUBMISSION`, `VISA_APPROVAL`, `FINALIZING_JOB`.

- **Non-Linear Stages**: Stages are independent. Candidates can complete stages out of order; completing a later stage does not artificially complete prior stages.
- **Process Table**:
  - **Process**: Stage name.
  - **Candidates**: Total number of candidates with this stage currently open/incomplete.
  - **Main reasons**: Aggregated primary reasons why the stage is incomplete:
    - *Automatic bio stages*: Evaluated from candidate record (e.g. *Surname missing*, *Other names missing*, *NIC missing*, *Passport issue date missing*, *Passport expiry date missing*, *Job type missing*, *Job experience missing*, *WhatsApp number missing*).
    - *Automatic document stages*: Evaluated from stored verified/pending documents (e.g. *Passport document missing*, *Medical missing*, *SL Verified police report missing*, *Romania police report missing*, *Scan missing*).
    - *Test details*: Evaluated from test result (*Test failed* or *No test result recorded*).
    - *Manual stages*: *Not marked complete*.
  - **View Drill-Down**: Clicking *View* expands `<IncompleteDetails stage={stage} />`, displaying candidate passport numbers (linked), names, and specific failure reasons, paginated at **25 candidates per page** via `GET /api/admin/reports/daily/incomplete?stage=&page=`.

##### 2. Police Report Status

Current 21-day countdown status across all candidates, linking directly to `/admin/police`:
- **Due soon (1–7 days)**: Countdown has 1–7 days remaining.
- **Due today**: Exactly 0 days remaining.
- **Overdue**: Due date has passed without a verified police report.
- **Missing slip date**: Police slip exists on record, but submitted date is not recorded.
- **Slip not uploaded**: No police slip on record.

---

#### Summary by Roles View

Accessible exclusively to `ADMIN` and `MANAGER` roles. Allows management to inspect staff productivity by role for the selected day.

- **Role Selector**: Options for `Analyst`, `Manager`, `Admin`, and `Registration Desk` (internal codes `ANALYST`, `MANAGER`, `ADMIN`, `REGISTRATION_DESK`).
- **Role Activity KPIs**:
  - **Calls taken**: Total calls logged on the day by staff members currently holding the selected role.
  - **Documents uploaded**: Total candidate documents manually uploaded on the day by staff holding the selected role.
  - *WhatsApp exclusion*: Files received via WhatsApp have no staff actor and are **never** attributed to a role.
- **Documents Uploaded by Type**:
  Breakdown table showing counts of manual uploads by candidate document type for the selected role.
- **Staff Activity Table**:
  Lists all staff members possessing the selected role, displaying their account status (`ACTIVE` or inactive), individual calls count, and individual uploads count, sorted by total activity.
- **Activity Details Table**:
  Chronological feed of all actions executed by staff in this role (Time, Staff member, Action e.g. *Call* or *Uploaded Passport (SL Verified)*, Candidate name, Passport number). Capped at 200 items with truncation notice.
- **Current Role Attribution Rule**: Staff activity is grouped using each staff member's **current** role because historical role reassignment history is not versioned in the database.

---

#### Structured PDF Export

Clicking **Export PDF** generates a clean, vector-rendered A4 portrait PDF using `jspdf` directly in the browser, formatted according to the active view and filters:

- **Summary PDF (`daily-report-YYYY-MM-DD.pdf`)**:
  - Header with business date, scope ("today, so far" or "full day"), Sri Lanka timezone confirmation, and generation timestamp.
  - Key metrics table (all 5 KPIs).
  - Documents submitted table (with WhatsApp / manual split).
  - Registered candidates table (Passport number, Name, Registered time, Registered by, Documents now, Progress now).
  - Completed candidates table (Passport number, Name, Completed time, All stages now).
  - Incomplete candidates table by process with main reasons.
  - Police report status table.
  - Footer with page numbering (*Page X of Y*) and *Confidential* marking.
- **Role PDF (`daily-report-YYYY-MM-DD-<role>.pdf`)**:
  - Header tailored to the selected role and staff count.
  - Activity summary table (calls taken, documents uploaded).
  - Documents uploaded by type table.
  - Staff breakdown table (staff name, status, calls, documents).
  - Activity details table (time, staff member, action, candidate, passport number).
  - Role-specific footer with page numbering and *Confidential* marking.
- **Export Quality**: Structured layout (not a raster screenshot), automatic page breaks, repeated table header rows on every page, wrapped text cells to prevent clipping, and clean export support for empty days (rendering clear "None." or "No calls or uploads on this day." placeholders).

---

#### Performance Architecture

The Daily Report endpoints are architected for high concurrency and sub-second response times:
- **Server-Side Totals & Grouped Queries**: Aggregate totals are computed directly in PostgreSQL (`COUNT`, `groupBy`).
- **Bounded Lists**: Detail tables (calls, registered candidates, completed candidates, role activity) enforce server-side limits (`take: 200`, role rows capped at 1000) with explicit `truncated` flags.
- **No N+1 Queries**: Incomplete candidate analysis loads candidate bio, stage statuses, and required submission documents in a single batched query (`readProgress(db)`), evaluating stage rules in memory rather than querying the database per candidate.
- **Single-Query Relationship Resolution**: Candidate registrations and uploader identities are batch-resolved in single `audit_logs.findMany` queries using passport ID arrays.

---

#### Architectural & Reporting Limitations

1. **Current State Snapshots**: Incomplete candidates breakdown and police workflow statuses represent the system state *now*; no historical daily snapshots are stored.
2. **Stage Reversal**: *Candidates completed* and *Visa completed* rely on the stage record's stored `completed_at`. If a stage is later unmarked, historical reports for that day will no longer reflect the earlier completion.
3. **Current Role Attribution**: Staff activity in *Summary by Roles* uses each staff member's current role; historical role reassignment timelines are not preserved.
4. **Registration Attribution**: *Registered by* is read from the `CREATE_CANDIDATE` audit log entry. Registrations made prior to audit logging or candidates whose passport ID was modified show as *—*. Current documents and progress columns reflect current state, not state at registration.
5. **Deleted Review Items**: A WhatsApp submission removed from review (where the record is permanently deleted) no longer counts as received on its historical day.

### Candidates (Candidate Pool & Deployment)

The primary interface for managing candidate registrations and deployment workflows (`/admin/candidates`). In the dashboard sidebar, Candidates replaces the older Clients link.

- **Candidate Pool (`/admin/candidates`)**:
  - Lists candidates from `public.candidate` with server-side pagination.
  - **Search** runs in PostgreSQL before pagination, 100 candidates per page. It matches passport ID, unique ID, first or other name, NIC, contact number and WhatsApp number, case-insensitively, as a substring. The text is split on spaces (up to five words) and every word must match. A phone-like word (digits, an optional leading `+`, dashes) also matches the other Sri Lankan form, so `0771234567` finds a number stored as `94771234567` and the reverse. Numbers are matched as stored: spaces inside a number split it into words and are not normalised. A new search starts at page 1, and the search and page stay in the URL (`?search=…&page=…`).
  - Candidate summary card: passport ID, business unique ID (`0001`, `0002`...), candidate name, contact numbers, and a 6-stage deployment progress overview.
  - Action buttons: **Register Candidate** and **View/Edit Deployment**.
- **Candidate Registration (`/admin/candidates/new`)**:
  - Registers a new candidate into `public.candidate`.
  - Captures: Passport ID, NIC, First Name, Other Name, Date of Birth, Place of Birth, Passport Issue Date, Passport Expiry Date, Nationality, Sex, WhatsApp Number, Contact Number, Address, Job Experience, and initial stage notes.
  - Prevents duplicates on Passport ID, NIC, and WhatsApp number.
- **Candidate Deployment & Stage Tracking (`/admin/candidates/:passportId`)**:
  - Independent eight-stage workflow for each candidate:
    1. **TEST_DETAILS**: agent name, test ID, test result (`PASS`, `FAIL`), and test date.
    1b. **JOB_DETAILS** (second): the current Job's code and its Client (read-only, from the Job assignment), a date and a note.
    2. **CANDIDATE_DETAILS**: Bio and contact details. WhatsApp number is locked once set to maintain inbound document matching.
    3. **DOCUMENT_SUBMISSION**: Checklist of 5 required candidate documents (`PASSPORT`, `POLICE_REPORT` [SL Verified + Romania], `MEDICAL`, `AFFIDAVIT`, `SKILL_VIDEO`).
    4. **IVS_INTERVIEW**: Interview completion status and notes.
    5. **VISA_SUBMISSION**: Visa submission completion status and notes (completed by staff, like Visa approval).
    6. **VISA_APPROVAL**: Visa processing completion status and notes.
    7. **FINALIZING_JOB**: Final deployment readiness completion status and notes.
- **Candidate Document Uploads & Removals**:
  - Direct browser-to-storage uploads via signed URLs (`POST /candidates/:passportId/documents/upload-target` and `POST /candidates/:passportId/documents/finalize`).
  - Stored documents can be removed with a mandatory reason via `POST /candidates/:passportId/documents/:documentId/remove`.
- **Candidate Call Logs**:
  - Slide-out drawer on the deployment screen. It closes with X, Close, Escape, or a click outside it.
  - Staff can record phone calls with timestamp, conversation notes, and staff attribution (`public.candidate_call_logs`).
  - **Candidate History** (formerly Call History) shows the calls and the candidate's activity (documents received or verified, details and stages saved) as one timeline, newest first. The Current Documents block is no longer shown in the drawer. See `Docs/20-candidate-management.md` §4.3 for the event types and limits.
  - **Candidate History colours.** Call log = soft amber, No Answer = soft red, Candidate activity = soft green; the Need Attention flag is amber/orange (filled while open) and a completed follow-up is a muted check. Colour is only a supplement: every entry also has a label and an icon. The tints come from the theme tokens, so they have their own readable values in Light and Dark.
  - **No Answer** (in the add form) records an unanswered call attempt with no note and no message body; it shows in Candidate History as a No Answer badge with the date, time and staff member, and counts as a call (*Calls Taken*) in the Daily Report. It does not open a follow-up by itself; flag it with the flag icon, or switch **Need Attention** on first.
  - **Compact, responsive form.** *Add New Call Log* has a smaller vertical footprint (tighter spacing, compact labels and controls, widths and heights that adapt to the screen), so Candidate History gets most of the drawer on large and small displays. A chevron beside the heading collapses it (down chevron when expanded, up when collapsed): expanded shows Date, Time and the note; collapsed hides those fields. **Close**, **No Answer**, **Need Attention** and **Add call** are always visible. Collapsing keeps what was typed and is only a display state (not saved anywhere).
  - **Current Documents removed.** The block was removed from this drawer (and from the Need Attention page) to reduce clutter and free vertical space for the history and the action items. Only the display was removed: the API still returns `documentStatus`, and document status is still on the candidate page.
  - A compact flag icon beside the caller is the Need Attention indicator and action (the large per-call text button was removed); the call then appears on the Need Attention page (route `/follow-ups`, API and audit actions unchanged). **Need Attention** in the add form marks the new call when it is added, in the same request. The existing follow-up record is reused; there is no second follow-up mechanism.
- **Additional details step (`/admin/candidates/:passportId?tab=additional`)**:
  - The third circle of the candidate's progress stepper (after Candidate details), for every role that manages candidates (REGISTRATION_DESK included). IVS interview and Finalizing the job have no circle.
  - Sections: Passport & Personal Details, Clothing & Sizes, Father Details, Mother Details, Marital & Family Details, Employment / Skills.
  - The passport number is the candidate's own passport ID (read-only), so the details always belong to the existing candidate.
  - A new form is pre-filled from the candidate's record (name, address, date of birth). Those values are only stored when Save is pressed, and the candidate's record itself is never changed from this tab.
  - The father and mother names are always available (required only when that parent is alive); parent birthdays are always available. Wife details appear only when married (her name is then required). Child names are hidden when the marital status is Single.
  - Pant and shoe sizes take a preset or a custom value.
  - If someone else saved the same candidate's details after you opened them, your save is refused with a message; press **Sync** to load their changes and try again (what you typed is kept until then).
  - Saved in `public.candidate_additional_details`. Every change is in Audit Logs with only the changed fields.

### Need Attention (`/admin/follow-ups`)

Formerly *Priority Follow-Ups*. Calls flagged **Need attention** in a candidate's Call Log, so important follow-ups are not lost in a long history. In the sidebar after Candidates; visible to every role that uses call logs (ADMIN, MANAGER, ANALYST, REGISTRATION_DESK). Only the wording users read changed: the route, the API (`/api/admin/follow-ups`), the `call_log_follow_up` table and the audit actions keep their technical names.

- **By candidate**: each candidate appears once as a compact card with name, passport ID, WhatsApp (or contact) number and the number of follow-ups. Their follow-ups are listed inside, newest first, each with the call's date and time, who called, the note (a **No Answer** call shows a No Answer badge instead), who flagged it and when. Candidates with the newest follow-up come first. The *Current documents* block that used to be on each card was removed (the API still sends `documentStatus`; nothing renders it here).
- **Compact flag icon**: the follow-up's state is a small icon at the top right of each row, beside who called, like a call in Candidate History: a filled flag (*Needs attention*) while open, a muted check (*Follow-up completed*) once completed. It shows the state only; the large *Needs attention* text badge was removed.
- **Open / Completed**: *Open* (default) lists follow-ups that still need attention; *Completed* is the history, with who completed each and when, in quieter muted tones.
- **Mark complete** (a button in the row's footer): every role that uses call logs can mark a follow-up complete. It leaves the Open list; it is kept (completer and time stored) and shown under *Completed*. This behaviour did not change.
- **Delete** (ADMIN and MANAGER only): permanently deletes the follow-up after a confirmation. It removes the follow-up only: the original call log, the candidate and the candidate's documents are never touched, and the call stays in Candidate History. ANALYST and REGISTRATION_DESK don't see the button, and the server refuses them with 403 whatever the dashboard shows.
- The call note, call time and caller are always read from the original call log; the follow-up stores only its own status, who flagged and completed it, and when.
- Marking, completing and deleting are recorded in Audit Logs (*Candidate* category: `FLAG_FOLLOW_UP`, `COMPLETE_FOLLOW_UP`, `DELETE_FOLLOW_UP`).
- Loading, empty, error and in-progress states are shown, with a confirmation message after each action.

### Work Allocation (`/admin/work-allocation`) — ADMIN and MANAGER

Assigns candidates to Analysts. In the sidebar after Need Attention, accessible exclusively to `ADMIN` and `MANAGER`. For `ANALYST` and `REGISTRATION_DESK`, the navigation link is hidden, direct URL access displays an `<AccessRestricted />` barrier requesting no data, and backend APIs fail closed with `403 { message: "Insufficient permissions" }`.

- **Views:** *Unallocated* (default, with badge count) and *Allocated* (with an Analyst filter). Both provide server-side substring search (matching candidate name, passport ID, contact number, or WhatsApp number) and paginate at 100 candidates per page, ordered newest registered first.
- **Table:** Row checkbox, passport number (links to candidate deployment profile), candidate name, contact / WhatsApp number, registered date, current stage (and completed stages count), assigned Analyst (flagged *inactive* when the user is deactivated), and status.
- **Page-Level Selection:** Individual row checkboxes, **Select all on this page**, and **Clear selection**. Selection is strictly scoped to the active page: navigating to another page, changing the search term, or switching tabs clears the selection automatically, ensuring operations never act on unseen off-screen records.
- **Manual Allocation:** The allocation panel lists all active Analysts with their current candidate count. Staff can enter specific numbers per Analyst; the panel previews resulting workloads (*42 candidates → 52*) and validates that the sum equals the selection count before enabling **Assign**. **All** assigns the full selection to a single Analyst.
- **Equal Distribution (Automatic):**
  - Designed for high-volume intake: `ADMIN` and `MANAGER` can select multiple candidates and multiple active Analysts, then click **Auto Allocate**.
  - The backend automatically distributes eligible unallocated candidates equally among the selected Analysts using the deterministic formula:
    $$\text{equalAllocationCount} = \left\lfloor \frac{\text{eligibleCandidates}}{\text{analystCount}} \right\rfloor$$
  - **Remainder candidates:** Any surplus candidates ($\text{remainder} = \text{eligibleCount} - (\text{equalAllocationCount} \times \text{analystCount})$) remain safely unallocated in the pool.
  - **Conflict & Overwrite Protection:** Existing allocations are **never silently overwritten**. Any candidate in the selection who is already allocated to an Analyst is automatically skipped from equal distribution and returned in `conflictsCount` / `skippedCount`.
  - **Transaction & Concurrency Safety:** The operation runs inside an atomic PostgreSQL transaction (`db.$transaction`). Candidate rows are locked `FOR UPDATE` in a deterministic order (newest registered first, with passport ID as a tie-breaker), and target Analysts are locked `FOR SHARE`. This guarantees deterministic assignment order and prevents race conditions if multiple managers allocate concurrently.
  - **Audit Logging:** Every allocated candidate generates an append-only `ASSIGN_CANDIDATE` audit log entry recording the performing actor, candidate passport ID, and assigned Analyst.
- **Reassign:** When the selection includes already-allocated candidates, the panel switches to *Reassign N candidates*, requiring confirmation and displaying a list of current Analyst assignments before execution.
- **Unassign:** *Unassign N* prompts for confirmation and returns allocated candidates to the Unallocated pool (`DELETE` from `candidate_allocation`, logged as `UNASSIGN`).
- **Analyst Scoped Visibility:** Once allocated, an Analyst sees only their assigned candidates across Candidates, Need Attention, Clients, Documents, Missing Documents, and Police Workflow. Accessing an unassigned candidate URL returns `404 Candidate not found`. Analysts cannot register new candidates (as new registrations start unallocated).

### Job Management (`/admin/jobs`) — ADMIN, MANAGER (ANALYST Read Scoped)

Centralized management for recruitment demand orders (Jobs) placed by employer Clients, and the assignment of candidates to those jobs (`/admin/jobs`).

- **Entity Model**:
  - `JobType` (`job_type`): Controlled list of recruitment trade classifications (e.g. Tile Fitter with auto-generated code `TILE_FITTER`). Free-text job titles are not permitted.
  - `Job` (`job`): Represents an active or historical recruitment order placed by a Client.
  - `JobCandidate` (`job_candidate`): Relational join entity managing candidate assignment history, membership status (`is_active`), assignment timestamps, and release tracking.
  - `JobCodeCounter` (`job_code_counter`): Atomic yearly counter table providing sequential numbers for human-readable job codes.
- **Three Core Identifiers**:
  - **Internal Job ID (`job.id`)**: An immutable UUID primary key generated by PostgreSQL. Used as the foreign key target for all relational links (`job_candidate.job_id`, `candidate_form_link.job_id`) and API routes. Never changes and is never displayed as an operational identifier.
  - **Display Job Code (`job.job_code`)**: System-generated display reference formatted as `JOB-YYYY-NNNNNN` (e.g. `JOB-2026-000012`), atomically allocated per Asia/Colombo calendar year via `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`. Displayed across all tables, headers, and reports.
  - **Client Job ID (`job.company_job_id`)**: The employer organization's external reference code (e.g. `Y26S01` or `QAT-2026-B`). Displayed in the UI as **Client Job ID**.
    - *Column Name Retention:* The database column deliberately retains its technical name `company_job_id`. It represents the employer's external reference identifier, **not** an entity foreign key. Renaming the column would break operational continuity and existing database schemas without changing business semantics.
    - *Format and Validation:* Normalized to uppercase, trimmed, 1–40 characters from `A-Z 0-9 . _ / # -`.
    - *Uniqueness:* Enforced unique per Client when present via the partial unique index:
      `CREATE UNIQUE INDEX "job_company_job_id_key" ON "job"("client_id", "company_job_id") WHERE "company_job_id" IS NOT NULL;`
    - Can be modified at any time on jobs in any status by `ADMIN` or `MANAGER`.
- **Job Statuses & Lifecycle**:
  - **`PROCESSING`**: Active job order. The only status in which candidates can be assigned or released.
  - **`COMPLETED`**: Fulfilled job order. Finalizing a job atomically releases all active candidate memberships (`job_candidate.is_active = false`, recording `released_at`), while preserving complete assignment history.
  - **`CANCELLED`**: Cancelled job order. Requires an administrative justification note (`cancel_reason`). Atomically releases all active candidate memberships while preserving history.
  - *One-Way Lifecycle:* Once marked `COMPLETED` or `CANCELLED`, a job cannot return to `PROCESSING` (enforced by PostgreSQL status triggers).
- **Client & Responsible Agent Relationships**:
  - Every Job belongs to exactly one employer **Client** (`job.client_id` → `client.id`).
  - Records its **Responsible Agent** (`job.responsible_agent_id` → `agent.id`), which must match the Client's responsible Agent at creation time (`409 CLIENT_AGENT_MISMATCH` if mismatched).
  - The job's country is immutable and copied from the responsible Agent's country upon creation.
  - Moving a job (`PUT /api/admin/jobs/:id { clientId }`) is permitted only between Clients managed by the exact same responsible Agent.
  - Historical integrity: When a Client is reassigned to a new Agent, existing historical Jobs retain their original responsible Agent; only new Jobs use the new Agent.
- **Candidate Assignment Rules**:
  - Candidates are assigned via `POST /api/admin/jobs/:jobId/candidates { passportId }`.
  - **Single Active Job Rule:** A candidate can be assigned to **at most one `PROCESSING` job** at any time across the entire system.
  - *Enforcement:* Verified at three independent levels:
    1. Application service check under row-level locks (`FOR UPDATE` on candidate, `FOR SHARE` on job).
    2. Partial unique database index: `CREATE UNIQUE INDEX job_candidate_one_active_per_candidate ON job_candidate (passport_id) WHERE is_active = true;`.
    3. PostgreSQL trigger permitting `is_active = true` only when `job.status = 'PROCESSING'`.
  - Releasing a candidate (`DELETE /api/admin/jobs/:jobId/candidates/:passportId`) marks `is_active = false` and writes `released_at`. Records are never deleted.
  - Candidate deployment profile (`GET /api/admin/candidates/:passportId`) returns full `jobAssignments: { current, history }`.
- **Role-Based Access**:
  - `ADMIN` and `MANAGER`: Full management (create, update, complete, cancel, assign/release candidates, manage Job Types).
  - `ANALYST`: Scoped read-only access. Analysts can only view Jobs that hold candidates allocated to them, and can only see their own candidates within those jobs. Accessing other jobs returns `404 Not Found`.
  - `REGISTRATION_DESK`: No access to Jobs (routes return 403, hidden from navigation).

### Agent Management (`/admin/agents`) — ADMIN and MANAGER

Interface for managing overseas recruitment agency partners (`/admin/agents`).

- **Business Entity Definition**: An Agent is a *commercial recruitment business partner abroad* (e.g., an agency in Romania, UAE, or Poland). It is **not** a login user, not an Admin or Analyst, and has zero connection to the `public."user"` table or Supabase Auth.
- **Country Assignment**: Each Agent belongs to exactly **one country** (`country_code CHAR(2)`, validated against ISO 3166-1). An Agent cannot hold multiple countries.
- **Cardinality**: One Agent manages **many employer Clients** (1 → N).
- **Status & Lifecycle**:
  - Status is represented by `is_active` and exposed as `ACTIVE` or `INACTIVE`.
  - **No Hard Delete:** Agents are never deleted from the database. There is no `DELETE` endpoint, and foreign keys enforce `ON DELETE RESTRICT`. Inactive records remain queryable for audit and historical reporting.
  - **Protection of Active Work:**
    - An Agent cannot be deactivated (`INACTIVE`) while any Job with that `responsible_agent_id` remains in `PROCESSING` status (`409 AGENT_HAS_PROCESSING_JOBS`).
    - An Agent's country cannot be changed while active `PROCESSING` jobs exist (since existing jobs inherit that country).
    - An `INACTIVE` Agent cannot receive new Clients, cannot be targeted for Client reassignment, and cannot be assigned to new Jobs (`409 AGENT_INACTIVE`).
- **User Interface**:
  - Table: Agent name, Country, Active Clients count, Processing Jobs count, Completed Jobs count, Status badge, and Actions (View, Edit, Activate/Deactivate).
  - Server-side search and filtering by Country and Status with URL synchronization.
  - Details View: Profile facts, contact info (phone, WhatsApp, email, address, notes), managed Clients tab, and Jobs tab categorized by status (Processing, Completed, Cancelled).
- **Role Access**: Restricted strictly to `ADMIN` and `MANAGER`. `ANALYST` and `REGISTRATION_DESK` receive `403 Forbidden`.

### Client Management (`/admin/client-management`) — ADMIN and MANAGER

Interface for managing employer and customer companies seeking overseas recruitment (`/admin/client-management`).

- **Terminology Standard**: The employer organization is consistently called **Client**. The legacy term "Company" is retired from application code and documentation. The authoritative database table is `client` (renamed from `company`).
- **Cardinality & Relationships**:
  - One Client belongs to **one responsible Agent** (`client.agent_id` → `agent.id`, `ON DELETE RESTRICT`).
  - One Client can have **many Jobs** (`job.client_id` → `client.id`).
  - A Client's operational country is derived directly from its responsible Agent, ensuring a single source of truth without data drift.
- **Status & Lifecycle**:
  - Status is stored as `is_active` (`ACTIVE` / `INACTIVE`).
  - **No Hard Delete:** Clients are never hard-deleted; foreign keys enforce `ON DELETE RESTRICT`.
  - **Protection of Active Work:**
    - A Client cannot be deactivated while any Job associated with that Client is in `PROCESSING` status (`409 CLIENT_HAS_PROCESSING_JOBS`).
    - An `INACTIVE` Client cannot receive new Jobs or moved jobs (`409 CLIENT_INACTIVE`).
    - Activating a Client requires that its assigned Agent is currently `ACTIVE` (`409 AGENT_INACTIVE`).
  - **Changing a Client's Agent:** An explicit administrative action (`PATCH /api/admin/client-management/:id/agent`). Requires that the target Agent is `ACTIVE`. Crucially, existing historical Jobs retain their original responsible Agent; only newly created Jobs inherit the new Agent.
- **User Interface**:
  - Table: Client name, Country (inherited from Agent), Responsible Agent, Processing Jobs count, Completed Jobs count, Status badge, and Actions (View, Edit, Change Agent, Activate/Deactivate).
  - Search and filters: Free-text search, filter by Agent, filter by Country, filter by Status.
  - Details View: Profile facts, contact person, phone, WhatsApp, email, address, responsible Agent link, and Jobs tab listing jobs with status and active candidate counts.
- **Role Access**: Restricted strictly to `ADMIN` and `MANAGER`.

### Distinction: Legacy `/clients` vs. Employer `/client-management`

To prevent operational and architectural confusion, the dashboard maintains an explicit distinction between two unrelated modules:

| Feature | Technical Route | API Endpoint | Business Purpose | Entity Type |
|---|---|---|---|---|
| **Candidate Documents** | `/clients`, `/clients/:passportId` | `/api/admin/clients` | Tracking candidate document intake checklists, missing files, and police report countdowns | Candidate (`public.candidate`) |
| **Client Management** | `/client-management`, `/client-management/:clientId` | `/api/admin/client-management` | Managing overseas employer/customer organizations that place recruitment Job orders | Employer Client (`public.client`) |

The technical route `/client-management` was intentionally chosen to avoid namespace collisions with the legacy candidate document workflow (`/clients`), which predates the Client/Agent management module. They are completely independent features.

### Modern Date Picker Component

All native date inputs (`<input type="date">`) across the Admin Dashboard have been replaced with a unified, accessible, and timezone-safe `DatePicker` component (`components/DatePicker.tsx`, built upon `react-day-picker`).

- **Universal Deployment:** Used across Candidate Registration, Candidate Deployment Stages (Test Details, Passport Issue/Expiry), Additional Details panels, Call Log Drawer, Review Queue corrections (Police Slip Date), Documents filter range, Client Details, Daily Report date navigation, and Audit Log date ranges.
- **Authoritative Storage & API Format:** Strictly adheres to ISO `YYYY-MM-DD` string representation. The component never outputs arbitrary timestamps or localized date strings to application state or API payloads.
- **Rapid Month & Year Navigation:** Provides native dropdown select menus for Month and Year. This enables one-click navigation across extensive date ranges (e.g. birth years back to 1900 or passport expiry dates 15–20 years in the future) without repetitive month-by-month pagination.
- **Zero Timezone Date Shifting:** Pure calendar-day parsing and formatting using custom helpers (`formatDay`, `parseDay`). This prevents common JavaScript `new Date("YYYY-MM-DD")` UTC bugs where client timezone offsets (e.g. Asia/Colombo `UTC+05:30`) could shift dates backward to the previous calendar day.
- **Accessibility & Focus Management:** Full keyboard navigation support (Tab indexing, Arrow keys, Enter to select, Escape to close dialog). When a date is selected or the picker is dismissed, DOM focus is automatically returned to the trigger input field.
- **Responsive Layout:** Automatically renders as an accessible popover dialog that repositions dynamically to prevent viewport overflow on both desktop displays and mobile viewports.

### Invite User (Settings tab, `/admin/settings/invite`) — ADMIN Only

- Accessible exclusively to users with the `ADMIN` role. It is the **Invite User** tab of Settings; it is no longer a sidebar entry, and the old `/admin/invitations` URL redirects to this tab.
- Interface for inviting new console users.
- **Invite Form**: Enter email, display name, and select a role (`ADMIN`, `MANAGER`, `ANALYST`, `REGISTRATION_DESK`).
- Backend calls the Supabase Auth Admin API to send an invitation email with a link pointing to `${APP_BASE_URL}/admin/setup-password`.
- Displays the user list with account status: `INVITED`, `ACTIVE`, `INACTIVE`.
- Audited under `INVITE_USER` or `REACTIVATE_USER`.

### Change Roles (Settings tab, `/admin/settings/roles`) — ADMIN Only

- Accessible exclusively to users with the `ADMIN` role. It is the **Change Roles** tab of Settings (the first tab; `/admin/settings` opens it); it is no longer a sidebar entry, and the old `/admin/roles` URL redirects to this tab.
- Interface for managing roles and deactivating staff users.
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
  - Need Attention follow-ups (formerly Priority Follow-Ups): `FLAG_FOLLOW_UP`, `COMPLETE_FOLLOW_UP`, `DELETE_FOLLOW_UP`.
  - Document actions: `UPLOAD_DOCUMENT`, `REMOVE_DOCUMENT`, `REPLACE_VERIFIED`, `KEEP_AS_VERSION`, `DELETE_TEMPORARY_DOCUMENT`.
  - Review queue decisions: `APPROVE`, `KEEP_PENDING`, `REMOVE_FROM_REVIEW`, `SET_DOCUMENT_TYPE`, `ASSIGN_CLIENT`, `SET_POLICE_DATE`, `RETRY_PROCESSING`.
  - Staff management: `INVITE_USER`, `REACTIVATE_USER`, `COMPLETE_INVITATION`, `UPDATE_USER_ROLE`, `DEACTIVATE_USER`.
  - Google Sheet Sync: `SET_SHEET_DESTINATION` (a validated destination switch; no spreadsheet ID is recorded).
- **API**: `GET /api/admin/audit-logs` (requires `ADMIN` role).

### Settings (`/admin/settings`) — ADMIN Only

Settings is one sidebar item. Under the page title a horizontal tab row holds the administrator functions, one URL per tab (reload, Back and Forward keep the tab):

| Tab | Route | What it is |
|---|---|---|
| Change Roles | `/admin/settings/roles` | the Change Roles page described above |
| Invite User | `/admin/settings/invite` | the Invite User page described above |
| Google Sheet Sync | `/admin/settings/sheet-sync` | Sheet Sync status, actions and destination (below) |

- `/admin/settings` opens the first tab, Change Roles.
- **No Configurations tab.** It existed briefly and was removed; there is no general configuration or placeholder page. New system settings become tabs or sections here, not sidebar entries.
- **History.** Invite User and Change Roles used to be standalone sidebar entries; they were consolidated into Settings to reduce sidebar clutter. The old `/admin/invitations` and `/admin/roles` URLs redirect to the matching tab, so bookmarks keep working.
- **Permissions did not change.** Every tab is ADMIN only, as the pages were before; the backend enforces it on every API call. For any other role the sidebar has no Settings entry and every Settings URL (including the old ones) shows *Access Restricted* and requests no data. This consolidation changed navigation only: no authentication, permission or API behaviour.

#### Google Sheet Sync tab

One-way operational mirror of candidate data from the database to a Google Sheet (database → Sheet only; the database is the source of truth and Sheet edits are never read back). The tab groups its information, top to bottom:

- **Test Connection** and **Sync Now** (top right). Test Connection checks the active Sheet's access and headers without changing anything; Sync Now requests a reconciliation. Both run in the background on the worker.
- **Status summary:** *Connection* (for example *Connected · schema valid*), *Integration state* (OK, Not checked yet, Configuration error, or duplicate IDs: sync halted) and *Write sync* (Enabled or Disabled; while disabled, Sync Now runs a dry run). A notice appears if the background worker is not reporting.
- **Sync activity:** *Last automatic sync*, *Last manual sync*, *Latest sync* (each with a **Scheduled** or **Manual** badge), *Last written to the Sheet*, *Pending / failed candidate syncs*, and *In progress* while a run is active. The automatic schedule is shown next to the heading: **06:00 · 12:00 · 18:00 (Asia/Colombo)**.
- **Sync destination:** which Google Sheet the mirror writes to (below).
- **Last reconciliation:** its status, Scheduled or Manual, time and counts (appended / updated / unchanged, marked inactive).
- **Last failure:** the latest failure, or *No recent failures*.

The layout is grouped with subtle dividers and compact status tiles so state can be scanned quickly; every value and action that was on the page before is still there.

**Scheduled and manual sync are shown separately.**
- The automatic schedule did not change: 06:00, 12:00 and 18:00 Asia/Colombo (Cloud Scheduler).
- Whether a run is *automatic* comes from the run's recorded source (the scheduler), never from its clock time. Sync Now (and the operator command) runs are tracked as *manual*.
- So a manual sync at 13:45 is shown as the last manual sync; it does not appear to be the 12:00 run and does not replace the last automatic sync. A scheduled run that finishes a few minutes late is still automatic.
- A source that has never run shows *Not yet run*.
- This status is **global**: it is shared by every destination, not kept per destination.

**Sync destination.** A dropdown (*Google Sheet*) lists the Sheets configured for the worker, with the active one selected, followed by *Currently syncing to*, a short *Spreadsheet ID* hint and the *Tab*. Full spreadsheet IDs are never shown.
- **Today** only the existing operational Sheet is configured, so the dropdown has one option, already selected, and no switch action is offered. No example or placeholder Sheets are listed.
- **When more Sheets are configured** (a worker configuration change; see the Google Sheet Sync architecture document, Sync Destination): choose a Sheet, then click **Use this destination**. Choosing alone changes nothing; the explicit click prevents accidental changes.
- The server records the choice as *pending*; the worker then validates that Sheet (connection, tab, headers). Only if the check passes does it become the destination of every run (scheduled, Sync Now, Test Connection), and the change is written to Audit Logs (*Sheet sync destination changed*). If the check fails, the previous destination stays in use and the page shows the reason; a failed check does not make the working integration look broken.
- Switching never copies Sheet data into the database and never clears the previous Sheet.
- If the dropdown is missing and only the plain *Spreadsheet* row shows, the Cloud Run worker is still an old version that does not publish destinations; update the worker (see the troubleshooting section of the Sheet Sync document).
- Changing the destination is ADMIN only like the rest of Settings; there is no view-only role.

### Light and dark theme

Light is the default; Dark is a per-browser choice. One stylesheet, `admin/src/index.css`, holds the colour tokens (Tailwind v4 `@theme`; this token system has no `tailwind.config`). Components use the tokens (`border-border`, `border-border-strong`, `bg-surface`, …) and carry no fixed colours, so a token change reaches every screen.

| Theme | Where its values live |
|---|---|
| Light | the root token values (the `@theme` block) |
| Dark | `:root[data-theme="dark"]` |
| Candidates screens, Light | `:root:not([data-theme="dark"]) .ui-classic` (restores the pre-redesign canvas and text values, and had its own, lighter borders) |
| Candidates screens, Dark | `:root[data-theme="dark"] .ui-classic` |

**Light Theme border visibility.** Borders and dividers were too faint in Light (card edges, table rows, input and select boundaries, panels and dialogs), and the Candidates area was fainter still because `.ui-classic` overrode the border tokens with lighter values. Only the three existing Light border tokens were adjusted, in both the base and the `.ui-classic` Light blocks:

| Token | Before (main) | Before (Candidates) | Now (both) |
|---|---|---|---|
| `--color-border` | `#d5dce5` | `#e2e8f0` | `#c9d1dc` |
| `--color-border-strong` | `#b6c0cd` | `#cbd5e1` | `#a9b5c4` |
| `--color-border-focus` | `#8494a8` | `#94a3b8` | `#7a8ba1` |

The order border < strong < focus is kept, so hover and focus still read as stronger than the resting border. Dark Theme values (both Dark blocks) were not changed. No tokens were added, and backgrounds, surfaces, status colours, shadows, spacing and component logic were left alone. The Daily Report's one `border-border/60` row line now uses the normal `border-border`. The PDF exports use their own print styles and are unaffected.

## 3. Rules

### Database Architecture & Entity Relationships

The relational architecture reflects real-world overseas agency recruitment workflows, connecting international recruiting partners (Agents), employer organizations (Clients), operational job demand orders (Jobs), candidates, and internal staff allocations.

```text
Agent (1) ───────────< Client (many)
Client (1) ──────────< Job (many)
Job (many) >─────────< Candidate (many) via JobCandidate
Candidate (optional 1:1) ─> Analyst (public."user") via CandidateAllocation
```

- **Current Real Table Names**:
  - `agent`: Commercial recruitment partner entities abroad.
  - `client`: Employer / customer organizations. The authoritative table is **`client`** (renamed in place from legacy `company`). There is **no** `company` table in the database schema.
  - `job`: Recruitment job orders placed by employer Clients.
  - `job_candidate`: Relational join table linking candidates to jobs with historical status tracking.
  - `job_type`: Standardized trade/job classifications.
  - `job_code_counter`: Atomic sequence generator for human-readable job codes.
  - `candidate`: Candidate master records (formerly `users`).
  - `candidate_allocation`: Current operational assignment of candidates to staff Analysts.
  - `user`: Internal console staff accounts with RBAC roles (formerly `admins`).
- **Entity Relationships**:
  - **Agent 1 → many Client**: One Agent represents an overseas recruitment partner in a single country (`country_code CHAR(2)`). An Agent manages multiple employer Clients (`client.agent_id` → `agent.id`, `ON DELETE RESTRICT`).
  - **Client 1 → many Job**: One employer Client places multiple recruitment Job orders (`job.client_id` → `client.id`, `ON DELETE RESTRICT`). A Client inherits its operational country directly from its assigned Agent.
  - **Job many ↔ many Candidate (through `job_candidate`)**: Candidates join Jobs through the `job_candidate` join table (`job_id`, `passport_id`, `is_active`, `assigned_at`, `released_at`).
  - **Candidate optional Work Allocation → Analyst**: Candidates can be allocated to an active Analyst for processing (`candidate_allocation.analyst_id` → `user.id`).
- **`company_job_id` Intentional Naming**:
  - The column on table `job` deliberately retains the name `company_job_id`.
  - It represents the Client/employer organization's external reference code (e.g. `Y26S01` or `QAT-2026-B`), labeled in the UI as **Client Job ID**.
  - It is **not** an entity foreign key and does **not** reference the removed `company` table. Retaining this column name preserves backwards compatibility with existing shared database schemas and queries without distorting business domain semantics. Unique per client when set (`UNIQUE (client_id, company_job_id) WHERE company_job_id IS NOT NULL`).

### Master Data & Job Lifecycle Rules

- **No Hard Delete**: Neither Agents, Clients, nor Jobs can be hard-deleted from the database. There are no `DELETE` endpoints for master entities, and foreign keys enforce `ON DELETE RESTRICT`. Inactive records remain queryable for historical continuity and audit logs.
- **Active / Inactive Status**: Status is tracked via `is_active` boolean columns, exposed through the API as `ACTIVE` or `INACTIVE`.
- **Protection Against Inactive Work**:
  - An Agent cannot be deactivated (`INACTIVE`) while any Job with that `responsible_agent_id` is currently in `PROCESSING` status (`409 AGENT_HAS_PROCESSING_JOBS`).
  - An Agent's country cannot be edited while active `PROCESSING` jobs exist.
  - An `INACTIVE` Agent cannot receive new Clients or new Job assignments (`409 AGENT_INACTIVE`).
  - A Client cannot be deactivated while any Job with that `client_id` is in `PROCESSING` status (`409 CLIENT_HAS_PROCESSING_JOBS`).
  - An `INACTIVE` Client cannot receive new Jobs or moved jobs (`409 CLIENT_INACTIVE`).
  - Activating a Client requires that its assigned Agent is currently `ACTIVE` (`409 AGENT_INACTIVE`).
- **Controlled Client Agent Reassignment**:
  - Changing a Client's responsible Agent is an explicit administrative action (`PATCH /api/admin/client-management/:id/agent`).
  - The target Agent must be `ACTIVE`.
  - Existing historical Jobs retain their original responsible Agent; only newly created Jobs inherit the new Agent.
- **Single Active Job Rule for Candidates**:
  - A candidate can be assigned to **at most one `PROCESSING` job** at any given time.
  - Enforced concurrently via application service row locks (`FOR UPDATE`), partial unique index `job_candidate_one_active_per_candidate`, and database status triggers.
- **Job Finalization & Historical Data Preservation**:
  - A Job can transition from `PROCESSING` → `COMPLETED` or `PROCESSING` → `CANCELLED` (with mandatory `cancel_reason`).
  - Leaving `PROCESSING` atomically marks all active candidate memberships as released (`is_active = false`, recording `released_at`), while preserving complete assignment history.
  - Finalized jobs (`COMPLETED` or `CANCELLED`) can never return to `PROCESSING`.
- **Work Allocation Equal Distribution Rules**:
  - Distributed strictly via $\text{floor}(\text{eligible candidates} / \text{analyst count})$.
  - Remainder candidates remain unallocated in the pool.
  - Existing allocations are never silently overwritten (conflicts are skipped).
  - Executed inside an atomic transaction with candidate rows locked `FOR UPDATE` (deterministic order) and analysts locked `FOR SHARE`.

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
| Google Sheet Sync | `/admin/settings/sheet-sync` | Status, Sync Now, Test Connection and Sync Destination (ADMIN). Writing to the Sheet is switched by the worker's `SHEET_SYNC_ENABLED` environment variable, not from the dashboard; the configured Sheets by the worker's `SHEET_SYNC_DESTINATIONS` (or `SHEET_SPREADSHEET_ID` / `SHEET_TAB_NAME`) |

```bash
npm run admin:install   # once
npm run admin:build     # build the dashboard into admin/dist
npm start               # dashboard at http://localhost:3000/admin/
npm run admin:dev       # development server with live reload (backend must run too)
```

**Database Migrations (through Phase 10, Job Management, and Client Management)**:

1. `20260925150000_phase10_review_data`
2. `20260925160000_phase10_review_audit_log`
3. `20260925170000_phase10_police_submitted_date`
4. `20260926090000_phase10_audit_removal_details`
5. `20260926120000_phase10_audit_correction_values`
6. `20260927120000_m1_async_processing` (background processing, below)
7. `20260927130000_m1_placement_path` (background processing, below)
8. `20261018120000_job_management` (Job, JobType, JobCandidate, JobCodeCounter, Agent tables)
9. `20261019120000_client_management` (company → client rename, client.agent_id, contact columns, job.company_job_id IF NOT EXISTS)

All migrations are forward-only and data-preserving. They were verified against both clean databases and existing shared migration histories.

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
| GET | `/clients` | ADMIN, MANAGER, ANALYST | Clients directory (`search`, `completion`, `missingType`, paging) — legacy candidate document view |
| GET | `/clients/:passportId` | ADMIN, MANAGER, ANALYST | Client details — legacy candidate document profile |
| GET | `/candidates` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Candidate list (search, filters, paging; Analysts see allocated only) |
| POST | `/candidates` | ADMIN, MANAGER, REGISTRATION_DESK | Candidate registration `{ passportId, nic, firstName, ... }` (not ANALYST: a new candidate is unallocated) |
| GET | `/candidates/:passportId` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Candidate details and stage status (returns `jobAssignments: { current, history }`) |
| PUT | `/candidates/:passportId` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Update candidate details |
| PUT | `/candidates/:passportId/stages/:stage` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Update candidate deployment stage `{ completed, notes, ... }` |
| POST | `/candidates/:passportId/documents/upload-target` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Issue signed upload URL for candidate document |
| POST | `/candidates/:passportId/documents/finalize` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Finalize and verify candidate document upload |
| POST | `/candidates/:passportId/documents/:documentId/remove` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Remove candidate document `{ reason }` |
| GET | `/candidates/:passportId/call-logs` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Candidate call logs and candidate activity (Candidate History) |
| POST | `/candidates/:passportId/call-logs` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Record call log `{ note, calledAt, needsAttention?, outcome? }` (`outcome: "NO_ANSWER"`: no note needed) |
| POST | `/candidates/:passportId/call-logs/:callLogId/follow-up` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Mark a call for follow-up (201; 409 `FOLLOW_UP_EXISTS` if it already has an open one; 404 if the call isn't this candidate's) |
| GET | `/work-allocation/candidates?status&analystId&search&page` | ADMIN, MANAGER | Work Allocation list: Unallocated or Allocated candidates, 100 a page |
| GET | `/work-allocation/analysts` | ADMIN, MANAGER | Active Analysts with their candidate counts |
| POST | `/work-allocation/assign` | ADMIN, MANAGER | Manual assign / distribute / reassign `{ candidateIds, allocations: [{ analystId, count }], reassign? }` |
| POST | `/work-allocation/auto-allocate` | ADMIN, MANAGER | Equal distribution: automatically allocate eligible candidates equally among selected Analysts `{ candidateIds, analystIds }` |
| POST | `/work-allocation/unassign` | ADMIN, MANAGER | Return candidates to Unallocated `{ candidateIds, confirm: true }` |
| GET | `/jobs?view=processing\|completed\|cancelled&search=&page=` | ADMIN, MANAGER, ANALYST (scoped) | List recruitment Jobs (50/page) with tab counts (Analysts see jobs with their allocated candidates) |
| GET | `/jobs/:jobId` | ADMIN, MANAGER, ANALYST (scoped) | Job details, Client/Agent info, and assigned candidates list |
| POST | `/jobs` | ADMIN, MANAGER | Create Job `{ jobTypeId, clientId, responsibleAgentId?, vacancies?, companyJobId? }` |
| PUT | `/jobs/:jobId` | ADMIN, MANAGER | Update Job `{ vacancies?, jobTypeId?, clientId?, companyJobId? }` (Client Job ID editable in any status) |
| POST | `/jobs/:jobId/candidates` | ADMIN, MANAGER | Assign candidate to Job `{ passportId }` (single active PROCESSING job rule enforced) |
| DELETE | `/jobs/:jobId/candidates/:passportId` | ADMIN, MANAGER | Release candidate from Job (record kept with `released_at`, `is_active = false`) |
| POST | `/jobs/:jobId/complete` | ADMIN, MANAGER | Complete Job (auto-releases all active candidate memberships; immutable) |
| POST | `/jobs/:jobId/cancel` | ADMIN, MANAGER | Cancel Job `{ reason }` (auto-releases all active candidate memberships; immutable) |
| GET | `/job-options` | ADMIN, MANAGER | Active Job Types, active Clients of active Agents (with `agentId`), and active Agents |
| POST | `/job-types` | ADMIN, MANAGER | Create Job Type `{ name }` |
| GET | `/agents?search=&country=&status=&page=` | ADMIN, MANAGER | List Agents (25/page) with active client and processing/completed job counts |
| POST | `/agents` | ADMIN, MANAGER | Create Agent `{ name, countryCode, contactNumber?, whatsappNumber?, email?, address?, notes?, status? }` |
| GET | `/agents/:agentId` | ADMIN, MANAGER | Agent details: facts, contact info, managed Clients, and Jobs by status |
| PATCH | `/agents/:agentId` | ADMIN, MANAGER | Update Agent details (immutable ID; country change blocked if PROCESSING jobs exist) |
| PATCH | `/agents/:agentId/status` | ADMIN, MANAGER | Change Agent status `{ status: "ACTIVE" \| "INACTIVE" }` (blocked if PROCESSING jobs exist) |
| GET | `/agent-options` | ADMIN, MANAGER | All agents (all statuses, unpaged) for selectors and filters |
| GET | `/client-management?search=&agentId=&country=&status=&page=` | ADMIN, MANAGER | List employer Clients (25/page) with processing/completed job counts |
| POST | `/client-management` | ADMIN, MANAGER | Create employer Client `{ name, agentId, contactPerson?, contactNumber?, whatsappNumber?, email?, address? }` |
| GET | `/client-management/:clientId` | ADMIN, MANAGER | Employer Client details: facts, contact info, responsible Agent, and Jobs with candidate counts |
| PATCH | `/client-management/:clientId` | ADMIN, MANAGER | Update employer Client details (not Agent or status) |
| PATCH | `/client-management/:clientId/agent` | ADMIN, MANAGER | Change responsible Agent `{ agentId }` (ACTIVE agent required; existing Jobs keep historical Agent) |
| PATCH | `/client-management/:clientId/status` | ADMIN, MANAGER | Change status `{ status: "ACTIVE" \| "INACTIVE" }` (blocked if PROCESSING jobs exist) |
| GET | `/follow-ups?status` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Need Attention follow-ups grouped by candidate (default `OPEN`; at most 500 follow-ups, newest first) |
| POST | `/follow-ups/:followUpId/complete` | ADMIN, MANAGER, ANALYST, REGISTRATION_DESK | Complete a follow-up (409 `FOLLOW_UP_COMPLETED` if already completed); the row is kept |
| DELETE | `/follow-ups/:followUpId` | ADMIN, MANAGER | Delete the follow-up row only; the call log, candidate and documents stay |
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
| GET | `/reports/daily` | ADMIN, MANAGER, ANALYST | Daily figures (`date=YYYY-MM-DD`, default today in Sri Lanka); kept for backwards compatibility |
| GET | `/reports/daily/summary` | ADMIN, MANAGER, ANALYST | Daily Report Summary (`date=YYYY-MM-DD`): 5 KPIs (`candidatesRegistered`, `candidatesCompleted`, `visaCompleted`, `callsTaken`, `documentsSubmitted`), `documents`, WhatsApp metrics, `adminActions`, `calls`, `registeredCandidates`, `completedCandidates`, and `current` pipeline snapshot |
| GET | `/reports/daily/incomplete` | ADMIN, MANAGER, ANALYST | Candidates with one deployment stage incomplete now (`stage`, `page`; paginated at 25 per page) |
| GET | `/reports/daily/roles` | ADMIN, MANAGER | Summary by Roles (`date=YYYY-MM-DD`, `role` = `ADMIN` / `MANAGER` / `ANALYST` / `REGISTRATION_DESK`) |
| GET | `/audit-logs` | ADMIN | View-only audit logs (search, user/candidate filters, dates, paging) |
| GET | `/users` | ADMIN | List staff users (under `/api/admin/users`) |
| POST | `/users/invite` | ADMIN | Invite a user `{ name, email, role }` |
| PUT | `/users/:userId/role` | ADMIN | Change a user's role |
| POST | `/users/:userId/deactivate` | ADMIN | Deactivate a user |
| GET | `/settings/sheet-sync/status` | ADMIN | Sheet Sync status: connection, integration state, write gate, sync activity, queue counts, reconciliation, and destination |
| POST | `/settings/sheet-sync/test` | ADMIN | Test Connection: queues a read-only check on the worker (202) |
| POST | `/settings/sheet-sync/run` | ADMIN | Sync Now: queues a reconciliation (202) |
| PUT | `/settings/sheet-sync/destination` | ADMIN | Ask to switch the Sync Destination `{ key }` |
| GET | `/settings/sheet-sync/runs/:runId` | ADMIN | One run's status and result |

Sign-in, sign-out, password recovery and setting a password from an invitation are Supabase Auth's, called by the dashboard directly; the backend only offers `GET /auth/me` and `POST /auth/complete-invite` (activates an invited user after they set a password).

Errors are `{ "message": "…" }`; invalid input (400) adds `errors: [{ field, message }]`, refused actions (409) add a `code` such as `ALREADY_RESOLVED`, `VERIFIED_DOCUMENT_EXISTS`, `CLIENT_NOT_FOUND`, `AGENT_NOT_FOUND`, `JOB_NOT_FOUND`, `AGENT_HAS_PROCESSING_JOBS`, `CLIENT_HAS_PROCESSING_JOBS`, `AGENT_INACTIVE`, `CLIENT_INACTIVE`, `CLIENT_AGENT_MISMATCH`, `CANDIDATE_ON_ACTIVE_JOB`, `COMPANY_JOB_ID_EXISTS`, `DUPLICATE_ACTIVE_ADMIN` or `NOT_CORRECTABLE`, and insufficient permissions (403) return `{ "message": "Insufficient permissions" }`. 401 means no or an invalid session, 404 an unknown item, 502 a storage failure, and 500 an unexpected error (no details are shown).

## 7. Security & Role-Based Access Control (RBAC)

The security model implements strict defense-in-depth across storage, authentication, and database authorization:

### Role Permissions Matrix

All application endpoints enforce server-side role validation via `requireRole` middleware inspecting `public."user".role`. Frontend navigation visibility is merely an affordance; backend APIs fail closed (`403 Forbidden`).

| Capability / Resource | ADMIN | MANAGER | ANALYST | REGISTRATION_DESK |
|---|:---:|:---:|:---:|:---:|
| **Agent Management** (`/agents`, `/api/admin/agents`) | Full | Full | None (403) | None (403) |
| **Client Management** (`/client-management`, `/api/admin/client-management`) | Full | Full | None (403) | None (403) |
| **Job Management** (`/jobs`, `/api/admin/jobs`) | Full | Full | Read-Only (Scoped to allocated candidates) | None (403) |
| **Work Allocation** (`/work-allocation`, `/api/admin/work-allocation/*`) | Full | Full | None (403) | None (403) |
| **Candidate Registration** (`/candidates/new`, `POST /candidates`) | Yes | Yes | No (Unallocated by default) | Yes |
| **Candidate Deployment & Profile** (`/candidates/:passportId`) | Full | Full | Scoped (Allocated candidates only) | Full |
| **Candidate Documents** (Upload & Removal) | Yes | Yes | Yes (Allocated candidates only) | Yes |
| **Call Logs & Need Attention** (`/follow-ups`) | Full (Delete open) | Full (Delete open) | Scoped (Flag & Complete) | Full (Flag & Complete) |
| **Review Queue** (`/review`) | Full | Full | Full | None (403) |
| **Police Slip Date Correction** | Yes | Yes | No (403) | No (403) |
| **Daily Report (Summary View)** | Yes | Yes | Yes | None (403) |
| **Daily Report (Summary by Roles)** | Yes | Yes | None (403) | None (403) |
| **Audit Logs** (`/audit-logs`) | Full (View Only) | None (403) | None (403) | None (403) |
| **Settings (User Roles, Invites, Sheet Sync)** | Full | None (403) | None (403) | None (403) |

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
| 16 | Dark mode | Added on top of the Stitch design through its colour tokens. Light mode's colours were unchanged then; its border tokens were later strengthened (see *Light and dark theme*). |
| 17 | User invitations | An ADMIN invites a user; Supabase Auth sends the invitation email and the user sets their password on `/admin/setup-password`. Dashboard SMTP is configured in Supabase, and every step is audit-logged. |
| 18 | Password recovery | Handled by Supabase Auth: the reset link opens `/admin/reset-password`, and the forgot-password page never reveals whether an email has an account. |

## 9. Known limitations

- **Database Migrations:** Schema migrations through `20261019120000_client_management` must be applied to target databases using `npx prisma migrate deploy` before deploying application code.
- **Failed submissions can't be retried or closed.** They stay in the *Failed processing* list; the client has to send the file again. Files refused on arrival (wrong type, too large) leave no record at all.
- **No historical snapshots for current pipeline state.** Incomplete candidate process breakdown and police status are current state snapshots evaluated at query time (`asOf`); historical day-by-day snapshots of incomplete reasons or police countdown states are not stored.
- **Stage completion reversal affects past days.** *Candidates completed* and *Visa completed* use the stage's stored completion timestamp (`completed_at`). If a stage completion is later unticked or reversed, the historical day will no longer count it because immutable stage completion transition history is not maintained.
- **Role attribution uses current role.** *Summary by Roles* groups staff activity by the user's current role, as historical role assignment timelines are not versioned in the database.
- **Registration audit attribution.** *Registered by* is derived from the `CREATE_CANDIDATE` audit log entry; candidates created before registration auditing or whose passport ID was modified show as unassigned (*—*). Current documents and progress columns reflect current state, not state at registration.
- **WhatsApp documents not attributable to staff.** Files received via WhatsApp have no staff actor and are never attributed to a role. Submissions removed from review (deleted records) no longer count as received on their day.
- **Refused files aren't counted.** Invalid files are refused at intake and leave no record.
- **Removed files leave only an audit entry.** A file removed from review no longer counts as received on its day, and there is no screen listing removed files.
- **Stored documents can't be corrected.** A *Review required* document can't be re-typed or moved to another client, because it is already in a client folder.
- **Contrast in light mode.** The Stitch light status colours (green, amber and red badge text) have a contrast of 3.1–4.4:1, below the 4.5:1 guideline for small text. Those status colours were kept unchanged (the later Light border-token change did not touch them); changing them would be a Stitch design decision. Dark mode meets 4.5:1 everywhere.
- **Calculated in memory.** Client completeness and police statuses are calculated over all clients on each request. That is fine for thousands of clients; a much larger client base would need the calculation moved into the database.
- **Need Attention list is capped.** The page shows the newest 500 follow-ups (it says so when more exist); there is no paging.
- **Sheet Sync status is global.** The last automatic / manual sync, queue counts and last failure are not kept per destination; right after a destination switch they still describe runs against the previous Sheet until the new one has run.
- **Not built here.** Automated WhatsApp reminders and warnings (Phase 11), global search across all entities, and client profile editing.

## 10. Testing

Last verified regression results:

- **Backend test suite (`npm test`)**: **1492 passed, 0 failed**
- **Frontend test suite (`npm run admin:test`)**: **372 / 372 passed**
- Full production build (`npm run admin:build`): passing clean type-check and Vite bundling.

### Daily Report Test Coverage

The comprehensive Daily Report test suite (`test/dailyReportSummary.test.js`, `test/dailyReportRegistrations.test.js`, and `admin/src/test/dailyReport.test.tsx`) validates:

1. **Sri Lanka Midnight Boundaries**: Strict enforcement of `00:00:00.000` to `24:00:00.000` `Asia/Colombo` time range. Edge timestamps (e.g. `23:59:59.999` belongs to the day; `00:00:00.000` on the next day belongs to the next day).
2. **Summary KPI Counts**: Authoritative counts for all five metrics (`candidatesRegistered`, `candidatesCompleted`, `visaCompleted`, `callsTaken`, `documentsSubmitted`).
3. **Document Source & Type Splits**: Full aggregation and separation of WhatsApp intake vs. staff manual uploads across all supported candidate document types, preserving the **ONE SCAN** policy and conditionally displaying unclassified items.
4. **Incomplete Reasons Evaluation**: In-memory stage evaluation across candidate bio fields (surname, NIC, WhatsApp, etc.), document submission checklists (passport, medical, police reports, scans), test outcomes (*Test failed*, *No test result recorded*), and manual stages (*Not marked complete*), supporting non-linear / out-of-order stage completion.
5. **Role Attribution & Isolation**: Correct attribution of calls and manual document uploads to the staff user's current role; complete exclusion of WhatsApp files from staff role metrics.
6. **Role-Based Access Control (RBAC)**: Summary view accessible to `ADMIN`, `MANAGER`, and `ANALYST`; Summary by Roles strictly restricted to `ADMIN` and `MANAGER` (403 for `ANALYST`); `REGISTRATION_DESK` fully blocked from both Daily Report endpoints (403).
7. **Empty Day Handling**: Verified clean zero-count responses and empty lists for days with zero activity without runtime errors or crashes.
8. **Registered Candidate with Zero Documents**: Independent verification that registering a candidate increments *Candidates registered* by 1 while *Documents submitted* remains 0; listed with *No documents* and appropriate stage progress.
9. **Structured PDF Export**: jsPDF generation in portrait A4 format for both Summary and Role views; verification of repeated table header rows across page breaks, cell wrapping, and confidential footers.
10. **Selected Date Behavior**: Navigation via *Today*, *Previous day*, *Next day*, and date picker; query validation blocking future dates; complete synchronization with URL query parameters.

| Command | What it runs |
|---|---|
| `npm test` | Backend tests (API, actions, corrections, audit, reports, rules, candidate registrations) |
| `set RUN_OCR_TESTS=1&& npm test` | The same, plus the OCR tests on real files (Windows `cmd`) |
| `npm run admin:test` | Dashboard tests (screens, dialogs, Daily Report, Sync, dark mode and colour contrast) |
| `npm run admin:build` | Type-check and production build |

The finished dashboard was also checked on a throwaway PostgreSQL database with the real database client, and in headless Chrome against the production build: every screen and action, in light and dark mode, with the contrast of every visible text measured. Details are in [`09a-admin-dashboard-api.md`](09a-admin-dashboard-api.md) §8.
