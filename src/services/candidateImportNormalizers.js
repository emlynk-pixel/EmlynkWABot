// Bulk candidate import: normalizers for legacy sheet values. Pure: no database,
// no clock unless passed, no logging. Each takes the raw cell text and returns
//   { value }                    a usable value (possibly with `warning`: a reason code)
//   { value: null }              nothing to store (blank or N/A)
//   { value: null, warning }     the value was unusable; the field is dropped, the row goes on
//   { value: null, error }       (identity fields only) the row cannot be imported
// Codes are safe to show and store; no raw value is ever part of a result's code.
//
// These rules are for LEGACY IMPORT ONLY. Normal Admin registration keeps its own,
// stricter rules (candidateService.js parseCandidateBody, utils/passportId.js).

import { CANDIDATE_PASSPORT_PATTERN } from "../utils/passportId.js";
import { parseHeight, parseWeight } from "../utils/bodyMeasurements.js";
import { canonicalPhoneNumber } from "../utils/phoneNumber.js";

export const NIC_PATTERN = /^(\d{9}[VX]|\d{12})$/;
// A legacy passport accepted with a warning: P or N + 8 digits (registration takes 7).
export const LEGACY_PASSPORT_PATTERN = /^[PN][0-9]{8}$/;
export const MARITAL_STATUSES = Object.freeze(["SINGLE", "MARRIED", "DIVORCED", "WIDOWED", "SEPARATED"]);
export const BLOOD_GROUPS = Object.freeze(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]);
export const SHIRT_SIZES = Object.freeze(["XS", "S", "M", "L", "XL", "XXL"]);
export const ENGLISH_LEVELS = Object.freeze(["NO KNOWLEDGE", "BASIC", "FAIR", "GOOD", "VERY GOOD", "FLUENT"]);

// Collapse spaces, trim; null/undefined -> "".
export const clean = (value) => (value === null || value === undefined ? "" : String(value).replace(/\s+/g, " ").trim());

// "N/A", "NA", "n/a", "na", "N.A", "-" (any case): the value does not apply / was not given.
export const isNotApplicable = (value) => /^(n\s*[/.]?\s*a\.?|-+)$/i.test(clean(value));

const blank = (value) => clean(value) === "" || isNotApplicable(value);
const none = () => ({ value: null });
const drop = (warning) => ({ value: null, warning });

// ---------------------------------------------------------------- identity

// Passport: upper case, spaces and hyphens removed. P/N + 7 digits: as registration.
// P/N + 8 digits: a legacy format, accepted with LEGACY_PASSPORT_FORMAT. Anything else: the
// row can't be identified.
export function normalizePassport(raw) {
    if (blank(raw)) return { value: null, error: "MISSING_PASSPORT" };
    const value = clean(raw).toUpperCase().replace(/[\s-]/g, "");
    if (CANDIDATE_PASSPORT_PATTERN.test(value)) return { value };
    if (LEGACY_PASSPORT_PATTERN.test(value)) return { value, warning: "LEGACY_PASSPORT_FORMAT" };
    return { value: null, error: "INVALID_PASSPORT" };
}

// Excel shows a long number as 1.99012E+11: the digits are gone and must never be guessed.
const SCIENTIFIC = /^\d+(\.\d+)?E\+?\d+$/i;

// NIC: upper case, spaces removed; old (9 digits + V/X) or new (12 digits).
export function normalizeNic(raw, { missing = "MISSING_NIC" } = {}) {
    if (blank(raw)) return missing ? drop(missing) : none();
    const value = clean(raw).toUpperCase().replace(/\s/g, "");
    if (SCIENTIFIC.test(value)) return drop("NIC_CORRUPTED");
    return NIC_PATTERN.test(value) ? { value } : drop("INVALID_NIC");
}

// ---------------------------------------------------------------- phone numbers

// One number -> the canonical candidate form (canonicalPhoneNumber, utils/phoneNumber.js: the
// same as registration), or null. Sri Lankan forms become +94...; a number already carrying a
// country code keeps it ("+" added); nothing else is changed.
//   07XXXXXXXX, 0XXXXXXXXX, 7XXXXXXXX (Excel dropped the 0), 947XXXXXXXX, +947XXXXXXXX  -> +94XXXXXXXXX
//   407XXXXXXXX, +407XXXXXXXX (Romania)                                                -> +407XXXXXXXX
//   +<8-15 digits> or 00<8-15 digits>                                                   -> +<digits>
//   <10-15 digits, not starting with 0> (a code we don't check)                         -> +<digits>, FOREIGN_PHONE_UNVERIFIED
// Stricter than registration for a legacy cell: a bare number of other lengths is refused.
function onePhone(part) {
    const text = clean(part);
    if (SCIENTIFIC.test(text.replace(/\s/g, ""))) return null;
    const canonical = canonicalPhoneNumber(text);
    if (!canonical) return null;
    if (/^(\+|00)/.test(text)) return { value: canonical };
    const digits = canonical.slice(1);
    if (/^94\d{9}$/.test(digits) || /^40\d{9}$/.test(digits)) return { value: canonical };
    if (/^[1-9]\d{9,14}$/.test(digits)) return { value: canonical, warning: "FOREIGN_PHONE_UNVERIFIED" };
    return null;
}

// A cell may hold several numbers ("0771234567 / 0711234567", or two full numbers separated by
// a space). Returns { numbers: [...E.164], warnings: [...codes] }.
export function normalizePhones(raw) {
    if (blank(raw)) return { numbers: [], warnings: [] };
    const parts = [];
    for (const piece of clean(raw).split(/[/,;&|]|\bor\b/i).map((p) => p.trim()).filter(Boolean)) {
        const tokens = piece.split(" ");
        // Two or more whole numbers separated by spaces; otherwise spaces are digit grouping.
        if (tokens.length > 1 && tokens.every((t) => t.replace(/\D/g, "").length >= 9)) parts.push(...tokens);
        else parts.push(piece);
    }
    const numbers = [];
    const warnings = new Set();
    for (const part of parts) {
        const result = onePhone(part);
        if (!result) { warnings.add("INVALID_PHONE"); continue; }
        if (result.warning) warnings.add(result.warning);
        if (!numbers.includes(result.value)) numbers.push(result.value);
    }
    if (numbers.length > 1) warnings.add("MULTIPLE_PHONE_NUMBERS");
    return { numbers, warnings: [...warnings] };
}

// The comparison key of a number stored in any format (utils/phoneNumber.js phoneKey).
export { phoneKey as phoneDigits } from "../utils/phoneNumber.js";

// ---------------------------------------------------------------- dates

const DAY_MS = 86_400_000;
// Excel's day 0 (its 1900 leap-year bug is absorbed: serial 60 and later count from 1899-12-30).
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

function utcDate(year, month, day) {
    if (!(year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

// A date in one of the KNOWN forms, never by JavaScript's locale parsing:
//   DD.MM.YYYY, DD/MM/YYYY, DD-MM-YYYY (1 or 2 digit day and month; the legacy sheet is day-first)
//   YYYY-MM-DD, optionally with a time (ISO; the time is ignored)
//   an Excel serial day number (as the cell's number)
// Two-digit years are refused (the century would be a guess).
export function parseLegacyDate(raw) {
    const text = clean(raw);
    let match = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(text);
    if (match) return utcDate(Number(match[3]), Number(match[2]), Number(match[1]));
    match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
    if (match) return utcDate(Number(match[1]), Number(match[2]), Number(match[3]));
    match = /^(\d{1,6})(?:\.\d+)?$/.exec(text);
    if (match) {
        const serial = Number(match[1]);
        if (serial < 1 || serial > 73_050) return null;
        const date = new Date(EXCEL_EPOCH + serial * DAY_MS);
        return utcDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    }
    return null;
}

const isoDay = (date) => date.toISOString().slice(0, 10);

// { value: Date } | none | drop("INVALID_DATE"). notFuture: a birth or issue date can't be after today.
export function normalizeDate(raw, { notFuture = false, today = new Date() } = {}) {
    if (blank(raw)) return none();
    const date = parseLegacyDate(raw);
    if (!date) return drop("INVALID_DATE");
    if (notFuture && isoDay(date) > isoDay(today)) return drop("INVALID_DATE");
    return { value: date };
}

// ---------------------------------------------------------------- codes

// The English part of a bilingual legacy answer: "<Sinhala> (Married)" -> "MARRIED". A plain
// answer is taken as it is.
function englishAnswer(raw) {
    const text = clean(raw);
    const inParentheses = /\(([^()]*)\)\s*$/.exec(text);
    return (inParentheses ? inParentheses[1] : text).trim().toUpperCase();
}

export function normalizeSex(raw) {
    if (blank(raw)) return none();
    const value = { M: "M", MALE: "M", F: "F", FEMALE: "F" }[englishAnswer(raw)];
    return value ? { value } : drop("INVALID_SEX");
}

export function normalizeMaritalStatus(raw) {
    if (blank(raw)) return none();
    const answer = englishAnswer(raw);
    return MARITAL_STATUSES.includes(answer) ? { value: answer } : drop("INVALID_CIVIL_STATUS");
}

export function normalizeYesNo(raw) {
    if (blank(raw)) return none();
    const answer = englishAnswer(raw);
    if (answer === "YES" || answer === "Y") return { value: true };
    if (answer === "NO" || answer === "N") return { value: false };
    return drop("INVALID_YES_NO");
}

// "B Positive (B+)", "B+", "b +", "AB NEGATIVE" -> "B+" / "AB-".
export function normalizeBloodGroup(raw) {
    if (blank(raw)) return none();
    const text = clean(raw).toUpperCase();
    const code = /\(\s*(AB|A|B|O)\s*([+-])\s*\)/.exec(text) ?? /^(AB|A|B|O)\s*([+-])$/.exec(text);
    if (code) return { value: `${code[1]}${code[2]}` };
    const words = /^(AB|A|B|O)\s+(POSITIVE|NEGATIVE)$/.exec(text);
    if (words) return { value: `${words[1]}${words[2] === "POSITIVE" ? "+" : "-"}` };
    return drop("INVALID_BLOOD_GROUP");
}

export function normalizeShirtSize(raw) {
    if (blank(raw)) return none();
    const text = clean(raw).toUpperCase().replace(/\s/g, "");
    const value = text === "2XL" ? "XXL" : text;
    return SHIRT_SIZES.includes(value) ? { value } : drop("INVALID_SIZE");
}

// Waist in inches, as the form stores it: "W32" -> "32". 20 to 60.
export function normalizeWaistSize(raw) {
    if (blank(raw)) return none();
    const match = /^W?\s*(\d{2})(?:\s*(?:IN|INCH|INCHES|"))?$/i.exec(clean(raw));
    const inches = match ? Number(match[1]) : NaN;
    return inches >= 20 && inches <= 60 ? { value: String(inches) } : drop("INVALID_SIZE");
}

// A UK shoe size, as the form stores it: "42.5 cm - size 8" -> "8", "UK 9" -> "9", "8.5" -> "8.5". 3 to 15.
export function normalizeShoeSize(raw) {
    if (blank(raw)) return none();
    const text = clean(raw);
    const match = /\bsize\s*(\d{1,2}(?:\.5)?)\s*$/i.exec(text) ?? /^(?:UK\s*)?(\d{1,2}(?:\.5)?)$/i.exec(text);
    const size = match ? Number(match[1]) : NaN;
    return size >= 3 && size <= 15 ? { value: match[1] } : drop("INVALID_SIZE");
}

export function normalizeHeight(raw) {
    if (blank(raw)) return none();
    const parsed = parseHeight(clean(raw));
    return parsed ? { value: parsed.text } : drop("INVALID_HEIGHT");
}

export function normalizeWeight(raw) {
    if (blank(raw)) return none();
    const kg = parseWeight(clean(raw));
    return kg === null ? drop("INVALID_WEIGHT") : { value: kg };
}

export function normalizeEnglishKnowledge(raw) {
    if (blank(raw)) return none();
    const value = englishAnswer(raw);
    return ENGLISH_LEVELS.includes(value) ? { value } : drop("INVALID_ENGLISH_LEVEL");
}

export function normalizeEmail(raw) {
    if (blank(raw)) return none();
    const value = clean(raw).toLowerCase();
    return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? { value } : drop("INVALID_EMAIL");
}

// A family member's passport number. A NIC-shaped value is not a passport: dropped.
export function normalizeFamilyPassport(raw) {
    if (blank(raw)) return none();
    const value = clean(raw).toUpperCase().replace(/[\s.-]/g, "");
    if (NIC_PATTERN.test(value)) return drop("FAMILY_PASSPORT_LOOKS_LIKE_NIC");
    return /^[A-Z0-9]{6,20}$/.test(value) && /\d/.test(value) ? { value } : drop("INVALID_FAMILY_PASSPORT");
}

// Free text up to `max` characters. Longer text is dropped, never cut.
export function normalizeText(raw, { max }) {
    if (blank(raw)) return none();
    const value = clean(raw);
    return value.length <= max ? { value } : drop("TEXT_TOO_LONG");
}

// ---------------------------------------------------------------- job roles

const MAX_JOB_TYPES = 10;

// "Plumber, Electrician" -> the matching ACTIVE job type names (case-insensitive, stored with
// the list's spelling) or a confirmed alias. Unknown roles are reported, never created.
// activeJobTypes: the active job type names. aliases: legacy name (upper case) -> job type name.
// Returns { value: [names] | null, warning? }.
export function normalizeJobRoles(raw, { activeJobTypes, aliases = {} }) {
    if (blank(raw)) return none();
    const active = new Map(activeJobTypes.map((name) => [name.toUpperCase(), name]));
    const resolved = [];
    let unknown = false;
    for (const role of clean(raw).split(",").map((r) => r.trim()).filter(Boolean)) {
        const key = role.toUpperCase();
        const alias = aliases[key];
        const name = active.get(key) ?? (alias ? active.get(alias.toUpperCase()) : undefined);
        if (!name) { unknown = true; continue; }
        if (!resolved.includes(name)) resolved.push(name);
    }
    if (resolved.length > MAX_JOB_TYPES) return drop("TOO_MANY_JOB_TYPES");
    const value = resolved.length ? resolved : null;
    return unknown ? { value, warning: "UNKNOWN_JOB_TYPE" } : { value };
}

// ---------------------------------------------------------------- masking

// A passport-like identifier shown only masked: "N12345678" -> "N1*****78".
export function maskIdentifier(value) {
    const text = clean(value);
    if (text.length < 6) return "***";
    return `${text.slice(0, 2)}${"*".repeat(text.length - 4)}${text.slice(-2)}`;
}
