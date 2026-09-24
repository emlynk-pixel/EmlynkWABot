// Lowercase and collapse whitespace so the same patterns work on clean PDF
// text and on noisy OCR output (random line breaks, double spaces).
export function normalizeForMatching(text) {
    return (text || "").toLowerCase().replace(/\s+/g, " ").trim();
}
