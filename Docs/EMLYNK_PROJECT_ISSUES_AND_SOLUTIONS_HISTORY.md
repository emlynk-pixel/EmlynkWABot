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

# 48. Current Project Status

## Completed

### Database & Authentication
- `users` table renamed to `candidate`
- `admins` table renamed to `user`
- Supabase Auth migration fully complete
- Custom password hashing, bcrypt, and legacy JWT libraries removed
- `auth_user_id` UUID foreign key active and enforced
- Gmail SMTP configured for invitation and password reset emails
- User invitation lifecycle (`/admin/settings/invite`) and setup flow verified
- Role-Based Access Control (RBAC) enforced on every API route (`ADMIN`, `MANAGER`, `ANALYST`, `REGISTRATION_DESK`)

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
- One-way DB → Google Sheet operational mirror
- Dynamic header mapping (41 columns, position-independent)
- Queue/outbox reconciliation architecture
- Cloud Run worker (`emlynk-sheet-sync-worker`) running on Google Cloud Run
- Sync Destination dropdown and validation protocol in Admin Settings (`/admin/settings/sheet-sync`)
- Automated schedule (06:00, 12:00, 18:00 Asia/Colombo)

---

# 49. Current Hold / Pending Items

## Google Cloud Billing Account — RESOLVED

- **Previous Status**: Live deployment was on hold due to closed billing account.
- **Current Status**: **RESOLVED**. The Google Cloud billing account was reactivated, payment was completed, billing status was confirmed active (`billingEnabled: true`), Cloud Build succeeded, and the latest worker container image was deployed to Cloud Run.

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

---

# 52. Final Summary

The EmlynkWABot system has matured from an early intake prototype into a resilient, enterprise-grade recruitment operations console.

Major completed milestones include:
```text
Monolithic OCR       -> Separate Cloud Run OCR Worker
Custom Auth          -> Supabase Auth (RBAC, Invitations, Password Reset)
Legacy Tables        -> candidate / user / auth.users
Real-Time Sheet Sync -> Scheduled Reconciliation + Worker Outbox Mirror
Fixed Sheet Mapping  -> Dynamic 41-Column Header Mapping + Destination Selector
Basic Intake Report  -> Modern Daily Report (5 KPIs, Role Summaries, PDF Export)
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

