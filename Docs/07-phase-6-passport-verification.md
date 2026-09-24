# Phase 6 — Passport Verification

## Overview

Phase 6 decides which client sent a document and compares passport data with that client's record.

Proposal reference: §6 (identifiers), §13 (User Identification Logic), §14 (Passport Verification and Reconciliation), §41 (business rules 1–10), §44 Phase 6.

Rules followed throughout:

- `users.passport_id` is the primary key and the identity.
- `users.unique_id` is a separate reference and is never used in place of `passport_id`.
- WhatsApp number is a signal, not an identity.
- Users are never merged. Stored WhatsApp numbers are never changed.
- Existing values are never overwritten.

## Flow

```text
Phase 5 result (document type, passport fields, field confidence)
        │
        ├── passport ID (if a passport) ──► findUsersByPassportId
        └── sender WhatsApp number ───────► findUsersByWhatsappNumber
        │
        ▼
decideIdentity ──► one of 7 statuses
        │
        ▼ (passport documents with a passport match)
reconcilePassportFields ──► matched / fill / conflict / skipped
        │
        ▼ (VERIFIED_MATCH only)
applyReconciliationUpdates ──► writes missing fields only
        │
        ▼
temporary_data: passport_id / unique_id linked when identity is resolved
```

## Main Files

| File | Purpose |
|---|---|
| `src/services/userLookupService.js` | Read-only Prisma lookups |
| `src/services/identityVerificationService.js` | Identity decision (§13) |
| `src/services/fieldReconciliationService.js` | Reconciliation matrix (§14) and safe updates |
| `src/utils/phoneNumber.js` | Phone number normalization for comparison |
| `src/utils/passportId.js` | Passport number normalization |
| `src/services/documentProcessingService.js` | Calls the above for each document |

## Passport ID Lookup

`findUsersByPassportId(passportId)`:

1. Normalizes the number: uppercase, no spaces, hyphens or `<`, 6–9 characters, at least one digit.
2. Invalid input returns `INVALID_INPUT` without querying.
3. Queries `users.passport_id` with an exact, case-insensitive match (in case legacy rows are lowercase).
4. Returns `FOUND`, `NOT_FOUND` or `MULTIPLE`.

A passport number with field confidence below 60 is not trusted for identity, even if it matches a user (`PASSPORT_ID_UNRESOLVED`).

## WhatsApp Lookup

`findUsersByWhatsappNumber(number)`:

- Numbers are compared as digits in international format without `+`.
- Rules (confirmed by the business):

  | Stored as | Compared as |
  |---|---|
  | `947XXXXXXXX` (Meta format) | kept |
  | `+947XXXXXXXX`, `+94 7X XXX XXXX`, `00947XXXXXXXX` | `947XXXXXXXX` |
  | `07XXXXXXXX` (local Sri Lankan mobile) | `947XXXXXXXX` |
  | `7XXXXXXXX` (9 digits; Excel dropped the leading zero) | `947XXXXXXXX` |
  | anything with another country code, landlines (`011…`) | digits only, nothing prepended |

- `94` is only added to local-format Sri Lankan mobile numbers. A number that already has a country code is never prefixed.
- `whatsapp_number` is not unique and its stored format varies, so the database is narrowed by the last 4 digits and the full normalized numbers are compared in code.
- Returns `FOUND`, `NOT_FOUND`, `MULTIPLE` or `INVALID_INPUT`.
- Stored numbers are never modified.

## Identity Decision Matrix

`decideIdentity()` returns `{ status, passportId, uniqueId, reviewRequired, provisional, notes, candidates }`. `candidates` hold only `passportId` and `uniqueId`, never names.

### Passport documents

| Proposal §13 | Passport lookup | WhatsApp lookup | Status | Review | Linked on temporary_data |
|---|---|---|---|---|---|
| A | user X | user X | `VERIFIED_MATCH` | no | yes |
| B | user X | user Y | `IDENTITY_CONFLICT` | yes | no |
| C | user X (has another WhatsApp) | none | `PASSPORT_MATCH_ONLY` + `WHATSAPP_DIFFERS` | yes | yes |
| E | user X (no WhatsApp on record) | none | `PASSPORT_MATCH_ONLY` + `WHATSAPP_NOT_ON_RECORD` | no | yes |
| D | none | user X | `WHATSAPP_MATCH_ONLY` (provisional) + `PASSPORT_NOT_IN_DATABASE` | yes | no |
| F | none | none | `NO_MATCH` | yes | no |
| G | unreadable / invalid / confidence < 60 | any | `PASSPORT_ID_UNRESOLVED` (WhatsApp user kept as provisional candidate) | yes | no |
| H | several | any, or any + several | `AMBIGUOUS_MATCH` | yes | no |

### Police and medical documents

These documents carry no passport, so the WhatsApp number is the only signal (§13: "Existing WhatsApp identity trusted?").

| WhatsApp lookup | Status | Review | Linked |
|---|---|---|---|
| one user | `WHATSAPP_MATCH_ONLY` | no | yes |
| several | `AMBIGUOUS_MATCH` | yes | no |
| none | `NO_MATCH` | yes | no |

"Linked" means `temporary_data.passport_id` and `unique_id` are set. This only happens for a single existing user (the foreign key requires it) and never for provisional matches.

## Conflict Handling

- `IDENTITY_CONFLICT`: nothing is merged, linked or written. Both candidate IDs are kept in the result for the reviewer. `processing_status = CONFLICT`.
- `WHATSAPP_DIFFERS`: the user's WhatsApp number is not changed. `processing_status = MANUAL_REVIEW`.
- `WHATSAPP_NOT_ON_RECORD`: the number is not filled in automatically (§13 E: only after identity is verified by a person).
- `AMBIGUOUS_MATCH`: no candidate is picked.

## Reconciliation Rules (§14)

`reconcilePassportFields()` compares the matched passport user's record with the extracted fields.

| DB value | Passport value | Outcome | Action |
|---|---|---|---|
| any | not extracted | `NOT_EXTRACTED` | none |
| existing | same | `MATCH` | none |
| missing | confidence ≥ 90 | `FILL` | update (if allowed, below) |
| existing | different, confidence ≥ 90 | `CONFLICT` | flag, never overwrite |
| missing or different | confidence < 90 | `LOW_CONFIDENCE` | nothing |

Comparison is by calendar day for dates, and case- and spacing-insensitive for text.

| Passport field | users column (legacy name) | Auto-fill |
|---|---|---|
| `dateOfBirth` | `date_of_birth` | yes |
| `placeOfBirth` | `place_of_birth` | yes |
| `passportExpiryDate` | `passport_expiry_date` | yes |
| `givenNames` | `first_name` (FIRST NAME) | yes |
| `surname` | `other_name` (OTHER NAME / surname) | yes |

`passport_id`, `unique_id` and `whatsapp_number` are never reconciled.

Writes (`applyReconciliationUpdates`):

- only for `VERIFIED_MATCH`
- one conditional update per column: `WHERE passport_id = ? AND <column> IS NULL`, so a value added in the meantime is never overwritten
- returns the columns actually written

The result lists (`matchedFields`, `missingFieldsFilled`, `conflicts`, `skipped`) contain field names and confidence only. `updates` contains values and is never logged.

## Security and Privacy

- Lookups and decisions log only statuses, notes and field names.
- Passport numbers, names, dates of birth and phone numbers are not logged.
- The loggable summary is covered by a test that checks for leaked values.

## Tests

| File | Covers |
|---|---|
| `test/userLookup.test.js` | Phone formats, passport lookup, lowercase legacy rows, `unique_id` not used, shared WhatsApp, same last 4 digits, no writes |
| `test/identityVerification.test.js` | Scenarios A–H, low-confidence passport number, police/medical documents, no names in results |
| `test/fieldReconciliation.test.js` | Same value, missing field, conflicting field, low confidence, names, never-reconciled columns, writes only for `VERIFIED_MATCH`, no overwrite race |
| `test/documentProcessing.test.js` | Verified passport, other client's WhatsApp, conflicting record value, unknown sender, failures |

Tests use an in-memory fake Prisma client (`test/helpers/fakePrisma.js`). The real query shapes were checked separately against the generated Prisma client.

## Current Limitations

- **Names** are filled exactly as printed on the passport (uppercase, e.g. `KAMAL NIMAL`). A record holding only part of the given names (e.g. `Kamal`) is reported as a conflict, not overwritten.
- **Phone numbers:** only Sri Lankan local mobile formats get `94`. Local landlines or other countries' local formats won't match Meta's international format.
- **Passport numbers stored with spaces** in legacy data won't match; legacy data should be normalized during migration.
- **Unsure passport matches:** a passport number between 60 and 89 confidence is used for lookup; a write still needs 90+ field confidence.
- **Conflict details** (which user, which field) are in the log line and the temporary record status, but there is no column for them. The admin view (Phase 10) will need them.
- **Duplicate document detection** (§31, checksum) is not part of Phase 6.

## Current Status

Implemented and tested: passport ID lookup, WhatsApp lookup, identity decisions A–H, conflict handling, reconciliation with safe updates, temporary record linking.
