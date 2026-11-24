# Notifications Guide

A beginner guide to the in-app notification system: what it does, how it works, how to test it, how to deploy it and how to fix common problems. Every path, command and text below was checked against the code at the time of writing. Commands were not run for this guide.

Related documents:

- Test commands in general: [12-testing-and-quality.md](12-testing-and-quality.md)
- Scheduler setup (Cloud Scheduler job and variables): section 8 of [../Deployment/04-VERCEL-DEPLOYMENT.md](../Deployment/04-VERCEL-DEPLOYMENT.md)
- Database and migrations: [../Deployment/03-SUPABASE-SETUP.md](../Deployment/03-SUPABASE-SETUP.md)

## 1. What It Is

The notification bell is in the header of the Admin dashboard. It shows a red number (the unread count). Click it to see a list of short messages for you.

Example: an Admin allocates 3 candidates to an Analyst. The Analyst sees the bell count go up. The message says "You have received 3 new candidates."

Key facts:

- Notifications are in-app only. No e-mail, no WhatsApp.
- Every signed-in role has a bell.
- Each person sees only their own notifications. Read or unread is per person.

## 2. Who Gets What

### Code letters

| Letter | Role | Role value in code |
|---|---|---|
| A | Analyst | `ANALYST` |
| B | Registration Desk | `REGISTRATION_DESK` |
| C | Job Handler | `JOB_HANDLER` |
| D | Team Lead | `TEAM_LEAD` |
| E | Admin | `ADMIN` |
| F | Owner | `OWNER` |

### Rules

- Only ACTIVE users receive notifications. Recipients are read from the `user` table on the server, never from a request.
- "Admin audience" means Owner, Admin and Team Lead. E1, E2, E3, E4, E5, E6, E7, E8 and E10 go to this audience (`AUDIENCE.ADMIN_TEAM`).
- E9 goes to Admin and Team Lead only (exact roles). The Owner gets F1 instead, for the same Google Sheet event.
- F2 goes to the Owner only.
- D1 to D4 go to the Team Lead only.
- E1 and E2 are never sent to the user who did the action.
- A, B and C notifications go only to the role named in the table.
- Role matching is exact. For example, A1 goes only to users whose role is exactly `ANALYST`.

### All 25 notifications

`[X]`, `[Y]`, `[N]`, `[Name]` are placeholders filled in by the code. Times are Asia/Colombo.

| Code | Recipient | Trigger | When | Title | Message |
|---|---|---|---|---|---|
| A1 | The Analyst who received candidates (role must be exactly `ANALYST`) | Candidates assigned, auto-allocated, or allocated by a bulk import (once per import) | Real time | New Candidates Allocated | You have received [X] new candidate(s). (singular: "1 new candidate.") |
| A2 | Each Analyst, own count | Analyst has open follow-ups in Need Attention (count above 0) | Scheduled, 18:00, every day while above 0 | Pending Follow-ups | 1: "You have 1 pending follow-up in Need Attention. Please review it." More: "You have [X] pending follow-ups in Need Attention. Please review them." |
| A3 | Each active Analyst | 3 months since last password change | Scheduled, 18:00, once per change | Password Change Reminder | It has been 3 months since your last password change. Please update your password for security. |
| A4 | The Analyst the candidate is allocated to (role must be exactly `ANALYST`) | The candidate submits the public Candidate Form | Real time | Candidate Form Submitted | [Candidate name] has submitted the candidate form. (fallback: the passport number) |
| B1 | Each Registration Desk user, own count | Last day of the month, count above 0 | Scheduled, 18:00 on the last day of the month | Monthly Registration Summary | You have registered [X] candidate(s) this month. (singular: "1 candidate") |
| B2 | The user whose role changed | Role changed and the old or the new role is `REGISTRATION_DESK` | Real time | Role Updated | Your role has been changed to [Role label]. |
| C1 | Job Handlers | A new job is added and eligible candidates are on no job | Real time | New Job Added | A new job has been added. Job ID: [Job code]. Please review the details. |
| C2 | Job Handlers | A new Agent was created without a country (bulk import or service path) | Real time | Missing Country Information | Country information is missing for [Name]. Please update the details. |
| C3 | Each active Job Handler | 2 months since last password change | Scheduled, 18:00, once per change | Password Change Reminder | It has been 2 months since your last password change. Please update your password for security. |
| D1 | Team Lead | Unallocated candidates exist (Work Allocation "Unallocated" count above 0) | Scheduled, 18:00, daily | Unallocated Candidates | You have [X] unallocated candidate(s) waiting for assignment. (singular: "1 unallocated candidate") |
| D2 | Team Lead | Today's Daily Report summary has figures above 0 | Scheduled, 16:00, daily | Daily Report Updated | The daily report has been updated: [Label]: [count], [Label]: [count]. Please review the latest information. |
| D3 | Team Lead | A PROCESSING job has vacancies and no active candidate | Scheduled, 18:00, once per job | New Vacancies Available | [X] new vacancy is / vacancies are available for Job [Job code]. [Y] free candidate is / candidates are eligible to be added to this job. (second sentence only when [Y] is above 0) |
| D4 | Each active Team Lead | 30 days since last password change | Scheduled, 18:00, once per change | Password Change Reminder | It has been 30 days since your last password change. Please update your password for security. |
| E1 | Admin audience, not the actor | A candidate is marked Cancelled | Real time | Candidate Cancelled | [Actor name] marked [Candidate name] as Cancelled. (fallbacks: "A user", "a candidate") |
| E2 | Admin audience, not the actor | A candidate is moved to Need Attention (follow-up opened) | Real time | Candidate Moved to Need Attention | [Candidate name] has been moved to the Need Attention tab. (fallback: "A candidate") |
| E3 | Admin audience | Candidates created today (count above 0) | Scheduled, 18:00, daily | New Candidates Added | 1: "1 new candidate has been added to the system today." More: "[X] new candidates have been added to the system today." |
| E4 | Admin audience | Candidates with missing documents or information that crossed 3 days without activity | Scheduled, 18:00, daily | Missing Documents or Information | 1: "1 candidate has had missing documents or information for more than 3 days without follow-up. Please review them." More: "[X] candidates have had ..." (same ending) |
| E5 | Admin audience | Open follow-ups not updated for 48 hours or more | Scheduled, 18:00, daily while any exist | Need Attention Follow-ups Pending | 1: "1 Need Attention follow-up has not been updated for more than [N] days. Please review it." More: "[X] Need Attention follow-ups have not been updated for more than [N] days. Please review them." |
| E6 | Admin audience | Jobs that crossed 3 days in Processing today | Scheduled, 18:00, daily | Jobs Stuck in Processing | 1: "1 job has remained in Processing for more than 3 days. Please check its status." More: "[X] jobs have remained in Processing for more than 3 days. Please check their status." |
| E7 | Admin audience | Documents still in review at day 3, 10, 17, ... | Scheduled, 18:00, one per milestone crossed that day | Documents Awaiting Review | 1: "1 document has been waiting for review for more than [N] days. Please review it." More: "[X] documents have been waiting for review for more than [N] days. Please review them." |
| E8 | Admin audience | An Analyst or Registration Desk user has no calls and no uploads for the last 2 working days | Scheduled, 18:00, working days only | Staff Inactivity | [Name] has recorded no calls or documents for the last 2 working days. Please review their activity. |
| E9 | Admin and Team Lead (never Owner) | A Google Sheet sync failure | Real time | Google Sheet Sync Failed | Google Sheet Sync has failed. Please check the connection and synchronization status. |
| E10 | Admin audience | A Candidate Form link could not be generated for a system reason (at most once an hour) | Real time | Candidate Form Link Failed | A Candidate Form link could not be generated. Please check the issue. |
| F1 | Owner only | The same Google Sheet failure as E9 | Real time | Google Sheet Sync Error | Google Sheet Sync has encountered an error. Please check the synchronization status. |
| F2 | Owner only | A server error (HTTP 500) or the daily health check finds a problem | Real time, and scheduled 06:00 | System Alert | System alert: [Issue]. Please check the system status. |

Notes on the table:

- B2 role labels: Owner, Admin, Team Lead, Analyst, Registration Desk, Job Handler.
- C2 covers Agents only. A Client has no country field.
- E8 watches only Analysts and Registration Desk staff. It never names an Owner, Admin or Team Lead.
- F2 issues in code: Unhandled server error, Database error, Document processing failed, Document processing is delayed, Sheet sync worker is not responding, Bulk import recovery needs attention.
- The same F2 issue is sent at most once per business day.
- Texts never contain a passport number, NIC or phone number, except A4: when the candidate has no name, A4 shows the passport number instead. Names appear only where the notification names someone.
- A4 is sent once per submission. A form can be submitted only once, so a candidate gets at most one A4. An unallocated candidate, or one allocated to a user who is not an active Analyst, sends nothing.

## 3. How It Works (Simple)

### The table

One table, `notification`, one row per recipient. A message for 5 people is 5 rows.

| Column | Meaning |
|---|---|
| `id` | Row id (UUID) |
| `recipient_id` | The user who gets it |
| `type` | The notification key, for example `A1_NEW_CANDIDATES_ALLOCATED` |
| `title`, `message` | Display text |
| `dedupe_key` | Identifies the event (see below) |
| `created_at` | When it was written |
| `read_at` | Empty means unread. Set once, by the recipient only |

### Real-time hooks

- The code calls a notify function after the action's database transaction has committed.
- `notify` never throws. If writing a notification fails, the error is logged (`notification.write_failed`) and the action still succeeds.
- A rolled-back action sends nothing.

### The scheduled scan

- Endpoint: `POST /api/tasks/notification-scan`.
- Cloud Scheduler calls it every 15 minutes.
- Each call checks the Asia/Colombo clock and runs the rules that are due. A rule runs on every scan from its due time to the end of that business day. A missed 18:00 run is made up by a later run the same day.
- Previous days are not back-filled.
- Rules due (from `SCAN_RULES`):

| Due | Rules |
|---|---|
| 06:00 | F2 (health check), PURGE (deletes notifications older than 90 days, 06:00 hour only) |
| 16:00 | D2 |
| 18:00 | A2, A3, C3, D4, B1, D1, D3, E3, E4, E5, E6, E7, E8 |

- Each rule is isolated: one failing rule does not stop the others. The run stops starting new rules after 40 seconds.
- The answer lists each rule as `NOT_DUE`, `DONE`, `SKIPPED` or `FAILED` (or `OUT_OF_TIME`), with counts only.

### Dedupe keys

The table has a unique index on (`recipient_id`, `dedupe_key`). Inserts use `ON CONFLICT DO NOTHING`. A repeated or overlapping run adds nothing.

| Key shape | Example meaning |
|---|---|
| `A1:<batchId>` | One allocation action (bulk import: `import:<importId>`) |
| `A4:<passportId>:<submittedAt>` | One form submission |
| `E2:<followUpId>` | One follow-up |
| `D2:<date>` | One day |
| `A2:<analystId>:<date>` | One Analyst, one day |
| `E7:N<days>:<date>` | One review milestone, one day |
| `F2:<issue>:<date>` | One system issue, one day |
| `E10:<YYYY-MM-DDTHH>` | One hour (UTC) |

### The bell

- The bell checks the unread count when it loads, then every 30 seconds while the browser tab is visible.
- Opening the bell loads the list (30 per page, newest first, "load more" for older ones).
- Clicking an unread item marks it as read for you only.
- API (all roles, always scoped to the signed-in user):

| Method and path | Use |
|---|---|
| `GET /api/admin/notifications?limit=&cursor=` | The list and the unread count (limit 1 to 100, default 30) |
| `GET /api/admin/notifications/unread-count` | Only the count |
| `POST /api/admin/notifications/:id/read` | Mark one as read. Another user's id gives 404 |

## 4. Where the Code Lives

| Part | Path |
|---|---|
| Prisma model `Notification` | `prisma/schema.prisma` |
| Migration | `prisma/migrations/20261124120000_notifications/migration.sql` |
| Write and read notifications | `src/services/notificationService.js` |
| Who receives (audiences) | `src/services/notificationRecipients.js` |
| Real-time events and texts | `src/services/notificationEvents.js` |
| Scheduled rules and texts (`MESSAGES`, `SCAN_RULES`) | `src/services/notificationScanService.js` |
| Business day and Asia/Colombo helpers | `src/utils/businessDay.js` |
| Bell API routes | `src/routes/admin.js` (search for "notifications") |
| Scan route and its auth | `src/routes/tasks.js` |
| Server error alert (F2 real time) | `src/middleware/errorHandler.js`, wired in `src/app.js` |
| Bell component | `admin/src/components/NotificationBell.tsx` |
| Bell API client | `admin/src/api/notifications.ts` |
| Bell animations | `admin/src/index.css` (`notif-arrive`, `notif-badge-pop`, `notif-badge-down`) |
| Header (shows the bell) | `admin/src/layout/Header.tsx` |

Trigger sites (where real-time notifications are sent):

| Notification | File |
|---|---|
| A1 | `src/services/workAllocationService.js`, `src/services/candidateImportService.js` |
| A4 | `src/services/candidateFormDataService.js` (`submitCandidateForm`) |
| B2 | `src/services/userAccountService.js`, `src/services/retiredRoleService.js` |
| C1 | `src/services/jobService.js`, `src/services/candidateImportService.js` |
| C2 | `src/services/agentService.js`, `src/services/candidateImportService.js` |
| E1 | `src/services/candidateFinalStatusService.js`, `src/services/candidateImportService.js` |
| E2 | `src/services/callLogFollowUpService.js`, `src/services/candidateService.js` |
| E9 and F1 | `src/services/sheetSyncStore.js`, `src/services/formSubmissionSyncStore.js` |
| E10 | `src/routes/admin.js` |
| F2 | `src/middleware/errorHandler.js` and the health check in `notificationScanService.js` |

## 5. How It Was Tested

### Automated tests

| File | Covers |
|---|---|
| `test/notifications.test.js` | Writing, recipients, real-time events, bell API (PGlite database) |
| `test/notificationScan.test.js` | The scheduled scan and the scan route (PGlite database) |
| `test/candidateImportProcess.test.js` | Notifications sent by a committed bulk import |
| `test/candidateFormSubmittedNotification.test.js` | A4, sent by a real Candidate Form submission (PGlite database) |
| `admin/src/test/notificationBell.test.tsx` | The bell component |

Other test files that mention notifications or the bell: `test/adminReviewActions.test.js`, `test/roleScopeRegression.test.js`, `admin/src/test/auth.test.tsx`, `admin/src/test/candidates.test.tsx`, `admin/src/test/roleNavigation.test.tsx`. What exactly they assert was not verified.

Commands (from the project root):

```bash
node --test test/notifications.test.js
node --test test/notificationScan.test.js
npm test                                  # all backend tests
npm run admin:test                        # all admin tests (Vitest)
npm --prefix admin run typecheck          # admin type check
npm run admin:build                       # admin type check and build
```

### End-to-end check script (live dev database)

`scripts/checkNotifications.js` drives the real app against a real dev database. Use it only on a dev or testing database, never on production. It is not part of the application.

Where it is:

- It is in the working folder of the `feature/notifications` branch, but not committed at the time of writing (`git status` shows it as new).
- The branch `tools/notification-e2e-check` was not found in this repository, so the "which branch holds it" question is not verified. Ask the team where the committed copy lives.
- `package.json` has the script `check:notifications` (also not committed at the time of writing).

Run it:

```bash
npm run check:notifications                    # run, then remove the test data
npm run check:notifications -- --keep          # keep test users and data for manual checks
npm run check:notifications -- --self-test     # check only the script's own helpers, no database
```

Environment variable names (set in `.env` or the shell; values are never printed):

| Name | Required | Note |
|---|---|---|
| `DATABASE_URL` | Yes | The dev database |
| `SUPABASE_URL` | Yes | |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | |
| `SUPABASE_ANON_KEY` or `VITE_SUPABASE_ANON_KEY` | For sign-in | If neither is set the script falls back to the service key (see script) |
| `E2E_NOTIF_PASSWORD` | No | 12 or more characters. Lets you sign in as the test users after `--keep` |
| `E2E_NOTIF_EMAIL_DOMAIN` | No | Default `example.com` |

Flags:

| Flag | Meaning |
|---|---|
| `--keep` | Do not clean up. Test users and data stay for manual UI checks |
| `--verbose` | Print full failure reasons in the table |
| `--allow-sheet-sync` | Run even if the Google Sheet sync worker is live |
| `--self-test` | Check the script's own helpers. No credentials or database needed |
| `--help` | Print usage |

What it does:

1. Creates 7 test users with the marker `e2e-notif-`: 2 Analysts, a Team Lead, a Registration Desk user, a Job Handler, an Admin and an Owner. Emails use the domain `example.com` by default.
2. Signs them in for real tokens and starts the real Express app inside the script.
3. Triggers the real-time events through the real API, then reads each user's own list and checks recipients, titles and exact texts.
4. Runs the scheduled rules with a controlled clock (before due, at due, again, next day) on back-dated test data.
5. Checks read state, paging and cross-user security (another user's cursor gives 400, another user's id gives 404).
6. Cleans up (unless `--keep`).

Why it refuses to run when the sheet worker is live: test candidates fire the sheet-sync triggers. A live worker (configured, heartbeat in the last 10 minutes) could write them to the real Google Sheet. Use `--allow-sheet-sync` only when you are sure.

How to read the output:

- A table with columns ID, Check, Result (`PASS` or `FAIL`) and Reason (only on FAIL), then a summary line such as `Summary: N checks, N passed, N failed`.
- If anything fails, a "Failures (full reasons)" section prints full reasons, the notification rows of each test user, the database and machine clocks, and any `notification.write_failed` log line.
- Exit codes: 0 all passed, 1 a check failed or the run broke, 2 not configured.

Cleanup:

- Only rows with the marker `e2e-notif-` are removed (passport IDs use `E2ENOTIF`).
- `audit_logs` is append-only and its link to the user is RESTRICT. A test user who made audited changes cannot be deleted. That user is set INACTIVE, its Supabase identity is removed, and the next run reuses it.
- The retention purge rule is never run by the script.

### Manual bell check

- [ ] Sign in. The bell is in the header.
- [ ] The red number equals the number of unread items.
- [ ] Open the bell. Unread items are highlighted (bar, bold title).
- [ ] Click an unread item. It turns to the read style and the count drops by 1.
- [ ] Refresh the page. The read state stays and the count is the same.
- [ ] Sign in as a different user. You see only that user's notifications and count.
- [ ] Repeat in light and dark theme.

### What is simulated and what is real

| Where | Simulated | Real |
|---|---|---|
| Unit tests (`test/notifications.test.js`, `test/notificationScan.test.js`) | In-memory Postgres (PGlite) with every migration applied. A stand-in `auth.users` table (PGlite has no Supabase auth schema). Test users. A controlled clock (`now`) | App code, services, real Prisma client |
| Admin tests | Mocked API calls | The bell component |
| Check script | Back-dated test data. Controlled clock for scheduled rules | Real Express API, real Supabase Auth, real database, real tokens |

## 6. Deployment Notes

1. Migration name: `20261124120000_notifications`. It adds one table and touches nothing else.
2. Apply it with:

```bash
npx prisma migrate deploy
```

Never use `npx prisma migrate dev` on a shared database. See [../Deployment/03-SUPABASE-SETUP.md](../Deployment/03-SUPABASE-SETUP.md).

3. Scheduled notifications need a Cloud Scheduler job and two variables, `NOTIFICATION_SCAN_SCHEDULER_AUDIENCE` and `NOTIFICATION_SCAN_SCHEDULER_INVOKER`. Full steps: section 8 of [../Deployment/04-VERCEL-DEPLOYMENT.md](../Deployment/04-VERCEL-DEPLOYMENT.md).
4. Set them per Vercel project. The production site needs its own two variables and its own scheduler job. A job aimed at another deployment does nothing for this one.
5. Redeploy the Cloud Run sheet sync worker so the E9 and F1 hooks run there. The worker needs no extra variable for notifications.
6. Roll back:
   - Deploy the previous app version, or pause the scheduler job.
   - To remove the table (this deletes all notifications):

```sql
DROP TABLE "notification";
```

```bash
npx prisma migrate resolve --rolled-back 20261124120000_notifications
```

Vercel rollback does not roll back the database. See the Rollback section of [../Deployment/04-VERCEL-DEPLOYMENT.md](../Deployment/04-VERCEL-DEPLOYMENT.md).

## 7. Known Limitations

- **Password reminders (A3, C3, D4).** The app stores no password-change date. The reminders read `auth.users.updated_at`, then the account's activation date, then its creation date. The team confirmed in testing that `updated_at` moves on sign-in. So the reminders may fire late or rarely for people who sign in often. Planned upgrade (not built): an app-owned `password_changed_at` that changes only when the password changes. If the `auth.users` table is absent, these rules send nothing.
- **Sheet sync health.** F2 reports `Sheet sync worker is not responding` only from the daily 06:00 check, and only when the sync is configured and the worker heartbeat is older than 2 minutes (or missing). There is no instant alert for a worker that is offline. E9 and F1 are sent for failed runs and dead-lettered rows, not for an offline worker.
- **E4 proxy.** "Last activity" is the latest of registration, latest call log and latest follow-up flag or completion. Completed placements (Departed, Cancelled, Rejected) are left out.
- **E5 proxy.** "Last update" is the later of the flag time and the candidate's latest call log. The day number shown is at least 2.
- **E6 and E7 timestamps.** E6 uses `job.created_at` as the time a job entered Processing. E7 uses `documents.created_date` as the time a document became REVIEW_REQUIRED. The code comments explain why both are safe.
- **D2.** "New updates" means each Daily Report summary figure above 0. If all are 0, nothing is sent.
- **E8.** No holiday list. Working days are Monday to Friday only (Saturday and Sunday are not working days). New staff (activated after the window starts) are not judged yet.
- **B1.** Sent only on the last day of the month, to Registration Desk users with a count above 0.
- **A1.** Only users whose role is exactly `ANALYST`.
- **C1 and D3 eligibility.** A candidate is eligible when the saved Test details result is PASS and the candidate is on no active job.
- Notifications older than 90 days are deleted by the daily purge.

## 8. Troubleshooting

| Problem | What you see | Fix |
|---|---|---|
| Hidden character in `DATABASE_URL` | "Database does not exist" although the name looks right. The team found an invisible zero-width character at the end of the value. (Found by the team; not verifiable from code.) | Type the value again by hand, do not copy it. Check its length: it should match the visible text. Save and retry |
| Missing environment variables | The check script prints "Not configured: set ..." and exits with code 2 | Set `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Also set an anon key (`SUPABASE_ANON_KEY` or `VITE_SUPABASE_ANON_KEY`) for sign-in. If `E2E_NOTIF_PASSWORD` is set it must have 12 or more characters (also exit code 2) |
| Sheet sync safety stop | The script stops with "The Google Sheet sync worker of this database is live ..." | Stop the worker, or use `--allow-sheet-sync` only when you are sure no real sheet can be written |
| Clock difference | A row seems missing when compared by time | `created_at` is written by the machine that inserts the row, not by the database. The script therefore finds new notifications by id, not by time. Compare the two clocks in the "Failures" section |
| Scheduled notifications never appear | No D1, E3 and so on. The scan route answers 404 | The route answers 404 unless both `NOTIFICATION_SCAN_SCHEDULER_AUDIENCE` and `NOTIFICATION_SCAN_SCHEDULER_INVOKER` are set. Also check the Cloud Scheduler job exists and points at this deployment. A 401 means the token is not valid |
| Trigger one scan by hand | | See the command below |
| Same notification twice | Not expected | Check the `dedupe_key` of both rows. The same recipient and key cannot exist twice |
| No scheduled rows for a rule | Rule shows `SKIPPED` or `NOT_DUE` in the answer | `NOT_DUE`: the Colombo time is before the due time. `SKIPPED`: the rule's own condition is false (for example B1 on a day that is not the last of the month, E8 on a weekend) |

Trigger one run and read the answer (variables as in the Deployment guide):

```bash
gcloud scheduler jobs run emlynk-notification-scan --project=$PROJECT --location=$REGION
```

The job name `emlynk-notification-scan` is the one used in the Deployment guide. The answer is 200 with each rule and its status and counts. The function log has one `notification_scan.run` line per call. A rejected token logs `notification_scan.trigger_rejected`.

## 9. Glossary

| Term | Meaning |
|---|---|
| Dedupe key | A text that identifies one event for one recipient. With the recipient it is unique, so the same event cannot be stored twice |
| Scheduled scan | The job at `POST /api/tasks/notification-scan` that sends the notifications that are due by the clock |
| Real-time hook | A call to a notify function right after an action commits (for example cancelling a candidate) |
| Migration | A versioned database change under `prisma/migrations` |
| Staging | A separate copy of the system used for testing before production. Not verified for this project's setup |
| Cloud Scheduler | The Google Cloud service that calls the scan endpoint every 15 minutes |
| PGlite | A small in-memory PostgreSQL used in the unit tests |
| Business time zone | `Asia/Colombo`. All "daily" and "due" times use it |
| Recipient | The user a notification row belongs to |
| Unread count | The number of the user's rows where `read_at` is empty. Shown on the bell |
| Audience | A group of roles that receives a notification (for example Owner, Admin and Team Lead) |
| Marker | The prefix `e2e-notif-` on every test row made by the check script |
| Working day | Monday to Friday. There is no holiday list |
