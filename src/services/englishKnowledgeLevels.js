// English Knowledge levels of the candidate record (candidate_additional_details.english_knowledge):
// NO KNOWLEDGE, or ENGLISH 6 (Basic, the lowest) to ENGLISH 10 (Fluent, the highest).
//
// The Candidate Form still asks with the older six answers (candidateFormDataService.js ENGLISH_LEVELS,
// kept as they are in candidate_form_response) and records saved before this scale still hold them, so
// every path that writes or reads the record's level goes through this one translation. NO KNOWLEDGE is
// the same answer on both scales and is kept. Pure apart from the warning below; never throws.

export const NO_ENGLISH_KNOWLEDGE = "NO KNOWLEDGE";
export const ENGLISH_KNOWLEDGE_LEVELS = Object.freeze(["ENGLISH 6", "ENGLISH 7", "ENGLISH 8", "ENGLISH 9", "ENGLISH 10"]);
// Every value the record may hold from now on (the Admin choices).
export const ENGLISH_KNOWLEDGE_VALUES = Object.freeze([NO_ENGLISH_KNOWLEDGE, ...ENGLISH_KNOWLEDGE_LEVELS]);

export const LEGACY_ENGLISH_KNOWLEDGE = Object.freeze({
    BASIC: "ENGLISH 6",
    FAIR: "ENGLISH 7",
    GOOD: "ENGLISH 8",
    "VERY GOOD": "ENGLISH 9",
    FLUENT: "ENGLISH 10",
});

const NO_VALUE = new Set(["", "NOT RECORDED"]);

const normalized = (raw) => String(raw).replace(/\s+/g, " ").trim().toUpperCase();

// { value, recognised }: value is one of ENGLISH_KNOWLEDGE_VALUES or null; recognised is false only
// for text that is neither a current value, an older level, nor "no value" (empty, Not recorded).
export function resolveEnglishKnowledge(raw) {
    if (raw === null || raw === undefined) return { value: null, recognised: true };
    if (typeof raw !== "string") return { value: null, recognised: false };
    const text = normalized(raw);
    if (NO_VALUE.has(text)) return { value: null, recognised: true };
    if (ENGLISH_KNOWLEDGE_VALUES.includes(text)) return { value: text, recognised: true };
    if (Object.hasOwn(LEGACY_ENGLISH_KNOWLEDGE, text)) return { value: LEGACY_ENGLISH_KNOWLEDGE[text], recognised: true };
    return { value: null, recognised: false };
}

// The record's value for any stored or submitted answer, or null. An unrecognised value is never
// guessed: null, and a warning that carries no part of the value.
export function mapEnglishKnowledge(raw) {
    const { value, recognised } = resolveEnglishKnowledge(raw);
    if (!recognised) console.warn("English knowledge value not recognised; treated as empty", { field: "englishKnowledge", valueType: typeof raw });
    return value;
}
