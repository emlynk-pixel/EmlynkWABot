import { normalizeForMatching } from "../utils/documentText.js";
import { findPassportMrz } from "../utils/mrz.js";

// POLICE_SLIP: the receipt given when a police clearance is applied for; its
// submitted date starts the 21-day wait for the final report (Phase 9).
// POLICE_REPORT: the final police clearance report/certificate. It needs no
// date; receiving it completes the police workflow (Phase 9).
export const DOCUMENT_TYPES = Object.freeze({
    PASSPORT: "PASSPORT",
    POLICE_SLIP: "POLICE_SLIP",
    POLICE_REPORT: "POLICE_REPORT",
    MEDICAL: "MEDICAL",
    UNKNOWN: "UNKNOWN",
});

export const POLICE_DOCUMENT_TYPES = Object.freeze([DOCUMENT_TYPES.POLICE_SLIP, DOCUMENT_TYPES.POLICE_REPORT]);

export const isPoliceDocumentType = (documentType) => POLICE_DOCUMENT_TYPES.includes(documentType);

// Filename classification

// Quick first guess from the filename. It's only a hint: users often send
// files with random names, so content-based classification has the final say.

// Checked in order. The first match wins.
const FILENAME_RULES = [
    { documentType: DOCUMENT_TYPES.PASSPORT, keywords: ["passport", "travel document"] },
    { documentType: DOCUMENT_TYPES.MEDICAL, keywords: ["medical", "health"] },
    { documentType: DOCUMENT_TYPES.POLICE_SLIP, keywords: ["slip", "receipt"] },
    { documentType: DOCUMENT_TYPES.POLICE_REPORT, keywords: ["police", "clearance"] },
];

const FILENAME_MATCH_CONFIDENCE = 50;

export function classifyDocument({ fileName }) {
    if (fileName) {
        const normalizedFileName = fileName.toLowerCase();

        const rule = FILENAME_RULES.find(({ keywords }) =>
            keywords.some((keyword) => normalizedFileName.includes(keyword))
        );

        if (rule) {
            return {
                documentType: rule.documentType,
                confidence: FILENAME_MATCH_CONFIDENCE,
                source: "FILENAME",
            };
        }
    }

    return {
        documentType: DOCUMENT_TYPES.UNKNOWN,
        confidence: 0,
        source: "FILENAME",
    };
}

// Content classification

// Police documents are first recognised as one family, with the same
// indicators as before, then split into slip or final report (below).
const POLICE_FAMILY = "POLICE";

// Each indicator counts once, however often it appears. Weight 2 is for
// phrases that almost only appear on that document type; weight 1 is for
// words that also show up elsewhere (e.g. police certificates often print
// "Passport No", so "passport" alone must not decide the type).
const CONTENT_INDICATORS = {
    [DOCUMENT_TYPES.PASSPORT]: [
        { id: "passport", weight: 1, pattern: /\bpassport\b/ },
        { id: "passport_number", weight: 1, pattern: /\bpassport\s*(no|number|#)\b/ },
        { id: "nationality", weight: 1, pattern: /\bnationality\b/ },
        { id: "surname", weight: 1, pattern: /\bsurname\b/ },
        { id: "given_names", weight: 1, pattern: /\bgiven\s*names?\b/ },
        { id: "place_of_birth", weight: 1, pattern: /\bplace\s*of\s*birth\b/ },
        { id: "date_of_expiry", weight: 1, pattern: /\b(date\s*of\s*expiry|expiry\s*date)\b/ },
    ],
    [POLICE_FAMILY]: [
        { id: "police", weight: 1, pattern: /\bpolice\b/ },
        { id: "police_clearance", weight: 2, pattern: /\bpolice\s*clearance\b/ },
        { id: "clearance_certificate", weight: 2, pattern: /\bclearance\s*certificate\b/ },
        { id: "criminal_record", weight: 2, pattern: /\bcriminal\s*records?\b/ },
        { id: "police_office", weight: 1, pattern: /\bpolice\s*(station|headquarters|department)\b/ },
        { id: "inspector_general", weight: 1, pattern: /\binspector\s*general\b/ },
        { id: "conviction", weight: 1, pattern: /\bconvict(ed|ions?)\b/ },
        { id: "character_certificate", weight: 1, pattern: /\bcharacter\s*certificate\b/ },
    ],
    [DOCUMENT_TYPES.MEDICAL]: [
        { id: "medical", weight: 1, pattern: /\bmedical\b/ },
        { id: "medical_report", weight: 2, pattern: /\bmedical\s*(examination|report|certificate|check\s*-?\s*up)\b/ },
        { id: "gcc_medical", weight: 2, pattern: /\b(gamca|wafid)\b/ },
        { id: "fitness", weight: 1, pattern: /\b(fit|unfit)\s*(for|to)\b/ },
        { id: "health", weight: 1, pattern: /\bhealth\b/ },
        { id: "medical_facility", weight: 1, pattern: /\b(hospital|clinic|laborator(y|ies)|diagnostic|medical\s*cent(er|re))\b/ },
        { id: "doctor", weight: 1, pattern: /\b(doctor|physician|medical\s*officer)\b|\bdr\.\s/ },
        { id: "lab_tests", weight: 1, pattern: /\b(blood\s*group|ha?emoglobin|hiv|hepatitis|x-?ray|vdrl|malaria|tuberculosis|urine)\b/ },
    ],
};

// MRZ lines are the strongest passport signal. Each line has its own strict
// format, so both lines together are enough even when OCR lost the keywords.
const MRZ_LINE_1_INDICATOR = { id: "mrz_line_1", weight: 2 };
const MRZ_LINE_2_INDICATOR = { id: "mrz_line_2", weight: 2 };

// A type must reach MIN_SCORE from at least MIN_INDICATORS different
// indicators, and beat the runner-up by MIN_LEAD. Otherwise we don't guess.
const MIN_SCORE = 3;
const MIN_INDICATORS = 2;
const MIN_LEAD = 2;

// Shorter than this there's nothing meaningful to classify.
const MIN_TEXT_LENGTH = 20;

export const CONTENT_CLASSIFICATION_REASONS = Object.freeze({
    NO_TEXT: "NO_TEXT",
    INSUFFICIENT_EVIDENCE: "INSUFFICIENT_EVIDENCE",
    AMBIGUOUS_CONTENT: "AMBIGUOUS_CONTENT",
    // Clearly a police document, but not clearly a slip or a final report.
    POLICE_TYPE_UNCLEAR: "POLICE_TYPE_UNCLEAR",
});

// Slip vs final report. Scored like the main classifier: each indicator
// once, and the winner needs POLICE_SUBTYPE_MIN_SCORE from at least two
// indicators and a lead of POLICE_SUBTYPE_MIN_LEAD. One weak word never
// decides; mixed or thin evidence is left unresolved (-> review).
const POLICE_SUBTYPE_INDICATORS = {
    [DOCUMENT_TYPES.POLICE_SLIP]: [
        { id: "slip_receipt", weight: 2, pattern: /\b(receipt|acknowledge?ments?)\b/ },
        { id: "slip_submitted", weight: 2, pattern: /\b(submitted|submission|lodged)\b/ },
        { id: "slip_application_number", weight: 2, pattern: /\bapplication\s*(no|number|#|ref(erence)?)\b/ },
        { id: "slip_clearance_application", weight: 2, pattern: /\b(clearance\s*application|application\s*for\s*(a\s*)?(police\s*)?clearance)\b/ },
        { id: "slip_application", weight: 1, pattern: /\b(application|applied)\b/ },
        { id: "slip_received", weight: 1, pattern: /\b(received|registered)\b/ },
        { id: "slip_reference_number", weight: 1, pattern: /\b(reference|ref)\.?\s*(no|number|#)\b/ },
    ],
    [DOCUMENT_TYPES.POLICE_REPORT]: [
        { id: "report_clearance_certificate", weight: 2, pattern: /\bclearance\s*certificate\b/ },
        { id: "report_no_criminal_record", weight: 2, pattern: /\bno\s*criminal\s*records?\b/ },
        { id: "report_certify", weight: 2, pattern: /\b(this\s*is\s*to\s*certify|hereby\s*certif(y|ied)|certified\s*that)\b/ },
        { id: "report_criminal_record", weight: 1, pattern: /\bcriminal\s*records?\b/ },
        { id: "report_inspector_general", weight: 1, pattern: /\binspector\s*general\b/ },
        { id: "report_police_headquarters", weight: 1, pattern: /\bpolice\s*headquarters\b/ },
        { id: "report_date_of_issue", weight: 1, pattern: /\b(date\s*of\s*issue|issued\s*(on|by))\b/ },
    ],
};
const POLICE_SUBTYPE_MIN_SCORE = 3;
const POLICE_SUBTYPE_MIN_INDICATORS = 2;
const POLICE_SUBTYPE_MIN_LEAD = 2;

// Returns { documentType (POLICE_SLIP / POLICE_REPORT, or null when unclear),
// indicators, scores }.
export function classifyPoliceSubtype(text) {
    const normalizedText = normalizeForMatching(text);
    const results = Object.entries(POLICE_SUBTYPE_INDICATORS)
        .map(([documentType, indicators]) => {
            const matched = indicators.filter(({ pattern }) => pattern.test(normalizedText));
            return {
                documentType,
                score: matched.reduce((total, { weight }) => total + weight, 0),
                indicators: matched.map(({ id }) => id),
            };
        })
        .sort((a, b) => b.score - a.score);

    const [best, runnerUp] = results;
    const scores = Object.fromEntries(results.map((r) => [r.documentType, r.score]));
    const clear = best.score >= POLICE_SUBTYPE_MIN_SCORE
        && best.indicators.length >= POLICE_SUBTYPE_MIN_INDICATORS
        && best.score - runnerUp.score >= POLICE_SUBTYPE_MIN_LEAD;

    return {
        documentType: clear ? best.documentType : null,
        indicators: clear ? best.indicators : [],
        scores,
    };
}

function scoreDocumentType(documentType, normalizedText, rawText) {
    const matched = CONTENT_INDICATORS[documentType].filter(({ pattern }) =>
        pattern.test(normalizedText)
    );

    if (documentType === DOCUMENT_TYPES.PASSPORT) {
        const mrz = findPassportMrz(rawText);
        if (mrz?.line1) matched.push(MRZ_LINE_1_INDICATOR);
        if (mrz?.line2) matched.push(MRZ_LINE_2_INDICATOR);
    }

    return {
        documentType,
        score: matched.reduce((total, { weight }) => total + weight, 0),
        indicators: matched.map(({ id }) => id),
    };
}

// Classify from extracted PDF/OCR text. Returns indicator IDs rather than
// matched text, so the result is safe to log.
export function classifyDocumentContent(text) {
    const rawText = text || "";
    const normalizedText = normalizeForMatching(rawText);

    const unknown = (reason, results = []) => ({
        documentType: DOCUMENT_TYPES.UNKNOWN,
        source: "CONTENT",
        score: 0,
        indicators: [],
        scores: Object.fromEntries(results.map((r) => [r.documentType, r.score])),
        reason,
    });

    if (normalizedText.length < MIN_TEXT_LENGTH) {
        return unknown(CONTENT_CLASSIFICATION_REASONS.NO_TEXT);
    }

    const results = Object.keys(CONTENT_INDICATORS)
        .map((documentType) => scoreDocumentType(documentType, normalizedText, rawText))
        .sort((a, b) => b.score - a.score);

    const [best, runnerUp] = results;

    if (best.score < MIN_SCORE || best.indicators.length < MIN_INDICATORS) {
        return unknown(CONTENT_CLASSIFICATION_REASONS.INSUFFICIENT_EVIDENCE, results);
    }

    if (best.score - runnerUp.score < MIN_LEAD) {
        return unknown(CONTENT_CLASSIFICATION_REASONS.AMBIGUOUS_CONTENT, results);
    }

    // A police document must also be clearly a slip or a final report: they
    // follow different rules, so an unclear one is left for a person.
    if (best.documentType === POLICE_FAMILY) {
        const subtype = classifyPoliceSubtype(rawText);
        if (!subtype.documentType) {
            return { ...unknown(CONTENT_CLASSIFICATION_REASONS.POLICE_TYPE_UNCLEAR, results), policeScores: subtype.scores };
        }
        return {
            documentType: subtype.documentType,
            source: "CONTENT",
            // The family score, so classification confidence works as before.
            score: best.score,
            indicators: [...best.indicators, ...subtype.indicators],
            scores: Object.fromEntries(results.map((r) => [r.documentType, r.score])),
            policeScores: subtype.scores,
            reason: null,
        };
    }

    return {
        documentType: best.documentType,
        source: "CONTENT",
        score: best.score,
        indicators: best.indicators,
        scores: Object.fromEntries(results.map((r) => [r.documentType, r.score])),
        reason: null,
    };
}

// Final document type

// Content decides. The filename is used only when there was no readable
// text at all, and a filename that disagrees with the content is flagged
// as a possible wrong document (proposal §17).
export function resolveDocumentType({ filenameClassification, contentClassification }) {
    const filenameType = filenameClassification?.documentType ?? DOCUMENT_TYPES.UNKNOWN;
    const contentType = contentClassification?.documentType ?? DOCUMENT_TYPES.UNKNOWN;

    if (contentType !== DOCUMENT_TYPES.UNKNOWN) {
        // A police-named file is not a "wrong document" for either police
        // type: people name slips and reports alike ("police.jpg").
        const family = (type) => (isPoliceDocumentType(type) ? POLICE_FAMILY : type);
        return {
            documentType: contentType,
            source: "CONTENT",
            filenameMismatch:
                filenameType !== DOCUMENT_TYPES.UNKNOWN && family(filenameType) !== family(contentType),
        };
    }

    const noReadableText =
        contentClassification?.reason === CONTENT_CLASSIFICATION_REASONS.NO_TEXT;

    if (noReadableText && filenameType !== DOCUMENT_TYPES.UNKNOWN) {
        return {
            documentType: filenameType,
            source: "FILENAME",
            filenameMismatch: false,
        };
    }

    return {
        documentType: DOCUMENT_TYPES.UNKNOWN,
        source: "CONTENT",
        filenameMismatch: false,
    };
}
