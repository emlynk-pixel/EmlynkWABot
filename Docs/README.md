# EmlynkWABot Documentation

This folder is the project's technical documentation, reorganized into one numbered set of living documents. Each covers one topic and supersedes the older, phase-by-phase documents it replaced — those originals are kept in full, unedited, in [`archive/`](archive/) for historical reference, never deleted.

The root [`README.md`](../README.md) (outside this folder) is the repository's own entry point — installation, quick start, the full API endpoint list. Start there for "how do I run this." Start here for "how does this actually work, and why."

## Where to Start

New to the project? Read in this order: `01` → `02` → `03`, then whichever of `04`–`10` covers what you're working on.

## Documents

| # | Document | Covers |
|---|---|---|
| 01 | [Project Overview](01-project-overview.md) | What the system is, its origin, its main purpose |
| 02 | [System Architecture](02-system-architecture.md) | Components, data flow, production deployment topology |
| 03 | [Database Design](03-database-design.md) | Schema, models, the passport_id/unique_id identity rule, migration history |
| 04 | [WhatsApp Integration](04-whatsapp-integration.md) | Webhook verification, HMAC signatures, message idempotency |
| 05 | [OCR & Document Processing](05-ocr-document-processing.md) | Text extraction, classification, confidence bands, identity resolution |
| 06 | [Storage Management](06-storage-management.md) | Bucket layout, placement rules, naming, duplicate detection |
| 07 | [Backend Development](07-backend-development.md) | Source layout, the three process entry points, API routes |
| 08 | [Cloud Deployment](08-cloud-deployment.md) | OCR worker + backend/worker/Vercel deployment, step by step |
| 09a | [Admin Dashboard — API Reference](09a-admin-dashboard-api.md) | Developer/API reference for the admin dashboard |
| 09b | [Admin Dashboard — Operator Guide](09b-admin-dashboard-guide.md) | Screens, workflows, day-to-day use for admin staff |
| 10 | [Security](10-security.md) | Authentication, RBAC, storage/database access control |
| 11 | [Development Guide](11-development-guide.md) | Local setup, git workflow (coding standards are their own file, below) |
| 12 | [Testing & Quality](12-testing-and-quality.md) | Running the test suites, test-double conventions |

Also in this folder, not part of the numbered set:

| Document | Why it's separate |
|---|---|
| [`CODING_STANDARDS.md`](CODING_STANDARDS.md) | A short, scannable reference (naming, error handling, security, git conventions) meant to be jumped to directly, not read start-to-end |
| `DB.txt` | Local-only notes, gitignored, never committed — not documentation |
| `Updates.txt` | An informal running backlog, not a finished document |

## Archive

[`archive/`](archive/) holds the complete, unedited originals that were consolidated into the numbered documents above: phase-by-phase development logs, dated audit/bug reports, and the original project proposal. They're kept because they contain real historical detail (exact commit hashes, point-in-time test counts, day-by-day decisions) that the living documents intentionally don't repeat. If a living document and an archived one ever disagree, the living, numbered document is correct — several factual corrections were made during consolidation (e.g. storage path format, confidence-band boundaries, the admin session cookie's `SameSite` value) against the actual running code.

## Keeping This Current

When something changes: update the numbered document that owns the topic, not a new dated file. A new phase-by-phase log is exactly the pattern that made the previous documentation hard to navigate — prefer editing the living document in place.
