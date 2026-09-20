# WhatsApp Document Submission & Client Management System
## Technical Project Proposal

**Prepared for:** Agency Management, Technical Team & Project Stakeholders
**Prepared by:** Solution Architecture Team
**Document Type:** Feature Extension Proposal — Existing WhatsApp Bot
**Status:** Revised Technical Proposal — implementation-ready architecture with clearly identified configuration items requiring agency confirmation

---

## Table of Contents

1. Executive Summary
2. Project Background
3. Business Problem
4. Proposed Solution
5. Project Objectives
6. Scope
7. Out of Scope
8. Existing System
9. Proposed System Architecture
10. Detailed Workflow
11. AI Document Processing
12. Database Architecture
13. Document/Object Storage Architecture
14. Client Identification Strategy
15. Staff Search & Retrieval
16. Security & Privacy
17. AI Cost Analysis
18. Data Extraction Strategy
19. ER Diagram
20. Activity Diagram
21. Sequence Diagram
22. Data Flow Diagram
23. Storage Structure Diagram
24. API Architecture
25. Error Handling
26. AI Accuracy & Human Verification
27. Scalability
28. Monitoring
29. Implementation Plan
30. Testing Strategy
31. Risks & Mitigation
32. Assumptions
33. Open Questions
34. Cost Considerations
35. Future Enhancements
36. Conclusion
37. Recommended Next Steps
38. Decision Log
39. Final Implementation Readiness Checklist

---

## 1. Executive Summary

The agency already operates a WhatsApp-based user bot that clients use to communicate. This proposal defines a new **Document Submission & Client Records feature** that extends the existing bot so clients can send required documents (passport, police report, birth certificate, educational and employment records, bank documents, photographs, visa documents, and others) directly through WhatsApp.

The system will automatically identify each client, classify the incoming document, extract structured data using a Google Cloud AI/OCR service, store extracted data in a relational database, store the original file in encrypted object storage, and let authorized staff retrieve a client's full document history by mobile number or passport number.

The proposal recommends an **internal UUID as the database primary key** (not the passport number), **asynchronous, queue-based AI processing** rather than synchronous processing, and a **document storage path keyed by internal client ID rather than passport number**. Reasons for each recommendation are detailed in Sections 12–14 and 29.

The proposal includes a cost model in Section 17. Pricing figures must be re-checked against the current official Google Cloud pricing pages immediately before client approval and procurement, because vendor pricing can change.

This is a **technical implementation proposal**. The architecture, database model, workflow, error-handling model, diagrams, security controls, and operational design are defined. A small set of business/configuration values — such as the final document list, extraction fields, support number, retention period, expected volume, and staff permissions — must be supplied by the agency before production configuration and final effort/cost approval.

---

## 2. Project Background

The agency uses WhatsApp as its primary client communication channel through an existing bot. Today, document collection for agency services (visa processing, employment placement, and similar case types) appears to happen outside that channel — by email, in person, or through other manual means — which the agency wants to consolidate into WhatsApp, the channel clients already use daily.

## 3. Business Problem

Manual or fragmented document collection creates avoidable overhead and risk:

- Staff spend time manually matching submitted documents to the right client file.
- Documents arriving through multiple channels are hard to keep organized and auditable.
- There is no single, searchable source of truth linking a client's identity (passport, mobile number) to every document they've submitted.
- Key data trapped inside PDF/image documents (passport number, dates, names) must be manually retyped for use in downstream agency processes.
- As volume grows, this manual approach does not scale and increases the chance of misfiled or lost documents.

## 4. Proposed Solution

Extend the existing WhatsApp bot with a **Document Intake Pipeline**:

1. Clients send documents as PDFs (and, where unavoidable, photos) directly in the existing WhatsApp conversation.
2. The bot validates and stores the file, then queues it for AI-based processing.
3. A backend service classifies the document type, extracts structured fields using a Google Cloud document-processing API, and identifies the submitting client — primarily via passport number when available, falling back to the WhatsApp mobile number otherwise.
4. Structured data is written to a SQL database; the original file is stored in versioned, access-controlled object storage.
5. The client receives a WhatsApp status message appropriate to the processing result: received, completed, needs resubmission, needs staff review, or processing failed.
6. Authorized staff search and retrieve a client's full record — profile, passport data, and every submitted document — by mobile number or passport number through a secure staff interface.
7. If the document type is missing, unknown, unsupported, or inconsistent with the expected document, the system sends a clear customer-facing message and the configured WhatsApp support number. Technical error details are never exposed to the customer.

## 5. Project Objectives

- Let clients submit any of 10+ document types via WhatsApp without learning a new tool.
- Automatically classify, extract, and structure key data from each document.
- Maintain one canonical client record per real-world person, avoiding duplicates.
- Give staff fast, auditable retrieval by mobile number or passport number.
- Keep sensitive personal documents encrypted, access-controlled, and auditable end to end.
- Build the data model and pipeline so new document types can be added by configuration, not by re-architecting the system.
- Give the agency a clear, evidence-based view of AI processing cost before committing to a depth of extraction.

## 6. Scope

- New backend service(s) that integrate with the existing WhatsApp bot's message/media webhook.
- Document validation, temporary storage, and virus/malware scanning.
- Integration with a Google Cloud AI/document-processing service for OCR, classification, and structured extraction.
- Relational database schema for clients, passports, mobile contacts, documents, and processing metadata.
- Object storage integration with a defined naming/versioning convention.
- Client identification and de-duplication logic.
- A staff-facing search/retrieval API and a defined human-verification workflow; a web UI may be implemented as part of the same phase or separately, but the backend review capability is required for production.
- Security controls: encryption, RBAC, audit logging, signed URLs.
- Monitoring and cost-tracking for AI usage.

## 7. Out of Scope

The following are explicitly **not** part of this feature unless the agency confirms otherwise (see Open Questions):

- Rebuilding or replacing the existing WhatsApp bot's core conversational logic.
- A full staff-facing web application UI (this proposal designs the API and data layer; a UI can be a follow-on phase).
- Legal/compliance certification (e.g., GDPR, PDPA, or country-specific data protection registration) — the agency must confirm which jurisdictions apply.
- Automated document authenticity/fraud verification (detecting forged passports) — flagged as a possible future enhancement, not included here.
- Payment processing or billing features.
- Migrating any historical documents already held outside this system, unless separately scoped.

## 8. Existing System

**Assumption (to be confirmed):** the existing WhatsApp bot already has a working WhatsApp Business API (or BSP) integration, can receive inbound media messages, and exposes some form of webhook or message-handling layer that this feature can hook into. The agency will provide the existing bot's architecture and API/document specifications separately (per the brief), and this proposal will be refined once those are reviewed. Where this proposal assumes a capability of the existing bot (e.g., "the bot can receive PDF attachments"), that assumption is listed in Section 32.

The new feature is designed as an **extension**, not a replacement: a new "document intake" capability is added to the bot's message-handling flow, and a new backend service family is introduced behind it. The existing bot's conversational flows for other purposes remain unchanged.

## 9. Proposed System Architecture

```mermaid
flowchart TB
    U[Client / User] -->|Sends document via chat| WA[WhatsApp Business Platform]
    WA <--> BOT[Existing WhatsApp Bot]
    BOT -->|New: document intent detected| GW[Document Intake API]
    GW --> VAL[Validation & Malware Scan]
    VAL --> TMP[(Temporary Staging Storage)]
    TMP --> Q[[Processing Queue]]
    Q --> WRK[AI Processing Worker]
    WRK --> AI[Google Cloud Document AI / Vision / Gemini]
    WRK --> DB[(SQL Database)]
    WRK --> OBJ[(Object Storage - Documents)]
    WRK --> NOTIFY[Notification Service]
    NOTIFY --> BOT
    STAFF[Agency Staff] --> STAFFAPI[Staff Search & Retrieval API]
    STAFFAPI --> DB
    STAFFAPI -->|Signed URL| OBJ
    ADMIN[Admin / Auth Service] --> STAFFAPI
    LOG[(Audit Log Store)] --- GW
    LOG --- STAFFAPI
    LOG --- WRK
```

**Key components**

| Component | Responsibility |
|---|---|
| Existing WhatsApp Bot | Existing conversational logic; forwards document-submission intents/media to the new Document Intake API |
| Document Intake API | Receives file references, validates them, writes to temporary staging, enqueues a processing job |
| Processing Queue | Decouples intake from AI processing (recommended: asynchronous — see Section 10) |
| AI Processing Worker | Calls the Google Cloud AI service, classifies the document, extracts fields, resolves the client identity, writes results |
| SQL Database | System of record for clients, passports, mobile numbers, documents metadata, extraction results, audit trail |
| Object Storage | System of record for original files, encrypted at rest, access-controlled via signed URLs |
| Staff Search & Retrieval API | Authenticated endpoint set for staff to look up clients and documents |
| Notification Service | Sends the WhatsApp confirmation/result back to the client through the existing bot |
| Audit Log Store | Immutable record of who accessed what, and when |

## 10. Detailed Workflow

The document-processing workflow is asynchronous and queue-based. The client receives an immediate acknowledgement, while validation, classification, extraction, client matching, persistence, and verification continue in the backend.

```mermaid
flowchart TD
    A[Client sends document via WhatsApp] --> B[Existing Bot receives message/media]
    B --> C[Document Intake API]
    C --> D{Webhook/message valid?}
    D -->|No| E1[Log invalid request]
    E1 --> E2[Send customer error + support number]
    D -->|Yes| F{File present and supported media type?}
    F -->|No| E3[Record DOC_MISSING or DOC_INVALID]
    E3 --> E4[Send customer error + support number]
    F -->|Yes| G[Validate size, MIME, extension and PDF/image structure]
    G --> H{File valid?}
    H -->|No| E5[Record DOC_INVALID / DOC_CORRUPTED / DOC_TOO_LARGE]
    E5 --> E6[Send customer error + support number]
    H -->|Yes| I[Malware / security scan]
    I --> J{Scan passed?}
    J -->|No| E7[Quarantine file + record security event]
    E7 --> E8[Send safe customer error + support number]
    J -->|Yes| K[Store in temporary staging]
    K --> L[Create RECEIVED document record + idempotency key]
    L --> M[Enqueue processing job]
    M --> N[Send 'received / processing' WhatsApp message]
    N --> O[AI classification]
    O --> P{Document type identified?}
    P -->|No| E9[Record DOC_TYPE_UNKNOWN]
    E9 --> E10[Set REVIEW_REQUIRED or request resubmission]
    E10 --> E11[Send unknown-document message + support number]
    P -->|Yes| Q{Document type supported?}
    Q -->|No| E12[Record DOC_TYPE_UNSUPPORTED]
    E12 --> E13[Send unsupported-document message + support number]
    Q -->|Yes| R{Document matches expected type / current request?}
    R -->|No| E14[Record DOC_TYPE_MISMATCH]
    E14 --> E15[Send wrong-document message + support number]
    R -->|Yes| S[Extract document-specific fields]
    S --> T{Required fields present and valid?}
    T -->|No| E16[Record DOC_REQUIRED_FIELD_MISSING or DOC_UNREADABLE]
    E16 --> E17[Request clearer / complete resubmission + support number]
    T -->|Yes| U[Validate formats, MRZ/checksum where applicable, confidence]
    U --> V{Client identified?}
    V -->|Passport match| W[Attach to existing client]
    V -->|Mobile/session match| X[Attach to existing or provisional client]
    V -->|No reliable match| Y[Create provisional client + REVIEW_REQUIRED]
    W --> Z[Persist structured data in SQL]
    X --> Z
    Y --> Z
    Z --> AA{Confidence and business rules passed?}
    AA -->|Yes| AB[Move/copy file to permanent object storage]
    AA -->|No| AC[Set REVIEW_REQUIRED]
    AC --> AD[Staff verifies/corrects data]
    AD --> AE{Staff verification successful?}
    AE -->|No| AF[Set FAILED or REQUEST_RESUBMISSION]
    AF --> AG[Send appropriate customer message + support number]
    AE -->|Yes| AB
    AB --> AH[Write audit log + processing history]
    AH --> AI[Set COMPLETED]
    AI --> AJ[Send successful WhatsApp confirmation]
```

### 10.1 Processing status lifecycle

```text
RECEIVED
  -> VALIDATING
  -> STORED
  -> QUEUED
  -> CLASSIFYING
  -> EXTRACTING
  -> MATCHING
  -> REVIEW_REQUIRED (when confidence/rules require human verification)
  -> VERIFIED
  -> COMPLETED

Failure paths:
  VALIDATING -> FAILED_VALIDATION
  CLASSIFYING -> DOC_TYPE_UNKNOWN / DOC_TYPE_UNSUPPORTED / DOC_TYPE_MISMATCH
  EXTRACTING -> FAILED_PROCESSING / DOC_UNREADABLE / DOC_REQUIRED_FIELD_MISSING
  Any transient infrastructure failure -> RETRY_PENDING -> PROCESSING
  Permanent failure after retry limit -> FAILED
```

### 10.2 Customer notification rules

The backend must not send a generic success message after every AI call. Notifications are tied to the final business state:

- **Received:** document has been received and is being processed.
- **Completed:** processing and validation completed successfully.
- **Needs resubmission:** the document is missing, unreadable, corrupted, unsupported, or the required information cannot be extracted.
- **Needs staff review:** the document was received but requires manual verification; the customer should not be told that extracted information is final.
- **Processing failed:** a recoverable/retried process ultimately failed; customer is given a safe retry message and support number.

### 10.3 Idempotency and retries

Every inbound WhatsApp media event must have an idempotency key based on the provider message/media identifier. Duplicate webhook deliveries must not create duplicate `DOCUMENTS` records or duplicate AI charges. Transient failures use exponential backoff with a bounded retry count. Permanently failed jobs move to a dead-letter/manual-review queue and remain auditable.

### 10.4 Support-number configuration

Customer-facing support messages use one centrally configured value rather than hard-coded text:

`SUPPORT_WHATSAPP_NUMBER=[AGENCY_SUPPORT_WHATSAPP_NUMBER]`

The production configuration must contain the agency's actual WhatsApp support number before go-live.

## 11. AI Document Processing

The brief proposed "Google Lens." Google Lens is a **consumer-facing product** (mobile app / visual search), not a production API suited to backend document pipelines, and it is not the right fit here. The relevant Google Cloud services are:

| Service | What it does | Best fit here |
|---|---|---|
| **Cloud Vision API** (`DOCUMENT_TEXT_DETECTION`) | Returns raw OCR text, layout blocks, and confidence scores; does not understand document semantics | Good low-cost fallback for plain OCR, or as a pre-check on scanned images |
| **Document AI — Enterprise Document OCR Processor** | Purpose-built document OCR (better than Vision for multi-page PDFs and forms) | General-purpose OCR layer for most document types |
| **Document AI — Prebuilt processors** (e.g., ID/passport-oriented processors) | Pretrained models that return structured key-value fields for common document types | Best fit for passports/IDs where a matching prebuilt processor exists |
| **Document AI — Custom Extractor / Form Parser** | Trainable processor returning custom structured fields (tables, key-value pairs) you define | Best fit for agency-specific documents (police reports, employment letters) that have no prebuilt Google processor |
| **Gemini API (multimodal)** | General-purpose LLM that can read an image/PDF and return extracted fields as JSON per a prompt/schema | Good fit for document types that are too varied/unstructured for a trainable extractor, or as the initial approach before investing in a custom-trained processor |

**Recommended approach (subject to confirmation — see Decision Log):**

1. **OCR/classification pass:** Document AI's Enterprise OCR Processor (or Cloud Vision as a lower-cost alternative) to get raw text and confirm the file is a real, legible document.
2. **Passport/MRZ extraction:** a Document AI processor suited to identity documents, since MRZ (Machine-Readable Zone) parsing benefits from a purpose-built model and checksum validation rather than free-form LLM extraction.
3. **Other document types (police report, education/employment/bank documents):** either a Document AI Custom Extractor trained per document type, or Gemini with a strict JSON schema prompt — the right choice depends on document volume and consistency of layout, and should be piloted with real (or representative) sample documents before final selection.

This is flagged as an **architectural decision requiring a short technical spike** with real sample documents from the agency before being finalized (see Decision Log, Section 38).

## 12. Database Architecture

### 12.1 Primary key: internal UUID vs. Passport Number

| Option | Advantages | Disadvantages |
|---|---|---|
| **Passport Number as primary key** | Simple business concept | Mutable on renewal/correction; OCR can be wrong; a client may exist before a passport is submitted; changing a natural key complicates foreign-key relationships |
| **Internal UUID as primary key, Passport Number as UNIQUE business identifier** | Stable references, supports provisional clients and passport renewals, safer foreign keys, supports identity correction without changing the client PK | Requires explicit client-resolution logic |

**Decision:** use `client_id` as the SQL primary key. Passport number is a unique business identifier in `PASSPORTS` when known. It is not the database primary key.

### 12.2 Mobile number

Mobile numbers are stored in a separate `MOBILE_CONTACTS` table. A client may have multiple numbers, while the WhatsApp sender number is recorded as the originating contact for each submission. Numbers are normalized to international E.164 format before matching. A mobile number should not be treated as an absolute identity proof when conflicting identity information exists; conflicts are routed to review.

### 12.3 Core tables

```mermaid
erDiagram
    CLIENTS ||--o{ MOBILE_CONTACTS : has
    CLIENTS ||--o{ PASSPORTS : owns
    CLIENTS ||--o{ DOCUMENTS : owns
    DOCUMENT_TYPES ||--o{ DOCUMENTS : classifies
    DOCUMENTS ||--o{ DOCUMENT_EXTRACTIONS : produces
    DOCUMENTS ||--o{ AI_PROCESSING_LOGS : has
    DOCUMENTS ||--o{ PROCESSING_ERRORS : may_have
    DOCUMENTS ||--o{ DOCUMENT_REVIEW_HISTORY : reviewed_in
    STAFF_USERS ||--o{ DOCUMENT_REVIEW_HISTORY : performs
    STAFF_USERS ||--o{ AUDIT_LOGS : performs
    CLIENTS ||--o{ AUDIT_LOGS : referenced_by
    DOCUMENTS ||--o{ AUDIT_LOGS : referenced_by
    STAFF_USERS ||--o{ AUDIT_LOGS : referenced_by

    CLIENTS {
        uuid client_id PK
        string full_name
        string nationality
        string gender
        date date_of_birth
        string address
        string status
        timestamp created_at
        timestamp updated_at
    }
    MOBILE_CONTACTS {
        uuid contact_id PK
        uuid client_id FK
        string mobile_number UK
        string country_code
        boolean is_whatsapp_primary
        boolean is_verified
        timestamp created_at
        timestamp updated_at
    }
    PASSPORTS {
        uuid passport_id PK
        uuid client_id FK
        string passport_number UK
        string issuing_country
        date date_of_issue
        date date_of_expiry
        string mrz_raw
        decimal extraction_confidence
        boolean is_current
        timestamp created_at
        timestamp updated_at
    }
    DOCUMENT_TYPES {
        uuid document_type_id PK
        string type_code UK
        string display_name
        boolean requires_passport_link
        jsonb expected_fields_schema
        boolean active
    }
    DOCUMENTS {
        uuid document_id PK
        uuid client_id FK
        uuid document_type_id FK
        string source_message_id UK
        string storage_path UK
        string original_filename
        string mime_type
        bigint file_size_bytes
        string sha256_hash
        int version_number
        string status
        string classification_confidence
        timestamp uploaded_at
        timestamp processed_at
    }
    DOCUMENT_EXTRACTIONS {
        uuid extraction_id PK
        uuid document_id FK
        jsonb extracted_fields
        string confidence_level
        boolean requires_review
        boolean reviewed
        uuid reviewed_by_staff_id FK
        string processor_version
        timestamp extracted_at
    }
    AI_PROCESSING_LOGS {
        uuid log_id PK
        uuid document_id FK
        string ai_service_used
        string processor_version
        int pages_processed
        numeric estimated_cost_usd
        string result_status
        text error_message
        timestamp started_at
        timestamp processed_at
    }
    PROCESSING_ERRORS {
        uuid error_id PK
        uuid document_id FK
        string error_code
        string error_type
        text customer_message_key
        text technical_details
        int retry_count
        boolean customer_notified
        timestamp created_at
        timestamp resolved_at
    }
    DOCUMENT_REVIEW_HISTORY {
        uuid review_id PK
        uuid document_id FK
        uuid staff_id FK
        string action
        jsonb before_data
        jsonb after_data
        text review_notes
        timestamp created_at
    }
    STAFF_USERS {
        uuid staff_id PK
        string username UK
        string role
        boolean active
        timestamp created_at
        timestamp updated_at
    }
    AUDIT_LOGS {
        uuid audit_id PK
        uuid staff_id FK
        uuid client_id FK
        uuid document_id FK
        string action
        string ip_address
        text details
        timestamp occurred_at
    }
```

### 12.4 Important constraints and indexes

- `CLIENTS.client_id` is the immutable primary key.
- `PASSPORTS.passport_number` is unique after normalization; it may be nullable until a passport is captured.
- `MOBILE_CONTACTS.mobile_number` is indexed; uniqueness policy should allow historical numbers if the business requires it, while preventing two active clients from claiming the same verified WhatsApp number without review.
- `DOCUMENTS.source_message_id` is unique to enforce webhook idempotency.
- `DOCUMENTS.sha256_hash` is indexed for duplicate-file detection.
- Index `PASSPORTS.passport_number`, `MOBILE_CONTACTS.mobile_number`, `DOCUMENTS.client_id`, `DOCUMENTS.status`, and `PROCESSING_ERRORS.error_code`.
- Foreign keys use stable UUIDs, not passport numbers.

### 12.5 Client merge and correction

If later evidence shows that two provisional client records represent the same person, the system must support a controlled staff-approved merge. The merge operation records the source client, target client, staff user, reason, timestamp, and affected documents. A destructive delete should not be used as the normal merge mechanism; the audit trail must remain intact.

### 12.6 Passport renewal

A passport renewal creates a new `PASSPORTS` record linked to the same `client_id` and marks the previous passport as non-current. Documents remain associated with the client and retain their historical passport relationship where applicable.

## 13. Document/Object Storage Architecture

### 13.1 Storage keyed by internal Client ID, not Passport Number

The brief's example structure used the passport number as the top-level folder name. This is **not recommended**:

- A passport number is personally identifiable and, if it ever leaked via a storage path, URL, or log line, would directly expose a real government ID number — the internal UUID is opaque and safe to appear in logs, URLs, and paths.
- A client may have documents before a passport is captured (e.g., a police report submitted first); an internal ID always exists, a passport number might not yet.
- If a passport number is corrected after an OCR error, a passport-number-keyed folder would need to be renamed everywhere; a UUID-keyed folder never needs to change.

### 13.2 Recommended naming convention

```text
{client_id}/{document_type}/{unique_document_id}_{version}.pdf
```

Example:
```text
7f3c2e10-4b2a-4e9e-9a3d-1a2b3c4d5e6f/passport/a1b2c3d4-e5f6-4789-a0b1-c2d3e4f5a6b7_v1.pdf
7f3c2e10-4b2a-4e9e-9a3d-1a2b3c4d5e6f/police_report/b2c3d4e5-f6a7-4890-b1c2-d3e4f5a6b7c8_v1.pdf
```

Rationale: never trust the original filename (clients may send `IMG_0234.pdf` or a filename in another script); the `unique_document_id` is generated server-side and is what the database references, so the file itself carries no ambiguity even if copied outside the system.

### 13.3 Additional storage considerations

| Concern | Approach |
|---|---|
| Versioning / re-uploads | New upload of an existing document type creates a new version row (`version_number` increments); prior versions are retained, not overwritten, unless a retention policy says otherwise |
| Duplicate detection | Compute a SHA-256 hash on upload; if it matches an existing document for the same client, flag as duplicate rather than storing a redundant copy |
| Metadata | MIME type, file size, upload timestamp, and hash are stored in the `documents` table, not only in the file itself |
| Encryption | Server-side encryption at rest (bucket-level, e.g., Google Cloud Storage default CMEK/Google-managed encryption); TLS in transit |
| Access control | No file is ever served by a public/direct URL; staff and the client-facing bot receive time-limited **signed URLs** generated on demand |
| Retention & deletion | Retention period must be defined by the agency based on its record-keeping and legal obligations (see Open Questions); deletion should be a soft-delete first (marks record inactive, revokes access) with a scheduled hard-delete job |
| Backup | Object storage should use the cloud provider's cross-region replication or scheduled bucket-to-bucket backup; the SQL database needs point-in-time backup separately |
| Audit logs | Every read (signed URL issuance) and write is logged with staff/service identity, timestamp, and document ID |

## 14. Client Identification Strategy

### 14.1 Passport ID as primary identifier, mobile number as secondary

Passport number is the strongest identifier when available (globally unique per issuing country + number, versus a mobile number which can be shared, changed, or reassigned by a telecom). The recommended precedence:

1. If a passport has been captured, `passport_number` is the authoritative link to a `client_id`.
2. Until then, the WhatsApp mobile number is used as a **provisional** identifier, with the resulting record flagged `passport_pending`. When a passport later arrives from that same number, the provisional record is upgraded/merged rather than a second record being created.

### 14.2 Mobile number edge cases

| Case | Handling |
|---|---|
| International formats / country codes | Normalize to E.164 format (`+<country code><number>`) at intake; never store local-format-only numbers |
| Duplicate mobile numbers across clients | Extremely unlikely for a genuine same number, but if it occurs (e.g., recycled SIM), the system should flag it for staff review rather than silently merging two different people |
| Client changes phone number | Old number is kept in `mobile_contacts` (marked inactive) rather than deleted, preserving history; new number is added and flagged as WhatsApp-primary |
| Multiple numbers per client | Supported directly by the `mobile_contacts` table design |
| WhatsApp number vs. personal contact number | The WhatsApp-originating number is always captured as `is_whatsapp_primary = true`; a different personal/office number can be added later by staff if the agency's process requires it |

## 15. Staff Search & Retrieval

```mermaid
flowchart LR
    S[Staff logs in] --> AUTH[Authentication + Role Check]
    AUTH --> SEARCH[Search by Passport Number OR Mobile Number]
    SEARCH --> DB[(SQL Database Lookup)]
    DB --> FOUND{Client Found?}
    FOUND -->|Yes| PROFILE[Return Client Profile + Document List]
    FOUND -->|No| NONE[No match — logged as a search event]
    PROFILE --> ACCESS{Staff role authorized for this document type?}
    ACCESS -->|Yes| SIGNED[Generate time-limited Signed URL]
    ACCESS -->|No| DENY[Access denied — logged]
    SIGNED --> AUDIT[Audit log entry written]
```

Authorization requirements: staff accounts are role-based (e.g., `intake_clerk`, `case_officer`, `admin`), and each role is scoped to which document types and actions (view metadata vs. view/download original file) it can perform. Every search and every document access is written to the audit log with staff identity, timestamp, and the client/document accessed — not just failures.

## 16. Security & Privacy

| Area | Approach |
|---|---|
| Encryption in transit | TLS 1.2+ for all API traffic, including WhatsApp webhook calls, AI service calls, and staff API calls |
| Encryption at rest | Database encryption at rest (managed by the cloud SQL provider); object storage server-side encryption |
| Access control / RBAC | Role-based permissions for staff; principle of least privilege; service-to-service calls (worker → DB, worker → storage) use scoped service accounts, not shared credentials |
| Staff authentication | Standard username/password with MFA recommended, or SSO if the agency has an existing identity provider |
| API authentication | Signed service-to-service tokens (e.g., OAuth2 client credentials) between internal services; the WhatsApp webhook itself authenticated per the WhatsApp/BSP provider's signature verification |
| Secure document access | No permanent public links; all downloads via short-lived signed URLs |
| Audit logging | Immutable, append-only log of all document access, searches, and administrative actions |
| Secrets management | API keys and service credentials stored in a managed secrets vault (e.g., Google Secret Manager), never in code or config files |
| Rate limiting | Applied at the API gateway to prevent abuse of both the intake endpoint and the AI processing pipeline |
| Malware/file scanning | All uploaded files scanned before being handed to the AI service or moved to permanent storage |
| PDF validation | Structural validation (well-formed PDF, page count limits) before processing |
| File size limits | Enforced at intake, with a clear client-facing WhatsApp error message if exceeded |
| Duplicate detection | SHA-256 hash comparison at intake, as described in Section 13 |

**Sending personal documents to a third-party AI service:** Passport and other identity documents will be transmitted to Google Cloud's AI/document-processing APIs for extraction. This is a material privacy consideration the agency should evaluate directly with Google Cloud's data processing terms (Google does not use Cloud AI API customer content to train its general models by default, but the agency should verify the current terms for the specific service selected) and against **the specific data-protection laws of the countries in which the agency and its clients operate** — this proposal does not make a legal determination and the agency should seek confirmation from qualified legal counsel or its compliance function before processing personal identity documents at scale.

## 17. AI Cost Analysis

### 17.1 Pricing used (official sources, as published)

| Service | Price | Source |
|---|---|---|
| Google Cloud Vision API, `DOCUMENT_TEXT_DETECTION` | First 1,000 units/month free, then $1.50 per 1,000 units | Google Cloud Vision pricing |
| Document AI — Enterprise Document OCR Processor | First 1,000 pages/month free, then $1.50 per 1,000 pages (0–5M/month), $0.60 per 1,000 pages above 5M/month | cloud.google.com/document-ai/pricing |
| Document AI — Custom Extractor / Form Parser | $30 per 1,000 pages (up to 1M/month), $20 per 1,000 pages above 1M/month | cloud.google.com/document-ai/pricing |
| Gemini 2.5 Flash-Lite (API) | $0.10 per 1M input tokens, $0.40 per 1M output tokens | ai.google.dev/gemini-api/docs/pricing (as reported August 2026) |
| Gemini 2.5 Flash (API) | $0.30 per 1M input tokens, $2.50 per 1M output tokens | ai.google.dev/gemini-api/docs/pricing (as reported August 2026) |
| Gemini 2.5 Pro (API) | $1.25 per 1M input tokens, $10.00 per 1M output tokens | ai.google.dev/gemini-api/docs/pricing (as reported September 2026) |

> These are the vendor's published list prices at the time of writing and are subject to change; the agency should re-confirm current rates on the official pricing pages before budgeting, and these numbers exclude any GCP infrastructure, storage, networking, or engineering costs.

### 17.2 Scenario assumptions (stated explicitly, not implied as fact)

- Average of **3 documents submitted per client** during onboarding (passport + 2 supporting documents), each averaging **2 pages**.
- Enterprise OCR Processor used for classification/OCR of every page; a Custom Extractor (or equivalent Gemini call) used only for pages that need structured field extraction (assume all pages, worst case, for Option B; assume only the passport page, best case, for Option A).
- These are illustrative planning numbers, not a guarantee of actual usage — the agency's real document mix and page counts should replace these once known (see Open Questions).

### 17.3 Option A — Minimal extraction (passport fields only; other documents OCR'd but not deeply structured)

Per client: 3 documents × 2 pages = 6 OCR pages, plus 2 structured-extraction pages (passport only, assuming 2-page passport data spread incl. MRZ).

| Clients/month | OCR pages (Enterprise OCR) | Structured pages (Custom Extractor) | OCR cost | Extraction cost | Total/month |
|---|---|---|---|---|---|
| 100 | 600 | 200 | $0.90* | $6.00 | ~$6.90 |
| 500 | 3,000 | 1,000 | $3.00 | $30.00 | ~$33.00 |
| 1,000 | 6,000 | 2,000 | $7.50 | $60.00 | ~$67.50 |
| 5,000 | 30,000 | 10,000 | $43.50 | $300.00 | ~$343.50 |

\* First 1,000 OCR pages/month are free; figures above net that out at low volume and are illustrative.

### 17.4 Option B — Detailed extraction (structured fields from every submitted document, not just the passport)

Per client: 3 documents × 2 pages = 6 pages, **all** routed through structured extraction.

| Clients/month | Structured pages (Custom Extractor, $30/1,000) | Total/month |
|---|---|---|
| 100 | 600 | $18.00 |
| 500 | 3,000 | $90.00 |
| 1,000 | 6,000 | $180.00 |
| 5,000 | 30,000 | $900.00 |

### 17.5 Comparison and recommendation

| Factor | Option A (minimal) | Option B (detailed) |
|---|---|---|
| AI/API cost | Lower | Higher, but still modest at these volumes (well under $1/client even at 5,000 clients/month) |
| Processing time | Slightly faster | Slightly slower per document, negligible with async processing |
| Database storage | Smaller | Larger, but structured text is cheap to store relative to the AI cost of producing it |
| Future business value | Lower — re-processing needed later if more data is ever required | Higher — fields are available immediately for future case work without re-scanning archived documents |
| Accuracy | N/A (not extracting from those documents at all) | Depends on document quality; requires the human-verification workflow in Section 26 regardless |
| Privacy | Marginally less data sent/retained | More personal data extracted and stored — increases the importance of the access controls in Section 16 |
| Complexity | Simpler to build initially | Slightly more processor/prompt configuration up front, but same pipeline shape |
| Reprocessing | Likely needed later if requirements grow | Avoided, since data was captured the first time |

**Observation:** at the volumes modeled, the incremental AI cost of Option B over Option A is on the order of tens to a few hundred dollars per month even at 5,000 clients/month — small relative to the value of not having to re-collect or re-scan documents later if the agency's case work needs more fields down the line. However, this trades off against **more personal data being extracted and retained**, which raises the privacy stakes discussed in Section 16. **This is a business decision, not a purely technical one**, and is listed in the Decision Log for the agency to confirm, ideally after a short pilot with real document samples to validate actual page counts and extraction quality per document type.

## 18. Data Extraction Strategy

Recommended default field sets per document type (to be confirmed/extended per Open Questions):

**Passport:** passport number, full name, date of birth, nationality, gender, date of issue, date of expiry, MRZ string (for checksum validation).

**Police report:** full name, date of report, reference number, address, issuing police station, report type/category.

**Other document types** (birth certificate, educational certificates, employment documents, bank documents, visa documents, photographs): field sets should be defined with agency input per type, since these vary far more by jurisdiction and issuing authority than passports do — each is modeled as configurable via the `document_types.expected_fields_schema` column (Section 12.3) so adding a document type is a configuration change, not a schema migration.

## 19. ER Diagram

The ER diagram below is the canonical version for this proposal. It includes document-processing errors, staff review history, audit relationships, idempotency metadata, passport history, and mobile contacts.

```mermaid
erDiagram
    CLIENTS ||--o{ MOBILE_CONTACTS : has
    CLIENTS ||--o{ PASSPORTS : owns
    CLIENTS ||--o{ DOCUMENTS : owns
    DOCUMENT_TYPES ||--o{ DOCUMENTS : classifies
    DOCUMENTS ||--o{ DOCUMENT_EXTRACTIONS : produces
    DOCUMENTS ||--o{ AI_PROCESSING_LOGS : has
    DOCUMENTS ||--o{ PROCESSING_ERRORS : may_have
    DOCUMENTS ||--o{ DOCUMENT_REVIEW_HISTORY : reviewed_in
    STAFF_USERS ||--o{ DOCUMENT_REVIEW_HISTORY : performs
    STAFF_USERS ||--o{ AUDIT_LOGS : performs
    CLIENTS ||--o{ AUDIT_LOGS : referenced_by
    DOCUMENTS ||--o{ AUDIT_LOGS : referenced_by

    CLIENTS {
        uuid client_id PK
        string full_name
        string nationality
        date date_of_birth
        string address
        string status
        timestamp created_at
        timestamp updated_at
    }
    MOBILE_CONTACTS {
        uuid contact_id PK
        uuid client_id FK
        string mobile_number UK
        boolean is_whatsapp_primary
        boolean is_verified
    }
    PASSPORTS {
        uuid passport_id PK
        uuid client_id FK
        string passport_number UK
        string issuing_country
        date date_of_issue
        date date_of_expiry
        boolean is_current
    }
    DOCUMENT_TYPES {
        uuid document_type_id PK
        string type_code UK
        string display_name
        boolean active
    }
    DOCUMENTS {
        uuid document_id PK
        uuid client_id FK
        uuid document_type_id FK
        string source_message_id UK
        string storage_path UK
        string sha256_hash
        string status
        timestamp uploaded_at
        timestamp processed_at
    }
    DOCUMENT_EXTRACTIONS {
        uuid extraction_id PK
        uuid document_id FK
        jsonb extracted_fields
        string confidence_level
        boolean requires_review
        uuid reviewed_by_staff_id FK
        string processor_version
        timestamp extracted_at
    }
    AI_PROCESSING_LOGS {
        uuid log_id PK
        uuid document_id FK
        string ai_service_used
        string processor_version
        int pages_processed
        numeric estimated_cost_usd
        string result_status
        timestamp processed_at
    }
    PROCESSING_ERRORS {
        uuid error_id PK
        uuid document_id FK
        string error_code
        string error_type
        text technical_details
        int retry_count
        boolean customer_notified
        timestamp created_at
        timestamp resolved_at
    }
    DOCUMENT_REVIEW_HISTORY {
        uuid review_id PK
        uuid document_id FK
        uuid staff_id FK
        string action
        jsonb before_data
        jsonb after_data
        text review_notes
        timestamp created_at
    }
    STAFF_USERS {
        uuid staff_id PK
        string username UK
        string role
        boolean active
    }
    AUDIT_LOGS {
        uuid audit_id PK
        uuid staff_id FK
        uuid client_id FK
        uuid document_id FK
        string action
        text details
        timestamp occurred_at
    }
```

`PROCESSING_ERRORS` is intentionally part of the ERD so failed validation, unknown document types, unsupported document types, extraction failures, retry exhaustion, and infrastructure errors can be persisted and audited rather than being lost in application logs.

## 20. Activity Diagram

```mermaid
flowchart TD
    Start([Client sends document]) --> Recv[Bot receives document]
    Recv --> Idem{Duplicate webhook/message?}
    Idem -->|Yes| IdemEnd[Return existing processing status]
    Idem -->|No| ValidFile{File present and valid?}
    ValidFile -->|No| RejectMsg[Record validation error + send customer error/support number]
    RejectMsg --> End1([End])
    ValidFile -->|Yes| ScanMalware{Malware scan passed?}
    ScanMalware -->|No| Quarantine[Quarantine + security alert + customer safe error]
    Quarantine --> End2([End])
    ScanMalware -->|Yes| TempStore[Store temporary file]
    TempStore --> Enqueue[Enqueue processing job]
    Enqueue --> Ack[Send received/processing message]
    Ack --> AIProc[AI classify + extract]
    AIProc --> AIResult{AI call successful?}
    AIResult -->|No| Retry{Retry available?}
    Retry -->|Yes| Enqueue
    Retry -->|No| ProcError[PROCESSING_ERROR + FAILED/manual queue]
    ProcError --> NotifyFail[Send processing-failed message + support number]
    NotifyFail --> End3([End])
    AIResult -->|Yes| DupCheck{Duplicate file hash?}
    DupCheck -->|Yes| DupRecord[Link/record duplicate submission]
    DupRecord --> NotifyDup[Send duplicate/already-received message]
    NotifyDup --> End4([End])
    DupCheck -->|No| TypeCheck{Document type identified and supported?}
    TypeCheck -->|Unknown| Unknown[DOC_TYPE_UNKNOWN + review/resubmission]
    Unknown --> UnknownMsg[Send unknown-document message + support number]
    UnknownMsg --> End5([End])
    TypeCheck -->|Unsupported| Unsupported[DOC_TYPE_UNSUPPORTED]
    Unsupported --> UnsupportedMsg[Send unsupported-document message + support number]
    UnsupportedMsg --> End6([End])
    TypeCheck -->|Mismatch| Mismatch[DOC_TYPE_MISMATCH]
    Mismatch --> MismatchMsg[Send wrong-document message + support number]
    MismatchMsg --> End7([End])
    TypeCheck -->|Valid| Extract[Extract required fields]
    Extract --> Required{Required fields valid?}
    Required -->|No| Missing[DOC_REQUIRED_FIELD_MISSING / DOC_UNREADABLE]
    Missing --> MissingMsg[Request clear/complete resubmission + support number]
    MissingMsg --> End8([End])
    Required -->|Yes| Match[Resolve client by passport/mobile/session rules]
    Match --> Confidence{Confidence and business validation passed?}
    Confidence -->|No| Review[REVIEW_REQUIRED]
    Review --> Staff[Staff verifies/corrects fields]
    Staff --> ReviewOK{Verified?}
    ReviewOK -->|No| StaffResubmit[Request customer resubmission or mark failed]
    StaffResubmit --> End9([End])
    ReviewOK -->|Yes| Persist[Persist verified data]
    Confidence -->|Yes| Persist[Persist verified data]
    Persist --> Permanent[Move to permanent object storage]
    Permanent --> Audit[Write audit + processing history]
    Audit --> Complete[COMPLETED]
    Complete --> Success[Send success confirmation]
    Success --> End10([End])
```

## 21. Sequence Diagram

```mermaid
sequenceDiagram
    participant U as Client
    participant WA as WhatsApp
    participant Bot as Existing Bot
    participant API as Document Intake API
    participant Store as Staging/Object Storage
    participant Q as Processing Queue
    participant Worker as AI Worker
    participant AI as Google AI Service
    participant DB as SQL Database
    participant Notify as Notification Service
    participant St as Staff

    U->>WA: Send document
    WA->>Bot: Message + media reference
    Bot->>API: Forward message/media metadata
    API->>DB: Check idempotency key
    alt Duplicate webhook
        DB-->>API: Existing document found
        API-->>Bot: Return existing status
    else New document
        API->>API: Validate file, size, MIME and security rules
        alt Invalid file
            API->>DB: Write PROCESSING_ERROR
            API->>Notify: Send customer error + support number
            Notify->>WA: Error message
            WA-->>U: Clear correction instructions
        else Valid file
            API->>Store: Save temporary staging file
            API->>DB: Create RECEIVED/STORED document record
            API->>Q: Enqueue processing job
            API->>Notify: Send received message
            Notify->>WA: "Document received, processing..."
            Q->>Worker: Deliver processing job
            Worker->>AI: Classify + extract
            AI-->>Worker: Type + fields + confidence
            alt Unknown/unsupported/wrong document type
                Worker->>DB: Write PROCESSING_ERROR + status
                Worker->>Notify: Send specific error + support number
                Notify->>WA: Specific customer message
                WA-->>U: Correction/support instructions
            else Valid document
                Worker->>DB: Resolve client + persist extraction
                alt Low confidence / validation failure
                    Worker->>DB: Set REVIEW_REQUIRED
                    St->>API: Open review task
                    API->>DB: Load extraction + original file metadata
                    St->>API: Confirm/correct data
                    API->>DB: Save review history + verified data
                end
                Worker->>Store: Move/copy to permanent path
                Worker->>DB: Write audit + processing log
                Worker->>DB: Set COMPLETED
                Worker->>Notify: Send completion message
                Notify->>WA: Success confirmation
                WA-->>U: Document processed
            end
        end
    end

    St->>API: Search by passport/mobile
    API->>DB: Query client + document metadata
    DB-->>API: Matching records
    API-->>St: Profile + document metadata
    St->>API: Request document
    API->>Store: Generate signed URL
    Store-->>API: Short-lived signed URL
    API->>DB: Write access audit event
    API-->>St: Secure document URL
```

## 22. Data Flow Diagram

```mermaid
flowchart LR
    subgraph Raw
        A[Raw PDF/Image from WhatsApp]
    end
    subgraph Processing
        B[AI Extraction]
    end
    subgraph Structured
        C[(Structured Data - SQL)]
    end
    subgraph Files
        D[(Original Document - Object Storage)]
    end
    subgraph StaffSide
        E[Search Request]
        F[Staff Response: Profile + Secure Links]
    end

    A -->|Sent for processing| B
    B -->|Extracted fields + metadata| C
    A -->|Stored as-is, encrypted| D
    E -->|Passport # or Mobile #| C
    C -->|Match found| F
    F -->|Signed URL request| D
    D -->|Time-limited link| F
```

Raw documents flow only into processing and permanent storage — never directly to staff. Structured data and metadata flow into the database and are what staff search against. Staff responses combine database records with on-demand, time-limited links to the original files; nothing is ever exposed as a static/public link.

## 23. Document Storage Structure Diagram

```mermaid
flowchart TD
    Bucket[Document Bucket] --> C1[client_id: 7f3c2e10-...]
    C1 --> P1[passport/]
    P1 --> P1F[unique_document_id_v1.pdf]
    C1 --> PR1[police_report/]
    PR1 --> PR1F[unique_document_id_v1.pdf]
    C1 --> OT1[bank_documents/]
    OT1 --> OT1F[unique_document_id_v1.pdf]
    Bucket --> C2[client_id: 9a1b8c22-...]
    C2 --> P2[passport/]
    P2 --> P2F[unique_document_id_v1.pdf]
```

## 24. API Architecture

Proposed endpoints (subject to refinement once the existing bot's API is reviewed):

| Method & Path | Purpose |
|---|---|
| `POST /v1/documents/intake` | Internal — bot forwards a received document reference for validation + queuing |
| `POST /v1/documents/{documentId}/process` | Internal — triggers/retries AI processing for a staged document |
| `GET /v1/documents/{documentId}` | Retrieve document metadata (staff-authenticated) |
| `GET /v1/documents/{documentId}/download-url` | Generate a short-lived signed URL (staff-authenticated, audited) |
| `GET /v1/clients/by-passport/{passportNumber}` | Staff search by passport number |
| `GET /v1/clients/by-mobile/{mobileNumber}` | Staff search by mobile number |
| `GET /v1/clients/{clientId}` | Full client profile |
| `GET /v1/clients/{clientId}/documents` | All documents for a client |
| `GET /v1/documents/{documentId}/status` | Processing status (queued/processing/complete/needs-review/failed) |
| `POST /v1/auth/login` | Staff authentication |
| `GET /v1/audit-logs` | Admin-only audit trail query |

These are a proposed starting point, not a final contract, and should be reconciled with the existing bot's API conventions once shared.

## 25. Error Handling

Error handling is split into **customer-safe messages**, **internal technical diagnostics**, **retryable failures**, and **manual-review failures**. Customers never receive stack traces, SQL errors, provider error payloads, API keys, or internal identifiers.

### 25.1 Standard error codes

| Error Code | Meaning | Customer action | Backend action |
|---|---|---|---|
| `DOC_MISSING` | No document/media attached | Send the required document | Record error; do not enqueue |
| `DOC_INVALID` | Unsupported file format or malformed media | Send supported PDF/image | Record error; do not enqueue |
| `DOC_TOO_LARGE` | File exceeds configured limit | Send smaller/compressed file | Record error; do not enqueue |
| `DOC_CORRUPTED` | File cannot be opened/read | Re-export or resend file | Record error; do not enqueue |
| `DOC_UNREADABLE` | Scan/image quality prevents reliable extraction | Send clearer complete copy | Route to resubmission |
| `DOC_TYPE_UNKNOWN` | AI cannot identify document type | Send correct document or contact support | Set `REVIEW_REQUIRED`/resubmission |
| `DOC_TYPE_UNSUPPORTED` | Document type is not configured | Send a supported document or contact support | Record unsupported type |
| `DOC_TYPE_MISMATCH` | Document is different from the expected/requested type | Send the requested document | Record mismatch |
| `DOC_REQUIRED_FIELD_MISSING` | Required field cannot be extracted | Send clearer/complete document | Route to resubmission/review |
| `CLIENT_MATCH_CONFLICT` | Passport/mobile/session identifiers conflict | Contact support if requested | Route to staff review; never auto-merge |
| `AI_PROCESSING_FAILED` | AI processing failed after retries | Resend or contact support | Retry then dead-letter/manual queue |
| `DB_WRITE_FAILED` | Database persistence failed | No action unless requested | Retry transaction/job |
| `STORAGE_FAILED` | Object-storage operation failed | No action unless requested | Retry job; do not mark complete |
| `WHATSAPP_SEND_FAILED` | Notification delivery failed | No action; message may retry | Retry notification and alert if persistent |
| `SYSTEM_ERROR` | Unexpected internal failure | Contact support | Log full technical details and alert |

### 25.2 Customer-facing messages

The following messages are the standard templates. Replace `[SUPPORT NUMBER]` with the configured agency WhatsApp support number before production.

**Document received**

> We received your document and are processing it. We will send you an update once processing is complete.

**Missing document**

> We did not receive a document with your message. Please send the required document as a PDF or supported image. If you need help, please contact our WhatsApp Support Team: **[SUPPORT NUMBER]**.

**Invalid/corrupted document**

> We could not open or process the document you sent. Please check that the file is valid and send it again. If the issue continues, please contact our WhatsApp Support Team: **[SUPPORT NUMBER]**.

**Document too large**

> The document you sent is larger than the allowed file size. Please reduce the file size and send it again. If you need assistance, please contact our WhatsApp Support Team: **[SUPPORT NUMBER]**.

**Wrong document type**

> We could not process this document because it does not appear to be the required document type. Please send the requested document as a clear PDF or supported image. If you need assistance, please contact our WhatsApp Support Team: **[SUPPORT NUMBER]**.

**Document type cannot be identified**

> We could not identify the type of document you sent. Please send a clear and complete document. If you are unsure which document to send, please contact our WhatsApp Support Team: **[SUPPORT NUMBER]**.

**Unsupported document type**

> The document you sent is not currently supported by our system. Please send one of the requested document types. If you need assistance, please contact our WhatsApp Support Team: **[SUPPORT NUMBER]**.

**Unreadable/missing information**

> We could not read some of the required information in your document. Please send a clearer, complete copy with all relevant information visible. For assistance, please contact our WhatsApp Support Team: **[SUPPORT NUMBER]**.

**Processing failed**

> We could not complete the processing of your document at this time. Please try sending it again. If the problem continues, please contact our WhatsApp Support Team: **[SUPPORT NUMBER]**.

**Needs staff review**

> We received your document, but it requires an additional verification step. Our team will review it before the information is finalized. If you need assistance, please contact our WhatsApp Support Team: **[SUPPORT NUMBER]**.

**Duplicate document**

> We have already received this document. No further action is required unless our team asks you to send an updated copy. For assistance, please contact our WhatsApp Support Team: **[SUPPORT NUMBER]**.

### 25.3 Internal error handling rules

1. Every processing failure creates a `PROCESSING_ERRORS` record.
2. Retryable errors use bounded exponential backoff.
3. Non-retryable validation errors are not repeatedly sent to the AI service.
4. AI/provider failures are retried without requiring the customer to resend the document.
5. Duplicate WhatsApp webhook deliveries are idempotent.
6. A document is never marked `COMPLETED` until the required database and object-storage writes succeed.
7. Customer notification failure does not roll back successful document processing; notification delivery is a separate retryable job.
8. Permanent failures move to a dead-letter/manual-review queue.
9. Technical details are stored internally and are never copied into customer messages.
10. Every staff correction or manual classification is audited.

## 26. AI Accuracy & Human Verification

```mermaid
flowchart TD
    Extract[AI Extracted Data] --> Rules[Validation: format, required fields, MRZ/checksum where applicable]
    Rules --> Conf{Confidence + validation passed?}
    Conf -->|High| Auto[Automatic verification]
    Conf -->|Low / conflict| Review[REVIEW_REQUIRED]
    Review --> StaffCheck[Staff reviews original document + extracted fields]
    StaffCheck --> Correct[Correct / confirm extracted data]
    Correct --> History[Write DOCUMENT_REVIEW_HISTORY + AUDIT_LOGS]
    History --> Auto
    Auto --> Complete[COMPLETED]
```

Fields that should be validated before being treated as authoritative include passport number, MRZ/checksum where available, date of birth, passport expiry date, and full name. The system should combine AI confidence, schema validation, format rules, and identity consistency checks. The exact confidence threshold should be determined during the pilot using labeled sample documents.

### Human verification requirements

The production design requires a staff-review capability, even if the first release does not include a full web UI. At minimum, the backend must support:

- A queue of `REVIEW_REQUIRED` documents.
- Retrieval of the original document through a short-lived signed URL.
- Display of extracted fields and confidence indicators.
- Staff correction/confirmation of fields.
- Mandatory review reason/notes for material corrections.
- Review history and audit trail.
- Controlled reprocessing after correction when required.

AI/OCR extraction must not be described as proof that a document is genuine. Authenticity/fraud detection is a separate capability and remains outside the current scope.

## 27. Scalability

| Volume | Considerations |
|---|---|
| 100 clients | Single small worker instance, standard managed SQL tier sufficient |
| 1,000 clients | Add database indexes on `passport_number`, `mobile_number`, `client_id`; queue-based processing already isolates load spikes |
| 10,000 clients | Consider read replicas for staff search queries; monitor AI API quota/rate limits and request increases proactively |
| 100,000+ clients | Horizontal scaling of worker pool; object storage scales natively; database partitioning/sharding strategy should be evaluated at this scale; caching layer for frequent staff searches |

Additional considerations throughout: connection pooling on the database, autoscaling worker instances against queue depth, and search-optimized indexing on the two lookup keys staff will use most (passport number, mobile number).

## 28. Observability & Monitoring

Recommended metrics and logs: application logs (intake, processing, staff API), AI processing logs with per-call cost estimate (already modeled in `ai_processing_logs`, Section 12.3), API latency and error rate, queue depth over time, document processing success/failure rate, count of documents routed to human review, database and storage utilization/health, and a running **AI cost dashboard** derived from the `estimated_cost_usd` field logged per call — directly supporting the cost governance discussed in Section 17.

## 29. Implementation Plan

| Phase | Activities | Deliverables | Dependencies | Outcome |
|---|---|---|---|---|
| 1. Requirements & Architecture | Confirm open questions, review existing bot's API/spec, finalize document type list and fields | Approved architecture document | Agency input on Open Questions | Shared understanding before build starts |
| 2. Database Implementation | Build schema, migrations, indexing | Deployed SQL schema | Phase 1 | Data layer ready |
| 3. Object Storage | Configure buckets, naming convention, encryption, signed URL issuance | Storage service integrated | Phase 1 | Files can be stored/retrieved securely |
| 4. AI Document Processing | Pilot Document AI/Gemini options, select processors per document type, build extraction pipeline | Working extraction pipeline with confidence thresholds | Phases 2–3, sample documents from agency | Documents can be classified and extracted |
| 5. WhatsApp Bot Integration | Hook intake flow into existing bot, build client-facing confirmation messages | Integrated document intake in the live bot | Existing bot spec, Phase 4 | Clients can submit documents end to end |
| 6. Staff Search Functionality | Build search/retrieval API (and UI if scoped), RBAC | Working staff search | Phases 2–3 | Staff can retrieve client records |
| 7. Security & Audit Logging | Implement RBAC, signed URLs, audit trail, secrets management | Security review sign-off | Phases 2–6 | System meets baseline security bar |
| 8. Testing | Execute test plan (Section 30) | Test report | All prior phases | Confidence in correctness and resilience |
| 9. Deployment | Production rollout, cutover plan, rollback plan | Live production system | Phase 8 sign-off | Feature live for real clients |
| 10. Monitoring & Maintenance | Dashboards, alerting, cost tracking live | Operating runbook | Phase 9 | Ongoing visibility and support |

## 30. Testing Strategy

- **Unit testing:** validation logic, client-matching logic, field normalization.
- **Integration testing:** end-to-end intake → AI → DB → storage flow with test documents.
- **API testing:** staff search/retrieval endpoints, auth, and error responses.
- **AI extraction testing:** accuracy against a labeled sample set per document type; confidence-threshold tuning.
- **WhatsApp testing:** message/media delivery, confirmation messages, failure messaging.
- **Database testing:** duplicate-prevention logic, transactional integrity under concurrent submissions.
- **Security testing:** access control enforcement, signed URL expiry, audit log completeness.
- **Performance testing:** queue behavior under burst load, AI API rate-limit handling.
- **User acceptance testing:** agency staff validate search/retrieval against real (or realistic) scenarios.
- **Failure/recovery testing:** simulate AI outage, storage outage, and database outage and confirm graceful degradation and recovery.

## 31. Risks & Mitigation

| Risk | Impact | Probability | Mitigation |
|---|---|---|---|
| AI extraction inaccuracies | Incorrect client data, misfiled documents | Medium | Confidence-based human verification (Section 26), validation rules |
| AI API cost increases with volume | Budget overrun | Low–Medium | Cost monitoring dashboard, alerts on unexpected volume spikes, periodic pricing review |
| Third-party AI service downtime | Processing delays | Low | Queue-based design absorbs outages; retries; fallback to a secondary OCR path if warranted |
| Privacy/data exposure | Regulatory and reputational risk | Medium | Encryption, RBAC, signed URLs, audit logging, legal review of jurisdictional requirements |
| Duplicate client records | Fragmented client history | Medium | Passport-number uniqueness constraint, provisional-record merge logic |
| Incorrect passport extraction | Wrong client match | Medium | MRZ checksum validation, confidence thresholds, staff review queue |
| Storage failures | Data loss | Low | Backups, cross-region replication, versioning |
| WhatsApp API limitations | Delivery/media constraints | Low–Medium | Confirm limits with existing bot's provider during Phase 1 |
| Large document volumes / bursts | Processing backlog | Medium | Queue-based, autoscaling workers |
| Vendor lock-in (Google Cloud AI) | Harder to switch providers later | Medium | Keep extraction logic behind an internal abstraction layer so the underlying AI provider can be swapped |
| Staff unauthorized access | Data breach | Low–Medium | RBAC, MFA, audit logging, least-privilege service accounts |

## 32. Assumptions

- The existing WhatsApp bot is operational and has a working WhatsApp Business API/BSP integration.
- The existing bot can receive and forward PDF (and likely image) attachments to a new backend service.
- The agency will provide the existing bot's architecture and API/document specifications for integration design.
- The agency will confirm the required document types and the fields to extract per type.
- The agency will define staff roles and access requirements.
- Cloud infrastructure (Google Cloud, for AI services and optionally hosting) will be made available/provisioned.
- The agency will provide or arrange the necessary AI/API credentials.
- The agency will confirm applicable legal/privacy requirements for the jurisdictions it operates in.

## 33. Open Questions and Production Configuration

The architecture is complete, but the following business inputs must be confirmed before production configuration and final effort/cost estimation. They are configuration decisions, not unresolved architecture defects.

1. **Supported document list:** confirm the final 10+ document types.
2. **Required fields:** confirm fields to extract for each document type.
3. **Volume:** confirm clients/month, documents/client, average pages/document, peak submissions, and maximum file size.
4. **Passport coverage:** confirm countries/passport formats to be supported.
5. **Expired passports:** confirm acceptance and business handling.
6. **Retention:** confirm retention periods for original files, extracted data, logs, and backups.
7. **Staff roles:** confirm who can search, view, download, correct, merge, and delete/archive records.
8. **Human-review UI:** confirm whether the staff UI is included in this phase; the backend review capability is required either way.
9. **Privacy/data residency:** confirm applicable jurisdictions, contractual requirements, and approved Google Cloud region(s).
10. **AI service selection:** finalize per document type after the technical pilot.
11. **AI budget:** confirm approved monthly AI-processing budget and alert thresholds.
12. **Extraction depth:** confirm which document types need detailed extraction versus minimal identity/status extraction.
13. **Passport renewals:** use the same `client_id` with historical passport records unless the agency specifies a different business rule.
14. **Multiple mobile numbers:** confirm staff-approved merge/verification policy for conflicting numbers.
15. **WhatsApp support number:** provide the production support number to replace `[SUPPORT NUMBER]` and configure `SUPPORT_WHATSAPP_NUMBER`.
16. **WhatsApp provider limits:** confirm media size, supported MIME types, webhook retry behavior, and message/template requirements with the existing provider.
17. **Disaster recovery:** confirm required RPO/RTO and backup retention.

### 33.1 Required production configuration

```text
SUPPORT_WHATSAPP_NUMBER=[AGENCY_SUPPORT_WHATSAPP_NUMBER]
MAX_DOCUMENT_SIZE_MB=[CONFIRM_LIMIT]
ALLOWED_MIME_TYPES=[CONFIRM_TYPES]
DOCUMENT_RETENTION_DAYS=[CONFIRM_POLICY]
AI_MONTHLY_BUDGET_USD=[CONFIRM_BUDGET]
GOOGLE_CLOUD_REGION=[CONFIRM_REGION]
```

The values above are intentionally placeholders because the source requirements do not provide the agency's actual support number, file limit, retention policy, budget, or cloud region. They must not be invented in the final implementation.

## 34. Cost Considerations

### One-time development costs (to be estimated once scope is finalized)
Backend development (intake API, worker service), database schema and migrations, WhatsApp bot integration work, AI pipeline integration and prompt/processor tuning, object storage integration, staff search API (and UI if in scope), security implementation, and testing.

### Recurring costs
- AI API usage (see Section 17 for a data-backed model).
- Cloud compute for backend services and workers.
- Managed SQL database hosting.
- Object storage (including redundancy/backup storage).
- WhatsApp Business API/BSP messaging costs (governed by the agency's existing provider agreement, not part of this proposal).
- Monitoring/alerting tooling.
- Ongoing maintenance and support.

Exact one-time development pricing depends on team rates and final scope and is intentionally not estimated here — the agency should request a separate effort/cost estimate once Sections 33's open questions are answered and the phased plan in Section 29 is scoped in detail.

## 35. Future Enhancements

- Automated document authenticity/fraud detection.
- Staff-facing web UI with dashboards (beyond the API-first design here).
- Multi-language OCR/extraction expansion as client base grows.
- Automated passport-expiry reminders to clients via WhatsApp.
- Self-service client portal for viewing their own submission status.
- Analytics on document-type volume and processing turnaround time.

## 36. Conclusion

This proposal extends the agency's existing WhatsApp bot with a structured, auditable document intake pipeline that identifies clients reliably, extracts key data using appropriate Google Cloud AI services, and gives staff fast, secure retrieval by passport number or mobile number. The architecture favors an internal UUID-based data model, asynchronous AI processing, and UUID-keyed storage over the passport-number-keyed approach originally sketched, for the security and maintainability reasons detailed above. The AI cost analysis, grounded in Google's published pricing, indicates the AI processing cost itself is modest relative to likely business value even at higher extraction depth — but this, along with several other decisions below, needs the agency's explicit confirmation before implementation begins.

## 37. Recommended Next Steps

1. Agency to provide the existing WhatsApp bot's architecture and API/message specifications.
2. Agency to answer the Open Questions in Section 33, particularly document types, expected volume, and retention requirements.
3. Run a short technical pilot with a handful of real (or representative/anonymized) sample documents per type to validate the AI service selection in Section 11 and refine the cost model in Section 17.
4. Confirm the Decision Log items below with the appropriate business and legal stakeholders.
5. Once confirmed, proceed to a detailed effort/cost estimate for Phases 1–10 (Section 29).

## 38. Decision Log

| Decision | Current decision/status |
|---|---|
| Database primary key | **Confirmed architecture:** internal UUID `client_id` |
| Passport identifier | **Confirmed architecture:** normalized unique business identifier in `PASSPORTS`; not SQL PK |
| Mobile identifier | **Confirmed architecture:** normalized contact record in `MOBILE_CONTACTS`; conflicts require review |
| Processing model | **Confirmed architecture:** asynchronous queue-based processing |
| Error persistence | **Confirmed architecture:** `PROCESSING_ERRORS` + application logs + audit trail |
| Webhook idempotency | **Confirmed architecture:** unique `source_message_id` / provider message identifier |
| Document duplicate detection | **Confirmed architecture:** SHA-256 hash plus business-level duplicate rules |
| Human verification | **Confirmed requirement:** `REVIEW_REQUIRED` workflow and review history |
| Customer support escalation | **Confirmed requirement:** all relevant customer errors include configured WhatsApp support number |
| Customer technical-error exposure | **Confirmed rule:** never expose stack traces, provider errors, database errors, or internal IDs |
| Passport renewal | **Proposed default:** new passport record under same client |
| Google AI service per document type | Pending technical pilot using representative samples |
| Extraction depth | Pending agency business decision by document type |
| Approved AI budget | Pending agency confirmation |
| Retention period | Pending agency/legal confirmation |
| Staff roles and permissions | Pending agency confirmation |
| Staff UI scope | Pending agency confirmation; backend review capability is required |
| Supported document types and fields | Pending final agency list |
| WhatsApp support number | Pending agency value; required before production |
| Cloud region/data residency | Pending agency/legal confirmation |
| RPO/RTO and backup retention | Pending agency confirmation |

## 39. Final Implementation Readiness Checklist

Before production go-live, confirm all of the following:

- [ ] Existing WhatsApp bot webhook/media API reviewed and integration contract approved.
- [ ] Final document-type list approved.
- [ ] Required extraction fields approved per document type.
- [ ] Representative sample documents available for AI pilot/testing.
- [ ] AI processor/model selected per document type and pricing verified against current official pricing.
- [ ] SQL schema/migrations deployed and constraints tested.
- [ ] Object storage bucket, encryption, lifecycle, versioning, and signed URLs configured.
- [ ] Malware/file validation implemented.
- [ ] Webhook idempotency implemented and tested.
- [ ] Queue retry and dead-letter handling implemented.
- [ ] `PROCESSING_ERRORS` and audit logging implemented.
- [ ] `REVIEW_REQUIRED` staff workflow implemented.
- [ ] Client merge/unmerge controls and audit trail implemented.
- [ ] Passport renewal/history handling tested.
- [ ] Customer-facing error messages approved.
- [ ] Actual WhatsApp support number configured in `SUPPORT_WHATSAPP_NUMBER`.
- [ ] Staff RBAC and least-privilege access tested.
- [ ] Retention, backup, RPO/RTO, and data-residency decisions approved.
- [ ] AI cost alerts and monitoring dashboard configured.
- [ ] End-to-end failure/recovery tests passed.
- [ ] Production rollback/runbook approved.

