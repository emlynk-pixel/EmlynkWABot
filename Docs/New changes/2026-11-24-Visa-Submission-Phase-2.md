# New feature updates

**Date:** 24 November 2026
**Applies to:** the admin dashboard (`admin/`), the backend (`src/`) and the database (`prisma/`)

| # | Feature | In one sentence |
|---|---|---|
| 1 | Visa Submission tab: bulk extraction | Copy the signed Visa Submission PDFs of completed candidates for a Job into a dated storage folder, named by passport number. |
| 2 | Excel files per client | Two Excel files per client are created and appended to on every extraction. |
| 3 | Files browser and ZIP | Browse the extracted folders and download files one by one or a folder as a ZIP. |

---

## 1. Extracting completed candidates

### What you will notice
A new **Visa Submission** item in the sidebar, for Admin, Owner and Team Lead only (Analysts do not see it).

### How to use it
1. Open **Visa Submission**. In **Extract**, choose a Job. It shows the client, primary trade and how many candidates are ready.
2. Click **Extract Completed Candidates**. Check the preview (candidates in order, warnings, target folder) and confirm.
3. Wait for the batches to finish and keep the tab open. A leave-page warning shows only while it runs.
4. Read the summary: extracted, skipped, failed (with reasons).

### Who is extracted
A candidate is extracted when they are on the Job (not released from it), their Visa Submission stage is completed, they have a current verified signed PDF, and that PDF was not extracted before. If a new signed PDF is uploaded later, the candidate is extracted again. The order is the upload time of the signed PDF, oldest first. The vacancy count never blocks an extraction.

### Where the files go
`VISA SUBMISSION/{YYYY-MM-DD}/Plan B/` in the private bucket. The date is the Sri Lanka date (Asia/Colombo). All extractions on the same day share the folder.
- `{passportNumber}.pdf`: a **copy** of the signed PDF. The original stays where it was.
- `Candidate_Details_{Client}.xlsx`: First name, Last name, Passport number, Profession (empty).
- `Extra_Details_{Client}.xlsx`: title row, then GROUP, Running No., names, Primary Trade, Secondary Trade / Soft skill, PP No., Communication Skills, cloths, Pant and Shoe size.

Later extractions the same day add rows. A candidate extracted again gets their row updated instead of a duplicate. Last name comes from the candidate's `otherName` field.

## 2. Files browser and ZIP
Under **Files**, open the date folder, then `Plan B`. Download a file, or **Download ZIP** for a folder. A ZIP can hold at most 300 files and 200 MB. Above that the page asks you to download files one by one.

## Good to know
- Two people extracting for the same client on the same day cannot overlap: the second gets "Extraction in progress, try again" and the page retries automatically.
- Closing the tab during a run stops it. Finished batches stay; run it again to continue.
- If the Excel files cannot be updated, the page stops and says so; no candidate of that batch is marked as extracted, so **Retry** adds them to both files exactly once (no duplicate rows, Running No. stays in order). The storage bucket must allow `.xlsx` files (MIME type `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`) in every environment. The server log names the underlying cause.
- Every extraction, file download and ZIP download is written to the Audit Logs.
- The folder names with spaces were checked against the Supabase client library only. If a bucket rejects them, change `VISA_SUBMISSION_ROOT` and `VISA_SUBMISSION_PLAN_FOLDER` in `src/config/visaSubmission.js`.

## Where the code is
See [Docs/Visa Submission/ARCHITECTURE.md](../Visa%20Submission/ARCHITECTURE.md) (section 5) and [README.md](../Visa%20Submission/README.md) (section 8).

## Database migration
`prisma/migrations/20261124140000_visa_submission_extractions/` is additive: it creates `visa_submission_extraction` and `visa_submission_extraction_lock`. No existing table or row changes. Run it like any other migration (`npx prisma migrate deploy`) when deploying.

## New dependency
`archiver` 7.0.1 (backend), pinned, to build the ZIP.

## Tests
- Backend: `npm test` passed (2,885 pass, 0 fail, 22 skipped).
- Admin: typecheck, 982 tests and the build passed.
