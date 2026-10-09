# OCR and Document Processing

Consolidates the original OCR/classification overview, the Phase 5 (Classification and OCR) and Phase 6 (Passport Verification) technical documents, and the Phase 7 fixes that changed OCR/classification behavior. Superseded originals are kept in full in `Docs/archive/` (`06-phase-5-classification-ocr.md`, `07-phase-6-passport-verification.md`, `10-phase-5-6-development-summary.md`, `phase-7-issues-and-fixes.md`).

Proposal reference: §12 (Passport Processing), §13 (User Identification Logic), §14 (Passport Verification and Reconciliation), §17 (confidence bands), §20 (Police Report Slip Processing), §32 (error handling), §41 (business rules 1–10).

Document rename, permanent/pending storage placement and the police-slip 21-day countdown are described in `06-storage-management.md`; this document covers reading a document and deciding whose it is and how reliable that reading was.

## Overview

The document is responsible for turning a stored WhatsApp document into structured, scored information:

- what kind of document it is (passport, police slip, final police report, medical, unknown)
- how reliably its text was read
- which client (if any) sent it, and whether their record agrees with the document
- for passports: the passport fields
- for police slips only: the submitted/application date (a final police report needs no date)

The document filename is **not** treated as the source of truth — a user may upload a passport saved as `6325523527323.pdf`, so the actual content is always analyzed.

## Flow

```text
temporary_data row created (UNCLASSIFIED / TEMPORARY_STORED)
        │
        ▼
Text extraction ─────────────── ocrService.extractDocumentText
   PDF with text layer  → PDF_TEXT
   PDF without text     → render first 3 pages → Tesseract → PDF_OCR
   PDF that can't parse → PDF_PARSE_FAILED (no OCR attempted)
   JPEG / PNG           → Tesseract → OCR
        │
        ▼
Content classification ──────── documentClassificationService
   filename hint (low trust) + content indicators → resolved type
        │
        ▼
Confidence ──────────────────── confidenceService
   extraction + classification → document confidence → band + flags
        │
        ├── PASSPORT      → passportExtractionService (fields + field confidence)
        └── POLICE_SLIP → policeReportDateService (date); POLICE_REPORT needs no date
        │
        ▼
Identity ─────────────────────── userLookupService + identityVerificationService
   passport ID (if a passport) ──► findUsersByPassportId
   sender WhatsApp number ───────► findUsersByWhatsappNumber
        │
        ▼
decideIdentity ──► one of 8 statuses (see Identity Decision Matrix)
        │
        ▼ (passport documents with a passport match)
reconcilePassportFields ──► matched / fill / conflict / skipped
        │
        ▼ (VERIFIED_MATCH only)
applyReconciliationUpdates ──► writes missing fields only
        │
        ▼
temporary_data updated (document_type, processing_status, passport_id/unique_id when resolved)
        │
        ▼
Storage placement (06-storage-management.md)
```

Orchestration lives in `src/services/documentProcessingService.js` and is called once from `src/routes/whatsapp.js`'s background worker after the temporary record is created.

## Main Files

| File | Purpose |
|---|---|
| `src/services/ocrService.js` | PDF text layer, scanned-PDF OCR, image OCR |
| `src/services/documentClassificationService.js` | Filename hint, content classification, final type |
| `src/services/confidenceService.js` | Confidence bands and the three confidence values |
| `src/services/passportExtractionService.js` | Passport field extraction |
| `src/services/policeReportDateService.js` | Police report date extraction |
| `src/services/userLookupService.js` | Read-only Prisma lookups (passport ID, WhatsApp number) |
| `src/services/identityVerificationService.js` | Identity decision (§13) |
| `src/services/fieldReconciliationService.js` | Reconciliation matrix (§14) and safe updates |
| `src/services/documentProcessingService.js` | Runs the whole flow above for one document |
| `src/utils/mrz.js` | MRZ detection, parsing, ICAO check digits |
| `src/utils/dateParsing.js` | Date formats and calendar validation |
| `src/utils/passportId.js` | Canonical passport number format |
| `src/utils/documentText.js` | Text normalization for keyword matching |
| `src/utils/phoneNumber.js` | Phone number normalization for comparison |
| `src/utils/fileValidation.js` | MIME and file-size validation, before processing starts |

Scanned-PDF rendering uses `pdf-parse`'s `getScreenshot()`, which relies on `@napi-rs/canvas`.

## File Validation

Before OCR processing, the backend validates the incoming file: MIME type (`application/pdf`, `image/jpeg`, `image/png`) and file size. Invalid or unsupported files are rejected from the pipeline before storage or OCR.

## Filename Hint

The filename is checked for keywords before OCR runs, as a low-trust hint only:

```text
passport.pdf         → PASSPORT
police_clearance.pdf → POLICE_REPORT
medical.pdf          → MEDICAL
6325523527323.pdf    → UNKNOWN
```

It is used as the final type only when there is no readable text at all (`source: "FILENAME"`), and then with confidence fixed at 30 so the document always needs review. A filename that disagrees with the content sets `filenameMismatch` and the flag `WRONG_DOCUMENT_SUSPECTED` — content always wins.

## Text Extraction

| Input | Method | Notes |
|---|---|---|
| PDF with ≥ 30 characters of text | `PDF_TEXT` | Page markers (`-- 1 of N --`) are disabled so they can't make a scanned PDF look like text. |
| PDF with less text | `PDF_OCR` | First 3 pages rendered at 2× and read with one Tesseract worker. Confidence is weighted by text per page. |
| PDF that fails to parse | `PDF_PARSE_FAILED` | Treated as corrupt. OCR is not attempted. |
| JPEG / PNG | `OCR` | Blank images return `success: false`. |
| Anything else | `UNSUPPORTED_DOCUMENT_TYPE` | Normally rejected earlier by file validation. |

Tesseract's English language data (`eng.traineddata`) ships inside the OCR worker's image (see `ocr-worker/README.md`) rather than being downloaded at runtime; it is gitignored in this repo.

### OCR settings for phone photos

WhatsApp photos are often tilted, shadowed and recompressed. Each OCR read (images and scanned-PDF pages) works like this:

1. **Default read**: Otsu thresholding, no rotation. If confidence is 70 or more, it's used as is.
2. **If weaker**, three alternatives are tried:
   - Otsu + `rotateAuto` (Tesseract straightens small tilts)
   - Sauvola thresholding (adapts to local brightness, so shadows hurt less)
   - Sauvola + `rotateAuto`
3. The **most confident read of all four** is kept, including the default. The result is therefore never worse than the default read.

Why rotation isn't always on: on a real police certificate photo, `rotateAuto` detected a false angle and dropped confidence from 59 to 32 (Sauvola + rotation: 41). Keeping the default read as a candidate prevents that.

The OCR result records the winning settings (`thresholding: "OTSU" | "SAUVOLA"`, `rotateAuto: true | false`); the log summary shows them as `ocrThresholding` and `ocrRotateAuto`.

Measured on synthetic phone-photo fixtures: a harsh police certificate photo went from confidence 63 (default) to about 86 (best alternative); good photos, including a passport photo whose MRZ reads with valid check digits, are read once with the default settings, as before.

### Photos taken sideways or upside down (0°, 90°, 180°, 270°)

`rotateAuto` only straightens small tilts. It does not turn a page that is sideways or upside down, and Tesseract's own orientation detection needs the legacy engine and the `osd` model, which are not installed. Such a photo used to be read as garbage (confidence 27–52, type `UNKNOWN`, pending review).

For images (JPEG/PNG), after the usual read of the image as received:

1. If that read is **weak** (confidence below 70) **and** has no complete passport MRZ, the image is turned 90°, 180° and 270°. Each is read once with the default settings; a small image (long side under 1200 px) is read at 2×, since it is too small to read at its own size.
2. The best of those three is used only if it is **clearly better** than the read as received: more valid passport MRZ check digits, or more than 5 points higher confidence. It then gets the full read (retries, 2×), and must still be clearly better.
3. Otherwise the read as received is kept, as before. An image that can't be decoded, or a turn that fails, also keeps it.

Only the OCR input is turned: a PNG copy made in memory from the decoded pixels, using the same pure-JavaScript decoders and header size check as the 2× read, and `@napi-rs/canvas`. The received file is never changed: the copies in `temporary/`, `pending/` and `clients/` are the file exactly as received. The result records the turn (`rotation`: 0, 90, 180 or 270, clockwise). The log summary shows it as `ocrRotation`, and the review page as *OCR orientation*.

Measured with real Tesseract on synthetic fixtures (passport photo, medical PNG, police photos, small low-quality passport), each turned 90°, 180° and 270°: every one reads like the upright image (same type, same confidence, all 4 MRZ checks for the passports). Upright images are unchanged, with no extra reads when they read well, and a blank image is never turned. A turned photo takes longer: about 4–8 s for a normal photo, about 20 s for the small passport, instead of under 1 s upright — well within the 120 s OCR job limit.

### Low-resolution images (fixed in Phase 7)

Real company passport scans initially came through with low OCR confidence and were classified as `UNDEFINED` or `UNKNOWN`, caused by low-resolution WhatsApp images, weak OCR output, misread MRZ characters and small images going to OCR without enough scaling. The fix: low-resolution image OCR fallback with 2× upscaling, improved OCR candidate selection, and relaxing only the MRZ sex-character detection position for OCR mistakes (see Passport Acceptance below). Low-quality passports can now be stored under the correct client as `CLIENT + REVIEW_REQUIRED`, keeping the real measured OCR confidence rather than being pushed to `UNDEFINED`.

### Diagnosing a document that isn't classified

`npm run diagnose:document -- <file>` or `npm run diagnose:document -- --storage-path temporary/<uuid>.jpeg`

Prints, for each OCR setting: confidence, character/line/word counts, letter ratio, classification scores and matched indicator IDs, MRZ line count, and which words from a fixed vocabulary list OCR recognized (exactly or as near-misses). It never prints document text, and a file downloaded from Supabase is kept in memory only.

## Classification

The filename is only a hint. Content decides.

Each type has weighted indicators. Each indicator counts once, however many times it appears.

| Type | Strong indicators (weight 2) | Supporting indicators (weight 1) |
|---|---|---|
| PASSPORT | MRZ line 1, MRZ line 2 | passport, passport no, nationality, surname, given names, place of birth, date of expiry |
| Police (family, then split below) | police clearance, clearance certificate, criminal record(s) | police, police station/headquarters, inspector general, conviction, character certificate |
| MEDICAL | medical examination/report/certificate, GAMCA/Wafid | medical, fit/unfit for, health, hospital/clinic/laboratory, doctor, lab tests |

Decision rules:

- A type needs a score ≥ 3 from ≥ 2 different indicators and a lead of ≥ 2 over the next type.
- Otherwise the result is `UNKNOWN` with a reason: `NO_TEXT`, `INSUFFICIENT_EVIDENCE` or `AMBIGUOUS_CONTENT`.
- The filename is used only when there is no readable text at all (`source: "FILENAME"`).
- A filename that disagrees with the content sets `filenameMismatch` (wrong document, §17).

Police certificates often print "Passport No" and "Nationality"; the weights keep those from being classified as passports.

**Why several indicators?** A single word is easily misleading — a police certificate usually says "holder of Passport No …", and a letter might say "bring your passport". Requiring several indicators and a clear lead stops these from being misclassified.

### Police slip vs final police report

A police document is then split into two types with separate indicators (`classifyPoliceSubtype()`):

| Type | Strong indicators (weight 2) | Supporting indicators (weight 1) |
|---|---|---|
| `POLICE_SLIP` (receipt given on application) | receipt/acknowledgement, submitted/submission/lodged, application no/number/reference, clearance application | application/applied, received/registered, reference no |
| `POLICE_REPORT` (final clearance certificate) | clearance certificate, no criminal record(s), "this is to certify" / "hereby certify" | criminal record(s), inspector general, police headquarters, date of issue / issued on |

The winner needs a score ≥ 3 from ≥ 2 indicators and a lead of ≥ 2; one keyword never decides. Otherwise the result is `UNKNOWN` with reason `POLICE_TYPE_UNCLEAR` and flag `POLICE_TYPE_UNCLEAR` (UNDEFINED band, pending storage, a person decides). Classification confidence still comes from the police family score. A police-named file (`police.jpg`) is not treated as a wrong document for either police type.

**Historical note:** `POLICE_SLIP` and `POLICE_REPORT` were originally treated as one type, which meant a final police report was incorrectly required to have a submitted/application date and sent to pending storage. Splitting them into two types (above) fixed it: only the slip requires a date; a correctly matched final report goes straight to permanent client storage.

## Passport Field Extraction

Fields extracted are those with a `candidate` column or listed in §12:

| Field | Source | candidate column |
|---|---|---|
| `passportId` | MRZ (check digit) and printed label | `passport_id` (lookup key, never overwritten) |
| `surname` | MRZ and printed label | `other_name` (legacy OTHER NAME / surname) |
| `givenNames` | MRZ and printed label | `first_name` (legacy FIRST NAME) |
| `dateOfBirth` | MRZ (check digit) and printed label | `date_of_birth` |
| `placeOfBirth` | printed label only | `place_of_birth` |
| `passportExpiryDate` | MRZ (check digit) and printed label | `passport_expiry_date` |

Nationality and sex are printed on passports but have no column, so they are not extracted.

Each field returns `{ value, source, checkDigitValid, crossCheck }`:

- A clean MRZ read wins.
- If the MRZ check digit fails, the printed value is used and `checkDigitValid: false` is kept.
- If MRZ and printed values disagree, `crossCheck: "MISMATCH"`.
- Unreadable or impossible values are `null`.

Result status: `COMPLETE`, `PARTIAL`, `PASSPORT_ID_MISSING` or `NO_TEXT`.

MRZ handling:

- ICAO 9303 TD3 layout, verified against the official ICAO specimen.
- OCR spaces and `«` are cleaned. `O/0`, `I/1`, `S/5`, `B/8` etc. are corrected only in digit-only positions.
- Birth years in the future are moved to the 1900s. Expiry years are always 2000s.
- The MRZ sex-character detection position was relaxed for OCR mistakes (Phase 7 fix, low-quality scans).

Printed dates are read day-first (`DD/MM/YYYY`), the Sri Lankan convention.

### Passport Acceptance (low-quality scans)

For low-quality but genuine passports, the system accepts and stores the document under the correct client (`CLIENT + REVIEW_REQUIRED`) when all of the following hold, while still keeping the real measured OCR confidence:

- a valid MRZ
- a verified passport ID
- date-of-birth and expiry checks pass
- identity resolved to `VERIFIED_MATCH`
- no reconciliation conflicts

## Confidence Rules

**One scale everywhere: 0–100 (percent).** This matches Tesseract and the proposal. `documents.ocr_confidence` uses the same scale.

Bands (proposal §17, exact):

| Confidence | Band | Flag | Review | Rename | Storage |
|---|---|---|---|---|---|
| > 95 | `VERIFIED` | — | no | yes | permanent |
| 90–95 | `HIGH_CONFIDENCE` | optional review | no | yes | permanent |
| 60–89 | `SLIGHTLY_UNCLEAR` | warning | no | yes | permanent |
| 40–59 | `UNCLEAR` | review | yes | no | permanent, original name |
| < 40 | `UNDEFINED` | critical review | yes | no | undefined area |

The 90 boundary is configurable (`CONFIDENCE_THRESHOLDS.HIGH_CONFIDENCE_FROM`), as the proposal allows. Rename and storage placement are described in `06-storage-management.md`.

Three separate confidence values:

| Name | Meaning | How it's calculated |
|---|---|---|
| `extractionConfidence` | How reliably the text was read | 100 for a PDF text layer; Tesseract's value for OCR; 0 if no text |
| `classificationConfidence` | How strongly the text shows the type | Content score 3 → 80, 4 → 90, 5 → 95, 6+ → 100. Filename-only → 30. Unknown → 0. |
| field confidence | How reliable one passport field is | MRZ check digit valid + printed agrees → 100; MRZ valid alone → 97; MRZ corrupt but printed agrees → 90; printed only → min(OCR, 90); MRZ/printed mismatch or unconfirmed corrupt MRZ → 30 |

`documentConfidence = min(extractionConfidence, classificationConfidence)`. A well-read document of unclear type is still unclear.

Document flags:

| Flag | When |
|---|---|
| `WRONG_DOCUMENT_SUSPECTED` | Filename type differs from content type. Forces review even in a high band. |
| `CLASSIFIED_FROM_FILENAME_ONLY` | No readable text; type came from the filename. |
| `NO_READABLE_TEXT` | Extraction produced no text. |
| `CORRUPT_FILE` | PDF could not be parsed. |

## Police Slip Date Extraction

Runs for `POLICE_SLIP` only. A final `POLICE_REPORT` has `policeDate: null` and no date requirement. A slip whose date is `AMBIGUOUS`, `INVALID` or `NOT_FOUND` goes to `MANUAL_REVIEW` (pending); no date is guessed.

`extractPoliceReportDate(text)` returns `{ status, date, kind, confidence, candidates }`.

| Status | Meaning |
|---|---|
| `RESOLVED` | One date chosen |
| `AMBIGUOUS` | Two different dates with the same label. Nothing is chosen. |
| `INVALID` | Dates found, but all in the future or before 2000 |
| `NOT_FOUND` | No usable date |

Priority: `SUBMITTED` (submitted, application, applied, lodged, received, registered; confidence 95) → `ISSUED` (issue/issued; 90) → a single unlabelled date (60). Birth and expiry dates are always ignored. A label on the line above the date is recognized.

The resolved date is stored (`documents.police_submitted_date`) and drives the 21-day countdown once the document is placed under a client — see `06-storage-management.md` and the Police Report Workflow.

## Identity Verification

Rules followed throughout:

- `candidate.passport_id` is the primary key and the identity.
- `candidate.unique_id` is a separate reference and is never used in place of `passport_id`.
- WhatsApp number is a signal, not an identity.
- Users are never merged. Stored WhatsApp numbers are never changed.
- Existing values are never overwritten.

### Passport ID Lookup

`findUsersByPassportId(passportId)`:

1. Normalizes the number: uppercase, no spaces, hyphens or `<`, 6–9 characters, at least one digit.
2. Invalid input returns `INVALID_INPUT` without querying.
3. Queries `candidate.passport_id` with an exact, case-insensitive match (in case legacy rows are lowercase).
4. Returns `FOUND`, `NOT_FOUND` or `MULTIPLE`.

A passport number with field confidence below 60 is not trusted for identity, even if it matches a user (`PASSPORT_ID_UNRESOLVED`).

### WhatsApp Lookup

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

### Identity Decision Matrix

`decideIdentity()` returns `{ status, passportId, uniqueId, reviewRequired, provisional, notes, candidates }`. `candidates` hold only `passportId` and `uniqueId`, never names.

**Passport documents:**

| Proposal §13 | Passport lookup | WhatsApp lookup | Status | Review | Linked on temporary_data |
|---|---|---|---|---|---|
| A | user X | user X | `VERIFIED_MATCH` | no | yes |
| B | user X | user Y | `IDENTITY_CONFLICT` | yes | no |
| C | user X (has another WhatsApp) | none | `PASSPORT_MATCH_ONLY` + `WHATSAPP_DIFFERS` | yes | yes |
| E | user X (no WhatsApp on record) | none | `PASSPORT_MATCH_ONLY` + `WHATSAPP_NOT_ON_RECORD` | yes (SEC-008) | yes |
| D | none | user X | `WHATSAPP_MATCH_ONLY` (provisional) + `PASSPORT_NOT_IN_DATABASE` | yes | no |
| F | none | none | `NO_MATCH` | yes | no |
| G | unreadable / invalid / confidence < 60 | any | `PASSPORT_ID_UNRESOLVED` (WhatsApp user kept as provisional candidate) | yes | no |
| H | several | any, or any + several | `AMBIGUOUS_MATCH` | yes | no |

**Police and medical documents** (no passport, so WhatsApp is the only signal — §13: "Existing WhatsApp identity trusted?"):

| WhatsApp lookup | Status | Review | Linked |
|---|---|---|---|
| one user | `WHATSAPP_MATCH_ONLY` | no | yes |
| several | `AMBIGUOUS_MATCH` | yes | no |
| none | `NO_MATCH` | yes | no |

"Linked" means `temporary_data.passport_id` and `unique_id` are set. This only happens for a single existing user (the foreign key requires it) and never for provisional matches.

### Conflict Handling

- `IDENTITY_CONFLICT`: nothing is merged, linked or written. Both candidate IDs are kept in the result for the reviewer. `processing_status = CONFLICT`.
- `WHATSAPP_DIFFERS`: the user's WhatsApp number is not changed. `processing_status = MANUAL_REVIEW`.
- `WHATSAPP_NOT_ON_RECORD`: the number is not filled in automatically (§13 E: only after identity is verified by a person). Since SEC-008 this case also needs review: a passport number alone does not prove the sender is the client. The document stays linked to the passport, `processing_status = MANUAL_REVIEW`, and the file goes to `pending/{unique_id}`, not the client folder.
- `AMBIGUOUS_MATCH`: no candidate is picked.

Why conflicts are never merged: if a passport belongs to client A but the WhatsApp number belongs to client B, the system can't know which is right — a family member, a shared phone, a wrong record, or misuse of a passport copy are all possible. Merging automatically could attach one person's passport to another person's record: a serious privacy and legal problem. The system flags it and a person decides (proposal §13, business rule 7).

### Reconciliation Rules (§14)

`reconcilePassportFields()` compares the matched passport user's record with the extracted fields.

| DB value | Passport value | Outcome | Action |
|---|---|---|---|
| any | not extracted | `NOT_EXTRACTED` | none |
| existing | same | `MATCH` | none |
| missing | confidence ≥ 90 | `FILL` | update (if allowed, below) |
| existing | different, confidence ≥ 90 | `CONFLICT` | flag, never overwrite |
| missing or different | confidence < 90 | `LOW_CONFIDENCE` | nothing |

Comparison is by calendar day for dates, and case- and spacing-insensitive for text.

| Passport field | candidate column (legacy name) | Auto-fill |
|---|---|---|
| `dateOfBirth` | `date_of_birth` | yes |
| `placeOfBirth` | `place_of_birth` | yes |
| `passportExpiryDate` | `passport_expiry_date` | yes |
| `givenNames` | `first_name` (FIRST NAME) | yes |
| `surname` | `other_name` (OTHER NAME / surname) | yes |

`passport_id`, `unique_id` and `whatsapp_number` are never reconciled. Names are filled exactly as printed on the passport (uppercase, e.g. `KAMAL NIMAL`); a record holding only part of the given names (e.g. `Kamal`) is reported as a conflict, not overwritten.

Writes (`applyReconciliationUpdates`):

- only for `VERIFIED_MATCH`
- one conditional update per column: `WHERE passport_id = ? AND <column> IS NULL`, so a value added in the meantime is never overwritten
- returns the columns actually written

The result lists (`matchedFields`, `missingFieldsFilled`, `conflicts`, `skipped`) contain field names and confidence only. `updates` contains values and is never logged.

## Temporary Record Update

After the flow above, the existing `temporary_data` row is updated:

| Column | Value |
|---|---|
| `document_type` | `PASSPORT`, `POLICE_SLIP`, `POLICE_REPORT`, `MEDICAL` or `UNKNOWN` |
| `processing_status` | See table below |
| `passport_id`, `unique_id` | Only when identity resolves to one existing user |

`processing_status` uses proposal names (§24, §32), most serious first:

| Status | When |
|---|---|
| `FAILED` | An exception at any stage |
| `CONFLICT` | Identity conflict, or a passport value contradicts the user record |
| `UNDEFINED` | Document confidence < 40 |
| `UNCLEAR` | Confidence 40–59 |
| `MANUAL_REVIEW` | Identity needs review, wrong document suspected, or a police slip's date not resolved |
| `VERIFIED` / `HIGH_CONFIDENCE` / `SLIGHTLY_UNCLEAR` | Otherwise, the confidence band |

## Failure Handling

- `processDocument` never throws. A failure sets `processing_status = FAILED` and reports the stage: `TEXT_EXTRACTION`, `CLASSIFICATION`, `FIELD_EXTRACTION`, `IDENTITY`, `RECONCILIATION` or `RECORD_UPDATE`.
- If even the `FAILED` update fails, that is reported in the log summary.
- The webhook still returns `200`; processing itself runs in the background worker, not inline in the request (see `08-cloud-deployment.md` for the worker's own lifecycle).

## Logging and Privacy

One line per document: `Document processing result`, with `messageId`, `temporaryId`, stage, type, method, confidences, band, flags, passport status and missing field names, police date status, identity status, and reconciliation field names.

Never logged: document text, names, dates, passport numbers, phone numbers. Lookups and decisions log only statuses, notes and field names. Error messages are cut to their first line because Prisma puts query arguments on later lines.

## Tests

`npm test` runs offline. `RUN_OCR_TESTS=1 npm test` also runs real Tesseract OCR.

| File | Covers |
|---|---|
| `test/documentClassification.test.js` | Passport, police, medical, unknown, ambiguous, misleading filename, filename fallback |
| `test/passportExtraction.test.js` | Valid, blurry, cropped, damaged, missing field, missing ID, malformed, empty |
| `test/mrz.test.js` | ICAO specimen, check digits, OCR lookalikes, corrupted MRZ |
| `test/dateParsing.test.js` | Date formats, day-first, invalid dates, passport ID normalization |
| `test/confidence.test.js` | Band boundaries, three confidence values, flags, low-confidence OCR |
| `test/ocrService.test.js` | Text PDF, corrupt PDF, unsupported type; with OCR: scanned PDF, image, blank image |
| `test/policeReportDate.test.js` | Valid, missing, invalid, future, multiple, ambiguous dates |
| `test/userLookup.test.js` | Phone formats, passport lookup, lowercase legacy rows, `unique_id` not used, shared WhatsApp, same last 4 digits, no writes |
| `test/identityVerification.test.js` | Scenarios A–H, low-confidence passport number, police/medical documents, no names in results |
| `test/fieldReconciliation.test.js` | Same value, missing field, conflicting field, low confidence, names, never-reconciled columns, writes only for `VERIFIED_MATCH`, no overwrite race |
| `test/documentProcessing.test.js` | Whole pipeline with a fake database |

All fixtures are synthetic (`test/fixtures/files/`, `test/fixtures/documents/*.txt`); the passport MRZ fixtures have correct check digits. Tests use an in-memory fake Prisma client (`test/helpers/fakePrisma.js`); the real query shapes were checked separately against the generated Prisma client.

## Known Limitations

- Classification weights and passport label variants were originally tuned on synthetic text; the low-resolution-image fixes above were driven by real company scans.
- MRZ names truncated by the 39-character limit are not rebuilt; filler misread as `K` is not corrected.
- Only the first 3 pages of a scanned PDF are OCR'd; pages of a scanned PDF are not turned (the 90°/180°/270° orientation check covers JPEG/PNG images only).
- A photo that is turned *and* barely readable upright stays unreadable — the turn only helps when the upright read is clearly better.
- Names are filled exactly as printed (uppercase); a record holding only part of the given names is reported as a conflict, not merged.
- Only Sri Lankan local mobile formats get `94` prepended; other countries' local formats or landlines won't match Meta's international format.
- Passport numbers stored with spaces in legacy data won't match; legacy data should be normalized during migration.
- Conflict details (which user, which field) are in the log line and the temporary record status; the admin dashboard (`09a-admin-dashboard-api.md`) surfaces them for review.
