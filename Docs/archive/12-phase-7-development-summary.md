# Phase 07 — Permanent Storage Development Summary

## 1. Objective

Phase 7 moves each processed WhatsApp document from its temporary upload into its proper place in the private Supabase bucket, and records it in the database (proposal §44 Phase 7: naming convention, object paths, private bucket, document records):

- documents from an identified client go into `clients/{passport_id}/…` with a standard name and a `documents` row,
- anything that must not be attached to a client automatically goes into `pending/…` for review,
- exact duplicates are detected with SHA-256 and not stored twice.

Design reference: `Docs/11-phase-7-permanent-storage.md`.

## 2. Starting State

Before Phase 7:

- Every accepted file was uploaded to `temporary/<uuid>.<ext>` and a `temporary_data` row was created (Phase 4).
- Phases 5 and 6 classified the document, scored its confidence, identified the client and reconciled passport fields, then updated `temporary_data`.
- Nothing ever left `temporary/`; the `documents` table was never written.
- Schema drift: the live database had `users.first_name` and `temporary_data.whatsapp_number` as `NOT NULL`, while the Prisma schema and migration history had them nullable.
- `schema.prisma` already contained the planned `file_sha256` fields (commit `1919ea1`) without a migration.

## 3. Database Changes

Two forward-only migrations, applied with `prisma migrate deploy`. No reset, no data changed.

| Migration | Contents |
|---|---|
| `20260924130000_align_required_user_and_temporary_fields` | `users.first_name SET NOT NULL`, `temporary_data.whatsapp_number SET NOT NULL`. A no-op on the live database (already `NOT NULL`, 0 NULL rows checked beforehand); it brings the migration history and `schema.prisma` in line with the senior business rule. `users.whatsapp_number` stays nullable. |
| `20260924130100_phase7_checksum_and_pending_storage` | `documents.file_sha256 CHAR(64)`, `temporary_data.file_sha256 CHAR(64)`, `temporary_data.pending_storage_path TEXT`; unique index `(documents.passport_id, file_sha256)`; index `documents.file_sha256`; index `(temporary_data.whatsapp_number, file_sha256)`. |

- All new columns are nullable (existing rows have no checksum); new code always sets the checksum.
- Checksum uniqueness is **client-scoped**, not global, so a file under another client is flagged rather than rejected by the database.
- After both migrations, `prisma migrate diff` between the live database and `schema.prisma` produces an empty migration (no drift).

## 4. Storage Architecture

| Area | Path | Contents |
|---|---|---|
| Temporary | `temporary/<uuid>.<ext>` | Every accepted upload. **Kept** in Phase 7; deleted in Phase 8. |
| Client | `clients/{passport_id}/passport/…`, `…/police-report/…`, `…/medical/…` | Documents from an identified client with confidence ≥ 40. |
| Pending (client known) | `pending/{unique_id}/undefined/uncleared-docs/…` | Undefined, manual-review or field-conflict documents from an identified client. |
| Pending (no client) | `pending/unidentified/{temporary_id}/undefined/uncleared-docs/…` | Unknown senders, provisional matches, identity conflicts, cross-client checksum conflicts. |

The bucket stays private; no public or signed URLs are created. WhatsApp numbers never appear in storage paths.

## 5. File Naming Rules

| Case | Name |
|---|---|
| Standard (VERIFIED / HIGH_CONFIDENCE / SLIGHTLY_UNCLEAR) | `passport.<ext>`, `police_report.<ext>`, `medical.<ext>`; later versions `_v2`, `_v3`, … |
| UNCLEAR | Sanitized original file name, `_2`, `_3` on collision |
| UNCLEAR photo without a name / nothing usable after sanitizing | `document_YYYYMMDD_HHMMSS.<ext>` |
| Pending | `document_YYYYMMDD_HHMMSS.<ext>`, `_2`, `_3` on collision |

- **Extension from the validated MIME type** (`.pdf`, `.jpeg`, `.png`); the sender's extension is discarded.
- **Sanitizing:** last path segment only, no `..`, no slashes or backslashes, no control characters, no leading dots, accents simplified, other characters replaced with `_`, maximum 100 characters.
- **No overwrite:** `exists()` before every `copy()`, and a copy reporting "already exists" moves on to the next name.
- Version = existing `documents` rows of that client and type + 1.
- Timestamps are UTC, from the WhatsApp message time (fallback: processing time).

## 6. SHA-256 and Duplicate Rules

- Calculated once in the webhook route after validation (`sha256Hex`, 64 lowercase hex characters), stored in `temporary_data.file_sha256` and `documents.file_sha256`, never logged.
- Checked after identity and **before reconciliation**, so duplicates and cross-client files never fill fields on a client's record.

| Case | Result |
|---|---|
| Same client, same checksum | `DUPLICATE` — no copy, no `documents` row, no `_v2`, temporary kept |
| Same checksum under a different client | `CONFLICT` — copied to `pending/unidentified/{temporary_id}/…`, no `documents` row, not linked |
| Different bytes (e.g. new photo of the same passport) | Normal new document / next version |
| Same sender, same checksum already in `pending/` | `DUPLICATE` — no second pending copy |
| Parallel request stored the same file first | Unique constraint (P2002) → copy removed → `DUPLICATE` |

## 7. Placement Decision Matrix

| Status | Storage destination | Renamed | `documents` row | `verification_status` | Temporary kept |
|---|---|---|---|---|---|
| `VERIFIED` | `clients/{passport_id}/{folder}/` | yes, standard | yes | `VERIFIED` | yes |
| `HIGH_CONFIDENCE` | `clients/{passport_id}/{folder}/` | yes, standard | yes | `VERIFIED` | yes |
| `SLIGHTLY_UNCLEAR` | `clients/{passport_id}/{folder}/` | yes, standard | yes | `VERIFIED` | yes |
| `UNCLEAR` | `clients/{passport_id}/{folder}/` (client identified), otherwise `pending/…` | no, sanitized original | yes (client) / no (pending) | `REVIEW_REQUIRED` | yes |
| `UNDEFINED` | `pending/…` | no, timestamp | no | — | yes |
| `MANUAL_REVIEW` | `pending/…` | no, timestamp | no | — | yes |
| `CONFLICT` | `pending/…` (`pending/unidentified/…` for identity or checksum conflicts) | no, timestamp | no | — | yes |
| `DUPLICATE` | none | — | no | — | yes |
| `FAILED` | none (a pending copy made before the failure is kept and recorded) | — | no (removed if its insert failed) | — | yes |

The four client bands require an identified, non-provisional client and a PASSPORT / POLICE_REPORT / MEDICAL type; otherwise the document goes to `pending/`.

## 8. Database Write Flow

```text
DUPLICATE_CHECK   documents lookups (same client, other clients)
RECONCILIATION    users updates only if the checksum is NEW
STORAGE           pending duplicate lookup → copy (client or pending)
                  → documents insert (client only)
                  → on insert failure: remove the copy
RECORD_UPDATE     temporary_data: type, status, link, pending_storage_path
```

- A failed `documents` insert removes the copy it just made; the temporary object is never touched.
- If the final `temporary_data` update fails, `FAILED` is written together with `pending_storage_path`.

## 9. Security and Privacy

- Private bucket; no public or signed URLs.
- No WhatsApp number in any storage path; `pending/` uses `unique_id` or the `temporary_id`.
- Extension from the validated MIME type; sender file names sanitized; IDs in paths restricted to `[A-Za-z0-9_-]`.
- Logs: the processing summary has a `storage` block with only outcomes and booleans (`checksum`, `placement`, `verificationStatus`, `documentStored`, `pendingCopy`). No paths, checksums, passport numbers, client references or phone numbers — covered by a test.
- Error messages from storage clean-up never include the path (it contains the passport number).
- Temporary objects retained until Phase 8.
- Tests use synthetic data and in-memory fakes for the database and bucket; they never reach Supabase.

## 10. Error Handling

| Failure | Handling |
|---|---|
| Storage copy fails | `FAILED` at stage `STORAGE`; no `documents` row; temporary kept |
| `documents` insert fails after copy | Copy removed; `FAILED` at `STORAGE`; if removal fails too, the error states "copy NOT removed" |
| Name already taken | Next version / suffix; gives up after 20 names |
| Missing source path | `placeDocument` refuses to run (clear error) |
| `temporary_data` update fails | `FAILED` recorded, with `pending_storage_path` if a pending copy exists |
| Any failure | Webhook still returns 200; the log line shows the stage |

## 11. Files Added / Changed

**Migrations and schema**

- `prisma/schema.prisma`
- `prisma/migrations/20260924130000_align_required_user_and_temporary_fields/migration.sql` (new)
- `prisma/migrations/20260924130100_phase7_checksum_and_pending_storage/migration.sql` (new)

**Source**

- `src/utils/fileChecksum.js` (new)
- `src/utils/storageNaming.js` (new)
- `src/services/documentChecksumService.js` (new)
- `src/services/permanentStorageService.js` (new)
- `src/services/clientDocumentService.js` (new)
- `src/services/storagePlacementService.js` (new)
- `src/services/documentProcessingService.js` (duplicate check and storage stages)
- `src/services/temporaryDataService.js` (checksum on create; `pendingStoragePath` updatable)
- `src/routes/whatsapp.js` (checksum, temporary path and message time passed to processing)

**Tests**

- `test/fileChecksum.test.js`, `test/temporaryData.test.js`, `test/documentChecksum.test.js`, `test/storageNaming.test.js`, `test/permanentStorage.test.js`, `test/clientDocument.test.js`, `test/storagePlacement.test.js` (new)
- `test/documentProcessing.test.js` (fake bucket always injected)
- `test/helpers/fakePrisma.js` (`document` model with client-scoped uniqueness, `not` conditions, `temporaryData.create/findFirst`)
- `test/helpers/fakeStorage.js` (new)

**Docs**

- `Docs/11-phase-7-permanent-storage.md` (updated to the implemented design)
- `Docs/12-phase-7-development-summary.md` (this file)

## 12. Automated Test Results

Actual output of the final validation run:

```text
Command: npm test
tests 366 | suites 69 | pass 360 | fail 0 | skipped 6

Command: RUN_OCR_TESTS=1 npm test   (Windows CMD: set RUN_OCR_TESTS=1 && npm test)
tests 366 | suites 69 | pass 366 | fail 0 | skipped 0
```

The 6 skipped tests in the first run are the opt-in real-OCR tests; they pass in the second run.

Other checks run: `node --check` on every changed source file; `npx prisma format`, `validate`, `generate`; `npx prisma migrate status` ("Database schema is up to date"); live-vs-schema `migrate diff` (empty migration); server smoke test (`/health` 200, unsigned webhook POST 401).

Phase 7 scenarios covered by passing tests:

- checksum utility (known SHA-256 value, determinism, 64 lowercase hex)
- checksum stored on `temporary_data`
- same file same client → `DUPLICATE`, no copy, no row, no client writes
- same checksum different client → `CONFLICT`, pending, no row for the wrong client, not linked
- standard passport, police report and medical permanent paths
- `_v2` / `_v3` versioning, and an existing object never overwritten
- UNCLEAR keeps the sanitized original name; photo without a name gets `document_YYYYMMDD_HHMMSS`
- path traversal, control characters and unsafe names sanitized; unsafe IDs refused
- UNDEFINED, MANUAL_REVIEW, identity conflict → pending
- `pending/{unique_id}` and `pending/unidentified/{temporary_id}` paths; no WhatsApp number in paths
- `pending_storage_path` saved, including after a late failure
- temporary object remains after permanent and pending copies
- `documents` row with `VERIFIED` / `REVIEW_REQUIRED`; UNDEFINED refused
- database failure after copy → copy removed; storage failure → no row
- parallel duplicate (P2002) → copy removed, `DUPLICATE`
- same sender re-sending a pending file → `DUPLICATE`
- no PII, paths or checksums in the loggable summary
- all real Prisma query shapes validated against the generated client (without a database connection)

## 13. Real Supabase Verification

**Database: verified.** Both migrations were applied to the live Supabase database; `migrate status` reports it up to date and the live schema matches `schema.prisma` exactly.

**Storage and end-to-end flow: not yet verified.** No WhatsApp test messages were sent and nothing was written to the live bucket during development. In particular, Supabase's response to copying onto an existing name (expected: 409 "already exists") is assumed from the client library; the code checks `exists()` first, so it does not rely on it.

Manual checklist, with controlled test data only:

| # | Test | Check |
|---|---|---|
| 1 | High-confidence passport from the client's own WhatsApp | `clients/{passport_id}/passport/passport.<ext>` exists; `documents` row with `VERIFIED`, `file_sha256`, `STORED`; `temporary_data.processing_status = VERIFIED`, `file_sha256` set; `temporary/…` still exists |
| 2 | Same passport file again | `temporary_data.processing_status = DUPLICATE`; no new object; no new row |
| 3 | New photo of the same passport | `passport_v2.<ext>`; second `documents` row |
| 4 | UNCLEAR document (low-quality photo of a known client's document) | Original (sanitized) name in the client folder; `verification_status = REVIEW_REQUIRED` |
| 5 | Unreadable / unknown document from an unknown number | `pending/unidentified/{temporary_id}/undefined/uncleared-docs/document_….<ext>`; `pending_storage_path` equals that path |
| 6 | Same file under a second test client (only if safe test clients exist) | `CONFLICT`; pending copy; no `documents` row for the second client |
| 7 | Bucket privacy | Opening an object URL without authentication fails; no public URL exists |

## 14. Git Checkpoints

| Commit | Message |
|---|---|
| `af3e1e9` | fix: align required user and temporary data fields with database |
| `50c4345` | feat: add Phase 7 checksum and pending storage schema |
| `5fb94da` | feat: add SHA-256 document checksum utility |
| `4dbd8c2` | feat: persist file checksums for temporary documents |
| `219f402` | feat: detect duplicate and cross-client document checksums |
| `71e9ef4` | feat: add safe permanent and pending storage path generation |
| `c99908f` | feat: add permanent and pending Supabase storage workflow |
| `17b284a` | feat: persist permanently stored documents metadata |
| `cb592a9` | feat: integrate Phase 7 permanent document placement |

Related earlier commits: `1919ea1` (Phase 7 design and checksum schema fields), `3df35e3` (first name compare-only in reconciliation).

## 15. Final Phase 7 Status

**PARTIALLY COMPLETE.**

Complete:

- all Phase 7 implementation (naming convention, object paths, private bucket usage, document records, checksum duplicates, pending storage)
- database migrations applied, no drift
- automated tests: 366/366 passing with OCR tests enabled

Remaining before Phase 7 can be marked COMPLETE:

- the manual Supabase checklist in section 13 (storage behaviour and end-to-end flow with controlled test data)

Deferred to Phase 8 by design: deleting temporary objects after finalization.
