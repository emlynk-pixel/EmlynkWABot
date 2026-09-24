import { findDocumentDates } from "../utils/dateParsing.js";

// Proposal §20: read the submitted/application date from a police report
// slip. For the actual police certificate, the issue date is the closest
// equivalent. The +21-day reminder belongs to Phase 9 and isn't done here.

export const POLICE_DATE_STATUS = Object.freeze({
    RESOLVED: "RESOLVED",
    AMBIGUOUS: "AMBIGUOUS",
    INVALID: "INVALID",
    NOT_FOUND: "NOT_FOUND",
});

export const POLICE_DATE_KIND = Object.freeze({
    SUBMITTED: "SUBMITTED",
    ISSUED: "ISSUED",
    UNLABELLED: "UNLABELLED",
});

// Checked in order: the first matching label decides what a date means.
// Birth and expiry dates are never a report date, so they're excluded.
const DATE_LABELS = [
    { kind: null, pattern: /\b(birth|dob|born|expiry|expires?|valid\s*(until|till))\b/i },
    { kind: POLICE_DATE_KIND.SUBMITTED, pattern: /\b(submi(tted|ssion)|appl(ication|ied)|lodged|received|registered)\b/i },
    { kind: POLICE_DATE_KIND.ISSUED, pattern: /\b(issue[d]?|date\s*of\s*issue|certified\s*on)\b/i },
];

// Confidence for the chosen date (0-100, same scale as everything else).
// An unlabelled date might be any date on the page, so it needs review.
const KIND_CONFIDENCE = {
    [POLICE_DATE_KIND.SUBMITTED]: 95,
    [POLICE_DATE_KIND.ISSUED]: 90,
    [POLICE_DATE_KIND.UNLABELLED]: 60,
};

const EARLIEST_VALID_YEAR = 2000;

function labelFor(context) {
    const label = DATE_LABELS.find(({ pattern }) => pattern.test(context));
    if (!label) return { kind: POLICE_DATE_KIND.UNLABELLED, excluded: false };
    return { kind: label.kind, excluded: label.kind === null };
}

// Every date with the label text that sits before it on the same line.
// If the line has no label text, the label is probably on the line above.
function findLabelledDates(text) {
    const lines = (text || "").split(/\r?\n/);
    const results = [];

    lines.forEach((line, lineIndex) => {
        let previousEnd = 0;

        for (const found of findDocumentDates(line)) {
            let context = line.slice(previousEnd, found.index);
            if (!/[a-z]/i.test(context) && lineIndex > 0) {
                context = lines[lineIndex - 1];
            }
            previousEnd = found.end;

            results.push({ date: found.date, ...labelFor(context) });
        }
    });

    return results;
}

function isPlausibleReportDate(isoDate, today) {
    return Number(isoDate.slice(0, 4)) >= EARLIEST_VALID_YEAR && isoDate <= today;
}

function unresolved(status, candidates) {
    return { status, date: null, kind: null, confidence: 0, candidates };
}

// `now` is only overridable for tests.
export function extractPoliceReportDate(text, { now = new Date() } = {}) {
    const today = now.toISOString().slice(0, 10);
    const found = findLabelledDates(text).filter((item) => !item.excluded);

    const candidates = found.map(({ date, kind }) => ({
        date,
        kind,
        valid: isPlausibleReportDate(date, today),
    }));

    if (candidates.length === 0) {
        return unresolved(POLICE_DATE_STATUS.NOT_FOUND, candidates);
    }

    const valid = candidates.filter((candidate) => candidate.valid);
    if (valid.length === 0) {
        return unresolved(POLICE_DATE_STATUS.INVALID, candidates);
    }

    // Prefer the most specific label. Within that label all dates must
    // agree; two different submitted dates means we can't tell which is right.
    for (const kind of [POLICE_DATE_KIND.SUBMITTED, POLICE_DATE_KIND.ISSUED, POLICE_DATE_KIND.UNLABELLED]) {
        const dates = [...new Set(valid.filter((c) => c.kind === kind).map((c) => c.date))];

        if (dates.length === 1) {
            return {
                status: POLICE_DATE_STATUS.RESOLVED,
                date: dates[0],
                kind,
                confidence: KIND_CONFIDENCE[kind],
                candidates,
            };
        }

        if (dates.length > 1) {
            return unresolved(POLICE_DATE_STATUS.AMBIGUOUS, candidates);
        }
    }

    return unresolved(POLICE_DATE_STATUS.NOT_FOUND, candidates);
}
