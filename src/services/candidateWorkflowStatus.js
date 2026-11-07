// The candidate's workflow Status (Admin > Candidates list, Work Allocation, Job details, the
// candidate page): ONE derived value, computed here from the candidate's existing data on every
// read. Nothing stores the Status and nobody edits it, so it follows the data at once: a stage
// completed on the candidate page, a verification, a Candidate Form submission, a bulk import or a
// recorded final status shows everywhere on the next read.
//
// Order of precedence (the first that holds wins):
//   1. a recorded final outcome (candidate.outcome): VISA_NOT_GOING, CANCELLED or REJECTED. Final:
//      it outranks everything, the test result included. Set by the bulk import's VISA STATUS (Got
//      Visa Not Going / Cancelled / Reject) or by an Admin on the candidate page.
//   2. STOPPED_WITH_TEST while the saved Test details result is FAIL (an override, not a step: when the
//      result is no longer FAIL the ladder below is read again from the current data).
//   3. the ladder, highest first:
//        DEPARTED            candidate.departed_at (import "Departed", or an Admin on the candidate page)
//        VISA_APPROVED       the Visa approval stage is completed (import "Got Visa", or completed by hand)
//        VISA_SUBMITTED      the Visa submission stage is completed (import "Submit", or by hand)
//        VISA_DOCUMENT_READY the Document submission stage is complete (every required document on record)
//        DOCUMENTS_VERIFIED  an Admin verified the documents
//        DETAILS_VERIFIED    an Admin verified the details
//        FORM_SUBMITTED      the candidate submitted the Candidate Form
//        JOB_ASSIGNED        an active job assignment
//        TEST_PASSED         the saved Test details result is PASS
//        REGISTERED          otherwise
// Docs/20-candidate-management.md §4.0 has the signals.

export const WORKFLOW_STATUS = Object.freeze({
    REGISTERED: "REGISTERED",
    STOPPED_WITH_TEST: "STOPPED_WITH_TEST",
    TEST_PASSED: "TEST_PASSED",
    JOB_ASSIGNED: "JOB_ASSIGNED",
    FORM_SUBMITTED: "FORM_SUBMITTED",
    DETAILS_VERIFIED: "DETAILS_VERIFIED",
    DOCUMENTS_VERIFIED: "DOCUMENTS_VERIFIED",
    VISA_DOCUMENT_READY: "VISA_DOCUMENT_READY",
    VISA_SUBMITTED: "VISA_SUBMITTED",
    VISA_APPROVED: "VISA_APPROVED",
    DEPARTED: "DEPARTED",
    VISA_NOT_GOING: "VISA_NOT_GOING",
    CANCELLED: "CANCELLED",
    REJECTED: "REJECTED",
});

export const WORKFLOW_STATUS_LABELS = Object.freeze({
    REGISTERED: "Registered",
    STOPPED_WITH_TEST: "Stopped with Test",
    TEST_PASSED: "Test Passed",
    JOB_ASSIGNED: "Job Assigned",
    FORM_SUBMITTED: "Form Submitted",
    DETAILS_VERIFIED: "Details Verified",
    DOCUMENTS_VERIFIED: "Documents Verified",
    VISA_DOCUMENT_READY: "Visa Document Ready",
    VISA_SUBMITTED: "Visa Submitted",
    VISA_APPROVED: "Visa Approved",
    DEPARTED: "Departed",
    VISA_NOT_GOING: "Visa Not Going",
    CANCELLED: "Cancelled",
    REJECTED: "Rejected",
});

// The final outcomes a candidate can have recorded (candidate.outcome; the database CHECK holds the
// same list). Departed is recorded separately (candidate.departed_at); a candidate never has both.
export const CANDIDATE_OUTCOME = Object.freeze({
    VISA_NOT_GOING: "VISA_NOT_GOING",
    CANCELLED: "CANCELLED",
    REJECTED: "REJECTED",
});
export const isCandidateOutcome = (value) => Object.hasOwn(CANDIDATE_OUTCOME, value);

const status = (code) => ({ code, label: WORKFLOW_STATUS_LABELS[code] });

// signals (plain booleans / the saved test result / the recorded outcome, gathered by candidateService):
//   outcome             candidate.outcome (VISA_NOT_GOING | CANCELLED | REJECTED) or null
//   testResult          the saved TEST_DETAILS result ("PASS" | "FAIL" | null)
//   hasCurrentJob       an active job_candidate on a PROCESSING job
//   formSubmitted       the Candidate Form was submitted (candidate_form_access.status = SUBMITTED)
//   detailsVerified     an Admin explicitly verified the details (candidate_verification)
//   documentsVerified   an Admin explicitly verified the documents (candidate_verification)
//   documentSubmissionCompleted   the Document submission stage is completed (every required
//                       document on record) = Visa Document Ready. Not the Visa submission stage.
//   visaSubmitted       the Visa submission stage is completed
//   visaApproved        the Visa approval stage is completed
//   departed            candidate.departed_at is set
export function deriveCandidateWorkflowStatus({
    outcome = null, testResult = null, hasCurrentJob = false, formSubmitted = false, detailsVerified = false, documentsVerified = false,
    documentSubmissionCompleted = false, visaSubmitted = false, visaApproved = false, departed = false,
} = {}) {
    if (isCandidateOutcome(outcome)) return status(WORKFLOW_STATUS[outcome]);
    if (testResult === "FAIL") return status(WORKFLOW_STATUS.STOPPED_WITH_TEST);
    if (departed) return status(WORKFLOW_STATUS.DEPARTED);
    if (visaApproved) return status(WORKFLOW_STATUS.VISA_APPROVED);
    if (visaSubmitted) return status(WORKFLOW_STATUS.VISA_SUBMITTED);
    if (documentSubmissionCompleted) return status(WORKFLOW_STATUS.VISA_DOCUMENT_READY);
    if (documentsVerified) return status(WORKFLOW_STATUS.DOCUMENTS_VERIFIED);
    if (detailsVerified) return status(WORKFLOW_STATUS.DETAILS_VERIFIED);
    if (formSubmitted) return status(WORKFLOW_STATUS.FORM_SUBMITTED);
    if (hasCurrentJob) return status(WORKFLOW_STATUS.JOB_ASSIGNED);
    if (testResult === "PASS") return status(WORKFLOW_STATUS.TEST_PASSED);
    return status(WORKFLOW_STATUS.REGISTERED);
}
