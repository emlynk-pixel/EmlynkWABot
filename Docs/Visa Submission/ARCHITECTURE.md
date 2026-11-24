# Visa Submission: Architecture (Phase 1)

See [README.md](README.md) for the overview. Phase 1 is described first; Phase 2 (bulk extraction) starts at "5. Phase 2: bulk extraction".

## Files

**Backend**
| File | Change |
|---|---|
| `src/config/visaSubmission.js` | New. `VISA_SUBMISSION_ROLES`, `VISA_SUBMISSION_DOCUMENT_TYPE`, `VISA_SUBMISSION_SLOTS`, `VISA_SUBMISSION_SLOT_KEYS` |
| `src/services/visaSubmissionService.js` | New. Manifest, file stream, download audit |
| `src/routes/admin.js` | 3 new routes; role check for `VISA_SUBMISSION` on upload-target and finalize |
| `src/services/candidateService.js` | PDF-only rule, stage completion on finalize, stage reopen on remove |
| `src/services/auditLogService.js` | Action `VISA_SUBMISSION_MERGED_DOWNLOAD` (category `DOCUMENT`) |
| `src/utils/storageTimeout.js` | `settleWithin` exported |
| `test/visaSubmission.test.js` | New |
| `test/candidates.test.js`, `test/adminReviewActions.test.js` | Updated for the new behaviour and route |

**Admin frontend**
| File | Change |
|---|---|
| `admin/src/auth/roles.ts` | `VISA_SUBMISSION_ROLES`, `canUseVisaSubmission()` |
| `admin/src/api/candidates.ts` | Manifest, file and audit calls; `stageCompletion` type |
| `admin/src/utils/visaSubmissionMerge.ts` | New. Browser merge with `pdf-lib` (lazy-loaded) |
| `admin/src/components/candidate/VisaSubmissionDownload.tsx` | New. Download button and flow |
| `admin/src/components/candidate/StagePanels.tsx`, `DocumentRow.tsx` | Visa section, PDF-only check, completion messages |
| `admin/src/pages/AuditLogsPage.tsx` | Label "Visa submission downloaded" |
| `admin/package.json`, `package-lock.json` | `pdf-lib` added (admin only) |
| `admin/src/test/visaSubmission*.test.ts(x)` | New tests |

No Prisma schema change, no migration, no change to the stage CHECK constraint.

## Routes

All under `/api/admin`. Roles: `VISA_SUBMISSION_ROLES` (ADMIN, TEAM_LEAD; OWNER implied). Others get 403.

| Method | Path | Notes |
|---|---|---|
| GET | `/candidates/:passportId/visa-submission/manifest` | `{ passportId, slots: [{ order, key, label, documentType, variant, status, document }] }`. `document` is `{ documentId, mimeType, size, fileUrl }` only when `VERIFIED` |
| GET | `/candidates/:passportId/visa-submission/files/:documentId` | Streams the file. 404 `DOCUMENT_NOT_FOUND` unless it is the current VERIFIED document of one of the 6 slots for that candidate. 502 on storage error |
| POST | `/candidates/:passportId/visa-submission/merged-download` | Body `{ includedSlots: [key] }`. 201 `{ auditId, passportId, includedSlots, excludedSlots }`. 409 `SLOT_NOT_VERIFIED` if a slot changed. 400 on a bad body |
| POST | `/candidates/:passportId/documents/upload-target` | For type `VISA_SUBMISSION`: `VISA_SUBMISSION_ROLES` only (403 `VISA_SUBMISSION_FORBIDDEN`), PDF only (422 `FILE_REJECTED`) |
| POST | `/candidates/:passportId/documents/finalize` | Same rules, plus `stageCompletion` in the response |
| POST | `/candidates/:passportId/documents/:documentId/remove` | For `VISA_SUBMISSION`: role check in the service; reopens the stage |

Slot status uses the existing `currentOf` rule: the newest VERIFIED document, otherwise the newest one waiting for review. Superseded documents never count. A police report without a variant fills no slot.

## Merge slot config

One list in `src/config/visaSubmission.js`, exposed to the frontend only through the manifest (the frontend has no second copy).

| Order | Key | Type | Variant |
|---|---|---|---|
| 1 | `PASSPORT` | PASSPORT | none |
| 2 | `SL_NORMAL_POLICE_REPORT` | POLICE_REPORT | SL_NORMAL |
| 3 | `SL_VERIFIED_POLICE_REPORT` | POLICE_REPORT | SL_VERIFIED |
| 4 | `ROMANIA_POLICE_REPORT` | POLICE_REPORT | ROMANIA |
| 5 | `MEDICAL` | MEDICAL | none |
| 6 | `SCAN` | SCAN | none |

## Data flow

1. **Manifest:** the browser calls the manifest route and gets each slot's status.
2. **Confirm:** missing or unverified slots are listed; the user cancels or continues. With no verified slot, it stops.
3. **Stream:** the browser fetches each verified file one at a time from the files route (streamed from Supabase; the path comes from the database record, never the request). The merge runs in the browser because of Vercel's response and time limits.
4. **Merge:** `pdf-lib` (loaded on first use) appends PDF pages in slot order and puts JPEG/PNG images on A4 pages. A failing file stops the merge and the error names it.
5. **Audit:** after a successful merge, the browser calls `merged-download`. The server re-checks that every included slot is still VERIFIED and writes one audit row with the included slots, excluded slots and document ids. If this call fails, the file is not saved.
6. **Save:** the browser saves `{passportId}_Visa_Submission_Unsigned.pdf`. Nothing is uploaded or stored.

## Completion logic (signed upload)

Only for document type `VISA_SUBMISSION`:

1. `upload-target` and `finalize` check the role and require a PDF (declared type and `%PDF` header; a bad file is removed from staging).
2. In the finalize transaction the document is saved (the previous VERIFIED one is superseded).
3. The existing `requireVisaPrerequisites` runs (test PASS, active Job).
   - Pass: `CandidateStage(VISA_SUBMISSION)` becomes `completed=true`, `completedAt=now`, with an `UPDATE_STAGE` audit entry. If it was already completed, nothing changes.
   - Fail: the document stays saved, the stage is not changed, and the response has `stageCompletion { completed: false, code: VISA_NEEDS_TEST_PASS | VISA_NEEDS_JOB, reason }`.
4. Removing the VISA_SUBMISSION document sets `completed=false`, `completedAt=null` (audited, only if it was completed).
5. The manual route `PUT /candidates/:passportId/stages/VISA_SUBMISSION` is unchanged.
6. Sheet sync follows the existing database trigger on `candidate_stages`.

---

## 5. Phase 2: bulk extraction

### Files
**Backend**
| File | Change |
|---|---|
| `prisma/schema.prisma`, `prisma/migrations/20261124140000_visa_submission_extractions/` | Models `VisaSubmissionExtraction` and `VisaSubmissionExtractionLock` |
| `src/config/visaSubmission.js` | Shared constants: `VISA_SUBMISSION_ROOT`, `VISA_SUBMISSION_PLAN_FOLDER`, batch sizes, ZIP limits |
| `src/services/visaExtractionService.js` | Eligibility, jobs list, preview, lock, batch |
| `src/services/visaExtractionExcel.js` | Creates and appends the two Excel files |
| `src/services/visaSubmissionStorage.js` | Path validation, folder list, file and ZIP streaming, download audit |
| `src/routes/admin.js`, `src/services/auditLogService.js` | 6 routes; 3 audit actions |
| `package.json` | `archiver` 7.0.1 (pinned) |
| `test/visaExtraction.test.js` | New |

**Admin frontend**
| File | Change |
|---|---|
| `admin/src/pages/VisaSubmissionPage.tsx`, `admin/src/api/visaSubmissionExtraction.ts` | New page and API calls |
| `admin/src/api/client.ts` | `apiGetForFile` (authenticated download that keeps the server file name and error code) |
| `admin/src/layout/navigation.ts`, `admin/src/App.tsx`, `admin/src/components/Icon.tsx` | Nav item, guarded route, icons |
| `admin/src/pages/AuditLogsPage.tsx` | Labels for the 3 new actions |

### Model
- `VisaSubmissionExtraction` (`visa_submission_extraction`): `id`, `passportId`, `jobId`, `documentId` (UNIQUE, nullable, SET NULL), `clientName`, `storagePath`, `extractedAt`, `extractedById`.
- `VisaSubmissionExtractionLock` (`visa_submission_extraction_lock`): `lock_key`, `holder`, `expires_at`.

### Routes
All under `/api/admin`. Roles: `VISA_SUBMISSION_ROLES` (ADMIN, TEAM_LEAD; OWNER implied). Others get 403.

| Method | Path | Notes |
|---|---|---|
| GET | `/visa-submission/extraction/jobs` | `{ jobs: [{ jobId, jobCode, companyJobId, status, client, primaryTrade, eligibleCount }] }`. Every PROCESSING job, plus completed or cancelled jobs that still have eligible candidates |
| GET | `/visa-submission/extraction/jobs/:jobId` | Preview: `{ job, date, folder, files, candidates, skipped, batchSize, maxBatchSize }`. 404 `JOB_NOT_FOUND` |
| POST | `/visa-submission/extraction/jobs/:jobId/extract` | Body `{ passportIds: [1..15] }`. 200 `{ date, folder, processed, extracted, skipped, failed, deferred, remaining }`. 409 `EXTRACTION_IN_PROGRESS`, 502 `EXCEL_UPDATE_FAILED`, 404, 400 |
| GET | `/visa-submission/storage?path=` | `{ root, path, entries, truncated }`. 400 `INVALID_PATH`, 404 `FOLDER_NOT_FOUND`, 502 `STORAGE_UNAVAILABLE` |
| GET | `/visa-submission/storage/file?path=` | Streams one file as an attachment. 404 `FILE_NOT_FOUND` |
| GET | `/visa-submission/storage/zip?path=` | Streams a folder as a ZIP. The root is refused. 413 `ZIP_TOO_LARGE` before streaming |

Audit actions (category `DOCUMENT`): `VISA_SUBMISSION_EXTRACTION` (one per batch that extracted or failed anything), `VISA_SUBMISSION_FILE_DOWNLOAD`, `VISA_SUBMISSION_ZIP_DOWNLOAD`. None holds a URL or session data.

### Extraction data flow
1. **Preview:** the server finds eligible candidates (see README section 8) ordered by `documents.receivedDate`, then `createdDate`, then `passportId`. A candidate is skipped with a warning for an unusable passport number or a case-only duplicate.
2. **Batches:** the browser splits the preview into chunks of `batchSize` and posts each chunk. The server re-checks eligibility of every id and ignores ones that are no longer eligible, so a retry is safe. Candidates the server did not reach in time come back as `deferred` and are queued again (at most 3 times each). `failed` ones are shown and not retried. `remaining` is informational: looping until it reached 0 could never end for a candidate that keeps failing.
3. **Per batch, in this order:**
   1. Take the lock for `{Colombo date}/{client}`.
   2. Copy each signed PDF on the server (`bucket.copy`) to `VISA SUBMISSION/{date}/Plan B/{passportId}.pdf`. An existing destination is removed first, because Supabase refuses to copy onto it. The original is not touched.
   3. Download, update and re-upload the two Excel files (rows matched by passport number, case-insensitive).
   4. In one short transaction insert the extraction rows (`createMany` with `skipDuplicates`) and one audit row.
   5. Release the lock.
   A candidate whose PDF copy failed gets no extraction row. If an Excel update fails, nothing is recorded and the answer is 502, so a retry is safe. An unreadable existing Excel file is never replaced by a fresh one.
4. **Time budget:** every storage call times out after 15 s, and no new copy starts after 30 s. Those candidates are returned as `deferred`.
5. **Folder date:** `Asia/Colombo`, so 18:29:59 UTC is still the same day and 18:30:00 UTC is the next one.

### Lock design
A lease row in `visa_submission_extraction_lock`, taken by one atomic `INSERT ... ON CONFLICT (lock_key) DO UPDATE ... WHERE expires_at <= now() RETURNING holder`. It also takes over an expired lease.
- **Key:** `{Colombo date}/{sanitized client file name}`, the pair of Excel files being protected.
- **Lease:** 120 s (longer than Vercel's 60 s limit), renewed and checked just before the Excel read-modify-write, and deleted at the end.
- **Busy:** HTTP 409 `{ code: "EXTRACTION_IN_PROGRESS", message: "Extraction in progress, try again" }`; the page waits 3 s and retries the same chunk (up to 5 attempts).
- **Why not a Postgres advisory lock:** the app reaches Postgres through a pooler (Supavisor plus a small `pg.Pool`), so a session lock may be taken and released on different connections. A transaction-level advisory lock would need one transaction open across about 20 storage calls, which ties up a pooled connection and meets Prisma's transaction timeout.

### Browsing, files and ZIP
- Every storage route validates the relative path and always prefixes it with `VISA SUBMISSION/`, so `clients/` and other roots cannot be reached. Rejected: any `%` (encoded and double-encoded traversal), backslashes, control characters, a leading `/`, empty, `.` or `..` segments, segments starting with `.`, leading or trailing spaces, unexpected characters, a repeated `path`, more than 6 segments or 512 characters.
- Listing pages through Supabase's 100-entry limit, up to 1,000 entries.
- Files stream with `Content-Disposition: attachment`, a sandbox CSP, `nosniff` and `no-store`. No signed URLs.
- ZIP uses `archiver`, stored without compression, one file fetched at a time. Limits are checked first from storage metadata: 300 files, 200 MB, 100 folders walked.

### Frontend
- `NAV_ITEMS` entry "Visa Submission" with `roles: VISA_SUBMISSION_ROLES` and a route under `<AllowRoles roles={VISA_SUBMISSION_ROLES}>`. Both use `hasRole`, which admits OWNER wherever ADMIN is listed.
- The Extract section drives the batches (progress, 409 retry, deferred re-queue, failed list). The `beforeunload` warning is registered only while batches run and removed on every exit path.
- The Files section builds paths only from what the server returned. Downloads use `apiGetForFile` (authenticated, keeps the server file name and the error code).
