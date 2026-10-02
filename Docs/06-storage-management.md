# Storage Management

Consolidates the Phase 7 permanent-storage design document and development summary, plus the Phase 7 storage-related fixes. Superseded originals are kept in full in `Docs/archive/` (`11-phase-7-permanent-storage.md`, `12-phase-7-development-summary.md`, `phase-7-issues-and-fixes.md`).

Proposal reference: §15, §16, §17, §18, §24, §25, §26, §31, §32, §44 Phase 7 (naming convention, object paths, private bucket, document records).

This document covers what happens to a document **after** OCR, classification and identity resolution (`05-ocr-document-processing.md`): moving it from its temporary upload into its proper place in the private Supabase bucket, and recording it in the database.

## Overview

- Documents from an identified client go into `clients/{passport_id}/…` with a standard name and a `documents` row.
- Anything that must not be attached to a client automatically goes into `pending/…` for review.
- Exact duplicates are detected with SHA-256 and not stored twice.
- The bucket stays private (§26): no public or signed URLs are created anywhere in this flow.
- The temporary object is **copied**, not moved; it is deleted only later, during finalization (a later phase, not yet built) — nothing in this document ever deletes a temporary or pending object.

## Storage Paths

```text
temporary/<uuid>.<ext>                                                   (unchanged since upload)
clients/{passport_id}/passport/passport.<ext>, passport_v2.<ext>, …
clients/{passport_id}/police-slip/police_slip.<ext>, …
clients/{passport_id}/police-report/police_report.<ext>, …
clients/{passport_id}/medical/medical.<ext>, …
pending/{unique_id}/undefined/uncleared-docs/document_YYYYMMDD_HHMMSS.<ext>
pending/unidentified/{temporary_id}/undefined/uncleared-docs/document_YYYYMMDD_HHMMSS.<ext>
```

- IDs used in paths must match `[A-Za-z0-9_-]+`; anything else is refused.
- The extension comes from the validated MIME type (`.pdf`, `.jpeg`, `.png`), never from the sender's file name.
- `pending/{unique_id}` is used only when identity resolution linked the document to exactly one existing, non-provisional client and the case is not a conflict between clients. Otherwise `pending/unidentified/{temporary_id}`.
- Timestamps are UTC and come from the WhatsApp message time, or the processing time if the message has none.
- No WhatsApp number ever appears in a storage path — `pending/` uses `unique_id` or the `temporary_id`, never the phone number.

## Placement Rules

Checked in order (`decidePlacement()` in `src/services/storagePlacementService.js`).

| # | Condition | Destination | Name | `documents` row | `processing_status` |
|---|---|---|---|---|---|
| — | Any exception during processing | none | — | no | `FAILED` |
| 1 | Same client already has this checksum | none | — | no | `DUPLICATE` |
| 2 | Another client has this checksum | `pending/unidentified/{temporary_id}/…` | timestamp | no | `CONFLICT` |
| 3 | Status `CONFLICT`, `UNDEFINED` or `MANUAL_REVIEW` | `pending/{unique_id or unidentified}/…` | timestamp | no | unchanged |
| 3a | A review reason is present (see below), whatever the band | `pending/{unique_id or unidentified}/…` | timestamp | no | unchanged (e.g. `UNCLEAR`) |
| 4 | Band `VERIFIED` / `HIGH_CONFIDENCE` / `SLIGHTLY_UNCLEAR` / `UNCLEAR`, client identified, type is PASSPORT / POLICE_SLIP / POLICE_REPORT / MEDICAL | `clients/{passport_id}/{folder}/` | standard (`UNCLEAR`: sanitized original) | yes | band name |
| 5 | Anything else (e.g. clear document, no identified client) | `pending/{unique_id or unidentified}/…` | timestamp | no | unchanged |

Before any pending copy: if the same sender's same checksum is **already stored in `pending/`** (an earlier `temporary_data` row with a `pending_storage_path`), the status is `DUPLICATE` and nothing is copied. An earlier attempt that never reached `pending/` does not count, so a failed upload can be sent again.

**Review reasons (rule 3a — fixed a real security gap).** A document in the `UNCLEAR` confidence band could originally enter a client folder even when it had another serious review reason (e.g. a passport with a WhatsApp identity issue, a medical file with wrong-document suspicion, a police slip with a missing/ambiguous date). The fix added an explicit review-blocking check before storage placement (`hasReviewBlocker()` in `documentProcessingService.js`): identity needs review (e.g. SEC-008 "no WhatsApp on record", or the record has another WhatsApp), `WRONG_DOCUMENT_SUSPECTED`, `CLASSIFIED_FROM_FILENAME_ONLY`, `POLICE_TYPE_UNCLEAR`, or a police slip whose date is `AMBIGUOUS` / `INVALID` / `NOT_FOUND`. A document with an explicit review blocker now stays in `pending/` even when its confidence band is `UNCLEAR`; a normal `UNCLEAR` document with no extra blocker still goes to `CLIENT + REVIEW_REQUIRED`.

Low confidence alone is not a review reason: a plain `UNCLEAR` document, and an accepted low-quality passport (`05-ocr-document-processing.md`, Passport Acceptance), still go to the client folder as `REVIEW_REQUIRED` — unless the client already has a `VERIFIED` document of that type, in which case it goes to `pending/` instead (a second one next to the verified one could never be approved automatically; see the admin dashboard's duplicate-verified-document policy).

"Client identified" means the identity result is `VERIFIED_MATCH`, `PASSPORT_MATCH_ONLY` or `WHATSAPP_MATCH_ONLY`, not provisional, with a passport ID.

### Confirmed working for all four document types

Medical document storage follows the same placement rules as the others: `VERIFIED`/`HIGH_CONFIDENCE`/`SLIGHTLY_UNCLEAR` → client folder, `UNCLEAR` → client folder + `REVIEW_REQUIRED`, `UNDEFINED` → pending, `NO_MATCH`/`AMBIGUOUS_MATCH` → pending — with the same duplicate detection, cross-client conflict protection and versioning (`medical_v2.pdf`) as passports and police documents. Medical documents are stored under `clients/{passport_id}/medical/`.

## Naming

- **Standard names:** `passport`, `police_slip`, `police_report`, `medical` + extension. Version = number of the client's existing `documents` rows of that type + 1 (`passport_v2.pdf`, `passport_v3.pdf`). If a name is already taken in storage, the next version is used.
- **`UNCLEAR`:** sanitized original file name — last path segment only, accents simplified, control characters removed, anything outside `[A-Za-z0-9._-]` replaced with `_`, no `..`, no leading dots, sender extension replaced by the MIME extension, at most 100 characters. If nothing usable remains (or the photo had no name): `document_YYYYMMDD_HHMMSS.<ext>`. Collisions get `_2`, `_3`, ….
- **Pending:** `document_YYYYMMDD_HHMMSS.<ext>`, with `_2`, `_3` on collision.
- **Never overwrite:** each name is checked with `exists()` before `copy()`, and a copy that reports "already exists" moves on to the next name. At most 20 names are tried.

## Checksum and Duplicates

- Calculated once in `src/routes/whatsapp.js` after validation: lowercase hex SHA-256 of the downloaded bytes (`src/utils/fileChecksum.js`). Stored in `temporary_data.file_sha256`, passed to `processDocument()`, stored in `documents.file_sha256`. Never logged.
- `documents`: unique on `(passport_id, file_sha256)` and indexed on `file_sha256` alone. Not globally unique, so a cross-client match is flagged instead of rejected.
- `temporary_data`: indexed on `(whatsapp_number, file_sha256)` for pending duplicates.
- The checksum check runs **after identity and before reconciliation**. A duplicate or cross-client file never fills fields on the client's `users` record.
- A new photo of the same paper has different bytes, so it is a new version, not a duplicate.
- A parallel request storing the same file first is caught by the unique constraint (P2002): the copy just made is removed and the result is `DUPLICATE`.

| Case | Result |
|---|---|
| Same client, same checksum | `DUPLICATE` — no copy, no `documents` row, no `_v2`, temporary kept |
| Same checksum under a different client | `CONFLICT` — copied to `pending/unidentified/{temporary_id}/…`, no `documents` row, not linked |
| Different bytes (e.g. a new photo of the same passport) | Normal new document / next version |
| Same sender, same checksum already in `pending/` | `DUPLICATE` — no second pending copy |
| Parallel request stored the same file first | Unique constraint (P2002) → copy removed → `DUPLICATE` |
| Same client already has a `VERIFIED` document of the type | The new copy waits in `pending/` for admin review instead of being auto-discarded — see the admin dashboard's duplicate-verified-document policy |

## Document Records

One row per file placed under `clients/`:

| Column | Value |
|---|---|
| `document_id` | new UUID |
| `passport_id` | identified client |
| `document_type` | `PASSPORT`, `POLICE_SLIP`, `POLICE_REPORT` or `MEDICAL` |
| `original_filename` | WhatsApp file name, or `document_YYYYMMDD_HHMMSS.<ext>` for photos |
| `stored_filename` / `storage_path` | final name and full `clients/…` path |
| `mime_type`, `file_size` | validated MIME type, byte count |
| `received_date` | WhatsApp message time (fallback: processing time) |
| `processing_status` | `STORED` (§24) |
| `verification_status` | `VERIFIED` for `VERIFIED`/`HIGH_CONFIDENCE`/`SLIGHTLY_UNCLEAR`; `REVIEW_REQUIRED` for `UNCLEAR` |
| `ocr_confidence` | document confidence, 0–100, two decimals |
| `file_sha256` | checksum |

`UNDEFINED` never creates a `documents` row.

## temporary_data

| Column | Set to |
|---|---|
| `file_sha256` | at creation |
| `processing_status` | final status (see `05-ocr-document-processing.md` for the full status list) |
| `passport_id`, `unique_id` | only when the client is identified and the file is not a cross-client conflict |
| `pending_storage_path` | exact pending object path when a pending copy is made; also kept if a later step fails |
| `temporary_storage_path` | unchanged (`temporary/…`), for later cleanup |

The permanent row for a temporary record can be found via `passport_id` + `file_sha256`.

## Order of Operations and Failures

```text
checksum checks → copy (permanent or pending) → documents row → temporary_data update
```

| Failure | Result |
|---|---|
| Storage copy fails | `FAILED`, stage `STORAGE`; no `documents` row; temporary object kept |
| `documents` insert fails after a copy | Copy removed again; `FAILED`, stage `STORAGE`; temporary object kept. If the removal also fails, the error says so (without the path). |
| Unique constraint (parallel duplicate) | Copy removed; `DUPLICATE` |
| Name already taken | Next version / suffix tried; gives up after 20 names |
| Missing source path | Placement refuses to run (clear error) |
| `temporary_data` update fails after a pending copy | `FAILED` is written together with `pending_storage_path`, so the copy stays traceable |

Nothing in this flow deletes a temporary object or anything in `pending/`.

## Security and Privacy

- Private bucket; no public or signed URLs.
- No WhatsApp number in any storage path.
- Extension from the validated MIME type; sender file names sanitized; IDs in paths restricted to `[A-Za-z0-9_-]`.
- Logs: the processing summary has a `storage` block with only outcomes and booleans (`checksum`, `placement`, `verificationStatus`, `documentStored`, `pendingCopy`). No paths, checksums, passport numbers, client references or phone numbers — covered by a test.
- Error messages from storage clean-up never include the path (it contains the passport number).

## Main Files

| File | Role |
|---|---|
| `src/utils/fileChecksum.js` | SHA-256 helper |
| `src/utils/storageNaming.js` | Paths, names, versions, sanitizing (pure) |
| `src/services/documentChecksumService.js` | Same-client / cross-client / pending duplicate lookups |
| `src/services/permanentStorageService.js` | Copy without overwrite; remove for rollback |
| `src/services/clientDocumentService.js` | Copy into `clients/…` + `documents` row + rollback |
| `src/services/storagePlacementService.js` | Placement rules and execution |
| `src/services/documentProcessingService.js` | `DUPLICATE_CHECK` and `STORAGE` stages |

## Tests

`test/fileChecksum.test.js`, `test/temporaryData.test.js`, `test/documentChecksum.test.js`, `test/storageNaming.test.js`, `test/permanentStorage.test.js`, `test/clientDocument.test.js`, `test/storagePlacement.test.js`, `test/documentProcessing.test.js` (fake bucket always injected). Tests use synthetic data and in-memory fakes for the database and bucket (`test/helpers/fakePrisma.js`, `test/helpers/fakeStorage.js`); they never reach Supabase.

Covered scenarios include: checksum utility (known SHA-256 value, determinism, 64 lowercase hex), same-client duplicate, cross-client conflict, standard permanent paths for all four types, `_v2`/`_v3` versioning with no overwrite, `UNCLEAR` sanitized naming, path traversal / control character / unsafe name sanitizing, unsafe IDs refused, pending placement for `UNDEFINED`/`MANUAL_REVIEW`/conflicts, `pending_storage_path` persistence including after a late failure, the temporary object remaining after permanent and pending copies, `documents` rows with the right `verification_status`, database/storage failure rollback, parallel-duplicate handling, and no PII/paths/checksums in the loggable summary.

## Known Limitations

- Deleting the temporary object after a document has a permanent home is not yet built (planned finalization step).
- The migrations that added `file_sha256` (both tables) and `pending_storage_path` are `20260924130000_align_required_user_and_temporary_fields` and `20260924130100_phase7_checksum_and_pending_storage` — see `03-database-design.md` for the full migration history.
