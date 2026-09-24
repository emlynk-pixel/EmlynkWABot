# Phase 7 — Permanent Storage (Design)

## Status

**Design agreed. Not implemented yet.**

| Item | State |
|---|---|
| Design decisions | Agreed (this document) |
| `prisma/schema.prisma` checksum fields | Edited locally, **not committed** |
| Migration for the checksum fields | **Not created, not applied** |
| Application code | **No changes yet** |

Proposal reference: §15 (Document Naming and Storage), §16 (Undefined / Unclear Documents), §17 (confidence bands), §18 (Temporary Finalization Rules), §24 (state machine), §25 (Storage Architecture), §26 (Storage Security), §31 (Duplicate Document Handling), §32 (Error Handling), §44 Phase 7.

Phase 7 tasks in the proposal: naming convention, object paths, private bucket, document records.

## Current Flow (before Phase 7)

```text
WhatsApp → webhook → download → validate
   ↓
saveTemporaryFile()                 src/services/temporaryStorageService.js
   <SUPABASE_BUCKET>/temporary/<uuid>.<ext>
   ↓
createTemporaryDocumentRecord()     src/services/temporaryDataService.js
   temporary_data.temporary_storage_path = "temporary/<uuid>.<ext>"
   ↓
processDocument()                   src/services/documentProcessingService.js
   temporary_data: document_type, processing_status, passport_id, unique_id
```

- Every file stays in `temporary/` whatever its result.
- Nothing copies, moves or deletes storage objects.
- Nothing writes to the `documents` table.
- The confidence bands already carry `renameAllowed` and `storageArea` (`src/services/confidenceService.js`), unused until Phase 7.

## Agreed Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Temporary file | **Copied, not moved**, in Phase 7. Deleted only in **Phase 8** finalization, after everything succeeds (§18). |
| D2 | Pending path identifier | **`unique_id`**, never the mobile number. |
| D3 | No `unique_id` available | **`pending/unidentified/{temporary_id}/…`** |
| D4 | `UNCLEAR` documents | Keep the **original filename** (§17), with the safeguards below. |
| D5 | Conflict and review documents | Go to **`pending/`**, never to `clients/`. |
| D6 | `documents.verification_status` | Only **`VERIFIED`** or **`REVIEW_REQUIRED`**. No band names. |
| D7 | Duplicate detection | **SHA-256 checksum**, stored on both `documents` and `temporary_data`. |
| D8 | Same client, same file | Status **`DUPLICATE`**. No copy, no new `documents` row, no new version. |
| D9 | Same file already stored for another client | Status **`CONFLICT`**. Never attached to either client automatically. |

## Storage Paths

The bucket stays private (§26). No public URLs are created in Phase 7.

### Permanent (identified client)

```text
clients/{passport_id}/passport/passport.<ext>
clients/{passport_id}/passport/passport_v2.<ext>
clients/{passport_id}/police-report/police_report.<ext>
clients/{passport_id}/medical/medical.<ext>
clients/{passport_id}/other/…
```

- `passport_id` is the client's primary key (§15: "use the verified Passport ID rather than a mutable display name").
- The extension comes from the **validated MIME type** (`application/pdf` → `.pdf`, `image/jpeg` → `.jpeg`, `image/png` → `.png`), not from the sender's filename.

| Document type | Folder | Base name |
|---|---|---|
| `PASSPORT` | `passport` | `passport` |
| `POLICE_REPORT` | `police-report` | `police_report` |
| `MEDICAL` | `medical` | `medical` |
| `UNKNOWN` | `other` | — (in practice these are `UNDEFINED` and go to `pending/`) |

### Pending (undefined, conflict, review)

```text
pending/{unique_id}/undefined/uncleared-docs/document_YYYYMMDD_HHMMSS.<ext>
pending/unidentified/{temporary_id}/undefined/uncleared-docs/document_YYYYMMDD_HHMMSS.<ext>
```

- `{unique_id}` is used when the identity result points at exactly one client (D2).
- `unidentified/{temporary_id}` is used otherwise (D3): unknown sender, conflict between two clients, ambiguous match, unreadable passport. No candidate client is ever picked for the path.
- The subfolder follows §16, which lists "unrecognized, unclear, corrupted, unsupported, or conflicting documents" under `undefined/uncleared-docs/`.
- Files in `pending/` are **never deleted automatically** (§16).

## Placement Rules

Evaluated in order. The first matching rule decides.

| # | Condition | Destination | Renamed | `documents` row | `temporary_data.processing_status` |
|---|---|---|---|---|---|
| 1 | Processing failed earlier | none (stays in `temporary/`) | — | no | `FAILED` (unchanged) |
| 2 | Same client already has this checksum | none | — | no | `DUPLICATE` |
| 3 | Another client has this checksum | `pending/…` | no | no | `CONFLICT` |
| 4 | Identity conflict, or passport data contradicts the record | `pending/…` | no | no | `CONFLICT` |
| 5 | Band `UNDEFINED` (< 40) | `pending/…` | no | no | `UNDEFINED` |
| 6 | Review needed: identity needs review, wrong document suspected, police date unresolved (`MANUAL_REVIEW`) | `pending/…` | no | no | `MANUAL_REVIEW` |
| 7 | Band `UNCLEAR` (40–59), client identified | `clients/{passport_id}/{folder}/` | **no**, original filename | yes, `REVIEW_REQUIRED` | `UNCLEAR` |
| 8 | Band `VERIFIED` / `HIGH_CONFIDENCE` / `SLIGHTLY_UNCLEAR`, client identified | `clients/{passport_id}/{folder}/` | **yes**, standard name | yes, `VERIFIED` | unchanged band status |

"Client identified" means the Phase 6 identity result links to exactly one existing user and is not provisional (`VERIFIED_MATCH`, `PASSPORT_MATCH_ONLY` without review, `WHATSAPP_MATCH_ONLY` for police/medical documents). Only these can have a `documents` row, because `documents.passport_id` is required.

**Clarification on `DUPLICATE` (rule 2):** the file already exists in permanent storage, so nothing is copied anywhere (§31: "avoid creating unnecessary duplicate records"). The temporary copy stays until Phase 8 cleanup.

## Naming

### Standard names (rule 8)

- First document of a type: `passport.<ext>`
- Later versions: `passport_v2.<ext>`, `passport_v3.<ext>`, … (§15)
- Version number = existing `documents` rows for the same `passport_id` and `document_type` + 1.
- A different photo of the same paper has a different checksum, so it's a new version, not a duplicate.

### Original filenames for `UNCLEAR` (rule 7)

1. **Keep the original filename** as sent on WhatsApp.
2. **Sanitize path-dangerous characters:** remove directory parts and characters such as `/`, `\`, `..`, control characters, and anything Supabase storage keys don't accept. The result must be a single safe file name.
3. **Fallback for photos with no filename:** WhatsApp photos (`type: "image"`) have no filename. Use a generated name, e.g. `whatsapp-image_YYYYMMDD_HHMMSS.<ext>`.
4. **Never overwrite:** uploads use `upsert: false`. If the name already exists in the folder, add a numeric suffix before the extension: `scan.pdf` → `scan_2.pdf` → `scan_3.pdf`.

The unmodified original filename is also stored in `documents.original_filename`.

### Pending names

`document_YYYYMMDD_HHMMSS.<ext>` (§16 example), with the same numeric-suffix rule on collision.

## Checksum and Duplicate Detection

### Fields

Added to `prisma/schema.prisma` (local edit, migration pending):

```prisma
model Document {
  // …
  fileSha256 String? @map("file_sha256") @db.Char(64)

  @@unique([passportId, fileSha256])
  @@index([fileSha256])
}

model TemporaryData {
  // …
  fileSha256 String? @map("file_sha256") @db.Char(64)

  @@index([whatsappNumber, fileSha256])
}
```

- Value: lowercase hexadecimal SHA-256 of the downloaded file bytes, 64 characters.
- Nullable so the migration can't fail on existing rows. New code always sets it.
- **Unique per client, not globally.** A global unique rule would make the database reject a cross-client match instead of letting it be flagged for review (business rule 7). The separate `fileSha256` index answers "does any client have this file?".

### Where it's calculated

Once, in `src/routes/whatsapp.js`, right after `downloadWhatsappMedia()` and file validation, before `saveTemporaryFile()`. It is saved on the new `temporary_data` row and passed to `processDocument()`.

Our own hash of the downloaded bytes is authoritative. Meta's `sha256` field in the webhook payload is not used as the stored value.

### Detection order (before any copy)

```text
1. Can the document go to a client folder? (placement rules 7–8)
     no  → check temporary_data for an earlier row with the same
           whatsapp_number + file_sha256 → if found: DUPLICATE
     yes ↓
2. documents WHERE passport_id = X AND file_sha256 = H   → found: DUPLICATE (D8)
3. documents WHERE file_sha256 = H AND passport_id <> X  → found: CONFLICT (D9)
4. Copy to clients/X/…, then create the documents row.
   Unique-constraint error (Prisma P2002) on create → a parallel request
   stored it first → treat as DUPLICATE and delete the copy just made.
```

Checking before copying means duplicates never leave extra objects in storage.

## Document Records

One `documents` row per file placed under `clients/` (rules 7 and 8):

| Column | Value |
|---|---|
| `document_id` | new UUID |
| `passport_id` | identified client |
| `document_type` | `PASSPORT`, `POLICE_REPORT` or `MEDICAL` |
| `original_filename` | WhatsApp filename, or the photo fallback name |
| `stored_filename` | standard name (rule 8) or sanitized original name (rule 7) |
| `storage_path` | full `clients/…` path |
| `mime_type` | validated MIME type |
| `file_size` | size in bytes |
| `received_date` | WhatsApp message timestamp, or `temporary_data.created_date` |
| `processing_status` | `STORED` (§24: `VERIFIED → STORED`) |
| `verification_status` | see mapping below |
| `ocr_confidence` | document confidence, **0–100** scale (same as the rest of the system) |
| `file_sha256` | checksum |

### `verification_status` mapping (D6)

| Confidence band | `verification_status` |
|---|---|
| `VERIFIED` (> 95) | `VERIFIED` |
| `HIGH_CONFIDENCE` (90–95) | `VERIFIED` |
| `SLIGHTLY_UNCLEAR` (60–89) | `VERIFIED` |
| `UNCLEAR` (40–59) | `REVIEW_REQUIRED` |
| `UNDEFINED` (< 40) | — (goes to `pending/`, no `documents` row) |

The `SLIGHTLY_UNCLEAR` warning from §17 is not visible in `verification_status`. It remains visible through `documents.ocr_confidence` and `temporary_data.processing_status`.

## temporary_data During Phase 7

- `temporary_storage_path` **keeps pointing at `temporary/…`**, because Phase 8 needs it to delete the temporary copy (D1).
- `processing_status` is set according to the placement rules table.
- `file_sha256` is set when the row is created.
- Phase 8 can find the permanent record of a temporary row through `passport_id` + `file_sha256`, so no extra link column is needed.

## Failure Handling

Order of operations for a permanent document: **duplicate checks → copy → create `documents` row → update `temporary_data`.**

| Failure | Handling |
|---|---|
| Storage copy fails | No `documents` row. Temporary file and row untouched. `processing_status = FAILED`, stage `STORAGE` (§32: "Storage failure → do not finalize"). Webhook still returns 200. |
| `documents` insert fails after the copy | Delete the object just copied, so no orphan is left. If that delete also fails, log the path (no personal data). Temporary file untouched, so a retry is safe. |
| Unique-constraint error on insert | Parallel request stored the same file → `DUPLICATE`; delete the copy just made. |
| Name collision on copy (`upsert: false`) | Try the next version number (rule 8) or numeric suffix (rule 7 and pending). |
| `temporary_data` update fails | The permanent copy and `documents` row are valid. Log the stage; Phase 8 can recover the link through `passport_id` + `file_sha256`. |

Nothing in Phase 7 deletes a temporary file or anything in `pending/`.

## Edge Cases

| Case | Handling |
|---|---|
| Same WhatsApp message processed twice (Meta retry) | Checksum check → `DUPLICATE`; unique constraint catches a race. |
| Same file sent again by the same client | `DUPLICATE` (D8). |
| Same file sent by another client | `CONFLICT` (D9), copied to `pending/…`. |
| New photo of an already stored document | New checksum → next version (`_v2`). |
| Unknown sender | `pending/unidentified/{temporary_id}/…`. |
| Conflict between two clients | `pending/unidentified/{temporary_id}/…`, `CONFLICT`. |
| Unreadable / corrupt / unknown document | `pending/…`, `UNDEFINED`. |
| `UNCLEAR` photo with no filename | Fallback name `whatsapp-image_YYYYMMDD_HHMMSS.<ext>`. |
| Orphaned objects | Prevented by the order of operations and the clean-up step; a later storage-vs-database check can find any that remain. |

## Schema and Migration Plan

The schema edit is local and uncommitted. **No migration has been created or applied.**

Expected migration SQL (only adds columns and indexes):

```sql
ALTER TABLE "documents" ADD COLUMN "file_sha256" CHAR(64);
CREATE UNIQUE INDEX "documents_passport_id_file_sha256_key" ON "documents"("passport_id", "file_sha256");
CREATE INDEX "documents_file_sha256_idx" ON "documents"("file_sha256");

ALTER TABLE "temporary_data" ADD COLUMN "file_sha256" CHAR(64);
CREATE INDEX "temporary_data_whatsapp_number_file_sha256_idx" ON "temporary_data"("whatsapp_number", "file_sha256");
```

Steps when approved:

1. `npx prisma migrate status` — confirm no drift.
2. Create the migration file without applying it (`npx prisma migrate dev --create-only --name add_file_sha256`, using a local shadow database if Supabase refuses to create one). **Never run `migrate dev` or `migrate reset` against the shared Supabase database.**
3. Review the generated SQL against the block above.
4. Apply with `npx prisma migrate deploy`.
5. `npx prisma generate`.
6. `npx prisma migrate status` again.
7. Commit the schema and the new migration folder together.

## Files to Change During Implementation

| File | Change |
|---|---|
| `prisma/schema.prisma` + new migration | Checksum fields (edited, migration pending) |
| `src/utils/fileChecksum.js` (new) | SHA-256 of a buffer |
| `src/routes/whatsapp.js` | Calculate the checksum after validation; pass it on |
| `src/services/temporaryDataService.js` | Save `file_sha256`; status updates |
| `src/services/storagePlacementService.js` (new) | Placement rules (pure logic) |
| `src/utils/storageNaming.js` (new) | Folders, standard names, versions, filename sanitizing, fallback, suffixes, pending names |
| `src/services/permanentStorageService.js` (new) | Supabase copy / remove helpers, no overwrite |
| `src/services/documentRecordService.js` (new) | Checksum lookups, version count, `documents` insert, P2002 handling |
| `src/services/documentProcessingService.js` | New `STORAGE` stage |
| `test/helpers/fakePrisma.js`, new fake storage helper, new tests | Unit and integration tests |

## Implementation Checkpoints

1. **7.1** Checksum helper + route calculation + `temporary_data.file_sha256` (after the migration is applied).
2. **7.2** Naming utilities (folders, versions, sanitizing, fallback, suffixes).
3. **7.3** Placement rules (pure function, every band × identity × duplicate case).
4. **7.4** Storage copy/remove helpers.
5. **7.5** Document records, duplicate checks, verification-status mapping.
6. **7.6** `STORAGE` stage in `processDocument()` with failure handling.
7. **7.7** Manual tests on real Supabase, including private-bucket access checks (§43.6).
8. **7.8** Update this document from "design" to "implemented".

## Open Item

**Recording where a `pending/` copy was placed.** `temporary_storage_path` must keep the `temporary/` path for Phase 8 (D1), and `documents` has no row for pending files, so the `pending/` path is currently stored nowhere. A reviewer needs to find it. Options to decide before checkpoint 7.6:

- **A.** Add a nullable `temporary_data.pending_storage_path` column in the same checksum migration.
- **B.** Make pending paths predictable from the record, e.g. include the `temporary_id` in the file name: `document_YYYYMMDD_HHMMSS_{temporary_id}.<ext>`.
