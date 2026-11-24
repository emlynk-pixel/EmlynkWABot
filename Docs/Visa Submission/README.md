# Visa Submission

A guide for new team members. For files, routes and data flow see [ARCHITECTURE.md](ARCHITECTURE.md).

| Phase | Status |
|---|---|
| Phase 1: merged unsigned PDF download and signed PDF upload (per candidate) | **Implemented** |
| Phase 2: bulk extraction tab, Excel files and ZIP download | **Planned** (not built) |

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

**Phase 2 (planned):** a new "VISA SUBMISSION" tab to extract completed candidates per Job into dated Supabase folders, with Excel files per client and ZIP download.

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

Do not copy the list anywhere else. Phase 2 will reuse the same constants.

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
| Completion uses the existing visa rules | One source of truth: test PASS and an active Job, as the manual form requires. |
| Rules failing still saves the document | The file is not lost; staff see why the stage is not completed. |
| Removing the signed document reopens the stage | The stage must not stay completed without its document. |
| Every confirmed download is audited | `VISA_SUBMISSION_MERGED_DOWNLOAD` records who downloaded and which documents were included or left out. |

## 6. Limits of the browser merge

- The browser downloads every document, so a slow internet connection makes it slower.
- A very large merge needs PC memory. Close heavy tabs if it fails.
- **Keep the tab open** until the file is saved.
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
