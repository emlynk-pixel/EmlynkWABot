import { classifyDocumentContent } from "../services/documentClassificationService.js";
import { findPassportMrz } from "./mrz.js";

// Words that commonly appear on each document type. Diagnostics report
// which of these OCR saw, so the output only ever contains words from this
// list, never text read from the document (names, numbers, addresses).
export const DIAGNOSTIC_VOCABULARY = Object.freeze({
    POLICE_REPORT: [
        "police", "clearance", "certificate", "criminal", "record", "records", "report",
        "convicted", "conviction", "offence", "headquarters", "inspector", "general",
        "division", "department", "station", "character", "certify", "issued", "lanka",
    ],
    PASSPORT: [
        "passport", "surname", "given", "names", "nationality", "birth", "expiry",
        "issue", "authority", "republic",
    ],
    MEDICAL: [
        "medical", "examination", "health", "hospital", "clinic", "laboratory",
        "doctor", "officer", "blood", "fit", "unfit",
    ],
});

// Edit distance, for spotting OCR near-misses like "polic3" or "clearence".
function levenshtein(a, b) {
    const previous = Array.from({ length: b.length + 1 }, (_, i) => i);

    for (let i = 1; i <= a.length; i++) {
        let diagonal = previous[0];
        previous[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const above = previous[j];
            previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
            diagonal = above;
        }
    }

    return previous[b.length];
}

// Short words must match exactly; longer words may be off by one or two characters.
function allowedDistance(word) {
    if (word.length >= 8) return 2;
    if (word.length >= 5) return 1;
    return 0;
}

function vocabularySeen(tokens) {
    const tokenSet = new Set(tokens);

    return Object.fromEntries(
        Object.entries(DIAGNOSTIC_VOCABULARY).map(([documentType, words]) => {
            const exact = words.filter((word) => tokenSet.has(word));
            const near = words.filter((word) => {
                const maxDistance = allowedDistance(word);
                return !tokenSet.has(word) && maxDistance > 0 &&
                    tokens.some((token) => Math.abs(token.length - word.length) <= maxDistance &&
                        levenshtein(token, word) <= maxDistance);
            });
            return [documentType, { exact, near }];
        })
    );
}

// Sanitized description of OCR/PDF text: counts, ratios, classification
// indicators and vocabulary hits. Safe to print or share.
export function describeTextForDiagnostics(text) {
    const raw = text || "";
    const nonSpace = raw.replace(/\s/g, "");
    const tokens = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const wordTokens = tokens.filter((token) => /^[a-z]+$/.test(token));
    const classification = classifyDocumentContent(raw);
    const mrz = findPassportMrz(raw);

    return {
        textLength: raw.length,
        lineCount: raw.split(/\r?\n/).filter((line) => line.trim()).length,
        wordCount: wordTokens.length,
        // Low values usually mean OCR produced noise (non-Latin script, bad photo).
        letterRatio: nonSpace.length ? Number((nonSpace.replace(/[^A-Za-z]/g, "").length / nonSpace.length).toFixed(2)) : 0,
        averageWordLength: wordTokens.length
            ? Number((wordTokens.reduce((sum, word) => sum + word.length, 0) / wordTokens.length).toFixed(1))
            : 0,
        classification: {
            documentType: classification.documentType,
            reason: classification.reason,
            scores: classification.scores,
            indicators: classification.indicators,
        },
        mrzLinesFound: (mrz?.line1 ? 1 : 0) + (mrz?.line2 ? 1 : 0),
        vocabulary: vocabularySeen(wordTokens),
    };
}
