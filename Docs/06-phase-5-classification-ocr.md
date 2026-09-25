# Phase 5 — Classification and OCR

## Overview

Phase 5 turns a stored WhatsApp document into structured, scored information:

- what kind of document it is (passport, police slip, final police report, medical, unknown)
- how reliably its text was read
- for passports: the passport fields
- for police slips only: the submitted/application date (a final police report needs no date)

Proposal reference: §12 (Passport Processing), §17 (confidence bands), §20 (Police Report Slip Processing), §32 (error handling), §44 Phase 5.

Nothing in this phase moves, renames or permanently stores files (Phase 7), and the 21-day police countdown is not calculated (Phase 9).

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
Phase 6 (identity, reconciliation) → temporary_data updated
```

Orchestration lives in `src/services/documentProcessingService.js` and is called once from `src/routes/whatsapp.js` after the temporary record is created.

## Main Files

| File | Purpose |
|---|---|
| `src/services/ocrService.js` | PDF text layer, scanned-PDF OCR, image OCR |
| `src/services/documentClassificationService.js` | Filename hint, content classification, final type |
| `src/services/confidenceService.js` | Confidence bands and the three confidence values |
| `src/services/passportExtractionService.js` | Passport field extraction |
| `src/services/policeReportDateService.js` | Police report date extraction |
| `src/services/documentProcessingService.js` | Runs Phase 5 + 6 for one document |
| `src/utils/mrz.js` | MRZ detection, parsing, ICAO check digits |
| `src/utils/dateParsing.js` | Date formats and calendar validation |
| `src/utils/passportId.js` | Canonical passport number format |
| `src/utils/documentText.js` | Text normalization for keyword matching |

No new dependencies. Scanned-PDF rendering uses `pdf-parse`'s `getScreenshot()`, which relies on `@napi-rs/canvas` already installed with `pdf-parse`.

## Text Extraction

| Input | Method | Notes |
|---|---|---|
| PDF with ≥ 30 characters of text | `PDF_TEXT` | Page markers (`-- 1 of N --`) are disabled so they can't make a scanned PDF look like text. |
| PDF with less text | `PDF_OCR` | First 3 pages rendered at 2× and read with one Tesseract worker. Confidence is weighted by text per page. |
| PDF that fails to parse | `PDF_PARSE_FAILED` | Treated as corrupt. OCR is not attempted. |
| JPEG / PNG | `OCR` | Blank images return `success: false`. |
| Anything else | `UNSUPPORTED_DOCUMENT_TYPE` | Normally rejected earlier by file validation. |

Tesseract downloads `eng.traineddata` from the jsDelivr CDN on first use and caches it in the working directory. `*.traineddata` is gitignored.

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

### Diagnosing a document that isn't classified

`npm run diagnose:document -- <file>` or `npm run diagnose:document -- --storage-path temporary/<uuid>.jpeg`

Prints, for each OCR setting: confidence, character/line/word counts, letter ratio, classification scores and matched indicator IDs, MRZ line count, and which words from a fixed vocabulary list OCR recognized (exactly or as near-misses). It never prints document text, and a file downloaded from Supabase is kept in memory only.

## Classification

The filename is only a hint. Content decides.

Each type has weighted indicators. Each indicator counts once.

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

Police certificates often print "Passport No" and "Nationality". The weights keep those from being classified as passports (see tests).

### Police slip vs final police report

A police document is then split into two types with separate indicators (`classifyPoliceSubtype()`):

| Type | Strong indicators (weight 2) | Supporting indicators (weight 1) |
|---|---|---|
| `POLICE_SLIP` (receipt given on application) | receipt/acknowledgement, submitted/submission/lodged, application no/number/reference, clearance application | application/applied, received/registered, reference no |
| `POLICE_REPORT` (final clearance certificate) | clearance certificate, no criminal record(s), "this is to certify" / "hereby certify" | criminal record(s), inspector general, police headquarters, date of issue / issued on |

The winner needs a score ≥ 3 from ≥ 2 indicators and a lead of ≥ 2; one keyword never decides. Otherwise the result is `UNKNOWN` with reason `POLICE_TYPE_UNCLEAR` and flag `POLICE_TYPE_UNCLEAR` (UNDEFINED band, pending storage, a person decides). Classification confidence still comes from the police family score. A police-named file (`police.jpg`) is not treated as a wrong document for either police type.

## Passport Field Extraction

Fields extracted are those with a `users` column or listed in §12:

| Field | Source | users column |
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

Printed dates are read day-first (`DD/MM/YYYY`), the Sri Lankan convention.

## Confidence Rules

**One scale everywhere: 0–100 (percent).** This matches Tesseract and the proposal. `documents.ocr_confidence` should use the same scale when Phase 7 writes it.

Bands (proposal §17, exact):

| Confidence | Band | Flag | Review | Rename (Phase 7) | Storage (Phase 7) |
|---|---|---|---|---|---|
| > 95 | `VERIFIED` | — | no | yes | permanent |
| 90–95 | `HIGH_CONFIDENCE` | optional review | no | yes | permanent |
| 60–89 | `SLIGHTLY_UNCLEAR` | warning | no | yes | permanent |
| 40–59 | `UNCLEAR` | review | yes | no | permanent, original name |
| < 40 | `UNDEFINED` | critical review | yes | no | undefined area |

The 90 boundary is configurable (`CONFIDENCE_THRESHOLDS.HIGH_CONFIDENCE_FROM`), as the proposal allows.

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

**Storage (deferred to Phase 7/9):** there is no column for this date, and no schema change is made in Phase 5/6. The full result (`status`, `date`, `kind`, `confidence`) is returned by `processDocument()` in `details.policeDate`, which is not logged. Only `status` and `kind` appear in the log summary. Persisting the date and the +21-day calculation belong to Phase 7/9.

## Temporary Record Update

After Phase 5 and 6, the existing `temporary_data` row is updated:

| Column | Value |
|---|---|
| `document_type` | `PASSPORT`, `POLICE_SLIP`, `POLICE_REPORT`, `MEDICAL` or `UNKNOWN` |
| `processing_status` | See table below |
| `passport_id`, `unique_id` | Only when identity resolves to one existing user (Phase 6) |

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
- The webhook still returns `200`.

## Logging

One line per document: `Document processing result` with `messageId`, `temporaryId`, stage, type, method, confidences, band, flags, passport status and missing field names, police date status, identity status, and reconciliation field names.

Never logged: document text, names, dates, passport numbers, phone numbers. Error messages are cut to their first line because Prisma puts query arguments on later lines.

## Tests

`npm test` runs offline. `RUN_OCR_TESTS=1 npm test` also runs real Tesseract OCR (downloads language data once).

| File | Covers |
|---|---|
| `test/documentClassification.test.js` | Passport, police, medical, unknown, ambiguous, misleading filename, filename fallback |
| `test/passportExtraction.test.js` | Valid, blurry, cropped, damaged, missing field, missing ID, malformed, empty |
| `test/mrz.test.js` | ICAO specimen, check digits, OCR lookalikes, corrupted MRZ |
| `test/dateParsing.test.js` | Date formats, day-first, invalid dates, passport ID normalization |
| `test/confidence.test.js` | Band boundaries, three confidence values, flags, low-confidence OCR |
| `test/ocrService.test.js` | Text PDF, corrupt PDF, unsupported type; with OCR: scanned PDF, image, blank image |
| `test/policeReportDate.test.js` | Valid, missing, invalid, future, multiple, ambiguous dates |
| `test/documentProcessing.test.js` | Whole pipeline with a fake database |

All fixtures are synthetic. `test/fixtures/files/` holds generated PDFs and images; the passport MRZ fixtures have correct check digits.

## Current Limitations

- Classification weights and passport label variants are tested on synthetic text, not real client scans yet.
- Police slip wording on real slips may differ; the synthetic slip scores exactly the minimum.
- MRZ names truncated by the 39-character limit are not rebuilt; filler misread as `K` is not corrected.
- Only the first 3 pages of a scanned PDF are OCR'd.
- Processing runs inside the webhook request. Scanned PDFs add about 1–2 seconds per page.
- Police date persistence is deferred to Phase 7/9 (needs a schema change). It is kept in `details.policeDate` for now.

## Current Status

Implemented and tested: content classification, scanned-PDF OCR, passport field extraction, confidence bands, police date extraction, temporary record update.
