# Phase 7 — Permanent Storage (Design)

## Status

**Implemented.** This document is the design reference; `Docs/12-phase-7-development-summary.md` records how and when it was built, with test results.

| Item | State |
|---|---|
| Design decisions D1–D11 | Implemented |
| Schema: `file_sha256` (both tables), `pending_storage_path` | Migrated (`20260924130100_phase7_checksum_and_pending_storage`) |
| Required-field drift (`users.first_name`, `temporary_data.whatsapp_number`) | Resolved (`20260924130000_align_required_user_and_temporary_fields`) |
| Real Supabase verification | See Docs/12 |

Proposal reference: §15, §16, §17, §18, §24, §25, §26, §31, §32, §44 Phase 7 (naming convention, object paths, private bucket, document records).

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Temporary file | **Copied, not moved.** Deleted only in **Phase 8** finalization (§18). |
| D2 | Pending path identifier | **`unique_id`**, never the WhatsApp number. |
| D3 | No client can be named safely | **`pending/unidentified/{temporary_id}/…`** |
| D4 | `UNCLEAR` documents | Keep the **sanitized original filename** (§17). |
| D5 | Conflict and review documents | Go to **`pending/`**, never to `clients/`. |
| D6 | `documents.verification_status` | Only **`VERIFIED`** or **`REVIEW_REQUIRED`**. |
| D7 | Duplicate detection | **SHA-256**, stored on `documents` and `temporary_data`. |
| D8 | Same client, same file | **`DUPLICATE`**: no copy, no `documents` row, no new version. |
| D9 | Same file stored for another client | **`CONFLICT`**: copied to `pending/unidentified/…`, never attached to either client. |
| D10 | `DUPLICATE` storage | Nothing copied; the temporary copy is cleaned up in Phase 8. |
| D11 | Pending copy location | Stored exactly in **`temporary_data.pending_storage_path`**. |

Business rule (senior-confirmed, deviates from proposal §9.2/§9.4): `users.first_name` and `temporary_data.whatsapp_number` are `NOT NULL`. `users.whatsapp_number` stays nullable. `first_name` is compare-only in Phase 6 reconciliation.

## Storage Paths

The bucket stays private (§26). No public or signed URLs are created.

```text
temporary/<uuid>.<ext>                                                   (Phase 4, unchanged)
clients/{passport_id}/passport/passport.<ext>, passport_v2.<ext>, …
clients/{passport_id}/police-slip/police_slip.<ext>, …
clients/{passport_id}/police-report/police_report.<ext>, …
clients/{passport_id}/medical/medical.<ext>, …
pending/{unique_id}/undefined/uncleared-docs/document_YYYYMMDD_HHMMSS.<ext>
pending/unidentified/{temporary_id}/undefined/uncleared-docs/document_YYYYMMDD_HHMMSS.<ext>
```

- IDs used in paths must match `[A-Za-z0-9_-]+`; anything else is refused.
- The extension comes from the validated MIME type (`.pdf`, `.jpeg`, `.png`), never from the sender's file name.
- `pending/{unique_id}` is used only when Phase 6 linked the document to exactly one existing, non-provisional client and the case is not a conflict between clients. Otherwise `pending/unidentified/{temporary_id}`.
- Timestamps are UTC and come from the WhatsApp message time, or the processing time if the message has none.

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

**Review reasons (rule 3a).** Identity needs review (e.g. SEC-008 "no WhatsApp on record", or the record has another WhatsApp), `WRONG_DOCUMENT_SUSPECTED`, `CLASSIFIED_FROM_FILENAME_ONLY`, `POLICE_TYPE_UNCLEAR`, or a police slip whose date is `AMBIGUOUS` / `INVALID` / `NOT_FOUND` (`hasReviewBlocker()` in `documentProcessingService.js`). In the `UNCLEAR` band the processing status stays `UNCLEAR`, so without this rule such a document would have entered the client folder. Low confidence alone is not a review reason: a plain `UNCLEAR` document, and an accepted low-quality passport, still go to the client folder as `REVIEW_REQUIRED`.

"Client identified" means the Phase 6 identity is `VERIFIED_MATCH`, `PASSPORT_MATCH_ONLY` or `WHATSAPP_MATCH_ONLY`, not provisional, with a passport ID.

## Naming

- **Standard names:** `passport`, `police_slip`, `police_report`, `medical` + extension. Version = number of the client's existing `documents` rows of that type + 1 (`passport_v2.pdf`, `passport_v3.pdf`). If a name is already taken in storage, the next version is used.
- **`UNCLEAR`:** sanitized original file name: last path segment only, accents simplified, control characters removed, anything outside `[A-Za-z0-9._-]` replaced with `_`, no `..`, no leading dots, sender extension replaced by the MIME extension, at most 100 characters. If nothing usable remains (or the photo had no name): `document_YYYYMMDD_HHMMSS.<ext>`. Collisions get `_2`, `_3`, ….
- **Pending:** `document_YYYYMMDD_HHMMSS.<ext>`, with `_2`, `_3` on collision.
- **Never overwrite:** each name is checked with `exists()` before `copy()`, and a copy that reports "already exists" moves on to the next name. At most 20 names are tried.

## Checksum and Duplicates

- Calculated once in `src/routes/whatsapp.js` after validation: lowercase hex SHA-256 of the downloaded bytes (`src/utils/fileChecksum.js`). Stored in `temporary_data.file_sha256`, passed to `processDocument()`, stored in `documents.file_sha256`.
- `documents`: unique on `(passport_id, file_sha256)` and indexed on `file_sha256` alone. Not globally unique, so a cross-client match is flagged instead of rejected.
- `temporary_data`: indexed on `(whatsapp_number, file_sha256)` for pending duplicates.
- The checksum check runs **after identity and before reconciliation**. A duplicate or cross-client file never fills fields on the client's `users` record.
- A new photo of the same paper has different bytes, so it is a new version, not a duplicate.
- A parallel request storing the same file first is caught by the unique constraint (P2002): the copy just made is removed and the result is `DUPLICATE`.

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
| `processing_status` | final status (table above) |
| `passport_id`, `unique_id` | only when the client is identified and the file is not a cross-client conflict |
| `pending_storage_path` | exact pending object path when a pending copy is made; also kept if a later step fails |
| `temporary_storage_path` | unchanged (`temporary/…`), for Phase 8 cleanup |

Phase 8 can find the permanent row for a temporary record via `passport_id` + `file_sha256`.

## Order of Operations and Failures

```text
checksum checks → copy (permanent or pending) → documents row → temporary_data update
```

| Failure | Result |
|---|---|
| Storage copy fails | `FAILED`, stage `STORAGE`; no `documents` row; temporary object kept |
| `documents` insert fails after a copy | Copy removed again; `FAILED`, stage `STORAGE`; temporary object kept. If the removal also fails, the error says so (without the path). |
| Unique constraint (parallel duplicate) | Copy removed; `DUPLICATE` |
| `temporary_data` update fails after a pending copy | `FAILED` is written together with `pending_storage_path`, so the copy stays traceable |

Nothing in Phase 7 deletes a temporary object or anything in `pending/`.

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
