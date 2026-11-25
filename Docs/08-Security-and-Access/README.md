# 08 Security and Access

**Purpose:** authentication, roles and permissions, and security risk assessments.

## Files, in reading order

| Document | What it covers |
|---|---|
| [10-security.md](10-security.md) | Security overview: authentication, the RBAC matrix (all six roles), invitations, webhook, files, database and storage, logging, HTTP hardening, accepted risks |
| [SUPABASE_AUTH.md](SUPABASE_AUTH.md) | Supabase Auth: request authentication, invite/recovery/sign-out flows, security decisions, project configuration, auth database cutover |
| [ROLES_AND_PERMISSIONS.md](ROLES_AND_PERMISSIONS.md) | What every role can and cannot do: OWNER, ADMIN, ANALYST, REGISTRATION_DESK and JOB_HANDLER; the retired MANAGER role |
| [OWNER_ROLE.md](OWNER_ROLE.md) | The OWNER role in detail: permission model, ADMIN restrictions, making the first OWNER and changing it |
| [CANDIDATE_EXTRA_DETAILS_FORM_SECURITY_RISKS.md](CANDIDATE_EXTRA_DETAILS_FORM_SECURITY_RISKS.md) | Candidate Form threat model: risk register, abuse test plan, required controls, release-blocking checks |

## Related

- [../04-Admin-Dashboard/09a-admin-dashboard-api.md](../04-Admin-Dashboard/09a-admin-dashboard-api.md): RBAC tiers (§12) and user management (§13)
- [../05-Candidate-Management/CANDIDATE_EXTRA_DETAILS_FORM_SHARE_LINKS_DESIGN.md](../05-Candidate-Management/CANDIDATE_EXTRA_DETAILS_FORM_SHARE_LINKS_DESIGN.md): the design the threat model reviews
