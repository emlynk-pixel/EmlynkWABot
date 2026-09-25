// How the proposal's status words (§22 "Statuses", §24 state machine) map
// onto what the implementation actually records. The dashboard counts and
// the daily report group submissions with this mapping, so the words on the
// screen mean the same thing everywhere. Docs/14 §4g has the full table.
//
// A submission is one received file: a temporary_data row. Its
// processing_status is set by the pipeline (documentProcessingService.js).

import { PROCESSING_STATUS } from "./documentProcessingService.js";

// Set when the row is created (temporaryDataService.js); replaced as soon as
// processing finishes or fails. A row still in this state is being processed
// (or processing was interrupted).
export const RECEIVED_STATUS = "TEMPORARY_STORED";

// Outcome groups used by the dashboard and the daily report.
export const SUBMISSION_OUTCOME = Object.freeze({
    PROCESSING: "PROCESSING",             // received, not finished yet
    STORED: "STORED",                     // stored in the client folder
    NEEDS_REVIEW: "NEEDS_REVIEW",         // held in pending/ for a person
    DUPLICATE: "DUPLICATE",               // the same file was already on record
    FAILED: "FAILED",                     // processing stopped with an error
});

const OUTCOME_BY_STATUS = Object.freeze({
    [RECEIVED_STATUS]: SUBMISSION_OUTCOME.PROCESSING,
    [PROCESSING_STATUS.VERIFIED]: SUBMISSION_OUTCOME.STORED,
    [PROCESSING_STATUS.HIGH_CONFIDENCE]: SUBMISSION_OUTCOME.STORED,
    [PROCESSING_STATUS.SLIGHTLY_UNCLEAR]: SUBMISSION_OUTCOME.STORED,
    [PROCESSING_STATUS.UNCLEAR]: SUBMISSION_OUTCOME.STORED, // stored as REVIEW_REQUIRED
    [PROCESSING_STATUS.UNDEFINED]: SUBMISSION_OUTCOME.NEEDS_REVIEW,
    [PROCESSING_STATUS.MANUAL_REVIEW]: SUBMISSION_OUTCOME.NEEDS_REVIEW,
    [PROCESSING_STATUS.CONFLICT]: SUBMISSION_OUTCOME.NEEDS_REVIEW,
    [PROCESSING_STATUS.DUPLICATE]: SUBMISSION_OUTCOME.DUPLICATE,
    [PROCESSING_STATUS.FAILED]: SUBMISSION_OUTCOME.FAILED,
});

// Unknown codes (none exist today) count as still processing, never as success.
export function submissionOutcome(processingStatus) {
    return OUTCOME_BY_STATUS[processingStatus] ?? SUBMISSION_OUTCOME.PROCESSING;
}

// "Successfully processed": the pipeline finished without an error, whatever
// it decided (stored, held for review, or recognised as a duplicate).
export function isSuccessfullyProcessed(processingStatus) {
    const outcome = submissionOutcome(processingStatus);
    return outcome !== SUBMISSION_OUTCOME.FAILED && outcome !== SUBMISSION_OUTCOME.PROCESSING;
}

// The proposal's "Unclear": read with low confidence (UNCLEAR, 40-59 %,
// stored as REVIEW_REQUIRED) or unreliable (UNDEFINED, below 40 %, held in pending/).
export const UNCLEAR_STATUSES = Object.freeze([PROCESSING_STATUS.UNCLEAR, PROCESSING_STATUS.UNDEFINED]);

// Statuses the processing pipeline writes, per outcome (for where clauses).
export function statusesFor(outcome) {
    return Object.entries(OUTCOME_BY_STATUS).filter(([, value]) => value === outcome).map(([status]) => status);
}
