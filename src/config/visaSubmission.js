// Visa Submission: who prepares it, and the documents merged into the one
// submission file (in this order). The single backend source for both: the
// routes (routes/admin.js), the manifest (services/visaSubmissionService.js)
// and the VISA_SUBMISSION document's upload, finalize and remove.

import { ROLES } from "../middleware/requireRole.js";

// An OWNER is admitted too (requireRole.js hasRole: a tier naming ADMIN admits OWNER).
// ANALYST, REGISTRATION_DESK and JOB_HANDLER are not.
export const VISA_SUBMISSION_ROLES = Object.freeze([ROLES.ADMIN, ROLES.TEAM_LEAD]);

export const VISA_SUBMISSION_DOCUMENT_TYPE = "VISA_SUBMISSION";

// The merge order. `key` is stable (the audit entry and the frontend use it);
// `variant` null: the document type has no variants. The police slip is not
// part of the submission.
export const VISA_SUBMISSION_SLOTS = Object.freeze([
    { order: 1, key: "PASSPORT", label: "Passport", documentType: "PASSPORT", variant: null },
    { order: 2, key: "SL_NORMAL_POLICE_REPORT", label: "SL Normal Police Report", documentType: "POLICE_REPORT", variant: "SL_NORMAL" },
    { order: 3, key: "SL_VERIFIED_POLICE_REPORT", label: "SL Verified Police Report", documentType: "POLICE_REPORT", variant: "SL_VERIFIED" },
    { order: 4, key: "ROMANIA_POLICE_REPORT", label: "Romania Police Report", documentType: "POLICE_REPORT", variant: "ROMANIA" },
    { order: 5, key: "MEDICAL", label: "Medical", documentType: "MEDICAL", variant: null },
    { order: 6, key: "SCAN", label: "Scan", documentType: "SCAN", variant: null },
].map((slot) => Object.freeze(slot)));

export const VISA_SUBMISSION_SLOT_KEYS = Object.freeze(VISA_SUBMISSION_SLOTS.map((slot) => slot.key));

// ---- Phase 2: extraction into VISA SUBMISSION/ (services/visaExtractionService.js) and its file browser
// (services/visaSubmissionStorage.js). Same roles: VISA_SUBMISSION_ROLES.

// Root of everything Phase 2 writes and the only part of the bucket its browser can reach.
export const VISA_SUBMISSION_ROOT = "VISA SUBMISSION";
// VISA SUBMISSION/{YYYY-MM-DD, Asia/Colombo}/Plan B/
export const VISA_SUBMISSION_PLAN_FOLDER = "Plan B";

// Candidates per extract request: the admin page sends the preview's list in chunks. Small enough that
// one request (copies plus the Excel read-modify-write) ends well inside Vercel's 60 s function limit.
export const VISA_EXTRACTION_BATCH_SIZE = 10;
export const VISA_EXTRACTION_MAX_BATCH_SIZE = 15;

// The ZIP download of a folder is refused (413 ZIP_TOO_LARGE, before anything is streamed) above these:
// it is streamed through one Vercel function invocation, which ends after 60 s.
export const VISA_ZIP_MAX_FILES = 300;
export const VISA_ZIP_MAX_BYTES = 200 * 1024 * 1024;
