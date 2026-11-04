// The candidate's workflow Status (Admin > Candidates list, "Status" column): ONE derived value,
// computed here from the candidate's existing data. Nothing stores it and nobody edits it.
//
// Ladder, lowest to highest (a candidate shows the highest one that currently holds):
//   REGISTERED < JOB_ASSIGNED < FORM_SUBMITTED < DETAILS_VERIFIED < DOCUMENTS_VERIFIED < VISA_DOCUMENT_READY
//   < VISA_SUBMITTED < DEPARTED
// (Checked from the top: DEPARTED when the candidate is recorded as departed (candidate.departed_at,
// the bulk import's VISA STATUS "Departed"; completing the Finalizing job stage is NOT departure),
// VISA_SUBMITTED when the Visa submission stage is completed, then VISA_DOCUMENT_READY once Document
// submission is complete.)
// STOPPED_WITH_TEST is not a step of the ladder but an override: while the saved Test details
// result is FAIL, nothing above it applies; when the result is no longer FAIL the ladder is
// read again from the current data. Docs/20-candidate-management.md §4.1 has the signals.

export const WORKFLOW_STATUS = Object.freeze({
    REGISTERED: "REGISTERED",
    STOPPED_WITH_TEST: "STOPPED_WITH_TEST",
    JOB_ASSIGNED: "JOB_ASSIGNED",
    FORM_SUBMITTED: "FORM_SUBMITTED",
    DETAILS_VERIFIED: "DETAILS_VERIFIED",
    DOCUMENTS_VERIFIED: "DOCUMENTS_VERIFIED",
    VISA_DOCUMENT_READY: "VISA_DOCUMENT_READY",
    VISA_SUBMITTED: "VISA_SUBMITTED",
    DEPARTED: "DEPARTED",
});

export const WORKFLOW_STATUS_LABELS = Object.freeze({
    REGISTERED: "Registered",
    STOPPED_WITH_TEST: "Stopped with Test",
    JOB_ASSIGNED: "Job Assigned",
    FORM_SUBMITTED: "Form Submitted",
    DETAILS_VERIFIED: "Details Verified",
    DOCUMENTS_VERIFIED: "Documents Verified",
    VISA_DOCUMENT_READY: "Visa Document Ready",
    VISA_SUBMITTED: "Visa Submitted",
    DEPARTED: "Departed",
});

const status = (code) => ({ code, label: WORKFLOW_STATUS_LABELS[code] });

// signals (all plain booleans / the saved test result, gathered by candidateService from the database):
//   testResult          the saved TEST_DETAILS result ("PASS" | "FAIL" | null)
//   hasCurrentJob       an active job_candidate on a PROCESSING job
//   formSubmitted       the Candidate Form was submitted (candidate_form_access.status = SUBMITTED)
//   detailsVerified     a manager explicitly verified the details (candidate_verification)
//   documentsVerified   a manager explicitly verified the documents (candidate_verification)
//   documentSubmissionCompleted   the Document submission stage is completed (every required
//                       document on record) = Visa Document Ready. Not the Visa submission stage.
//   visaSubmitted       the Visa submission stage is completed (by an admin, or the import's "Submit")
//   departed            candidate.departed_at is set (the import's VISA STATUS "Departed")
export function deriveCandidateWorkflowStatus({ testResult = null, hasCurrentJob = false, formSubmitted = false, detailsVerified = false, documentsVerified = false, documentSubmissionCompleted = false, visaSubmitted = false, departed = false } = {}) {
    if (testResult === "FAIL") return status(WORKFLOW_STATUS.STOPPED_WITH_TEST);
    if (departed) return status(WORKFLOW_STATUS.DEPARTED);
    if (visaSubmitted) return status(WORKFLOW_STATUS.VISA_SUBMITTED);
    if (documentSubmissionCompleted) return status(WORKFLOW_STATUS.VISA_DOCUMENT_READY);
    if (documentsVerified) return status(WORKFLOW_STATUS.DOCUMENTS_VERIFIED);
    if (detailsVerified) return status(WORKFLOW_STATUS.DETAILS_VERIFIED);
    if (formSubmitted) return status(WORKFLOW_STATUS.FORM_SUBMITTED);
    if (hasCurrentJob) return status(WORKFLOW_STATUS.JOB_ASSIGNED);
    return status(WORKFLOW_STATUS.REGISTERED);
}
