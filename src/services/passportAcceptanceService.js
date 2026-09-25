import { CONFIDENCE_BANDS, DOCUMENT_FLAGS } from "./confidenceService.js";
import { DOCUMENT_TYPES } from "./documentClassificationService.js";
import { IDENTITY_STATUS } from "./identityVerificationService.js";

// Low-quality passport scans (approved business rule).
//
// Company passports are usually poor scans: OCR reports ~30-40% for the whole
// page (photo, background pattern, stamps), so the document band is
// UNDEFINED even when every field that matters was read correctly. For
// passports only, correctness can be proven independently of OCR quality:
// MRZ check digits for the passport number, date of birth and expiry, the
// same client found by passport number and by WhatsApp number, and DOB and
// expiry equal to the client's stored values.
//
// When all of that holds, the document may go to the client folder, but
// only as UNCLEAR: verification_status REVIEW_REQUIRED, no standard rename,
// and the measured document confidence is kept as it is. The global
// thresholds are unchanged; police and medical documents have no such proof.

export const PASSPORT_ACCEPTANCE_FLAG = DOCUMENT_FLAGS.PASSPORT_ACCEPTED_BY_MRZ_AND_IDENTITY;

// Bands this rule looks at. Better bands already go to the client folder.
const LOW_BANDS = new Set([CONFIDENCE_BANDS.UNDEFINED.name, CONFIDENCE_BANDS.UNCLEAR.name]);

// Band used for storage when the rule applies.
const ACCEPTED_BAND = CONFIDENCE_BANDS.UNCLEAR;

const isVerifiedField = (fieldConfidence, field) =>
    fieldConfidence?.[field]?.band === CONFIDENCE_BANDS.VERIFIED.name;

const isMatched = (reconciliation, field) =>
    (reconciliation?.matchedFields ?? []).some((entry) => entry.field === field);

// Every condition must pass. Names only, so the list is safe to log.
const CONDITIONS = [
    ["PASSPORT_DOCUMENT", (s) => s.resolvedType?.documentType === DOCUMENT_TYPES.PASSPORT],
    ["TYPE_FROM_CONTENT", (s) => s.resolvedType?.source === "CONTENT"
        && !s.confidence?.flags?.includes(DOCUMENT_FLAGS.CLASSIFIED_FROM_FILENAME_ONLY)],
    ["NO_WRONG_DOCUMENT_SUSPICION", (s) => !s.resolvedType?.filenameMismatch
        && !s.confidence?.flags?.includes(DOCUMENT_FLAGS.WRONG_DOCUMENT_SUSPECTED)],
    ["TWO_MRZ_LINES", (s) => s.passport?.mrz?.linesFound === 2],
    ["PASSPORT_ID_VERIFIED", (s) => isVerifiedField(s.fieldConfidence, "passportId")],
    ["DATE_OF_BIRTH_VERIFIED", (s) => isVerifiedField(s.fieldConfidence, "dateOfBirth")],
    ["EXPIRY_DATE_VERIFIED", (s) => isVerifiedField(s.fieldConfidence, "passportExpiryDate")],
    ["IDENTITY_VERIFIED_MATCH", (s) => s.identity?.status === IDENTITY_STATUS.VERIFIED_MATCH],
    ["IDENTITY_NOT_PROVISIONAL", (s) => s.identity?.provisional === false],
    ["NO_RECONCILIATION_CONFLICTS", (s) => Array.isArray(s.reconciliation?.conflicts) && s.reconciliation.conflicts.length === 0],
    ["DATE_OF_BIRTH_MATCHED", (s) => isMatched(s.reconciliation, "dateOfBirth")],
    ["EXPIRY_DATE_MATCHED", (s) => isMatched(s.reconciliation, "passportExpiryDate")],
];

// Pure. Returns null when the rule doesn't apply (not a low band), otherwise
// { accepted, failedConditions }. Checksum duplicate and cross-client rules
// are not part of this: decidePlacement applies them first, whatever the band.
export function evaluatePassportAcceptance(state) {
    if (!LOW_BANDS.has(state?.confidence?.band)) {
        return null;
    }
    const failedConditions = CONDITIONS.filter(([, check]) => !check(state)).map(([name]) => name);
    return { accepted: failedConditions.length === 0, failedConditions };
}

// The confidence result used for storage. Unchanged unless the rule accepted
// the document; then only the band (UNCLEAR) and the flag change. The
// measured band is kept, and documentConfidence is never touched.
export function applyPassportAcceptance(confidence, acceptance) {
    if (!acceptance?.accepted) {
        return confidence;
    }
    return {
        ...confidence,
        measuredBand: confidence.band,
        band: ACCEPTED_BAND.name,
        bandFlag: ACCEPTED_BAND.flag,
        reviewRequired: true,
        flags: [...confidence.flags, PASSPORT_ACCEPTANCE_FLAG],
    };
}
