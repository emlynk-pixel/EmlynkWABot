# Roles and Permissions

What each staff role in the Emlynk admin dashboard can and cannot do. Checked against the code on `dev` (2026-10-30):
- route guards: `src/routes/admin.js`, `users.js`, `sheetSyncSettings.js`, `candidateImport.js`
- user-management rules: `src/middleware/requireRole.js`, `src/services/userAccountService.js`
- candidate scope: `src/services/candidateAccess.js`
- screens: `admin/src/auth/roles.ts`, `admin/src/layout/navigation.ts`

**How it is enforced.** A user's role is read from the database (`public."user".role`) on **every request**, never from the sign-in token. A change applies to the user's next click. The server refuses anything outside the role with **403**. Hiding menu items and buttons in the dashboard is only a convenience, not the protection. An account must also be **ACTIVE** and hold a **supported role**: INVITED and INACTIVE accounts, and accounts still holding the retired MANAGER role, can't use the dashboard at all.

---

## 1. The roles at a glance

```
OWNER  >  ADMIN  >  ANALYST / REGISTRATION_DESK / JOB_HANDLER
```

| Role | In one sentence |
|---|---|
| **OWNER** | The single system owner: everything an ADMIN can do, plus managing ADMIN accounts. Set in the database only. |
| **ADMIN** | Runs the system and the operation: all candidate, document, review, police, job and allocation work (verification and approvals included), Settings, Audit Logs, Google Sheet Sync, and managing every user below ADMIN. |
| **ANALYST** | Does the candidate work for **the candidates allocated to them**: review, documents, stages, call logs. |
| **REGISTRATION_DESK** | Registers candidates and works on candidate records (details, stages, documents, call logs); nothing outside the Candidates area. |
| **JOB_HANDLER** | Manages Jobs, Agents and Clients; can **read** candidates (to staff jobs) but never changes a candidate record. |

The roles below ADMIN are separate kinds of work, not a ladder: none of ANALYST, REGISTRATION_DESK and JOB_HANDLER includes another's permissions.

The **MANAGER** role was retired on 2026-10-30; ADMIN holds everything it could do (section 6).

---

## 2. Full comparison table

✅ = allowed · ❌ = refused (403) · *Own* = only the candidates allocated to that Analyst · *Read* = view only

### Dashboard and documents

| Capability | OWNER | ADMIN | ANALYST | REG. DESK | JOB HANDLER |
|---|:-:|:-:|:-:|:-:|:-:|
| Overview dashboard | ✅ | ✅ | ✅ | ❌ | ❌ |
| Documents list, Missing Documents | ✅ | ✅ | ✅ | ❌ | ❌ |
| Clients (candidate documents view) | ✅ | ✅ | ✅ | ❌ | ❌ |
| Daily Report: Summary, Incomplete, Monthly | ✅ | ✅ | ✅ | ❌ | ❌ |
| Daily Report: **Summary by Roles** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Audit Logs** | ✅ | ✅ | ❌ | ❌ | ❌ |

### Review queue (WhatsApp submissions)

| Capability | OWNER | ADMIN | ANALYST | REG. DESK | JOB HANDLER |
|---|:-:|:-:|:-:|:-:|:-:|
| Open the review queue and items | ✅ | ✅ | ✅ *Own*¹ | ❌ | ❌ |
| Approve, keep pending, remove from review | ✅ | ✅ | ✅ *Own*¹ | ❌ | ❌ |
| Set document type, assign to a client, retry processing | ✅ | ✅ | ✅ *Own*¹ | ❌ | ❌ |
| Replace a verified document / keep as a version | ✅ | ✅ | ✅ *Own*¹ | ❌ | ❌ |
| Delete a temporary (unprocessed) document | ✅ | ✅ | ✅ *Own*¹ | ❌ | ❌ |

¹ An item already linked to a candidate outside the Analyst's allocation is "not found" for them. A file not yet linked to any candidate is open to every Analyst, since that is the review work.

### Police workflow

| Capability | OWNER | ADMIN | ANALYST | REG. DESK | JOB HANDLER |
|---|:-:|:-:|:-:|:-:|:-:|
| Police Workflow page (21-day countdown) | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Correct a police slip's submitted date** | ✅ | ✅ | ❌ | ❌ | ❌ |

### Candidates

| Capability | OWNER | ADMIN | ANALYST | REG. DESK | JOB HANDLER |
|---|:-:|:-:|:-:|:-:|:-:|
| Candidate list and candidate page | ✅ | ✅ | ✅ *Own* | ✅ | ✅ *Read* |
| **Register a new candidate** | ✅ | ✅ | ❌² | ✅ | ❌ |
| Edit candidate details, additional details | ✅ | ✅ | ✅ *Own* | ✅ | ❌ |
| Update stages (Test details … Finalizing Job) | ✅ | ✅ | ✅ *Own* | ✅ | ❌ |
| Upload and remove candidate documents | ✅ | ✅ | ✅ *Own* | ✅ | ❌ |
| Add call logs | ✅ | ✅ | ✅ *Own* | ✅ | ❌ (reads them) |
| **Verify** a candidate's details / documents | ✅ | ✅ | ❌ | ❌ | ❌ |
| Share / revoke a candidate's Candidate Form link | ✅ | ✅ | ✅ *Own* | ✅ | ❌ |
| View a submitted Candidate Form | ✅ | ✅ | ✅ *Own* | ✅ | ✅ *Read* |
| **Confirm / reject submitted form changes** into the record | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Assign to Job** from the candidate's page | ✅ | ✅ | ❌ | ❌ | ❌ (assigns from the Job page) |
| Bulk candidate import (Settings → Google Sheet Sync → **Upload**) | ✅ | ✅ | ❌ | ❌ | ❌ |

² A new candidate is unallocated, and an Analyst only works on candidates allocated to them.

### Need Attention (call-log follow-ups)

| Capability | OWNER | ADMIN | ANALYST | REG. DESK | JOB HANDLER |
|---|:-:|:-:|:-:|:-:|:-:|
| See Need Attention | ✅ | ✅ | ✅ *Own* | ✅ | ❌ |
| Flag a call for follow-up, mark complete | ✅ | ✅ | ✅ *Own* | ✅ | ❌ |
| **Delete** a follow-up | ✅ | ✅ | ❌ | ❌ | ❌ |

### Work allocation

| Capability | OWNER | ADMIN | ANALYST | REG. DESK | JOB HANDLER |
|---|:-:|:-:|:-:|:-:|:-:|
| Work Allocation page | ✅ | ✅ | ❌ | ❌ | ❌ |
| Assign, reassign, unassign, auto-allocate candidates to Analysts | ✅ | ✅ | ❌ | ❌ | ❌ |

### Jobs, Agents and Clients

| Capability | OWNER | ADMIN | ANALYST | REG. DESK | JOB HANDLER |
|---|:-:|:-:|:-:|:-:|:-:|
| Jobs list and job details | ✅ | ✅ | ✅ *Read*³ | ❌ | ✅ |
| Create / edit a job | ✅ | ✅ | ❌ | ❌ | ✅ |
| Add / remove candidates on a job | ✅ | ✅ | ❌ | ❌ | ✅ |
| Complete / cancel a job | ✅ | ✅ | ❌ | ❌ | ✅ |
| Add a **new** Job Type (from the New Job dialog) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Manage Job Types (Settings → Job Types: list, rename, activate) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Share / revoke a **job-group** Candidate Form link | ✅ | ✅ | ❌ | ❌ | ❌ |
| Agents: list, create, edit, activate/deactivate | ✅ | ✅ | ❌ | ❌ | ✅ |
| Client Management: list, create, edit, change agent, activate/deactivate | ✅ | ✅ | ❌ | ❌ | ✅ |

³ An Analyst sees only the jobs that hold their own candidates.

### Settings and Google Sheet Sync

| Capability | OWNER | ADMIN | ANALYST | REG. DESK | JOB HANDLER |
|---|:-:|:-:|:-:|:-:|:-:|
| Open Settings (every tab) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Google Sheet Sync: status, run history | ✅ | ✅ | ❌ | ❌ | ❌ |
| Google Sheet Sync: **Upload** (bulk import) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Google Sheet Sync: **Test Connection**, **Sync Now** | ✅ | ✅ | ❌ | ❌ | ❌ |
| Google Sheet Sync: switch the **Sync Destination** | ✅ | ✅ | ❌ | ❌ | ❌ |

### User management

| Capability | OWNER | ADMIN | ANALYST | REG. DESK | JOB HANDLER |
|---|:-:|:-:|:-:|:-:|:-:|
| List users (Change Roles, Invite User tabs) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Invite ADMIN | ✅ | ❌ | ❌ | ❌ | ❌ |
| Invite ANALYST, REGISTRATION_DESK, JOB_HANDLER | ✅ | ✅ | ❌ | ❌ | ❌ |
| Change role / deactivate / re-invite an **ADMIN** | ✅ | ❌ | ❌ | ❌ | ❌ |
| Change role / deactivate / re-invite a user **below ADMIN** | ✅ | ✅ | ❌ | ❌ | ❌ |
| Change an account still holding the retired **MANAGER** role | ✅ | ❌ | ❌ | ❌ | ❌ |
| Give the **ADMIN** role | ✅ | ❌ | ❌ | ❌ | ❌ |
| Give or invite the retired **MANAGER** role | ❌⁵ | ❌⁵ | ❌ | ❌ | ❌ |
| Give the **OWNER** role, or change / deactivate an OWNER | ❌⁴ | ❌ | ❌ | ❌ | ❌ |
| Change or deactivate **your own** account | ❌ | ❌ | ❌ | ❌ | ❌ |

⁴ The OWNER is set in the database only, never through the app, the OWNER included. See [`OWNER_ROLE.md`](OWNER_ROLE.md).
⁵ Refused with 400 (`INVALID_ROLE` / "must be one of: OWNER, ADMIN, ANALYST, REGISTRATION_DESK, JOB_HANDLER"); never replaced by another role.

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
- Daily Report including *Summary by Roles*.
- Every Settings tab: Change Roles, Invite User, Google Sheet Sync (Test Connection, Sync Now, Sync Destination, Upload) and Job Types.
- Audit Logs.
- Invite, change, deactivate and re-invite **ANALYST, REGISTRATION_DESK and JOB_HANDLER** accounts.

**Cannot:**
- Change another ADMIN's role, deactivate another ADMIN, or re-invite an ADMIN's email.
- Change or deactivate the OWNER.
- Change, deactivate or re-invite an account still holding the retired MANAGER role (the OWNER decides).
- Give the ADMIN, OWNER or MANAGER role.
- Invite an ADMIN or OWNER.
- Change their own account.

A requested role the ADMIN may not give is refused (403 `OWNER_REQUIRED` / `OWNER_LOCKED`, or 400 for MANAGER), never quietly replaced by a lower one.

### ANALYST
**Can (only for candidates allocated to them):**
- Open and work on the candidate: details, additional details, stages, documents, call logs, Candidate Form links, viewing a submitted form.
- Review-queue actions on items for their candidates, and on files not yet linked to any candidate.
- Flag and complete follow-ups in Need Attention.

**Can (without that limit):** the Overview, Documents, Missing Documents, Police Workflow and Daily Report summary pages. They can also read the jobs that hold their own candidates.

**Cannot:**
- See or change candidates that are not allocated to them.
- Register new candidates.
- Verify details or documents, or confirm submitted form changes.
- Correct police slip dates.
- Delete follow-ups.
- Use Work Allocation.
- Create, edit or staff jobs, or manage Agents and Clients.
- Daily Report *Summary by Roles*, Audit Logs, Settings, user management.

### REGISTRATION_DESK
**Can, on every candidate:**
- Register new candidates.
- Edit details and additional details, update stages, upload and remove documents.
- Add call logs, share and revoke Candidate Form links, view submitted forms.
- Flag and complete follow-ups in Need Attention.

**Cannot:**
- Anything outside the Candidates area: Overview, Documents, Review Queue, Police Workflow, Missing Documents, Daily Report.
- Verify candidates, confirm form changes, delete follow-ups.
- Work Allocation, Jobs, Agents, Clients.
- Audit Logs, Settings, user management.

### JOB_HANDLER
**Can:**
- Jobs: list, view, create, edit, add and remove candidates, complete and cancel.
- Agents and Client Management, fully.
- **Read** candidates (the list, candidate pages, call logs, a submitted form), to staff jobs.

**Cannot:**
- Change any candidate record (no edits, stages, documents, call logs, form links).
- Register candidates, verify them, or confirm form changes.
- Need Attention, Review Queue, Overview, Documents, Police Workflow, Daily Report, Work Allocation.
- Add a new Job Type, manage Job Types, or share job-group form links.
- Audit Logs, Settings, user management.

---

## 4. Side-by-side: what each role is missing compared with the role above

| Compared with | The lower role **cannot** |
|---|---|
| **ADMIN vs OWNER** | Manage ADMIN accounts (change, deactivate, re-invite), give the ADMIN role, invite ADMINs, convert an account still holding the retired MANAGER role. |
| **ANALYST vs ADMIN** | Work outside their allocated candidates; register candidates; verify; confirm form changes; correct police dates; delete follow-ups; Work Allocation; job writes; Agents and Clients; Summary by Roles; bulk import; job-group form links; adding job types; Settings; Audit Logs; user management. |
| **REGISTRATION_DESK vs ADMIN** | Everything outside the Candidates area (dashboard, review, police, reports, jobs, agents, clients, allocation); verification; confirming form changes; deleting follow-ups; bulk import; Settings; Audit Logs; user management. |
| **JOB_HANDLER vs ADMIN** | Any candidate change (read only); review, police, dashboard, reports, Need Attention, allocation; verification; adding job types; job-group form links; bulk import; Settings; Audit Logs; user management. |

---

## 5. Notes

- **OWNER = ADMIN for access.** Every rule that names ADMIN admits OWNER too (`hasRole()`); OWNER only adds managing ADMIN accounts (and accounts holding a retired role).
- **Analyst scope follows Work Allocation on every request.** Reassigning a candidate moves access immediately. If an Analyst is deactivated or given another role, their allocations stay recorded until someone reassigns them.
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

Until 2026-10-30 there was a **MANAGER** role between ADMIN and the other roles. It was retired because ADMIN already held every MANAGER permission (business decision: "admin = manager"). The supported hierarchy is now `OWNER > ADMIN > ANALYST / REGISTRATION_DESK / JOB_HANDLER`.

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
