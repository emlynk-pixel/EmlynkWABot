# New feature updates

**Date:** 23 November 2026
**Applies to:** the admin dashboard (`admin/`), the backend (`src/`) and the database (`prisma/`)

This guide explains the changes made on 23 November 2026 in plain language: what changed, how to use it, and where the code lives.

| # | Feature | In one sentence |
|---|---|---|
| 1 | Audit Log report download | Download the audit log as an Excel or PDF file, containing only the records you filtered. |
| 2 | Faster audit log filters | New database indexes make the passport and date filters fast on a large log. |

---

## 1. Audit Log report download

### What you will notice
The **Audit Logs** page has a new **Download report** section under the filters, with two buttons: **Excel (.xlsx)** and **PDF**.

### How to use it
1. Open **Audit Logs** (Admin and Owner only, as before).
2. Set the filters you want. The download uses the filters that are applied on the page right now:
   - date range
   - user
   - action
   - passport number
   - candidate, category and search
3. Click **Excel (.xlsx)** or **PDF**. The button shows "Preparing…" while the file is built.
4. The file is saved as `audit-log-YYYY-MM-DD.xlsx` or `.pdf`.

With no filters selected, the file contains every audit record, the same set the page shows without filters.

### What the file contains
Date and time (Sri Lanka), action, stage or document type, performed by, role, **passport number**, unique ID, candidate, category, previous value, new value, previous and new status, police slip date, and reason or notes. Changed fields are listed one per line as `field: value`.

### Messages you may see
| Situation | Message |
|---|---|
| Start date is after the end date | "The start date must be on or before the end date." (checked in the browser first, then again on the server) |
| Nothing matches the filters | "No audit log records match the selected filters" |
| More than 50,000 records match | "…more than the 50,000 an export can hold. Narrow your filters (for example the date range) and try again." |
| A filter value is not valid | A short message naming the field, for example "Passport number must be a passport ID." |

### How it works (for developers)
- The filters are applied **on the backend**, not just in the browser. The server checks them with the same rules as the audit log list.
- The request is `POST /api/admin/audit-logs/export` with a JSON body. A POST is used so the **passport number never appears in a URL** (browser history or hosting access logs).
- Body: `{ "format": "xlsx" | "pdf", "adminId", "passportId", "candidate", "action", "category", "startDate", "endDate", "search" }`. Empty filters are left out.
- Only roles that can already open the audit log can use it (Admin and Owner). Other roles get 403, and no session gets 401.
- Large exports are safe: records are read in batches of 1,000 and streamed into the file, never all held in memory. The hard limit is 50,000 records.
- Excel cells that start with `=`, `+`, `-` or `@` get a leading apostrophe, so a value cannot run as a spreadsheet formula.
- Error messages never repeat the value you typed, so a passport number does not leak into an error.

### Good to know
- The PDF uses built-in fonts that only cover Western European characters. Other scripts (for example a name in Sinhala) print as `?` in the PDF. The Excel file does not have this limit.
- Passport number was already stored on candidate audit entries, shown in the table's Candidate column, and usable as a filter. No new column was needed.

### Where the code is
- [src/routes/admin.js](../../src/routes/admin.js) (the export route)
- [src/services/auditLogService.js](../../src/services/auditLogService.js) (validation, filters, batch reading)
- [src/services/auditLogExportWriters.js](../../src/services/auditLogExportWriters.js) (builds the Excel and PDF files)
- [admin/src/pages/AuditLogsPage.tsx](../../admin/src/pages/AuditLogsPage.tsx) (the Download report buttons)
- [admin/src/api/admin.ts](../../admin/src/api/admin.ts) and [admin/src/api/client.ts](../../admin/src/api/client.ts) (the request and file save)
- Tests: [test/auditLogExport.test.js](../../test/auditLogExport.test.js) and [admin/src/test/auditLogs.test.tsx](../../admin/src/test/auditLogs.test.tsx)

---

## 2. Faster audit log filters

### What you will notice
Nothing changes on screen. Filtering by passport number or date stays fast as the audit log grows.

### Why
Before, the passport and date filters had no index, so the database had to read the whole table. The passport filter is also case-insensitive, which a normal index cannot help with.

### What we changed
The passport filter first looks up the stored spelling of the passport number through an index, then filters on it. The results are the same as before. This also applies to the existing audit log list.

---

## Database migration

Run it like any other migration (`npx prisma migrate deploy`). It is safe: it only adds indexes. No column, row or trigger is changed, and **existing audit log records are untouched**.

**Folder:** [prisma/migrations/20261123120000_audit_log_export_indexes/](../../prisma/migrations/20261123120000_audit_log_export_indexes/migration.sql)

| Index | On | Used for |
|---|---|---|
| `audit_logs_created_date_idx` | `created_date` | The newest-first list and export, and date filters |
| `audit_logs_passport_id_created_date_idx` | `passport_id`, `created_date` | One candidate's entries, newest first |
| `audit_logs_passport_id_lower_idx` | `lower(passport_id)` | The case-insensitive passport filter |

Notes:
- The first two are declared in `prisma/schema.prisma`. The third exists in SQL only, because Prisma cannot describe an expression index (the project does the same for `job_type_name_lower_key`).
- The indexes are created without `CONCURRENTLY`, so writes to `audit_logs` wait while they build. This is fine at the current table size, but run the migration at a quiet time.
- It was checked only on a local test database, not on Supabase or production.

---

## New dependencies

Two packages were added to the backend (`package.json` and `package-lock.json`) to build the files on the server:

- `exceljs` for the Excel file
- `pdfkit` for the PDF file

**Vercel note:** `pdfkit` reads font files from disk, and Vercel may leave them out of the bundle. If a PDF download fails there with an `ENOENT` error, add `node_modules/pdfkit/js/data/**` to `includeFiles` for `api/index.js` in `vercel.json`.

---

## What was checked on candidate update logging

The audit log already records these candidate changes with the user, time, passport number, and old and new values, and skips saves where nothing changed: candidate details, stage, Additional Details, form field confirm or reject, final status, verification, allocation, and document changes.

These are **not changed or still not logged**:
- **OCR auto-fill** writes no audit entry. Logging it needs a non-login "system" user as the actor, which was postponed.
- **The phone normalisation script** writes no audit entry, because it has no admin to attribute the change to.
- **Candidate create and bulk import** log only the field names, not the values. This is deliberate and was kept.
- **Passport number changes:** the passport number is the candidate's primary key and no code changes it, so there is no old and new passport entry today.

---

## Tests
- Backend: `npm test` passed (2,722 pass, 0 fail) when the export was built. Two tests that build real Excel and PDF files only run once `exceljs` and `pdfkit` are installed.
- Admin: typecheck, 927 tests and the build all passed.
