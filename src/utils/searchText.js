// One normalisation for every typed search (quick search, the Full name filter, suggestions):
// trimmed, internal runs of whitespace collapsed to one space, lowercase. Matching stays
// case-insensitive in the database too; stored values are never changed.
//   "  NIMAL   PERERA  " -> "nimal perera"
export function normalizeSearchText(value) {
    return typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLowerCase() : "";
}

// The words of a search, each matched on its own (every word must match somewhere). At most
// `max` words, so one request never builds an unbounded condition.
export function searchTokens(value, max = 5) {
    const text = normalizeSearchText(value);
    return text ? text.split(" ").slice(0, max) : [];
}
