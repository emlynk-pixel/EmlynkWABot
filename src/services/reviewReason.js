import { DOCUMENT_TYPES } from "./documentClassificationService.js";
import { DOCUMENT_FLAGS } from "./confidenceService.js";
import { IDENTITY_STATUS } from "./identityVerificationService.js";
import { CHECKSUM_OUTCOME } from "./documentChecksumService.js";
import { POLICE_DATE_STATUS } from "./policeReportDateService.js";

// Why a person must look at a processed submission (temporary_data
// .review_reason, Phase 10). Each code is an existing pipeline decision,
// named; nothing new is decided here. The order below is the order of the
// existing rules (failure, conflicts, unusable document, review blockers,
// low confidence), and the first one that applies is the reason.
export const REVIEW_REASON = Object.freeze({
    PROCESSING_FAILED: "PROCESSING_FAILED",             // processing stopped with an error (FAILED)
    CROSS_CLIENT_DUPLICATE: "CROSS_CLIENT_DUPLICATE",   // same file already stored for another client
    IDENTITY_CONFLICT: "IDENTITY_CONFLICT",             // passport and WhatsApp point at different clients
    RECORD_CONFLICT: "RECORD_CONFLICT",                 // passport values differ from the client record
    DOCUMENT_TYPE_UNCLEAR: "DOCUMENT_TYPE_UNCLEAR",     // unknown type, unclear police type, or filename only
    WRONG_DOCUMENT_SUSPECTED: "WRONG_DOCUMENT_SUSPECTED", // file name and content disagree
    IDENTITY_NOT_CONFIRMED: "IDENTITY_NOT_CONFIRMED",   // no match, ambiguous, passport-only (SEC-008), provisional, unreadable ID
    POLICE_DATE_UNRESOLVED: "POLICE_DATE_UNRESOLVED",   // police slip date ambiguous / invalid / not found
    LOW_CONFIDENCE: "LOW_CONFIDENCE",                   // UNDEFINED or UNCLEAR confidence band
    DUPLICATE_OF_VERIFIED: "DUPLICATE_OF_VERIFIED",     // M4: exact copy of the same client's VERIFIED document
});

// Groups for the Review Queue summary cards.
export const REVIEW_REASON_CATEGORY = Object.freeze({
    [REVIEW_REASON.PROCESSING_FAILED]: "OTHER",
    [REVIEW_REASON.CROSS_CLIENT_DUPLICATE]: "CONFLICT",
    [REVIEW_REASON.IDENTITY_CONFLICT]: "CONFLICT",
    [REVIEW_REASON.RECORD_CONFLICT]: "CONFLICT",
    [REVIEW_REASON.DOCUMENT_TYPE_UNCLEAR]: "QUALITY",
    [REVIEW_REASON.WRONG_DOCUMENT_SUSPECTED]: "QUALITY",
    [REVIEW_REASON.IDENTITY_NOT_CONFIRMED]: "IDENTITY",
    [REVIEW_REASON.POLICE_DATE_UNRESOLVED]: "OTHER",
    [REVIEW_REASON.LOW_CONFIDENCE]: "QUALITY",
    [REVIEW_REASON.DUPLICATE_OF_VERIFIED]: "OTHER",
});

const POLICE_DATE_NEEDS_REVIEW = new Set([POLICE_DATE_STATUS.AMBIGUOUS, POLICE_DATE_STATUS.INVALID, POLICE_DATE_STATUS.NOT_FOUND]);
const UNCLEAR_TYPE_FLAGS = [DOCUMENT_FLAGS.POLICE_TYPE_UNCLEAR, DOCUMENT_FLAGS.CLASSIFIED_FROM_FILENAME_ONLY];
const LOW_BANDS = new Set(["UNDEFINED", "UNCLEAR"]);

// `state` is the processing state of documentProcessingService (or the same
// fields from a stored summary). Returns a REVIEW_REASON or null.
export function deriveReviewReason({ processingStatus, resolvedType, confidence, identity, reconciliation, policeDate, checksum }) {
    const flags = confidence?.flags ?? [];

    if (processingStatus === "FAILED") return REVIEW_REASON.PROCESSING_FAILED;
    if (processingStatus === "DUPLICATE") {
        // M4: a copy of a VERIFIED document waits for an admin; any other
        // same-client duplicate needs nothing (the client already has it).
        return checksum?.existingVerified ? REVIEW_REASON.DUPLICATE_OF_VERIFIED : null;
    }
    if (checksum?.outcome === CHECKSUM_OUTCOME.CROSS_CLIENT_CONFLICT) return REVIEW_REASON.CROSS_CLIENT_DUPLICATE;
    if (identity?.status === IDENTITY_STATUS.IDENTITY_CONFLICT) return REVIEW_REASON.IDENTITY_CONFLICT;
    if ((reconciliation?.conflicts?.length ?? 0) > 0) return REVIEW_REASON.RECORD_CONFLICT;
    if (resolvedType?.documentType === DOCUMENT_TYPES.UNKNOWN || UNCLEAR_TYPE_FLAGS.some((flag) => flags.includes(flag))) {
        return REVIEW_REASON.DOCUMENT_TYPE_UNCLEAR;
    }
    if (flags.includes(DOCUMENT_FLAGS.WRONG_DOCUMENT_SUSPECTED)) return REVIEW_REASON.WRONG_DOCUMENT_SUSPECTED;
    if (identity?.reviewRequired) return REVIEW_REASON.IDENTITY_NOT_CONFIRMED;
    if (POLICE_DATE_NEEDS_REVIEW.has(policeDate?.status)) return REVIEW_REASON.POLICE_DATE_UNRESOLVED;
    if (LOW_BANDS.has(confidence?.band)) return REVIEW_REASON.LOW_CONFIDENCE;
    return null;
}
