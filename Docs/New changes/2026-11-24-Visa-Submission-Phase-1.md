# New feature updates

**Date:** 24 November 2026
**Applies to:** the admin dashboard (`admin/`) and the backend (`src/`). No database change.

| # | Feature | In one sentence |
|---|---|---|
| 1 | Visa submission merged PDF | A Download button builds one unsigned PDF from the candidate's verified documents. |
| 2 | Signed upload completes the stage | Uploading the lawyer-signed PDF completes the Visa submission stage when the usual rules pass. |

---

## 1. Visa submission merged PDF

### What you will notice
In the **Visa submission** stage there is a **Download** button next to **Upload**. Only Admin, Owner and Team Lead see it.

### How to use it
1. Open the candidate and the Visa submission stage.
2. Click **Download**.
3. If documents are missing or not verified, a list is shown (for example "Medical (missing)"). Choose **Cancel** or **Download anyway**.
4. Keep the tab open while it shows "Preparing document 3/6…". The file `{passportId}_Visa_Submission_Unsigned.pdf` is then saved.

Order: Passport, SL Normal Police Report, SL Verified Police Report, Romania Police Report, Medical, Scan. Only verified documents are included. If nothing is verified, you get an error and no file.

### Good to know
- The PDF is built in your browser and is never stored. Each download is recorded in the Audit Logs as "Visa submission downloaded".
- A password-protected or damaged document stops the merge and the error names it.

## 2. Signed upload completes the stage

### What changed
- Uploading the signed document now marks the stage **Completed** when the existing rules pass (test PASS and an active Job). Before, the stage had to be ticked by hand.
- If the rules fail, the document is still saved and the screen shows the reason.
- Removing the signed document sets the stage back to not completed.
- **Only PDF** is accepted for this document now.
- **Analysts can no longer upload or remove this document.** Admin, Owner and Team Lead can. Other document types are unchanged.

## Where the code is
See [Docs/Visa Submission/ARCHITECTURE.md](../Visa%20Submission/ARCHITECTURE.md) for files, routes and data flow, and [README.md](../Visa%20Submission/README.md) for the full guide.

## New dependency
`pdf-lib` was added to the **admin** package only. It is loaded on first use and is not part of the main bundle.

## Tests
- Backend: `npm test` passed (2,858 pass, 0 fail, 22 skipped).
- Admin: typecheck, 955 tests and the build passed.
