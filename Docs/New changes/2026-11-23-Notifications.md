# New feature updates

**Date:** 23 November 2026
**Applies to:** the admin dashboard (`admin/`), the backend (`src/`) and the database (`prisma/`)

This guide explains the notification work in plain language: what changed, how it behaves, and where the code lives. The full reference (every notification with its exact text, testing steps and troubleshooting) is in [13-notifications-guide.md](../13-notifications-guide.md).

| # | Feature | In one sentence |
|---|---|---|
| 1 | Role-based notifications | Every user sees their own notifications in the header bell, with an unread count that is saved per user. |
| 2 | Clearer bell design | Unread and read notifications look clearly different, with small, fast animations. |

---

## 1. Role-based notifications

### What you will notice
The bell in the header now works for **every role**, including Registration Desk and Job Handler (before, their bell was empty). It shows:
- a number badge with your unread count
- a list of your notifications, each with a title, a message and a date and time (Sri Lanka time)

Clicking a notification marks it as read. This stays after you refresh the page or sign in again. Marking a notification read affects only your own copy, never another user's.

### Who gets what
There are 24 notifications, grouped by the code letter: A Analyst, B Registration Desk, C Job Handler, D Team Lead, E Admin, F Owner.

- A user gets only the notifications meant for their own account and role. For example, when candidates are allocated to one Analyst, other Analysts get nothing.
- Team Leads and Owners also receive all Admin notifications (E1 to E10).
- For one Google Sheet Sync failure, Admins and Team Leads get **E9** and Owners get only **F1**.
- The user who cancelled a candidate (E1) or moved one to Need Attention (E2) does not receive that notification.
- Notifications are in the app only. No email, WhatsApp or push.

The full table with each trigger, time and message text is in section 2 of [13-notifications-guide.md](../13-notifications-guide.md).

### When they are sent
| Kind | Notifications | When |
|---|---|---|
| Real time | A1, B2, C1, C2, E1, E2, E9/F1, E10, and runtime F2 | Right after the action, once it has saved |
| Scheduled | A2, A3, B1, C3, D1, D3, D4, E3 to E8 | Daily at 6:00 PM (Asia/Colombo). B1 is sent on the last day of the month. |
| Scheduled | D2 | Daily at 4:00 PM |
| Scheduled | F2 health check | Daily at 6:00 AM |

If a count is 0, nothing is sent. Repeat rules follow the requirements: A2 repeats daily while items are pending, E5 repeats daily after 48 hours, and E7 repeats at 3, 10 and 17 days.

### How it works (for developers)
- **One row per recipient** in a new `notification` table: a notification sent to five users is five rows, so each user's read state is their own.
- **No duplicates:** every row has a dedupe key, and the pair (recipient, key) is unique. A repeated or retried event, a second scan or a server restart adds nothing.
- **Real-time hooks** run after the action commits. If writing a notification fails, the error is logged (`notification.write_failed`, no personal data) and the original action still succeeds.
- **Scheduled scan:** `POST /api/tasks/notification-scan` is called by Cloud Scheduler every 15 minutes. Each rule becomes due at its Asia/Colombo time and can send until the end of that business day. The dedupe keys make this safe to repeat.
- **API:** all roles can call these, and every query is limited to the signed-in user. Another user's notification returns 404.
  - `GET /api/admin/notifications` (newest first, with a cursor)
  - `GET /api/admin/notifications/unread-count`
  - `POST /api/admin/notifications/:id/read`
- **Bell:** the unread count is checked every 30 seconds, paused while the tab is hidden, and refreshed when you open the bell.

### Good to know
- **Password reminders (A3, C3, D4)** use the Supabase `auth.users.updated_at` date, because the app stores no password-change date. Testing showed this date also moves when someone signs in, so the reminders can fire late or rarely for people who sign in often. A later upgrade should add an app-owned `password_changed_at` that is set only when the password changes. Not built yet.
- **C2 (missing country)** covers Agents only. The Client record has no country field.
- **Working days** are Monday to Friday (Saturday and Sunday are not counted). There is no holiday list.
- **E8 (staff inactivity)** watches Analysts and Registration Desk staff only.
- Some time-based rules use the closest available date, because no exact "status started" date is stored: E4 uses the candidate's last activity, E5 uses the later of the flag date and the latest call log. E6 (job created) and E7 (document created) are exact for the current code paths.

### Where the code is
- [prisma/schema.prisma](../../prisma/schema.prisma) (the `Notification` model)
- [src/services/notificationService.js](../../src/services/notificationService.js) (writing and reading, never throws)
- [src/services/notificationRecipients.js](../../src/services/notificationRecipients.js) (who receives what)
- [src/services/notificationEvents.js](../../src/services/notificationEvents.js) (the real-time events and texts)
- [src/services/notificationScanService.js](../../src/services/notificationScanService.js) (scheduled rules and due times)
- [src/routes/tasks.js](../../src/routes/tasks.js) (the scan route) and [src/routes/admin.js](../../src/routes/admin.js) (the notification API)
- [admin/src/components/NotificationBell.tsx](../../admin/src/components/NotificationBell.tsx) and [admin/src/api/notifications.ts](../../admin/src/api/notifications.ts) (the bell)
- Tests: [test/notifications.test.js](../../test/notifications.test.js), [test/notificationScan.test.js](../../test/notificationScan.test.js) and [admin/src/test/notificationBell.test.tsx](../../admin/src/test/notificationBell.test.tsx)

---

## 2. Clearer bell design

### What you will notice
| | Unread | Read |
|---|---|---|
| Background | accent tint | plain, neutral |
| Left edge | coloured bar | none |
| Dot | coloured dot | none |
| Title | bold | normal weight |
| Text | full brightness | muted |

The difference does not rely on colour alone: the bar, the dot and the bold title also show it. Text contrast meets WCAG AA in both the dark and light themes.

Small animations (about 200 to 300 ms, CSS only):
- Marking as read: the tint fades, the bar shrinks and the dot fades, with no row jumping.
- A new notification arriving while the list is open: it slides in from the top with a short glow.
- The bell badge pops when the count changes.

If your device is set to **reduce motion**, the animations are switched off and the unread and read styles still differ.

### Where the code is
- [admin/src/components/NotificationBell.tsx](../../admin/src/components/NotificationBell.tsx)
- [admin/src/index.css](../../admin/src/index.css) (the animation keyframes and the reduced-motion rule)

Nothing about notification logic, the API, read behaviour or the unread count changed in this part. No browser check of the animations was done yet, so please look at both themes.

---

## Database migration

Run it like any other migration (`npx prisma migrate deploy`, never `migrate dev` on a shared database). It is safe: it only adds one table, so **no existing data is touched**.

**Folder:** [prisma/migrations/20261124120000_notifications/](../../prisma/migrations/20261124120000_notifications/migration.sql)

| Object | Used for |
|---|---|
| Table `notification` | One row per recipient: type, title, message, dedupe key, created time, read time |
| Unique index on recipient and dedupe key | No duplicate notifications |
| Index on recipient, read time and created time | A fast bell list and unread count |

Notes:
- The table has row-level security on and no access for the public Supabase roles. Only the backend reads and writes it.
- To roll back, deploy the previous version (or pause the scheduler job), run `DROP TABLE "notification";` and then `npx prisma migrate resolve --rolled-back 20261124120000_notifications`. This deletes all notifications.
- It has been run on test databases (in memory). Apply it to staging first.

---

## Scheduler setup

Scheduled notifications only run when a Cloud Scheduler job calls the scan route. Without it, only the real-time notifications work.

- Set `NOTIFICATION_SCAN_SCHEDULER_AUDIENCE` and `NOTIFICATION_SCAN_SCHEDULER_INVOKER` on each Vercel project that should send them. Without both, the route answers 404.
- Create the job (every 15 minutes, Asia/Colombo). The steps are in section 8 of [Deployment/04-VERCEL-DEPLOYMENT.md](../../Deployment/04-VERCEL-DEPLOYMENT.md).
- Redeploy the Cloud Run sheet worker so the Google Sheet failure notifications (E9 and F1) are sent from it.

---

## New dependencies

None.

---

## Tests
- Backend and admin tests, the typecheck and the build passed when this was written (backend 2,788 passed, 22 skipped; admin 924 passed). The 22 skipped tests are real-OCR tests that only run with `RUN_OCR_TESTS=1`.
- A developer check script, `scripts/checkNotifications.js` (`npm run check:notifications`), creates test users and back-dated data in the dev database and checks every notification. How to run it is in [12-testing-and-quality.md](../12-testing-and-quality.md) and [13-notifications-guide.md](../13-notifications-guide.md).
