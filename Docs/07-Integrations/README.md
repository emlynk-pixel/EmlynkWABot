# 07 Integrations

**Purpose:** everything that connects the system to the outside world: WhatsApp, OCR, Google Sheets, notifications and email.

## Files, in reading order

| Document | What it covers |
|---|---|
| [04-whatsapp-integration.md](04-whatsapp-integration.md) | Webhook verification, HMAC signatures, message idempotency, message handling flow |
| [05-ocr-document-processing.md](05-ocr-document-processing.md) | Text extraction, classification, passport fields, confidence rules, police-slip dates, identity verification |
| [GOOGLE_SHEET_INTEGRATION.md](GOOGLE_SHEET_INTEGRATION.md) | **Start here for Sheet Sync.** Both tabs, outbox, write gate, Cloud Run worker, endpoints, deployment, troubleshooting, and the Operational Mirror feature reference |
| [GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md](GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md) | The design specification: scope contract, business rules, sync and reconciliation architecture, security, ADRs, risks, runbook |
| [13-notifications-guide.md](13-notifications-guide.md) | Beginner guide to the in-app notification system: how it works, how to test and deploy it |
| [NOTIFICATION_SYSTEM_AUDIT.md](NOTIFICATION_SYSTEM_AUDIT.md) | Research only (not implemented): proposed Crucial / Optional notifications, recipients, dedup rules, detection gaps |
| [email-templates/](email-templates/README.md) | Supabase invite and password-reset email templates |

## Related

- [../05-Candidate-Management/CANDIDATE_BULK_IMPORT.md](../05-Candidate-Management/CANDIDATE_BULK_IMPORT.md): Update Sheet bulk import
- [../../ocr-worker/README.md](../../ocr-worker/README.md): the OCR worker service
- [../02-Architecture/06-storage-management.md](../02-Architecture/06-storage-management.md): where processed documents are stored
