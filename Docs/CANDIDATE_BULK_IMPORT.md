# Bulk Candidate Import (Update Sheet) and the Approved Operational Mirror

Settings → Google Sheet Sync → **Upload**: ADMIN users (an OWNER too) upload a legacy candidate sheet (.xlsx), check a preview, and confirm. The supported values go into the Emlynk database. The existing Google Sheet reconciliation then mirrors the database to the **Emlynk Candidate Operational Mirror**.

```
Legacy .xlsx ─▶ browser reads it (only allow-listed columns leave the machine)
            ─▶ server: normalize ─▶ validate ─▶ classify (new / existing / duplicate / conflict) ─▶ PREVIEW (no writes)
            ─▶ ADMIN confirms ─▶ commit in 100-row chunks (one short transaction each)
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
| Database snapshot, duplicates and conflicts, fill-blanks merge, officer / Test / visa / Client / Agent plans | [candidateImportClassifier.js](../src/services/candidateImportClassifier.js) |
| Error / warning severity and messages (one catalog) | [candidateImportIssues.js](../src/services/candidateImportIssues.js) |
| Preview, chunk commit, unique IDs, Client / Agent / allocation / stage writes, finish | [candidateImportService.js](../src/services/candidateImportService.js) |
| Officer allocation | [workAllocationService.js](../src/services/workAllocationService.js) `allocateImportedCandidates` |
| Test ID (`T` + YYMMDD) | [testId.js](../src/services/testId.js) |
| API (`/api/admin/settings/sheet-sync/import`) | [routes/candidateImport.js](../src/routes/candidateImport.js) |
| Import tracking table; Company Number, country-less Agents | migrations `20261103120000_candidate_import`, `20261106120000_sheet_import_org_fields` |
| UI | [SettingsPage.tsx](../admin/src/pages/SettingsPage.tsx), [CandidateImportDialog.tsx](../admin/src/components/CandidateImportDialog.tsx), [importWorkbook.ts](../admin/src/components/importWorkbook.ts), [validationWorkbook.ts](../admin/src/components/validationWorkbook.ts) |

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

Headers match after trimming, collapsing spaces and upper-casing. **Required headings:** PASSPORT NUMBER, SURNAME, OTHER NAME, JOB ROLE.

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
| JOB ROLE | preferred job types | `candidate.job` | TRANSFORM | required on every row (blank → ERROR `MISSING_JOB_ROLE`); active job type by name, or a confirmed alias; else left unset, `UNKNOWN_JOB_TYPE` |
| MARITAL STATUS, CIVIL STATUS | civil status | `marital_status` | TRANSFORM | English answer (also `<text> (Married)`); both given and different → dropped |
| BLOOD GROUP | | `blood_group` | TRANSFORM | `B Positive (B+)` → `B+` |
| HEIGHT / WEIGHT | | `height` / `weight_kg` | TRANSFORM | the Candidate Form parsers |
| SHIRT SIZE / HIP SIZE / SHOE SIZE | | `tshirt_size` / `pant_size` / `shoe_size` | TRANSFORM | `2XL` → `XXL`; `W32` → `32` (the legacy values are waist sizes); `… size 8` → `8` (UK) |
| ENGLISH KNOWLEDGE, EMAIL | | details | TRANSFORM | code list; email format |
| CITY, DISTRICT, DS DIVISION, GN DIVISION, OTHER SKILLS 1, OTHER SKILLS 2 | | details | IMPORT | length limits |
| FATHER DOB, MOTHER DOB, FATHER ALIVE, MOTHER ALIVE, FATHER PASSPORT, MOTHER PASSPORT | | details | TRANSFORM | dates; Yes / No (`<text> (Yes)`); a NIC-shaped value is not a passport |
| SPOUSE DOB, SPOUSE PASSPORT | | `wife_birthday`, `spouse_passport_number` | TRANSFORM | kept only when the record is Married |
| GUARDIAN NAME, RELATION, NIC, DOB, PHONE, ADDRESS | | `guardian_*` | IMPORT / TRANSFORM | |

**Process columns (TRANSFORM, 7).** Not candidate fields: the classifier acts on them (§5a). Checked against the legacy workbook's real header row: OFFICER (A), VISA STATUS (B), AGENT (G), COMPANY (H), INTERVIEW DATE (I), INTERVIEW PASS FAIL (AR), COMPANY NUMBER (BE). There is no separate INTERVIEW column: Interview = these two columns.

| Legacy header | Target | Rule |
|---|---|---|
| OFFICER | `candidate_allocation` | the user who handles the candidate, matched by **first name** (§5a) |
| VISA STATUS | `candidate_stages`, `candidate.departed_at`, `candidate.outcome` | Every value becomes the candidate's Status: `Submit` → Visa submission completed (Visa Submitted); `Got Visa` → Visa approval completed (Visa Approved); `Departed` → recorded departed (`departed_at`); `Got Visa Not Going` → Visa approval completed + outcome `VISA_NOT_GOING`; `Cancelled` / `Canceled` → outcome `CANCELLED`; `Reject` / `Rejected` → outcome `REJECTED`. A final status (departed or an outcome) is set only when the candidate has none; a different one is kept (WARNING `FINAL_STATUS_KEPT`). `Not Submit` and blank → nothing (no warning); anything else → WARNING `UNKNOWN_VISA_STATUS`, ignored |
| INTERVIEW DATE | `candidate_stages.test_date` (TEST_DETAILS) | Interview = Test; §6 dates; also gives the Test ID |
| INTERVIEW PASS FAIL | `candidate_stages.test_result` | `PASS` → PASS, `FAIL` → FAIL, empty (blank, spaces, or the word `EMPTY`) → PASS; anything else → WARNING `INVALID_TEST_RESULT` |
| COMPANY | `client.name` | the Client: reused by name, or created with the sheet's spelling |
| COMPANY NUMBER | `client.registration_number` | filled when the Client's number is blank; never overwritten |
| AGENT | `agent.name` | the Client's Agent: reused by name, or created with no country |

**UNRESOLVED: not imported until the business confirms their meaning (14)**
- **FATHER / MOTHER / SPOUSE NAME and SURNAME.** In about three of every four legacy rows the NAME column already contains the surname, so NAME + SURNAME would repeat it, and NAME alone is sometimes incomplete.
- **CHILD1–3 NAME and SURNAME.** The record keeps each child as one name, and how the two legacy columns combine isn't confirmed.
- **REMARK.** Not confirmed to be the Candidate Details note.
- **OTHER SKILLS DESCRIPTION.**

**SYSTEM_GENERATED: never accepted from a file (18)**
- UNIQUE NUMBER, REGISTER NUMBER, REGISTER DATE, ACTIVE STATUS
- DOCUMENT CREATED STATUS, and the 13 document columns (PASSPORT, MEDICAL, SCAN, NIC COPY, POLICE REPORT, POLICE REPORT FM CERTIFIED, ROMANIA POLICE REPORT, ROMANIA POLICE REPORT CERTIFIED, DRIVING LICENSE, DRIVING LICENSE FM CERTIFIED, VIDEO, VISA COPY, ROMANIA ID)

No document rows are created. The only stages the import completes are Visa submission (VISA STATUS `Submit`), Visa approval (`Got Visa`, `Got Visa Not Going`) and the Test details (Interview); every other stage stays incomplete until the work is done in Emlynk.

**IGNORE.** These are operational, payment, loan, cheque, travel and affidavit columns, plus ERRORS and WARNINGS (the columns of a validation sheet, §6a, so a corrected sheet uploads cleanly): JOB SECTOR, MERGED, AIR TICKET, ARRIVAL CONFIRMATION (×2), DEPARTURE PHOTO, CV, OTHER/REPEAT COUNT/DETAILS, APPLY COUNTRY, REGISTRATION CATEGORY, CONTACT PERSON, BRANCH, APPLIED FROM, PREVIOUS COMPANY (1/2) and their affidavit dates, CONTRACT RECEIVED, VISA PROCESSING CATEGORY, DOCUMENTS LAWYER PAYMENT, AFFIDAVITS CONTRACTS SIGNED DATE, CHILD1–3 DOB/PASSPORT, CASH PAYMENT 1–4 DATE, BUREAU READY, CLIENT SUBMIT DATE, VISA RECIVED DATE, AIR TICKET BOOKED DATE, LOAN ×4, CHEQUE ×3, the departure/arrival/ticket/airline columns, ISRAEL PROBLEMS, PASSPORT WITH DOCUMENTS HAND OVER, FINAL AFFIDAVIT BOND, CHECKED DATE, DEPATURE CONFIRMATION CHECKED OFFICER NAME, OFFICER UPDATE, CLIENT UPDATED COMPANY, SUBMITTED COMPANY, AGGREEMENT CREATED FOR, AGENT ASKED FOR A COMPANY, VISA FILE CREATION, REMAINING DOCUMENTS, DOCUMENTS UPDATE, SUBMITTED GROUP, WITHDRAW DATE, REASON TO REJECT, REASON FOR CANCELED.

Ignored, unresolved and system columns never leave the browser. The server also drops any such column it does receive.

**Job role aliases.** A legacy role equal to an active job type's name (Plaster, Plumber, Electrician, Tiler, Block Mason) needs no alias. `JOB_ROLE_ALIASES` (candidateImportSourceMapping.js) maps the other known names (plus Plasterer, Plastering, Plumbing, Blockmason, Motor Grader):
- Excavator → EXCAVATOR OPERATOR
- JCB → JCB OPERATOR
- Wheel Loader → WHEEL LOADER OPERATOR
- Bobcat → BOBCAT OPERATOR
- Motorgrader → MOTOR GRADER OPERATOR
- Formwork Carpenter → SHUTTERING CARPENTER
- Steel Fixer → BARBENDER
- Drywall worker → GYPSUM WORKER

A generic `Welder` is never mapped to TIG / MIG / ARC.

**Unknown roles become job types.** A role with no matching job type and no alias is added as a new active job type (upper-case name) when the import is committed, so no role is lost. The preview creates nothing and treats such roles as known. Multiple roles in one cell are split on `,` `/` `;` `&` `+`. Rename or deactivate an added type in Settings > Job Types. (`UNKNOWN_JOB_TYPE` now only appears if a type cannot be created, e.g. its code belongs to an inactive type.)

## 5a. Officer, visa, Test, Client and Agent (`candidateImportClassifier.js`)

All of these are **fill-only** for an existing candidate, and none is written for a candidate whose details are verified (`SKIPPED_VERIFIED`). The preview lists them under **Automatic actions** before anything is confirmed.

**OFFICER → allocation.**
- The cell's first word and each user's first name are compared trimmed and case-insensitively (`firstNameKey`). Any role can be the officer (Admin, Owner, Team Lead, Analyst, Registration Desk, Job Handler); the retired MANAGER role never matches.
- Exactly one ACTIVE match → the candidate is allocated to that user (`candidate_allocation`, through `workAllocationService.allocateImportedCandidates`, audited `ASSIGN_CANDIDATE` like a manual allocation; the user is re-checked ACTIVE under `FOR SHARE` at commit).
- No user → ERROR `OFFICER_NOT_FOUND`. Several ACTIVE users → ERROR `OFFICER_AMBIGUOUS`. Only inactive / invited users → ERROR `OFFICER_NOT_ACTIVE`. An ERROR row is not imported; nobody is guessed.
- Blank cell → WARNING `OFFICER_MISSING`, imported unassigned. No OFFICER column at all → nothing reported.
- Already allocated: to the same user → nothing; to another user → WARNING `OFFICER_DIFFERS`, never reassigned.
- Analyst visibility is unchanged (an Analyst sees only their own candidates). In Work Allocation a non-Analyst holder is listed with the unavailable Analysts, so the candidates can be moved.

**VISA STATUS.** Every value is the candidate's Status (`20-candidate-management.md` §4.0). `Got Visa` completes the existing **Visa approval** stage (when not completed yet), giving `VISA_APPROVED`. `Got Visa Not Going`, `Cancelled` and `Reject` are imported and record the final outcome (`candidate.outcome`, audited `SET_FINAL_STATUS`): `VISA_NOT_GOING`, `CANCELLED`, `REJECTED`, which outrank every other status. `Not Submit` does nothing and reports nothing. Status columns are applied to a candidate whose details are verified too (they never clear a verification); only the details are left alone (`SKIPPED_VERIFIED`). `Submit` completes **Visa submission** when it is not completed yet; completing it by hand in the candidate's stages gives the same Status (`VISA_SUBMITTED`); there is no second workflow. `Departed` records the candidate as departed (`candidate.departed_at`, set once, audited `CANDIDATE_DEPARTED`), giving `DEPARTED` (`20-candidate-management.md` §4.0). The Finalizing job and IVS interview stages were retired (migration `20261109120000_candidate_status_cleanup`).

**Interview → Test details (TEST_DETAILS stage).** There is no separate Interview entity.
- A row has a test when it has an Interview Date or says PASS / FAIL. An empty result is PASS only for a test held on or before today: a row with neither invents no test, and a test scheduled for later gets no result.
- Test date, result and Test ID are each written only when the stage has none; a different stored value → WARNING `TEST_DETAILS_DIFFER`. A new Test details row is completed when it has a result.
- **Test ID** = `T` + YY + MM + DD of the Test date (`src/services/testId.js`, the one generator), e.g. 2026-11-04 → `T261104`. It names the day's test **session**: every candidate tested that day shares it, by design, so it is not unique and has no unique index. The Test details stage generates it too when saved with a date and no ID; a typed ID is kept.

**COMPANY / AGENT / COMPANY NUMBER → Client and Agent.** For every row that is not an ERROR row (not candidate data). Genuinely different names are never fuzzy-matched or merged (`TKUMAT` / `TUHUMAT`, `JAMINO` / `JAMINO (TAL)` stay separate Clients until the sheet is corrected). Names are matched by a key that ignores case, leading / trailing spaces and repeated internal spaces (`ABC Ltd` = `ABC  Ltd` = ` abc ltd `), compared with the stored name normalized the same way (`findClientsByKeys` / `findAgentsByKeys`, in the preview and again in the commit transaction), so an older record saved with extra spaces is found too and never rewritten. A new record takes the sheet's spelling, trimmed with spaces collapsed (the first row's). The ids are the database's own (`gen_random_uuid()`); Clients and Agents have no other code.
- Existing Client → reused. New Client → created only together with an Agent (every Client has one); a new Company without an Agent → WARNING `CLIENT_NEEDS_AGENT`.
- Existing Agent → reused and linked to the Client if not yet. New Agent → created with **no country** (the legacy sheet has none: "Not set" in Admin > Agents, where an admin sets it). A Job can't be created with a country-less responsible Agent (409 `AGENT_COUNTRY_MISSING`). Same name in two countries → WARNING `AGENT_AMBIGUOUS`; inactive Agent → WARNING `AGENT_INACTIVE` (not linked). An Agent without a Company → WARNING `AGENT_NEEDS_COMPANY`, not created.
- Company Number → `client.registration_number` (migration `20261106120000_sheet_import_org_fields`): saved for a new Client, fills a blank one, never overwrites. A different stored number, or two different numbers for one Company in the file → WARNING `COMPANY_NUMBER_CONFLICT`.
- Audited `AGENT_CREATED`, `CLIENT_CREATED`, `CLIENT_AGENT_CHANGED`, `CLIENT_UPDATED`, like Admin > Clients / Agents. Two imports creating the same name at once: the unique indexes refuse the second (`client_name_lower_key`, `agent_name_country_lower_key`, and `agent_name_no_country_lower_key` for country-less Agents); its chunk is retried row by row and finds the record.

**Re-import (idempotency).** The same sheet again writes nothing: every candidate is `NO_CHANGE`, Clients and Agents are reused, allocations, Test details and stages are already there, and no audit row is added.

## 5b. Jobs from the upload (Interview Date + UNIQUE NUMBER, `importJobGroups.js`)

The upload creates and fills Jobs. Manual Job creation is unchanged and keeps `JOB-YYYY-NNNNNN` from `job_code_counter`.

- **Group:** the Interview Date and the hundreds block of UNIQUE NUMBER, `floor(n / 100)` (3100–3199 → 31). One group is one Job. The legacy UNIQUE NUMBER is never the candidate's Emlynk ID.
- **Job ID:** `JOB-YYYY-MMDD` from the Interview Date plus a two-digit suffix. On a date with no Job yet, the date's blocks in ascending order get 01, 02, 03 (3100, 3300, 3500 → 01, 02, 03). Each date starts again at 01. Row order never matters.
- **Stable:** a created group is stored (`import_job_group`, unique per date + block, per date + suffix, and per Job). Every later upload reuses it, so the same date and range always go to the same Job, and an edited suffix is never recalculated. A block that first appears on a date that already has Jobs gets the lowest unused suffix (warning `JOB_GROUP_ADDED_LATER`). A suffix whose full code is used by any Job, manual ones included, is skipped.
- **The Job:** Client = the group's COMPANY, responsible Agent = its AGENT, Job Types = its Job roles, From Country RO. To Country = the Agent's country, or **RO** when the Agent has none (new Agents from the upload have none).
- **Who joins it:** only candidates whose Test result is PASS. The others are imported and reported (`NOT_PASSED_NO_JOB`). A candidate a user removed from the Job is not added back (`JOB_MEMBER_REMOVED_KEPT`).
- **Problems (the group gets no Job; its rows are still imported):**
  - different companies or agents in one group;
  - no company;
  - no usable Client and Agent;
  - an existing Job for another Client.
  - A group where nobody passed gets no Job yet (SKIPPED).
- **Preview:** the "Jobs from this upload" table shows date, range, Job ID, candidates passed and the result. Only a NEW Job's last two digits can be changed (`PUT /import/:id/job-groups`). The change is checked before any chunk is committed: 01–99, unique in the upload and against every job code. The plan is stored on `candidate_import.job_groups` and every chunk applies it.
- **Commit:** inside each chunk's transaction, under a per-date advisory lock: the group is read (reused if a concurrent or earlier upload created it) or its Job is created, and the PASS candidates are added in one batch. This adds about 15 operations per new group and 6 per existing group touched by a chunk, never per row. Audited: `CREATE_JOB` and `ADD_CANDIDATE_TO_JOB`.
- **After the import:** `PATCH /api/admin/jobs/:jobId/import-suffix { suffix }` changes only the last two digits. Allowed for ADMIN, OWNER and JOB_HANDLER, and for an ANALYST on a Job holding one of their candidates. Audited `UPDATE_JOB`. It is shown on the Job page and in the candidate's job panel.

## 6. Validation (import only; registration unchanged)

Normal registration keeps `^[PN]\d{7}$`, a required NIC and a required WhatsApp number.

| Value | Import rule |
|---|---|
| Dates | `DD.MM.YYYY`, `DD/MM/YYYY`, `DD-MM-YYYY` (day first; the legacy data shows the day above 12 in about 60 % of rows and the month never above 12), ISO `YYYY-MM-DD` (time ignored), Excel serial days. Two-digit years, impossible dates and `####` are refused. JavaScript locale parsing is never used. |
| Phones | The same canonical form as registration (§12). `07XXXXXXXX`, `0XXXXXXXXX`, `7XXXXXXXX`, `947…`, `+947…`, `0094…` → `+94…`. Romanian `407…` → `+407…`. `+`/`00` numbers keep their own code. Another 10–15 digit number gets `+` with WARNING `FOREIGN_PHONE_UNVERIFIED`. Junk and scientific notation are dropped. Several numbers in one cell: all are kept in order, with `MULTIPLE_PHONE_NUMBERS`. |
| N/A | `N/A`, `NA`, `n/a`, `N.A`, `-` (any case) mean "not given". |

**Row status.** INVALID (identity unusable: passport, surname or other names; no Job Role; an unmatched officer), WARNING (a value dropped or in a legacy format), VALID, CONFLICT, DUPLICATE.

**Errors and warnings (one catalog: `src/services/candidateImportIssues.js`).** Every code has one severity and one readable message (no cell value in it). The preview's "Rows to review" table and the validation sheet's ERRORS / WARNINGS columns show the **same** messages, from the same preview response (`problems[].errors / warnings` and `rowIssues`). A message is listed once per row.

| Field | ERROR (row not imported) | WARNING (imported) |
|---|---|---|
| Passport | missing; not P/N + 7 or 8 digits (it is the identity key, so a bad format stays an error) | old format P/N + 8 digits |
| Names | surname / other name missing or too long | other name N/A |
| Job Role | missing | not a known job type; more than 10 |
| NIC | — (NIC conflict: CONFLICT, not imported) | missing; invalid format; changed by Excel |
| Officer | no matching user; several active users; only inactive users | blank; already assigned to someone else |
| Visa status | — | a final status already recorded differs (`FINAL_STATUS_KEPT`); a value Emlynk doesn't map |
| Interview | — | invalid date; result not PASS / FAIL / empty; different test details on record |
| Company / Agent / Number | — | new Company without an Agent; Agent without a Company; ambiguous or inactive Agent; number conflict or without a Company |

**Codes.** All are safe to show; none carries a value:
- `MISSING_JOB_ROLE`, `FINAL_STATUS_KEPT`, `UNKNOWN_VISA_STATUS`, `INVALID_TEST_RESULT`, `TEST_DETAILS_DIFFER`
- `OFFICER_MISSING`, `OFFICER_NOT_FOUND`, `OFFICER_AMBIGUOUS`, `OFFICER_NOT_ACTIVE`, `OFFICER_DIFFERS`
- `CLIENT_NEEDS_AGENT`, `AGENT_NEEDS_COMPANY`, `AGENT_AMBIGUOUS`, `AGENT_INACTIVE`, `COMPANY_NUMBER_CONFLICT`, `COMPANY_NUMBER_WITHOUT_COMPANY`
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

## 6a. Validation sheet (ERRORS / WARNINGS)

When the preview finds any error or warning, the dialog offers **Download validation sheet**. It is a copy of the uploaded workbook with two columns added to its first sheet (the one the import reads), `ERRORS` and `WARNINGS`, each holding that row's messages, one per line in the cell. A clean row leaves both blank. The admin fixes the rows and uploads the sheet again; the import ignores the two columns.

- **Built in the browser** (`admin/src/components/validationWorkbook.ts`, ExcelJS, loaded only on the click) from the file the admin chose and the preview's `rowIssues`. The file still never leaves the computer: there is no download endpoint, no stored copy, no URL beyond the click (the object URL is revoked at once). The data behind it is the preview response, which only ADMIN / OWNER get.
- **Kept as it was:** every other sheet, every column in its place, every value and formula, the sheet names. The original file is not modified (a copy is written).
- An `ERRORS` / `WARNINGS` column already there (any case, e.g. an earlier validation sheet) is **reused**: its old messages are cleared and replaced; no `ERRORS_2`. Otherwise both are added after the last used column.
- Row numbers are Excel's own (the reader keeps leading blank rows), so each message lands on its row.

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
- Never touched: passport, unique ID, documents, verification, job assignments, Candidate Form data. Allocation, Test details and the visa stages are only filled when empty (§5a).

**Verified candidates.** If the record's details are verified and the import would change anything (including an allocation, Test or stage), the row is `SKIPPED_VERIFIED`. The verification-reset trigger is neither bypassed nor fired.

## 8. Commit architecture

- **Preview.** One request, up to 3,000 rows. About 11 Prisma operations for 1,000 rows, whatever the row count: active job types once, passports and NICs in `IN` groups of 500, WhatsApp numbers narrowed by their last 4 digits in `OR` groups of 200, then one metadata insert. Nothing is written to a candidate table.
- **Commit.** 100 rows per chunk, one chunk per request, sent one at a time by the browser.
  - Each chunk runs in **one short transaction** (30 s timeout). The transaction locks the `candidate_import` row (`FOR UPDATE`), re-reads the chunk's DB state (snapshot), allocates unique IDs, runs `createMany` for candidates, details and audit rows, and fills blanks for existing candidates.
  - The commit uses 14 operations per chunk. On Vercel, each request stays far below the 60 s limit and uses one pooled connection (pool max 3).
- **Integrity.** A chunk must hash (SHA-256) to what was previewed, so a commit writes exactly the previewed rows. Only the user who previewed may commit, and a preview expires after 24 h.
- **Process writes.** Clients / Agents, allocations, Test details and visa stages are written in the **same** chunk transaction as the candidates (a new candidate's stage rows in one `createMany`). Users, Clients and Agents are read once per preview / chunk in batched queries (no query per row).
- **Failure.** A failed chunk rolls back alone; earlier chunks stay. It is then retried row by row, each row in its own transaction, so only the bad row fails, with a safe code, and leaves no Client, Agent, allocation or stage behind.
- **Idempotency.** A committed chunk is never written twice. A retry keeps earlier CREATED / FILLED outcomes, and a re-imported row finds its own record with nothing to fill.

**Unique IDs.**
- **Before:** `nextUniqueId` read *every* candidate for each new candidate, which is O(N²) across a bulk import.
- **Now:** `allocateUniqueIds` takes one advisory lock and runs one `MAX(unique_id)` query per chunk, then numbers the chunk's new candidates contiguously. The numbering is the same (highest numeric + 1, zero-padded to 4). For 1,000 rows this is 10 queries instead of 1,000 full-table reads.
- Single registration still uses `nextUniqueId`, unchanged. A collision with a concurrent registration fails on the unique index and the chunk is retried with fresh numbers.

## 9. Google Sheet

There is no new sync path. The import's writes queue the candidates through the **existing** triggers (`candidate`, `candidate_additional_details`). On finish, if anything was written, the import requests the **existing** RECONCILE run; an already queued or running one is reused. The worker writes the mirror in batches of 200 rows per request: 5 requests for 1,000 candidates.

## 10. Roles

| Role | Settings | Google Sheet Sync status | Upload | Test Connection / Sync Now / destination |
|---|---|---|---|---|
| OWNER, ADMIN | every tab | ✓ | ✓ | ✓ |
| ANALYST, REGISTRATION_DESK, JOB_HANDLER | ✗ | ✗ (403) | ✗ (403) | ✗ |

The backend enforces this per route; the UI only hides what a role can't use. (Until 2026-10-30 a MANAGER also had the status and Upload; that role is retired: `ROLES_AND_PERMISSIONS.md` §6.)

Tooltip on **Update Sheet**: "Upload an existing candidate sheet to validate and import candidate records into Emlynk, then sync them to the Candidate Operational Mirror."

## 11. Privacy

- The workbook is read in the browser and is never uploaded or stored.
- Only allow-listed columns are sent.
- The UI shows masked passports (`N9*****12`) and readable reasons only. The preview's automatic actions name users, Clients and Agents, never a candidate.
- The validation sheet is built and saved in the browser only (§6a).
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


## 13. Concurrency, the change ledger and rollback

**One import per administrator.** Each administrator may have one import `COMMITTING`; different administrators import side by side (database index on `admin_id`). What they share is protected in the database: a chunk's unique IDs are allocated under one advisory lock, a Job group is read and written under a per-date advisory lock, and passports, NICs, Client / Agent names and Job-group keys are unique constraints.

**The change ledger** (`candidate_import_change`, `src/services/candidateImportLedger.js`). Every change an import makes is recorded in the same transaction as the change: what was created or filled, by internal id, with the exact previous value (`null` and `""` stay different) and what was written. Personal values are never stored: they are a keyed HMAC-SHA256 (`IMPORT_LEDGER_HMAC_SECRET`, see `Deployment/02-ENVIRONMENT-VARIABLES.md`). Without that key an import is refused (503) and nothing is written.

**Rollback** (`src/services/candidateImportRollback.js`, Upload dialog: "Roll back this import…"). An administrator who ran an import, or an Owner, reviews what a rollback would do (nothing is changed by looking), confirms explicitly, and the server reverses it in short batches:

| Entry | Reversed only if |
|---|---|
| Created record (candidate, Job, Client, Agent) | every value the import wrote is still there, nothing has been recorded about it since by anything else, and nothing else depends on it (documents, Job memberships, forms, other Jobs ... found from the database's own foreign keys) |
| Filled blank | the filled fields still hold what the import wrote; they go back to the exact previous value |
| Link / membership | it is still as the import made it |

A candidate the import created is deleted together with what the import gave it (details, stages, allocation, Job memberships), or kept together: someone who has attached a document or changed a stage keeps the candidate. A Job is deleted only when no member is left. Everything that cannot be reversed safely stays and is reported with the reason; once the cause is gone, rolling back again retries it. One call holds a lease (a second administrator or a double click is refused); a long import takes several calls; an interrupted rollback is continued, never repeated. Entries are `APPLIED` -> `REVERTED` / `CONFLICT` / `SKIPPED` (the record was already gone). The audit log has `BULK_IMPORT_ROLLBACK_STARTED`, `_ENTRY`, `_COMPLETED`, `_FAILED`. A rollback runs from the dialog, or by the automatic recovery below.

**Automatic recovery** (`src/services/importRecoveryService.js`, migration `20261113120000_import_recovery`). An import is all-or-nothing: only a `finishImport` that reaches the backend completes it. Every chunk (and row) transaction renews a commit lease (`commit_lease_expires_at`, database time, 2 minutes); the dialog sends a heartbeat every 20 s that never renews the lease. A scheduled task (`POST /api/tasks/import-recovery`, OIDC, about once a minute) claims, with `FOR UPDATE SKIP LOCKED`, every `COMMITTING` import whose lease has expired and whose heartbeat is older than the grace period (or whose lease expired longer ago than the maximum idle time), moves it to `ROLLING_BACK` and runs this same rollback in time-bounded batches until it is done; an interrupted rollback (also one an administrator left) is continued. The returning browser is refused (`IMPORT_RECOVERY_STARTED`). An import whose chunks all committed but that was never finished is rolled back too. A Job Type an import created is now made inside the chunk transaction and recorded (`JOB_TYPE`); it is removed only if unchanged and unused (no Job, no candidate preference). Without the ledger key nothing is attempted: the import stays `ROLLING_BACK`, is retried with backoff and needs attention after the limit. After the database, the Sheet: complete only when this import's deletion approvals are consumed by a successful, writing reconciliation that started after the rollback; failed / dry-run runs are retried. `recovery_status`: `ROLLING_BACK` → `SHEET_PENDING` → `COMPLETED`, or `NEEDS_ATTENTION` (conflicts kept, key missing, retries used up; audit `BULK_IMPORT_RECOVERY_ATTENTION` and the error log event `candidate_import.recovery_attention`). `GET .../import/recovery` lists it all (states, counts, codes). Imports that were `COMMITTING` before the migration have no lease and are never recovered automatically (listed as untracked).

**Google Sheet.** Deleting many candidates would exceed the mirror's deletion guard (10 rows / 5 %), which stays. A rollback records an approval (`sheet_deletion_approval`) for exactly each candidate it deletes; the sheet worker marks the Sheet row of an **approved** candidate that is absent from its complete database snapshot inactive beyond the guard, then marks the approval consumed. Every other absent row is judged by the unchanged guard. **This needs the sheet-sync worker to be redeployed**; until then the database is rolled back but the guard keeps the Sheet rows as they are.
