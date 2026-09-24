const MONTHS = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
};

const pad = (value) => String(value).padStart(2, "0");

// Returns "YYYY-MM-DD", or null if the date doesn't exist (e.g. 31/02).
export function toIsoDate(year, month, day) {
    if (![year, month, day].every(Number.isInteger)) return null;
    if (year < 1900 || year > 2100) return null;

    const date = new Date(Date.UTC(year, month - 1, day));
    const isRealDate =
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day;

    return isRealDate ? `${year}-${pad(month)}-${pad(day)}` : null;
}

// Numeric dates are read day-first (DD/MM/YYYY), the convention on
// Sri Lankan documents. 03/04/2026 is 3 April, never 4 March.
const DATE_PATTERNS = [
    {
        format: "YYYY-MM-DD",
        regex: /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g,
        toParts: (m) => [m[1], m[2], m[3]],
    },
    {
        format: "DD-MM-YYYY",
        regex: /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/g,
        toParts: (m) => [m[3], m[2], m[1]],
    },
    {
        // "12 MAR 1990", "12-Mar-1990", and bilingual "12 MAR/MARS 1990".
        format: "DD MON YYYY",
        regex: /\b(\d{1,2})[\s\-/.]*([a-z]{3,9})(?:\s*\/\s*[a-z]{3,9})?[\s\-/.,]*(\d{4})\b/gi,
        toParts: (m) => [m[3], MONTHS[m[2].toLowerCase()], m[1]],
    },
    {
        // "March 12, 1990"
        format: "MON DD YYYY",
        regex: /\b([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/gi,
        toParts: (m) => [m[3], MONTHS[m[1].toLowerCase()], m[2]],
    },
];

// Every valid date in the text, in reading order. Invalid calendar dates
// are skipped rather than guessed.
export function findDocumentDates(text) {
    const found = [];

    for (const { format, regex, toParts } of DATE_PATTERNS) {
        for (const match of (text || "").matchAll(regex)) {
            const [year, month, day] = toParts(match).map(Number);
            const date = toIsoDate(year, month, day);

            if (date) {
                found.push({
                    date,
                    format,
                    index: match.index,
                    end: match.index + match[0].length,
                });
            }
        }
    }

    // Keep the earliest match when two patterns overlap the same text.
    found.sort((a, b) => a.index - b.index);
    return found.filter((item, i) => i === 0 || item.index >= found[i - 1].end);
}

export function parseDocumentDate(text) {
    return findDocumentDates(text)[0]?.date ?? null;
}
