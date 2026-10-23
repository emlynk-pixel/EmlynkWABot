# EmlynkWABot — Project Issues, Errors, Blockers, Fixes & Lessons Learned

> **Purpose of this document**  
> This document records the major technical issues, blockers, deployment problems, account/setup problems, database/authentication problems, Google Cloud issues, Google Sheet Sync issues, Git/branching problems, and other important debugging situations encountered while building **EmlynkWABot**.  
>
> It is written as an easy-to-follow project history and troubleshooting reference so a developer, senior engineer, or future maintainer can understand:
>
> - what went wrong,
> - how the issue appeared,
> - what the real root cause was,
> - what was tried,
> - what finally solved it,
> - and what remains pending or on hold.

---

## 1. Project Overview

**EmlynkWABot** is an internal recruitment/agency system used to manage candidates and clients for overseas recruitment workflows.

The solution has several major parts:

- WhatsApp document intake
- Meta WhatsApp Business integration
- Candidate registration and management
- Admin dashboard
- Document upload and verification
- OCR/document extraction
- Supabase PostgreSQL database
- Supabase Storage
- Supabase Auth
- Prisma ORM
- Google Sheet operational mirror
- Google Cloud Run workers
- Vercel preview/staging deployment
- React + TypeScript + Vite admin application
- Node.js + Express backend

The architecture evolved significantly during development. Several features that originally lived together were separated for reliability and deployment reasons.

---

# 2. Final High-Level Architecture

The final direction of the system became:

```text
WhatsApp / Admin UI
        |
        v
Node.js / Express API
        |
        +--------------------+
        |                    |
        v                    v
Supabase PostgreSQL     Supabase Storage
        |
        +--------------------+
        |                    |
        v                    v
Supabase Auth        Google Sheet Sync Queue
                             |
                             v
                      Cloud Run Worker
                             |
                             v
                       Google Sheets

Document processing:
WhatsApp / Upload
      |
      v
Backend / Queue
      |
      v
OCR Worker on Google Cloud Run
```

Important architectural principles that emerged:

1. **Database is the source of truth.**
2. **Google Sheet is a one-way mirror: DB → Sheet.**
3. **OCR is separated from the main web application.**
4. **Supabase Auth owns passwords, sessions, invites, and recovery.**
5. **Prisma manages the application schema, but not Supabase's internal Auth schema.**
6. **Heavy workers run on Cloud Run.**
7. **Admin preview/testing runs through the `stage` branch and Vercel.**
8. **Completed feature snapshots are kept in `version/*` branches.**

---

# 3. Git & Branching Workflow

## 3.1 Initial Branching Confusion

During early development, several branches existed at the same time:

- `main`
- `dev`
- `stage`
- `version/Admin-dashboard`
- `version/Cloud-run-worker`
- `version/candidate-management-pool`
- `version/ocr-cloud-run-v1`
- `version/google-sheet-sync`
- `version/database-auth-restructure`
- `dev-seed-data`
- `local-postgres-backup`

This caused several situations where a fix existed in one branch but was not available in another.

### Example

A Vercel build error existed in `dev`, while a fix already existed in:

```text
origin/version/Cloud-run-worker
```

This made it look like the application was still broken even though the fix already existed elsewhere.

### What we did

We used Git comparison commands such as:

```powershell
git branch
git branch -a
git log --oneline --decorate -5
git log --oneline --left-right stage...dev
git branch -vv
```

This allowed us to confirm which branch contained the actual fix.

### Lesson

Before editing code for a build error:

1. Check whether another branch already contains the fix.
2. Check whether the current branch is behind.
3. Avoid duplicating or rewriting an already completed solution.

---

## 3.2 Stage Branch Requirement

The senior requested:

```text
dev
  -> completed version branch
  -> stage
  -> testing / Vercel preview
  -> later PR / merge to main
```

The important requirement was:

> **Do not change `main` until integration is approved.**

A dedicated `stage` branch was created so the latest integrated work could be tested without affecting production.

---

## 3.3 Version Branch Strategy

For completed features, a snapshot branch is created.

Examples:

```text
version/ocr-cloud-run-v1
version/google-sheet-sync
version/database-auth-restructure
```

This has two benefits:

- preserves the completed feature state,
- allows future work to continue on `dev`.

---

## 3.4 Local Dev Ahead of Remote

At one point:

```text
On branch dev
Your branch is ahead of 'origin/dev' by 12 commits.
```

This was not an error.

It meant:

- local work was committed,
- but remote `origin/dev` had not been updated yet.

The safe action was:

```powershell
git push origin dev
```

after confirming the work was ready.

---

# 4. Windows / PowerShell Setup Problems

## 4.1 PowerShell Execution Policy Blocking npm

A new/local machine produced a PowerShell error similar to:

```text
PSSecurityException
UnauthorizedAccess
```

when trying to run npm commands.

### Root Cause

PowerShell script execution policy blocked npm's PowerShell scripts.

### Fix

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Then reopen the terminal and retry.

### Lesson

When Node/npm works in CMD but not PowerShell, check PowerShell execution policy before reinstalling Node.

---

## 4.2 Linux-Style `\` Commands on Windows

During Google Cloud Artifact Registry setup, a multi-line command written with Linux-style backslashes was used in Windows CMD.

Example concept:

```bash
gcloud artifacts repositories create ... \
  --repository-format=docker \
  --location=asia-south1
```

Windows interpreted `\` incorrectly and treated parts of the command as arguments.

### Fix

Use:

- a single-line command, or
- PowerShell backticks:

```powershell
gcloud artifacts repositories create ... `
  --repository-format=docker `
  --location=asia-south1
```

### Lesson

Always adapt shell syntax to the current OS.

---

# 5. OCR Separation & Google Cloud Run

## 5.1 Why OCR Was Separated

OCR processing was too heavy and unsuitable for the main Vercel/serverless runtime.

The OCR service was moved into:

```text
ocr-worker/
```

and deployed separately to Google Cloud Run.

Technology included:

- Tesseract.js
- PDF parsing
- thresholding
- auto rotation
- upscaling
- confidence scoring

---

## 5.2 Google Cloud Setup

A Google Cloud project was used:

```text
Project ID:
project-aa11e15e-a951-4e1b-a65

Region:
asia-south1
```

Artifact Registry repository:

```text
emlynk-ocr
```

Image path pattern:

```text
asia-south1-docker.pkg.dev/project-aa11e15e-a951-4e1b-a65/emlynk-ocr/ocr-worker:latest
```

---

## 5.3 Cloud Run Authentication Problem

The OCR worker could be called manually with authentication, but the Express backend initially could not authenticate correctly when calling the Cloud Run service.

### Fix

The backend added:

```text
google-auth-library
```

and used proper authenticated service-to-service requests.

### Result

The OCR worker could be called from the main backend without making the Cloud Run service public.

---

## 5.4 `gcloud logs --follow` Error

A command was attempted:

```powershell
gcloud run services logs read emlynk-ocr-worker --region asia-south1 --follow
```

The CLI returned:

```text
ERROR: (gcloud.run.services.logs.read) unrecognized arguments: --follow
```

### Cause

The installed/current gcloud command did not support `--follow` for that command.

### Lesson

Do not assume flags from other logging commands are supported by every gcloud command.

---

# 6. Vercel Deployment Problems

Vercel was used primarily for the admin preview/staging deployment.

---

## 6.1 TypeScript Build Errors

One major deployment failure came from TypeScript errors in:

```text
ReviewDetailPage.tsx
```

Errors included:

```text
TS2367
TS2304
TS2345
```

and references to:

```text
deleteTemporary
deleteTemporaryDocument
```

### Root Cause

The branch being deployed did not contain the newer fix.

### Resolution

The fix was found in another branch and later integrated instead of rewriting the same fix.

### Lesson

A deployment build error can be a **branch synchronization problem**, not always a code-writing problem.

---

## 6.2 Wrong Build Path / `admin/admin/package.json`

Another Vercel error was:

```text
ENOENT ... /admin/admin/package.json
```

### Root Cause

The project root/build settings and npm working directory were incorrectly combined.

### Final Vercel build direction

Install:

```text
npm ci && npm --prefix admin ci
```

Build:

```text
npm --prefix admin run build -- --outDir ../public/admin --emptyOutDir
```

Output directory:

```text
public
```

Frontend base:

```text
/admin/
```

React Router basename:

```text
/admin
```

---

## 6.3 Admin Deep Links Returning 404

The root admin page loaded, but deep links failed.

### Root Cause

Vite base path and router basename were not aligned with `/admin`.

### Fix

Use:

```text
base: "/admin/"
```

and:

```text
basename="/admin"
```

and build into:

```text
public/admin
```

---

## 6.4 `/auth/login` 500 on Preview

The preview deployment later reached the admin page but login returned HTTP 500.

Error:

```text
Prisma P2010
```

One major complication was that a database-backed rate limiter executed **before** the login logic.

The rate limiter used the `rate_limits` table.

### Investigation

We checked:

- migrations,
- `public.rate_limits`,
- schema qualification,
- Vercel proxy headers,
- database connectivity.

### Fixes Made

1. SQL references were schema-qualified:

```text
public.rate_limits
```

2. `trust proxy` was configured for Vercel:

```text
1 hop
```

This removed `X-Forwarded-For` warnings and restored correct per-client rate limiting.

### Important Lesson

If an auth endpoint fails before auth code runs, inspect middleware order first:

```text
rate limit
-> auth middleware
-> route
```

The visible route name does not always identify the actual failing component.

---

# 7. Environment Variable Problems

## 7.1 Missing Vercel `DATABASE_URL`

At one stage the Vercel environment did not contain `DATABASE_URL`.

The local `.env` and Vercel environments were not identical.

### Lesson

For every environment:

- Local `.env`
- Vercel env
- Cloud Run env

must be treated separately.

Changing local `.env` does **not** automatically change Vercel or Cloud Run.

---

## 7.2 Recovering Environment Variables on a New PC

An old PC became unavailable.

The project already had environment values in Vercel, so instead of asking anyone to paste secrets into chat, the safe workflow was:

```powershell
vercel login
vercel link
vercel env pull .env
```

### Lesson

Use the deployment platform as the source for environment recovery instead of manually copying secrets through messages.

---

# 8. Prisma & Supabase Database Management

## 8.1 Misunderstanding About Manual Supabase Changes

A recurring question was:

> If Prisma is used, do we manually edit Supabase DB?

The general answer became:

```text
schema.prisma
   ->
Prisma migration
   ->
Supabase PostgreSQL
```

Development:

```powershell
npx prisma migrate dev
```

Deployment:

```powershell
npx prisma migrate deploy
```

Status:

```powershell
npx prisma migrate status
```

Manual Supabase SQL should only be used for special cases such as:

- RLS,
- extensions,
- special triggers,
- controlled migration repair,
- cross-schema Supabase-specific constraints.

---

# 9. Candidate Database Rename

Originally the candidate table was:

```text
users
```

and the staff/admin table was:

```text
admins
```

This naming became confusing, especially after introducing Supabase Auth.

Final target:

```text
public.candidate
public."user"
auth.users
```

---

## 9.1 Rename Migration

Migration:

```text
20261008120000_rename_candidate_user_tables
```

Changed:

```text
users  -> candidate
admins -> user
```

It also renamed constraints/indexes and updated Sheet Sync trigger/function references.

---

## 9.2 Why We Did Not Run All Migrations Immediately

The next migration required every staff user to have:

```text
auth_user_id
```

linked to:

```text
auth.users.id
```

But at that point:

```text
public.admins rows: 3
auth.users rows: 0
```

If we had run:

```powershell
npx prisma migrate deploy
```

immediately, the cutover would have failed.

### Safe Strategy

We applied only the rename migration first:

```powershell
npx prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20261008120000_rename_candidate_user_tables/migration.sql
```

Then recorded it:

```powershell
npx prisma migrate resolve --applied 20261008120000_rename_candidate_user_tables
```

This allowed:

```text
public."user".auth_user_id
```

to exist while remaining temporarily nullable.

---

# 10. Supabase Auth Migration

This was one of the largest architecture changes.

The old system used:

- bcrypt
- custom JWTs
- custom auth middleware
- custom invitation tables
- custom password-reset tables
- custom email sending
- custom cookie/CSRF flow

The new system moved authentication to **Supabase Auth**.

---

## 10.1 Final Authentication Flow

Frontend:

```text
supabase.auth.signInWithPassword()
```

Frontend sends:

```text
Authorization: Bearer <Supabase access token>
```

Backend:

```text
supabase.auth.getUser(token)
```

Then backend loads:

```text
public."user"
WHERE auth_user_id = auth.users.id
```

Then checks:

```text
status === ACTIVE
```

Role is always read from the application DB.

Current roles:

```text
ADMIN
MANAGER
ANALYST
REGISTRATION_DESK
```

---

## 10.2 Legacy Auth Files Removed

Old files were removed, including:

```text
src/middleware/auth.js
src/middleware/csrf.js
src/middleware/loginRateLimiter.js
src/middleware/requireActiveAdmin.js
src/routes/adminInvitations.js
src/services/adminInvitationService.js
src/services/passwordResetService.js
src/services/emailService.js
src/services/adminProvisioningService.js
src/services/adminAccountService.js
src/utils/password.js
scripts/createAdmin.js
scripts/updateDbRole.js
admin/src/auth/tokenStorage.ts
```

Dependencies removed included:

```text
jsonwebtoken
bcrypt
nodemailer
csrf-csrf
cookie-parser
```

---

# 11. Supabase Auth User Linking Problem

After the rename migration:

```text
public."user" rows: 3
auth.users rows: 0
auth_user_id: NULL for all 3
```

The cutover migration would refuse to continue until all staff rows were linked.

---

## 11.1 Why `user:create` Could Not Be Used During the Intermediate State

The Prisma client already expected:

```text
authUserId = required UUID
```

but the database temporarily contained:

```text
auth_user_id = NULL
```

A Prisma read failed with:

```text
P2032
Error converting field "authUserId"
```

### Root Cause

The generated Prisma client represented the **final schema**, while the live DB was intentionally in an intermediate migration state.

### Resolution

We did not modify the provisioning script just for this temporary condition.

Instead:

1. Create Supabase Auth identities manually in the dashboard.
2. Link them to the existing staff rows with guarded SQL.
3. Continue the final migration.

---

# 12. Existing Staff User Count Confusion

Initially, only 2 real staff users were expected, but the database contained 3 rows.

Audit showed:

```text
2 ADMIN
1 REGISTRATION_DESK
```

The third row came from an earlier custom invitation test.

It could not simply be deleted because:

```text
audit_logs
```

referenced it with:

```text
ON DELETE RESTRICT
```

and the audit history was intentionally immutable.

### Resolution

A third Supabase Auth identity was created for the existing row.

Then all three users were linked.

This preserved:

- staff IDs,
- audit history,
- call logs,
- roles,
- status.

---

# 13. Guarded Auth Linking

All three users were linked by matching email case-insensitively:

```sql
UPDATE "user" u
SET auth_user_id = a.id::text
FROM auth.users a
WHERE lower(a.email) = lower(u.email)
  AND u.auth_user_id IS NULL;
```

The real execution used a transaction and preconditions so it would rollback unless exactly the expected rows matched.

### Result

```text
public."user" rows: 3
auth.users rows: 3
valid mappings: 3
broken mappings: 0
duplicate auth_user_id: 0
```

---

# 14. Final Supabase Auth Cutover

Migration:

```text
20261009120000_supabase_auth_cutover
```

was then applied with:

```powershell
npx prisma migrate deploy
```

It completed successfully.

Final state:

```text
public.candidate
public."user"
auth.users
```

Removed:

```text
admin_invitations
admin_password_resets
password_hash
```

`auth_user_id` became:

```text
UUID
NOT NULL
UNIQUE
FK -> auth.users(id)
```

---

# 15. Supabase SMTP / Gmail Setup

Supabase Auth requires email delivery for:

- invitations,
- password reset,
- account setup.

Gmail SMTP was selected for testing.

Settings:

```text
Host: smtp.gmail.com
Port: 587
Username: Gmail address
Password: Google App Password
Sender name: Emlynk
```

Important:

> The normal Gmail password must not be used.

A Google App Password was generated after enabling 2-Step Verification.

---

## 15.1 App Password Confusion

After creating the App Password, there was a question about viewing it again.

Google does not show the full App Password again after creation.

### Important Architecture Point

The Gmail App Password does **not** belong in the application `.env`.

It belongs in:

```text
Supabase
-> Authentication
-> Emails
-> SMTP Settings
```

because Supabase Auth sends the auth emails.

---

# 16. Supabase Redirect Configuration

Configured redirect paths included:

```text
/admin/setup-password
/admin/reset-password
```

Local:

```text
http://localhost:5173/admin/setup-password
http://localhost:5173/admin/reset-password
```

Stage:

```text
https://emlynk-wa-bot-git-stage-emlynk-pixel.vercel.app/admin/setup-password
https://emlynk-wa-bot-git-stage-emlynk-pixel.vercel.app/admin/reset-password
```

---

# 17. `APP_BASE_URL` Problem

The invite flow built:

```text
${APP_BASE_URL}/admin/setup-password
```

Originally, if `APP_BASE_URL` was missing, the backend could send the invite without a redirect and Supabase could fall back to the project Site URL.

This was considered too risky.

### Final Decision

`APP_BASE_URL` became required.

Local:

```text
APP_BASE_URL=http://localhost:5173
```

Stage:

```text
APP_BASE_URL=https://emlynk-wa-bot-git-stage-emlynk-pixel.vercel.app
```

The application now fails clearly instead of silently creating a wrong invite redirect.

---

# 18. Old Environment Variables Cleanup

Obsolete variables included:

```text
JWT_SECRET
SMTP_HOST
SMTP_PORT
SMTP_USER
SMTP_PASS
EMAIL_FROM
ADMIN_SETUP_URL_BASE
```

These were removed from active code/docs because auth email is handled by Supabase Auth.

Active important variables include:

```text
DATABASE_URL
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_BUCKET
APP_BASE_URL
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
META_APP_SECRET
WHATSAPP_VERIFY_TOKEN
WHATSAPP_ACCESS_TOKEN
WHATSAPP_API_VERSION
OCR_SERVICE_URL
```

---

# 19. Local Frontend Supabase Configuration Error

The admin UI showed:

```text
Sign-in is not configured
```

`admin/.env.local` existed but had:

```text
Length: 0
```

It was empty.

### Fix

Add:

```env
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<browser-safe anon key>
```

Then restart Vite.

### Important

The frontend must be restarted after changing Vite environment variables.

---

# 20. Supabase Auth Smoke Tests

The following flows were successfully tested locally:

### Existing Admin Login

```text
Supabase Auth login
-> bearer token
-> /auth/me
-> admin UI
```

### Forgot Password

```text
Forgot password
-> Supabase recovery email
-> /admin/reset-password
-> new password
-> login successful
```

### Invite User

```text
Admin Invite User
-> Supabase invite email
-> /admin/setup-password
-> set password
-> login
```

This confirmed the new auth architecture worked end-to-end.

---

# 21. Prisma P4002 Cross-Schema Limitation

After the auth cutover, a Prisma drift command failed:

```text
P4002
```

### Root Cause

The application table:

```text
public."user"
```

has a foreign key to:

```text
auth.users
```

but Prisma intentionally does not manage the Supabase `auth` schema.

### Decision

Do **not** add the Supabase `auth` schema as Prisma-owned just to remove the warning.

This would increase risk because Prisma could attempt to model or migrate Supabase-managed Auth objects.

### Safe Position

These still work:

```text
prisma migrate deploy
prisma migrate status
prisma validate
prisma generate
normal Prisma queries
```

Some live-schema drift/introspection commands can remain limited.

---

# 22. Local Database Connectivity Failure — P2010 / P1001

Later, local testing produced repeated errors:

```text
PrismaClientKnownRequestError
P2010
```

including:

```text
GET /auth/me -> 500
```

and background queue errors.

At first this looked like another auth problem.

It was not.

---

## 22.1 Real Root Cause

Running:

```powershell
npx prisma migrate status
```

returned:

```text
P1001
Can't reach database server at
db.ckzoqahklxxzzqnlconx.supabase.co:5432
```

The direct Supabase database hostname resolved through an IPv6 path that the machine/network could no longer reach.

### Why P2010 Was Misleading

The PostgreSQL adapter raised a socket timeout, but Prisma surfaced it through an unexpected raw-query error path.

So:

```text
P2010
```

was only the visible symptom.

The real problem was:

```text
P1001
Database unreachable
```

---

## 22.2 Why `/auth/me` Failed Before Auth

The first DB call came from the rate limiter:

```text
createPostgresRateLimitStore().increment()
```

So the request failed before Supabase Auth verification completed.

The repeated background error came from:

```text
startSubmissionWorker
-> claimNextSubmission
-> temporary_data query
```

Both failures had the same DB connectivity root cause.

---

## 22.3 Recommended Local Fix

Use the Supabase **Session Pooler** connection string for local development instead of the direct IPv6-only database endpoint.

This changes only local:

```text
.env
```

It does not automatically change Vercel or Cloud Run.

### Troubleshooting Lesson & Prevention

When Prisma raw-query errors (such as `P2010`) appear unexpectedly:
1. Run direct migration/connectivity checks first: `npx prisma migrate status`.
2. Test database port reachability (port 5432 vs session pooler port 6543) before assuming SQL syntax, migration, or schema problems.
3. If IPv6 or direct host reachability is blocked on the local network, switch local `.env` `DATABASE_URL` to the Supabase Session Pooler.
4. **Never expose database credentials, passwords, or host connection tokens** in documentation, commit messages, or error screenshots.

---

# 23. Google Sheet Sync Architecture

Google Sheet Sync became an important feature.

Core rule:

> **Database is always the source of truth.**

The Sheet must never write changes back into the DB.

The system uses:

- `sheet_sync_queue`
- worker
- reconciliation
- writer lease
- duplicate protection
- deletion guard
- hidden system candidate ID

---

# 24. Google Sheet Duplicate Candidate Risk

One important audit found a high-priority issue involving Column AN.

Untrimmed whitespace in the hidden system candidate ID could make an existing candidate look like a new candidate.

### Risk

Duplicate Sheet rows.

### Fix

Normalize/trim the system candidate ID before matching.

After the fix, the Sheet Sync feature was considered high-confidence.

---

# 25. Dynamic Sheet Column Mapping

The Sheet later changed from 40 columns to 41 columns.

A new column:

```text
VISA SUBMISSION STATUS
```

was inserted.

The hidden system candidate ID moved:

```text
AN -> AO
```

The system was updated to dynamic header mapping so column order changes were less fragile.

---

# 26. Removing Real-Time Google Sheet Sync

A later requirement changed the sync behavior.

Old behavior:

```text
DB change
-> queue
-> worker
-> near-real-time Sheet write
```

New behavior:

```text
DB change
-> recorded
-> no immediate Sheet write
```

Sync only happens:

```text
06:00
12:00
18:00
```

or when an authorized user clicks:

```text
Sync Now
```

Timezone:

```text
Asia/Colombo
```

The schedule uses Cloud Scheduler, not an in-process timer.

Cron:

```text
0 6,12,18 * * *
```

---

# 27. Document Status / Date Mapping in Google Sheet

The task required all document-related Sheet columns to show:

```text
submitted/current date
```

if the document exists, otherwise:

```text
Not Submitted
```

Tracked columns included:

```text
PASSPORT COPY
POLICE REP SRI LANKA
POLICE REP ROMANIA
MEDICAL
SCAN
NATIONAL ID
POLICE REPORT APPLIED
VIDEOS
```

The system uses:

```text
documents.received_date
```

and writes a consistent date format such as:

```text
YYYY-MM-DD
```

---

## 27.1 R and W Sheet Columns

Two Sheet columns existed without matching application document types:

```text
R - DRIVING LICIAN
W - POLICE REP FM
```

Initially they remained blank.

But the task wording required **all document columns** to display either a date or:

```text
Not Submitted
```

### Final Fix

R and W now output:

```text
Not Submitted
```

only in the Google Sheet.

No DB fields, schema, migrations, upload types, or storage logic were added.

---

# 28. Old Cloud Run Worker Causing Sheet Schema Error

Admin Settings later showed:

```text
Integration state:
Configuration error: sync halted
```

and:

```text
Schema invalid (AI,AJ,AK,AL,AM,AN)
```

At first this looked like a Sheet structure problem.

### Real Root Cause

The deployed Cloud Run worker was stale.

It still used the original 40-column position-based validator.

The live Sheet already had 41 columns.

Current layout:

```text
AI  VISA SUBMISSION STATUS
AJ  VISA APPROVAL STATUS
AK  FINALIZING JOB STATUS
AL  RECORD STATUS
AM  REGISTERED AT
AN  LAST MIRRORED AT
AO  _SYSTEM_CANDIDATE_ID
```

The old worker expected:

```text
AI  VISA APPROVAL STATUS
AJ  FINALIZING JOB STATUS
AK  RECORD STATUS
AL  REGISTERED AT
AM  LAST MIRRORED AT
AN  _SYSTEM_CANDIDATE_ID
```

So every column after the inserted field appeared wrong.

### Important Evidence

The error format:

```text
AI,AJ,AK,AL,AM,AN
```

came from the old validator.

The current dynamic validator reports errors such as:

```text
MISSING:<header>
DUPLICATE:<header>
```

### Resolution Plan

Redeploy the current worker.

No Sheet header changes were required.

---

# 29. Google Cloud Billing Account Disabled / Closed (Incident & Resolution)

**Date / Phase**: Phase 25 (Sheet Sync Worker Deployment)

### Symptoms

When attempting to build and redeploy the Cloud Run worker (`emlynk-sheet-sync-worker`) using Cloud Build, the command failed immediately before starting the build:

```powershell
gcloud builds submit --project=project-aa11e15e-a951-4e1b-a65 ...
```

Error output:

```text
ERROR: (gcloud.builds.submit) 403 Could not upload file:
The billing account for the owning project is disabled in state closed.
```

Subsequent billable Google Cloud operations were refused. Checking billing status with:

```powershell
gcloud billing projects describe project-aa11e15e-a951-4e1b-a65
```

returned:

```text
billingAccountName: billingAccounts/014FEB-5E0B68-D2CE4E
billingEnabled: false
projectId: project-aa11e15e-a951-4e1b-a65
```

The Google Cloud Console Billing overview displayed account status as:

```text
Status: Closed / Not in good standing
```

As a result, Cloud Build could not upload sources to Google Cloud Storage or build/push Docker images to Google Artifact Registry.

---

### Root Cause

The linked Google Cloud billing account (`014FEB-5E0B68-D2CE4E`) had been disabled / closed because the account was not in good standing.

During earlier cloud verification, temporary card authorization transactions were placed and refunded. However, the verification refund process left the billing account in a closed / inactive state rather than automatically restoring active standing.

**Critical Finding**: This was purely an external Google Cloud account/billing standing issue, **not** an application code, Dockerfile, or Prisma migration problem. Changing application code or Docker configurations has zero effect when the cloud provider blocks billable operations.

---

### Resolution

1. **Account Investigation**: Verified via Google Cloud Console that the project remained linked to the billing account, but the billing account itself required manual payment / reactivation.
2. **Reactivation & Payment**: The billing account was reactivated through the Google Cloud Billing Console. Required payment / prepayment was processed to restore the account to active good standing. (No card numbers, payment tokens, invoice numbers, or sensitive financial details are stored or logged in the repository).
3. **Status Verification**: Re-checked billing status via CLI:
   ```powershell
   gcloud billing projects describe project-aa11e15e-a951-4e1b-a65
   ```
   Confirmed `billingEnabled: true` and account status returned to `Open / Good standing`.
4. **Cloud Build Rerun**: Re-executed Cloud Build:
   ```powershell
   gcloud builds submit --project=project-aa11e15e-a951-4e1b-a65 ...
   ```
   The source archive uploaded successfully, Docker image build completed without errors, and the image was pushed to Google Artifact Registry.
5. **Worker Deployment**: Successfully updated `emlynk-sheet-sync-worker` Cloud Run service to the newly built image revision.

---

### Verification

- Cloud Build completed with `STATUS: SUCCESS`.
- Container image published to Artifact Registry: `asia-south1-docker.pkg.dev/project-aa11e15e-a951-4e1b-a65/emlynk-worker/emlynk-sheet-sync-worker:latest`.
- Cloud Run service restarted and reported healthy heartbeats to the database.

---

### Troubleshooting Lesson & Prevention

When Cloud Build or Google Cloud deployments suddenly fail with `403` or billing-related upload errors:

1. **Check Cloud Billing status first**: Run `gcloud billing projects describe <project-id>` immediately to check `billingEnabled`.
2. **Verify project linkage**: Confirm the project is linked to the intended billing account ID.
3. **Inspect Billing Console standing**: Check Google Cloud Console Billing dashboard for account closure, suspended cards, or required payment verification.
4. **Resolve payment/billing standing**: Reactivate the billing account or settle outstanding invoices in the Google Cloud Billing Console.
5. **Retry deployment only after billing is active**: Do not attempt to debug or modify application code, Dockerfiles, or CI/CD scripts; these errors cannot be resolved at the application level if the cloud billing account is disabled.

---

# 30. Google Cloud Scheduler Target

Planned scheduler:

```text
Job:
emlynk-sheet-sync-reconcile

Schedule:
0 6,12,18 * * *

Timezone:
Asia/Colombo
```

Target:

```text
POST <Cloud Run worker URL>/tasks/reconcile
```

Authentication:

```text
OIDC service account
Cloud Run IAM
configured audience/invoker
```

The scheduler should not use an in-process Node cron timer.

---

# 31. Candidate Workflow Changes

Candidate management changed several times as requirements became clearer.

Final stage names became:

1. Test Details
2. Candidate Details
3. Document Submission
4. IVS Interview
5. Visa Approval
6. Finalizing the Job

Later design requirements included:

- non-linear completion,
- red = incomplete,
- green = completed normally,
- light green = completed out of order.

Additional requirement:

> Candidate Pool page should remain unchanged during the major UI redesign.

---

# 32. Candidate Registration Requirement Changes

Requirements changed during development.

Important final rules included:

- Surname required
- Other names required
- Address required to complete Candidate Details
- NIC unique
- Passport ID required
- Job type required
- Job experience required
- Passport document required
- NIC document optional
- Skill video optional
- WhatsApp required in later flow decisions

A major clarification:

> **There is ONLY ONE SCAN document.**

No separate:

```text
Agreements
Affidavits
Contracts
```

should exist as separate scan slots.

This rule had to be reflected across UI, backend, docs, and Sheet mapping.

---

# 33. Skill Video Validation Bug

A bug was identified where the skill-video field accepted non-video files such as:

```text
PDF
JPEG
PNG
```

Expected formats included:

```text
MP4
MOV
WebM
```

This was flagged for frontend/backend validation correction.

---

# 34. Candidate List Error-State Problem

A candidate-list page could show:

```text
error banner
+
stale previous results
```

at the same time.

This made the UI misleading.

The desired behavior became:

```text
loading
OR error
OR results
```

instead of stacking stale results underneath an error.

---

# 35. Call Log UI Redesign

Call Log was redesigned into a cleaner right-side drawer.

Requirements included:

- candidate summary
- call-history cards
- long-note wrapping
- loading state
- empty state
- error state
- add call
- keyboard accessibility
- duplicate-save prevention

A flaky frontend test remained around returning focus after closing the drawer.

The production behavior was correct; the test timing was race-prone.

A temporary test adjustment using:

```text
waitFor focus
```

made the full suite pass.

The final decision was to handle the remaining test stabilization during final QA rather than interrupt other major tasks.

---

# 36. Frontend Auth Test Timing Flakes

Some auth/loading-state tests failed intermittently under parallel jsdom load.

This was not a product auth failure.

### Fix

Tests were updated to wait for explicit UI state transitions using a helper such as:

```text
renderAppSignedIn()
```

and longer test waits.

Result:

```text
affected auth/loading tests passed repeatedly
```

The only remaining intermittent frontend issue was the Call Log focus timing test.

---

# 37. Meta / WhatsApp Business Setup

The project also required a real WhatsApp Business setup.

A WhatsApp Business Account existed:

```text
Lilyga Holdings
```

The phone number was visible in Meta but at one point showed:

```text
Offline
```

There were also permission/setup steps around assigning people to the WABA.

At one stage:

```text
0 people assigned
```

and the account owner was later assigned.

The WhatsApp setup was paused while database/auth work became the priority.

---

# 38. Hosting R&D Decision

A separate hosting research task compared deployment options.

The final practical direction was to keep the hybrid model:

```text
Vercel
+
Google Cloud Run
+
Supabase
```

Reasoning:

- Vercel works well for the React/Vite admin and preview workflow.
- Cloud Run works well for Dockerized OCR/heavy workers.
- Supabase provides Postgres, Storage, and Auth.
- Moving everything to a different provider would create unnecessary migration work.

Other platforms were evaluated as alternatives, but the existing hybrid architecture remained the most suitable.

---

# 39. Important Error Reference

| Error / Symptom | Real Cause | Resolution |
|---|---|---|
| `TS2367 / TS2304 / TS2345` | Missing fix in deployed branch | Merge/use branch containing correct implementation |
| `/admin` works but deep link 404 | Wrong Vite base/router path | `base="/admin/"`, router basename `/admin` |
| `ENOENT /admin/admin/package.json` | Incorrect Vercel working directory/build command | Use `npm --prefix admin ...` from repo root |
| `/auth/login` 500 | DB middleware/rate-limit path failed before login | Inspect middleware, schema-qualify DB table, trust proxy |
| `P2032 authUserId null` | Prisma final schema used against intermediate migration DB | Manual/guarded auth identity linking before final cutover |
| `P4002` | Cross-schema FK from public user to Supabase auth.users | Keep auth schema outside Prisma; document limitation |
| `Sign-in is not configured` | `admin/.env.local` empty | Add VITE Supabase URL + anon key and restart Vite |
| `P2010` on `/auth/me` | DB socket timeout surfaced misleadingly | Check `migrate status`; real cause was DB unreachable |
| `P1001` | Direct Supabase DB endpoint unreachable over current network | Use Session Pooler / fix network path |
| `Schema invalid (AI...AN)` | Old 40-column worker against 41-column Sheet | Redeploy current dynamic-mapping worker |
| `gcloud build 403 billing disabled` | Cloud Billing account closed/not in good standing | Resolve billing account before build/deploy |
| `--follow unrecognized` | Unsupported gcloud logs option | Use supported logging method |
| npm PowerShell permission error | Execution policy | `Set-ExecutionPolicy ... RemoteSigned` |

---

# 40. Accounts / External Services Created or Configured

## Supabase

Used for:

- PostgreSQL
- Storage
- Auth
- user invitations
- password recovery
- SMTP integration

Configured:

- redirect URLs
- public signup disabled
- custom Gmail SMTP
- browser anon key
- server service-role key
- auth users linked to app users

---

## Google Cloud

Project:

```text
project-aa11e15e-a951-4e1b-a65
```

Region:

```text
asia-south1
```

Used for:

- Artifact Registry
- Cloud Run OCR worker
- Cloud Run Sheet Sync worker
- Cloud Build
- Cloud Scheduler

Current blocker:

```text
Billing disabled / closed
```

---

## Vercel

Used for:

- admin preview/staging
- `stage` branch deployment

Important settings included:

```text
npm ci && npm --prefix admin ci
npm --prefix admin run build -- --outDir ../public/admin --emptyOutDir
outputDirectory = public
```

---

## Google / Gmail

Used for:

- SMTP sender
- Google App Password
- Cloud account authentication
- Google Sheets

---

## Meta

Used for:

- WhatsApp Business Account
- webhook integration
- WhatsApp document intake

---

# 41. Security Improvements Made During the Project

Several security improvements emerged naturally from debugging:

1. Removed application-managed passwords.
2. Removed custom JWT secrets.
3. Removed custom password-reset tokens.
4. Removed custom invitation tables.
5. Removed browser storage of custom auth token.
6. Moved auth email delivery to Supabase.
7. Kept Supabase service-role key server-side only.
8. Role is always loaded from DB, not trusted from token/body.
9. User status is checked on every authenticated backend request.
10. Cloud Run workers use authenticated invocation.
11. Google Sheet remains one-way DB → Sheet.
12. Secrets are never committed into Git.
13. Environment-specific URLs are explicit.
14. `APP_BASE_URL` is required instead of silently falling back.

---

# 42. Troubleshooting Method That Worked Best

A reliable troubleshooting pattern emerged:

## Step 1 — Do not immediately edit code

First identify whether the issue is:

```text
code
branch
environment
database
network
deployment
cloud account
stale worker
```

## Step 2 — Reproduce with the smallest command

Examples:

```powershell
npx prisma migrate status
git log --oneline -8
git status
gcloud billing projects describe ...
```

## Step 3 — Find the first failing layer

For example:

```text
browser
-> frontend
-> middleware
-> DB
```

The first error may happen before the visible route logic.

## Step 4 — Compare local and deployed versions

Many bugs came from:

```text
local code != deployed worker
```

or:

```text
feature branch != dev
```

## Step 5 — Make the smallest safe fix

Avoid broad rewrites when the root cause is:

- a stale deployment,
- wrong env,
- billing state,
- network reachability,
- branch mismatch.

---

# 43. Cloud Build Failed Due to Stale `createAdmin.js` Reference in Dockerfile

**Date / Phase**: Phase 25 (Sheet Sync Worker Deployment)

### Symptoms

When triggering Google Cloud Build to build the Sheet Sync worker container image from `Dockerfile`:

```powershell
gcloud builds submit --project=project-aa11e15e-a951-4e1b-a65 ...
```

The build failed during step 8:

```text
Step 8/12 : COPY scripts/createAdmin.js scripts/checkDatabaseConnection.js ./scripts/
COPY failed: file not found in build context: scripts/createAdmin.js: not found
```

### Root Cause

During the earlier Supabase Auth migration (documented in Section 10.2 "Legacy Auth Files Removed"), custom admin creation and password hashing scripts were intentionally decommissioned. The legacy script:

```text
scripts/createAdmin.js
```

was deleted from the codebase because administrator onboarding was replaced by the official CLI utility:

```bash
npm run user:create
```

However, the `Dockerfile` on the active feature branch still retained a stale `COPY` instruction referencing `scripts/createAdmin.js` alongside `scripts/checkDatabaseConnection.js`.

### Resolution

1. Updated `Dockerfile` to copy only the active database verification utility:
   ```dockerfile
   COPY scripts/checkDatabaseConnection.js ./scripts/
   ```
2. **Do NOT restore `createAdmin.js`**: Restoring the deleted script would reintroduce obsolete custom authentication logic that conflicts with Supabase Auth.
3. Brought the existing deployment fix commit (`783697f` / `fix(deploy): remove stale createAdmin Docker reference`) into the branch prior to rebuilding.
4. Reran Cloud Build; container image built cleanly.

### Troubleshooting Lesson & Prevention

After authentication, architecture, or dependency refactoring where legacy scripts are removed:
1. Audit all container manifests (`Dockerfile`, `Dockerfile.worker`, CI build scripts) for stale file references.
2. When a Docker `COPY` fails with `file not found in build context`, verify whether the file was intentionally deprecated before attempting to recreate or restore it.
3. Keep container build definitions minimal, copying only files strictly required at container runtime.

---

# 44. Sync Destination Dropdown Missing in Admin Settings

**Date / Phase**: Phase 25 (Google Sheet Sync Destination Deployment)

### Symptoms

In the Admin Dashboard under **Settings → Google Sheet Sync** (`/admin/settings/sheet-sync`), the section heading changed to **Sync destination**, but:
- Only the legacy plain `Spreadsheet` row (`…<hint> / <tab>`) was displayed.
- No Google Sheet selection dropdown appeared.
- In the database, `sheet_sync_state.destinations`, `active_destination_key`, and `requested_destination_key` were all `NULL`.
- The background worker heartbeat was active and reporting every ~10 seconds.

### Investigation

1. Checked frontend React components: The new UI code supporting destination selection was compiled and active.
2. Checked backend Admin API: `GET /settings/sheet-sync/status` and `PUT /settings/sheet-sync/destination` were mounted and functional.
3. Checked database schema: Migration `20261012120000_sheet_sync_destination` had been applied successfully, adding nullable columns to `sheet_sync_state` and `sheet_sync_runs`.
4. Checked Cloud Run worker: The deployed worker service (`emlynk-sheet-sync-worker`) was still executing an **OLD container image revision** built prior to the destination feature implementation.

### Root Cause

The Sync Destination feature is architected so that the **Cloud Run worker is the authoritative publisher of destination metadata**:
- The worker reads its environment (`SHEET_SYNC_DESTINATIONS` or the single-Sheet fallback) and periodically publishes safe destination summaries (`destinations`) on its heartbeat.
- Because Cloud Run was running an old worker revision, its heartbeats did not include destination metadata, leaving `sheet_sync_state.destinations` as `NULL`.
- Consequently, the Admin API returned no available destinations, and the frontend gracefully fell back to the legacy plain target display.

### Resolution

1. Built the latest worker container image containing the destination publishing logic.
2. Pushed the image to Google Artifact Registry.
3. Updated the `emlynk-sheet-sync-worker` Cloud Run service to deploy the new revision.
4. On its very first heartbeat, the updated worker published the destination metadata to `sheet_sync_state.destinations`.
5. Refreshed Admin Settings; the destination dropdown appeared immediately with the active Sheet selected.

### Fallback Behavior

When the worker's `SHEET_SYNC_DESTINATIONS` environment variable is not explicitly provided, the worker automatically constructs a fallback destination from `SHEET_SPREADSHEET_ID` and `SHEET_TAB_NAME`:
- Destination key: `default`
- Name: derived from the tab or configuration
- Allows backward compatibility without forcing environment variable changes for single-sheet deployments.

### Troubleshooting Lesson & Prevention

When an architecture delegates state publication or background configuration to an asynchronous worker:
1. Updating frontend code, backend APIs, and applying database migrations is not sufficient.
2. The background worker service must also be rebuilt and redeployed to match the new schema and protocol.
3. When debugging UI missing-element states, check database state columns (e.g. `destinations IS NULL`) and trace which microservice or daemon is responsible for populating them.

---

# 45. Daily Report Previous Design Was Too Busy / Low Utility (Redesign)

**Date / Phase**: Phase 26 (Daily Report Modernization)

### Symptoms & Operational Feedback

The legacy Daily Report interface (`/admin/reports/daily`) presented significant operational limitations:
1. **Outdated Terminology**: Displayed "Clients" throughout, conflicting with the candidate-centric domain model (`public.candidate`).
2. **Flat Presentation**: Presented a single busy screen with low visual hierarchy and minimal operational utility.
3. **No Process Breakdown**: Showed a simple count of incomplete candidates without breaking down the 7 recruitment stages or detailing why candidates were stalled.
4. **No Role-Based Insights**: Management had no visibility into productivity by role (analyst vs manager vs admin).
5. **Limited Document Metrics**: Did not distinguish inbound WhatsApp submissions from staff manual uploads, and lacked breakdown by candidate document type.
6. **Poor PDF Export**: The legacy PDF export was a flat, unformatted printout with clipped content and no pagination.
7. **Snapshot Confusion**: Current pipeline state (incomplete candidates, police status) could easily be misinterpreted as historical figures for past dates.

### Root Cause

The initial daily reporting was implemented early in Phase 10 as a simple intake report before candidate deployment workflows, candidate call logging, role-based access control, and audit logging were completed.

### Resolution

Redesigned the Daily Report system across backend (`src/services/dailyReportService.js`) and frontend (`DailyReportPage.tsx`, `dailyReportPdf.ts`):

1. **Standardized on Candidates Terminology**: Replaced all "Client" references with "Candidate".
2. **Two Dedicated Views**:
   - **Summary Tab**: High-level KPIs, document source breakdown, completed candidates, calls taken, and current pipeline health (accessible to `ADMIN`, `MANAGER`, `ANALYST`).
   - **Summary by Roles Tab**: Productivity analysis filtering by `ANALYST`, `MANAGER`, `ADMIN`, or `REGISTRATION_DESK` (strictly restricted to `ADMIN` and `MANAGER`).
3. **Five Authoritative KPIs**: Candidates registered, Candidates completed, Visa completed, Calls taken, Documents submitted.
4. **Document Source & Type Split**: Detailed matrix separating WhatsApp intake from staff uploads across all supported candidate document types (`PASSPORT`, `POLICE_REPORT` [SL Verified + Romania], `MEDICAL`, `AFFIDAVIT`, `SKILL_VIDEO`, and `SCAN` under the ONE SCAN policy), plus conditional unclassified items.
5. **Incomplete Process Drill-Down**: Categorized incomplete candidates across all 7 deployment stages with real failure reasons, including 25-per-page paged candidate lists (`GET /api/admin/reports/daily/incomplete`).
6. **Structured PDF Export**: Vector-based PDF generation via `jspdf` featuring repeated table headers, cell text wrapping, confidential footers, and clean empty-day support.
7. **Explicit Temporal Separation**: Grouped current pipeline metrics under a dedicated *Current state* header with generation timestamps (`asOf`), clearly explaining that incomplete candidate and police report metrics reflect the system state *now*, not historical past days.
8. **No Database Migration Required**: Existing timestamps (`created_date`, `completed_at`) and audit entries (`audit_logs`) were sufficient to support all redesigned metrics.

### Verification

Backend test suite verified with 15 new test cases in `test/dailyReportSummary.test.js`; frontend test suite verified in `admin/src/test/dailyReport.test.tsx`.

---

# 46. Daily Report Had No Registered Candidate Activity (Registration Gap)

**Date / Phase**: Phase 26 (Candidate Registration Tracking)

### Symptoms

A candidate could be successfully registered in the system with zero uploaded documents, but the Daily Report showed no indication of this registration activity.

Example operational scenario:
- Candidates registered on day: 1
- Documents uploaded on day: 0
- Daily Report displayed: *Documents submitted = 0*, *Candidates completed = 0*, *Calls taken = 0*.

The candidate registration activity was completely invisible in the daily report, leading managers to believe no recruitment intake occurred on that day.

### Root Cause

The Daily Report was originally built around progression and verification events (document intake, stage completions, calls). It had no KPI or detail list tracking candidate registration records created on that business day.

### Resolution

1. **Added "Candidates registered" KPI**: Defined as the count of candidate records created within the selected Sri Lanka business day (`00:00:00.000`–`24:00:00.000` `Asia/Colombo`), derived from `candidate.created_date` populated during `createCandidate`.
2. **Added Registered Candidates Detail Section**:
   - Passport number (linked)
   - Candidate name
   - Registration time (`HH:mm`)
   - Registered by (staff member from `CREATE_CANDIDATE` audit log entry, or *—* if unavailable)
   - Documents now (active documents currently on record, or *No documents*)
   - Progress now (current stages complete out of 7)
3. **Established Core Business Rule**:
   > **Candidate Registration != Document Submission**  
   Candidate registration and document submission are distinct, independent activities. A candidate registered with zero documents increments *Candidates registered* by 1 and contributes 0 to *Documents submitted*. Zero-document registrations remain fully visible in the Daily Report.
4. **Integrated with PDF Export**: Summary PDF includes the Candidates registered KPI and a dedicated registered candidates table.

### Verification

Added test suite `test/dailyReportRegistrations.test.js` validating:
- Zero-document candidate registration counting and listing.
- Independence from *Documents submitted*.
- Strict Sri Lanka midnight boundary compliance (`00:00:00` vs `23:59:59.999`).
- Audit log attribution for *Registered by*.
- Clean zero counts on days without registrations.

---

# 47. Claude Co-Author Appearing in GitHub Contributors (Git Attribution)

**Date / Phase**: Phase 24-25 (Git History & Repository Management)

### Symptoms

In GitHub repository Insights under **Contributors**, Claude appeared as a project contributor alongside the developer (Shamal Sathsara), even though all commits were committed by Shamal.

### Investigation

Inspecting recent Git commit messages revealed that co-author trailers were appended to commit bodies, such as:

```text
Co-Authored-By: Claude <noreply@anthropic.com>
```

### Root Cause

GitHub automatically parses Git commit trailers formatted as `Co-Authored-By: Name <email>` according to the GitHub co-authored commits specification. When a co-author email is recognized, GitHub attributes contributor credit to that entity on the repository's contributor graphs.

### Resolution & Recommended Policy

1. **Prevent Future Trailers**: Ensure local commit commands and tooling do not append `Co-Authored-By` trailers to commit messages.
2. **Evaluating Removal of Existing Attribution**:
   - To remove Claude from past GitHub contributor history, every commit containing the trailer would have to be rewritten (e.g. using `git filter-repo` or interactive rebase) and force-pushed across all remote branches.
3. **High-Risk Warning on Git History Rewriting**:
   > [!CAUTION]
   > Rewriting Git history modifies all subsequent commit SHA-1 hashes. This invalidates existing commit references in documentation, breaks local checkouts for team members, and creates severe merge conflicts on shared branches.
   > **History rewriting is classified as a high-risk operation and is NOT recommended as a routine maintenance procedure.**
   > The safe and standard approach is preventing future commits from including co-author trailers while leaving existing historical commits intact.

---

# 47A. Light Theme Borders and UI Separation Were Too Faint

**Date / Phase**: October 2026 (Admin UI refinement)

### Symptoms

- Card edges were difficult to distinguish from the page.
- Divider lines were too light.
- Table rows were difficult to scan.
- Input and select boundaries were weak.
- The Candidates area was even harder to read.
- The whole UI looked washed out in the Light Theme (the Dark Theme was acceptable).

### Initial Concern

This looked like a potentially huge UI-wide redesign, because the problem showed on nearly every page.

### Audit

The project was inspected before anything was edited. Findings:

- There is one global stylesheet, `admin/src/index.css` (Tailwind v4, `@theme` tokens; no `tailwind.config` for these tokens).
- The tokens drive nearly all UI borders: `border-border` (about 99 uses) and `border-border-strong` (about 35 uses) are used widely.
- No hardcoded hex/rgb colours exist in the application's TSX components.
- The Candidates area had its own Light overrides under `:root:not([data-theme="dark"]) .ui-classic`.
- The Dark Theme had a complete, separate set of overrides.

### Root Cause

The existing Light border tokens were too light, and the Candidates `.ui-classic` values were lighter still.

| Token | Main Light (old) | Candidates Light (old) |
|---|---|---|
| `--color-border` | `#d5dce5` | `#e2e8f0` |
| `--color-border-strong` | `#b6c0cd` | `#cbd5e1` |
| `--color-border-focus` | `#8494a8` | `#94a3b8` |

### Resolution

Only the three existing Light border tokens were retuned, and the same values were applied to the Candidates Light block:

- `--color-border`: `#c9d1dc`
- `--color-border-strong`: `#a9b5c4`
- `--color-border-focus`: `#7a8ba1`

The order border < strong < focus was kept so hover and focus still read as stronger. The Daily Report's one `border-border/60` row-line exception was also changed to the normal `border-border`. One test that pinned the old Candidates values was updated to the new ones.

### What Was Not Changed

- The Dark Theme (both Dark blocks)
- backgrounds, canvas and surfaces
- shadows
- status colours
- component logic, spacing and layout
- authentication and business logic
- no new tokens were introduced

### Verification

- The full frontend suite passed, as did typecheck and the production build.
- The Dark Theme blocks were compared with the previous commit and are identical.
- A visual browser smoke-check of each page was **not** performed as part of this change; it is still required.

### Lesson Learned

For a large visual consistency problem:

- audit the theme and token architecture first;
- avoid editing dozens of components by hand;
- prefer the existing global semantic tokens;
- include scoped theme overrides such as `.ui-classic`;
- preserve the Dark Theme by changing only Light-specific selectors.

---

# 47B. Call Log and Follow-Up Workflow Was Cluttered (Candidate History)

**Date / Phase**: October 2026 (Admin UI refinement; follows the earlier Call Log drawer redesign in section 35)

### Symptoms

- *Current Documents* took too much vertical space in the drawer and on the follow-up cards.
- Call History showed only calls, not what changed on the candidate afterwards.
- A large *Need Attention* text button on every call and every follow-up consumed card space.
- The drawer needed an explicit close control.
- The Add New Call Log area took too much of the drawer.
- Large and small displays behaved inconsistently.
- An unanswered call had no short way to be recorded.

### Resolution

- **Candidate History** timeline: calls and meaningful candidate activity, newest first (documents received, verified or removed; registration; details, additional details and stage saves), built only from records that already exist (no new table).
- **Current Documents** removed from the drawer and from the Need Attention page (display only; the data and `documentStatus` in the API remain).
- **Compact flag icon** beside the caller replaces the per-call text button; **Need Attention** is also an option in the Add form and reuses the existing follow-up record.
- **No Answer**: records an unanswered call with no note. It is stored as a call with the `NO_ANSWER` outcome (additive migration `20261013120000_call_log_outcome`), counts as a call in the Daily Report, and opens no follow-up on its own.
- **Backdrop close**: X, Close, Escape or a click outside the drawer.
- **Compact, responsive** Add form with a **collapse / expand** chevron (hides Date, Time and the note; the buttons stay; typed values are kept; display state only).
- **Semantic event colours** (No Answer soft red, Call log soft amber, Candidate activity soft green), theme-aware, never the only cue.
- **Need Attention page**: the former *Priority Follow-Ups* renamed for users (route, API, table and audit actions unchanged), a compact state icon instead of a text badge, *Complete* behaviour unchanged, delete still ADMIN and MANAGER only.

### Status

All of the above is implemented and in the codebase. Not implemented, and not claimed in the docs: reconstruction of earlier stage completions or reopenings that were never recorded, and history for the automatic stages (Candidate details, Document submission), which keep no completion history.

### Lesson Learned

Show the history and the action items first; keep derived or secondary data (such as current document status) where it already lives. Reuse an existing mechanism (the follow-up record) instead of adding a second one.

---

# 47C. Frontend Full-Suite Timeouts and a Request-Spy Assertion Race

**Date / Phase**: October 2026

### Observed

One full frontend run reported 5 failures (420 passed): four 5000 ms timeouts (two candidate pagination tests and two candidate registration tests) and one Need Attention assertion that the request `/api/admin/follow-ups?status=OPEN` had not been seen.

### Investigation

- None of the failures reproduced when their test files were run alone, and a full rerun passed.
- The Need Attention page still called `/api/admin/follow-ups?status=OPEN`. The test read the request spy right after the page heading appeared, which can happen before the fetch effect has fired.

### Resolution

- The assertion was moved to after the candidate list had loaded, so the request has certainly been made. Production code was unchanged and no test timeout was increased.

### Verification

- 425 of 425 frontend tests passed, and typecheck and build passed.

### Later Observation

The two pagination tests (Next/Previous paging and contact-number search) still time out occasionally in full runs: one takes about 3.4 s on its own against the 5 s limit, so heavy worker load pushes it over. They pass alone and in clean full runs. This is test-suite load sensitivity, not a product regression; a longer timeout on just those tests is the remedy if it becomes a nuisance.

### Lesson Learned

Do not treat full-suite async timing failures as product regressions without a focused reproduction. Wait for the response or the rendered result before asserting on a request spy.

---

# 47D. Client Management Migration Failed Because company_job_id Already Existed

**Date / Phase**: October 2026 / Pre-Stage Deployment

### Symptoms & Error Output

When deploying the Client Management database migration to the shared Supabase PostgreSQL instance using Prisma, the migration failed with an execution error:

```bash
npx prisma migrate deploy
```

```text
Applying migration `20261019120000_client_management`
Error: P3009

migrate found failed migrations in the target database,
new migrations will not be applied. Read more about how to resolve migration issues in a production database: https://pris.ly/d/migrate-resolve
The `20261019120000_client_management` migration failed when applied to the database.
Database error code: 42701
Database error:
ERROR: column "company_job_id" of relation "job" already exists
```

- **Command**: `npx prisma migrate deploy`
- **Prisma Error**: `Prisma P3009` (Failed migration found in target database)
- **Failed Migration**: `20261019120000_client_management`
- **PostgreSQL Error Code**: `SQLSTATE 42701` (`duplicate_column`)
- **Database Error Message**: `column "company_job_id" of relation "job" already exists`

### Root Cause Analysis

The failure was **NOT database corruption** or schema inconsistency within the PostgreSQL engine.

The root cause was **divergent branch migration histories** between two parallel feature branches that shared the same remote Supabase database:

1. **Prior Candidate Form Migration on Shared Database:**
   Earlier development on the Candidate Form feature branch (`version/candidate-extra-details-form`) had applied migration:
   `20261018130000_job_company_id_and_form_job_group`
   This migration had already created:
   - Column `job.company_job_id`
   - Check constraint `job_company_job_id_check`
   - Partial unique index `job_company_job_id_key`

2. **Linear Migration Path on Current Branch (`dev`):**
   The new Admin Dashboard migration `20261019120000_client_management` was authored and tested locally against a simpler linear branch path:
   `20261018120000_job_management` → `20261019120000_client_management`

3. **Collision in Shared Environment:**
   In the shared database environment, the actual upgrade path was:
   `20261018120000_job_management` → Candidate Form migration (`20261018130000_...`) → `20261019120000_client_management`

When `20261019120000_client_management` executed `ALTER TABLE "job" ADD COLUMN "company_job_id" TEXT;`, PostgreSQL threw `SQLSTATE 42701` because the column had already been added by the Candidate Form migration.

### Wrong Fixes Avoided (and Why)

Under pressure to unblock deployment, several naive or destructive fixes were explicitly avoided:

1. **Did NOT reset the database (`prisma migrate reset`):**
   A reset drops the database and recreates it from scratch. In a shared/stage Supabase instance, this would permanently destroy live testing data, Candidate Form tables, audit logs, and existing Job records.
2. **Did NOT drop the existing Job tables:**
   Dropping `job`, `job_candidate`, or `client` would break relational integrity and delete valid candidate assignments.
3. **Did NOT mark the failed migration as applied (`prisma migrate resolve --applied`):**
   Running `--applied` would update `_prisma_migrations` to record success, but because the transaction had failed on step 4, the preceding operations (such as renaming `company` to `client`, adding `client.agent_id`, and updating foreign keys) would **never** have been applied! The schema in the database would be out-of-sync with Prisma client models.
4. **Did NOT use `prisma migrate dev`:**
   `prisma migrate dev` is an interactive development command intended for local prototyping. Running it against shared or staging databases risks prompt loops, unreviewed auto-generated migrations, or accidental reset prompts.
5. **Did NOT delete Candidate Form tables:**
   The `candidate_form_*` tables belong to an active feature stream; destroying them to satisfy an Admin migration would violate branch separation.
6. **Did NOT manually delete rows from `_prisma_migrations`:**
   Direct manipulation of the Prisma migration ledger bypasses internal checksum and state tracking, leaving the migration history corrupted.
7. **Did NOT overwrite or truncate existing `company_job_id` values:**
   Existing Client Job IDs stored by previous tests were preserved intact.

### Safe Resolution (Recovery Procedure)

The issue was resolved cleanly and safely using forward-compatible DDL and standard Prisma CLI recovery tooling:

1. **Inspected `_prisma_migrations` Ledger:**
   Queried the migration ledger directly:
   ```sql
   SELECT migration_name, started_at, finished_at, rolled_back_at, applied_steps_count
   FROM "_prisma_migrations"
   WHERE migration_name = '20261019120000_client_management';
   ```
   Confirmed `applied_steps_count = 0`. Because PostgreSQL executes DDL inside transactional migration blocks, the failed statement caused the entire migration transaction to roll back cleanly. No partial schema alterations remained.

2. **Verified Shared Schema State:**
   Confirmed that `job.company_job_id` already existed, while `company` had not yet been renamed to `client`.

3. **Made Migration Idempotent & Compatibility-Sensitive:**
   Updated `prisma/migrations/20261019120000_client_management/migration.sql` to make the conflicting statements safely handle existing objects:
   - Added column conditionally:
     ```sql
     ALTER TABLE "job" ADD COLUMN IF NOT EXISTS "company_job_id" TEXT;
     ```
   - Added check constraint conditionally inside a PL/pgSQL `DO $$` block:
     ```sql
     DO $$
     BEGIN
         IF NOT EXISTS (
             SELECT 1 FROM pg_constraint
             WHERE conrelid = 'public.job'::regclass
               AND conname = 'job_company_job_id_check'
         ) THEN
             ALTER TABLE "job" ADD CONSTRAINT "job_company_job_id_check"
                 CHECK ("company_job_id" IS NULL OR "company_job_id" ~ '^[A-Z0-9][A-Z0-9 ._/#-]{0,39}$');
         END IF;
     END
     $$;
     ```
   - Created partial unique index conditionally:
     ```sql
     CREATE UNIQUE INDEX IF NOT EXISTS "job_company_job_id_key"
         ON "job"("client_id", "company_job_id")
         WHERE "company_job_id" IS NOT NULL;
     ```

4. **Marked Failed Attempt as Rolled Back:**
   Used the authoritative Prisma command to register that the failed attempt was safely rolled back:
   ```bash
   npx prisma migrate resolve --rolled-back 20261019120000_client_management
   ```

5. **Reran Deployment Migration:**
   Executed the updated migration against the shared database:
   ```bash
   npx prisma migrate deploy
   ```
   Prisma successfully executed the entire migration:
   - Table `company` was renamed to `client` along with constraints and indexes (`client_pkey`, `client_name_check`, `client_name_lower_key`).
   - `job.company_id` was renamed to `job.client_id` with foreign key and index updates.
   - Column `client.agent_id` was created, backfilled from the newest job's `responsible_agent_id`, and linked via `ON DELETE RESTRICT`.
   - Contact columns were added to `agent` and `client`.
   - `job.company_job_id` and its check/index were safely verified without errors.

6. **Regenerated Prisma Client & Verified Status:**
   ```bash
   npx prisma migrate status
   npx prisma generate
   ```
   Prisma reported: `Database schema is up to date!`

### Final Database Result

The shared database was brought into the exact target architectural state:
- Table `client` exists with all historical employer data preserved.
- Table `company` no longer exists (cleanly renamed).
- `job.client_id` exists; legacy `job.company_id` is removed.
- `job.company_job_id` is preserved with its data intact.
- `job.responsible_agent_id` is preserved.
- `client.agent_id` exists with foreign key constraint and index.
- Candidate Form tables (`candidate_form_*`) remain completely intact.
- Candidate Form group-link foreign key (`candidate_form_link.job_id` → `job.id`) remains intact.
- Existing Client and Job UUIDs are preserved; zero orphan records exist.
- `_prisma_migrations` contains two entries for `20261019120000_client_management`:
  - One historical record with `rolled_back_at` populated (the initial failed attempt).
  - One successful record with `finished_at` populated (the clean deployment).
  *Note:* Having two entries in `_prisma_migrations` for a resolved migration is the expected and documented behavior of Prisma's audit ledger; it is not database corruption.

### Prevention & Migration Rules

1. **Always Use `prisma migrate deploy` for Shared Environments:**
   Never run `prisma migrate dev` against shared Supabase or staging databases. `deploy` runs headless, non-interactive, and enforces forward-only migration scripts.
2. **Inspect Shared Migration History Before Writing Overlapping Migrations:**
   When multiple feature branches are active, query `_prisma_migrations` on the shared database before introducing migrations that touch related tables or columns.
3. **Test Both Clean and Upgrade Migration Paths:**
   Always validate migrations against:
   - A clean database from scratch (`init` → latest).
   - An existing shared database clone that contains migration history from other branches.
4. **Never Edit Successfully Applied Historical Migrations:**
   Never retroactively alter a migration file that has already been applied in shared or production environments. Forward migrations must resolve compatibility gaps.
5. **Use Defensive DDL for Cross-Branch Objects:**
   When a column or constraint may already have been introduced by another branch, write compatibility-sensitive DDL (`ADD COLUMN IF NOT EXISTS`, conditional constraint creation via `DO $$` blocks, `CREATE INDEX IF NOT EXISTS`).
6. **Dev Migration Folder vs Shared Database:**
   The `dev` branch migration folder does not contain every Candidate Form migration even though the shared DB has them. This is expected due to branch separation, but it means migration integration must be handled carefully before branches are combined.

---

# 47E. Candidate Form and Dev Reconciliation (Client Architecture vs. Legacy Company)

**Date / Phase**: October 2026 / Feature Reconciliation & Merge into `dev`

### Problem
During parallel development, the Candidate Form branch (`version/candidate-extra-details-form`) was branched from an earlier commit that still referenced the legacy `Company` entity and `job.company_id`. While the candidate form was being developed and hardened, the main active development branch (`dev`) merged the new `Client` management architecture (`version/client-management`), which renamed the `company` table to `client`, introduced the `agent` commercial partner entity, and updated job foreign keys from `company_id` to `client_id`.

### Symptoms & Conflict
When preparing to integrate the Candidate Form feature stream into `dev`, significant architectural divergence and relational conflicts occurred:
1. `candidate-form` and backend job-group services referenced `job.company` and `job.company_id`.
2. Prisma schema on `dev` modeled `client` and `job.client_id`, with no `company` model.
3. Database migrations diverged on how external job references (`company_job_id` / Client Job ID) were introduced.

### Root Cause
Parallel development without periodic rebase synchronization against `dev`. The Candidate Form group link feature had introduced `candidate_form_link.job_id` referencing `job(id)` and `job.company_job_id` alongside legacy `company_id`. Concurrently, `dev` refactored the entire employer domain to `Client`.

### Resolution
The `version/candidate-extra-details-form` branch was reconciled with `dev` across integration commits (`c53b8ff` and `fab7ddc`):
1. **Model & Relation Alignment**: Updated `jobAssignmentReader.js`, `candidateFormJobGroupService.js`, and associated test suites to use `job.client` and `client_id`, retiring all remaining references to the obsolete `company` entity.
2. **Schema & Migration Harmonization**: Adjusted the Candidate Form relations so `candidate_form_link.job_id` links directly to `job.id` (UUID), maintaining relational integrity with the updated `job` model.
3. **Comprehensive Verification**: Ran the full backend test suite (1690+ passing tests) and Admin suite (526+ passing tests) on the reconciled branch before merging cleanly into `dev` (`ea89273`).

### Prevention & Lesson
Long-lived feature branches must be periodically rebased or merged with `dev` to detect relational model refactorings early, preventing painful end-of-release merge collisions.

---

# 47F. Preserving Applied Migrations and the Bridge / Reconciliation Strategy

**Date / Phase**: October 2026 / Multi-Branch Database Coordination

### Problem
In shared staging environments (e.g., Supabase), migrations that have already been applied cannot be edited or retroactively removed without causing checksum failures in Prisma's `_prisma_migrations` ledger.

### Symptoms
When running `npx prisma migrate deploy`, Prisma checks the SHA-256 hash of each local migration file against the `checksum` column in `_prisma_migrations`. If a developer retroactively modifies an applied migration file:
```text
Error: P3009
The migration `20261018130000_job_company_id_and_form_job_group` was modified after it was applied.
```
Furthermore, because `version/candidate-extra-details-form` had applied `20261018130000_...` on the shared database, a branch built from `dev` first (which ran `20261019120000_client_management` first) had a different schema state than the shared database.

### Root Cause
Altering applied migrations violates Prisma's append-only migration ledger. Different branches had applied conflicting DDL operations on the shared database during independent testing cycles.

### Resolution
Rather than editing historical migration files or performing destructive database resets, the team implemented a forward-only **Bridge and Reconciliation Migration Strategy**:
1. **`20261018125900_bridge_dev_first_company_job_id`**:
   - A defensive bridge migration inserted into the timeline immediately before `20261018130000`.
   - Uses a conditional PL/pgSQL `DO $$` block that executes **only** on a database built from `dev` first (where `company_job_id` exists, `company_id` does not, and `candidate_form_link.job_id` does not).
   - In that specific state, it temporarily parks existing `company_job_id` values into `company_job_id_reconcile`, drops conflicting constraints/indexes, and creates a temporary `company_id` column so `20261018130000` can execute byte-identically.
   - On the shared database and on clean databases, it performs a complete no-op.
2. **`20261023120000_reconcile_job_company_job_id`**:
   - A forward-only completion migration that executes after both branch streams have run.
   - Restores the parked `company_job_id_reconcile` values back into `company_job_id`.
   - Cleans up temporary columns and establishes the definitive unique index `("client_id", "company_job_id")`.
   - Performs a no-op on databases where the bridge was not activated.

### Prevention & Lesson
Never edit an applied migration file. Always resolve multi-branch schema divergences using forward-only, idempotent migrations with defensive PL/pgSQL guards (`IF EXISTS`, `IF NOT EXISTS`).

---

# 47G. Candidate Form Security Hardening and Concurrency Controls

**Date / Phase**: October 2026 / Security Audit & Candidate Form Release Hardening

### Problem
Public-facing web forms are vulnerable to identity enumeration, link brute forcing, race conditions during link creation, and replay/duplicate submissions.

### Symptoms
Early prototypes:
- Used knowledge-only factors (Passport Number + WhatsApp), both of which could be acquired or guessed.
- Lacked row-level concurrency locking on access states, allowing simultaneous administrative clicks to generate orphaned or conflicting links.
- Could theoretically permit duplicate submissions or race conditions if a candidate double-clicked submit.

### Root Cause
Public endpoints cannot rely on staff authentication or trusted browser sessions. They require strict defense-in-depth at the cryptographic, database, and application layers.

### Resolution
Implemented comprehensive security hardening across the candidate form architecture:
1. **Fragment Secret Delivery**: Links deliver a 256-bit CSPRNG token (`crypto.randomBytes(32)` in base64url) in the URL fragment (`/#k=<secret>`). Fragments are never sent to servers in HTTP requests, keeping secrets out of access logs, proxy logs, and `Referer` headers.
2. **SHA-256 Stored Hashes**: Only the SHA-256 hash of the secret is stored in `candidate_form_link.token_hash`. Plaintext secrets can never be read back.
3. **Two-Factor Candidate Verification**: Unlocking requires possessing the link secret plus verifying **Passport Number + NIC Number**.
4. **Database Row Locks (`FOR UPDATE`)**:
   - `lockAccessRow(tx, passportId)` serializes link creation and revocation using `SELECT ... FOR UPDATE` on `candidate_form_access`.
   - `lockProcessingJob(tx, jobId)` serializes job-group link generation and ensures the job is actively in `PROCESSING` status.
5. **State Machine Concurrency**: Form access strictly follows `LOCKED -> UNLOCKED -> SUBMITTED`. Every state transition increments `version`, instantly invalidating any prior sessions.
6. **Isolated Storage & Idempotent Submission**: Candidate answers are stored in an append-only `candidate_form_response` table (never directly updating the canonical candidate record). Re-submitting with the same idempotency key returns 200 without creating duplicate response rows.
7. **Job-Group Live Membership**: Job-group links (`JOB_GROUP`) bind to the immutable `job.id` UUID. Membership is evaluated live against active `job_candidate` records where job status is `PROCESSING`. Cross-job candidates are rejected.

### Prevention & Lesson
Never allow public endpoints to directly write canonical business tables. Always use fragment-based secrets, constant-time verification, strict database row locks, and immutable response staging tables.

---

# 47H. Candidate Form Contact Admin State and Public Contact Hardening

**Date / Phase**: October 2026 / Public UI Security & Contact Architecture

### Problem
When candidates encounter terminal access errors (e.g., link expired, link revoked, verification failed, or form already submitted), they require clear guidance on how to contact agency administrators without exposing sensitive internal data or encouraging unmonitored communication.

### Symptoms
Early designs proposed a direct WhatsApp button linking to `https://wa.me/<number>`. In QA, this raised security and operational issues:
- `wa.me` links leaked staff mobile numbers in page source code and DOM trees.
- Candidates could initiate unsolicited WhatsApp messaging without context or verification.
- Error states risked leaking whether an application existed or belonged to another job.

### Root Cause
Conflating staff communication channels with public error-handling workflows, and embedding hardcoded contact actions in client-side code.

### Resolution
1. **Fixed Bilingual Screen**: Designed an integrated English and Sinhala full-screen state for terminal access failures (`We couldn't continue with this form link.` / `මෙම පෝරම සබැඳිය සමඟ ඉදිරියට යාමට නොහැක.`).
2. **Configurable Administrative Contact Numbers**:
   - Implemented `VITE_API_ADMIN_MOBILE_NUMBERS` in `candidate-form/src/config/env.ts`.
   - Accepts comma-separated numbers (e.g., `0771234567, 0719876543`), trims whitespace, filters empty entries, and formats numbers cleanly in tabular numbers.
   - Numbers can be updated in environment settings without code modifications.
3. **Complete Removal of WhatsApp Actions**:
   - Zero `wa.me` URLs, WhatsApp buttons, or messaging links exist in the DOM or source.
   - Verified by automated tests `CONTACT-ADMIN-007` and `CONTACT-ADMIN-008`.
4. **Zero Information Leakage**: Error states render no candidate identifiers, job codes, or server-side error details (`CONTACT-ADMIN-009`).

### Prevention & Lesson
Public error screens should present neutral, bilingual operational instructions. Avoid third-party direct-messaging links, and keep contact phone numbers externalized in environment variables.

---

# 47I. Vercel Candidate Form Multi-Project Preview Deployment

**Date / Phase**: October 2026 / Staging Deployment Configuration

### Problem
The single Git repository contains two distinct web applications (Admin+Backend at root and Candidate Form in `candidate-form/`). Attempting to deploy both from a single Vercel project causes build failures or deploys the wrong application.

### Symptoms
- Deploying the repository root on Vercel runs root `vercel.json`, which builds the Admin dashboard into `public/admin` and deploys Express serverless functions. The Candidate Form was not accessible.
- When creating a second Vercel project, the `candidate-form` folder was not visible in Vercel's directory selector because the default branch (`main`) did not yet have the folder.

### Root Cause
Monorepo topology where different applications have different build roots, different output directories (`public` vs. `dist`), different domains, and different environment scopes.

### Resolution
1. **Configured Separate Vercel Project (Project B)**:
   - Created dedicated Vercel project for the Candidate Form.
   - Explicitly configured **Root Directory** as `candidate-form`.
   - Set framework preset to `Vite`, Install Command to `npm ci`, and Build Command to `npm run build`.
2. **Branch Preview Configuration**:
   - Configured project tracking to build previews from `stage` (and active feature branches) so the `candidate-form/` directory is resolved correctly.
3. **Security Headers**:
   - Defined static security headers in `candidate-form/vercel.json` (`frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `X-Robots-Tag: noindex, nofollow`, `Cache-Control: no-store`).

### Prevention & Lesson
In multi-application repositories on Vercel, always establish separate Vercel projects for each deployable application, specify explicit Root Directories, and configure preview branches appropriately.

---

# 47J. FORM_NOT_CONFIGURED Due to Missing Backend Origin Configuration

**Date / Phase**: October 2026 / Integration Testing

### Problem
When staff clicked **Share Form** in the Admin Dashboard, the link creation modal reported an error.

### Symptoms
`POST /api/admin/candidates/:passportId/form-share` returned HTTP `503 Service Unavailable`:
```json
{
  "code": "FORM_NOT_CONFIGURED",
  "message": "The Candidate Form is not configured, so no link can be created."
}
```

### Root Cause
The backend service (`candidateFormShareService.js`) checks `if (!formOrigin) throw new CandidateError(503, "FORM_NOT_CONFIGURED", ...)`. In the Vercel Preview environment for Project A (Backend), `CANDIDATE_FORM_ORIGIN` was either missing or set to an invalid URL format.

### Resolution
1. Added `CANDIDATE_FORM_ORIGIN` to Vercel Project A settings, scoped to both **Preview** and **Production**.
2. Specified the exact public bare origin of Project B:
   `https://candidate-form-preview.vercel.app` (no `/admin`, no trailing slash, no fragment).
3. Redeployed the backend to make the updated environment active.
4. Subsequent link generation calls succeeded with HTTP 200, returning the generated URL with the random secret fragment.

### Prevention & Lesson
The backend deliberately fails closed when public form integration is unconfigured. Inter-application origin variables must be configured in Vercel before initiating integration testing.

---

# 47K. Candidate Form Token Secret Backend-Only Deployment Boundary

**Date / Phase**: October 2026 / Security Audit

### Problem
Risk of cryptographic secrets leaking into public static frontend bundles if environment variables are improperly scoped or named.

### Symptoms
If a variable like `CANDIDATE_FORM_TOKEN_SECRET` is placed in frontend `.env` files or matches Vite's `envPrefix`, it gets compiled directly into JavaScript bundles distributed to untrusted public browsers.

### Root Cause
Vite embeds any variable matching `envPrefix` into client-side code via `import.meta.env`. Developers accustomed to unified `.env` files can accidentally expose backend encryption keys.

### Resolution
1. **Strict Backend-Only Scoping**: `CANDIDATE_FORM_TOKEN_SECRET` is strictly restricted to Vercel Project A (Backend/Admin). It is never added to Project B.
2. **Restricted Vite Env Prefix**: In `candidate-form/vite.config.ts`, `envPrefix` is set strictly to `VITE_API_`. Vite ignores standard `VITE_*` variables that do not match this prefix.
3. **Automated Secret Scanner Test (`SECRET-001`)**:
   - Automated test in `test/publicCandidateDetails.test.js` scans source files, `.env.example`, and any compiled bundle in `candidate-form/dist` for backend secret names (`CANDIDATE_FORM_TOKEN_SECRET`, `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `META_APP_SECRET`).
   - Asserts that zero backend secrets exist in the public bundle.

### Prevention & Lesson
Enforce hard prefix boundaries in frontend build tooling, and maintain automated test assertions that fail builds if backend secret keys appear in client assets.

---

# 47L. Prisma Windows Query Engine EPERM File Lock

**Date / Phase**: October 2026 / Local Development & Build Verification

### Problem
Running `npx prisma generate` or `npm run postinstall` on Windows development machines fails with a file access error.

### Symptoms
```text
Error: EPERM: operation not permitted, rename
'C:\...\node_modules\.prisma\client\query_engine-windows.dll.node.tmp' ->
'C:\...\node_modules\.prisma\client\query_engine-windows.dll.node'
```

### Root Cause
On Windows, executable files and native dynamic link libraries (`.dll.node`) cannot be renamed or overwritten while a running process has them loaded in memory. If a local Express server (`npm start`), development watcher, or test runner is active, Windows holds an exclusive file lock on the query engine DLL.

### Resolution
1. Terminated all active Node.js processes holding the DLL:
   ```powershell
   Get-Process node | Stop-Process -Force
   ```
2. Re-executed Prisma generation:
   ```powershell
   npx prisma generate
   ```
3. Generation succeeded cleanly, updating the client in `generated/prisma`.

### Prevention & Lesson
Always stop local running Node processes and backend servers before executing Prisma schema migrations or client regeneration on Windows.

---

# 47M. Supabase EMAXCONNSESSION Connection Pool Exhaustion in Serverless Preview

**Date / Phase**: October 2026 / Preview Load & Concurrency Verification

### Problem
During preview testing of multiple Admin Dashboard endpoints, several API routes intermittently returned HTTP `500 Internal Server Error`, and Prisma migration commands failed.

### Symptoms
Backend error logs and `npx prisma migrate status` reported:
```text
PrismaClientInitializationError: Error querying the database:
db error: ERROR: EMAXCONNSESSION max clients reached in session mode
```

### Root Cause
The Supabase Supavisor session-mode pooler reached its maximum concurrent client threshold. This error is **not** caused by an invalid `DATABASE_URL`, incorrect credentials, or database engine corruption.
In Vercel serverless deployments, each incoming request can trigger a new function instance with its own Prisma client connection pool. If `DATABASE_POOL_MAX` is configured too high, or if multiple local development processes and developer GUI tools hold persistent session connections, the Supabase session pool limit is rapidly exceeded.

### Resolution
1. **Conservative Pool Size**: Enforced `DATABASE_POOL_MAX=3` (or default) in backend environment configuration, bounding connection acquisition per serverless function instance.
2. **Session Cleanup**: Closed idle local Node server instances and local database management tools holding open connections to the remote Supabase pooler.
3. **Pooler Port Verification**: Verified that runtime connections use the session-mode pooler host (`aws-0-ap-northeast-1.pooler.supabase.com:5432` or port `6543`), which is required for interactive transactions and `FOR UPDATE` row locks.

### Prevention & Lesson
Serverless functions multiply database connections under concurrency. Never configure large connection pools on serverless backend instances, and keep local test connections disconnected when not in use.

---

# 47N. Vercel Preview Environment-Variable Scoping & Missing Staging Variables

**Date / Phase**: October 2026 / Staging Deployment Setup

### Problem
Variables added to Vercel Project Settings were not taking effect on deployments from the `stage` branch.

### Symptoms
Staging deployments failed at startup with missing environment variable errors (`CANDIDATE_FORM_ORIGIN is missing`, `APP_BASE_URL is missing`), even though the administrator had saved the values in the Vercel dashboard.

### Root Cause
In Vercel Project Settings > Environment Variables, each variable has environment scope checkboxes: **Production**, **Preview**, and **Development**. When configuring new variables, only "Production" was checked by default. Deployments triggered by the `stage` branch are classified as **Preview** deployments by Vercel and therefore did not receive the variables.

### Resolution
1. Opened Vercel Project Settings for both Project A and Project B.
2. Edited each environment variable and checked the **Preview** checkbox (alongside **Production**).
3. Triggered a redeployment of the `stage` branch deployment.
4. The deployment started successfully with all required environment variables present.

### Prevention & Lesson
When adding or updating environment variables for staging testing, always verify that the **Preview** scope is explicitly enabled in Vercel.

---

# 47O. Candidate Form Share Link Origin Enforcement & Host Header Protection

**Date / Phase**: October 2026 / Security Review

### Problem
Risk of generated candidate share links containing incorrect hostnames (e.g., `http://localhost:5174/#k=...`) or being manipulated via HTTP Host Header injection.

### Symptoms
In development setups, if share links are constructed from the incoming HTTP `Host` or `X-Forwarded-Host` header, staff accessing the Admin Dashboard through internal proxies or localhost generate links that external candidates cannot open. Furthermore, OWASP identifies Host-header injection as a vulnerability if an attacker can manipulate headers to generate links pointing to a malicious phishing origin.

### Root Cause
Deriving external public URLs from client-supplied HTTP request headers instead of server-controlled environment configurations.

### Resolution
1. **Strict Configured Origin**: In `src/services/candidateFormShareService.js`, the share URL generator strictly uses the configured `formOrigin`:
   ```javascript
   export const shareUrl = (formOrigin, secret) => `${formOrigin}/#k=${secret}`;
   ```
2. **Zero Header Reliance**: The backend completely ignores `req.headers.host` and `req.headers['x-forwarded-host']` when constructing share links.
3. **Fail-Closed Validation**: If `CANDIDATE_FORM_ORIGIN` is missing or invalid, link creation throws `FORM_NOT_CONFIGURED` (503) rather than guessing or defaulting to the request host.

### Prevention & Lesson
Never use incoming request headers to determine public application URLs. Always construct external shareable links from explicit, validated server environment variables.

---

# 47P. Google Sheet Sync & Candidate Form Submission Sync: Deployment & Debugging History

**Date / Phase**: October 2026 / Cloud Run Worker Deployment & Google Sheet Outbox Verification

This section records the operational blockers, routing anomalies, write gate behaviors, and deployment requirements encountered while deploying and verifying the Google Sheet synchronization features on Cloud Run (`emlynk-sheet-sync-worker`, region `asia-south1`).

---

### 47P.1 Candidate Form Submission Succeeded but Google Sheet Stayed Empty

#### Problem
A candidate successfully submitted the Candidate Extra Details Form, and the submission was stored in PostgreSQL, but no corresponding row appeared in the Google Sheet's `Candidate Form Submissions` tab.

#### Symptoms
- The candidate wizard displayed the green success confirmation screen with a valid timestamp.
- The PostgreSQL database confirmed that `candidate_form_response` was stored with all submitted answers.
- The outbox table `candidate_form_sheet_sync` contained the row for the candidate's passport ID:
  ```json
  {
    "submissionId": "e5d7e9de-5f80-4c1e-a41b-27b003eda58a",
    "passportId": "PN25847",
    "status": "PENDING",
    "attempts": 0,
    "leaseOwner": null,
    "lastResult": null,
    "lastErrorClass": null,
    "lastErrorCode": null
  }
  ```
- The row remained in `PENDING` indefinitely, and `attempts` remained `0`.
- The Google Sheet `Candidate Form Submissions` tab remained completely empty.

#### Investigation
1. **Database Identity**: Verified that local/backend API processes and the Cloud Run worker were connected to the exact same hosted Supabase database instance.
2. **Atomic Outbox Creation**: Confirmed that `submitCandidateForm` in `src/services/candidateFormDataService.js` correctly enqueues the outbox row in the same transaction as `candidate_form_response`.
3. **Worker Code Audit**: Inspected `src/services/sheetSyncWorker.js:357`:
   ```javascript
   let formBatchFull = false;
   if (formSubmissions && config.enabled === true) {
       try {
           const form = await formSubmissions.processDue({ owner, destination: active, withWriterLease });
           ...
       }
   }
   ```
4. **State Audit**: Queried `sheet_sync_state`:
   - `write_gate: "DISABLED"`
   - `SHEET_SYNC_ENABLED` was `"false"`.

#### Root Cause
The worker loop deliberately guards form submission processing with `config.enabled === true`. When `SHEET_SYNC_ENABLED` is `"false"` (the safe default in `deploy/sheet-sync-worker.env.yaml`), `config.enabled` evaluates to `false`. The worker tick loop completely bypasses `formSubmissions.processDue()`. The outbox row was never claimed, remaining in `PENDING` with `attempts = 0`.

#### Solution
1. Changed `SHEET_SYNC_ENABLED` to `"true"` in `deploy/sheet-sync-worker.env.yaml`.
2. Redeployed the Cloud Run worker service so the container loaded the updated environment.
3. Upon startup, the worker claimed the due `PENDING` row under the shared writer lease, created the 74-column header row in the blank tab, and appended the submission row with `lastResult: 'APPENDED'`.

---

### 47P.2 `POST /tasks/reconcile` Returned 404 (Dockerfile Default Entrypoint)

#### Problem
Triggering a manual reconciliation via `POST /tasks/reconcile` against the Cloud Run worker returned `HTTP 404 Not Found`.

#### Symptoms
```text
HTTP/2 404
content-type: text/html; charset=utf-8
content-length: 159

<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Error</title>
</head>
<body>
<pre>Cannot POST /tasks/reconcile</pre>
</body>
</html>
```

#### Root Cause
The repository uses a single root `Dockerfile` shared by multiple backend services. The default entrypoint is:
```dockerfile
CMD ["node", "src/app.js"]
```
When `emlynk-sheet-sync-worker` was deployed without container command overrides, Cloud Run started `node src/app.js` (the Express API backend). The Express API does not mount `/tasks/reconcile`, resulting in an Express default 404.

Furthermore, [src/sheetSyncWorkerProcess.js](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/src/sheetSyncWorkerProcess.js) is a module export library rather than an executable; running `node src/sheetSyncWorkerProcess.js` executes no top-level listeners and exits immediately with code 0. The true standalone worker executable is [src/sheetSyncWorker.js](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/src/sheetSyncWorker.js).

#### Solution
Configured the Cloud Run service deployment to override container execution parameters:
- `--command=node`
- `--args=src/sheetSyncWorker.js`

---

### 47P.3 `POST /tasks/reconcile` Still Returned 404 After Command Override

#### Problem
Even after overriding the Cloud Run command to execute `node src/sheetSyncWorker.js`, calling `POST /tasks/reconcile` continued to return `404 Not Found`. Meanwhile, `GET /health` returned `200 {"status":"OK"}`.

#### Symptoms
- `GET /health` → `200 {"status":"OK"}` (confirmed the worker process was running and listening).
- `POST /tasks/reconcile` → `404 Not Found` (plain empty 404 from the worker HTTP server).

#### Root Cause
In [src/sheetSyncWorkerProcess.js](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/src/sheetSyncWorkerProcess.js#L52), the route was originally gated as follows:
```javascript
// Old logic:
if (req.method === "POST" && path === "/tasks/reconcile" && verifyScheduler) {
    if (!(await verifyScheduler(req.headers.authorization))) { ... }
    ...
}
return send(404);
```
In `src/sheetSyncWorker.js:98-105`, `verifyScheduler` is created **only if** both `SHEET_SYNC_SCHEDULER_AUDIENCE` and `SHEET_SYNC_SCHEDULER_INVOKER` are present in `process.env`. In `deploy/sheet-sync-worker.env.yaml`, these variables were commented out by default. Because `verifyScheduler` was `null`, the condition `&& verifyScheduler` evaluated to `false`, causing the server to fall through to `return send(404);`.

#### Solution
Refactored `createSheetSyncHttpServer` in `src/sheetSyncWorkerProcess.js` so that the endpoint is always registered. Token verification is applied defence-in-depth if `verifyScheduler` is configured, while Cloud Run IAM (`--no-allow-unauthenticated`) serves as the outer authorization boundary:
```javascript
if (req.method === "POST" && path === "/tasks/reconcile") {
    if (verifyScheduler) {
        if (!(await verifyScheduler(req.headers.authorization))) {
            log.warn(JSON.stringify({ event: "sheet_sync.trigger_rejected" }));
            return send(401, { message: "Unauthorized" });
        }
    }
    const run = await requestReconcile();
    log.log(JSON.stringify({ event: "sheet_sync.run_requested", kind: "RECONCILE", trigger: "SCHEDULER", runId: run.runId, created: run.created }));
    return send(202, run);
}
```
Updated `test/sheetSyncWorkerProcess.test.js` to assert that the endpoint returns `202 Accepted` when scheduler env vars are omitted.

---

### 47P.4 Cloud Run POST Returned 411 Length Required

#### Problem
Triggering `POST /tasks/reconcile` via `curl` returned `HTTP 411 Length Required`.

#### Symptoms
```text
HTTP/2 411
date: Thu, 22 Oct 2026 08:44:56 GMT
content-type: text/html; charset=UTF-8
server: Google Frontend
content-length: 310

<html><head>
<meta http-equiv="content-type" content="text/html;charset=utf-8">
<title>411 Length Required</title>
</head>
<body text=#000000 bgcolor=#ffffff>
<h1>Error: Length Required</h1>
<h2>The server encountered an error and could not complete your request.<p>Please try again in 30 seconds.</h2>
```

#### Root Cause
When executing `curl -X POST https://<service-url>/tasks/reconcile` without a request body, `curl` omits the `Content-Length` header. The Google Cloud Run Google Frontend (GFE) edge reverse-proxy requires a `Content-Length` header on all `POST` requests and rejects empty `POST` requests before they reach the container.

#### Solution
Supplied an explicit empty JSON payload and `Content-Type` header:
```cmd
FOR /F "tokens=*" %i IN ('gcloud auth print-identity-token') DO SET GCLOUD_TOKEN=%i
curl -i -X POST -H "Authorization: Bearer %GCLOUD_TOKEN%" -H "Content-Type: application/json" -d "{}" https://emlynk-sheet-sync-worker-76153319636.asia-south1.run.app/tasks/reconcile
```
The request successfully reached the container, returning `202 Accepted` with a queued run ID.

---

### 47P.5 Reconcile Run Succeeded but Did Not Write (`dryRun: true`)

#### Problem
Reconciliation completed with `status: "SUCCEEDED"`, but no changes were applied to the Google Sheet.

#### Symptoms
Querying `sheet_sync_runs` for run `8caf5eaf-ba35-4a9b-834e-a0bc8bda95ee`:
```json
{
  "runId": "8caf5eaf-ba35-4a9b-834e-a0bc8bda95ee",
  "status": "SUCCEEDED",
  "dryRun": true,
  "summary": {
    "dryRun": true,
    "updated": 0,
    "appended": 0,
    "sheetRows": 8,
    "unchanged": 8,
    "databaseCandidates": 8
  }
}
```

#### Root Cause
`SHEET_SYNC_ENABLED` was set to `"false"`. By design, when writes are disabled, the worker acquires a Google OAuth token with the read-only scope (`spreadsheets.readonly`). Reconciliations run in dry-run mode, calculating drift and validating schemas without committing writes.

#### Solution
Enabled write authorization by setting `SHEET_SYNC_ENABLED="true"` and redeploying the worker.

---

### 47P.6 Local Environment File and Cloud Run Revision Did Not Match

#### Problem
The local configuration file `deploy/sheet-sync-worker.env.yaml` was edited to `SHEET_SYNC_ENABLED: "true"`, but Cloud Run logs still showed `writeGate: "DISABLED"`.

#### Symptoms
- Local file inspection: `SHEET_SYNC_ENABLED: "true"`.
- Remote container logs: `{"event":"sheet_sync.worker_config","writeGate":"DISABLED","gateReason":"FALSE"}`.

#### Root Cause
Cloud Run revisions are **immutable deployment artifacts**. Editing local configuration files on a development workstation does not alter the active revision running in Google Cloud. An explicit deployment command is required to compile a new service revision with the updated environment file.

#### Solution
1. Redeployed Cloud Run with the updated environment file:
   ```cmd
   gcloud run deploy emlynk-sheet-sync-worker ^
     --project=project-aa11e15e-a951-4e1b-a65 ^
     --region=asia-south1 ^
     --image=asia-south1-docker.pkg.dev/project-aa11e15e-a951-4e1b-a65/emlynk-ocr/sheet-sync-worker:latest ^
     --env-vars-file=deploy/sheet-sync-worker.env.yaml
   ```
2. Verified active revision environment variables:
   ```cmd
   gcloud run services describe emlynk-sheet-sync-worker --project=project-aa11e15e-a951-4e1b-a65 --region=asia-south1 --format="yaml(spec.template.spec.containers[0].env)"
   ```

---

### 47P.7 Cloud Scheduler Expected but No Jobs Existed in Project

#### Problem
Attempts to inspect or run automated reconciliation cron jobs failed.

#### Symptoms
- Running `gcloud scheduler jobs list --location asia-south1` returned:
  `ERROR: (gcloud.scheduler.jobs.list) Cloud Scheduler API has not been used in project project-aa11e15e-a951-4e1b-a65 before or it is disabled.`
- After enabling the Cloud Scheduler API (`gcloud services enable cloudscheduler.googleapis.com`), listing jobs returned:
  `Listed 0 items.`

#### Root Cause
While the architecture documentation specified automated reconciliation at 06:00, 12:00, and 18:00 Asia/Colombo (`0 6,12,18 * * *`), the Cloud Scheduler job had never been provisioned in the Google Cloud project.

#### Resolution & Current Operational Reality
1. Documented that Cloud Scheduler cron jobs are **not currently provisioned** in the GCP project.
2. Verified that the Sheet Sync Worker operates autonomously via its internal polling loop (`SHEET_SYNC_POLL_INTERVAL_MS=10000`) because Cloud Run is deployed with `--min-instances=1` and `--no-cpu-throttling`.
3. Candidate Form submissions are processed continuously via the worker's polling loop.
4. Operational Mirror reconciliations can be triggered on demand via the Admin Console ("Sync Now") or via the operator CLI (`npm run sheet:request -- reconcile`).
5. Provisioning the Cloud Scheduler cron job remains an operational deployment step:
   ```cmd
   gcloud scheduler jobs create http emlynk-sheet-sync-reconcile ^
     --project=project-aa11e15e-a951-4e1b-a65 ^
     --location=asia-south1 ^
     --schedule="0 6,12,18 * * *" ^
     --time-zone=Asia/Colombo ^
     --uri="https://emlynk-sheet-sync-worker-76153319636.asia-south1.run.app/tasks/reconcile" ^
     --http-method=POST ^
     --headers="Content-Type=application/json" ^
     --message-body="{}" ^
     --oidc-service-account-email="emlynk-sheet-sync-scheduler@project-aa11e15e-a951-4e1b-a65.iam.gserviceaccount.com" ^
     --oidc-token-audience="https://emlynk-sheet-sync-worker-76153319636.asia-south1.run.app"
   ```

---

### 47P.8 Root Dockerfile Reused for Worker Service

#### Problem
Risk of worker container crashing or running the incorrect application if built without entrypoint awareness.

#### Explanation & Requirement
The root `Dockerfile` is shared across the entire backend monorepo and defaults to:
```dockerfile
CMD ["node", "src/app.js"]
```
Building a dedicated Dockerfile for every microservice creates maintenance churn. Reusing the root Dockerfile for `emlynk-sheet-sync-worker` is acceptable and supported, provided that **every deployment command explicitly overrides the container command and arguments**:
```text
--command=node
--args=src/sheetSyncWorker.js
```
Omitting these flags causes Cloud Run to start the Express API backend instead of the sheet sync worker.

---

# 48. Current Project Status

## Completed

### Database & Authentication
- `users` table renamed to `candidate`
- `admins` table renamed to `user`
- `company` table renamed to `client` (authoritative employer entity; `company` retired)
- `agent` table created (overseas agency commercial partner; `country_code`, contact details, `is_active`)
- `client.agent_id` foreign key established with `ON DELETE RESTRICT`
- `job`, `job_type`, `job_candidate`, `job_code_counter` fully implemented
- Single active `PROCESSING` job per candidate enforced at service, index, and trigger levels
- `job.company_job_id` retained as Client Job ID (external employer reference) with per-client unique index
- Supabase Auth migration fully complete
- Custom password hashing, bcrypt, and legacy JWT libraries removed
- `auth_user_id` UUID foreign key active and enforced
- Gmail SMTP configured for invitation and password reset emails
- User invitation lifecycle (`/admin/settings/invite`) and setup flow verified
- Role-Based Access Control (RBAC) enforced on every API route (`ADMIN`, `MANAGER`, `ANALYST`, `REGISTRATION_DESK`)
- Migration `20261019120000_client_management` successfully deployed and verified on shared Supabase instance
- Bridge and reconciliation migrations (`20261018125900_bridge_dev_first_company_job_id` and `20261023120000_reconcile_job_company_job_id`) implemented to preserve applied migration history

### Candidate Extra Details Form & Public Security (Integrated)
- **Candidate Extra Details Form (`candidate-form/`)**:
  - Independent Vite single-page application deployed to Vercel Project B.
  - 4-step wizard: Verify -> Personal Details -> Work & Family -> Review & Submit.
  - Full bilingual support (English and සිංහල) and Light/Dark theme.
  - Universal calendar `DatePicker` (built on `react-day-picker`) with zero timezone shifting.
  - Dynamic build-time Content Security Policy (CSP) pinning `connect-src` strictly to backend API origin.
- **Security & Link Architecture**:
  - Single-candidate share links with 256-bit CSPRNG secrets delivered in `#k=` URL fragment.
  - Stored strictly as SHA-256 hashes (`candidate_form_link.token_hash`) with 3-day TTL.
  - Two-factor verification: Link possession + matching Passport Number + NIC Number.
  - `JOB_GROUP` share links bound to immutable `job.id` UUID with live `PROCESSING` job membership verification.
  - Form access state machine (`LOCKED -> UNLOCKED -> SUBMITTED`) with version increments invalidating prior sessions.
  - Submissions written once to isolated `candidate_form_response` table; canonical candidate record remains untouched by public submissions.
  - Generic 401 verification responses with timing equalization and rate limiting (per-IP and per-passport).
- **Admin Review & Reconciliation Workflow**:
  - Read-only submission view (`GET /api/admin/candidates/:passportId/form-submission`).
  - Inline field-level review hints: "Candidate submitted: <value> [Confirm] [Revoke]".
  - Strict server-side allowlists for confirmable fields with full audit logging (`CANDIDATE_FORM_FIELD_CONFIRMED`, `CANDIDATE_FORM_FIELD_REJECTED`).
- **Contact Admin Hardening**:
  - Dedicated bilingual terminal access failure screen with configurable administrative mobile numbers (`VITE_API_ADMIN_MOBILE_NUMBERS`).
  - Total removal of direct WhatsApp actions and `wa.me` links.

### Master Data & Operational Modules
- **Agent Management (`/admin/agents`)**: Full CRUD and lifecycle protection (blocked from deactivation while `PROCESSING` jobs exist).
- **Client Management (`/admin/client-management`)**: Employer client management separate from legacy candidate `/clients` workflow.
- **Job Management (`/admin/jobs`)**: Demand order tracking, Client Job ID, candidate assignment history, and atomic `job_code` generation.
- **Work Allocation Equal Distribution (`/admin/work-allocation`)**: Automated distribution via $\text{floor}(\text{eligible} / \text{analysts})$ with concurrency row locks (`FOR UPDATE`) and remainder protection.
- **Universal Modern DatePicker**: Reusable `react-day-picker` integration across all Admin date inputs with `YYYY-MM-DD` persistence, month/year navigation, and zero timezone shifting.

### Candidate & Deployment Workflows
- Candidate Pool (`/admin/candidates`) with server-side pagination and search
- Candidate Registration form with duplicate validation
- 7-stage deployment workflow tracking
- Candidate document upload via signed URLs and removal with audit reasons
- Candidate Call Logs drawer, now **Candidate History** (calls, No Answer attempts and candidate activity; compact, collapsible add form; backdrop close; see section 47B)
- **Need Attention** page (`/admin/follow-ups`), formerly Priority Follow-Ups; the route, API and `call_log_follow_up` table keep their names
- Light Theme border visibility strengthened globally (section 47A)
- Parent name and birthday independent of the alive answer; child names unavailable when marital status is Single

### Daily Report System
- Redesigned Daily Report (`/admin/reports/daily`) with Candidates terminology
- Summary view (5 KPIs, documents by type, completed candidates, calls, review actions)
- Summary by Roles view (productivity breakdown for Analyst, Manager, Admin, Registration Desk)
- Registered Candidates tracking (authoritative `candidate.created_date` filtering, zero-document support)
- Real failure reason analysis for incomplete stages with 25-per-page candidate drill-down
- Structured vector PDF export via jsPDF with repeated headers and pagination

### Google Sheet Sync & Worker Architecture
- One-way DB → Google Sheet operational mirror (`Emlynk Candidate Operational Mirror`, 41 columns, position-independent)
- Staged Candidate Form Submissions sync (`Candidate Form Submissions`, 74 columns, isolated outbox)
- Queue/outbox reconciliation architecture (`sheet_sync_queue` and `candidate_form_sheet_sync`)
- Cloud Run worker (`emlynk-sheet-sync-worker`) running on Google Cloud Run with `--min-instances=1`
- Sync Destination dropdown and validation protocol in Admin Settings (`/admin/settings/sheet-sync`)
- Automated schedule design (06:00, 12:00, 18:00 Asia/Colombo)
- Consolidated reference: [Docs/GOOGLE_SHEET_INTEGRATION.md](file:///c:/Users/Shamal%20Sathsara/OneDrive/Desktop/EmlynkWABot/Docs/GOOGLE_SHEET_INTEGRATION.md)

---

# 49. Current Hold / Pending Items

## Google Cloud Billing Account — RESOLVED

- **Previous Status**: Live deployment was on hold due to closed billing account.
- **Current Status**: **RESOLVED**. The Google Cloud billing account was reactivated, payment was completed, billing status was confirmed active (`billingEnabled: true`), Cloud Build succeeded, and the latest worker container image was deployed to Cloud Run.

## Cloud Scheduler Automated Cron — PENDING PROVISIONING

- **Current Status**: Cloud Scheduler API was enabled, but automated jobs are not currently provisioned (`gcloud scheduler jobs list` returned 0 items).
- **Operational Impact**: None on Candidate Form sync (worker processes due outbox rows continuously via its internal polling loop). Operational Mirror reconciliations can be triggered on demand via Admin Settings "Sync Now" or operator CLI until Cloud Scheduler job is provisioned.

## Local Direct Supabase DB Connection

- Direct PostgreSQL connection (`db.<project-ref>.supabase.co:5432`) may be unreachable from some local networks due to IPv6 routing.
- **Recommended Local Solution**: Use Supabase Session Pooler (port 6543) in local `.env`.
- This is a local network environment condition, not an application code bug.

---

# 50. Recommended Next Steps

1. Continue feature work on the active `dev` branch.
2. When releasing integrated features, merge into `stage` for Vercel preview validation.
3. Monitor Google Sheet Sync worker heartbeats in Admin Settings.
4. Verify scheduled sync executions at 06:00, 12:00, and 18:00 Sri Lanka time.
5. Maintain strict separation between true daily historical activity and current snapshot pipeline metrics in all future reporting features.

---

# 51. Key Lessons Learned

## Architecture & System Design
- Separate heavy workloads (OCR, background synchronization) from web application lifecycles.
- The PostgreSQL database must always remain the single authoritative source of truth.
- External operational views (Google Sheets) must be strictly read-only mirrors.

## Background Workers & Configuration
- When background workers own configuration publishing (e.g. Sync Destinations via heartbeat), updating the web frontend and API is insufficient; the worker service must also be redeployed.
- Always provide safe defaults (e.g. `default` destination fallback) when new configuration schemas are introduced.

## Cloud Operations & Account Health
- Cloud Build failures with `403` or billing disabled errors cannot be fixed by modifying Dockerfiles or application code.
- Always check account standing via `gcloud billing projects describe` before debugging deployment scripts.

## Daily Reporting & Data Semantics
- Candidate registration is an independent business event from document submission; zero-document intake must remain visible.
- Always explicitly differentiate historical daily activity (immutable event timestamps) from current pipeline snapshots (evaluated at request time).
- Do not claim historical metrics exist unless the underlying schema stores an immutable history.

## UI Theme & Frontend Tests
- For a UI-wide visual problem, audit the token architecture first and change the existing global tokens (including scoped overrides such as `.ui-classic`) instead of editing components one by one.
- Change only Light-specific selectors to keep the Dark Theme byte-for-byte unchanged.
- Do not treat full-suite async timing failures as product regressions without a focused reproduction; wait for the rendered result before asserting on a request spy.

## Git & Team Workflows
- Keep `dev` as the active feature branch and `stage` as the integration preview branch.
- Avoid modifying `main` until integration testing is approved.
- Avoid rewriting Git history on shared branches to fix minor metadata like commit trailers.

## Database Migrations & Multi-Branch Schema Coordination
- In shared cloud environments (e.g. Supabase), divergent feature branches can easily introduce schema overlap. Never blindly run `prisma migrate dev` against shared databases.
- Always use `prisma migrate deploy` for shared, staging, and production deployments.
- When an overlapping migration fails, never mark it `--applied` unless every individual statement has actually taken effect in the database; `--applied` creates a false success record while leaving the schema partially unmigrated. Use `--rolled-back` and repair the migration script using defensive, idempotent DDL (`ADD COLUMN IF NOT EXISTS`, conditional PL/pgSQL `DO $$` blocks, `CREATE UNIQUE INDEX IF NOT EXISTS`).
- Always test both migration paths: clean-database path (fresh DB from scratch) and the real upgrade path from the shared database's historical state.
- Note that the `dev` branch migration folder does not contain every Candidate Form migration even though the shared DB has them. This is expected due to branch separation, but it means migration integration must be handled carefully before branches are combined.

---

# 52. Final Summary

The EmlynkWABot system has matured from an early intake prototype into a resilient, enterprise-grade recruitment operations console.

Major completed milestones include:
```text
Monolithic OCR       -> Separate Cloud Run OCR Worker
Custom Auth          -> Supabase Auth (RBAC, Invitations, Password Reset)
Legacy Tables        -> candidate / user / auth.users / client / agent / job
Real-Time Sheet Sync -> Scheduled Reconciliation + Worker Outbox Mirror
Fixed Sheet Mapping  -> Dynamic 41-Column Header Mapping + Destination Selector
Basic Intake Report  -> Modern Daily Report (5 KPIs, Role Summaries, PDF Export)
Equal Allocation     -> Automated Deterministic Equal Distribution across Analysts
Master Data          -> Agent Management, Employer Client Management, and Job Tracking
Modern Date Picker   -> Universal react-day-picker Integration (Zero Timezone Shift)
```

The Google Cloud billing hold has been completely resolved, the background worker is active and healthy on Cloud Run, and the Admin Console provides end-to-end visibility across candidate registration, deployment stages, call logs, and daily productivity.

---

## Document Maintenance Note

Update this document whenever a major incident, deployment blocker, or architectural transition occurs.

For each incident, record:
- Date / Phase
- Symptoms & error output
- Root cause
- Resolution steps
- Verification
- Troubleshooting lesson & prevention

This prevents recurring issues and provides incoming engineers with complete operational context.

