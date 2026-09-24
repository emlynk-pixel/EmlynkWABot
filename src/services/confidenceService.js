import { DOCUMENT_TYPES } from "./documentClassificationService.js";
import { TEXT_EXTRACTION_METHODS } from "./ocrService.js";
import { CROSS_CHECK } from "./passportExtractionService.js";

// All confidence values in this project use one scale: 0-100 (percent),
// matching Tesseract and the proposal's bands (§17, §32).
//
// Three separate values, never mixed up:
// - extractionConfidence: how reliably the text was read (PDF text layer or OCR)
// - classificationConfidence: how strongly the text shows the document type
// - field confidence: how reliable one extracted passport field is

// Proposal §17. Rename and storage decisions are applied in Phase 7; they
// live here so the band table stays in one place.
export const CONFIDENCE_BANDS = Object.freeze({
    VERIFIED: { name: "VERIFIED", flag: null, reviewRequired: false, renameAllowed: true, storageArea: "PERMANENT" },
    HIGH_CONFIDENCE: { name: "HIGH_CONFIDENCE", flag: "OPTIONAL_REVIEW", reviewRequired: false, renameAllowed: true, storageArea: "PERMANENT" },
    SLIGHTLY_UNCLEAR: { name: "SLIGHTLY_UNCLEAR", flag: "WARNING", reviewRequired: false, renameAllowed: true, storageArea: "PERMANENT" },
    UNCLEAR: { name: "UNCLEAR", flag: "REVIEW", reviewRequired: true, renameAllowed: false, storageArea: "PERMANENT" },
    UNDEFINED: { name: "UNDEFINED", flag: "CRITICAL_REVIEW", reviewRequired: true, renameAllowed: false, storageArea: "UNDEFINED" },
});

// The 90% boundary is marked "configurable" in the proposal.
export const CONFIDENCE_THRESHOLDS = Object.freeze({
    VERIFIED_ABOVE: 95,
    HIGH_CONFIDENCE_FROM: 90,
    SLIGHTLY_UNCLEAR_FROM: 60,
    UNCLEAR_FROM: 40,
});

// Above 95 | 90-95 | 60-89 | 40-59 | below 40
export function getConfidenceBand(confidence) {
    const value = Number.isFinite(confidence) ? confidence : 0;

    if (value > CONFIDENCE_THRESHOLDS.VERIFIED_ABOVE) return CONFIDENCE_BANDS.VERIFIED;
    if (value >= CONFIDENCE_THRESHOLDS.HIGH_CONFIDENCE_FROM) return CONFIDENCE_BANDS.HIGH_CONFIDENCE;
    if (value >= CONFIDENCE_THRESHOLDS.SLIGHTLY_UNCLEAR_FROM) return CONFIDENCE_BANDS.SLIGHTLY_UNCLEAR;
    if (value >= CONFIDENCE_THRESHOLDS.UNCLEAR_FROM) return CONFIDENCE_BANDS.UNCLEAR;
    return CONFIDENCE_BANDS.UNDEFINED;
}

// Embedded PDF text is exact. OCR reports its own confidence. Anything
// that produced no text has nothing to trust.
export function getExtractionConfidence(textExtraction) {
    if (!textExtraction?.success) return 0;
    if (textExtraction.method === TEXT_EXTRACTION_METHODS.PDF_TEXT) return 100;
    return clamp(textExtraction.confidence);
}

// Content score -> confidence. The classifier only returns a type when the
// score is at least 3 with a clear lead, so the table starts there.
// A type taken from the filename alone is never enough (proposal §5, §17),
// so it always lands in the UNDEFINED band and needs review.
const CONTENT_SCORE_CONFIDENCE = [
    { minScore: 6, confidence: 100 },
    { minScore: 5, confidence: 95 },
    { minScore: 4, confidence: 90 },
    { minScore: 3, confidence: 80 },
];
const FILENAME_ONLY_CONFIDENCE = 30;

export function getClassificationConfidence({ resolvedType, contentClassification }) {
    if (!resolvedType || resolvedType.documentType === DOCUMENT_TYPES.UNKNOWN) return 0;
    if (resolvedType.source === "FILENAME") return FILENAME_ONLY_CONFIDENCE;

    const score = contentClassification?.score ?? 0;
    return CONTENT_SCORE_CONFIDENCE.find((row) => score >= row.minScore)?.confidence ?? 0;
}

export const DOCUMENT_FLAGS = Object.freeze({
    WRONG_DOCUMENT_SUSPECTED: "WRONG_DOCUMENT_SUSPECTED",
    CLASSIFIED_FROM_FILENAME_ONLY: "CLASSIFIED_FROM_FILENAME_ONLY",
    NO_READABLE_TEXT: "NO_READABLE_TEXT",
    CORRUPT_FILE: "CORRUPT_FILE",
});

// Overall confidence for one received document. It's the weaker of the two
// signals: a perfectly read document of unclear type is still unclear.
export function assessDocumentConfidence({ textExtraction, contentClassification, resolvedType }) {
    const extractionConfidence = getExtractionConfidence(textExtraction);
    const classificationConfidence = getClassificationConfidence({ resolvedType, contentClassification });
    const documentConfidence = Math.min(extractionConfidence, classificationConfidence);
    const band = getConfidenceBand(documentConfidence);

    const flags = [];
    if (textExtraction?.method === TEXT_EXTRACTION_METHODS.PDF_PARSE_FAILED) flags.push(DOCUMENT_FLAGS.CORRUPT_FILE);
    else if (!textExtraction?.success) flags.push(DOCUMENT_FLAGS.NO_READABLE_TEXT);
    if (resolvedType?.source === "FILENAME") flags.push(DOCUMENT_FLAGS.CLASSIFIED_FROM_FILENAME_ONLY);
    if (resolvedType?.filenameMismatch) flags.push(DOCUMENT_FLAGS.WRONG_DOCUMENT_SUSPECTED);

    return {
        extractionConfidence,
        classificationConfidence,
        documentConfidence,
        band: band.name,
        bandFlag: band.flag,
        // A wrong-document suspicion needs a human even in a high band (§17).
        reviewRequired: band.reviewRequired || flags.includes(DOCUMENT_FLAGS.WRONG_DOCUMENT_SUSPECTED),
        flags,
    };
}

// Field confidence for extracted passport values. MRZ check digits are
// independent proof of a correct read, so they count for more than OCR's
// own confidence. A single unchecked printed value can't be better than
// the OCR that produced it.
export function getPassportFieldConfidence(field, extractionConfidence) {
    if (!field?.value) return 0;
    if (field.crossCheck === CROSS_CHECK.MISMATCH) return 30;

    if (field.source === "MRZ") {
        if (field.checkDigitValid === true) {
            return field.crossCheck === CROSS_CHECK.MATCH ? 100 : 97;
        }
        if (field.checkDigitValid === false) return 30;
        // MRZ names have no check digit.
        return field.crossCheck === CROSS_CHECK.MATCH ? 97 : Math.min(extractionConfidence, 90);
    }

    // Printed value. A corrupted MRZ that still agrees with it is decent evidence.
    if (field.checkDigitValid === false && field.crossCheck === CROSS_CHECK.MATCH) return 90;
    return Math.min(extractionConfidence, 90);
}

export function assessPassportFieldConfidence(passportExtraction, extractionConfidence) {
    return Object.fromEntries(
        Object.entries(passportExtraction?.fields ?? {}).map(([name, field]) => {
            const confidence = getPassportFieldConfidence(field, extractionConfidence);
            return [name, { confidence, band: getConfidenceBand(confidence).name }];
        })
    );
}

function clamp(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, value));
}
