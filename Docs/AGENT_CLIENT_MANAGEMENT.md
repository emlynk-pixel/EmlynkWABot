# Agent Management and Client Management

Admin > **Agents** and Admin > **Client Management**. Migration `20261019120000_client_management`. Code: `src/services/agentService.js`, `src/services/clientService.js`, routes in `src/routes/admin.js`, pages `admin/src/pages/Agent*.tsx` and `ClientManagement*.tsx`. Tests: `test/agentClientManagement.test.js`, `admin/src/test/agentClientManagement.test.tsx`. Jobs: [`JOB_MANAGEMENT_IMPLEMENTATION.md`](JOB_MANAGEMENT_IMPLEMENTATION.md).

## 1. Business definitions

* **Agent** — a *business entity*: the recruiting partner abroad. It is **not** a login, not an Admin user, not an Analyst, and has no link to the `user` table. It belongs to **one country** and manages **many Clients**.
* **Client** — the *employer / customer organisation* a Job is for. It has **one** responsible Agent and **many** Jobs. The word "Client" is used everywhere for this; there is no "Company" entity.
* **Job** — belongs to one Client and records its responsible Agent (must be the Client's Agent). Candidates join a Job through `job_candidate`.

> **Naming.** In the older Documents / Candidates area, "Client" meant a *registered candidate* (`/clients`, `/api/admin/clients`, `ClientsPage`, `clients/` storage folder). That area is untouched. The employer Client uses the non-colliding technical names **`/client-management`** and **`/api/admin/client-management`**; the visible label is **Client Management**. Cleaning up the legacy candidate naming is a separate, later task.

## 2. Cardinality

```
Agent 1 ──< Client 1 ──< Job >── JobCandidate >── Candidate
Agent 1 ──< Job      (job.responsible_agent_id, copied from the Client's Agent at creation)
```

No many-to-many. Every link is a foreign key on an immutable UUID; no name, phone or country is used as a key.

## 3. Database

`agent` (existing columns `id`, `name`, `country_code CHAR(2)`, `is_active`, `created_at`, `updated_at`; **added** `contact_number`, `whatsapp_number`, `email`, `address`, `notes`). Unique `(lower(name), country_code)`; the name is **not** globally unique.

`client` (renamed from `company`; **added** `agent_id` → `agent.id` `ON DELETE RESTRICT`, indexed; `contact_person`, `contact_number`, `whatsapp_number`, `email`, `address`). Unique `lower(name)`. `is_active` is the ACTIVE / INACTIVE status.

`job`: `client_id` → `client.id` (renamed from `company_id`), `responsible_agent_id` → `agent.id`, `company_job_id` (the employer's own external job reference; **name kept**, see Job doc §2.1).

* **Status** is stored as `is_active` and exposed as `ACTIVE` / `INACTIVE`.
* **Country**: only an Agent has a country (validated against the ISO 3166-1 list in `src/utils/countries.js`). A Client's country *is* its Agent's, so there is one source of truth and nothing to drift. A Job copies its Agent's country at creation.
* `client.agent_id` is nullable **only** to carry a row that existed before the column; the service requires an ACTIVE Agent on every create and on every status activation, and a client without one cannot get a Job (`CLIENT_HAS_NO_AGENT`) until an Agent is assigned.
* Row-level security stays on for both tables; no `anon` / `authenticated` privileges.

## 4. Lifecycle rules

Neither Agents nor Clients are ever hard-deleted: there is no `DELETE` route, and the foreign keys are `ON DELETE RESTRICT`. Inactive records stay readable and linked.

| Action | Rule |
|---|---|
| Agent → INACTIVE | refused with `409 AGENT_HAS_PROCESSING_JOBS` while any job with that `responsible_agent_id` is PROCESSING |
| Agent country change | refused while it has PROCESSING jobs (each job copied the country) |
| INACTIVE Agent | cannot be chosen for a new Client (`409 AGENT_INACTIVE`), cannot receive a Client by reassignment, cannot be the Agent of a new Job |
| Client → INACTIVE | refused with `409 CLIENT_HAS_PROCESSING_JOBS` while it has PROCESSING jobs |
| Client → ACTIVE | needs an ACTIVE Agent (`409 AGENT_INACTIVE`) |
| INACTIVE Client | cannot get a new Job, and no job can be moved to it (`409 CLIENT_INACTIVE`); existing Jobs stay |
| Change a Client's Agent | explicit action `PATCH …/agent`; new Agent must be ACTIVE. **Existing Jobs keep their own Agent** (nothing in `job` is rewritten); only new Jobs use the new Agent |
| Repeating a status | a no-op: returns the record and writes no second audit entry |

Why "block, don't reassign": deactivating with PROCESSING work would leave Jobs whose responsible party is inactive, and the Job lifecycle has no reassignment. All these checks run inside one transaction with the row locked `FOR UPDATE`; Job creation share-locks the same Client and Agent rows, so the check and the write cannot interleave.

## 5. Roles

| Role | Agents | Client Management |
|---|---|---|
| ADMIN | full | full |
| MANAGER | full | full |
| ANALYST | **no access** (403, no sidebar entry) | **no access** |
| REGISTRATION_DESK | no access | no access |

Read access is also ADMIN / MANAGER only: nothing in the Analyst's candidate-scoped work needs the master data (Jobs already show the Client and Agent names an Analyst may see). The backend enforces every route with `requireRole`; the hidden sidebar entries and the restricted page are not the control.

## 6. API (all ADMIN / MANAGER)

| Endpoint | Purpose |
|---|---|
| `GET /api/admin/agents?search=&country=&status=&page=` | list with `activeClients`, `processingJobs`, `completedJobs`, `cancelledJobs`; 25 per page; `countries` = the filter choices |
| `POST /api/admin/agents` | create `{ name, countryCode, contactNumber?, whatsappNumber?, email?, address?, notes?, status? }` |
| `GET /api/admin/agents/:agentId` | details: clients (with processing-job counts) and jobs by status (newest 50 each) |
| `PATCH /api/admin/agents/:agentId` | edit; the id and status are refused here |
| `PATCH /api/admin/agents/:agentId/status` | `{ status: "ACTIVE" \| "INACTIVE" }` |
| `GET /api/admin/agent-options` | every agent (all statuses, unpaged) for selectors / filters |
| `GET /api/admin/client-management?search=&agentId=&country=&status=&page=` | list with `processingJobs`, `completedJobs`, `cancelledJobs` |
| `POST /api/admin/client-management` | create `{ name, agentId, contactPerson?, contactNumber?, whatsappNumber?, email?, address? }` |
| `GET /api/admin/client-management/:clientId` | details: Agent (name, country, status) and jobs by status with active candidate counts |
| `PATCH /api/admin/client-management/:clientId` | edit business details (not the Agent, not the status) |
| `PATCH /api/admin/client-management/:clientId/agent` | `{ agentId }` — the controlled Agent change |
| `PATCH /api/admin/client-management/:clientId/status` | `{ status }` |

There are **no** `DELETE` endpoints. Counts come from `GROUP BY` queries over `client` and `job`, never from stored counters. Validation is server-side for everything: required name and country, ISO country, email shape, phone via the project's `normalizePhoneNumber` (stored as `94771234567`), text length and control characters, unknown / malformed ids (404 or 400). Unique violations become `409 DUPLICATE`; no Prisma or PostgreSQL text reaches the client.

## 7. Audit logging

`AGENT_CREATED`, `AGENT_UPDATED`, `AGENT_STATUS_CHANGED`, `CLIENT_CREATED`, `CLIENT_UPDATED`, `CLIENT_AGENT_CHANGED`, `CLIENT_STATUS_CHANGED` (Audit Logs categories **Agent** and **Client Management**). Each row has the actor, the entity id, previous and new values and the timestamp. Updates record the changed field names with values for name / country; for contact details (phone, email, address, notes, contact person) **only the fact of the change** (`"(changed)"`) is stored, never the value.

## 8. Admin UI

* **Agents** — table: Agent, Country, Active clients, Processing jobs, Completed jobs, Status, Actions (View / Edit / Make inactive or Activate); search, Country and Status filters (in the URL, server-filtered), pagination; Add / Edit dialog; status confirmation dialog that shows the server's refusal. **Agent details**: information, Clients, Jobs tabs (Processing / Completed / Cancelled) linking to the Job record.
* **Client Management** — table: Client, Country, Responsible agent, Processing jobs, Completed jobs, Status, Actions; search, Agent, Country, Status filters; pagination; Add dialog (ACTIVE agents only); Edit dialog (no agent field); **Change agent** dialog on the details page. **Client details**: information, responsible Agent (name, country, status), Jobs tabs with job type, status, responsible agent and active candidate count.
* **New job** (Jobs): choose the Client; the responsible Agent and country are shown from it (the server re-validates).

## 9. Migration `20261019120000_client_management`

Forward-only; no historical migration is edited. `20261018120000_job_management` is copied **byte-for-byte** from `version/candidate-extra-details-form` so a database that already ran it is unaffected and a later merge sees the same file.

1. `ALTER TABLE company RENAME TO client` — the table, its rows, UUIDs, primary key and the job foreign key are kept; `company_pkey`, `company_name_check`, `company_name_lower_key` are renamed to `client_*`; `job.company_id` → `client_id`, `job_company_id_fkey` → `job_client_id_fkey`, `job_company_id_idx` → `job_client_id_idx`.
2. `client.agent_id` added, backfilled from the client's newest job's `responsible_agent_id` (a legacy client cannot be given an Agent it never had), FK `RESTRICT`, indexed.
3. Contact columns added to `agent` and `client` (all nullable).
4. `job.company_job_id` added with its format `CHECK` and the per-client partial unique index.

Verified by `test/agentClientManagement.test.js` ("migration …"): a database at the previous migration with real `company` / `job` rows is migrated; ids, names, job links, the FK targets, RLS and the unique name survive, there is no `company` table or constraint left, and no `candidate_form_*` object exists.

**Merging `version/candidate-extra-details-form` later:** that branch's `20261018130000_job_company_id_and_form_job_group` adds `job.company_job_id` and an index on `job(company_id, company_job_id)`; both already exist here under the new names, and `company_id` no longer exists. That migration must be rewritten (keep only the `candidate_form_link.job_id` parts, pointing at `job.id`) and the branch's `Company` model / `/companies` route / `createCompany` removed in favour of `Client` before merging.

## 10. Not included / limitations

* The Candidate Form (share links, job-group links, form review) and the Candidate Details "Job assignment" panel are not on this branch; the API already returns `jobAssignments`.
* The free-text `candidate_stages.job_id` is unchanged.
* Edits are last-write-wins; status changes and Job creation are serialised by row locks.
* Job lists on the Agent / Client details pages show the newest 50 per status with the true total beside it.
