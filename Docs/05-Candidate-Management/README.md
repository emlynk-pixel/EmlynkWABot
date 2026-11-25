# 05 Candidate Management

**Purpose:** candidate registration and lifecycle, the candidate list (filters, pagination, bulk import) and the public Candidate Form.

## Files, in reading order

| Document | What it covers |
|---|---|
| [20-candidate-management.md](20-candidate-management.md) | Candidate registration, the deployment stages, document uploads, API, validation, the 2026-10-01 bug-fix release |
| [CANDIDATE_ADVANCED_FILTERS_AND_SEARCH.md](CANDIDATE_ADVANCED_FILTERS_AND_SEARCH.md) | Advanced filters and search on Candidates and Work Allocation |
| [CANDIDATE_PAGINATION_AND_PERFORMANCE.md](CANDIDATE_PAGINATION_AND_PERFORMANCE.md) | Server-side pagination of the Candidates list (100 per page): backend, API, frontend, performance, edge cases |
| [CANDIDATE_BULK_IMPORT.md](CANDIDATE_BULK_IMPORT.md) | Update Sheet bulk import, the approved 83-column Operational Mirror mapping, phone-number storage |
| [CANDIDATE_FORM_FEATURE_ARCHITECTURE.md](CANDIDATE_FORM_FEATURE_ARCHITECTURE.md) | Candidate Form end to end: share links, verification, session, locking, job groups, storage, admin field review, API, deployment |
| [CANDIDATE_EXTRA_DETAILS_FORM_SHARE_LINKS_DESIGN.md](CANDIDATE_EXTRA_DETAILS_FORM_SHARE_LINKS_DESIGN.md) | Design record for share links, Passport + NIC verification, single submission and job-group links |
| [CANDIDATE_EXTRA_DETAILS_FORM_ISSUES_AND_SOLUTIONS.md](CANDIDATE_EXTRA_DETAILS_FORM_ISSUES_AND_SOLUTIONS.md) | Candidate Form issue log: security, data, deployment, UX and testing issues, open items, lessons learned |

## Related

- [../08-Security-and-Access/CANDIDATE_EXTRA_DETAILS_FORM_SECURITY_RISKS.md](../08-Security-and-Access/CANDIDATE_EXTRA_DETAILS_FORM_SECURITY_RISKS.md): the Candidate Form threat model
- [../07-Integrations/](../07-Integrations/README.md): Google Sheet sync that mirrors candidates
- [../Visa%20Submission/README.md](../Visa%20Submission/README.md): visa submission workflow
- [../../candidate-form/README.md](../../candidate-form/README.md): the Candidate Form frontend package
