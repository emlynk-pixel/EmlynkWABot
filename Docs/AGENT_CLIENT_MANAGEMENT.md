# Agent Management and Client Management

Admin > **Agents** and Admin > **Client Management**.

**Primary Migrations:**
- `20261019120000_client_management` (renamed employer table `company` → `client`, added initial contact details and legacy `client.agent_id`)
- `20261026120000_agent_client_many_to_many` (introduced many-to-many join table `agent_client`, backfilled links, deprecated `client.agent_id`)

**Backend Implementation:**
- Services: `src/services/agentService.js`, `src/services/clientService.js`, `src/services/jobService.js`
- Routes: `src/routes/admin.js`

**Frontend Implementation:**
- Pages: `admin/src/pages/AgentsPage.tsx`, `admin/src/pages/AgentDetailsPage.tsx`, `admin/src/pages/ClientManagementPage.tsx`, `admin/src/pages/ClientManagementDetailsPage.tsx`
- Components: `admin/src/components/master/MasterParts.tsx` (`MultiSelect`, `StatusDialog`, `PageTabs`)

**Test Suites:**
- Node.js / PGlite tests: `test/agentClientManyToMany.test.js`, `test/agentClientManagement.test.js`
- React / Vitest tests: `admin/src/test/agentClientManyToMany.test.tsx`, `admin/src/test/agentClientManagement.test.tsx`
- Related Job Management: [`JOB_MANAGEMENT_IMPLEMENTATION.md`](JOB_MANAGEMENT_IMPLEMENTATION.md)

---

## 1. Overview & Business Definitions

* **Agent** — A *business entity*: the recruiting partner abroad. It is **not** a login, not an Admin user, not an Analyst, and has no link to the `user` table. An Agent belongs to **one country** (`country_code`) and can work with **many Clients**.
* **Client** — The *employer / customer organisation* for which Jobs are created. A Client can work with **many Agents** (and an Agent with many Clients). The term "Client" is used throughout; there is no "Company" entity.
* **Job** — Belongs to **one Client** and records its single **Responsible Agent** (selected from among the Client's linked Agents). Candidates join a Job through `job_candidate`.

> **Naming & Disambiguation:**
> In the legacy Documents / Candidates area, "Client" historically referred to a *registered candidate* (`/clients`, `/api/admin/clients`, `ClientsPage`, `clients/` storage folder). That candidate-facing area remains distinct. The employer organisation uses the technical routes **`/client-management`** and **`/api/admin/client-management`**; the UI label is **Client Management**.

---

## 2. Cardinality & Relationship Model

```
Agent M <───> N Client 1 ──< Job >── JobCandidate >── Candidate
                  │          │
                  │          └── job.responsible_agent_id (must be one of the Client's linked Agents)
                  └───────────── job.client_id
```

### Cardinality Summary:
- **Agent ↔ Client**: **Many-to-Many (`M:N`)** via the explicit join table `agent_client`.
  - One Agent can be associated with multiple Clients.
  - One Client can be associated with multiple Agents (including Agents across different countries).
- **Client ──< Job**: **One-to-Many (`1:N`)**. Each Job belongs to exactly one Client.
- **Agent ──< Job**: **One-to-Many (`1:N`)**. Each Job has exactly one Responsible Agent (`job.responsible_agent_id`), which must be one of the linked Agents of the Job's Client.
- **Candidate Links**: Candidates connect to Jobs through `job_candidate` (many-to-many history; at most one active `PROCESSING` job per candidate).

Every entity link uses an immutable UUID; names, phone numbers, and countries are never used as foreign keys.

---

## 3. Database Schema

### 3.1 `agent`
Represents the overseas recruitment partner.
- `id` (`UUID`, PK, default `gen_random_uuid()`)
- `name` (`VARCHAR(120)`): Business name.
- `country_code` (`CHAR(2)`): ISO 3166-1 alpha-2 code. Unique together with name: `UNIQUE (lower(name), country_code)`. (Name alone is not globally unique).
- `is_active` (`BOOLEAN`, default `true`): Exposed as `ACTIVE` / `INACTIVE`.
- Contact fields (nullable): `contact_number`, `whatsapp_number`, `email`, `address`, `notes`.
- Timestamps: `created_at`, `updated_at`.

### 3.2 `client`
Represents the employer organisation.
- `id` (`UUID`, PK, default `gen_random_uuid()`)
- `name` (`VARCHAR(120)`): Employer name. Unique constraint: `UNIQUE (lower(name))`.
- `agent_id` (`UUID`, nullable, FK → `agent.id` `ON DELETE RESTRICT`): **Deprecated legacy column**. See Section 4.
- `is_active` (`BOOLEAN`, default `true`): Exposed as `ACTIVE` / `INACTIVE`.
- Contact fields (nullable): `contact_person`, `contact_number`, `whatsapp_number`, `email`, `address`.
- Timestamps: `created_at`, `updated_at`.

### 3.3 `agent_client` (Join Table)
The explicit many-to-many join table between Agents and Clients.
- `agent_id` (`UUID`, NOT NULL, FK → `agent.id` `ON DELETE RESTRICT ON UPDATE CASCADE`)
- `client_id` (`UUID`, NOT NULL, FK → `client.id` `ON DELETE RESTRICT ON UPDATE CASCADE`)
- `created_at` (`TIMESTAMP(3)`, default `CURRENT_TIMESTAMP`)
- **Primary Key:** Composite `PRIMARY KEY ("agent_id", "client_id")` ensures duplicate pairs cannot exist.
- **Index:** `CREATE INDEX "agent_client_client_id_idx" ON "agent_client"("client_id")` for efficient Client → Agents lookups (the composite PK already covers Agent → Clients lookups).
- **Row-Level Security (RLS):** Enabled; permissions revoked from `anon` and `authenticated`. Backend-only table.

```sql
CREATE TABLE IF NOT EXISTS "agent_client" (
    "agent_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_client_pkey" PRIMARY KEY ("agent_id", "client_id")
);

CREATE INDEX IF NOT EXISTS "agent_client_client_id_idx" ON "agent_client"("client_id");
```

### 3.4 `job`
- `id` (`UUID`, PK)
- `job_code` (`TEXT`, unique, e.g. `JOB-2026-000001`)
- `company_job_id` (`TEXT`, nullable, unique per client when set)
- `job_type_id` (`UUID`, FK → `job_type.id`)
- `client_id` (`UUID`, FK → `client.id`)
- `responsible_agent_id` (`UUID`, FK → `agent.id`): Must be one of `client`'s linked Agents in `agent_client`.
- `country_code` (`CHAR(2)`): Creation-time snapshot of the responsible Agent's `country_code` ("To Country").
- `from_country_code` (`CHAR(2)`, nullable): Defaults to `RO` on creation; editable.
- `vacancies` (`INTEGER`, nullable)
- `status` (`TEXT`, default `PROCESSING`: `PROCESSING` | `COMPLETED` | `CANCELLED`)
- `created_by` (`TEXT`, FK → `user.admin_id`)
- Timestamps: `created_at`, `updated_at`, `completed_at`, `cancelled_at`, `cancel_reason`.

---

## 4. Legacy `client.agent_id` & Deprecation Notice

During the initial Job Management rollout (`20261019120000_client_management`), `client.agent_id` was introduced as a 1:1 foreign key. With migration `20261026120000_agent_client_many_to_many`, the data model transitioned to many-to-many.

### Current Status of `client.agent_id`:
1. **Deprecated**: The column remains in PostgreSQL only for staged migration safety and backward compatibility during multi-instance rollout.
2. **Prisma Mapping**: Mapped in `prisma/schema.prisma` as `legacyAgentId` and `legacyAgent`:
   ```prisma
   // DEPRECATED: the single Agent before agent_client. Not read or written by the
   // application (agentLinks is the source); kept until a later migration drops it.
   legacyAgentId  String?  @map("agent_id") @db.Uuid
   legacyAgent    Agent?   @relation("ClientLegacyAgent", fields: [legacyAgentId], references: [id], onDelete: Restrict, onUpdate: Cascade)
   agentLinks     AgentClient[]
   ```
3. **Application Inactivity**: New application code **no longer reads or writes** `client.agent_id`. All services (`agentService.js`, `clientService.js`, `jobService.js`) query and mutate `agent_client` (`agentLinks` / `clientLinks`).
4. **Backfill**: Migration `20261026120000_agent_client_many_to_many` copied all existing `client.agent_id` rows into `agent_client`.
5. **Drop Schedule**: `client.agent_id` will be dropped in a subsequent, dedicated migration once production traffic has fully cut over to this release.

> [!WARNING]
> Do NOT treat `client.agent_id` as an active source of truth. Any new queries, mutations, or feature work must strictly use the `agent_client` join table.

---

## 5. Migration Strategy (`20261026120000_agent_client_many_to_many`)

The migration is forward-only, additive, and safe to execute against production databases.

### 5.1 What the Migration Executes
1. **Creates `agent_client`**: Creates the table with `agent_id`, `client_id`, `created_at`, and primary key `(agent_id, client_id)`.
2. **Adds Foreign Keys with `RESTRICT`**: Foreign keys target `agent(id)` and `client(id)` with `ON DELETE RESTRICT ON UPDATE CASCADE`. Removing an association deletes only the `agent_client` row; linked Agents or Clients cannot be hard-deleted.
3. **Adds Lookup Index**: Creates `agent_client_client_id_idx` on `client_id`.
4. **Backfills Associations**:
   ```sql
   INSERT INTO "agent_client" ("agent_id", "client_id")
   SELECT c."agent_id", c."id" FROM "client" c WHERE c."agent_id" IS NOT NULL
   ON CONFLICT ("agent_id", "client_id") DO NOTHING;
   ```
5. **Verifies Completeness**: Executes a PL/pgSQL verification check. If any client with an `agent_id` lacks a corresponding `agent_client` row, the migration raises an exception and aborts:
   ```sql
   DO $$
   DECLARE missing INTEGER;
   BEGIN
       SELECT count(*) INTO missing FROM "client" c
       WHERE c."agent_id" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "agent_client" ac WHERE ac."client_id" = c."id" AND ac."agent_id" = c."agent_id");
       IF missing > 0 THEN
           RAISE EXCEPTION 'agent_client backfill incomplete: % client(s) without their agent link', missing;
       END IF;
   END $$;
   ```
6. **No Phantom Links**: Historical agents from older jobs are **not** inferred or backfilled into `agent_client`. Only active associations present at migration time are copied.
7. **Security**: Enables Row Level Security on `agent_client` and revokes `anon` and `authenticated` roles.

### 5.2 Safe Deployment Guidance
To deploy to Supabase / staging / production:

```bash
# 1. Check pending migrations
npx prisma migrate status --config prisma7.config.ts

# 2. Deploy migration safely
npx prisma migrate deploy --config prisma7.config.ts
```

> [!CAUTION]
> **NEVER** run `prisma migrate dev` or `prisma migrate reset` against shared or production Supabase databases. Always use `prisma migrate deploy`.

**Deployment Order:**
1. Run `prisma migrate deploy` on the database.
2. Deploy the application backend and admin frontend.
   *(Because the migration is non-destructive and keeps `client.agent_id`, earlier instances running during rollout continue operating normally without schema mismatch).*

---

## 6. Agent Management (Service & API)

Handled by `src/services/agentService.js` and routes in `src/routes/admin.js`.

### 6.1 Agent Capabilities & Replacement Semantics
- **Multi-Client Association**: An Agent can be linked to zero, one, or many Clients.
- **Create**: Accepts optional `clientIds: string[]`. Linking happens in the same transaction. An inactive Agent cannot be created with clients (`409 AGENT_INACTIVE`).
- **Edit (`PATCH`)**: Accepts `clientIds: string[]`. Link updates use **replacement semantics**:
  - The submitted `clientIds` array becomes the exact, complete set of linked clients.
  - New client IDs are added.
  - Omitted client IDs are unlinked (deleted from `agent_client`).
  - Unchanged client IDs remain intact.
  - Duplicate IDs in the request are automatically de-duplicated.
- **Client Protection Rule**: An Agent edit **cannot** orphan a Client. If removing a Client would leave that Client with zero linked Agents across the entire system, the request is rejected with `409 CLIENT_NEEDS_AGENT`.
- **Inactive Agent Rule**: An inactive Agent cannot be given new clients (`409 AGENT_INACTIVE`). However, an existing linked Agent that later becomes inactive retains its existing links.

### 6.2 Agent Endpoints (ADMIN and MANAGER only)

| Method | Endpoint | Description | Request Body | Response |
|---|---|---|---|---|
| `GET` | `/api/admin/agents` | Paginated list (25/page) with filter counts | Query: `search`, `country`, `status`, `page` | `{ items, pagination, filters, countries }` |
| `POST` | `/api/admin/agents` | Create new agent | `{ name, countryCode, contactNumber?, whatsappNumber?, email?, address?, notes?, status?, clientIds? }` | `201` + Agent detail object |
| `GET` | `/api/admin/agents/:agentId` | Agent details, linked clients, and jobs by status (newest 50 per status) | None | Agent detail object with `clients[]` and `jobs` |
| `PATCH` | `/api/admin/agents/:agentId` | Edit agent details and/or replace linked clients | `{ name?, countryCode?, contactNumber?, whatsappNumber?, email?, address?, notes?, clientIds? }` | Updated Agent detail object |
| `PATCH` | `/api/admin/agents/:agentId/status` | Change status (`ACTIVE` \| `INACTIVE`) | `{ status: "ACTIVE" \| "INACTIVE" }` | Updated Agent detail object |
| `GET` | `/api/admin/agent-options` | Unpaged list of all agents for selectors/filters | None | `{ agents: [{ agentId, name, countryCode, status }] }` |

---

## 7. Client Management (Service & API)

Handled by `src/services/clientService.js` and routes in `src/routes/admin.js`.

### 7.1 Client Capabilities & Replacement Semantics
- **Multi-Agent Association**: A Client can be linked to multiple Agents.
- **At Least One Agent Required**: The business model requires every Client to have at least one Agent. Creating a client with `agentIds: []` or omitting agents is rejected with `400` ("must contain at least one ID").
- **Edit (`PATCH`)**: Accepts `agentIds: string[]`. Uses **replacement semantics**:
  - The submitted `agentIds` becomes the exact list of linked Agents.
  - Adding an Agent requires that Agent to exist (`400 AGENT_NOT_FOUND` if invalid) and be `ACTIVE` (`409 AGENT_INACTIVE`).
  - If an Agent already linked becomes inactive in the future, it may remain linked; however, new links cannot be formed to inactive Agents.
- **Compatibility Endpoint**: `PATCH /api/admin/client-management/:clientId/agent` with `{ agentId }` is retained for backwards compatibility; it replaces the agent list with `agentIds: [agentId]`.

### 7.2 Client Endpoints (ADMIN and MANAGER only)

| Method | Endpoint | Description | Request Body | Response |
|---|---|---|---|---|
| `GET` | `/api/admin/client-management` | Paginated list (25/page) | Query: `search`, `agentId`, `country`, `status`, `page` | `{ items, pagination, filters, countries }` |
| `POST` | `/api/admin/client-management` | Create client | `{ name, agentIds, contactPerson?, contactNumber?, whatsappNumber?, email?, address? }` *(also accepts legacy `agentId`)* | `201` + Client detail object |
| `GET` | `/api/admin/client-management/:clientId` | Client details, all linked agents, and jobs by status | None | Client detail object with `agents[]`, `countryCodes[]`, `jobs` |
| `PATCH` | `/api/admin/client-management/:clientId` | Edit client details and/or replace linked agents | `{ name?, agentIds?, contactPerson?, contactNumber?, whatsappNumber?, email?, address? }` | Updated Client detail object |
| `PATCH` | `/api/admin/client-management/:clientId/agent` | Controlled single-agent replacement (compatibility) | `{ agentId }` | Updated Client detail object |
| `PATCH` | `/api/admin/client-management/:clientId/status` | Change status (`ACTIVE` \| `INACTIVE`) | `{ status: "ACTIVE" \| "INACTIVE" }` | Updated Client detail object |
| `GET` | `/api/admin/client-options` | Unpaged list of all clients for selectors | None | `{ clients: [{ clientId, name, status }] }` |

### 7.3 Client List & Detail Response Shapes
The old single `agent` object and single `countryCode` have been replaced:
```json
{
  "clientId": "4f54e19b-c40d-4081-9b4f-8012f6a7d5cb",
  "name": "Acme Holdings",
  "status": "ACTIVE",
  "agents": [
    {
      "agentId": "a1b2c3d4-...",
      "name": "Global Placements Lanka",
      "countryCode": "LK",
      "status": "ACTIVE"
    },
    {
      "agentId": "e5f6a7b8-...",
      "name": "EuroRecruit Romania",
      "countryCode": "RO",
      "status": "ACTIVE"
    }
  ],
  "countryCodes": ["LK", "RO"],
  "contactPerson": "John Doe",
  "contactNumber": "94771234567",
  "processingJobs": 2,
  "completedJobs": 5,
  "cancelledJobs": 0
}
```

---

## 8. Options & Job Integration

Handled in `src/services/jobService.js`.

### 8.1 Job Options (`GET /api/admin/job-options`)
When creating a Job, the UI fetches active job types, eligible clients, and active agents:
- `clients`: Includes active clients that have **at least one active linked agent**. Each client entry exposes `agentIds`:
  ```json
  {
    "id": "4f54e19b-...",
    "name": "Acme Holdings",
    "agentIds": ["a1b2c3d4-...", "e5f6a7b8-..."]
  }
  ```
- `agents`: Active agents with their `countryCode`.

### 8.2 Job Creation Integrity Rules (`requireClientWithAgent`)
When creating a Job (`POST /api/admin/jobs`) with `clientId` and optional `responsibleAgentId`:
1. **Client Active Check**: Client must exist and be `ACTIVE` (`409 CLIENT_INACTIVE`).
2. **Has Linked Agents**: Client must have at least one linked agent in `agent_client` (`409 CLIENT_HAS_NO_AGENT`).
3. **Agent Membership Verification**: If `responsibleAgentId` is provided, it **must** be present in the Client's `agent_client` links (`409 CLIENT_AGENT_MISMATCH`). An unlinked agent cannot be assigned to the job.
4. **Disambiguation / Multi-Agent Rule**:
   - If the Client has **exactly 1 linked Agent**: That Agent is selected automatically if `responsibleAgentId` is omitted.
   - If the Client has **multiple linked Agents**: The user **must explicitly choose** the `responsibleAgentId`. The backend will **not** silently default to the first or arbitrary agent (`409 AGENT_REQUIRED`).
5. **Agent Active Check**: The selected Responsible Agent must be `ACTIVE` (`409 AGENT_INACTIVE`).
6. **Moving Jobs (`PUT /jobs/:jobId`)**: If a Job is moved to another Client, the Job's `responsibleAgentId` must be a linked agent of the target Client (`409 CLIENT_AGENT_MISMATCH`).

---

## 9. Country & "To Country" Rules

This is a critical architectural rule:

1. **Client has NO Country Column**: A Client is an employer organisation and does not possess its own ISO country code column.
2. **Agent Holds Country**: Each Agent has a single immutable/validated `country_code` (e.g. `RO`, `LK`, `DE`).
3. **Clients Multi-Country Exposure**: Because a Client can partner with Agents from different countries (e.g. one in Romania, one in Sri Lanka), the Client has **no single unambiguous country**. In the Client list and details view, `countryCodes` displays the distinct sorted list of countries of its linked Agents.
4. **Job "To Country"**:
   - A Job represents work in a specific destination country.
   - `job.country_code` ("To Country") is copied directly from the **selected Responsible Agent's `country_code`** at Job creation time.
   - This value is stored as an immutable **creation-time snapshot**.
5. **No Historical Rewrites**:
   - If a Client changes its linked Agents, existing Jobs for that Client **keep their original `responsible_agent_id` and `country_code`**.
   - Jobs are historical commercial records and are never rewritten by link changes.
6. **Future Consideration**:
   > [!NOTE]
   > If the business later decides that a Client must possess a single fixed legal operating country independent of its recruiting Agents, that will require a business decision and a dedicated migration adding `client.country_code`. Under the current architecture, country belongs strictly to the Agent and flows to the Job.

---

## 10. Lifecycle Rules & Data Consistency

Neither Agents nor Clients are ever hard-deleted. They have no `DELETE` API endpoints, and foreign keys are protected with `ON DELETE RESTRICT`.

| Action | Business / Integrity Rule | Error Code |
|---|---|---|
| **Agent → INACTIVE** | Blocked if the Agent is responsible for any job with status `PROCESSING`. | `409 AGENT_HAS_PROCESSING_JOBS` |
| **Agent Country Change** | Blocked if the Agent has any `PROCESSING` jobs (each job copied the country at creation). | `409 AGENT_HAS_PROCESSING_JOBS` |
| **Link Inactive Agent** | An inactive Agent cannot be added to a new or existing Client. | `409 AGENT_INACTIVE` |
| **Client → INACTIVE** | Blocked if the Client has any jobs with status `PROCESSING`. | `409 CLIENT_HAS_PROCESSING_JOBS` |
| **Client → ACTIVE** | Blocked if the Client has no `ACTIVE` linked Agent. | `409 AGENT_INACTIVE` |
| **Create Job for Inactive Client** | Refused. | `409 CLIENT_INACTIVE` |
| **Create Job with Inactive Agent** | Refused. | `409 AGENT_INACTIVE` |
| **Job Agent Mismatch** | Responsible Agent is not linked to the Client in `agent_client`. | `409 CLIENT_AGENT_MISMATCH` |
| **Ambiguous Job Agent** | Client has >1 Agents and no `responsibleAgentId` was passed. | `409 AGENT_REQUIRED` |
| **Client Has No Agents** | Client has 0 linked agents when creating a Job. | `409 CLIENT_HAS_NO_AGENT` |
| **Orphan Client** | Removing an agent link from an Agent leaves a Client with 0 agents. | `409 CLIENT_NEEDS_AGENT` |
| **Client Empty Agents** | Attempting to save a Client with 0 agents (`agentIds: []`). | `400` ("must contain at least one ID") |
| **Concurrent Modification** | A link was modified concurrently between initial read and lock acquisition. | `409 CHANGED_MEANWHILE` |
| **Duplicate Entity Name** | Unique constraint collision on name / (name + country). | `409 DUPLICATE` |
| **Duplicate Agent/Client Link** | In-memory de-duplication + `agent_client` composite PK. | Silent deduplication / DB PK |

---

## 11. Concurrency, Locking & Transactions

To guarantee zero race conditions, deadlocks, or orphaned entities under concurrent load:

1. **Deterministic Lock Order**:
   All transactions touching both Clients and Agents acquire row-level locks in a strict global order:
   - **Client rows first (`FOR UPDATE` or `FOR SHARE`), ordered by UUID.**
   - **Agent rows second (`FOR UPDATE` or `FOR SHARE`), ordered by UUID.**
   Because all writers and readers (including `createJob`) follow this identical hierarchy, deadlocks between concurrent operations are mathematically prevented.
2. **Replacement Atomicity**:
   All link changes (`agentIds` or `clientIds`) run inside a single database transaction (`db.$transaction`). If any validation fails (e.g. an agent is inactive, an ID is invalid, or a client would be orphaned), the transaction rolls back completely; partial link sets are never persisted.
3. **Mid-Flight Conflict Detection (`CHANGED_MEANWHILE`)**:
   In `updateAgent`:
   - Current linked clients are read.
   - Locks are acquired on all current and requested client IDs.
   - Current linked clients are re-queried under lock.
   - If another transaction slipped in and added a client before the lock was granted, the operation safely aborts with `409 CHANGED_MEANWHILE ("This agent's clients were changed meanwhile. Reload and try again.")`.
4. **Job Creation Atomicity**:
   `createJob` share-locks the Client and the Responsible Agent (`FOR SHARE`), preventing concurrent status deactivations or link removals while the Job row is being inserted.

---

## 12. RBAC & Permissions

Access control is enforced strictly in the backend via `requireRole` middleware on every route.

| Role | Agents API (`/agents`) | Client Management API (`/client-management`) | Options Endpoints (`/agent-options`, `/client-options`, `/job-options`) | Admin UI Sidebar Access |
|---|---|---|---|---|
| **ADMIN** | Full (Read, Write, Status) | Full (Read, Write, Status) | Allowed | Visible |
| **MANAGER** | Full (Read, Write, Status) | Full (Read, Write, Status) | Allowed | Visible |
| **ANALYST** | **403 Forbidden** | **403 Forbidden** | **403 Forbidden** | Hidden |
| **REGISTRATION_DESK** | **403 Forbidden** | **403 Forbidden** | **403 Forbidden** | Hidden |

*Analyst Note:* Analysts deal exclusively with candidate workflows and assigned candidate stages. Master entity configuration (Agents and Clients) is strictly reserved for `ADMIN` and `MANAGER`.

---

## 13. Admin UI Specifications

Implemented in React with Tailwind CSS and accessible dialog patterns.

### 13.1 Agents List (`/agents`)
- **Table Columns:** `Agent`, `Country`, `Active clients`, `Processing jobs`, `Completed jobs`, `Status`, `Actions` (View / Edit / Activate or Make inactive).
- **Search & Filters:** Search (name), Country dropdown (distinct agent countries), Status dropdown (`All`, `Active`, `Inactive`).
- **Pagination:** 25 items per page with URL search params sync.

### 13.2 Agent Details (`/agents/:agentId`)
Structured with horizontal tabs (`PageTabs`):
1. **Jobs (Default Tab)**:
   - Nested sub-tabs by status: `Processing`, `Completed`, `Cancelled`.
   - Displays Job code, Client name, Job type, Vacancies, Candidate counts, and Date.
   - Links directly to `/jobs/:jobId`.
2. **Agent Details Tab**:
   - Card displaying Country, Contact number, WhatsApp number, Email, Address, Notes, and Created timestamp.
3. **Clients Tab**:
   - Table of all Clients associated with this Agent via `agent_client`.
   - Columns: Client name (links to `/client-management/:clientId`), Status badge, and Processing jobs count.

### 13.3 Client Management List (`/client-management`)
- **Table Columns:** `Client`, `Country`, `Processing jobs`, `Completed jobs`, `Status`, `Actions` (View / Edit / Activate or Make inactive).
- **Responsible Agent Column Removed:** Replaced by the relationship model; clients no longer have a single responsible agent in the list view.
- **Country Column:** Displays the distinct country names of all linked agents (e.g. `Romania, Sri Lanka`), or `—` if none.
- **Filters:** Search (name or contact person), Agent dropdown (all agents from `/agent-options`), Country dropdown, Status dropdown (`All`, `Active`, `Inactive`).

### 13.4 Client Details (`/client-management/:clientId`)
Structured with horizontal tabs (`PageTabs`):
1. **Job Details (Default Tab)**:
   - Sub-tabs: `Processing`, `Completed`, `Cancelled`.
   - Displays Job code, Job type, Responsible Agent (name & country), Vacancies, and Active candidate counts.
2. **Client Details Tab**:
   - Displays Country (distinct countries of linked agents), Contact person, Contact number, WhatsApp number, Email, Address, and Created date.
   - **No single Responsible Agent field** is shown on the Client Details panel.
3. **Agents Tab**:
   - Displays a table of all Agents linked to this Client.
   - Columns: Agent name (links to `/agents/:agentId`), Country name, and Status badge.
   - Contains an "Edit agents" shortcut opening the edit modal.

### 13.5 Shared `MultiSelect` Component (`MasterParts.tsx`)
Used in both `AgentFormDialog` (selecting clients) and `ClientFormDialog` (selecting agents):
- **Chip Display:** Selected items render as rounded chips with a `×` remove button.
- **Search Filtering:** Search input appears automatically when options exceed 6 items.
- **Selection Control:** Checkbox list allowing multi-selection.
- **Duplicate Prevention:** Handled via JavaScript `Set`.
- **Inactive Options Handling:**
  - Inactive options that are **already selected** remain visible, checked, and can be unselected/removed.
  - Inactive options that are **not selected** are disabled (`disabled: true`), preventing new associations to inactive entities.

### 13.6 New Job Modal (`JobsPage.tsx`)
- When a Client is selected:
  - If the Client has 1 linked active Agent: The Agent and destination country are automatically selected.
  - If the Client has multiple linked active Agents: The Responsible Agent dropdown is enabled and marked required. The user must choose the Responsible Agent.
  - The destination "To Country" dynamically reflects the chosen Agent's country.

---

## 14. Audit Logging

All actions are logged append-only to `audit_logs` with actor details, timestamps, and JSON-serialized state:

| Action | Trigger | Logged Details |
|---|---|---|
| `AGENT_CREATED` | New agent created | Initial values and `clientIds` |
| `AGENT_UPDATED` | Agent fields updated | Redacted contact details (`(changed)`), changed field values |
| `AGENT_STATUS_CHANGED` | Agent activated or made inactive | Previous and new status |
| `AGENT_CLIENTS_CHANGED` | Agent's linked clients changed | `added[]`, `removed[]`, full `clientIds` |
| `CLIENT_CREATED` | New client created | Initial values and `agentIds` |
| `CLIENT_UPDATED` | Client fields updated | Redacted contact details (`(changed)`), changed field values |
| `CLIENT_AGENT_CHANGED` | Client's linked agents changed | `added[]`, `removed[]`, full `agentIds` |
| `CLIENT_STATUS_CHANGED` | Client activated or made inactive | Previous and new status |

*Privacy Rule:* Personal contact details (`contactNumber`, `whatsappNumber`, `email`, `address`, `notes`, `contactPerson`) record only `"(changed)"`, never the raw value.

---

## 15. Known Legacy & Follow-Up Work

1. **Drop Legacy `client.agent_id` Column**:
   - Create a future migration (`DROP COLUMN "agent_id"`) once all deployed application services are confirmed running on the many-to-many codebase.
   - Remove `legacyAgentId` and `legacyAgent` from `prisma/schema.prisma`.
2. **Remove Compatibility Endpoint**:
   - Deprecate and eventually retire `PATCH /api/admin/client-management/:clientId/agent` once external consumers or legacy scripts no longer invoke it.
3. **Candidate Area "Client" Naming**:
   - Clean up candidate-facing terminology where `/clients` and `ClientsPage` refer to candidate registrations, renaming them to avoid confusion with employer Client Management.
