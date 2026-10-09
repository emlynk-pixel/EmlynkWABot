# Database Design

Consolidates the original database setup log and seed-data document with the current live schema (`prisma/schema.prisma`). Superseded originals are kept in full in `Docs/archive/` (`01-initial-backend-database-setup.md`, `02-seed-data.md`).

## Overview

PostgreSQL 16, accessed through Prisma ORM (`@prisma/adapter-pg`). Locally: Docker Compose (`docker-compose.yml`, container `emlynk-postgres`, database `emlynk_docs`). In production: Supabase-hosted PostgreSQL, reached through the Supavisor **session-mode pooler** (see `08-cloud-deployment.md`, Step 2) rather than the direct host, because Cloud Run's default egress is IPv4-only and the direct host is IPv6-only.

```
Node.js Backend
      │
      ▼
Prisma ORM (@prisma/adapter-pg)
      │
      ▼
PostgreSQL (Docker locally / Supabase in production)
```

## Models

The core models are below (`prisma/schema.prisma`). The candidate stages, call logs and Google Sheet sync outbox tables (`candidate_stages`, `candidate_call_logs`, `sheet_sync_*`) are described in the documents for those features.

### User (`user`): staff accounts

The application's staff profile table (Prisma model `User`, table `public."user"`). It holds **no credentials**: authentication, passwords and sessions belong to Supabase Auth, which manages `auth.users`.

- `adminId`: the primary key (kept under this name; audit entries and call logs reference it).
- `authUserId` (`auth_user_id`): required, unique UUID that references `auth.users.id`. It links a staff profile to its Supabase Auth identity and is only ever taken from a verified Supabase session, never from a request body. The foreign key to `auth.users` (`ON DELETE RESTRICT`) is created by the migration where the `auth` schema exists (Supabase), so a profile can't outlive or be detached from its identity by accident.
- `email` (unique), `name`.
- `role`: `ADMIN`, `MANAGER`, `ANALYST` or `REGISTRATION_DESK`. The application's authorization source of truth; never read from a token or Supabase metadata.
- `status`: `INVITED` (invitation sent, password not yet set), `ACTIVE` or `INACTIVE`. Only `ACTIVE` users can use the API, checked on every request.

Relations: `auditLogs` (as the actor) and `callLogs`. There are no password hash, token, invitation or reset tables: invitations and password recovery are Supabase Auth's (`SUPABASE_AUTH.md`). Role and status rules: `10-security.md`.

### AuditLog (`audit_logs`)

Append-only record of admin review actions and user-management actions (`INVITE_USER`, `REACTIVATE_USER`, `COMPLETE_INVITATION`, `UPDATE_USER_ROLE`, `DEACTIVATE_USER`). **A database trigger rejects `UPDATE` and `DELETE` on this table** — it is genuinely immutable, not just convention. The reviewed item is referenced by plain IDs (`temporaryId`, `documentId`, `passportId`), without foreign keys, so the audit entry outlives the row it describes (e.g. Remove from Review deletes the `temporary_data` row, but its audit entry stays). `action` is one of `APPROVE`, `KEEP_PENDING`, `REMOVE_FROM_REVIEW`, `SET_DOCUMENT_TYPE`, `ASSIGN_CLIENT`, `SET_POLICE_DATE`, `RETRY_PROCESSING`. Indexed on `(temporaryId, createdDate)`, `(documentId, createdDate)`, `(adminId, createdDate)`.

### Candidate (`candidate`)

Registered clients (formerly named `User` / `users`; renamed so `User` means staff). `passportId` is the **primary key and the identity** — see the critical distinction below. `uniqueId` is a separate unique reference, never used in place of `passportId`. `whatsappNumber` is nullable and is a signal, not an identity (`05-ocr-document-processing.md`, Identity Verification). Fields such as `dateOfBirth`, `placeOfBirth` and `passportExpiryDate` are filled in only by the passport reconciliation logic, never overwritten once set.

### Document (`documents`)

One row per file permanently placed under `clients/`. `@@unique([passportId, fileSha256])` enforces the same-client-duplicate rule at the database level, not just in application logic. `verificationStatus` is `VERIFIED`, `REVIEW_REQUIRED` or `SUPERSEDED` (the last one from the admin dashboard's duplicate-verified-document policy, `09a-admin-dashboard-api.md`). `temporaryId` links back to the submission it was stored from (`onDelete: SetNull`, so removing the submission doesn't delete the permanent document). `policeSubmittedDate` is set only for police slips.

### TemporaryData (`temporary_data`)

Both the intake record **and** the durable background-job queue (`08-cloud-deployment.md`, Step 5). The webhook commits this row (`processingStatus = TEMPORARY_STORED`) before answering Meta; the background worker claims and processes it. `messageId` is unique, so a redelivered WhatsApp message never creates a second submission, even across restarts. `processingAttempts` and `processingStartedAt` are the worker's lease. `placementPath` records the object path an attempt was about to create *before* the copy, so a retry after a crash reuses that object instead of duplicating it. `processingSummary` (JSON) and `reviewReason` hold the PII-free result shown in the admin review queue. Indexed on `(whatsappNumber, fileSha256)` and `(processingStatus, createdDate)`.

### RateLimit (`rate_limits`)

Rate-limit counters shared by every app instance (added for the Vercel/Cloud Run split, `08-cloud-deployment.md`, Step 6). Operational state only — one row per limiter and client, reused when its window has passed, deleted once expired. `key = "<limiter>:<sha256 of the client key>"`, so no IP address is stored. Indexed on `resetAt` for cleanup.

## Critical Identifier Distinction

Three different IDs exist, and mixing them up would misattribute a client's documents:

| ID | Meaning | Rules |
|---|---|---|
| `passportId` | The client's passport number. Primary key of `Candidate`. **The identity.** | Never overwritten once set. Used for all document ownership and lookups. |
| `uniqueId` | A separate business reference (e.g. a legacy client number). | Unique, but never used in place of `passportId` for identity decisions. |
| `whatsappNumber` | The phone number a message arrived from. | A **signal**, not an identity — see `05-ocr-document-processing.md`, Identity Verification. Never used alone to attach a document to a client's permanent record. |

## Entity Relationships

```
auth.users 1──1 User         (Supabase identity <-> staff profile, via auth_user_id)
User  1──∞ AuditLog          (staff member performs many audited actions)
Candidate 1──∞ Document      (a client owns many permanent documents)
Candidate 1──∞ TemporaryData (a client submits many documents over time)
TemporaryData 1──∞ Document  (one submission can be the source of one placed document)
```

## Migration History

Applied with `prisma migrate deploy` (forward-only; the live production database has never been reset):

| Migration | What it did |
|---|---|
| `20260921064444_init_schema` | Initial four models: `Admin`, `User`, `Document`, `TemporaryData`. |
| `20260924130000_align_required_user_and_temporary_fields` | `users.first_name` and `temporary_data.whatsapp_number` set `NOT NULL`, matching the business rule that these are always required (a no-op on the live data, which already had no NULLs). `users.whatsapp_number` stays nullable. |
| `20260924130100_phase7_checksum_and_pending_storage` | Added `file_sha256` to both `documents` and `temporary_data`, and `pending_storage_path` to `temporary_data`; unique index `(documents.passport_id, file_sha256)`; supporting indexes. |
| `20260924140000_restrict_public_database_access` | Enabled RLS on every table with no policies, and revoked all privileges from Supabase's `anon`/`authenticated` roles, including on future tables (`ALTER DEFAULT PRIVILEGES`). The backend connects as the table owner, which bypasses RLS, so this only affects Supabase's own public API roles. |
| `20260925150000_phase10_review_data` | Added `processing_summary` and `review_reason` to `temporary_data` for the admin review queue. |
| `20260925160000_phase10_review_audit_log` | Added the `audit_logs` table, with its immutability trigger. |
| `20260925170000_phase10_police_submitted_date` | Added `police_submitted_date` to `documents`. |
| `20260926090000_phase10_audit_removal_details` | Added `document_type` and `file_sha256` to `audit_logs`, so a Remove-from-Review entry keeps what was removed. |
| `20260926120000_phase10_audit_correction_values` | Added `previous_value`/`new_value` to `audit_logs` for correction actions. |
| `20260927120000_m1_async_processing` | Added `message_id`, `original_filename`, `received_at`, `processing_attempts`, `processing_started_at` to `temporary_data` — the async worker's lease fields. |
| `20260927130000_m1_placement_path` | Added `placement_path` to `temporary_data`, for crash-safe retry of storage placement. |
| `20260928090000_phase12_admin_invitations` | Added the `admin_invitations` table. |
| `20260928100000_password_reset_tokens` | Added the `admin_password_resets` table. |
| `20260928130000_remove_redundant_token_indexes` | Removed a redundant explicit index that duplicated a `@unique` constraint's own index (AUDIT-005). |
| `20260930120000_phase12_rate_limits` | Added the `rate_limits` table. |
| `20261008120000_rename_candidate_user_tables` | Renamed the client table to `candidate` and the staff table to `user`; added `auth_user_id`. |
| `20261009120000_supabase_auth_cutover` | Dropped `admin_invitations`, `admin_password_resets` and `password_hash` (replaced by Supabase Auth); made `auth_user_id` required, with the foreign key to `auth.users`. Refuses to run while any staff row has no `auth_user_id`. |

The `admin_invitations` and `admin_password_resets` tables and the bcrypt `password_hash` column in the earlier rows are historical: the cutover migration removed them.

All new columns across these migrations were added nullable where existing rows had no value, with new code always setting them going forward — no migration has ever required backfilling or guessing a value for existing rows.

## Seed Data

A repeatable seed script (`prisma/seed.js`, run via `npx prisma db seed`) populates sample records for local development, using Prisma `upsert` so re-running it is safe (existing records are kept, not duplicated). Inspect the result with `npx prisma studio`. See `11-development-guide.md` for the full local setup sequence.

## Local Development Setup

```bash
docker compose up -d                    # starts emlynk-postgres (Docker Compose)
npx prisma migrate dev                  # applies migrations, generates the client
npx prisma db seed                      # optional sample data
npx prisma studio                       # inspect the database
```

`DATABASE_URL` for local Docker Postgres: `postgresql://emlynk_user:emlynk_password@localhost:5432/emlynk_docs`.
