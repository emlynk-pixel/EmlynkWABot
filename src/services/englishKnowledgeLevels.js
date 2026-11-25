// English Knowledge: the database keeps the six stored codes (candidateFormDataService.js
// ENGLISH_LEVELS); admins see BASIC..FLUENT as ENGLISH 6..ENGLISH 10. Display only, no migration.

// Stored code -> label shown to admins.
export const ENGLISH_KNOWLEDGE_LABELS = Object.freeze({
    "NO KNOWLEDGE": "NO KNOWLEDGE",
    BASIC: "ENGLISH 6",
    FAIR: "ENGLISH 7",
    GOOD: "ENGLISH 8",
    "VERY GOOD": "ENGLISH 9",
    FLUENT: "ENGLISH 10",
});

// Label -> stored code.
const CODE_OF_LABEL = Object.freeze(Object.fromEntries(Object.entries(ENGLISH_KNOWLEDGE_LABELS).map(([code, label]) => [label, code])));

const normalized = (raw) => (typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().toUpperCase() : "");

// The label of a stored code, or null.
export function labelOf(code) {
    const key = normalized(code);
    return Object.hasOwn(ENGLISH_KNOWLEDGE_LABELS, key) ? ENGLISH_KNOWLEDGE_LABELS[key] : null;
}

// A stored code or an ENGLISH n label (any case or spacing) -> the stored code; null if blank or unknown.
export function codeOf(raw) {
    const key = normalized(raw);
    if (Object.hasOwn(ENGLISH_KNOWLEDGE_LABELS, key)) return key;
    if (Object.hasOwn(CODE_OF_LABEL, key)) return CODE_OF_LABEL[key];
    return null;
}
