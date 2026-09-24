# Phase 5 & Phase 6 Development Summary

## Purpose

This document explains, in plain language, what has been built for:

- **Phase 5 — Classification and OCR**: working out what a received document is and reading its contents.
- **Phase 6 — Passport Verification**: working out which client sent it and comparing passport data with the client's record.

It describes the code as of commit `9c77ea4` and compares it with the project proposal (`Docs/WhatsApp_Document_Processing_Project_Proposal_Final.md`, §44 Phase 5 and Phase 6). Anything not built yet is marked as such.

For full technical detail see `Docs/06-phase-5-classification-ocr.md` and `Docs/07-phase-6-passport-verification.md`.

## Current Overall Status

| Phase | Proposal tasks | Built | Automatically tested | Tested with real documents / live database |
|---|---|---|---|---|
| Phase 5 | Document classification, passport OCR, confidence handling, police-report date extraction | All 4 | Yes | Not yet |
| Phase 6 | Passport ID lookup, WhatsApp lookup, identity conflict rules, field reconciliation | All 4 | Yes | Not yet |

All 219 automated tests pass. What remains for both phases is **manual checking with real documents and the real Supabase database**, plus a few items the team decided to defer to later phases.

## Phase 5 — Classification and OCR

### Implemented

- **Filename hint**: a quick guess from the filename (e.g. `passport.pdf` → PASSPORT). Treated as low trust.
- **Content classification**: reads the document's text and decides between PASSPORT, POLICE_REPORT, MEDICAL and UNKNOWN using a scoring system.
- **Wrong-document detection**: flags a file whose name says one thing and whose content says another.
- **Text extraction**:
  - PDFs with a text layer are read directly.
  - Scanned PDFs (pictures of pages) are converted to images and read with OCR (first 3 pages).
  - JPEG/PNG images are read with OCR.
  - Corrupt PDFs are detected and reported separately.
- **Passport field extraction**: passport number, given names, surname, date of birth, place of birth, expiry date. Uses the MRZ (the two machine-readable lines at the bottom of a passport) with check-digit validation, plus the printed labels.
- **Confidence handling**: the proposal's five confidence bands, on one 0–100 scale.
- **Police-report date extraction**: finds the submitted (or issue) date and validates it.
- **Connected to the WhatsApp flow**: every received document now goes through these steps, and the result is saved on its `temporary_data` row.

### Partially Implemented

- **Police-report date storage**: the date is extracted and validated and kept in the processing result, but it is **not saved to the database**. There is no column for it, and by decision no schema change is made in Phase 5/6. Deferred to Phase 7/9.
- **Validation on real documents**: all tests use synthetic (made-up) documents. The rules have not yet been checked against real client scans, so keyword weights may need tuning.

### Not Yet Implemented

- **Nationality and sex extraction**: printed on passports but not extracted, because the `users` table has no columns for them. This is intentional, not a gap in Phase 5.
- **OCR beyond the first 3 pages** of a scanned PDF (by design, to keep processing time low).

## Phase 6 — Passport Verification

### Implemented

- **Passport ID lookup** on `users.passport_id` (the primary key). `unique_id` is never used instead.
- **WhatsApp lookup** on `users.whatsapp_number`, matching different stored formats (`+94…`, `07…`, `94…`).
- **Identity decisions** for all proposal scenarios (§13 A–H), each with a clear status name.
- **Conflict handling**: conflicting users are never merged; the case is flagged for review.
- **Field reconciliation** following the proposal's matrix (§14): match, fill, conflict, low confidence.
- **Safe database updates**: only empty fields are filled, only for a verified client, only with high-confidence values, and never overwriting an existing value.
- **Linking**: when the client is identified, `temporary_data.passport_id` and `unique_id` are set.

### Partially Implemented

- **Live database testing**: tested with an in-memory fake database; the database queries were checked against the real Prisma client, but not yet run against the real Supabase data.
- **Conflict details**: the log line shows which fields conflicted, but there is no database column to store those details for an admin to see later.

### Not Yet Implemented

Nothing from the Phase 6 task list is missing. Showing conflicts to an administrator belongs to the dashboard (Phase 10).

## Current End-to-End Processing Flow

```text
WhatsApp message with a document
   ↓
Webhook receives it                          ✅ (Phase 3)
   ↓
Signature check (is it really from Meta?)    ✅ (Phase 3)
   ↓
Duplicate-message check                      ✅ (Phase 3, in memory only)
   ↓
Download the file from Meta                  ✅ (Phase 3)
   ↓
Validate type (PDF/JPEG/PNG) and size        ✅ (Phase 4)
   ↓
Upload to private Supabase bucket            ✅ (Phase 4) → temporary/<uuid>.<ext>
   ↓
Filename classification (hint only)          ✅ Phase 5
   ↓
Create temporary_data row                    ✅ (Phase 4) → UNCLASSIFIED / TEMPORARY_STORED
   ↓
─── processDocument() ─────────────────────────────────────────────
   ↓
Text extraction (PDF text / OCR)             ✅ Phase 5
   ↓
Content classification                       ✅ Phase 5
   ↓
Confidence decision                          ✅ Phase 5
   ↓
Passport fields   or   police date           ✅ Phase 5 (police date not stored 🟡)
   ↓
Passport lookup                              ✅ Phase 6
   ↓
WhatsApp lookup                              ✅ Phase 6
   ↓
Identity decision                            ✅ Phase 6
   ↓
Field reconciliation (+ safe updates)        ✅ Phase 6
   ↓
temporary_data update                        ✅ Phase 5/6
   ↓
One log line with the result (no personal data)
```

If anything fails inside `processDocument()`, the row is marked `FAILED` with the step name, and WhatsApp still gets a normal reply.

## Document Classification Logic

### Filename hint

The filename is checked for keywords:

| Filename | Guess |
|---|---|
| `passport.pdf` | PASSPORT |
| `police.pdf` | POLICE_REPORT |
| `medical.pdf` | MEDICAL |
| `123456.pdf` | UNKNOWN |

It is only a hint, because clients often send files with random names (for example a passport saved as `6325523527323.pdf`) or with the wrong name. The proposal says the filename is not enough evidence on its own.

### Content scoring

The document's text is checked for **indicators**: words and patterns typical of each type. Each indicator has a weight:

- **2 points**: strong evidence that almost only appears on that type, e.g. "police clearance", "criminal records", "medical examination report", "GAMCA", or an MRZ line.
- **1 point**: supporting evidence that can appear elsewhere, e.g. "passport", "nationality", "hospital".

Each indicator counts once, however many times it appears.

A type is chosen only if:

1. it has at least **3 points**,
2. from at least **2 different indicators**, and
3. it is at least **2 points ahead** of the next type.

Otherwise the result is UNKNOWN, with a reason: no text, not enough evidence, or ambiguous (two types too close).

**Why several indicators?** A single word is easily misleading. A police certificate usually says "holder of Passport No …", and a letter might say "bring your passport". Requiring several indicators and a clear lead stops these from being called passports.

### MRZ detection

The MRZ (Machine Readable Zone) is the two lines of capital letters, numbers and `<` signs at the bottom of a passport's photo page. They follow a strict international format (ICAO 9303). Each MRZ line found counts as a strong passport indicator, so a blurry passport where OCR could only read the MRZ is still recognized.

### filenameMismatch

If the filename suggests one type and the content clearly shows another (e.g. `medical.pdf` that is actually a passport), the content wins, and the result gets `filenameMismatch: true`. This becomes the flag `WRONG_DOCUMENT_SUSPECTED`, which always sends the document to manual review (proposal §17).

If there is **no readable text at all**, the filename guess is used, but the confidence is set very low (30) so the document always needs review.

## OCR Flow

**OCR** (Optical Character Recognition) turns a picture of text into actual text.

| Document | What happens | Tool |
|---|---|---|
| PDF with real text (e.g. generated by a computer) | Text is read directly. Fast and exact. | `pdf-parse` |
| Scanned PDF (only pictures inside) | First 3 pages are turned into images, then OCR'd | `pdf-parse` (renders pages) + Tesseract (reads them) |
| JPEG / PNG photo | OCR | Tesseract |
| PDF that can't be opened | Reported as corrupt (`PDF_PARSE_FAILED`); OCR is not attempted | `pdf-parse` |

- **pdf-parse** reads PDF files: it extracts the text layer and can render pages as images.
- **Tesseract** (`tesseract.js`) is the OCR engine. It also reports how confident it is (0–100). It downloads its English language data once and caches it as `eng.traineddata` (ignored by Git).

A PDF with fewer than 30 characters of text is treated as scanned.

## Passport Extraction

| Passport field | Database column | How it's read |
|---|---|---|
| Passport number | `passport_id` (used for lookup only, never changed) | MRZ (with check digit) and the "Passport No" label |
| Given names | `first_name` (legacy FIRST NAME) | MRZ and the "Given Names" label |
| Surname | `other_name` (legacy OTHER NAME / surname) | MRZ and the "Surname" label |
| Date of birth | `date_of_birth` | MRZ (with check digit) and the label |
| Place of birth | `place_of_birth` | Label only (not in the MRZ) |
| Expiry date | `passport_expiry_date` | MRZ (with check digit) and the label |
| Nationality | — | **Not extracted** (no column) |

**MRZ parsing**: the MRZ contains **check digits**, small calculated numbers that prove the field was read correctly. If OCR misreads one character, the check digit no longer matches, and the system knows. Common OCR mix-ups (`O`/`0`, `I`/`1`) are corrected only where the MRZ can only contain digits.

For each field the system:

- prefers a clean MRZ read,
- uses the printed value if the MRZ check digit failed,
- records if the MRZ and printed values disagree,
- leaves the field empty (null) if it can't be read. It never guesses.

Dates like `03/04/2026` are read day-first (3 April), the Sri Lankan convention.

## Confidence Handling

### Proposal bands (§17)

| Confidence | Band | Meaning | Proposal action |
|---|---|---|---|
| Above 95% | VERIFIED | Clear document | Rename, store permanently |
| 90–95% | HIGH_CONFIDENCE | Very likely right | Rename, store; optional review |
| 60–89% | SLIGHTLY_UNCLEAR | Probably right | Rename, store; warning flag |
| 40–59% | UNCLEAR | Doubtful | Don't rename; review |
| Below 40% | UNDEFINED | Unreliable | Don't rename; store in undefined area; critical review |

### What is implemented

- The bands are implemented exactly as above, with all confidence values on **one scale: 0–100**.
- The **rename and storage actions are not performed yet**. They are Phase 7. The band only decides the `processing_status` and whether review is needed.

There are three separate confidence values, so they never get mixed up:

| Value | Question it answers | Example |
|---|---|---|
| Extraction confidence | How well was the text read? | 100 for a text PDF; Tesseract's value (e.g. 94) for OCR |
| Classification confidence | How sure are we of the type? | Score 3 → 80, 4 → 90, 5 → 95, 6+ → 100; filename only → 30 |
| Field confidence | How reliable is this passport field? | MRZ check digit valid + label agrees → 100; label only → up to 90; MRZ and label disagree → 30 |

**Document confidence** = the lower of extraction and classification confidence. A perfectly read document of unclear type is still unclear.

## Police-Report Date Extraction

Implemented, except for storage.

- Finds dates in many formats (`01/09/2026`, `01 Sep 2026`, `2026-09-01`, …).
- Looks at the label next to each date:
  - "Submitted", "Application", "Received" → **submitted date** (preferred, confidence 95)
  - "Issued", "Date of issue" → **issue date** (confidence 90)
  - no label, only one date on the page → used with confidence 60 (review)
  - birth and expiry dates are always ignored
- Rejects impossible dates (31/02), future dates, and dates before 2000.
- If two **different** dates have the same label, the result is AMBIGUOUS and no date is picked.

Result statuses: RESOLVED, AMBIGUOUS, INVALID, NOT_FOUND.

**Not stored** in the database (no column; deferred to Phase 7/9). The date is returned in the processing result (`details.policeDate`) and is not logged. The 21-day reminder is Phase 9 and is not built.

## Identity Verification Logic

### Lookups

- **Passport ID lookup**: the extracted passport number is cleaned (uppercase, no spaces) and matched exactly against `users.passport_id`. Invalid-looking numbers are not looked up at all. A passport number with confidence below 60 is not trusted for identification.
- **WhatsApp lookup**: the sender's number is matched against `users.whatsapp_number`, with formats normalized for comparison only:

  | Stored as | Compared as |
  |---|---|
  | `947XXXXXXXX` | kept |
  | `+947XXXXXXXX` | `947XXXXXXXX` |
  | `07XXXXXXXX` | `947XXXXXXXX` |
  | `7XXXXXXXX` (leading zero lost in Excel) | `947XXXXXXXX` |
  | Other country codes, landlines | digits only, nothing added |

  Stored numbers are never changed.

### Scenarios (proposal §13)

All scenarios below are **implemented** and covered by tests.

| Scenario | Result status | What the system does now |
|---|---|---|
| Passport + WhatsApp → same user | `VERIFIED_MATCH` | Links the record to the client; may fill empty fields |
| Passport match, client has a different WhatsApp | `PASSPORT_MATCH_ONLY` | Links by passport; does **not** change the WhatsApp number; sends to review |
| Passport match, client has no WhatsApp on record | `PASSPORT_MATCH_ONLY` | Links by passport; does not add the WhatsApp number automatically |
| WhatsApp match only (passport not in database) | `WHATSAPP_MATCH_ONLY` (provisional) | Does **not** link; sends to review |
| Passport + WhatsApp → different users | `IDENTITY_CONFLICT` | Links nothing, changes nothing, marks CONFLICT |
| No match | `NO_MATCH` | Does not link; sends to review |
| Passport ID missing or unreadable | `PASSPORT_ID_UNRESOLVED` | Does not link; a WhatsApp match is kept only as a hint for the reviewer |
| Multiple possible users | `AMBIGUOUS_MATCH` | Picks nobody; sends to review |

Police and medical documents have no passport on them, so only the WhatsApp number is used: one match → linked (`WHATSAPP_MATCH_ONLY`), several → `AMBIGUOUS_MATCH`, none → `NO_MATCH`.

### Why conflicts are never merged

If a passport belongs to client A but the WhatsApp number belongs to client B, the system can't know which is right. It could be a family member sending documents, a shared phone, a wrong number in the records, or someone misusing a passport copy. Merging automatically could attach one person's passport to another person's record, which is a serious privacy and legal problem. So the system flags it and a person decides (proposal §13, business rule 7).

## Field Reconciliation

After a passport is matched to a client, the passport's values are compared with the client's record (proposal §14). Examples use `first_name` (given names):

| Database | Passport (OCR) | Result | What happens |
|---|---|---|---|
| `Kamal` | `KAMAL` | **MATCH** | Nothing changes (comparison ignores upper/lower case) |
| empty | `KAMAL`, confidence ≥ 90 | **FILL** | Written to the database, but only for a `VERIFIED_MATCH`, and only if the field is still empty at that moment |
| empty | `KAMAL`, confidence < 90 | **LOW_CONFIDENCE** | Nothing written |
| `Kamal` | `NIMAL`, confidence ≥ 90 | **CONFLICT** | Database value kept, document marked CONFLICT for review |
| `Kamal` | `NIMAL`, confidence < 90 | **LOW_CONFIDENCE** | Nothing written, no conflict raised (a weak read can't contradict trusted data) |
| anything | not readable | **NOT_EXTRACTED** | Nothing happens |

Fields compared: given names → `first_name`, surname → `other_name`, date of birth, place of birth, passport expiry date. `passport_id`, `unique_id` and `whatsapp_number` are never changed.

Names are filled exactly as printed on the passport (uppercase, e.g. `KAMAL NIMAL`). If the record holds only part of the given names (`Kamal`), it is reported as a conflict, not overwritten.

This logic is **implemented and tested**.

## temporary_data Updates

Each received document already has a `temporary_data` row (created as `UNCLASSIFIED` / `TEMPORARY_STORED`). After processing it is updated:

| Column | New value |
|---|---|
| `document_type` | PASSPORT, POLICE_REPORT, MEDICAL or UNKNOWN |
| `processing_status` | see below |
| `passport_id`, `unique_id` | only when the client is clearly identified (not for conflicts, provisional or ambiguous matches) |

`processing_status` uses the proposal's status names, most serious first:

| Status | When |
|---|---|
| `FAILED` | Something crashed (the step name is logged) |
| `CONFLICT` | Identity conflict, or passport data contradicts the record |
| `UNDEFINED` | Confidence below 40 |
| `UNCLEAR` | Confidence 40–59 |
| `MANUAL_REVIEW` | Identity needs checking, wrong document suspected, or police date unclear |
| `VERIFIED` / `HIGH_CONFIDENCE` / `SLIGHTLY_UNCLEAR` | Everything fine; the confidence band |

The file itself stays in `temporary/` in Supabase. Moving it is Phase 7.

## Related Files and Responsibilities

### Main processing

| File | What it does |
|---|---|
| `src/routes/whatsapp.js` | Receives WhatsApp messages and calls `processDocument()` for each stored document. |
| `src/services/documentProcessingService.js` | Runs all Phase 5 and 6 steps in order and updates the `temporary_data` row. |

### Phase 5

| File | What it does |
|---|---|
| `src/services/ocrService.js` | Gets the text out of a PDF or image (direct text, scanned-PDF OCR, image OCR). |
| `src/services/documentClassificationService.js` | Decides whether a document is a passport, police report, medical report or unknown. |
| `src/services/confidenceService.js` | Turns reading and classification quality into the proposal's confidence bands. |
| `src/services/passportExtractionService.js` | Reads passport fields from the passport text. |
| `src/services/policeReportDateService.js` | Finds and validates the submitted/issue date on a police document. |
| `src/utils/mrz.js` | Finds and decodes the passport MRZ lines and checks their check digits. |
| `src/utils/dateParsing.js` | Understands dates written in different formats and rejects impossible dates. |
| `src/utils/passportId.js` | Puts passport numbers into one standard format. |
| `src/utils/documentText.js` | Cleans up text so keyword matching works on messy OCR output. |

### Phase 6

| File | What it does |
|---|---|
| `src/services/userLookupService.js` | Finds users by passport number or WhatsApp number (read-only). |
| `src/services/identityVerificationService.js` | Decides who sent the document (the scenario table above). |
| `src/services/fieldReconciliationService.js` | Compares passport values with the user record and safely fills empty fields. |
| `src/utils/phoneNumber.js` | Puts phone numbers into one format for comparison. |
| `src/services/temporaryDataService.js` | Creates and updates `temporary_data` rows. |

## Testing Completed

Run with `npm test`. Real OCR tests are optional: `RUN_OCR_TESTS=1 npm test`.

**Result: 219 tests, all passing** (3 OCR tests are skipped unless enabled; with them enabled, 219/219 pass).

### Permanent project tests (`test/` folder)

| Test file | What it checks |
|---|---|
| `documentClassification.test.js` | Passport, police and medical classification; unknown and ambiguous documents; misleading filenames; filename used only when there's no text |
| `passportExtraction.test.js` | Valid, blurry, cropped and damaged passports; missing fields; missing passport number; malformed text |
| `mrz.test.js` | MRZ reading and check digits, including the official ICAO sample passport and OCR mix-ups |
| `dateParsing.test.js` | Date formats, day-first dates, impossible dates, passport number cleanup |
| `confidence.test.js` | Every band boundary, the three confidence values, flags, low-confidence OCR |
| `ocrService.test.js` | Text PDF, corrupt PDF, unsupported type; with OCR enabled: scanned PDF, image, blank image |
| `policeReportDate.test.js` | Valid, missing, invalid, future and conflicting dates |
| `userLookup.test.js` | Phone number formats, passport lookup, `unique_id` never used, shared numbers |
| `identityVerification.test.js` | Every identity scenario, for passports and for police/medical documents |
| `fieldReconciliation.test.js` | Match, fill, conflict and low confidence, including names; writes only for verified clients |
| `documentProcessing.test.js` | The whole flow end to end with a fake database, including failures and a check that logs contain no personal data |

### Synthetic test data

All test documents are made up. No real client data is used.

- `test/fixtures/documents/*.txt`: sample text for passports, police certificates and slips, medical reports, invoices, etc.
- `test/fixtures/files/`: a generated text PDF, a scanned (image-only) PDF, a medical report image, a blank image and a corrupt PDF.
- `test/helpers/fakePrisma.js`: an in-memory fake database, so tests never touch Supabase.

### Other checks done during development (not saved as tests)

- Database query shapes checked against the real generated Prisma client (without connecting to Supabase).
- Server started locally: `/health` answered, and the webhook rejected a wrong verify token and an unsigned POST.

## Manual Tests Still Required

These need the real WhatsApp number and the real Supabase database:

1. Send a real text-based passport PDF from the WhatsApp number stored for that client → expect `VERIFIED_MATCH`, `processing_status = VERIFIED`, and `passport_id` / `unique_id` set on the `temporary_data` row.
2. For a client with empty name or date fields, check they are filled correctly.
3. Send the same passport from another client's WhatsApp number → expect `CONFLICT` and no change to `users`.
4. Send a scanned police slip → expect `PDF_OCR`, `POLICE_REPORT`, police date status `RESOLVED`.
5. Send a phone photo of a passport → check the passport number is read and the confidence band makes sense.
6. Send a blank or blurry image → expect `UNDEFINED` or `MANUAL_REVIEW`.
7. Read the server logs → confirm no passport numbers, names, dates or full phone numbers appear.

## Known Limitations

- Tested only with synthetic documents; real scans may need keyword or label tuning.
- The police date is not stored (deferred to Phase 7/9).
- Nationality is not extracted (no column).
- Only the first 3 pages of a scanned PDF are read.
- Processing happens while WhatsApp waits for a reply. Scanned PDFs add about 1–2 seconds per page. This makes the existing duplicate-message risk (in-memory duplicate check) more likely. Moving work to the background is planned for a later phase (proposal §29).
- Conflict details have no database column; they are only in the log.
- Local phone numbers are treated as Sri Lankan; other countries' local formats won't match.
- Files that fail type/size validation are still not stored (earlier-phase behavior; the proposal's "undefined" storage area is Phase 7).

## Remaining Work

For Phase 5 and 6 themselves:

- Run the manual tests above with real documents and the real database.
- Tune classification keywords or passport labels if real documents need it.

Deferred to later phases (by decision, not missing):

- Store the police date and calculate the 21-day reminder (Phase 7/9).
- Rename documents and move them to permanent or undefined storage using the confidence band (Phase 7).
- Show conflicts and review cases to administrators (Phase 10).

## Next Recommended Checkpoint

**Phase 5/6 acceptance check with real data.** Run the manual tests above, note any misclassified documents or unread passport fields, and adjust the rules if needed. Only after that, start Phase 7 (naming and permanent storage), which will rely on the document type, confidence band and identity results produced here.
