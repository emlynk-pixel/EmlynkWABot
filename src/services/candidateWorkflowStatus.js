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
//   3. the sheet-driven states, highest first, each on its own signal (no earlier step needed):
//        DEPARTED            candidate.departed_at (import "Departed", or an Admin on the candidate page)
//        VISA_APPROVED       the Visa approval stage is completed (import "Got Visa", or completed by hand)
//   4. the Candidates tab flow, strictly gated: a step counts only when every earlier step holds.
//        1 REGISTERED                  otherwise
//        2 TEST_PASSED                 the saved Test details result is PASS
//        3 JOB_ASSIGNED                an active job assignment
//        4 CANDIDATE_DETAILS_VERIFIED  all three sub-steps below, in order (a contiguous prefix counts):
//            CANDIDATE_DETAILS_COLLECTED   the Candidate details stage is complete
//            FORM_SUBMITTED                the candidate submitted the Candidate Form
//            ADDITIONAL_DETAILS_COLLECTED  every Additional details field is filled (additionalDetailsCompletion.js)
//        5 DOCUMENTS_VERIFIED          the Document submission stage is complete
//        6 VISA_DOCUMENT_READY         the Visa submission stage is complete
//      VISA_SUBMITTED (import "Submit", or completed by hand) keeps its old meaning: the Visa submission
//      stage is complete. It is shown whenever that holds but steps 1-5 do not all hold (a sheet-imported
//      candidate without the Candidates tab data), so it outranks steps 1-5 exactly as before; with steps
//      1-5 all holding the same stage is step 6 instead.
// DETAILS_VERIFIED is no longer derived (the manual Verify details action no longer moves the Status);
// the code and label are kept so old links and saved filters stay valid.
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
    CANDIDATE_DETAILS_COLLECTED: "CANDIDATE_DETAILS_COLLECTED",
    ADDITIONAL_DETAILS_COLLECTED: "ADDITIONAL_DETAILS_COLLECTED",
    CANDIDATE_DETAILS_VERIFIED: "CANDIDATE_DETAILS_VERIFIED",
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
    CANDIDATE_DETAILS_COLLECTED: "Candidate Details Collected",
    ADDITIONAL_DETAILS_COLLECTED: "Additional Details Collected",
    CANDIDATE_DETAILS_VERIFIED: "Candidate Details Verified",
});

// Step 4's sub-statuses, in order. While step 4 is partial the Status is the sub-step reached (its own
// code and label) and carries `group` (step 4 itself) and `subStatus` (that sub-step). Reaching the last
// one completes step 4, so ADDITIONAL_DETAILS_COLLECTED is a sub-step label, never the Status itself.
export const CANDIDATE_DETAILS_SUB_STATUSES = Object.freeze([
    WORKFLOW_STATUS.CANDIDATE_DETAILS_COLLECTED, WORKFLOW_STATUS.FORM_SUBMITTED, WORKFLOW_STATUS.ADDITIONAL_DETAILS_COLLECTED,
]);

// The final outcomes a candidate can have recorded (candidate.outcome; the database CHECK holds the
// same list). Departed is recorded separately (candidate.departed_at); a candidate never has both.
export const CANDIDATE_OUTCOME = Object.freeze({
    VISA_NOT_GOING: "VISA_NOT_GOING",
    CANCELLED: "CANCELLED",
    REJECTED: "REJECTED",
});
export const isCandidateOutcome = (value) => Object.hasOwn(CANDIDATE_OUTCOME, value);

// A completed placement (Work Allocation's Completed view): Departed, Cancelled or Rejected. Visa Not
// Going is NOT completed. Derived from candidate.departed_at / candidate.outcome, as Prisma `where`s.
export const COMPLETED_OUTCOMES = Object.freeze([CANDIDATE_OUTCOME.CANCELLED, CANDIDATE_OUTCOME.REJECTED]);
export const completedPlacementWhere = () => ({ OR: [{ outcome: { in: [...COMPLETED_OUTCOMES] } }, { departedAt: { not: null } }] });
// Written out rather than NOT(completed): outcome is nullable, and NOT (outcome IN (...)) is NULL, not true, for a NULL outcome.
export const notCompletedPlacementWhere = () => ({ departedAt: null, OR: [{ outcome: null }, { outcome: { notIn: [...COMPLETED_OUTCOMES] } }] });

const status = (code) => ({ code, label: WORKFLOW_STATUS_LABELS[code] });
// A partial step 4: its own code and label (what filters match), plus the step it belongs to.
const subStatus = (code) => ({ ...status(code), group: status(WORKFLOW_STATUS.CANDIDATE_DETAILS_VERIFIED), subStatus: status(code) });

// signals (plain booleans / the saved test result / the recorded outcome, gathered by candidateService):
//   outcome             candidate.outcome (VISA_NOT_GOING | CANCELLED | REJECTED) or null
//   testResult          the saved TEST_DETAILS result ("PASS" | "FAIL" | null)
//   hasCurrentJob       an active job_candidate on a PROCESSING job
//   candidateDetailsCompleted     the Candidate details stage is complete (automaticStageMissing)
//   formSubmitted       the Candidate Form was submitted (candidate_form_access.status = SUBMITTED)
//   additionalDetailsCompleted    every Additional details field is filled (additionalDetailsCompletion.js)
//   documentSubmissionCompleted   the Document submission stage is complete (every required document on record)
//   visaSubmitted       the Visa submission stage is completed
//   visaApproved        the Visa approval stage is completed
//   departed            candidate.departed_at is set
// detailsVerified / documentsVerified (the manual verifications) may be passed and are ignored.
export function deriveCandidateWorkflowStatus({
    outcome = null, testResult = null, hasCurrentJob = false, candidateDetailsCompleted = false, formSubmitted = false,
    additionalDetailsCompleted = false, documentSubmissionCompleted = false, visaSubmitted = false, visaApproved = false, departed = false,
} = {}) {
    if (isCandidateOutcome(outcome)) return status(WORKFLOW_STATUS[outcome]);
    if (testResult === "FAIL") return status(WORKFLOW_STATUS.STOPPED_WITH_TEST);
    if (departed) return status(WORKFLOW_STATUS.DEPARTED);
    if (visaApproved) return status(WORKFLOW_STATUS.VISA_APPROVED);

    const testPassed = testResult === "PASS";
    const jobAssigned = testPassed && hasCurrentJob;
    const detailsCollected = jobAssigned && candidateDetailsCompleted;
    const formDone = detailsCollected && formSubmitted;
    const detailsVerified = formDone && additionalDetailsCompleted;
    const documentsDone = detailsVerified && documentSubmissionCompleted;

    if (documentsDone && visaSubmitted) return status(WORKFLOW_STATUS.VISA_DOCUMENT_READY);
    if (visaSubmitted) return status(WORKFLOW_STATUS.VISA_SUBMITTED);
    if (documentsDone) return status(WORKFLOW_STATUS.DOCUMENTS_VERIFIED);
    if (detailsVerified) return status(WORKFLOW_STATUS.CANDIDATE_DETAILS_VERIFIED);
    if (formDone) return subStatus(WORKFLOW_STATUS.FORM_SUBMITTED);
    if (detailsCollected) return subStatus(WORKFLOW_STATUS.CANDIDATE_DETAILS_COLLECTED);
    if (jobAssigned) return status(WORKFLOW_STATUS.JOB_ASSIGNED);
    if (testPassed) return status(WORKFLOW_STATUS.TEST_PASSED);
    return status(WORKFLOW_STATUS.REGISTERED);
}
