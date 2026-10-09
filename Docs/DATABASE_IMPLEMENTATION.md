# Database Implementation Guide

Technical architecture documentation for the PostgreSQL / Supabase database implementation, Prisma ORM mapping, and Supabase Auth integration in EmlynkWABot.

---

## 1. Overview

The EmlynkWABot system uses a hosted **PostgreSQL** database managed on **Supabase**, interfaced from Node.js applications via **Prisma ORM**.

Key architectural principles:
- **Database as Source of Truth**: The PostgreSQL database is the sole authoritative store for all candidate records, document metadata, application staff accounts, audit trails, and integration queues.
- **Supabase Auth Ownership**: Credential management, sign-in sessions, JWT issuance, invitation dispatch, and password recovery are owned by Supabase Auth (`auth.users` schema). The application database stores zero passwords or password hashes.
- **Application Profile Separation**: Application-specific identities, role-based access control (RBAC), and account operational status are stored in the public schema (`public."user"`).
- **Prisma Scope**: Prisma manages and models the `public` schema tables. The internal `auth` schema is owned and maintained by Supabase, linked via database-level foreign keys.

---

## 2. Current Core Tables

All core application tables reside in the `public` schema.

### 2.1 `public.candidate`
- **Purpose**: Master table for candidate registrations and deployment tracking.
- **Primary Key**: `passport_id` (`TEXT`).
- **Important Columns**:
  - `passport_id` (`TEXT`): Primary passport number identifier (normalized uppercase).
  - `unique_id` (`TEXT`, `UNIQUE`): Sequential candidate business reference (e.g., `0001`, `0002`).
  - `nic` (`TEXT`, `UNIQUE`, nullable): National Identity Card number.
  - `first_name` (`TEXT`), `other_name` (`TEXT`, nullable): Full name attributes.
  - `date_of_birth` (`TIMESTAMPTZ`, nullable), `place_of_birth` (`TEXT`, nullable).
  - `passport_expiry_date` (`TIMESTAMPTZ`, nullable), `passport_issue_date` (`TIMESTAMPTZ`, nullable).
  - `whatsapp_number` (`TEXT`, nullable): WhatsApp phone number in E.164 format. A partial unique index (`candidate_whatsapp_number_key`) prevents duplicate registrations.
  - `contact_number` (`TEXT`, nullable), `address` (`TEXT`, nullable), `job` (`TEXT`, nullable), `job_experience` (`TEXT`, nullable).
  - `nationality` (`TEXT`, nullable), `sex` (`TEXT`, nullable: `M`, `F`, `X`).
  - `created_date` (`TIMESTAMPTZ`), `updated_date` (`TIMESTAMPTZ`).
- **Relationships**: One-to-many with `documents`, `candidate_stages`, `candidate_call_logs`, `temporary_data`; one-to-one (optional) with `candidate_additional_details`.
- **Triggers**: `candidate_sheet_sync_capture` captures changes into `sheet_sync_queue`.

### 2.2 `public."user"`
- **Purpose**: Staff members who access the Admin Console and execute operational actions.
- **Primary Key**: `admin_id` (`TEXT`, UUID).
- **Important Columns**:
  - `admin_id` (`TEXT`): Internal primary key.
  - `auth_user_id` (`UUID`, `UNIQUE`, `NOT NULL`): Foreign key referencing Supabase Auth `auth.users.id`.
  - `email` (`TEXT`, `UNIQUE`): Staff login email address.
  - `name` (`TEXT`): Display name.
  - `role` (`TEXT`): Application RBAC role (`ADMIN`, `MANAGER`, `ANALYST`, `REGISTRATION_DESK`).
  - `status` (`TEXT`): Account status (`ACTIVE`, `INACTIVE`, `INVITED`).
  - `created_date` (`TIMESTAMPTZ`), `updated_date` (`TIMESTAMPTZ`).
- **Relationships**: One-to-many with `audit_logs` (`admin_id`), one-to-many with `candidate_call_logs` (`admin_id`).

### 2.3 `public.documents`
- **Purpose**: Verified and stored documents filed into candidate folders (`clients/{passport_id}/{type}/`).
- **Primary Key**: `document_id` (`TEXT`).
- **Important Columns**:
  - `document_id` (`TEXT`): Unique document identifier.
  - `passport_id` (`TEXT`, FK -> `candidate.passport_id`): Candidate owner.
  - `document_type` (`TEXT`): Classification (`PASSPORT`, `POLICE_REPORT`, `POLICE_SLIP`, `MEDICAL`, `AFFIDAVIT`, `SKILL_VIDEO`).
  - `document_variant` (`TEXT`, nullable): Variant identifier (e.g., `SL_VERIFIED`, `ROMANIA`, `ENGLISH`, `SINHALA`).
  - `original_filename` (`TEXT`), `stored_filename` (`TEXT`), `storage_path` (`TEXT`).
  - `mime_type` (`TEXT`, nullable), `file_size` (`BIGINT`, nullable), `file_sha256` (`CHAR(64)`, nullable).
  - `processing_status` (`TEXT`), `verification_status` (`TEXT`: `VERIFIED`, `SUPERSEDED`, `REVIEW_REQUIRED`).
  - `ocr_confidence` (`DECIMAL`, nullable).
  - `temporary_id` (`TEXT`, nullable, FK -> `temporary_data.temporary_id` `ON DELETE SET NULL`).
  - `police_submitted_date` (`DATE`, nullable): The submission date for police clearance slips.
  - `received_date` (`TIMESTAMPTZ`), `created_date` (`TIMESTAMPTZ`), `updated_date` (`TIMESTAMPTZ`).
- **Constraints/Indexes**:
  - Unique constraint on `(passport_id, file_sha256)`.
  - Index on `file_sha256`, index on `temporary_id`.
- **Triggers**: Change capture trigger inserts queue events into `sheet_sync_queue`.

### 2.4 `public.candidate_stages`
- **Purpose**: Independent deployment workflow stage states for each candidate.
- **Primary Key**: Composite `(passport_id, stage)`.
- **Important Columns**:
  - `passport_id` (`TEXT`, FK -> `candidate.passport_id` `ON DELETE CASCADE`).
  - `stage` (`TEXT`): Stage code (`TEST_DETAILS`, `CANDIDATE_DETAILS`, `DOCUMENT_SUBMISSION`, `IVS_INTERVIEW`, `VISA_APPROVAL`, `FINALIZING_JOB`).
  - `completed` (`BOOLEAN`, default `false`).
  - `completed_at` (`TIMESTAMPTZ`, nullable).
  - `notes` (`TEXT`, nullable).
  - `job_id` (`TEXT`, nullable), `test_result` (`TEXT`, nullable), `test_date` (`DATE`, nullable) — used by `TEST_DETAILS`.
  - `updated_at` (`TIMESTAMPTZ`).
- **Triggers**: Change capture trigger inserts queue events into `sheet_sync_queue`.

### 2.5 `public.candidate_call_logs`
- **Purpose**: Communication history records with candidates.
- **Primary Key**: `call_log_id` (`TEXT`, UUID).
- **Important Columns**:
  - `passport_id` (`TEXT`, FK -> `candidate.passport_id` `ON DELETE CASCADE`).
  - `admin_id` (`TEXT`, FK -> `"user".admin_id` `ON DELETE RESTRICT`).
  - `note` (`TEXT`): Notes recorded during the telephone conversation.
  - `created_date` (`TIMESTAMPTZ`): Call timestamp.
- **Indexes**: `(passport_id, created_date)`.

### 2.6 `public.audit_logs`
- **Purpose**: Append-only security and operational audit trail for all admin actions, candidate modifications, document operations, and staff role adjustments.
- **Primary Key**: `audit_id` (`TEXT`, UUID).
- **Important Columns**:
  - `audit_id` (`TEXT`).
  - `admin_id` (`TEXT`, FK -> `"user".admin_id` `ON DELETE RESTRICT`).
  - `action` (`TEXT`): Action name (e.g., `CREATE_CANDIDATE`, `UPDATE_CANDIDATE`, `UPDATE_STAGE`, `APPROVE`, `UPDATE_USER_ROLE`).
  - `temporary_id` (`TEXT`, nullable), `document_id` (`TEXT`, nullable), `passport_id` (`TEXT`, nullable).
  - `previous_status` (`TEXT`), `new_status` (`TEXT`).
  - `reason` (`TEXT`, nullable).
  - `police_submitted_date` (`DATE`, nullable).
  - `document_type` (`TEXT`, nullable), `file_sha256` (`CHAR(64)`, nullable).
  - `previous_value` (`TEXT`, nullable), `new_value` (`TEXT`, nullable).
  - `created_date` (`TIMESTAMPTZ`, default `now()`).
- **Security & Immutability**: Protected by database trigger `audit_logs_reject_change()` rejecting all `UPDATE`, `DELETE`, and `TRUNCATE` operations.

### 2.7 `public.temporary_data`
- **Purpose**: Intake and pending review queue storage for documents received via WhatsApp or pending human review.
- **Primary Key**: `temporary_id` (`TEXT`, UUID).
- **Important Columns**:
  - `temporary_id` (`TEXT`).
  - `passport_id` (`TEXT`, nullable, FK -> `candidate.passport_id`).
  - `unique_id` (`TEXT`, nullable).
  - `whatsapp_number` (`TEXT`).
  - `document_type` (`TEXT`).
  - `temporary_storage_path` (`TEXT`), `pending_storage_path` (`TEXT`, nullable).
  - `processing_status` (`TEXT`).
  - `file_sha256` (`CHAR(64)`, nullable).
  - `processing_summary` (`JSONB`, nullable), `review_reason` (`TEXT`, nullable).
  - `message_id` (`TEXT`, `UNIQUE`, nullable): WhatsApp message ID.
  - `original_filename` (`TEXT`, nullable), `received_at` (`TIMESTAMPTZ`, nullable).
  - `processing_attempts` (`INT`, default `0`), `processing_started_at` (`TIMESTAMPTZ`, nullable), `placement_path` (`TEXT`, nullable).
- **Indexes**: `(whatsapp_number, file_sha256)`, `(processing_status, created_date)`.

### 2.8 `public.rate_limits`
- **Purpose**: Database-backed distributed rate limiting counters across serverless and worker instances.
- **Primary Key**: `key` (`TEXT`: `<limiter>:<sha256-of-identifier>`).
- **Columns**: `key` (`TEXT`), `hits` (`INT`), `reset_at` (`TIMESTAMPTZ(3)`).
- **Indexes**: `(reset_at)`.

### 2.9 `public.sheet_sync_queue`
- **Purpose**: Durable outbox queue tracking candidates that require synchronization to the Google Sheet operational mirror.
- **Primary Key**: `queue_id` (`TEXT`).
- **Important Columns**:
  - `queue_id` (`TEXT`, default `(gen_random_uuid())::text`).
  - `unique_id` (`TEXT`): Candidate business ID.
  - `status` (`TEXT`: `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`).
  - `candidate_deleted` (`BOOLEAN`, default `false`).
  - `attempts` (`INT`, default `0`), `next_attempt_at` (`TIMESTAMPTZ(3)`).
  - `lease_owner` (`TEXT`, nullable), `lease_expires_at` (`TIMESTAMPTZ(3)`, nullable).
  - `last_result` (`TEXT`, nullable), `last_error_class` (`TEXT`, nullable), `last_error_code` (`TEXT`, nullable).
  - `created_at`, `updated_at`, `completed_at`.
- **Indexes**: `(status, next_attempt_at)`, `(unique_id)`. Partial unique index ensures at most one `PENDING` queue row per candidate.

### 2.10 `public.sheet_sync_runs`
- **Purpose**: Audit and execution history for reconciliation batches ("Sync Now", Cloud Scheduler) and Test Connection operations.
- **Primary Key**: `run_id` (`TEXT`, UUID).
- **Important Columns**:
  - `run_id` (`TEXT`).
  - `kind` (`TEXT`: `RECONCILE`, `TEST_CONNECTION`).
  - `trigger_source` (`TEXT`: `ADMIN`, `SCHEDULER`, `OPERATOR`).
  - `requested_by` (`TEXT`, nullable).
  - `status` (`TEXT`: `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `SKIPPED`).
  - `dry_run` (`BOOLEAN`, nullable).
  - `attempts` (`INT`), `lease_owner` (`TEXT`, nullable), `lease_expires_at` (`TIMESTAMPTZ(3)`, nullable).
  - `summary` (`JSONB`, nullable: counts and codes only, no PII), `error_class` (`TEXT`, nullable), `error_code` (`TEXT`, nullable).
  - `created_at`, `started_at`, `finished_at`, `updated_at`.
- **Indexes**: `(kind, created_at)`, `(status)`.

### 2.11 `public.sheet_sync_state`
- **Purpose**: Singleton row (`state_id = 'sheet-sync'`) recording integration health, writer lease coordination, and worker heartbeat.
- **Primary Key**: `state_id` (`TEXT`).
- **Important Columns**:
  - `state_id` (`TEXT`, default `'sheet-sync'`).
  - `integration_state` (`TEXT`: `UNKNOWN`, `OK`, `CONFIG_ERROR`, `DATA_INTEGRITY`).
  - `last_error_class` (`TEXT`, nullable), `last_error_code` (`TEXT`, nullable), `last_error_at` (`TIMESTAMPTZ(3)`, nullable).
  - `last_sync_success_at` (`TIMESTAMPTZ(3)`, nullable).
  - `write_gate` (`TEXT`: `ENABLED`, `DISABLED`).
  - `configured` (`BOOLEAN`, nullable), `target_hint` (`TEXT`, nullable).
  - `worker_heartbeat_at` (`TIMESTAMPTZ(3)`, nullable).
  - `writer_lease_owner` (`TEXT`, nullable), `writer_lease_expires_at` (`TIMESTAMPTZ(3)`, nullable).
  - `updated_at` (`TIMESTAMPTZ(3)`).

### 2.12 `public.candidate_additional_details`
- **Purpose**: Extra details collected for a candidate in Admin > Candidates > **Additional Details**. Kept separate from `candidate`, which is never changed from that tab.
- **Primary Key**: `passport_id` (`TEXT`), which is also the foreign key to `candidate.passport_id` (`ON DELETE CASCADE ON UPDATE CASCADE`). This makes it one-to-one: a second row for the same candidate, or a row for a candidate that doesn't exist, is impossible.
- **Columns** (all nullable except the key and timestamps; details are collected over time):
  - `name_as_in_passport`, `permanent_address` (`TEXT`), `birthday` (`DATE`).
  - `tshirt_size` (`TEXT`: `XS`, `S`, `M`, `L`, `XL`, `XXL`), `pant_size`, `shoe_size` (`TEXT`: a preset or a short custom value).
  - `father_alive` (`BOOLEAN`), `father_full_name` (`TEXT`), `father_birthday` (`DATE`); `mother_alive`, `mother_full_name`, `mother_birthday` likewise.
  - `marital_status` (`TEXT`: `SINGLE`, `MARRIED`, `DIVORCED`, `WIDOWED`, `SEPARATED`), `wife_full_name` (`TEXT`), `wife_birthday` (`DATE`).
  - `child_1_name`, `child_2_name`, `child_3_name`, `other_job_skills` (`TEXT`).
  - `created_date` (`TIMESTAMP(3)`), `updated_date` (`TIMESTAMP(3)`).
- **Rules** (enforced by `src/services/candidateAdditionalDetailsService.js`, not by database constraints):
  - Father/mother details are kept only when that parent is alive, and the name is then required. The wife's details are kept only when married, and her name is then required.
  - Children are filled in order. Dates are real dates from 1900 up to today.
- **Security**: RLS enabled, all privileges revoked from `anon` and `authenticated`.
- **Not mirrored** to the Google Sheet (no change-capture trigger).

---

## 3. Candidate Table (`public.candidate`)

The candidate table represents job applicants and client records.

### 3.1 Historical Evolution
- **Historical Table Name**: `public.users` (renamed to `public.candidate` in migration `20261008120000_rename_candidate_user_tables`).
- The old name `users` is strictly historical. No active queries or services reference `public.users`.

### 3.2 Identity & Key Fields
- `passport_id`: Primary natural identifier. Cleaned and normalized to uppercase.
- `unique_id`: Unique business serial number (e.g., `0001`, `0002`).
- `nic`: Sri Lankan National Identity Card number; unique constraint prevents duplicate candidate registrations.
- `whatsapp_number`: Phone number used to match inbound document transmissions over WhatsApp.
- Personal attributes: `first_name`, `other_name`, `date_of_birth`, `place_of_birth`, `passport_expiry_date`, `passport_issue_date`, `nationality`, `sex`, `address`, `job`, `job_experience`.

### 3.3 Relationships
- `documents`: Stored and verified files belonging to this candidate.
- `candidate_stages`: Six deployment tracking stages (`TEST_DETAILS`, `CANDIDATE_DETAILS`, `DOCUMENT_SUBMISSION`, `IVS_INTERVIEW`, `VISA_APPROVAL`, `FINALIZING_JOB`).
- `candidate_call_logs`: Telephone call notes recorded by staff.
- `candidate_additional_details`: At most one row of extra details (passport name, sizes, family, other skills); see §2.12.
- `temporary_data`: Unprocessed or pending review items matched to this candidate.

---

## 4. Staff User Table (`public."user"`)

The staff user table represents console users (administrators, managers, analysts, registration desk officers).

### 4.1 Historical Evolution
- **Historical Table Name**: `public.admins` (renamed to `public."user"` in migration `20261008120000_rename_candidate_user_tables`).
- Because `user` is a reserved keyword in PostgreSQL, the table is named `"user"` with quotes in SQL statements, and mapped via `@@map("user")` in Prisma.

### 4.2 Attributes & Identity Link
- `admin_id` (`TEXT`, PK): Internal unique identifier.
- `auth_user_id` (`UUID`, `UNIQUE`, `NOT NULL`): Direct foreign key linking to `auth.users.id`.
- `email` (`TEXT`, `UNIQUE`): Email address of the staff member.
- `name` (`TEXT`): Staff member's display name.
- `role` (`TEXT`): Role governing RBAC permissions.
- `status` (`TEXT`): Operational state (`INVITED`, `ACTIVE`, `INACTIVE`).

### 4.3 Supported Roles
- `ADMIN`: Full access to all operations, user management, invitations, role modifications, audit logs, and settings.
- `MANAGER`: Full access to operational queues, candidate pool, documents, and reports; cannot manage users or settings.
- `ANALYST`: Operational review, document classification, candidate profile updates, call logs.
- `REGISTRATION_DESK`: Restricted to candidate registration, search, and detail viewing.

### 4.4 Authorization Mechanism
The staff role and status are **always queried from `public."user"` in the database on every HTTP request** by `requireActiveUser` middleware. Token claims are never used to determine role or active status, ensuring that role changes or account deactivations take effect immediately.

---

## 5. Supabase Auth Integration

Authentication is fully delegated to **Supabase Auth**.

### 5.1 Architecture Workflow
```
[Client Browser]
   │
   ├── 1. supabase.auth.signInWithPassword({ email, password })
   │      └──> [Supabase Auth] validates credentials in auth.users
   │      <─── returns access_token (JWT)
   │
   └── 2. Request to Backend with Header:
          Authorization: Bearer <access_token>
             │
             ▼
        [Express Middleware: requireActiveUser]
             │
             ├── 3. supabase.auth.getUser(token) -> verifies identity
             │      auth_user_id = identity.id
             │
             └── 4. SELECT * FROM public."user" WHERE auth_user_id = $1
                    Assert: status === 'ACTIVE'
                    Attach: req.user = { adminId, authUserId, email, name, role, status }
```

### 5.2 Legacy Auth Removal
- `password_hash` column was dropped from `"user"`.
- Legacy tables `admin_invitations` and `admin_password_resets` were dropped.
- Legacy custom JWT signing, bcrypt hashing, cookie sessions, and CSRF middleware are removed.
- Password reset, invitation acceptance, and login rate limiting are handled directly by Supabase Auth APIs.

---

## 6. Migration History

### 6.1 `20261008120000_rename_candidate_user_tables`
- Renamed `users` to `candidate`.
- Renamed `admins` to `"user"`.
- Updated constraint and index names (`users_pkey` -> `candidate_pkey`, `admins_pkey` -> `user_pkey`, etc.).
- Renamed Sheet Sync change-capture triggers:
  - `users_sheet_sync_capture` -> `candidate_sheet_sync_capture`
  - Function `sheet_sync_capture_candidate_child()` updated to read `FROM "candidate"`.
- Added nullable `auth_user_id` column to `"user"`.

### 6.2 `20261009120000_supabase_auth_cutover`
- Dropped legacy tables `admin_invitations` and `admin_password_resets`.
- Dropped `password_hash` column from `"user"`.
- Converted `"user".auth_user_id` to `UUID NOT NULL UNIQUE`.
- Added foreign key constraint:
  ```sql
  ALTER TABLE "user"
      ADD CONSTRAINT "user_auth_user_id_fkey"
      FOREIGN KEY ("auth_user_id") REFERENCES auth.users ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  ```
  *(Wrapped in conditional `to_regclass('auth.users') IS NOT NULL` for compatibility with test environments without an `auth` schema).*

Migrations 6.1 and 6.2 are applied and active on the shared database.

### 6.3 `20261009150000_candidate_additional_details`
- **Status**: committed, **not yet applied** to the shared database. Apply it through the normal migration deploy (`prisma migrate deploy`), never by hand.
- Additive only: creates `public.candidate_additional_details` and its foreign key to `candidate`. No existing table, column or row changes; existing candidates have no details row until one is saved.
- Enables RLS and revokes all privileges from `anon` and `authenticated` (SEC-001), like every other application table.
- Until it is applied, the Additional Details endpoints fail on that database (the table does not exist); everything else is unaffected.

---

## 7. Foreign Keys and Relationships

| Source Table / Column | Target Table / Column | Constraint Name | Action on Delete / Update |
| :--- | :--- | :--- | :--- |
| `public."user".auth_user_id` | `auth.users.id` | `user_auth_user_id_fkey` | `ON DELETE RESTRICT ON UPDATE CASCADE` |
| `public.documents.passport_id` | `public.candidate.passport_id` | `documents_passport_id_fkey` | `RESTRICT / CASCADE` |
| `public.documents.temporary_id`| `public.temporary_data.temporary_id` | `documents_temporary_id_fkey` | `ON DELETE SET NULL` |
| `public.candidate_stages.passport_id` | `public.candidate.passport_id` | `candidate_stages_passport_id_fkey` | `ON DELETE CASCADE` |
| `public.candidate_call_logs.passport_id` | `public.candidate.passport_id` | `candidate_call_logs_passport_id_fkey`| `ON DELETE CASCADE` |
| `public.candidate_call_logs.admin_id` | `public."user".admin_id` | `candidate_call_logs_admin_id_fkey` | `ON DELETE RESTRICT` |
| `public.candidate_additional_details.passport_id` (also its primary key) | `public.candidate.passport_id` | `candidate_additional_details_passport_id_fkey` | `ON DELETE CASCADE ON UPDATE CASCADE` |
| `public.audit_logs.admin_id` | `public."user".admin_id` | `audit_logs_admin_id_fkey` | `ON DELETE RESTRICT` |
| `public.temporary_data.passport_id` | `public.candidate.passport_id` | `temporary_data_passport_id_fkey` | `RESTRICT / CASCADE` |

*Note on `audit_logs` references*: In `audit_logs`, `passport_id`, `document_id`, and `temporary_id` are plain text identifiers without foreign key cascades, ensuring the audit history outlives deleted temporary rows or replaced documents.

---

## 8. Audit Log Architecture

The audit trail is implemented via `public.audit_logs`.

### 8.1 Immutability Enforcement
The table is append-only. Modifying or deleting audit records is forbidden by a PostgreSQL database trigger:
```sql
CREATE FUNCTION "audit_logs_reject_change"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_logs_no_update_delete"
    BEFORE UPDATE OR DELETE ON "audit_logs"
    FOR EACH ROW EXECUTE FUNCTION "audit_logs_reject_change"();

CREATE TRIGGER "audit_logs_no_truncate"
    BEFORE TRUNCATE ON "audit_logs"
    FOR EACH STATEMENT EXECUTE FUNCTION "audit_logs_reject_change"();
```

### 8.2 Logged Event Types
- **Candidate Lifecycle**: `CREATE_CANDIDATE`, `UPDATE_CANDIDATE`, `UPDATE_STAGE`, `CREATE_ADDITIONAL_DETAILS`, `UPDATE_ADDITIONAL_DETAILS` (only the changed fields, before and after; no row for a save that changes nothing).
- **Document Management**: `UPLOAD_DOCUMENT`, `REMOVE_DOCUMENT`, `REPLACE_VERIFIED`, `KEEP_AS_VERSION`, `DELETE_TEMPORARY_DOCUMENT`.
- **Review Queue Actions**: `APPROVE`, `KEEP_PENDING`, `REMOVE_FROM_REVIEW`, `SET_DOCUMENT_TYPE`, `ASSIGN_CLIENT`, `SET_POLICE_DATE`, `RETRY_PROCESSING`.
- **Staff User Lifecycle**: `INVITE_USER`, `REACTIVATE_USER`, `COMPLETE_INVITATION`, `UPDATE_USER_ROLE`, `DEACTIVATE_USER`.

Audit rows never record passwords, bearer tokens, session identifiers, or encryption keys.

---

## 9. Google Sheet Sync Database Integration

The Google Sheet operational mirror is driven by database triggers and an asynchronous worker.

### 9.1 Change Capture
1. Triggers on `candidate`, `candidate_stages`, and `documents` fire inside PostgreSQL transactions on `INSERT`, `UPDATE`, or `DELETE`.
2. The trigger executes `candidate_sheet_sync_capture()` / `sheet_sync_capture_candidate_child()`, inserting a row into `public.sheet_sync_queue`.
3. The queue row contains only `unique_id`, `status: 'PENDING'`, and `candidate_deleted`. It carries no PII.
4. When the background worker executes, it reads fresh candidate data from `public.candidate` and updates the Sheet row.

### 9.2 Operational Tables
- `sheet_sync_queue`: Coalescing queue.
- `sheet_sync_runs`: Durable execution records for reconciliation runs (`Sync Now`, automated cron).
- `sheet_sync_state`: Writer lease coordination and health heartbeats.

---

## 10. Prisma ORM Notes

- **Application Scope**: `prisma/schema.prisma` models all application-owned tables in the `public` schema.
- **Supabase Auth Boundary**: The `auth` schema (`auth.users`) is intentionally omitted from `prisma/schema.prisma` because it is owned by Supabase Auth migrations.
- **Cross-Schema Foreign Key (P4002)**: Because `public."user".auth_user_id` references `auth.users.id` in PostgreSQL, commands like `prisma db pull` may report advisory code `P4002`. This is expected. All runtime queries, `prisma migrate deploy`, `prisma migrate status`, `prisma validate`, and `prisma generate` operate normally. Do not add `auth` to Prisma schema models.

---

## 11. Security Rules

1. **Zero Credential Storage**: No passwords or password hashes exist in `public."user"` or anywhere in application tables.
2. **Server-Side Token Verification**: Every request to `/api/admin/*` verifies the Supabase access token with Supabase Auth.
3. **Database-Driven Authorization**: Account `status` (`ACTIVE`) and `role` are always verified against `public."user"` on every request.
4. **Key Segregation**: The Supabase Service Role Key (`SUPABASE_SERVICE_ROLE_KEY`) is stored strictly in server environment variables and never exposed to the frontend. The browser receives only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
5. **Immutable Audit Trail**: Database triggers prevent modification or purging of `audit_logs`.
6. **Least Privilege Database Access**: Row Level Security (RLS) is enabled on sensitive tables, revoking access from `anon` and `authenticated` roles and restricting direct access to the database connection pooler.

---

## 12. Current Database Naming Rules

| Entity | Current Authoritative Name | Historical Name (Obsolete) |
| :--- | :--- | :--- |
| Candidate Records | `public.candidate` (`Candidate` in Prisma) | `public.users` |
| Staff User Records| `public."user"` (`User` in Prisma) | `public.admins` |
| Primary Candidate ID | `passport_id` | `passport_id` |
| Primary Staff ID | `admin_id` | `admin_id` |
| Staff Auth Identity | `auth_user_id` | *(none - previously local password_hash)* |

Developers and contributors must never reintroduce `users` or `admins` table names into queries, migrations, or documentation.

---

## 13. Deployment & Migration Rules

1. **Deploy with Prisma Migrate**: Run `npx prisma migrate deploy` in staging and production CI/CD pipelines.
2. **Never Run `migrate dev` on Shared DB**: Never run `npx prisma migrate dev` against the shared Supabase test or production databases.
3. **Additive, Forward-Only Changes**: Database migrations must be forward-only and tested with the application test suite.
4. **Preserve Immutability Triggers**: Do not drop or bypass `audit_logs_reject_change()` triggers in migrations.
