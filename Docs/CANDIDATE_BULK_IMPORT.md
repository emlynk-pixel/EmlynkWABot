# Bulk Candidate Import (Update Sheet) and the Approved Operational Mirror

Settings → Google Sheet Sync → **Update Sheet**: ADMIN and MANAGER users upload a legacy candidate sheet (.xlsx), check a preview, and confirm. The supported values go into the Emlynk database. The existing Google Sheet reconciliation then mirrors the database to the **Emlynk Candidate Operational Mirror**.

```
Legacy .xlsx ─▶ browser reads it (only allow-listed columns leave the machine)
            ─▶ server: normalize ─▶ validate ─▶ classify (new / existing / duplicate / conflict) ─▶ PREVIEW (no writes)
            ─▶ ADMIN / MANAGER confirms ─▶ commit in 100-row chunks (one short transaction each)
            ─▶ database ─▶ existing triggers ─▶ sheet_sync_queue ─▶ existing RECONCILE ─▶ mapper ─▶ mirror
```

The database is the source of truth. A legacy row is never copied into the mirror; the mirror shows only what the mapper ([candidateSheetMapper.js](../src/services/candidateSheetMapper.js)) reads from the database.

## 1. Code map

| Concern | File |
|---|---|
| Mirror columns: approved headers, order, kind | [sheetSchema.js](../src/services/sheetSchema.js) |
| Database → mirror values | [candidateSheetMapper.js](../src/services/candidateSheetMapper.js) |
| Legacy column classification (the only place legacy headers are named) | [candidateImportSourceMapping.js](../src/services/candidateImportSourceMapping.js) |
| Legacy value normalizers | [candidateImportNormalizers.js](../src/services/candidateImportNormalizers.js) |
| Row validation, field → column targets | [candidateImportRowValidator.js](../src/services/candidateImportRowValidator.js) |
| Database snapshot, duplicates and conflicts, fill-blanks merge | [candidateImportClassifier.js](../src/services/candidateImportClassifier.js) |
| Preview, chunk commit, unique IDs, finish | [candidateImportService.js](../src/services/candidateImportService.js) |
| API (`/api/admin/settings/sheet-sync/import`) | [routes/candidateImport.js](../src/routes/candidateImport.js) |
| Import tracking table | migration `20261103120000_candidate_import` |
| UI | [SettingsPage.tsx](../admin/src/pages/SettingsPage.tsx), [CandidateImportDialog.tsx](../admin/src/components/CandidateImportDialog.tsx), [importWorkbook.ts](../admin/src/components/importWorkbook.ts) |

## 2. Name semantics

The candidate table's column names are historical; the **stored meaning** is what counts. Every write path stores it the same way: registration, Candidate Details, the Candidate Form confirm flow, and passport OCR reconciliation.

| Business meaning | DB field | Code input field | Mirror header | Legacy header |
|---|---|---|---|---|
| Surname / family name | `candidate.other_name` (Prisma `otherName`) | `surname` | `SURNAME` | `SURNAME` |
| Other / given names | `candidate.first_name` (Prisma `firstName`) | `otherNames` | `OTHER NAME` | `OTHER NAME` |
| Full name / name as in passport | `candidate_additional_details.name_as_in_passport` | `basic.fullName` (form) | `FULL NAME` | `FULL NAME` |

No column was renamed in the database.

## 3. Database → Operational Mirror (approved, 83 columns, A–CE)

Kinds: **DB** = DATABASE_FIELD, **DERIVED** = DERIVED_FIELD, **DOC** = DOCUMENT_STATUS, **STAGE** = STAGE_STATUS, **SYSTEM** = SYSTEM_GENERATED. Columns are found by header text, so the live order does not matter.

| Col | Approved header | Previous header | Source | Kind |
|---|---|---|---|---|
| A | TEST NUMBER | TEST NUMBER | always blank | SYSTEM |
| B | _SYSTEM_CANDIDATE_ID | _SYSTEM_CANDIDATE_ID (was AO) | `unique_id` | SYSTEM |
| C | PASSPORT NUMBER | PASSPORT NUMBER | `passport_id` | DB |
| D | SURNAME | FIRST NAME ⚠ | `other_name` (surname) | DB |
| E | OTHER NAME | OTHER NAME ⚠ | `first_name` (other names) | DB |
| F | TEST DATE | TEST DATE | TEST_DETAILS `test_date` | DB |
| G | BIRTH DATE | BIRTHDAY | `date_of_birth` | DB |
| H | PASSPORT EXPIRE DATE | PP EX DATE | `passport_expiry_date` | DB |
| I | JOB ROLE | JOB | `job` (labels) | DERIVED |
| J | NIC NUMBER | ID NUMBER | `nic` | DB |
| K | ADDRESS | ADDRESS | `address` | DB |
| L | WHATSAPP NUMBER | WHATSAPP NUM | `whatsapp_number` | DB |
| M | CONTACT NUMBER | CONTACT NUM | `contact_number` | DB |
| N | PASSPORT | PASSPORT COPY | current PASSPORT document | DOC |
| O | POLICE REP SRI LANKA | POLICE REP SRI LANKA (1st) | POLICE_REPORT SL_VERIFIED | DOC |
| P | POLICE REP ROMANIA | POLICE REP ROMANIA | POLICE_REPORT ROMANIA | DOC |
| Q | MEDICAL | MEDICAL | MEDICAL | DOC |
| R | SCAN | SCAN | SCAN | DOC |
| S | DRIVING LICENSE | DRIVING LICIAN | none (always `Not Submitted`) | DOC |
| T | NIC COPY | NATIONAL ID | NIC document | DOC |
| U | POLICE REPORT APPLIED | POLICE REPORT APPLIED | POLICE_SLIP | DOC |
| V | SUBMIT DATE | SUBMIT DATE | police slip `police_submitted_date` | DERIVED |
| — | *(removed)* | POLICE REP SRI LANKA (2nd, SL_NORMAL) | the duplicate column was deleted; SL_NORMAL reports have no mirror column | — |
| W | POLICE REP FM | POLICE REP FM | none (always `Not Submitted`) | DOC |
| X | VIDEO | VIDEOS | SKILL_VIDEO | DOC |
| Y | BIRTH PLACE | PLACE OF BIRTH | `place_of_birth` | DB |
| Z | SEX | SEX | `sex` | DB |
| AA | NATIONALITY | NATIONALITY | `nationality` | DB |
| AB | PASSPORT ISSUE DATE | PASSPORT ISSUE DATE | `passport_issue_date` | DB |
| AC | JOB EXPERIENCE | JOB EXPERIENCE | `job_experience` | DB |
| AD | REMARK | CANDIDATE DETAILS NOTE | CANDIDATE_DETAILS `notes` | DB |
| AE–AK | TEST DETAILS / CANDIDATE DETAILS / DOCUMENT SUBMISSION / IVS INTERVIEW / VISA SUBMISSION / VISA APPROVAL / FINALIZING JOB STATUS | same | stage completion | STAGE |
| AL | ACTIVE STATUS | RECORD STATUS | mirror record state | SYSTEM |
| AM | REGISTER DATE | REGISTERED AT | `created_date` | SYSTEM |
| AN | LAST MIRRORED AT | LAST MIRRORED AT | sync time | SYSTEM |
| AO | FULL NAME | NAME AS IN PASSPORT | `name_as_in_passport` | DB |
| AP | CIVIL STATUS / MARITAL STATUS | CIVIL STATUS | `marital_status` | DB |
| AQ–CE | BLOOD GROUP … GUARDIAN ADDRESS (43 columns) | unchanged | additional details | DB (DISTANCE TO BUCHAREST (KM): DERIVED) |

⚠ Previously, the column headed `OTHER NAME` showed the surname and `FIRST NAME` showed the given names. Under the approved headers, `SURNAME` shows the surname and `OTHER NAME` shows the given names.

**Unique and near-duplicate headers.**
- Every header is unique. `POLICE REP SRI LANKA` is **one** column, showing the SL Verified police report. A second copy (like the removed duplicate) makes the column ambiguous and stops the sync with `SCHEMA_INVALID`; so does a missing one.
- `DRIVING LICENSE` (document status) and `DRIVING LICENCE` (Yes / No answer) are two exact, distinct required headers. If either one is renamed, the sync stops.

## 4. Deployment: live Sheet header changes (required)

Row 1 of the live Operational Mirror must carry the approved headers **when the code is deployed**. Otherwise the reconcile stops with `SCHEMA_INVALID` and writes nothing, which is safe but halted.

| Rename this live header | To |
|---|---|
| FIRST NAME | SURNAME (contents switch; see ⚠ above) |
| BIRTHDAY | BIRTH DATE |
| PP EX DATE | PASSPORT EXPIRE DATE |
| JOB | JOB ROLE |
| ID NUMBER | NIC NUMBER |
| WHATSAPP NUM | WHATSAPP NUMBER |
| CONTACT NUM | CONTACT NUMBER |
| PASSPORT COPY | PASSPORT |
| DRIVING LICIAN | DRIVING LICENSE |
| NATIONAL ID | NIC COPY |
| VIDEOS | VIDEO |
| PLACE OF BIRTH | BIRTH PLACE |
| CANDIDATE DETAILS NOTE | REMARK |
| RECORD STATUS | ACTIVE STATUS |
| REGISTERED AT | REGISTER DATE |
| NAME AS IN PASSPORT | FULL NAME |
| CIVIL STATUS | CIVIL STATUS / MARITAL STATUS |

**Delete** the second `POLICE REP SRI LANKA` column (the SL Normal one, after `SUBMIT DATE`), keeping the first one. Done on the live Sheet on 2026-10-28.

`OTHER NAME` keeps its text. Column order may stay as it is: columns are found by header. The first reconcile after the change rewrites every row's name cells from the database. Then run **Test Connection** (ADMIN); it must report "schema valid".

## 5. Legacy sheet → database

Headers match after trimming, collapsing spaces and upper-casing. **Required headings:** PASSPORT NUMBER, SURNAME, OTHER NAME.

**IMPORT / TRANSFORM (45)**

| Legacy header | Meaning | DB field | Class | Transformation / validation |
|---|---|---|---|---|
| PASSPORT NUMBER | identity key | `candidate.passport_id` | TRANSFORM | upper case, spaces/hyphens removed; P/N + 7 digits VALID, P/N + 8 digits WARNING `LEGACY_PASSPORT_FORMAT`, else INVALID |
| SURNAME | surname | `candidate.other_name` | IMPORT | required, ≤ 100 |
| OTHER NAME | other names | `candidate.first_name` | IMPORT | required, ≤ 100; a literal N/A is kept as `N/A` (WARNING) |
| FULL NAME | name as in passport | `name_as_in_passport` | IMPORT | ≤ 200 |
| NIC NUMBER | NIC | `candidate.nic` | TRANSFORM | upper case, spaces removed; `\d{9}[VX]` or `\d{12}`; scientific notation → dropped (`NIC_CORRUPTED`) |
| WHATSAPP NUMBER | WhatsApp | `candidate.whatsapp_number` | TRANSFORM | E.164 with `+` (§6); a second number → contact number when that is empty |
| CONTACT NUMBER | contact | `candidate.contact_number` | TRANSFORM | E.164 with `+` |
| ADDRESS / BIRTH PLACE / EXPERIENCE | | `address` / `place_of_birth` / `job_experience` | IMPORT | ≤ 500 / 100 / 2000 |
| BIRTH DATE / PASSPORT ISSUE DATE / PASSPORT EXPIRE DATE | | candidate dates | TRANSFORM | §6 dates; birth and issue dates not in the future; issue before expiry |
| SEX | | `sex` | TRANSFORM | M, MALE → M; F, FEMALE → F |
| JOB ROLE | preferred job types | `candidate.job` | TRANSFORM | active job type by name, or a confirmed alias; else left unset, `UNKNOWN_JOB_TYPE` |
| MARITAL STATUS, CIVIL STATUS | civil status | `marital_status` | TRANSFORM | English answer (also `<text> (Married)`); both given and different → dropped |
| BLOOD GROUP | | `blood_group` | TRANSFORM | `B Positive (B+)` → `B+` |
| HEIGHT / WEIGHT | | `height` / `weight_kg` | TRANSFORM | the Candidate Form parsers |
| SHIRT SIZE / HIP SIZE / SHOE SIZE | | `tshirt_size` / `pant_size` / `shoe_size` | TRANSFORM | `2XL` → `XXL`; `W32` → `32` (the legacy values are waist sizes); `… size 8` → `8` (UK) |
| ENGLISH KNOWLEDGE, EMAIL | | details | TRANSFORM | code list; email format |
| CITY, DISTRICT, DS DIVISION, GN DIVISION, OTHER SKILLS 1, OTHER SKILLS 2 | | details | IMPORT | length limits |
| FATHER DOB, MOTHER DOB, FATHER ALIVE, MOTHER ALIVE, FATHER PASSPORT, MOTHER PASSPORT | | details | TRANSFORM | dates; Yes / No (`<text> (Yes)`); a NIC-shaped value is not a passport |
| SPOUSE DOB, SPOUSE PASSPORT | | `wife_birthday`, `spouse_passport_number` | TRANSFORM | kept only when the record is Married |
| GUARDIAN NAME, RELATION, NIC, DOB, PHONE, ADDRESS | | `guardian_*` | IMPORT / TRANSFORM | |

**UNRESOLVED: not imported until the business confirms their meaning (15)**
- **FATHER / MOTHER / SPOUSE NAME and SURNAME.** In about three of every four legacy rows the NAME column already contains the surname, so NAME + SURNAME would repeat it, and NAME alone is sometimes incomplete.
- **CHILD1–3 NAME and SURNAME.** The record keeps each child as one name, and how the two legacy columns combine isn't confirmed.
- **REMARK.** Not confirmed to be the Candidate Details note.
- **OTHER SKILLS DESCRIPTION.**
- **INTERVIEW DATE.** Not confirmed to be the Test date.

**SYSTEM_GENERATED: never accepted from a file (20)**
- UNIQUE NUMBER, REGISTER NUMBER, REGISTER DATE, ACTIVE STATUS
- VISA STATUS, INTERVIEW PASS FAIL
- DOCUMENT CREATED STATUS, and the 13 document columns (PASSPORT, MEDICAL, SCAN, NIC COPY, POLICE REPORT, POLICE REPORT FM CERTIFIED, ROMANIA POLICE REPORT, ROMANIA POLICE REPORT CERTIFIED, DRIVING LICENSE, DRIVING LICENSE FM CERTIFIED, VIDEO, VISA COPY, ROMANIA ID)

No document rows are created, and no stage is completed. Imported candidates therefore show `Not Submitted` documents and incomplete stages until the work is done in Emlynk.

**IGNORE (73).** These are operational, payment, loan, cheque, travel, company, agent and affidavit columns: OFFICER, JOB SECTOR, COMPANY, MERGED, AIR TICKET, ARRIVAL CONFIRMATION (×2), DEPARTURE PHOTO, CV, OTHER/REPEAT COUNT/DETAILS, APPLY COUNTRY, REGISTRATION CATEGORY, CONTACT PERSON, BRANCH, APPLIED FROM, PREVIOUS COMPANY (1/2) and their affidavit dates, CONTRACT RECEIVED, COMPANY NUMBER, AGENT, VISA PROCESSING CATEGORY, DOCUMENTS LAWYER PAYMENT, AFFIDAVITS CONTRACTS SIGNED DATE, CHILD1–3 DOB/PASSPORT, CASH PAYMENT 1–4 DATE, BUREAU READY, CLIENT SUBMIT DATE, VISA RECIVED DATE, AIR TICKET BOOKED DATE, LOAN ×4, CHEQUE ×3, the departure/arrival/ticket/airline columns, ISRAEL PROBLEMS, PASSPORT WITH DOCUMENTS HAND OVER, FINAL AFFIDAVIT BOND, CHECKED DATE, DEPATURE CONFIRMATION CHECKED OFFICER NAME, OFFICER UPDATE, CLIENT UPDATED COMPANY, SUBMITTED COMPANY, AGGREEMENT CREATED FOR, AGENT ASKED FOR A COMPANY, VISA FILE CREATION, REMAINING DOCUMENTS, DOCUMENTS UPDATE, SUBMITTED GROUP, WITHDRAW DATE, REASON TO REJECT, REASON FOR CANCELED.

Ignored, unresolved and system columns never leave the browser. The server also drops any such column it does receive.

**Job role aliases.** `JOB_ROLE_ALIASES` is empty until mappings are confirmed. A legacy role equal to an active job type's name (Plaster, Plumber, Electrician, Tiler, Block Mason) needs no alias. Proposed aliases, backed by the legacy Job Sector column, awaiting confirmation:
- Excavator → EXCAVATOR OPERATOR
- JCB → JCB OPERATOR
- Wheel Loader → WHEEL LOADER OPERATOR
- Bobcat → BOBCAT OPERATOR
- Motorgrader → MOTOR GRADER OPERATOR
- Formwork Carpenter → SHUTTERING CARPENTER
- Steel Fixer → BARBENDER
- Drywall worker → GYPSUM WORKER

A generic `Welder` is never mapped to TIG / MIG / ARC. Job types are never created by an import.

**Known limitation.** Until aliases are approved, unmatched legacy roles import with `job` left blank and WARNING `UNKNOWN_JOB_TYPE`. In the current legacy file that is about 600 rows. `candidate.job` is nullable, so this does not block an import. Staff add the job type later in Candidate Details.

## 6. Validation (import only; registration unchanged)

Normal registration keeps `^[PN]\d{7}$`, a required NIC and a required WhatsApp number.

| Value | Import rule |
|---|---|
| Dates | `DD.MM.YYYY`, `DD/MM/YYYY`, `DD-MM-YYYY` (day first; the legacy data shows the day above 12 in about 60 % of rows and the month never above 12), ISO `YYYY-MM-DD` (time ignored), Excel serial days. Two-digit years, impossible dates and `####` are refused. JavaScript locale parsing is never used. |
| Phones | The same canonical form as registration (§12). `07XXXXXXXX`, `0XXXXXXXXX`, `7XXXXXXXX`, `947…`, `+947…`, `0094…` → `+94…`. Romanian `407…` → `+407…`. `+`/`00` numbers keep their own code. Another 10–15 digit number gets `+` with WARNING `FOREIGN_PHONE_UNVERIFIED`. Junk and scientific notation are dropped. Several numbers in one cell: all are kept in order, with `MULTIPLE_PHONE_NUMBERS`. |
| N/A | `N/A`, `NA`, `n/a`, `N.A`, `-` (any case) mean "not given". |

**Row status.** INVALID (identity unusable: passport, surname or other names), WARNING (a value dropped or in a legacy format), VALID, CONFLICT, DUPLICATE.

**Warning and failure codes.** All are safe to show; none carries a value:
- `LEGACY_PASSPORT_FORMAT`, `MISSING_NIC`, `INVALID_NIC`, `NIC_CORRUPTED`
- `MISSING_WHATSAPP`, `INVALID_PHONE`, `MULTIPLE_PHONE_NUMBERS`, `FOREIGN_PHONE_UNVERIFIED`
- `INVALID_DATE`, `PASSPORT_DATES_INCONSISTENT`
- `INVALID_SEX`, `INVALID_CIVIL_STATUS`, `CIVIL_STATUS_CONFLICT`, `INVALID_YES_NO`, `INVALID_BLOOD_GROUP`, `INVALID_SIZE`, `INVALID_HEIGHT`, `INVALID_WEIGHT`, `INVALID_ENGLISH_LEVEL`, `INVALID_EMAIL`
- `UNKNOWN_JOB_TYPE`, `TOO_MANY_JOB_TYPES`, `TEXT_TOO_LONG`
- `FAMILY_PASSPORT_LOOKS_LIKE_NIC`, `INVALID_FAMILY_PASSPORT`
- `MARRIED_WITHOUT_SPOUSE_NAME`, `SPOUSE_DETAILS_NOT_MARRIED`, `OTHER_NAMES_NOT_APPLICABLE`
- `MISSING_PASSPORT`, `INVALID_PASSPORT`, `MISSING_SURNAME`, `MISSING_OTHER_NAMES`, `NAME_TOO_LONG`
- `DUPLICATE_SOURCE_ROW`, `NIC_CONFLICT`, `WHATSAPP_CONFLICT`, `SKIPPED_VERIFIED`
- `PASSPORT_EXISTS`, `UNIQUE_ID_COLLISION`, `DB_ERROR`

## 7. Identity, duplicates and conflicts

| Case | Result |
|---|---|
| Passport not in DB, identifiers free | NEW → created |
| Passport in DB (case-insensitive), NIC equal or one side blank | EXISTING → fill blanks |
| Passport in DB with another NIC | CONFLICT `NIC_CONFLICT` (skipped) |
| NIC belongs to another passport (DB or file) | CONFLICT `NIC_CONFLICT` |
| Passport on more than one row of the file | every occurrence `DUPLICATE_SOURCE_ROW`; none imported (manual review) |
| WhatsApp number owned by another candidate, or by another passport in the file | the row is imported **without** it, WARNING `WHATSAPP_CONFLICT` |

A name is never used as an identity key.

**Existing candidates: fill blanks only.**
- A field is written only when the record's value is empty and the imported value is valid.
- A non-empty field is never overwritten. A differing value is only counted (`fieldsDiffering`) and never shown.
- Never touched: passport, unique ID, stages, documents, verification, job assignments, work allocation, Candidate Form data.

**Verified candidates.** If the record's details are verified and the import would change anything, the row is `SKIPPED_VERIFIED`. The verification-reset trigger is neither bypassed nor fired.

## 8. Commit architecture

- **Preview.** One request, up to 3,000 rows. About 11 Prisma operations for 1,000 rows, whatever the row count: active job types once, passports and NICs in `IN` groups of 500, WhatsApp numbers narrowed by their last 4 digits in `OR` groups of 200, then one metadata insert. Nothing is written to a candidate table.
- **Commit.** 100 rows per chunk, one chunk per request, sent one at a time by the browser.
  - Each chunk runs in **one short transaction** (30 s timeout). The transaction locks the `candidate_import` row (`FOR UPDATE`), re-reads the chunk's DB state (snapshot), allocates unique IDs, runs `createMany` for candidates, details and audit rows, and fills blanks for existing candidates.
  - The commit uses 14 operations per chunk. On Vercel, each request stays far below the 60 s limit and uses one pooled connection (pool max 3).
- **Integrity.** A chunk must hash (SHA-256) to what was previewed, so a commit writes exactly the previewed rows. Only the user who previewed may commit, and a preview expires after 24 h.
- **Failure.** A failed chunk rolls back alone; earlier chunks stay. It is then retried row by row, so only the bad row fails, with a safe code.
- **Idempotency.** A committed chunk is never written twice. A retry keeps earlier CREATED / FILLED outcomes, and a re-imported row finds its own record with nothing to fill.

**Unique IDs.**
- **Before:** `nextUniqueId` read *every* candidate for each new candidate, which is O(N²) across a bulk import.
- **Now:** `allocateUniqueIds` takes one advisory lock and runs one `MAX(unique_id)` query per chunk, then numbers the chunk's new candidates contiguously. The numbering is the same (highest numeric + 1, zero-padded to 4). For 1,000 rows this is 10 queries instead of 1,000 full-table reads.
- Single registration still uses `nextUniqueId`, unchanged. A collision with a concurrent registration fails on the unique index and the chunk is retried with fresh numbers.

## 9. Google Sheet

There is no new sync path. The import's writes queue the candidates through the **existing** triggers (`candidate`, `candidate_additional_details`). On finish, if anything was written, the import requests the **existing** RECONCILE run; an already queued or running one is reused. The worker writes the mirror in batches of 200 rows per request: 5 requests for 1,000 candidates.

## 10. Roles

| Role | Settings | Google Sheet Sync status | Update Sheet | Test Connection / Sync Now / destination |
|---|---|---|---|---|
| ADMIN | every tab | ✓ | ✓ | ✓ |
| MANAGER | Google Sheet Sync tab only | ✓ (read) | ✓ | ✗ (403) |
| ANALYST, REGISTRATION_DESK, JOB_HANDLER | ✗ | ✗ (403) | ✗ (403) | ✗ |

The backend enforces this per route; the UI only hides what a role can't use.

Tooltip on **Update Sheet**: "Upload an existing candidate sheet to validate and import candidate records into Emlynk, then sync them to the Candidate Operational Mirror."

## 11. Privacy

- The workbook is read in the browser and is never uploaded or stored.
- Only allow-listed columns are sent.
- The UI shows masked passports (`N9*****12`) and reason codes only.
- `candidate_import` holds counts, row numbers, reason codes and chunk hashes; it holds no values.
- `BULK_IMPORT_STARTED` / `COMPLETED` / `FAILED` audit entries hold counts only.
- Per-candidate audit entries (`CREATE_CANDIDATE`, `UPDATE_CANDIDATE`, `*_ADDITIONAL_DETAILS`) name the fields, never their values. Like every candidate audit entry, they keep the passport number as the record key.
- Logs carry event names, import IDs, counts and admin IDs only.

## 12. Candidate phone numbers: storage, comparison, uniqueness

| Form | Function | Example | Used for |
|---|---|---|---|
| Storage | `canonicalPhoneNumber` | `+94771234567` | every new write of `whatsapp_number` / `contact_number` (and the guardian phone confirmed from the form) |
| Comparison | `phoneKey` | `94771234567` | duplicates, WhatsApp-sender lookup, the WhatsApp lock on update, the importer |
| Display | stored value | `+94771234567` | Admin, Google Sheet mirror |

**Write paths using the storage form.**
- Registration and Candidate Details (`parseCandidateBody`).
- Candidate Form confirm of the alternative contact and guardian phone. These previously stored the raw typed text.
- Bulk import.

The WhatsApp webhook writes only `temporary_data`. Agents' and clients' phones are separate tables and unchanged.

**Number rules.**
- A Sri Lankan 10-digit national number (`0XXXXXXXXX`) is `+94…`.
- A number that already carries a country code keeps it; `+94` is never forced on it.
- A number still starting with `0` that is not the 10-digit Sri Lankan form is refused (it has no country code).

**Older rows.** Rows stored as `94771234567` keep working everywhere: every comparison uses `phoneKey`. Resubmitting the same number on update is not a change.

**Database uniqueness** (migration `20261104120000`). `candidate_phone_key(text)` is an `IMMUTABLE` SQL function; tests check it computes the same key as `phoneKey`. It backs the unique index `candidate_whatsapp_number_key_normalized`, so `94771234567`, `+94771234567` and `0771234567` can't be held by two candidates. The old raw-text index stays. The number that was already shared before the index existed stays exempt.

**Migration safety.** If two candidates already share a number in different forms, the migration aborts before changing anything. Its message gives counts only (`N group(s) (M candidates)`).

**Deploy order.**
1. `node scripts/auditCandidatePhones.mjs` (read-only). Output: counts, country-code tallies, conflict groups as internal unique IDs, and what the backfill would change.
2. Resolve each conflict group by hand. Deciding who keeps the number is a business decision.
3. `prisma migrate deploy`.
4. `node scripts/auditCandidatePhones.mjs --apply` rewrites older forms to the storage form. It skips:
   - conflicts;
   - values that can't be normalized (reported, left as they are);
   - candidates whose details are verified, because changing the column would clear the verification. They keep the older form, which still compares correctly.
   
   Each rewrite queues the candidate for the mirror through the existing triggers.
