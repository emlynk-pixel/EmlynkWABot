# EmlynkWABot Documentation: Start Here

EmlynkWABot receives candidate documents over WhatsApp, reads them with OCR (passports, police slips and similar), and gives staff an admin dashboard to review, verify and track each candidate through to deployment. It also runs a public Candidate Form, Google Sheet sync and in-app notifications.

The root [`README.md`](../README.md) is the repository's entry point (installation, quick start, the full API endpoint list): start there for "how do I run this", and here for "how does this work, and why". Step-by-step setup of a new environment is in [`Deployment/`](../Deployment/README.md).

## Recommended reading order for new developers

1. [01-Getting-Started/01-project-overview.md](01-Getting-Started/01-project-overview.md): what the system is and why it exists
2. [02-Architecture/02-system-architecture.md](02-Architecture/02-system-architecture.md): the components and the overall flow
3. [02-Architecture/03-database-design.md](02-Architecture/03-database-design.md): the data model
4. [01-Getting-Started/11-development-guide.md](01-Getting-Started/11-development-guide.md): run it locally
5. [01-Getting-Started/CODING_STANDARDS.md](01-Getting-Started/CODING_STANDARDS.md): the rules code is reviewed against
6. [03-Backend/07-backend-development.md](03-Backend/07-backend-development.md): the backend layout and route map
7. The folder for the area you are working on (table below)

## Folders

| Folder | What is in it |
|---|---|
| [01-Getting-Started/](01-Getting-Started/README.md) | Project overview, development guide, coding standards |
| [02-Architecture/](02-Architecture/README.md) | System architecture, database design, storage management |
| [03-Backend/](03-Backend/README.md) | Backend development, API calls and performance audit |
| [04-Admin-Dashboard/](04-Admin-Dashboard/README.md) | Admin dashboard API reference and operator guide |
| [05-Candidate-Management/](05-Candidate-Management/README.md) | Candidate management, list filters and pagination, bulk import, the Candidate Form |
| [06-Jobs-and-Clients/](06-Jobs-and-Clients/README.md) | Job management, agent and client management |
| [07-Integrations/](07-Integrations/README.md) | WhatsApp, OCR, Google Sheets, notifications, email templates |
| [08-Security-and-Access/](08-Security-and-Access/README.md) | Security overview, Supabase Auth, roles and permissions, security risk assessments |
| [09-Deployment/](09-Deployment/README.md) | Cloud deployment and the release process |
| [10-Testing-and-Quality/](10-Testing-and-Quality/README.md) | Testing, quality and audit reports |
| [Visa Submission/](Visa%20Submission/README.md) | The visa submission feature: guide and architecture |
| [New changes/](New%20changes/) | Dated notes on recent changes |
| [History/](History/README.md) | Past issues and solutions, informal backlog |
| [archive/](archive/) | Original phase-by-phase documents the living documents were consolidated from (table below) |

**Naming.** Files keep their original names. Several are referenced by name from source-code comments and migrations. Update the document that owns a topic in place rather than adding a new dated file.

## Archive

[`archive/`](archive/) keeps the original phase-by-phase documents in full: development logs, dated audit and bug reports, and the original project proposal. They hold historical detail the living documents intentionally don't repeat (commit hashes, point-in-time test counts, day-by-day decisions). **If a living document and an archived one disagree, the living document is correct**; several corrections were made against the running code during consolidation (e.g. storage path format, confidence-band boundaries, the old admin session cookie's `SameSite` value).

| Archived document | Original topic | Now covered by |
|---|---|---|
| [01-initial-backend-database-setup.md](archive/01-initial-backend-database-setup.md) | First backend and database setup log | 03, 11 |
| [02-seed-data.md](archive/02-seed-data.md) | Seed data | 03 |
| [03-admin-authentication.md](archive/03-admin-authentication.md) | The original (pre-Supabase) admin authentication | 10, SUPABASE_AUTH |
| [04-whatsapp-security.md](archive/04-whatsapp-security.md) | Webhook security | 04, 10 |
| [05-ocr-document-processing-v1.md](archive/05-ocr-document-processing-v1.md) | First OCR / document processing design | 05 |
| [06-phase-5-classification-ocr.md](archive/06-phase-5-classification-ocr.md) | Phase 5: classification and OCR | 05 |
| [07-phase-6-passport-verification.md](archive/07-phase-6-passport-verification.md) | Phase 6: passport verification | 05 |
| [08-code-quality-and-bug-report.md](archive/08-code-quality-and-bug-report.md) | Dated code-quality and bug report | 12 |
| [09-code-optimization-review.md](archive/09-code-optimization-review.md) | Dated optimization review | 12 |
| [10-phase-5-6-development-summary.md](archive/10-phase-5-6-development-summary.md) | Phases 5–6 development summary | 05 |
| [11-phase-7-permanent-storage.md](archive/11-phase-7-permanent-storage.md) | Phase 7: permanent storage design | 06 |
| [12-phase-7-development-summary.md](archive/12-phase-7-development-summary.md) | Phase 7 development summary | 06 |
| [13-security-overview.md](archive/13-security-overview.md) | Original security overview and findings | 10 |
| [14-phase-10-admin-dashboard.md](archive/14-phase-10-admin-dashboard.md) | Phase 10 admin dashboard log | 09a |
| [15-admin-dashboard-reference.md](archive/15-admin-dashboard-reference.md) | Original admin dashboard reference | 09b |
| [16-project-summary.md](archive/16-project-summary.md) | Technical project summary | 01, 02 |
| [17-full-code-audit-report.md](archive/17-full-code-audit-report.md) | Dated full code audit | 12 |
| [18-ocr-worker-cloud-run.md](archive/18-ocr-worker-cloud-run.md) | OCR worker Cloud Run handoff | 08 Part 1 |
| [19-backend-cloud-run-deployment.md](archive/19-backend-cloud-run-deployment.md) | Backend Cloud Run / Vercel deployment log | 08 Part 2 |
| [phase-7-issues-and-fixes.md](archive/phase-7-issues-and-fixes.md) | Phase 7 issues and fixes | 05, 06 |
| [whatsapp-document-processing-proposal.md](archive/whatsapp-document-processing-proposal.md) | The original project proposal (business case, requirements; the `§` numbers other documents cite) | 01 |

Also in this folder, not documentation: `DB.txt` (local-only notes, gitignored, never committed).
