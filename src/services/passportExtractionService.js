import { findPassportMrz, parsePassportMrz } from "../utils/mrz.js";
import { parseDocumentDate } from "../utils/dateParsing.js";
import { normalizePassportId } from "../utils/passportId.js";

// Only fields that map to the users table or the proposal (§12).
// Nationality and sex are on the passport but have no column, so they're skipped.
export const PASSPORT_FIELDS = Object.freeze([
    "passportId",
    "surname",
    "givenNames",
    "dateOfBirth",
    "placeOfBirth",
    "passportExpiryDate",
]);

export const PASSPORT_EXTRACTION_STATUS = Object.freeze({
    COMPLETE: "COMPLETE",
    PARTIAL: "PARTIAL",
    PASSPORT_ID_MISSING: "PASSPORT_ID_MISSING",
    NO_TEXT: "NO_TEXT",
});

// Whether the MRZ and the printed (visual zone) value agree.
export const CROSS_CHECK = Object.freeze({
    MATCH: "MATCH",
    MISMATCH: "MISMATCH",
    NOT_AVAILABLE: "NOT_AVAILABLE",
});

// Printed labels on the passport data page. Labels with field: null aren't
// extracted; they only mark where the previous value ends.
const VIZ_LABELS = [
    { field: "passportId", pattern: /\bpassport\s*(?:no\b|number\b|#)\.?/gi },
    { field: "surname", pattern: /\bsurname\b/gi },
    { field: "givenNames", pattern: /\bgiven\s*names?\b/gi },
    { field: "dateOfBirth", pattern: /\b(?:date\s*of\s*birth|birth\s*date)\b/gi },
    { field: "placeOfBirth", pattern: /\bplace\s*of\s*birth\b/gi },
    { field: "passportExpiryDate", pattern: /\b(?:date\s*of\s*expiry|expiry\s*date|expiration\s*date)\b/gi },
    {
        field: null,
        pattern: /\b(?:nationality|sex|type|country\s*code|date\s*of\s*issue|authority|personal\s*no|national\s*id(?:\s*no)?)\b/gi,
    },
];

function findLabels(line) {
    const labels = [];

    for (const { field, pattern } of VIZ_LABELS) {
        for (const match of line.matchAll(pattern)) {
            labels.push({ field, start: match.index, end: match.index + match[0].length });
        }
    }

    return labels.sort((a, b) => a.start - b.start);
}

function cleanLabelValue(value) {
    return value.replace(/^[\s:.\-/]+/, "").replace(/\s+/g, " ").trim();
}

// Raw printed values by field. Value is the text after the label up to the
// next label on the same line; if that's empty, OCR probably put the value
// on the next line, so we try there.
function readLabelledValues(text) {
    const lines = text.split(/\r?\n/);
    const values = {};

    lines.forEach((line, lineIndex) => {
        const labels = findLabels(line);

        labels.forEach((label, i) => {
            if (!label.field || values[label.field]) return;

            const nextStart = labels[i + 1]?.start ?? line.length;
            let value = cleanLabelValue(line.slice(label.end, nextStart));

            const isLastLabelOnLine = i === labels.length - 1;
            if (!value && isLastLabelOnLine) {
                const nextLine = lines.slice(lineIndex + 1).find((l) => l.trim());
                if (nextLine) {
                    const nextLabels = findLabels(nextLine);
                    value = cleanLabelValue(nextLine.slice(0, nextLabels[0]?.start ?? nextLine.length));
                }
            }

            if (value) values[label.field] = value;
        });
    });

    return values;
}

function cleanName(value) {
    const name = (value || "")
        .toUpperCase()
        .replace(/[^A-Z\s'-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    return name.length >= 2 ? name : null;
}

// Printed numbers can have trailing punctuation ("N1234567,") or junk after
// them, so fall back to the first token without its punctuation.
function cleanPrintedPassportId(value) {
    if (!value) return null;

    const firstToken = value.split(/\s+/)[0].replace(/[^A-Za-z0-9]/g, "");
    return normalizePassportId(value) ?? normalizePassportId(firstToken);
}

function readVisualZone(text) {
    const raw = readLabelledValues(text);

    return {
        passportId: cleanPrintedPassportId(raw.passportId),
        surname: cleanName(raw.surname),
        givenNames: cleanName(raw.givenNames),
        dateOfBirth: raw.dateOfBirth ? parseDocumentDate(raw.dateOfBirth) : null,
        placeOfBirth: cleanName(raw.placeOfBirth),
        passportExpiryDate: raw.passportExpiryDate ? parseDocumentDate(raw.passportExpiryDate) : null,
    };
}

const lettersOnly = (value) => (value || "").replace(/[^A-Z]/g, "");

// Pick one value per field from the MRZ and the printed zone.
// - A clean MRZ read (check digit valid, or no check digit exists) wins.
// - If the MRZ check digit failed, the printed value is preferred.
// - Disagreement between the two is reported, never hidden.
function mergeField({ mrzValue, mrzCheckValid = null, vizValue, compare = (a, b) => a === b }) {
    const crossCheck = (a, b) =>
        a && b ? (compare(a, b) ? CROSS_CHECK.MATCH : CROSS_CHECK.MISMATCH) : CROSS_CHECK.NOT_AVAILABLE;

    if (mrzValue && mrzCheckValid !== false) {
        return { value: mrzValue, source: "MRZ", checkDigitValid: mrzCheckValid, crossCheck: crossCheck(mrzValue, vizValue) };
    }

    if (mrzValue && vizValue) {
        return { value: vizValue, source: "VIZ", checkDigitValid: false, crossCheck: crossCheck(mrzValue, vizValue) };
    }

    if (mrzValue) {
        return { value: mrzValue, source: "MRZ", checkDigitValid: false, crossCheck: CROSS_CHECK.NOT_AVAILABLE };
    }

    if (vizValue) {
        return { value: vizValue, source: "VIZ", checkDigitValid: null, crossCheck: CROSS_CHECK.NOT_AVAILABLE };
    }

    return { value: null, source: null, checkDigitValid: null, crossCheck: CROSS_CHECK.NOT_AVAILABLE };
}

function emptyResult(status) {
    const empty = { value: null, source: null, checkDigitValid: null, crossCheck: CROSS_CHECK.NOT_AVAILABLE };

    return {
        status,
        fields: Object.fromEntries(PASSPORT_FIELDS.map((field) => [field, { ...empty }])),
        missingFields: [...PASSPORT_FIELDS],
        mrz: { linesFound: 0, compositeCheckValid: null },
    };
}

// Extract passport fields from PDF/OCR text. Unreadable fields are null;
// nothing is guessed. The result holds personal data, so log only
// status, missingFields and mrz, never the field values.
export function extractPassportFields(text) {
    if (!text || !text.trim()) {
        return emptyResult(PASSPORT_EXTRACTION_STATUS.NO_TEXT);
    }

    const mrzLines = findPassportMrz(text);
    const mrz = parsePassportMrz(mrzLines ?? {});
    const viz = readVisualZone(text);

    const sameName = (a, b) => lettersOnly(a) === lettersOnly(b);

    const fields = {
        passportId: mergeField({
            mrzValue: normalizePassportId(mrz.passportNumber),
            mrzCheckValid: mrz.passportNumberCheckValid,
            vizValue: viz.passportId,
        }),
        surname: mergeField({ mrzValue: mrz.surname, vizValue: viz.surname, compare: sameName }),
        givenNames: mergeField({ mrzValue: mrz.givenNames, vizValue: viz.givenNames, compare: sameName }),
        dateOfBirth: mergeField({
            mrzValue: mrz.dateOfBirth,
            mrzCheckValid: mrz.dateOfBirthCheckValid,
            vizValue: viz.dateOfBirth,
        }),
        placeOfBirth: mergeField({ vizValue: viz.placeOfBirth }),
        passportExpiryDate: mergeField({
            mrzValue: mrz.expiryDate,
            mrzCheckValid: mrz.expiryDateCheckValid,
            vizValue: viz.passportExpiryDate,
        }),
    };

    const missingFields = PASSPORT_FIELDS.filter((field) => !fields[field].value);

    let status = PASSPORT_EXTRACTION_STATUS.COMPLETE;
    if (!fields.passportId.value) status = PASSPORT_EXTRACTION_STATUS.PASSPORT_ID_MISSING;
    else if (missingFields.length > 0) status = PASSPORT_EXTRACTION_STATUS.PARTIAL;

    return {
        status,
        fields,
        missingFields,
        mrz: {
            linesFound: (mrzLines?.line1 ? 1 : 0) + (mrzLines?.line2 ? 1 : 0),
            compositeCheckValid: mrz.compositeCheckValid,
        },
    };
}
