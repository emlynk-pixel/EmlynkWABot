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

# 29. Google Cloud Billing Blocker

When redeploying the Sheet Sync worker, Cloud Build failed:

```text
403 Could not upload file
```

with:

```text
The billing account for the owning project is disabled in state closed.
```

Command:

```powershell
gcloud builds submit --project=project-aa11e15e-a951-4e1b-a65 ...
```

failed before the build started.

---

## 29.1 Billing Verification

Command:

```powershell
gcloud billing projects describe project-aa11e15e-a951-4e1b-a65
```

returned:

```text
billingEnabled: false
```

Billing account:

```text
014FEB-5E0B68-D2CE4E
```

was linked but disabled.

Google Cloud Console showed:

```text
Closed
Not in good standing
```

---

## 29.2 Card Verification Confusion

During Google Cloud free-trial/account verification, a temporary card payment/authorization was requested.

The amount was later refunded.

This was expected for card verification.

However:

> The verification refund did not automatically restore the Cloud Billing account to good standing.

So Cloud Build remained blocked.

---

## 29.3 Current Status of Sheet Sync Deployment

Coding is complete.

Automated tests passed.

But live deployment/testing is **ON HOLD** because:

```text
GCP billing disabled / account not in good standing
```

Remaining actions after billing is fixed:

1. Build latest worker image.
2. Redeploy Cloud Run worker.
3. Create/update Cloud Scheduler.
4. Run `Test Connection`.
5. Run `Sync Now`.
6. Verify 41-column dynamic mapping.
7. Verify document dates / `Not Submitted`.
8. Verify scheduled sync.
9. Verify immediate real-time syncing no longer occurs.

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

# 43. Current Project Status

## Completed

### Database / Auth

- `users` renamed to `candidate`
- `admins` renamed to `user`
- Supabase Auth migration complete
- old auth tables removed
- password hashes removed
- `auth_user_id` UUID FK active
- Gmail SMTP configured
- invite flow tested
- reset-password flow tested
- admin login tested
- legacy JWT/bcrypt/custom auth removed

### OCR

- separate Cloud Run OCR worker created
- Artifact Registry image workflow established
- authenticated backend-to-worker call implemented

### Google Sheet Sync Code

- dynamic column mapping
- DB remains source of truth
- queue/outbox architecture
- manual sync
- scheduled sync code
- real-time processing removed in latest code
- document date output
- `Not Submitted` fallback
- R/W output corrected
- automated tests passing

---

# 44. Current Hold / Pending Items

## Google Sheet Sync Deployment — HOLD

Reason:

```text
Google Cloud billing account is closed / not in good standing.
```

The coding part is complete.

Final live steps are blocked:

```text
Cloud Build
Cloud Run redeploy
Cloud Scheduler creation/update
live Google Sheet validation
```

---

## Local Direct Supabase DB Connection

Current direct connection:

```text
db.<project-ref>.supabase.co:5432
```

became unreachable from the local machine/network.

Recommended local workaround:

```text
Supabase Session Pooler
```

This is an environment/network issue, not an application-code issue.

---

# 45. Recommended Next Steps After the Hold Is Cleared

When Google Cloud billing is active again:

1. Confirm `dev` contains the latest Sheet Sync commits.
2. Build latest Sheet Sync worker image.
3. Redeploy `emlynk-sheet-sync-worker`.
4. Confirm heartbeat.
5. Run `Test Connection`.
6. Confirm old `AI...AN` schema error disappears.
7. Run `Sync Now`.
8. Verify current 41-column Sheet mapping.
9. Verify all document columns.
10. Verify R and W = `Not Submitted`.
11. Verify database is unchanged by Sheet edits.
12. Create Cloud Scheduler job:
    ```text
    0 6,12,18 * * *
    Asia/Colombo
    ```
13. Trigger Scheduler manually once.
14. Confirm successful run.
15. Confirm no immediate real-time sync occurs after a DB edit.
16. Mark Trello task complete.

---

# 46. Key Lessons Learned

## Architecture

- Heavy OCR and background synchronization should not run inside the web request lifecycle.
- Database should remain the central source of truth.
- External operational views such as Google Sheets should be mirrors, not writable databases.

## Authentication

- Managed auth reduces the amount of sensitive security code the project must own.
- Do not keep two auth systems active at the same time.
- Every application staff row should have exactly one identity mapping.

## Database Migrations

- Never blindly run all migrations when a migration has explicit preconditions.
- An intermediate migration state may not be readable by the final generated Prisma client.
- Preserve existing referenced rows instead of deleting/recreating them.

## Deployment

- Always verify which branch/revision is actually deployed.
- A stale Cloud Run revision can look exactly like a new code bug.
- Local environment changes do not affect Vercel or Cloud Run.
- Billing/account state can block builds even when code is correct.

## Debugging

- Error code shown by the app may not represent the actual root cause.
- `P2010` was ultimately a connectivity problem proven by `P1001`.
- Middleware can fail before the route being debugged.
- Use the smallest independent health check possible.

## Git

- Version branches are useful snapshots.
- `dev` should remain the active development base.
- `stage` is for integrated preview testing.
- Avoid touching `main` until review/approval.

---

# 47. Final Summary

The EmlynkWABot project went through several major architecture changes rather than only feature additions.

The largest transitions were:

```text
Monolithic OCR
-> Separate Cloud Run OCR worker

Custom auth
-> Supabase Auth

users/admins tables
-> candidate/user + auth.users

Real-time Sheet writes
-> Scheduled reconciliation + manual sync

Position-based Sheet mapping
-> Dynamic header mapping
```

Most difficult issues were not caused by business logic.

They were caused by:

- branch differences,
- stale deployments,
- environment mismatches,
- cloud account state,
- database migration ordering,
- cross-schema constraints,
- network connectivity,
- build configuration,
- and provider-specific behavior.

The project is now much cleaner architecturally:

```text
Supabase = DB + Storage + Auth
Vercel = Admin/preview web deployment
Cloud Run = OCR + background workers
Google Sheets = read-only operational mirror
Meta = WhatsApp intake
```

The main current blocker is external:

```text
Google Cloud Billing account disabled / closed
```

Once that billing state is resolved, the latest Google Sheet Sync worker can be deployed and final live scheduled-sync verification can be completed.

---

## Document Maintenance Note

Update this file whenever a major incident occurs.

For each new incident, record:

```text
Date
Feature / service
Symptom
Error message
Root cause
Investigation
Fix
Verification
Current status
Lesson learned
```

This prevents the same debugging work from being repeated later.
