# Phase 7 - Issues and Fixes

## 1. Low-Quality Passport PDF / Image

### Problem
Real company passport scans had low OCR confidence and were being classified as `UNDEFINED` or `UNKNOWN`.

### Cause
- Low-resolution WhatsApp images
- Weak OCR output
- MRZ characters sometimes misread
- Small images were sent directly to OCR without enough scaling

### Fix
- Added low-resolution image OCR fallback with 2x upscaling
- Improved OCR candidate selection
- Relaxed only the MRZ sex-character detection position for OCR mistakes
- Added passport-specific acceptance using:
  - valid MRZ
  - verified passport ID
  - DOB and expiry checks
  - `VERIFIED_MATCH`
  - no reconciliation conflicts

### Result
Low-quality passports can now be stored under the correct client as:

`CLIENT + REVIEW_REQUIRED`

while keeping the real measured OCR confidence.

---

## 2. Duplicate Document Handling

### Problem
The same document could be uploaded more than once.

### Fix
SHA-256 checksum comparison is used before permanent storage.

### Result
Same client + same file:

`DUPLICATE`

- no second permanent copy
- no new `documents` row

A different version of the same document is saved using versioning such as:

`passport_v2.pdf`

---

## 3. Police Slip and Police Report Were Mixed

### Problem
`POLICE_SLIP` and final `POLICE_REPORT` were treated as the same document type.

This caused final police reports to require a submitted/application date and go to pending storage.

### Fix
Separated the workflow into:

- `POLICE_SLIP`
- `POLICE_REPORT`

### Police Slip
- submitted/application date is required
- later used for the 21-day countdown
- unresolved date -> `MANUAL_REVIEW / PENDING`

### Police Report
- final police clearance document
- submitted date is not required
- correct client match -> permanent client storage
- later Phase 9 will mark the police workflow as completed and stop reminders

### Result
Real police-report PDF and JPEG tests successfully stored under:

`clients/{passport_id}/police-report/`

---

## 4. Medical Document Storage

### Problem
Medical storage behaviour needed to be confirmed.

### Result
Medical storage logic already supports:

- `VERIFIED` -> CLIENT
- `HIGH_CONFIDENCE` -> CLIENT
- `SLIGHTLY_UNCLEAR` -> CLIENT
- `UNCLEAR` -> CLIENT + `REVIEW_REQUIRED`
- `UNDEFINED` -> PENDING
- `NO_MATCH / AMBIGUOUS_MATCH` -> PENDING
- duplicate and cross-client conflict protection
- document versioning such as `medical_v2.pdf`

Medical documents are stored under:

`clients/{passport_id}/medical/`

---

## 5. UNCLEAR Review-Routing Security Gap

### Problem
A document in the `UNCLEAR` confidence band could enter a client folder even when it had another serious review reason.

Affected examples:
- passport with WhatsApp identity issue
- medical file with wrong-document suspicion
- police slip with missing/ambiguous date

### Fix
Added an explicit review-blocking signal before storage placement.

Review blockers include:
- identity review required
- wrong-document suspicion
- filename-only classification
- unclear police subtype
- unresolved police-slip date

### Result
Documents with an explicit review blocker now remain in:

`PENDING`

even when their confidence band is `UNCLEAR`.

Normal `UNCLEAR` documents with no extra blocker still use:

`CLIENT + REVIEW_REQUIRED`

---

## Final Phase 7 Status

Main permanent-storage workflows are now working for:

- Passport
- Police Slip
- Police Report
- Medical

Verified features include:

- OCR and classification
- client identity linking
- confidence-based routing
- duplicate detection
- cross-client conflict handling
- permanent and pending storage
- versioning
- review-required routing
- low-quality document handling

Real WhatsApp E2E tests were completed for passport and police-report flows.