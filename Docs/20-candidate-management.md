# Candidate Management

Status: **Implemented and verified. Applies to all active admin and reviewer accounts.**

This document covers the Candidate Management feature introduced after Phase 10: how candidates are registered, how their six-stage deployment process works, how documents are uploaded, and what the recent bug-fix release (C1, D1, E1) changed.

---

## 1. Overview

**Candidate Management** is a section of the admin dashboard (`/admin/candidates`) for managing deployment candidates — people being prepared for overseas deployment. It is separate from the main WhatsApp-driven document review workflow (clients).

A candidate is stored as a row in the `users` table identified by their **passport ID**. The same table is used for WhatsApp clients; a candidate who later sends documents via WhatsApp is the same row.

| | |
|---|---|
| URL | `/admin/candidates` |
| Add candidate | `/admin/candidates/new` |
| Candidate detail | `/admin/candidates/:passportId?stage=…` |
| Who can read | Any active admin |
| Who can write | Reviewer role or above |
| Search | By name, passport ID, NIC, or WhatsApp number |
| Uniqueness | Passport ID and NIC are unique. WhatsApp number is unique per candidate (DB-level partial index). |

---

## 2. File Structure

### Backend

| File | Purpose |
|---|---|
| `src/services/candidateService.js` | All candidate business logic: registration, stage updates, document uploads, validation, uniqueness checks |
| `src/routes/admin.js` (lines 319–454) | Express routes for `/api/admin/candidates/*` |

### Frontend (admin/)

| File | Purpose |
|---|---|
| `admin/src/pages/CandidatesPage.tsx` | Candidates list with search, pagination |
| `admin/src/pages/CandidateRegistrationPage.tsx` | Add / edit candidate form |
| `admin/src/pages/CandidateDeploymentPage.tsx` | Six-stage deployment view per candidate |
| `admin/src/components/candidate/CandidateFields.tsx` | Shared form fields (all candidate detail inputs) |
| `admin/src/components/candidate/StagePanels.tsx` | Stage-specific panel components |
| `admin/src/components/candidate/DocumentRow.tsx` | Per-document upload row (used in both registration and stage 2) |
| `admin/src/components/candidate/CandidateStepper.tsx` | Progress stepper shown across the top of the deployment page |
| `admin/src/components/candidate/CallLogDialog.tsx` | Admin call log dialog |
| `admin/src/api/candidates.ts` | Typed frontend API wrappers for all candidate endpoints |

### Database

| Table | Purpose |
|---|---|
| `users` | One row per candidate (same table used for WhatsApp clients) |
| `candidate_stages` | One row per stage per candidate: completion, notes, timestamps |
| `documents` | All uploaded files (passport, NIC, skill video, medical, police report, agreement, affidavit) |
| `audit_logs` | Every document upload is appended here |

---

## 3. Registration (`/admin/candidates/new`)

The **Add candidate** page (`CandidateRegistrationPage`) works in two modes depending on whether the entered passport ID is already on record:

### 3.1 New candidate

1. The admin enters a passport ID (6–9 alphanumeric characters, must include at least one digit).
2. On field blur (or form submit), the frontend calls `GET /api/admin/candidates/:passportId`.
3. If the response is **404**, the passport ID is new. The admin fills in the full details form and uploads:
   - **Passport** (required, PDF/JPG/PNG, ≤ 50 MB)
   - NIC document (optional)
   - Skill video (optional, `video/mp4`, `video/quicktime`, `video/webm`)
4. On submit, `POST /api/admin/candidates` creates the `users` row and stage rows, then documents are uploaded one by one.
5. On success the admin is navigated to the candidate's deployment page at `CANDIDATE_DETAILS` stage.

**Fields collected at registration:**

| Field | Required | Notes |
|---|---|---|
| Passport ID | ✓ | Normalized to uppercase, 6–9 alphanumeric |
| Surname | ✓ | |
| Other names | ✓ | |
| NIC | ✓ | 9 digits + V/X, or 12 digits |
| Address | ✓ | |
| Job types | ✓ | Up to 10 chips; Enter or comma to add |
| Job experience | ✓ | |
| Nationality | | |
| Sex | | M / F / X (as on ICAO passports) |
| Date of birth | | |
| Place of birth | | |
| Passport issue date | | |
| Passport expiry date | | |
| WhatsApp number | | Stored and locked once saved (see §5.1) |
| Contact number | | |
| Comment | | Internal note, saved to `CANDIDATE_DETAILS` stage |

### 3.2 Existing candidate

If `GET /api/admin/candidates/:passportId` returns **200**, the candidate already exists. The form is pre-populated with their stored details. The admin can:

- Edit any field (except the passport ID and a locked WhatsApp number — see §5.1).
- Replace or add their **Passport**, **NIC document**, or **Skill video** via the live `DocumentRow` upload controls (same versioning as WhatsApp documents: a new upload becomes `VERIFIED`, the previous one becomes `SUPERSEDED`).
- Update the `CANDIDATE_DETAILS` stage comment.

On save, the form calls `PUT /api/admin/candidates/:passportId` and, if the comment changed, `PUT /api/admin/candidates/:passportId/stages/CANDIDATE_DETAILS`.

---

## 4. Six-Stage Deployment Process

Each candidate has exactly **six stages**, always in this order:

| # | Stage key | Label | Completed by |
|---|---|---|---|
| 1 | `TEST_DETAILS` | Test details | Admin (checkbox) |
| 2 | `CANDIDATE_DETAILS` | Candidate details | Automatically — when required fields and passport are present |
| 3 | `DOCUMENT_SUBMISSION` | Document submission | Automatically — when all 5 required documents are present |
| 4 | `IVS_INTERVIEW` | IVS interview | Admin (checkbox) |
| 5 | `VISA_APPROVAL` | Visa approval | Admin (checkbox) |
| 6 | `FINALIZING_JOB` | Finalizing the job | Admin (checkbox) |

Stages are independent: any stage can be opened and edited in any order. The URL uses `?stage=<key>` to select which panel is shown; the default is the first incomplete stage.

### 4.1 Automatic stages (2 and 3)

**Stage 2 — Candidate details** is marked complete when the following required fields are filled **and** a `PASSPORT` document is uploaded:

- Surname, other names, NIC, address, one or more job types, job experience.

The panel shows what is still missing (`Missing: …`) until complete.

**Stage 3 — Document submission** is marked complete when all five required documents are on record:

- PASSPORT, MEDICAL, POLICE_REPORT, AGREEMENT, AFFIDAVIT.

A checklist of the five documents is shown at the top of the panel.

### 4.2 Notes stages (1, 4, 5, 6)

Each has a free-text **Notes** field and a **Stage completed** checkbox. Changes are saved with **Save changes** / discarded with **Cancel**. The `PUT /api/admin/candidates/:passportId/stages/:stage` endpoint accepts `{ notes, completed }`.

### 4.3 Call log

Every candidate page has a **Call log** button (top right). The dialog shows a chronological log of admin call notes and allows adding new ones (`POST /api/admin/candidates/:passportId/call-logs`).

---

## 5. Bug-Fix Release (2026-10-01)

The following issues were fixed in a single release. The stage order, completion logic, and overall UI layout were not changed.

### 5.1 C1 — WhatsApp uniqueness race condition

**Problem:** Two near-simultaneous registrations could both pass the application-level WhatsApp duplicate check and save the same number.

**Fix:**

- A **partial unique index** was added to the database:

  ```sql
  -- prisma/migrations/20261001140000_whatsapp_unique_constraint/migration.sql
  CREATE UNIQUE INDEX "users_whatsapp_number_unique"
  ON "users" ("whatsapp_number")
  WHERE "whatsapp_number" IS NOT NULL
    AND "whatsapp_number" NOT IN ('+94771581916');
  ```

  The exclusion covers one pre-existing duplicate that cannot be cleaned up without business input. All new registrations are enforced at the database level.

- `src/services/candidateService.js` was updated in `createCandidate` and `updateCandidateDetails` to catch Prisma's `P2002` error (unique constraint violation) and throw a friendly `CandidateError` with code `WHATSAPP_EXISTS` (HTTP 409) instead of letting a raw database error surface.

> The application-level check in `candidateService.js` is kept so admins still see a friendly validation message before the request reaches the database.

**Note on the known duplicate:** `+94771581916` is associated with two existing rows (`P0124960` and `P1215209`). It was excluded from the index. Do **not** silently delete, merge, or modify either row; resolve it with the business team.

---

### 5.2 D1 — WhatsApp field read-only for existing candidates

**Problem:** When an admin edited an existing candidate's details, the WhatsApp field appeared editable. But the server silently ignored any change to it (by design — the number must not change once registered). This caused confusion.

**Fix (UI only):** In `admin/src/components/candidate/CandidateFields.tsx`, when `whatsappLocked` is `true` (i.e. a WhatsApp number is already stored), the field renders as `readOnly` and a hint is shown below it:

```
Registered WhatsApp numbers cannot be changed.
```

The `whatsappLocked` prop is passed from both `CandidateDetailsStage` (deployment page) and `CandidateRegistrationPage` (registration form) as:

```tsx
whatsappLocked={Boolean(details.candidate.whatsappNumber)}
```

No API change was needed.

---

### 5.3 E1 — Stale state when navigating between candidates

**Problem:** Navigating from Candidate A's page directly to Candidate B's page (e.g. via breadcrumb → list → another row) could briefly show Candidate A's data in Candidate B's URL. React's local state was not reset on route parameter change.

**Fix** (`admin/src/pages/CandidateDeploymentPage.tsx`):

1. A `useEffect` dependent on `passportId` now clears the locally updated copy (`setUpdated(null)`) and closes the call log dialog (`setCallLogOpen(false)`) whenever the route changes.
2. The candidate data is gated: if `details.candidate.passportId` does not match the current URL `passportId`, the loading spinner is shown instead of stale data:

```tsx
if (!details || details.candidate.passportId.toUpperCase() !== passportId.toUpperCase()) {
    return <Card><LoadingState label="Loading candidate…" /></Card>;
}
```

---

### 5.4 Search retry stale results

**Problem:** When a candidate search failed and the admin clicked **Try again** (via `ErrorState`'s retry), the previous search results would flash briefly on screen before the new request completed.

**Fix** (`admin/src/pages/CandidatesPage.tsx`): A `useRef` flag tracks whether the last settled state was an error. During a retry (`status === "loading"` while `wasErrorRef.current` is `true`), `data` is forced to `null` so no stale rows are displayed:

```tsx
const wasErrorRef = useRef(false);
if (list.status === "error") wasErrorRef.current = true;
if (list.status === "success") wasErrorRef.current = false;
const data = (list.status === "error" || (list.status === "loading" && wasErrorRef.current)) ? null : list.data;
```

Normal pagination is unaffected: rows from the previous page remain visible while the next page loads.

---

## 6. Document Uploads

### Accepted file types

| Document type | Accepted MIME types |
|---|---|
| Passport, NIC, Medical, Police Report, Agreement, Affidavit | `image/jpeg`, `image/png`, `application/pdf` |
| Skill video | `video/mp4`, `video/quicktime`, `video/webm` |

The size limit is **50 MB** for all types (enforced by both the Express route and the Supabase bucket).

**Production note:** For skill video uploads to work in production, the Supabase bucket's **Allowed MIME types** setting must include `video/mp4`, `video/quicktime`, and `video/webm`. This is configured in the Supabase Dashboard under **Storage → Bucket Settings**, not in the source code.

### Versioning

Uploading a new file of a document type that already has a `VERIFIED` document:
- The new file becomes `VERIFIED`.
- The previous `VERIFIED` file is set to `SUPERSEDED` (it is not deleted from storage).

This is the same behaviour as WhatsApp-submitted documents (`clientDocumentService.js`).

### Document variants

| Document | Variants |
|---|---|
| Police Report | `SL_VERIFIED`, `ROMANIA`, `SL_NORMAL` |
| Affidavit | `ENGLISH`, `SINHALA` |
| Others | None |

---

## 7. API Reference

All routes are mounted under `/api/admin/candidates` by `src/routes/admin.js`.

| Method | Path | Role | Description |
|---|---|---|---|
| `GET` | `/candidates` | All active admins | List candidates (paginated, searchable) |
| `POST` | `/candidates` | Reviewer+ | Register a new candidate |
| `GET` | `/candidates/:passportId` | All active admins | Get a single candidate (also used for the registration lookup) |
| `PUT` | `/candidates/:passportId` | Reviewer+ | Update candidate details |
| `PUT` | `/candidates/:passportId/stages/:stage` | Reviewer+ | Update a stage (notes, completed) |
| `POST` | `/candidates/:passportId/documents` | Reviewer+ | Upload a document (raw body, `Content-Type` is the MIME type) |
| `GET` | `/candidates/:passportId/call-logs` | All active admins | List call log entries |
| `POST` | `/candidates/:passportId/call-logs` | Reviewer+ | Add a call log entry |

### Error codes

`CandidateError` is thrown by `candidateService.js` and returned as `{ message, code }` by the route handler.

| Code | HTTP | Meaning |
|---|---|---|
| `NOT_FOUND` | 404 | Passport ID does not exist |
| `ALREADY_EXISTS` | 409 | Passport ID is already registered |
| `NIC_EXISTS` | 409 | NIC is already in use by another candidate |
| `WHATSAPP_EXISTS` | 409 | WhatsApp number is already registered to another candidate |
| `INVALID_STAGE` | 400 | Unknown stage key |
| `UPLOAD_FAILED` | 500 | Storage copy failed |

### Query parameters — `GET /candidates`

| Parameter | Type | Default | Description |
|---|---|---|---|
| `page` | integer >= 1 | 1 | Page number |
| `pageSize` | integer | 25 | Results per page |
| `search` | string | — | Search by name, passport ID, NIC, WhatsApp number |

### Upload headers

| Header | Value |
|---|---|
| `Content-Type` | MIME type of the file (`image/jpeg`, `video/mp4`, etc.) |
| `X-File-Name` | URI-encoded original file name |

Query parameters: `type=<DOCUMENT_TYPE>`, optionally `variant=<VARIANT>`.

---

## 8. Validation Rules

These are enforced by `parseCandidateBody` in `candidateService.js` (server) and `validateDetails` in `CandidateFields.tsx` (client):

| Field | Rule |
|---|---|
| Passport ID | `/^[A-Z0-9]{6,9}$/` with at least one digit |
| Surname, other names | Required, <= 100 characters |
| NIC | `/^(\d{9}[VX]|\d{12})$/` |
| Address | Required, <= 500 characters |
| Job types | At least 1, at most 10; each <= 60 characters |
| Job experience | Required, <= 2000 characters |
| Nationality | Optional, <= 60 characters |
| Sex | `M`, `F`, or `X` (ICAO) |
| Dates | `YYYY-MM-DD`; passport issue date must be before expiry date |
| WhatsApp / Contact | If given: 8–15 digits (after removing spaces, dashes, `+`, leading `00`) |
| Comment | Optional, <= 2000 characters |

---

## 9. Debugging Utility

A script was used during the C1 investigation to check for duplicate WhatsApp numbers in the database:

```js
// check-duplicates.cjs  (CommonJS — run with: node check-duplicates.cjs)
const { PrismaClient } = require('./generated/prisma');

async function main() {
    const prisma = new PrismaClient();
    try {
        const users = await prisma.user.findMany({
            where: { whatsappNumber: { not: null } }
        });
        const counts = {};
        for (const u of users) {
            counts[u.whatsappNumber] = (counts[u.whatsappNumber] || 0) + 1;
        }
        const duplicates = Object.keys(counts).filter(k => counts[k] > 1);
        console.log("Duplicates:", duplicates);
    } finally {
        await prisma.$disconnect();
    }
}
main();
```

This file lives at the project root as `check-duplicates.cjs` and is a one-off diagnostic tool; it is not part of the application.
