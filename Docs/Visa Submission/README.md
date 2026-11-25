# Visa Submission

A guide for new team members. For files, routes and data flow see [ARCHITECTURE.md](ARCHITECTURE.md).

| Phase | Status |
|---|---|
| Phase 1: merged unsigned PDF download and signed PDF upload (per candidate) | **Implemented** |
| Phase 2: bulk extraction tab, Excel files and ZIP download | **Implemented** |

---

## 1. What it does

In the **VISA SUBMISSION** stage of a candidate, staff can:

1. **Download** one PDF that merges the candidate's documents. This is the unsigned file the lawyer signs.
2. **Upload** the lawyer-signed PDF with the existing Upload button.
3. When the upload is saved and the normal visa rules pass, the stage is marked **completed** automatically.

## 2. Business flow

1. The candidate reaches the VISA SUBMISSION stage.
2. A Team Lead or Admin clicks **Download**. The browser builds the merged PDF.
3. The lawyer signs the PDF.
4. The Team Lead or Admin uploads the signed PDF (PDF only).
5. The system saves it and checks the visa rules (test result is PASS, and the candidate has an active Job).
   - Rules pass: the stage becomes **Completed**.
   - Rules fail: the document is still saved, the stage stays open, and the screen shows the reason.
6. If the signed document is removed later, the stage goes back to **not completed**.
7. The manual completion form still works as before.

**Phase 2:** the admin **Visa Submission** tab extracts completed candidates per Job into dated Supabase folders, with two Excel files per client and a file browser with ZIP download (section 8).

## 3. Merge order

| # | Document | Type and variant |
|---|---|---|
| 1 | Passport | `PASSPORT` |
| 2 | SL Normal Police Report | `POLICE_REPORT` / `SL_NORMAL` |
| 3 | SL Verified Police Report | `POLICE_REPORT` / `SL_VERIFIED` |
| 4 | Romania Police Report | `POLICE_REPORT` / `ROMANIA` |
| 5 | Medical | `MEDICAL` |
| 6 | Scan (Agreement + Affidavit EN/SI) | `SCAN` |

The Police Slip is **not** part of the merge. The order lives in one place: `src/config/visaSubmission.js`.

### Missing or unverified documents

Each slot has one status, using only the current (not replaced) document:

| Status | Meaning | In the merged PDF? |
|---|---|---|
| `VERIFIED` | A verified document exists | Yes |
| `UNVERIFIED` | A document exists but is waiting for review | No |
| `MISSING` | No document | No |

- If any slot is missing or unverified, a dialog lists them (for example "Medical (missing)", "Romania Police Report (not verified)"). You can **Cancel** or **Download anyway**.
- If no slot is verified, an error is shown and nothing is downloaded.
- PDF pages keep their size. JPEG and PNG images are placed on A4 pages, scaled to fit.
- The file is named `{passportId}_Visa_Submission_Unsigned.pdf`.

## 4. Permissions

| Action | Allowed roles |
|---|---|
| See the Download button, upload or remove the signed PDF | ADMIN, OWNER, TEAM_LEAD |
| Everyone else (ANALYST, REGISTRATION_DESK, JOB_HANDLER) | Blocked (backend returns 403; the UI shows a read-only row) |

OWNER is allowed because the project treats OWNER as ADMIN wherever ADMIN is listed (`hasRole()`).

### Adding a new role

The role list is `VISA_SUBMISSION_ROLES`. Change it in two places only:

- Backend: `src/config/visaSubmission.js`
- Frontend: `admin/src/auth/roles.ts`

Do not copy the list anywhere else. Phase 2 (the tab and all its routes) uses the same constants.

## 5. Security and decisions

| Decision | Reason |
|---|---|
| Only VERIFIED documents are merged | Unchecked files must not reach the lawyer or the visa file. |
| The merge runs in the browser | Vercel limits responses (about 4.5 MB) and function time (60 s); six documents can be larger and slower than that. |
| Files are streamed one by one from the server | Streaming avoids the response size limit and never loads a whole file into server memory. |
| The unsigned merged PDF is never stored or uploaded | It contains sensitive passport data; there is nothing to protect if no copy exists. |
| No signed download URLs | Every file goes through the API, so role and candidate checks run on each request. |
| The server builds the storage path from the database record | A request can never point at another file. |
| ANALYST access removed for this document type | Visa submission is handled by Team Lead and Admin only. Other document types are unchanged. |
| The signed upload accepts PDF only | A signed legal document must be a PDF. Checked in the browser and on the server (file type and the `%PDF` header). |
| The signed upload may be up to 50 MB (other documents stay at 10 MB) | The signed file is a merge of six documents that is rescanned after signing, so it often passes 10 MB. The limit is `VISA_SUBMISSION_MAX_FILE_SIZE` in `src/config/visaSubmission.js`, enforced on `upload-target` and `finalize` (the message says "larger than 50 MB"). The file still goes straight from the browser to storage; it never passes through the API. **The Supabase project's global file size limit and the bucket's own limit must both be at least 50 MB** (Storage settings), or the upload fails at storage before the app can check it. |
| Completion uses the existing visa rules | One source of truth: test PASS and an active Job, as the manual form requires. |
| Rules failing still saves the document | The file is not lost; staff see why the stage is not completed. |
| Removing the signed document reopens the stage | The stage must not stay completed without its document. |
| A leave-page warning is shown only while merging | Closing or reloading the tab cancels the merge and loses the work. The warning is removed as soon as the merge ends, so it never appears at other times. |
| Extraction **copies** the signed PDF, never moves it | The candidate's own record and storage must stay intact. |
| One lock per date and client while the Excel files are updated | Two people extracting at once could overwrite each other's rows and corrupt the files. A busy lock returns "Extraction in progress, try again". |
| The lock is a short database lease, not a Postgres advisory lock | The app talks to Postgres through a pooler, where a session lock can be taken on one connection and released on another. |
| Extraction runs in batches of 10 (max 15) | Vercel stops a request after 60 s. The browser sends the batches one after another and shows progress. |
| Eligibility is tied to the document id | A re-uploaded signed document is a new document, so the candidate becomes eligible again without any reset step. |
| The folder date uses the Asia/Colombo time zone | The business day in Sri Lanka, not UTC, decides the folder. Sri Lanka midnight is 18:30 UTC the day before. |
| The browser only reaches `VISA SUBMISSION/` | Every path is checked and rebuilt on the server; `..`, `%`, backslashes and other roots (such as `clients/`) are refused. |
| Files and ZIPs are streamed, with no signed URLs | Role checks run on every request. |
| The vacancy count never blocks an extraction | Vacancies are managed elsewhere; extraction only follows the eligibility rules. |
| Downloads and extractions are audited | `VISA_SUBMISSION_EXTRACTION`, `VISA_SUBMISSION_FILE_DOWNLOAD` and `VISA_SUBMISSION_ZIP_DOWNLOAD`. |
| Every confirmed download is audited | `VISA_SUBMISSION_MERGED_DOWNLOAD` records who downloaded and which documents were included or left out. |

## 6. Limits of the browser merge

- The browser downloads every document, so a slow internet connection makes it slower.
- A very large merge needs PC memory. Close heavy tabs if it fails.
- **Keep the tab open** until the file is saved. While the merge runs, the browser shows its own "leave site?" warning if you close or reload the tab. The warning appears only during the merge. Clicking a link inside the admin app (for example the sidebar) or the Back button is **not** blocked and silently cancels the merge, because the app's router cannot block in-app navigation without a larger change.
- A password-protected or corrupt PDF stops the merge, and the error names the document.
- Images are not compressed, so the file can be large.
- No copy is kept. Download again if you need it again.
- If a document changes while you wait on the dialog, the download is refused and you are asked to try again.

## 7. How to test manually

1. Sign in as ADMIN, OWNER or TEAM_LEAD. Open a candidate with a test PASS and an active Job, and open the **Visa submission** stage.
2. Check that **Download** is next to **Upload**.
3. Click Download with some documents missing. Check the dialog lists them. Click **Cancel**: nothing downloads.
4. Click Download again, then **Download anyway**. Check the progress text ("Preparing document 3/6…"), then the file `{passportId}_Visa_Submission_Unsigned.pdf`.
5. Open the PDF. Check the order is Passport, police reports, Medical, Scan, and images are on A4 pages.
6. On a candidate with no verified documents, check the error and that nothing downloads.
7. Upload a non-PDF (for example a JPG). It must be rejected.
8. Upload a PDF. Check the message "stage is now completed" and that the stage shows completed.
9. Try a candidate without an active Job. The document should save, the stage stay open, and the reason show.
10. Remove the signed document. The stage must go back to not completed.
11. Sign in as ANALYST. Download must be hidden and Upload disabled.
12. As ADMIN open **Audit Logs**. Find "Visa submission downloaded" for the download in step 4.
13. Start a download with a large set of documents and try to close or reload the tab while "Preparing document…" shows. The browser should warn you. After the file is saved, closing the tab must not warn.

---

## 8. Phase 2: bulk extraction

### Flow
1. Open **Visa Submission** in the sidebar (Admin, Owner, Team Lead only).
2. **Extract:** pick a Job (shown with client, primary trade and the number of eligible candidates) and click **Extract Completed Candidates**.
3. A preview lists the candidates in order, any warnings, the target folder and the two Excel file names. Confirm to start.
4. The browser sends the candidates in batches and shows "Batch 2 of 5". Keep the tab open: a leave-page warning shows only while batches run.
5. A summary lists extracted, skipped, failed (with reasons) and warnings.
6. **Files:** browse `VISA SUBMISSION` (date, then `Plan B`, then files). Download a file, or **Download ZIP** for a folder.

### Eligibility rules
A candidate is extracted for a Job when **all** are true:
1. The candidate has a `JobCandidate` row for that Job that has **not been released** (`releasedAt` is empty). Active or inactive both count.
2. The `VISA_SUBMISSION` stage is completed.
3. The candidate has a current, verified signed `VISA_SUBMISSION` document.
4. That document has not been extracted before.

Order is the upload time of the signed document, oldest first. A re-uploaded signed document is a new document, so the candidate is extracted again. A candidate is **skipped with a warning** if the passport number is not usable as a file name, or if two candidates on the Job have passport numbers that differ only by letter case.

### Folder structure
```
VISA SUBMISSION/
  2026-11-24/            (Asia/Colombo date; the same folder all day)
    Plan B/
      AB1234567.pdf      (copy of the signed PDF, named by passport number)
      Candidate_Details_{Client}.xlsx
      Extra_Details_{Client}.xlsx
```
Same-day extractions use the same folder. A PDF with the same name is replaced. The original in the candidate's storage is never touched. Client names are made safe for file names but stay readable.

### Excel files (one pair per client)
**Candidate_Details_{Client}.xlsx**: `First name | Last name | Passport number | Profession`. First name is `firstName`, Last name is `otherName`, Passport number is `passportId`, Profession is empty.

**Extra_Details_{Client}.xlsx**: row 1 is the title `EXTRA DETAIL FOR ({Client})` (merged, bold, yellow); row 2 holds the headers (dark blue, white bold, wrapped): `GROUP`, `Running No.`, `Candidate's First Name`, `Candidate's Last Name`, `Primary Trade מקצוע ראשי`, `Secondary Trade מקצוע משני / Soft skill`, `PP No.`, `Communication Skills ידע אנגלית-רמת תקשורת`, `cloths size`, `Pant size`, `Shoe size`.

| Column | Source |
|---|---|
| GROUP | Empty |
| Running No. | 1, 2, 3, continuing from the last number in the file |
| First / Last name | `firstName` / `otherName` |
| Primary Trade | First job type of the Job |
| Secondary Trade / Soft skill | `Can Read Drawings: Yes, Team Leading: Yes, Languages: ...`, only the parts that apply; empty if none |
| PP No. | `passportId` |
| Communication Skills | `englishKnowledge` (older levels are read as ENGLISH 6 to 10) |
| cloths / Pant / Shoe size | T-shirt, pant and shoe size from Additional Details |

**Append rules:** if the file exists it is downloaded, new rows are added in completed order, and it is uploaded again. If the passport number already has a row (a re-extraction after a re-upload), that row is updated instead of adding a duplicate; it keeps its Running No. Cells starting with `=`, `+`, `-` or `@` are escaped so they cannot run as formulas.

### Limitations
- **ZIP limit:** at most 300 files and 200 MB per ZIP, checked before streaming starts. Over the limit the page says to download files one by one (413 `ZIP_TOO_LARGE`). This keeps the stream inside Vercel's 60 s limit.
- The folder browser shows up to 1,000 entries per folder and says when the list is cut.
- Closing the tab in the middle of a run stops it. Already finished batches stay; start again and only the remaining candidates are extracted.
- Two different clients whose names become the same file name share one pair of Excel files.
- Removing a candidate document keeps its extraction record with an empty document link.
- The system does not edit the Excel files after creating them, except to append. If someone edits a file by hand, the next append reads that edited file.
- Folder names with spaces (`VISA SUBMISSION`, `Plan B`) were checked only against the Supabase client library, not a real bucket. If a bucket rejects them, change `VISA_SUBMISSION_ROOT` and `VISA_SUBMISSION_PLAN_FOLDER` in `src/config/visaSubmission.js` (for example to `VISA_SUBMISSION` and `Plan_B`).

### How to test manually
1. Prepare a Job with two candidates that have a completed Visa Submission stage and a signed PDF, and one without.
2. Sign in as ADMIN, TEAM_LEAD or OWNER and open **Visa Submission**. Check the Job shows an eligible count of 2.
3. Click **Extract Completed Candidates**. Check the preview order (oldest signed upload first) and confirm.
4. Check progress, then the summary: 2 extracted.
5. In **Files** open today's date, then `Plan B`. Check `{passportId}.pdf` for both, and the two Excel files for the client.
6. Open `Extra_Details_{Client}.xlsx`: check the title, headers, and one row per candidate with Running No. 1 and 2. Open `Candidate_Details_{Client}.xlsx`: check Profession is empty.
7. Run Extract again. Nothing should be eligible.
8. Upload a new signed PDF for one candidate and extract again. Check that candidate is extracted again, the PDF is replaced, and the Excel row is updated (no duplicate row).
9. Complete another candidate and extract. Check the new row has Running No. 3.
10. Download one file, then **Download ZIP** for `Plan B`. Open the ZIP.
11. Sign in as ANALYST. The Visa Submission item must be missing, and opening the address must redirect.
12. In **Audit Logs** find "Visa submission extracted", "file downloaded" and "ZIP downloaded".
13. While a run is in progress try to close the tab. The browser should warn you.
