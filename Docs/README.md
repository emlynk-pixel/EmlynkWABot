# EmlynkWABot Documentation

This folder is the project's technical documentation. The root [`README.md`](../README.md) is the repository's entry point (installation, quick start, the full API endpoint list): start there for "how do I run this", and here for "how does this work, and why".

## Where to Start

New to the project? Read `01` → `02` → `03`, then [`11-development-guide.md`](11-development-guide.md) to run it locally, then the document for the area you are working on. Before writing code, read [`CODING_STANDARDS.md`](CODING_STANDARDS.md).

**Naming.** Numbered, lower-case files (`01-…` to `20-…`) are the core topics. Upper-case files are feature-specific documents; several of them are referenced by name from source-code comments and migrations, so they keep their names. Update the document that owns a topic in place rather than adding a new dated file.

## Getting Started

| Document | What it covers |
|---|---|
| [01-project-overview.md](01-project-overview.md) | What the system is, its origin, its purpose and the document types it handles |
| [11-development-guide.md](11-development-guide.md) | Prerequisites, local setup, running the processes, local OCR, webhook testing, git workflow |
| [CODING_STANDARDS.md](CODING_STANDARDS.md) | Short, scannable coding rules: naming, errors, async, database, storage, security, logging, testing, git |

## Architecture

| Document | What it covers |
|---|---|
| [02-system-architecture.md](02-system-architecture.md) | Components, high-level workflow, production topology, confidence bands, why this architecture |
| [07-backend-development.md](07-backend-development.md) | Backend source layout, key modules, the API route map, environment variables |

## Database

| Document | What it covers |
|---|---|
| [03-database-design.md](03-database-design.md) | Part 1: models, the passport_id / unique_id identity rule, relationships, migration history, seed data, local setup. Part 2: detailed table-by-table schema, roles, Supabase Auth link, migration notes, foreign keys, audit-log triggers, Prisma notes, naming and migration rules (formerly `DATABASE_IMPLEMENTATION.md`) |

## Backend: WhatsApp, OCR and Storage

| Document | What it covers |
|---|---|
| [04-whatsapp-integration.md](04-whatsapp-integration.md) | Webhook verification, HMAC signatures, message idempotency, message handling flow |
| [05-ocr-document-processing.md](05-ocr-document-processing.md) | Text extraction, classification, passport fields, confidence rules, police-slip dates, identity verification |
| [06-storage-management.md](06-storage-management.md) | Bucket layout, placement rules, naming, checksums and duplicates, document records |

## Admin Dashboard

| Document | What it covers |
|---|---|
| [09a-admin-dashboard-api.md](09a-admin-dashboard-api.md) | Developer/API reference: routes, review, police workflow, reports, async processing, RBAC tiers (§12), user management and OWNER rules (§13), password recovery |
| [09b-admin-dashboard-guide.md](09b-admin-dashboard-guide.md) | Operator guide: every screen, the rules, settings, the role permissions matrix (§7) |
| [OWNER_ROLE.md](OWNER_ROLE.md) | **The OWNER role in detail:** permission model, ADMIN restrictions, making the first OWNER and changing it (SQL) |
| [AGENT_CLIENT_MANAGEMENT.md](AGENT_CLIENT_MANAGEMENT.md) | Agents and Client Management: data model, many-to-many migration, API, lifecycle, locking, RBAC, UI, audit |
| [JOB_MANAGEMENT_IMPLEMENTATION.md](JOB_MANAGEMENT_IMPLEMENTATION.md) | Jobs: job codes, client/agent on a job, candidate assignment (one PROCESSING job at a time), lifecycle, API |

## Candidate Features

| Document | What it covers |
|---|---|
| [20-candidate-management.md](20-candidate-management.md) | Candidate registration, the deployment stages, document uploads, API, validation, the 2026-10-01 bug-fix release |
| [CANDIDATE_PAGINATION_AND_PERFORMANCE.md](CANDIDATE_PAGINATION_AND_PERFORMANCE.md) | Server-side pagination of the Candidates list (100 per page): backend, API, frontend, performance, edge cases |
| [CANDIDATE_BULK_IMPORT.md](CANDIDATE_BULK_IMPORT.md) | Update Sheet bulk import, the approved 83-column Operational Mirror mapping, phone-number storage |
| [CANDIDATE_FORM_FEATURE_ARCHITECTURE.md](CANDIDATE_FORM_FEATURE_ARCHITECTURE.md) | Candidate Form end to end: share links, verification, session, locking, job groups, storage, admin field review, API, deployment |
| [CANDIDATE_EXTRA_DETAILS_FORM_SHARE_LINKS_DESIGN.md](CANDIDATE_EXTRA_DETAILS_FORM_SHARE_LINKS_DESIGN.md) | Design record for share links, Passport + NIC verification, single submission and job-group links (decisions and their reasons) |
| [CANDIDATE_EXTRA_DETAILS_FORM_SECURITY_RISKS.md](CANDIDATE_EXTRA_DETAILS_FORM_SECURITY_RISKS.md) | Candidate Form threat model: risk register, abuse test plan, required controls, release-blocking checks |
| [CANDIDATE_EXTRA_DETAILS_FORM_ISSUES_AND_SOLUTIONS.md](CANDIDATE_EXTRA_DETAILS_FORM_ISSUES_AND_SOLUTIONS.md) | Candidate Form issue log: security, data, deployment, UX and testing issues, open items, lessons learned |
| [../candidate-form/README.md](../candidate-form/README.md) | The Candidate Form frontend package: setup and build |

## Google Integrations

| Document | What it covers |
|---|---|
| [GOOGLE_SHEET_INTEGRATION.md](GOOGLE_SHEET_INTEGRATION.md) | **Start here for Sheet Sync.** Part A: both tabs (Operational Mirror and Candidate Form Submissions), outbox, write gate, Cloud Run worker, endpoints, deployment, troubleshooting. Part B: the Operational Mirror feature reference: row identity, schema, reconciliation, settings UI, scheduler, emergency disable, rollback (formerly `GOOGLE_SHEET_SYNC_FEATURE.md`) |
| [GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md](GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md) | The design specification: scope contract, business rules, sync and reconciliation architecture, security, ADRs, risks, as-built runbook (§24), Sync Destination (§25) |

## Security and Authentication

| Document | What it covers |
|---|---|
| [10-security.md](10-security.md) | Security overview: authentication, the RBAC matrix (all six roles), invitations, webhook, files, database and storage, logging, HTTP hardening, accepted risks |
| [SUPABASE_AUTH.md](SUPABASE_AUTH.md) | Supabase Auth: request authentication, invite/recovery/sign-out flows, security decisions, Supabase project configuration, auth database cutover |
| [OWNER_ROLE.md](OWNER_ROLE.md) | User-management authorization: OWNER vs ADMIN (also listed under Admin Dashboard) |

## Deployment

| Document | What it covers |
|---|---|
| [08-cloud-deployment.md](08-cloud-deployment.md) | Part 1: OCR worker on Cloud Run. Part 2: backend, submission worker and Vercel, step by step. Part 3: branches and environments, Vercel projects, environment variables, Prisma migration process, QA gates, stage flow, smoke tests, common deployment issues (formerly `DEPLOYMENT_AND_QA_PROCESS.md`) |
| [../ocr-worker/README.md](../ocr-worker/README.md) | The OCR worker service: API, running and deploying it |

## Testing and Quality

| Document | What it covers |
|---|---|
| [12-testing-and-quality.md](12-testing-and-quality.md) | Running the backend and admin test suites, what is covered, manual checks, definition of done |
| [CODING_STANDARDS.md](CODING_STANDARDS.md) | The standards code is reviewed against (also listed under Getting Started) |

## Troubleshooting and Historical Notes

| Document | What it covers |
|---|---|
| [EMLYNK_PROJECT_ISSUES_AND_SOLUTIONS_HISTORY.md](EMLYNK_PROJECT_ISSUES_AND_SOLUTIONS_HISTORY.md) | Project-wide issues, errors, blockers and fixes (branching, Windows, Google Cloud, Vercel, Supabase, auth, Sheet Sync), with a debugging method |
| [CANDIDATE_EXTRA_DETAILS_FORM_ISSUES_AND_SOLUTIONS.md](CANDIDATE_EXTRA_DETAILS_FORM_ISSUES_AND_SOLUTIONS.md) | Candidate Form issue log (also listed under Candidate Features) |
| [archive/](archive/) | The complete, unedited originals the numbered documents were consolidated from (below) |

### Archive

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

Also in this folder, not documentation: `DB.txt` (local-only notes, gitignored, never committed) and `Updates.txt` (an informal running backlog).
