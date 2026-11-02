# Notification System — Workflow Audit and Proposal

Status: **research only (2026-10-30, branch `dev`).** Updated the same day for the retired MANAGER role: everything it would have received now goes to ADMIN (and so OWNER). Nothing here is implemented: no code, schema or migration was changed. Every trigger below is checked against the current code and documents; anything the code does not support is marked **Proposed / Needs Business Confirmation**.

Source tags used throughout:

| Tag | Meaning |
|---|---|
| **Existing requirement** | In the initial notification list. |
| **Found** | Not in the initial list; found during the audit, from current code and data. |
| **Proposed** | Useful, but the rule or threshold isn't in the code or documents: needs business confirmation. |

Severity: **Critical** (act today), **High** (act soon), **Warning** (act within days), **Info** (no action needed).

---

## 1. Workflow areas audited

| Area | Where it lives | What can be detected today |
|---|---|---|
| Registration, candidate details | `candidateService.js`, `candidate` table | creation, edits, identity fields (passport, NIC, WhatsApp; partial unique WhatsApp index) |
| Workflow status | `candidateWorkflowStatus.js` (derived, never stored) | REGISTERED → JOB_ASSIGNED → FORM_SUBMITTED → DETAILS_VERIFIED → DOCUMENTS_VERIFIED → VISA_DOCUMENT_READY; STOPPED_WITH_TEST override |
| Stages | `candidate_stages` | 8 stages (TEST_DETAILS … FINALIZING_JOB), `completed`, `completed_at`, test result PASS/FAIL |
| Verification | `candidateVerificationService.js`, `candidate_verification` | details/documents verified (ADMIN and OWNER); **automatic reset by DB trigger** when covered data changes (`DETAILS_VERIFICATION_RESET`, `DOCUMENTS_VERIFICATION_RESET`) |
| Candidate Form | `candidateForm*Service.js`, `candidate_form_*` tables | link created/revoked/expired (3 days), failed-attempt lock (`locked_until`), access LOCKED/UNLOCKED/SUBMITTED, prefill snapshot vs response, per-field review (CONFIRMED/REJECTED; pending = no row; confirm = ADMIN, MANAGER) |
| WhatsApp intake, OCR | `submissionQueue.js`, `documentProcessingService.js`, `temporary_data` | TEMPORARY_STORED (in flight), stored, NEEDS_REVIEW (UNDEFINED / MANUAL_REVIEW / CONFLICT), DUPLICATE, **FAILED after 3 attempts** |
| Review queue | `adminReview*Service.js`, `reviewReason.js` | reasons: PROCESSING_FAILED, IDENTITY_CONFLICT, RECORD_CONFLICT, CROSS_CLIENT_DUPLICATE, DOCUMENT_TYPE_UNCLEAR, WRONG_DOCUMENT_SUSPECTED, IDENTITY_NOT_CONFIRMED, POLICE_DATE_UNRESOLVED, LOW_CONFIDENCE, DUPLICATE_OF_VERIFIED, EXISTING_VERIFIED_DOCUMENT; actions APPROVE / KEEP_PENDING / REMOVE_FROM_REVIEW (audited) |
| Identity matching | `identityVerificationService.js` | VERIFIED_MATCH, AMBIGUOUS_MATCH, IDENTITY_CONFLICT, WHATSAPP_DIFFERS, PASSPORT_NOT_IN_DATABASE, … |
| Required documents | `config/requiredDocuments.js`, Missing Documents page | default PASSPORT, POLICE_REPORT, MEDICAL (configurable) |
| Police workflow | `policeCountdownService.js` | slip date + 21 days: PENDING, DUE_SOON (1–7 days), DUE_TODAY, OVERDUE, DATE_MISSING, NOT_UPLOADED, COMPLETED (verified report). Computed on read; no reminders exist |
| Call logs, Need Attention | `callLogFollowUpService.js`, `call_log_follow_up` | manual follow-up flags on call logs (OPEN/COMPLETED); page "Need Attention" (`/follow-ups`) for Candidates-area roles |
| Work allocation | `workAllocationService.js`, `candidate_allocation` | allocated / unallocated; the allocated user's current status and role (`analystView.active`) |
| Jobs | `jobService.js`, `job`, `job_candidate` | PROCESSING/COMPLETED/CANCELLED; active assignment (`is_active`, `released_at`); several active jobs per candidate allowed (migration `20261029120000_job_candidate_multiple_active`); "Filled" = assigned ≥ vacancies |
| Agents / Clients | `agentService.js`, `clientService.js` | ACTIVE/INACTIVE; nothing time-critical found |
| Visa flow | stages VISA_SUBMISSION, VISA_APPROVAL; status VISA_DOCUMENT_READY | stage completion only (no visa dates stored) |
| User management | `userAccountService.js`, OWNER_ROLE.md | INVITE_USER, REACTIVATE_USER, COMPLETE_INVITATION, UPDATE_USER_ROLE, DEACTIVATE_USER (audited); statuses INVITED/ACTIVE/INACTIVE; OWNER set in DB only |
| Bulk import | `candidateImportService.js`, `candidate_import` | PREVIEWED, COMMITTING, COMPLETED, COMPLETED_WITH_ERRORS, FAILED; row outcomes incl. CONFLICT, NIC_CONFLICT, WHATSAPP_CONFLICT, SKIPPED_VERIFIED; audited BULK_IMPORT_* |
| Operational Mirror sync | `sheetSync*.js`, `sheet_sync_queue/runs/state` | queue FAILED (dead letter), run FAILED / RUN_ABANDONED, integration state OK / CONFIG_ERROR / DATA_INTEGRITY, SCHEMA_INVALID, worker heartbeat (stale after 2 min), last success time |
| Candidate Form Sheet sync | `formSubmissionSync*.js`, `candidate_form_sheet_sync` | PENDING/PROCESSING/COMPLETED/FAILED (dead letter after 5 attempts) |
| Auth / security | Supabase Auth, `requireActiveUser.js` | sessions and sign-in are Supabase's; the app records no failed sign-ins |
| Existing alert surfaces | Overview page, Police Workflow, Missing Documents, Review Queue, Need Attention | Overview shows failed submissions and police overdue/due-soon counts; **no stored notification, no badge, no time-based checker** |

---

## 2. Existing notification requirements (initial list)

| # | Requirement | Mapped to |
|---|---|---|
| 1 | Candidate Form submitted with values different from the main record | CR-01 |
| 2 | OCR validation fails, or manual review rejects a required document | CR-02, CR-03 |
| 3 | Trade Test PASS but unallocated > 48 h, or on a job without Analyst coverage | CR-08, CR-09 |
| 4 | Police Clearance issue date > 5 months while Visa Submission pending | CR-07 (not detectable yet: §11) |
| 5 | Candidate in an incomplete stage with no calls and no document updates | CR-11 |
| 6 | Sheet-sync outbox fails after maximum retries | CR-13 |
| 7 | Police Report countdown Due Soon / Due Today / Overdue | CR-05 |
| 8 | Candidate lost all active jobs but remains in the pipeline | CR-12 |
| 9 | Same Passport / NIC / WhatsApp maps to another candidate, or ambiguous match | CR-04 |
| 10 | New system user added | OP-01 |
| 11 | Unread-count badge on Need Attention | §9 |

---

## 3. Missing notifications discovered

From the current code (tag **Found**):

- **CR-06 Police slip date missing:** the countdown can't start. Detected by the existing `DATE_MISSING` status.
- **CR-10 Candidates allocated to a deactivated or re-roled Analyst:** allocations are not cleared when the user changes, so those candidates lose their owner.
- **CR-14 Google Sheet integration unhealthy:** the Sheet's headers don't match (SCHEMA_INVALID), there's a configuration error, a data-integrity problem, or the reconcile run failed or was abandoned.
- **CR-15 Sheet sync worker offline / scheduled sync not succeeding.**
- **CR-16 Candidate Form Sheet sync dead letter:** separate from the Operational Mirror.
- **CR-17 Document intake stuck:** the OCR worker or submission worker is unavailable.
- **CR-18 Verification reset by a data change:** the candidate falls back down the status ladder.
- **CR-19 Candidate Form link locked after repeated failed verification attempts:** a possible guessing attempt.
- **CR-20 Bulk import failed, stuck, or finished with conflicts.**
- **OP-03 to OP-11:** informational events (role changes, form submitted, allocation, job changes, job filled, test failed, milestones, import done, form link expired unused).

Proposed (needs confirmation): CR-21, CR-22, OP-02, OP-12, OP-13.

---

## 4. Crucial / Need Attention notifications

Recipients use: **OWNER, ADMIN, ANALYST\*** (the candidate's allocated Analyst only), **JOB_HANDLER**. OWNER receives everything ADMIN receives.

### CR-01 Candidate Form changes awaiting review — *Existing requirement*
- **Trigger:** `candidate_form_access.status = SUBMITTED` and at least one submitted field differs from the current record with no `candidate_form_field_review` row (CONFIRMED / REJECTED) yet.
- **Recipients:** ADMIN (they confirm); ANALYST\* (visibility).
- **Why:** the main record stays unchanged until someone confirms. Unreviewed changes mean outdated candidate data.
- **Dedup:** one per candidate; update the count of pending fields.
- **Auto-resolve:** no pending differing field left.
- **Severity:** Warning.

### CR-02 Document processing failed — *Existing requirement*
- **Trigger:** `temporary_data.processing_status = FAILED` (reason PROCESSING_FAILED, after 3 worker attempts).
- **Recipients:** ADMIN; ANALYST\* when the candidate is known.
- **Why:** the candidate's document never reaches their file and they think it was received.
- **Dedup:** one per submission (`temporary_id`).
- **Auto-resolve:** the item is retried successfully, approved or removed.
- **Severity:** High.

### CR-03 Required document not accepted at review — *Existing requirement (adapted)*
- **Trigger:** REMOVE_FROM_REVIEW of a document of a required type (REQUIRED_DOCUMENT_TYPES) while the candidate has no VERIFIED document of that type. The code has no separate "reject" action: Remove from Review is the rejection.
- **Recipients:** ANALYST\*, ADMIN.
- **Why:** the candidate must be asked for the document again.
- **Dedup:** one per candidate + document type.
- **Auto-resolve:** a VERIFIED document of that type exists.
- **Severity:** Warning.

### CR-04 Identity conflict or ambiguous match — *Existing requirement*
- **Trigger:** review item with reason IDENTITY_CONFLICT, RECORD_CONFLICT or CROSS_CLIENT_DUPLICATE, or identity outcome AMBIGUOUS_MATCH. Registration and import refusals for duplicate passport/NIC/WhatsApp are shown to the person doing it at that moment and are **not** notifications.
- **Recipients:** ADMIN.
- **Why:** risk of filing one person's document under another.
- **Dedup:** one per submission.
- **Auto-resolve:** the review item is resolved.
- **Severity:** High.

### CR-05 Police Report countdown — *Existing requirement*
- **Trigger:** police status DUE_SOON (1–7 days left), DUE_TODAY or OVERDUE.
- **Recipients:** ADMIN, ANALYST\*.
- **Why:** compliance. The final police report is due 21 days after the slip.
- **Dedup:** **one per candidate.** Severity escalates in place (Warning → High → Critical) and is marked unread again only when it escalates; no new notification each day.
- **Auto-resolve:** status COMPLETED (verified police report), or no slip any more.

### CR-06 Police slip date missing — *Found*
- **Trigger:** police status DATE_MISSING (a slip exists, no submitted date).
- **Recipients:** ADMIN, ANALYST\*.
- **Why:** without the date the 21-day countdown, and so CR-05, never starts.
- **Dedup:** one per candidate.
- **Auto-resolve:** a date is set (review approve or police-date correction).
- **Severity:** High.

### CR-07 Police Clearance near expiry before Visa Submission — *Existing requirement; not detectable today*
- **Trigger:** verified POLICE_REPORT issue date + 5 months ≤ today, and VISA_SUBMISSION not completed.
- **Recipients:** ADMIN, ANALYST\*.
- **Why:** per the requirement, the certificate is valid for 6 months. That validity rule is not in the code or documents: **confirm it**.
- **Dedup:** one per candidate; High at 5 months, Critical at 6 months.
- **Auto-resolve:** a newer verified report, or Visa Submission completed.
- **Blocker:** the certificate's issue date is **not stored** (§11).

### CR-08 Trade Test passed, no Analyst after 48 hours — *Existing requirement*
- **Trigger:** TEST_DETAILS result PASS, no `candidate_allocation` row, and 48 h since the PASS was saved. The start time needs a reliable source (§11).
- **Recipients:** ADMIN.
- **Why:** a qualified candidate waits with nobody working on them.
- **Dedup:** one per candidate.
- **Auto-resolve:** allocated, or result no longer PASS.
- **Severity:** High.

### CR-09 Candidate on a job without Analyst coverage — *Existing requirement*
- **Trigger:** an active `job_candidate` on a PROCESSING job and no allocation.
- **Recipients:** ADMIN.
- **Dedup:** one per candidate (not per job).
- **Auto-resolve:** allocated to an active Analyst, or no active job.
- **Severity:** High.

### CR-10 Candidates allocated to an inactive or re-roled user — *Found*
- **Trigger:** `candidate_allocation.analyst_id` is a user who is no longer ACTIVE or no longer ANALYST. Allocations are not cleared on deactivation or role change.
- **Recipients:** ADMIN.
- **Why:** those candidates look covered but nobody can work on them.
- **Dedup:** **one per affected user**, with the candidate count.
- **Auto-resolve:** no candidates remain allocated to that user, or the user is an active Analyst again.
- **Severity:** High.

### CR-11 Stalled candidate — *Existing requirement; threshold needs confirmation*
- **Trigger:** candidate in the pipeline (see the definition in §6) with no call log, no document received or uploaded and no stage change for **N days** (proposed default 14).
- **Recipients:** ANALYST\*, ADMIN.
- **Dedup:** one per candidate.
- **Auto-resolve:** any of those activities, or the candidate leaves the pipeline.
- **Severity:** Warning.

### CR-12 Candidate left without an active job — *Existing requirement*
- **Trigger:** the candidate had at least one `job_candidate` row, now has **no** active assignment (released, or the job COMPLETED / CANCELLED), is still in the pipeline, and FINALIZING_JOB is not completed. This one rule also covers "job completed/cancelled while candidates depend on it" and "unassigned after job removal". Several active jobs per candidate are allowed, so losing one job alone is not a trigger.
- **Recipients:** ADMIN, JOB_HANDLER; ANALYST\*.
- **Dedup:** one per candidate.
- **Auto-resolve:** assigned to a PROCESSING job, or the candidate leaves the pipeline.
- **Severity:** Warning.

### CR-13 Operational Mirror sync items failed permanently — *Existing requirement*
- **Trigger:** any `sheet_sync_queue` row with status FAILED.
- **Recipients:** OWNER, ADMIN.
- **Dedup:** **one system notification**, with a count of failed candidates (never one per candidate).
- **Auto-resolve:** no FAILED rows remain.
- **Severity:** High.

### CR-14 Google Sheet integration unhealthy — *Found*
- **Trigger:** `sheet_sync_state.integration_state` CONFIG_ERROR or DATA_INTEGRITY, or SCHEMA_INVALID (header mismatch), or the latest RECONCILE run FAILED or RUN_ABANDONED.
- **Recipients:** OWNER, ADMIN.
- **Why:** the Sheet stops updating for everyone.
- **Dedup:** one per error code.
- **Auto-resolve:** integration state OK and the next run SUCCEEDED.
- **Severity:** Critical.

### CR-15 Sheet sync worker offline / scheduled sync not succeeding — *Found*
- **Trigger:** worker heartbeat older than the stale limit (2 min) while sync is enabled, or no successful reconcile since the last expected scheduled run.
- **Recipients:** OWNER, ADMIN.
- **Dedup:** one system notification.
- **Auto-resolve:** fresh heartbeat and a successful run.
- **Severity:** High.
- Confirm the worker is expected to run continuously (§11).

### CR-16 Candidate Form Sheet sync dead letter — *Found*
- **Trigger:** `candidate_form_sheet_sync.status = FAILED` (after 5 attempts).
- **Recipients:** OWNER, ADMIN.
- **Dedup:** one system notification with a count.
- **Auto-resolve:** no FAILED rows.
- **Severity:** High.

### CR-17 Document intake stuck (OCR or worker unavailable) — *Found*
- **Trigger:** `temporary_data` rows still TEMPORARY_STORED longer than **X minutes** (proposed 30), or several FAILED within one hour.
- **Recipients:** OWNER, ADMIN.
- **Why:** WhatsApp documents pile up unprocessed.
- **Dedup:** one system notification with the backlog size.
- **Auto-resolve:** backlog below the threshold.
- **Severity:** Critical.

### CR-18 Verification reset — *Found*
- **Trigger:** audit DETAILS_VERIFICATION_RESET or DOCUMENTS_VERIFICATION_RESET (the DB trigger cleared a verification because covered data changed).
- **Recipients:** ADMIN (the verifiers); ANALYST\*.
- **Why:** the candidate drops from Details/Documents Verified and must be checked again before visa work.
- **Dedup:** one per candidate + kind.
- **Auto-resolve:** verified again.
- **Severity:** Warning.

### CR-19 Candidate Form link locked after failed verification attempts — *Found (security)*
- **Trigger:** `candidate_form_link.locked_until` is set (repeated wrong Passport/NIC).
- **Recipients:** OWNER, ADMIN.
- **Why:** someone may be guessing a candidate's details, or the candidate is stuck.
- **Dedup:** one per link.
- **Auto-resolve:** lock expires, or the link is revoked/replaced. Keep it in the resolved history.
- **Severity:** High.

### CR-20 Bulk import failed, stuck or finished with conflicts — *Found*
- **Trigger:** `candidate_import.status` FAILED, or COMPLETED_WITH_ERRORS (rows CONFLICT / NIC_CONFLICT / WHATSAPP_CONFLICT / FAILED), or COMMITTING for longer than X minutes.
- **Recipients:** the user who ran it; OWNER, ADMIN.
- **Dedup:** one per import.
- **Auto-resolve:** none possible from data. **Dismissed by a person** after checking.
- **Severity:** High (FAILED / stuck), Warning (with errors).

### CR-21 Required documents missing before a critical stage — *Proposed*
- **Trigger (to confirm):** candidate has an active job and has reached IVS_INTERVIEW or VISA_SUBMISSION, while a required document has no VERIFIED copy.
- **Recipients:** ANALYST\*, ADMIN.
- **Dedup:** one per candidate; list the missing types.
- **Auto-resolve:** all required documents verified.
- **Severity:** High.
- Which stage needs which documents is **not** defined in the code.

### CR-22 Review item waiting too long — *Proposed*
- **Trigger:** a NEEDS_REVIEW submission (UNDEFINED / MANUAL_REVIEW / CONFLICT, or held for LOW_CONFIDENCE etc.) older than **N hours** (proposed 24).
- **Recipients:** ADMIN.
- **Dedup:** one system notification with the count and the oldest age, not one per item.
- **Auto-resolve:** no item older than N.
- **Severity:** Warning.

---

## 5. Optional / Informational notifications

| ID | Notification | Trigger | Recipients | Dedup / resolve | Source |
|---|---|---|---|---|---|
| OP-01 | New user invited / joined / reactivated | audit INVITE_USER, COMPLETE_INVITATION, REACTIVATE_USER | OWNER, ADMIN | one per user; read = done | Existing requirement |
| OP-02 | Invitation not completed | user INVITED for more than N days | the inviter; OWNER, ADMIN | one per user; resolves on ACTIVE or deactivation | Proposed |
| OP-03 | Role changed or account deactivated | audit UPDATE_USER_ROLE, DEACTIVATE_USER | OWNER, ADMIN (not the person who made the change) | one per change | Found |
| OP-04 | Candidate Form submitted | access becomes SUBMITTED (no differing fields; otherwise CR-01) | ANALYST\*, ADMIN | one per candidate | Found |
| OP-05 | Candidate allocated to you | ASSIGN_CANDIDATE / REASSIGN_CANDIDATE | the new Analyst | one per candidate | Found |
| OP-06 | Job assignment changed | candidate added to / removed from a job (loss of the last job is CR-12) | ANALYST\* | one per candidate per day, merged | Found |
| OP-07 | Job filled | assigned candidates ≥ vacancies (jobService "Filled") | ADMIN, JOB_HANDLER | one per job; resolves if no longer filled | Found |
| OP-08 | Trade Test failed | TEST_DETAILS result FAIL (Stopped with Test) | ANALYST\*, ADMIN | one per candidate | Found |
| OP-09 | Milestone reached | status becomes DOCUMENTS_VERIFIED or VISA_DOCUMENT_READY | ANALYST\*, ADMIN | one per candidate + milestone | Found |
| OP-10 | Bulk import completed | candidate_import COMPLETED | the user who ran it | one per import | Found |
| OP-11 | Form link expired unused | link expired, access not SUBMITTED, no newer active link | the link's creator, ANALYST\* | one per candidate; resolves when a new link is shared or the form submitted | Found |
| OP-12 | Analyst has no activity on assigned candidates | no call logs / document actions by the Analyst for N days while they have allocated candidates | ADMIN | one per Analyst; resolves on activity | Proposed (HR-sensitive) |
| OP-13 | Job over its vacancies | assigned > vacancies (allowed by the code) | ADMIN, JOB_HANDLER | one per job | Proposed |

---

## 6. Items requiring business confirmation

Proposed notifications:
1. **CR-21:** which stage requires which documents.
2. **CR-22:** the waiting time N for review items.
3. **OP-02:** the invitation age N. Supabase's invite link lifetime is set in the Supabase dashboard, not in the app.
4. **OP-12:** whether Analyst activity monitoring is wanted at all, and the period.
5. **OP-13:** whether over-filling a job is an error or normal.

Parameters of existing requirements:
6. **CR-07:** the 6-month validity rule and the 5-month warning, plus storing the certificate issue date.
7. **CR-08:** what counts as the PASS time (the first PASS save, or the latest).
8. **CR-11:** the inactivity period N, and which activities count.
9. **CR-11 / CR-12 — "in the pipeline":** no stored active/inactive flag exists. Proposed definition: Test result is not FAIL and FINALIZING_JOB is not completed.

---

## 7. Recipient matrix

ANALYST\* = the candidate's allocated Analyst only. REGISTRATION_DESK receives none: its access is the Candidates area only, and none of these require its action.

| ID | OWNER | ADMIN | ANALYST\* | JOB_HANDLER | Other |
|---|:-:|:-:|:-:|:-:|---|
| CR-01 Form changes awaiting review | ✓ | ✓ | ✓ | | |
| CR-02 Processing failed | ✓ | ✓ | ✓ | | |
| CR-03 Required document not accepted | ✓ | ✓ | ✓ | | |
| CR-04 Identity conflict | ✓ | ✓ | | | |
| CR-05 Police countdown | ✓ | ✓ | ✓ | | |
| CR-06 Police slip date missing | ✓ | ✓ | ✓ | | |
| CR-07 Police Clearance near expiry | ✓ | ✓ | ✓ | | |
| CR-08 Test passed, unallocated 48 h | ✓ | ✓ | | | |
| CR-09 On a job, no Analyst | ✓ | ✓ | | | |
| CR-10 Allocated to inactive user | ✓ | ✓ | | | |
| CR-11 Stalled candidate | ✓ | ✓ | ✓ | | |
| CR-12 Left without an active job | ✓ | ✓ | ✓ | ✓ | |
| CR-13 Mirror sync dead letter | ✓ | ✓ | | | |
| CR-14 Sheet integration unhealthy | ✓ | ✓ | | | |
| CR-15 Sheet worker offline | ✓ | ✓ | | | |
| CR-16 Form Sheet sync dead letter | ✓ | ✓ | | | |
| CR-17 Intake stuck | ✓ | ✓ | | | |
| CR-18 Verification reset | ✓ | ✓ | ✓ | | |
| CR-19 Form link locked | ✓ | ✓ | | | |
| CR-20 Import failed / conflicts | ✓ | ✓ | | | the importing user |
| CR-21 Documents missing before stage | ✓ | ✓ | ✓ | | |
| CR-22 Review waiting too long | ✓ | ✓ | | | |
| OP-01 User invited / joined | ✓ | ✓ | | | |
| OP-02 Invitation not completed | ✓ | ✓ | | | the inviter |
| OP-03 Role change / deactivation | ✓ | ✓ | | | not the actor |
| OP-04 Form submitted | ✓ | ✓ | ✓ | | |
| OP-05 Allocated to you | | | ✓ | | |
| OP-06 Job assignment changed | | | ✓ | | |
| OP-07 Job filled | ✓ | ✓ | | ✓ | |
| OP-08 Test failed | ✓ | ✓ | ✓ | | |
| OP-09 Milestone reached | ✓ | ✓ | ✓ | | |
| OP-10 Import completed | | | | | the importing user |
| OP-11 Form link expired unused | | | ✓ | | the link creator |
| OP-12 Analyst inactivity | ✓ | ✓ | | | |
| OP-13 Job over vacancies | ✓ | ✓ | | ✓ | |

---

## 8. Deduplication and auto-resolution

- **One active notification per key.** Key = type + subject: a candidate (`passport_id`), a submission (`temporary_id`), a job, a user, an import, or a system component (`SHEET_SYNC`, `FORM_SHEET_SYNC`, `INTAKE`). A new detection of an existing active key **updates** it (last seen, count, severity) and never creates another.
- **Conditions, not events.** Most notifications describe a condition that a periodic check re-evaluates (for example every 15 minutes, and once a day for date-based rules). When the condition no longer holds, the notification is **resolved automatically** (resolved time recorded, kept in history). If it comes back later, it **reopens**, with a reopen count, instead of creating a duplicate.
- **Escalation, not repetition.** Police countdown, Police Clearance expiry and waiting-time alerts change severity on the same notification. They become unread again only when severity rises: no daily repeats.
- **System problems are aggregated.** Sync dead letters, intake backlog and review backlog are one notification each, with a count. Never one per candidate.
- **Event-only items** (CR-20, OP-01, OP-03 to OP-10) have no condition to re-check. They are closed by reading or dismissing, and dedup by their event ID.
- **Reading is per user; resolving is shared.** One person's read doesn't hide the item from others, but a fixed condition resolves it for everyone.
- **History:** keep resolved notifications for a limited period (proposed 30 days for Optional, 90 for Crucial). Audit logs remain the permanent record.

---

## 9. Need Attention: badge and list

Keep the existing **Need Attention** menu item and page (`/follow-ups`). Don't add a new menu area.

- **Two tabs on the page:**
  - **Alerts:** the new notifications, the default when any are active.
  - **Follow-ups:** today's call-log flags, unchanged.
- **Badge** on the Need Attention menu item: the number of **active, unread Crucial** notifications visible to the user, plus their open follow-ups. Red when any Critical item is present, amber otherwise; hidden at 0; "99+" above 99. Optional notifications don't count towards the badge.
- **Small popup:** clicking the badge opens the five newest Crucial items, with "View all" leading to the Alerts tab.
- **Each row shows:**
  - severity chip (Critical / High / Warning / Info)
  - short title
  - reference: candidate name + Unique ID, or the system component, job code or user
  - one-line message, with no passport or NIC numbers
  - first seen / last updated time
  - status: Active, Resolved (with resolved time), or Dismissed
  - an action link: candidate page tab, review item, Police Workflow, Work Allocation, job, or Settings → Google Sheet Sync
- **Filters:** Active / Resolved; Crucial / Optional; severity; "Mine" (as allocated Analyst) for Analysts.
- **Access:** OWNER, ADMIN, ANALYST already see Need Attention. **JOB_HANDLER does not** (the menu item uses the Candidates roles). CR-12, OP-07 and OP-13 address Job Handlers, so their access to the Alerts tab is a decision (§11).

---

## 10. Events that should NOT become notifications (noise)

- Every successful document stored, every OCR result, every duplicate file resent (DUPLICATE). They're visible in Documents and the Daily Report.
- A single transient retry (submission RETRY_LATER, a sync item rescheduled). Only the final failure (CR-02, CR-13, CR-16) or a backlog (CR-17) counts.
- Every call log, stage tick, candidate edit, document upload: these are already in the audit log and candidate history.
- Each successful scheduled Sheet reconcile, each candidate written to the Sheet, Test Connection results.
- Errors the user sees on the spot: registration or import refused for a duplicate passport/NIC/WhatsApp, validation errors, 403s.
- Sign-in, sign-out, password changes and recovery emails (Supabase's).
- **Failed sign-in attempts:** the app doesn't record them; Supabase does. Not detectable without a Supabase log or hook integration.
- **Last-OWNER protection:** the app can no longer change or remove the OWNER (database only), so no in-app event exists. A "no active OWNER" check belongs in a deployment health check, not in notifications.
- Candidate Form draft autosaves, link views, successful verifications.
- Each flag/complete of a call-log follow-up: these already *are* the Need Attention list.
- Agent and client creation or status changes.

---

## 11. Gaps that prevent reliable detection

1. **No notification storage or periodic checker.** Today nothing is saved and nothing runs on a timer except the WhatsApp worker loop and the Sheet Sync schedule. Every time-based rule needs a scheduled evaluator (CR-05 to CR-12, CR-15, CR-17, CR-21, CR-22, OP-02, OP-11, OP-12).
2. **The Police Clearance issue date is not stored.** OCR reads an "issued" date only to help find a slip's submitted date, and `documents.police_submitted_date` is kept for police slips only. CR-07 needs a stored issue date (or expiry) for POLICE_REPORT documents.
3. **No reliable "PASS since" time.** `candidate_stages.updated_at` changes on any edit of the stage. CR-08 should use the audit entry that recorded the PASS; check that the UPDATE_STAGE audit records the test result.
4. **No candidate active/inactive (pipeline) flag.** CR-11 and CR-12 must derive it (§6 item 9). The Sheet's "ACTIVE / INACTIVE" column must use the same definition.
5. **Allocations survive deactivation or role change.** CR-10 detects it; it doesn't fix it.
6. **Failed sign-ins and invitation-link expiry are Supabase's.** The app only sees INVITED and the row's dates.
7. **"Pending field review" is implicit** (no row). CR-01 must compare the response with the current record each time.
8. **Sheet worker liveness:** the heartbeat is only meaningful if the worker is expected to run continuously. If it only runs on the schedule, CR-15 must use "no success since the last expected run" instead.
9. **Documentation conflict:** `JOB_MANAGEMENT_IMPLEMENTATION.md` still says one PROCESSING job per candidate. The code allows several (`20261029120000_job_candidate_multiple_active`). CR-12 uses "no active job at all".
10. **Need Attention access:** JOB_HANDLER can't open it today (§9).
11. **Shared items vs personal read state:** follow-ups are shared team items with no read state, so the badge needs a per-user read record.

---

## 12. Summary for approval

**Crucial — Need Attention (22)**
1. Candidate Form changes waiting for review.
2. Document processing failed.
3. Required document not accepted at review.
4. Identity conflict / ambiguous match.
5. Police Report Due Soon / Due Today / Overdue (one per candidate, escalating).
6. Police slip date missing (countdown can't start).
7. Police Clearance older than 5 months before Visa Submission *(needs the issue date stored)*.
8. Trade Test passed, no Analyst after 48 h.
9. Candidate on a job with no Analyst.
10. Candidates allocated to a deactivated / re-roled user.
11. Stalled candidate (no calls, documents or stage changes for N days).
12. Candidate left without an active job while still in the pipeline.
13. Operational Mirror sync failed after retries.
14. Google Sheet integration unhealthy (headers, config, data integrity, failed run).
15. Sheet Sync worker offline / scheduled sync not succeeding.
16. Candidate Form Sheet sync failed after retries.
17. Document intake stuck (OCR / worker down).
18. Verification reset by a data change.
19. Candidate Form link locked after failed verification attempts.
20. Bulk import failed, stuck or finished with conflicts.
21. *(Proposed)* Required documents missing before IVS / Visa Submission.
22. *(Proposed)* Review items waiting longer than N hours.

**Optional — Informational (13)**
1. New user invited / joined / reactivated.
2. *(Proposed)* Invitation not completed after N days.
3. Role changed / account deactivated.
4. Candidate Form submitted.
5. Candidate allocated to you.
6. Job assignment changed.
7. Job filled.
8. Trade Test failed.
9. Milestone reached (Documents Verified, Visa Document Ready).
10. Bulk import completed.
11. Form link expired without submission.
12. *(Proposed)* Analyst inactivity.
13. *(Proposed)* Job over its vacancies.

**Rules:** one active notification per candidate/subject; updated, not duplicated; resolved automatically when fixed; reopened only if it happens again; system failures aggregated into one alert. **UI:** an Alerts tab plus a badge on the existing Need Attention item (Crucial unread + open follow-ups).

**Decisions needed:** the Police Clearance validity rule and storing its issue date; the thresholds (48 h start point, stalled N days, review waiting N hours, invitation N days); the definition of "in the pipeline"; which stage needs which documents; Analyst inactivity monitoring; whether Job Handlers see Alerts.

---

### Totals

| | Count |
|---|---|
| Crucial notifications | **22** (20 confirmed by the code or requirement, 2 Proposed) |
| Optional notifications | **13** (10 confirmed, 3 Proposed) |
| Items needing business confirmation | **9** (5 Proposed notifications + 4 parameter decisions, §6) |

- **From the initial list:** CR-01, CR-02, CR-03, CR-04, CR-05, CR-07, CR-08, CR-09, CR-11, CR-12, CR-13, OP-01, and the Need Attention badge (§9).
- **New, found during the audit:** CR-06, CR-10, CR-14, CR-15, CR-16, CR-17, CR-18, CR-19, CR-20, OP-03 to OP-11.
- **New, proposed:** CR-21, CR-22, OP-02, OP-12, OP-13.
