# Visa Submission: Architecture (Phase 1)

See [README.md](README.md) for the overview. Phase 2 (bulk extraction) is **planned** and not described here.

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
