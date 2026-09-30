# OCR and Document Processing

## Overview

The OCR and document processing module is responsible for reading incoming PDF or image documents and extracting useful text and document information.

The system is designed to process documents such as:

- Passports
- Police reports / police clearance documents
- Medical documents
- Other unknown documents

The document filename is not treated as the final source of truth.

A user may upload a passport using a filename such as:

```text
6325523527323.pdf
```

Therefore, the actual document content must also be analyzed.

## Document Processing Flow

```text
WhatsApp Document
        ↓
Media Download
        ↓
File Validation
        ↓
Initial Filename Classification
        ↓
Temporary Supabase Storage
        ↓
Text Extraction / OCR
        ↓
Content-Based Classification
        ↓
Confidence Handling
        ↓
Field Extraction
        ↓
Verification
        ↓
Rename
        ↓
Permanent Storage
```

## Initial Filename Classification

Before running full OCR processing, the backend checks whether the uploaded filename provides a useful document-type hint.

Examples:

```text
passport.pdf → PASSPORT
police_clearance.pdf → POLICE_REPORT
medical.pdf → MEDICAL
6325523527323.pdf → UNKNOWN
```

This is only an initial supporting signal.

The filename is not considered sufficient evidence for final document verification.

## File Validation

Before OCR processing, the backend validates the incoming file.

Current supported MIME types include:

```text
application/pdf
image/jpeg
image/png
```

The backend also checks file size before allowing further processing.

Invalid or unsupported files are rejected from the document-processing pipeline.

## PDF Text Extraction

Some PDF documents contain embedded selectable text.

For these documents, the backend uses `pdf-parse` to directly extract the text.

Example result:

```text
method: PDF_TEXT
success: true
textLength: 17991
```

Direct PDF text extraction is faster than image OCR when readable text already exists inside the PDF.

## Image OCR

For image files such as JPEG and PNG, the backend uses Tesseract OCR.

```text
Image
  ↓
Tesseract OCR
  ↓
Extracted Text
  ↓
OCR Confidence
```

The OCR output can later be used for:

- Document classification
- Passport number extraction
- Name extraction
- Date of birth extraction
- Passport expiry date extraction
- Police-report date extraction
- Other required document fields

## Scanned PDF Handling

A scanned PDF may contain images instead of selectable text.

The intended flow is:

```text
Scanned PDF
     ↓
Direct text extraction attempted
     ↓
Insufficient text
     ↓
Convert PDF page to image
     ↓
OCR
     ↓
Extract text
```

Scanned-PDF OCR fallback is implemented (method `PDF_OCR`): the first 3 pages are rendered and read with Tesseract. Corrupt PDFs are reported separately as `PDF_PARSE_FAILED`. See `Docs/06-phase-5-classification-ocr.md`.

## Content-Based Classification

Content-based classification analyzes the extracted text instead of relying only on the original filename. Implemented in Phase 5; see `Docs/06-phase-5-classification-ocr.md` for the exact indicators and rules.

Example passport signals may include:

```text
Passport
Nationality
Passport No
Date of Birth
Date of Expiry
MRZ
```

Police-report documents may contain signals such as:

```text
Police
Police Clearance
Certificate
Report
Issued Date
```

The final classification may result in:

```text
PASSPORT
POLICE_REPORT
MEDICAL
UNKNOWN
```

## Confidence Handling

Classification and OCR results use confidence values.

The final document workflow will use confidence thresholds to determine whether the document can be automatically processed or requires review.

Low-confidence or unclear documents must not be treated as fully verified documents.

## Temporary Storage

Documents are not permanently renamed immediately after being received.

Incoming files are first uploaded to the private Supabase Storage bucket using temporary UUID-based paths.

Example:

```text
temporary/080d7ee3-a020-4047-95ae-d215e4eb9328.pdf
```

The temporary record is also stored in the Supabase PostgreSQL `temporary_data` table.

Initially:

```text
documentType = UNCLASSIFIED
processingStatus = TEMPORARY_STORED
passportId = NULL
uniqueId = NULL
```

These values are updated later after classification and identity matching.

## Final Rename Flow

```text
Original:
6325523527323.pdf

        ↓ OCR

Document Type:
PASSPORT

Passport Number:
N1234567

        ↓ Verification

Final Naming:
N1234567_PASSPORT.pdf
```

The final naming convention will be applied only after sufficient classification and verification.

## Main Implementation Files

### `src/services/ocrService.js`

Responsible for:

- PDF text extraction
- Image OCR
- OCR result handling

### `src/services/documentClassificationService.js`

Responsible for:

- Initial filename-based classification
- Supporting classification signals

### `src/utils/fileValidation.js`

Responsible for:

- MIME validation
- File-size validation

### `src/services/temporaryStorageService.js`

Responsible for:

- Uploading temporary documents to the private Supabase bucket

### `src/services/temporaryDataService.js`

Responsible for:

- Creating temporary document records in PostgreSQL

## Current Status

Implemented:

- File validation
- Initial filename-based classification
- Supabase temporary storage
- Temporary database records
- Direct PDF text extraction
- Image OCR
- Scanned PDF OCR fallback
- Content-based classification
- Passport field extraction
- Confidence bands (proposal §17)
- Police report date extraction
- Identity verification and field reconciliation (Phase 6, see `Docs/07-phase-6-passport-verification.md`)

Next:

- Document rename rules (Phase 7)
- Permanent document storage (Phase 7)
- Temporary finalization (Phase 8)
- Police report countdown (Phase 9)
