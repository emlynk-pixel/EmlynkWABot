# Roles and Permissions

What each staff role in the Emlynk admin dashboard can and cannot do. Checked against the code on `dev` (2026-11-02, ANALYST narrowed to its allocated candidates and Need Attention):
- route guards: `src/routes/admin.js`, `users.js`, `sheetSyncSettings.js`, `candidateImport.js`
- user-management rules: `src/middleware/requireRole.js`, `src/services/userAccountService.js`
- candidate scope: `src/services/candidateAccess.js`
- screens: `admin/src/auth/roles.ts` (the shared permission mapping), `admin/src/layout/navigation.ts` (sidebar), `admin/src/App.tsx` (page guards)

**How it is enforced.** A user's role is read from the database (`public."user".role`) on **every request**, never from the sign-in token. A change applies to the user's next click. The server refuses anything outside the role with **403**. Hiding menu items and buttons in the dashboard is only a convenience, not the protection. An account must also be **ACTIVE** and hold a **supported role**: INVITED and INACTIVE accounts, and accounts still holding the retired MANAGER role, can't use the dashboard at all.

---

## 1. The roles at a glance

```
OWNER  >  ADMIN  >  TEAM_LEAD  >  ANALYST / REGISTRATION_DESK / JOB_HANDLER
```

| Role | In one sentence |
|---|---|
| **OWNER** | The single system owner: everything an ADMIN can do, plus managing ADMIN accounts. Set in the database only. |
| **ADMIN** | Runs the system and the operation: all candidate, document, review, police, job and allocation work (verification and approvals included), Settings, Audit Logs, Google Sheet Sync, and managing every user below ADMIN. |
| **TEAM_LEAD** | Exactly seven areas: Candidates (**every** candidate), Need Attention, Work Allocation, Jobs, Agents, Clients and the standard Daily Report. Every ADMIN-only action inside them stays ADMIN only; no Settings, user management, Audit Logs, dashboards or review queue. |
| **ANALYST** | Works **only on the candidates allocated to them**: the candidate's workflow (details, stages, documents, call logs) and Need Attention. Nothing else: no dashboard, documents, review queue, police workflow, reports or jobs. |
| **REGISTRATION_DESK** | The **candidate registration workflow** (Add Candidate): register a candidate, or load an existing one by passport ID and save their registration details and documents; and **views** Need Attention without acting on it. Nothing else. |
| **JOB_HANDLER** | Manages Jobs, Agents and Clients; **views** candidates and their workflow (the list and the candidate's page) but never changes a candidate record. |

**The hierarchy is about who manages whom, not about inherited permissions.** OWNER inherits every ADMIN permission. **TEAM_LEAD inherits nothing from ADMIN:** it has an explicit operational permission set (section 3), and a route admits TEAM_LEAD only where its tier names TEAM_LEAD. TEAM_LEAD is above the operational roles because it allocates their work and supervises it, and because an ADMIN may give the TEAM_LEAD role; it manages no user account itself.

The roles below TEAM_LEAD are separate kinds of work, not a ladder: none of ANALYST, REGISTRATION_DESK and JOB_HANDLER includes another's permissions.

The **MANAGER** role was retired on 2026-10-30; ADMIN holds everything it could do (section 6). TEAM_LEAD (added 2026-11-01) is a new role with its own permission set, not a revived MANAGER.

---

## 2. Full comparison table

✅ = allowed · ❌ = refused (403) · *Own* = only the candidates allocated to that Analyst · *Read* = view only

### Dashboard and documents

| Capability | OWNER | ADMIN | TEAM LEAD | ANALYST | REG. DESK | JOB HANDLER |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Overview dashboard | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Documents list, Missing Documents | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Clients (candidate documents view) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Daily Report: Summary, Incomplete | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Monthly overview | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Daily Report: **Summary by Roles** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Audit Logs** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |


### Review queue (WhatsApp submissions)

| Capability | OWNER | ADMIN | TEAM LEAD | ANALYST | REG. DESK | JOB HANDLER |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Open the review queue and items | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Approve, keep pending, remove from review | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Set document type, assign to a client, retry processing | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Replace a verified document / keep as a version | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Delete a temporary (unprocessed) document | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

The review queue (WhatsApp submissions) is ADMIN (and OWNER) work.

### Police workflow

| Capability | OWNER | ADMIN | TEAM LEAD | ANALYST | REG. DESK | JOB HANDLER |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Police Workflow page (21-day countdown) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Correct a police slip's submitted date** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Enter the date** when approving (or replacing with) a slip whose date wasn't read | ✅ | ✅ | ❌ | ❌⁷ | ❌ | ❌ |
| Approve a slip whose date OCR read (the date is confirmed as read) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

⁷ Approving is review-queue work (ADMIN). As a second line, the server also refuses any approve or replace request from a non-ADMIN that sends `policeSubmittedDate` (403 `POLICE_DATE_ADMIN_ONLY`).

### Candidates

| Capability | OWNER | ADMIN | TEAM LEAD | ANALYST | REG. DESK | JOB HANDLER |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Candidates **list** (browse, search) | ✅ | ✅ | ✅ | ✅ *Own* | ❌ | ✅ *Read* |
| Candidate page (the workflow: stages, documents, call logs, additional details, submitted form) | ✅ | ✅ | ✅ | ✅ *Own* | ❌ | ✅ *Read* |
| Registration lookup by passport ID (Add Candidate) | ✅ | ✅ | ✅ | ✅ *Own* | ✅³ | ✅ *Read* |
| **Register a new candidate** | ✅ | ✅ | ✅ | ❌² | ✅ | ❌ |
| Edit candidate details | ✅ | ✅ | ✅ | ✅ *Own* | ✅³ | ❌ |
| Edit additional details | ✅ | ✅ | ✅ | ✅ *Own* | ❌ | ❌ |
| Update stages (Test details … Finalizing Job) | ✅ | ✅ | ✅ | ✅ *Own* | ❌ (Candidate Details note only³) | ❌ |
| Upload candidate documents | ✅ | ✅ | ✅ | ✅ *Own* | Passport, NIC, Skill video only³ | ❌ |
| Remove candidate documents | ✅ | ✅ | ✅ | ✅ *Own* | ❌ | ❌ |
| Add call logs | ✅ | ✅ | ✅ | ✅ *Own* | ❌ | ❌ (reads them) |
| **Verify** a candidate's details / documents | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Share / revoke a candidate's Candidate Form link | ✅ | ✅ | ✅ | ✅ *Own* | ❌ | ❌ |
| View a submitted Candidate Form | ✅ | ✅ | ✅ | ✅ *Own* | ❌ | ✅ *Read* |
| **Confirm / reject submitted form changes** into the record | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Assign to Job** from the candidate's page | ✅ | ✅ | ❌ (assigns from the Job page) | ❌ | ❌ | ❌ (assigns from the Job page) |
| Bulk candidate import (Settings → Google Sheet Sync → **Upload**) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

² A new candidate is unallocated, and an Analyst only works on candidates allocated to them.
³ Only inside the Add Candidate form: entering an existing passport ID loads that candidate into the form, whose details, Candidate Details note and registration documents (Passport, NIC, Skill video: Upload / Replace, never Remove) can be saved. After saving, the Registration Desk stays on Add Candidate (the form is cleared); it never opens the candidate's page. The lookup and every save answer it with the registration view only (the details, the Candidate Details stage and the three registration documents; no other stage, document, job assignment or verification: `registrationView` in `src/services/candidateService.js`). The server enforces the same limits (`REGISTRATION_WORKFLOW` in `src/routes/admin.js`).

### Need Attention (call-log follow-ups)

| Capability | OWNER | ADMIN | TEAM LEAD | ANALYST | REG. DESK | JOB HANDLER |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| See Need Attention | ✅ | ✅ | ✅ | ✅ *Own* | ✅ *Read* | ❌ |
| Flag a call for follow-up (also "Need Attention" when adding a call), mark complete | ✅ | ✅ | ✅ | ✅ *Own* | ❌ | ❌ |
| **Delete** a follow-up | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

### Work allocation

| Capability | OWNER | ADMIN | TEAM LEAD | ANALYST | REG. DESK | JOB HANDLER |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Work Allocation page | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Assign, reassign, unassign, auto-allocate candidates to Analysts | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |

Work is only ever allocated to **ACTIVE ANALYST** accounts (the server refuses any other target: `NOT_AN_ANALYST`), so nobody can allocate work to an OWNER, ADMIN or TEAM_LEAD.

### Jobs, Agents and Clients

| Capability | OWNER | ADMIN | TEAM LEAD | ANALYST | REG. DESK | JOB HANDLER |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Jobs list and job details (with the job's candidates: name, passport ID, NIC, Status, assigned date) | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Create / edit a job | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Job candidate picker (New job, Add candidates: test-PASS candidates; name, passport ID, NIC, Status only) | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Add / remove candidates on a job | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Complete / cancel a job | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Add a **new** Job Type (from the New Job dialog) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Manage Job Types (Settings → Job Types: list, rename, activate) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Share / revoke a **job-group** Candidate Form link | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Agents: list, create, edit, activate/deactivate | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Client Management: list, create, edit, change agent, activate/deactivate | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |


### Notification bell (header)

| Capability | OWNER | ADMIN | TEAM LEAD | ANALYST | REG. DESK | JOB HANDLER |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Bell shown | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Source | Review Queue | Review Queue | **Open Need Attention follow-ups** | **Open Need Attention follow-ups** (*Own*) | — | — |
| Where an item leads | the review item | the review item | Need Attention | Need Attention | — | — |

The bell only ever reads data the role can already open (`GET /review` or `GET /follow-ups?status=OPEN`) and only links to a page it can open (`admin/src/auth/roles.ts` `notificationSource`). TEAM_LEAD gets no Review Queue access for it: `GET /review` stays 403 for TEAM_LEAD. No role's bell carries admin, security, Settings, user-management or integration alerts. Read/unread state is per user in the browser (`localStorage`).

### Settings and Google Sheet Sync

| Capability | OWNER | ADMIN | TEAM LEAD | ANALYST | REG. DESK | JOB HANDLER |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Open Settings (every tab) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Google Sheet Sync: status, run history | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Google Sheet Sync: **Upload** (bulk import) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Google Sheet Sync: **Test Connection**, **Sync Now** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Google Sheet Sync: switch the **Sync Destination** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

### User management

| Capability | OWNER | ADMIN | TEAM LEAD | ANALYST | REG. DESK | JOB HANDLER |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| List users (Change Roles, Invite User tabs) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Invite ADMIN | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Invite TEAM_LEAD, ANALYST, REGISTRATION_DESK, JOB_HANDLER | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Change role / deactivate / re-invite an **ADMIN** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Change role / deactivate / re-invite a user **below ADMIN** (TEAM_LEAD included) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Change an account still holding the retired **MANAGER** role | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Give the **ADMIN** role | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Give the **TEAM_LEAD** role | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Give or invite the retired **MANAGER** role | ❌⁵ | ❌⁵ | ❌ | ❌ | ❌ | ❌ |
| Give the **OWNER** role, or change / deactivate an OWNER | ❌⁴ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Change or deactivate **your own** account | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

⁴ The OWNER is set in the database only, never through the app, the OWNER included. See [`OWNER_ROLE.md`](OWNER_ROLE.md).
⁵ Refused with 400 (`INVALID_ROLE` / "must be one of: OWNER, ADMIN, TEAM_LEAD, ANALYST, REGISTRATION_DESK, JOB_HANDLER"); never replaced by another role.

### Every role

| Capability | All roles |
|---|---|
| Sign in, sign out, reset your own password (Supabase) | ✅ |
| See your own profile and role in the header | ✅ |

---

## 3. Each role in detail

### OWNER
**Can:** everything an ADMIN can (every page, Settings, Audit Logs, Google Sheet Sync control). In addition:
- manage **ADMIN accounts**: change their role, deactivate them, re-invite them;
- invite new ADMINs and give the ADMIN role;
- convert an account that still holds the retired MANAGER role (Settings → Change Roles shows it as "Manager (retired)").

**Cannot:**
- Give anyone the OWNER role, or the retired MANAGER role.
- Change, deactivate or re-invite an OWNER account.
- Invite an OWNER.
- Change their own account.

There is one OWNER, created or changed in the database only ([`OWNER_ROLE.md`](OWNER_ROLE.md)).

### ADMIN
**Can:**
- All operational work, on every candidate:
  - the dashboard, documents, review queue (all actions)
  - Police Workflow, **including correcting a police slip's date**
  - candidates: register, edit, stages, documents, call logs, Candidate Form links, **Assign to Job**
  - **verifying** details and documents
  - **confirming or rejecting** changes a candidate submitted through the form
- Need Attention, including **deleting** follow-ups.
- **Work Allocation.**
- Jobs (create, edit, staff, complete, cancel), job-group form links, adding a new Job Type from the New Job dialog.
- Agents and Clients.
- Daily Report including *Summary by Roles* (every role).
- Every Settings tab: Change Roles, Invite User, Google Sheet Sync (Test Connection, Sync Now, Sync Destination, Upload) and Job Types.
- Audit Logs.
- Invite, change, deactivate and re-invite **TEAM_LEAD, ANALYST, REGISTRATION_DESK and JOB_HANDLER** accounts, and give the TEAM_LEAD role.

**Cannot:**
- Change another ADMIN's role, deactivate another ADMIN, or re-invite an ADMIN's email.
- Change or deactivate the OWNER.
- Change, deactivate or re-invite an account still holding the retired MANAGER role (the OWNER decides).
- Give the ADMIN, OWNER or MANAGER role.
- Invite an ADMIN or OWNER.
- Change their own account.

A requested role the ADMIN may not give is refused (403 `OWNER_REQUIRED` / `OWNER_LOCKED`, or 400 for MANAGER), never quietly replaced by a lower one.

### TEAM_LEAD
Exactly seven areas, nothing inferred from them. It is **not** "ADMIN minus something": a TEAM_LEAD gets only what is listed here, and every action that is ADMIN only inside these areas stays ADMIN only.

**Can:**
- **Candidates**, on every candidate (not limited to an allocation): list, open, register, edit details and additional details, update stages, upload and remove documents, add call logs, share and revoke the candidate's Candidate Form link, view a submitted form.
- **Need Attention:** see every follow-up, flag a call, mark a follow-up complete. The header bell lists the open follow-ups and leads to Need Attention (it never reads the Review Queue).
- **Work Allocation:** view unallocated candidates and Analysts; assign, reassign, unassign; select one, several or all; equal (even) distribution. Work goes to ACTIVE Analysts only.
- **Jobs:** list and view (processing and completed), create and edit, add and remove candidates on the Job's page, complete and cancel (the Job Handler's job actions).
- **Agents** and **Clients** (Client Management): list, view, create, edit, link, activate and deactivate.
- **Daily Report:** the standard report (Summary and Incomplete), as an ANALYST sees it.

**Cannot (ADMIN only, or outside the seven areas):**
- Verify a candidate's details or documents.
- Confirm or reject submitted Candidate Form values.
- Delete a Need Attention follow-up.
- Share a job-group Candidate Form link.
- "Assign to Job" from the candidate's page (it assigns from the Job's page instead).
- Daily Report *Summary by Roles*.
- Add a new Job Type from the New Job dialog, or manage Job Types.
- Settings (any tab): Change Roles, Invite User, Google Sheet Sync (status, Test Connection, Sync Now, Sync Destination, Upload) and Job Types.
- User management of any kind: list users, invite, give or change roles, deactivate, manage OWNER or ADMIN accounts.
- Audit Logs.
- Overview, Documents, Missing Documents, Review Queue, Police Workflow, the Monthly overview, and correcting police slip dates.

### ANALYST
Sidebar: **Candidates** (their allocated candidates only) and **Need Attention**. Lands on Candidates. The bell lists their open Need Attention follow-ups.

**Can (only for candidates allocated to them, by an ADMIN or a TEAM_LEAD in Work Allocation):**
- List, search and open the candidate, and work on their workflow: details, additional details, stages, documents, call logs, Candidate Form links, viewing a submitted form.
- Flag and complete follow-ups in Need Attention.

**Cannot:**
- See or change candidates that are not allocated to them.
- Register new candidates.
- Verify details or documents, or confirm submitted form changes.
- Enter or correct police slip dates (approving an undated slip needs an ADMIN).
- Delete follow-ups.
- Use Work Allocation.
- Overview, Documents, Missing Documents, Clients, Review Queue (any review action), Police Workflow, Daily Report, Monthly overview.
- Jobs (not even read), Agents and Clients.
- Audit Logs, Settings, user management.

### REGISTRATION_DESK
Sidebar: **Add Candidate** and **Need Attention**. Lands on Add Candidate. No notification bell.

**Can (the candidate registration workflow, and Need Attention read only):**
- Register new candidates, with their Passport, NIC and Skill video.
- Enter a passport ID that already exists: that candidate loads into the same form, and its registration details, Candidate Details note and Passport / NIC / Skill video (Upload or Replace) can be saved.
- After registering or saving, it stays on Add Candidate with a confirmation, and the form is cleared for the next candidate.
- **View** Need Attention (Open and Completed) for every candidate. A candidate's name there is not a link (it opens no candidate page).

**Cannot:**
- Open the Candidates list or any candidate's page.
- Other stages, additional details, other documents, removing a document, call logs, Candidate Form links or submitted forms.
- Act on Need Attention: flag a call, mark a follow-up complete, or delete one.
- Anything else: Overview, Documents, Review Queue, Police Workflow, Missing Documents, Daily Report, Work Allocation, Jobs, Agents, Clients, Audit Logs, Settings, user management.
- Verify candidates, confirm form changes.

### JOB_HANDLER
Sidebar: **Candidates**, **Jobs**, **Agents**, **Client Management**. Lands on Jobs. No notification bell.

**Can:**
- Jobs: list, view, create, edit, add and remove candidates, complete and cancel. The job pickers use the job candidate picker (`GET /job-candidate-options`: candidates who passed the test, with name, passport ID, NIC and Status).
- **View** candidates and their workflow, read only: the Candidates list, the candidate's page (stages, documents, call logs, additional details, a submitted form), opened from the list or a job's candidates.
- Agents and Client Management, fully.

**Cannot:**
- Change any candidate record: no edits, stages, uploads or removals, call logs, Need Attention flags or Candidate Form links (every candidate write route is 403; the page shows no change control).
- Register, verify, or confirm form changes.
- Need Attention, Review Queue, Overview, Documents, Police Workflow, Daily Report, Work Allocation.
- Add a new Job Type, manage Job Types, or share job-group form links.
- Audit Logs, Settings, user management.

---

## 4. Side-by-side: what each role is missing compared with the role above

| Compared with | The lower role **cannot** |
|---|---|
| **ADMIN vs OWNER** | Manage ADMIN accounts (change, deactivate, re-invite), give the ADMIN role, invite ADMINs, convert an account still holding the retired MANAGER role. |
| **TEAM_LEAD vs ADMIN** | Verification; confirming or rejecting form values; deleting follow-ups; job-group form links; Assign to Job from the candidate's page; *Summary by Roles*; Settings (every tab, Google Sheet Sync and Upload included); user management; Audit Logs; Job Types (Settings, and adding one from the New Job dialog); the dashboard, documents, review queue, police workflow and monthly overview; police-date corrections. |
| **ANALYST vs TEAM_LEAD** | Work outside their allocated candidates; register candidates; Work Allocation; Jobs; Agents and Clients; the Daily Report. |
| **ANALYST vs ADMIN** | Work outside their allocated candidates; the dashboard, documents, review queue, police workflow, reports and jobs; register candidates; verify; confirm form changes; correct police dates; delete follow-ups; Work Allocation; job writes; Agents and Clients; Summary by Roles; bulk import; job-group form links; adding job types; Settings; Audit Logs; user management. |
| **REGISTRATION_DESK vs ADMIN** | Everything outside the Add Candidate registration workflow and viewing Need Attention: the Candidates list, the candidate's page, other stages and documents, removing documents, call logs, Candidate Form links, any Need Attention action, dashboard, review, police, reports, jobs, agents, clients, allocation; verification; confirming form changes; bulk import; Settings; Audit Logs; user management. |
| **JOB_HANDLER vs ADMIN** | Any candidate change (read only); review, police, dashboard, reports, Need Attention, allocation; verification; adding job types; job-group form links; bulk import; Settings; Audit Logs; user management. |

---

## 5. Notes

- **OWNER = ADMIN for access.** Every rule that names ADMIN admits OWNER too (`hasRole()`); OWNER only adds managing ADMIN accounts (and accounts holding a retired role).
- **TEAM_LEAD inherits nothing.** `hasRole()` admits TEAM_LEAD only where a tier names it (`REPORT_READERS`, `CANDIDATE_STAFF`, `CANDIDATE_READERS`, `REGISTRATION_WORKFLOW`, `REGISTRATION_STAFF`, `ALLOCATION_MANAGERS`, `JOB_READERS`, `JOB_MANAGERS`, `MASTER_DATA_STAFF` in `src/routes/admin.js`). It is in no `ADMINS_ONLY` route and in no user-management, Settings, Sheet Sync or import route.
- **The screens follow the same lists.** `admin/src/auth/roles.ts` holds the role lists; the sidebar (`navigation.ts`) and the page guards (`App.tsx` `AllowRoles`, an allow-list: a role not named is refused) use them, so a page hidden from a role, opened by URL (or as the page someone was on before signing in), takes that role to its own home page instead, with no warning, and requests nothing.
- **Analyst scope follows Work Allocation on every request.** Reassigning a candidate moves access immediately. If an Analyst is deactivated or given another role, their allocations stay recorded until someone reassigns them. The scope is applied in the database before search, filters, paging and totals, on the candidate page and every route under it, Need Attention, jobs and the reports, so another Analyst's or an unallocated candidate is never listed and reads as 404 by URL (`test/roleScopeRegression.test.js`). TEAM_LEAD, like ADMIN and JOB_HANDLER (read only), sees every candidate; REGISTRATION_DESK can look up any passport ID from Add Candidate.
- **Error responses.**
  - 401: not signed in.
  - 403 `ACCOUNT_NOT_ACTIVE`: the account isn't ACTIVE.
  - 403 `ROLE_NOT_SUPPORTED`: the account still holds the retired MANAGER role (or any role that isn't supported). Sign-in shows "Your account's role is no longer supported. Contact the Owner to update it."
  - 403 "Insufficient permissions": wrong role for the page or action.
  - 404: the candidate is outside an Analyst's allocation, so it reads as "not found" (the response never reveals that the candidate exists).
  - 400 `INVALID_ROLE` (or an invitation `errors` entry for `role`): the requested role isn't supported, e.g. MANAGER.
  - 403 `OWNER_REQUIRED` / `OWNER_LOCKED` and 400 `SELF_CHANGE`: user-management refusals.
- **Related documents:**
  - [`OWNER_ROLE.md`](OWNER_ROLE.md): OWNER details and the database procedure.
  - [`09a-admin-dashboard-api.md`](09a-admin-dashboard-api.md) §12–13: route tiers and the user-management API.
  - [`09b-admin-dashboard-guide.md`](09b-admin-dashboard-guide.md) §7: the operator view.
  - [`10-security.md`](10-security.md): the security model.
- **Keep this table in step with the code.** When a route's role tier changes in `src/routes/admin.js`, update this document.

---

## 6. The retired MANAGER role

Until 2026-10-30 there was a **MANAGER** role between ADMIN and the other roles. It was retired because ADMIN already held every MANAGER permission (business decision: "admin = manager"). The supported hierarchy is now `OWNER > ADMIN > TEAM_LEAD > ANALYST / REGISTRATION_DESK / JOB_HANDLER`. TEAM_LEAD (added 2026-11-01) is a new role with its own explicit permission set (section 3); it is not a revived MANAGER, and no MANAGER permission or account was moved to it (every former MANAGER-only action stays ADMIN only).

### Where each MANAGER permission went

| What MANAGER could do | Owner now | Route / guard |
|---|---|---|
| Work Allocation (page, assign, reassign, unassign, auto-allocate) | ADMIN (OWNER) | `/work-allocation/*`: `ADMINS_ONLY` |
| Verify a candidate's details / documents | ADMIN (OWNER) | `POST /candidates/:id/verification` |
| Confirm / reject a submitted Candidate Form value | ADMIN (OWNER) | `POST /candidates/:id/form-submission/*` |
| Correct a police slip's submitted date | ADMIN (OWNER) | `POST /documents/:id/police-date` |
| Delete a Need Attention follow-up | ADMIN (OWNER) | `DELETE /follow-ups/:id` |
| Add a new Job Type from the New Job dialog | ADMIN (OWNER); JOB_HANDLER unchanged (no) | `POST /job-types` |
| Job-group Candidate Form link (create, view, revoke) | ADMIN (OWNER); JOB_HANDLER unchanged (no) | `/jobs/:id/form-share*` |
| Assign to Job from the candidate's page | ADMIN (OWNER); JOB_HANDLER keeps assigning from the Job page | dashboard only |
| Daily Report → Summary by Roles | ADMIN (OWNER) | `GET /reports/daily/roles` |
| Settings → Google Sheet Sync status and run history | ADMIN (OWNER) | `/settings/sheet-sync/*`: `ADMINS_ONLY` |
| Upload (bulk candidate import) | ADMIN (OWNER) | `/settings/sheet-sync/import/*`: `CANDIDATE_IMPORT_ROLES = [ADMIN]` |
| Invite new Job Handlers (its own Invite User page) | ADMIN (OWNER), from Settings → Invite User | `POST /users/invite` |
| Jobs, Agents, Clients, candidate work, review, reports, police reads | ADMIN (OWNER), and the other roles exactly as before | unchanged tiers, MANAGER removed |

Nothing moved down to ANALYST, REGISTRATION_DESK or JOB_HANDLER: their access is exactly what it was.

### What happens to an account that still holds MANAGER

- `MANAGER` is not a valid role (`isValidRole`), is in no route tier, and can't be given or invited (400).
- An ACTIVE account still holding it is refused by `requireActiveUser` on **every** request: 403 `ROLE_NOT_SUPPORTED`. It sees no candidates and reaches no route, so it can't bypass anything. The dashboard shows the sign-in page with "Your account's role is no longer supported. Contact the Owner to update it."
- Only the **OWNER** can change it in the app (Settings → Change Roles, where it shows as "Manager (retired)"). An ADMIN sees it read only.
- Audit entries written before the retirement keep the value `MANAGER` (an audit entry is never rewritten); the Audit Logs page shows it as "Manager (retired)".

### Converting existing MANAGER accounts (each environment: dev, stage, prod)

`public."user".role` is plain TEXT with no CHECK constraint, so **no schema migration** is needed. The data must still be converted, and the agreed replacement is **ADMIN**. This is a privilege change: a former MANAGER also gets user management (below ADMIN), every Settings tab and Audit Logs.

1. **Check** (read only):
   ```sql
   SELECT admin_id, name, status FROM "user" WHERE role = 'MANAGER';
   ```
   or `npm run user:migrate-manager` (dry run: prints the database host, the count, the IDs and statuses; changes nothing).
2. **Convert** with the script, as the ACTIVE OWNER (recommended; audited like Change Roles):
   ```
   npm run user:migrate-manager -- --apply --owner <owner admin_id>
   ```
   Every MANAGER account (ACTIVE, INVITED and INACTIVE alike) becomes ADMIN in one transaction, keeping its status, with one `UPDATE_USER_ROLE` audit entry each (`MANAGER → ADMIN`, recorded under the OWNER). `--to ANALYST` (or another supported role, never OWNER) picks a different replacement. Running it again changes nothing.
3. **Or convert with SQL** (only if the script can't be run; guarded, one transaction, audited):
   ```sql
   BEGIN;
   -- The ACTIVE owner who takes responsibility for the change.
   SELECT admin_id FROM "user" WHERE role = 'OWNER' AND status = 'ACTIVE';   -- exactly one row expected
   INSERT INTO "audit_logs" ("audit_id", "admin_id", "action", "previous_status", "new_status", "reason", "previous_value", "new_value")
   SELECT gen_random_uuid()::text, '<owner admin_id>', 'UPDATE_USER_ROLE', 'MANAGER', 'ADMIN',
          'Retired role MANAGER converted for user ' || admin_id, 'MANAGER', 'ADMIN'
   FROM "user" WHERE role = 'MANAGER';
   UPDATE "user" SET role = 'ADMIN' WHERE role = 'MANAGER';
   SELECT count(*) FROM "user" WHERE role = 'MANAGER';                        -- must be 0
   COMMIT;   -- or ROLLBACK if anything above is unexpected
   ```
4. **Verify**: the check query in step 1 returns no rows.

Run the conversion before, or together with, deploying the release that retires MANAGER. Between the deploy and the conversion, a MANAGER account is locked out (403 `ROLE_NOT_SUPPORTED`), never given more access.
