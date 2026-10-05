# Project Overview

Consolidates the introduction of the original project proposal with the later technical project summary. The full original proposal (business case, legacy data mapping, detailed requirements by section) is kept in full in `Docs/archive/` (`whatsapp-document-processing-proposal.md`, plus the PDF it was originally delivered as).

## What EmlynkWABot Is

EmlynkWABot is an automated document processing, identity reconciliation and verification system for visa and immigration workflow automation. It ingests document submissions from clients over WhatsApp, processes them through an asynchronous pipeline, performs OCR and classification, validates client identity against existing records, securely archives files into private cloud storage, and provides an administrative console with role-based access control and an audit trail.

## Origin

The project began as an enhancement to an existing WhatsApp-based document-processing workflow that a client-services team was running manually, using data tracked in a legacy Excel workbook (passport numbers, names, dates of birth, WhatsApp/contact numbers, police-report and medical status). The original proposal intentionally kept the new database small: four tables (`admins`, `users`, `documents`, `temporary_data`), with `users.passport_id` as the primary identity and `users.unique_id` as a separate, never-interchangeable business reference. The schema has since grown (audit logging, admin invitations, password reset, rate limiting — see `03-database-design.md`), but this original identity rule is unchanged and remains the most important rule in the system: **`passport_id` is the identity; `unique_id` and the WhatsApp number are never used in its place.**

## Main Purpose

- Ingest client documents (passports, police clearance slips, police clearance reports, medical clearance certificates) over WhatsApp messaging.
- Decouple webhook ingestion from compute-heavy processing, so WhatsApp/Meta webhooks receive prompt acknowledgements regardless of OCR latency.
- Extract structured metadata using OCR (Tesseract.js) and Machine Readable Zone (MRZ) parsing.
- Automatically associate submissions with existing registered clients by matching passport numbers or sender phone numbers.
- Calculate deterministic document confidence scores and classify files into confidence bands.
- Enforce duplicate detection using SHA-256 cryptographic hashes.
- Route low-confidence, ambiguous, unclassified or conflicting documents into a review queue for human administrator decision-making.
- Track a 21-day countdown for police clearance reports, triggered by submitted police slips.
- Provide a secure, role-based administrative console with an immutable audit log.

## Document Types Handled

- International passports
- Police clearance slips (the receipt given on application)
- Police clearance reports (the final certificate)
- Medical clearance certificates

## Where to Go Next

| Topic | Document |
|---|---|
| Architecture and components | `02-system-architecture.md` |
| Database schema | `03-database-design.md` |
| WhatsApp ingestion | `04-whatsapp-integration.md` |
| OCR, classification, identity | `05-ocr-document-processing.md` |
| Document storage rules | `06-storage-management.md` |
| Backend code structure | `07-backend-development.md` |
| Production deployment | `08-cloud-deployment.md` |
| Admin dashboard | `09a-admin-dashboard-api.md`, `09b-admin-dashboard-guide.md` |
| Security | `10-security.md` |
| Local setup and coding standards | `11-development-guide.md` |
| Testing | `12-testing-and-quality.md` |
