import { toIsoDate } from "./dateParsing.js";

// Passport MRZ (ICAO 9303, TD3): two 44-character lines at the bottom of the data page.
// Line 1: P<ISSUER SURNAME<<GIVEN<NAMES<<<...
// Line 2: passport no, check digit, nationality, birth date, check digit, sex,
//         expiry date, check digit, personal no, check digit, composite check digit

// Digit positions also accept letters OCR confuses with digits (O/0, I/1, ...).
// They're corrected in parsePassportMrz, and check digits catch bad reads.
const D = "[0-9OQDILZSGB]";
const MRZ_LINE_1 = /^P[A-Z<][A-Z<]{3}[A-Z<]*<<[A-Z<]*$/;
// The sex position (index 20) accepts any MRZ character: on low-resolution
// photos OCR often misreads M/F as another letter or a digit, and one bad
// character shouldn't hide the whole line. Sex is not extracted and no check
// digit used here covers it; the passport number, dates and their check
// digits keep their strict positions and still decide verification.
const MRZ_SEX = "[A-Z0-9<]";
const MRZ_LINE_2 = new RegExp(`^[A-Z0-9<]{9}[0-9<OQDILZSGB][A-Z<]{3}${D}{6}[0-9<OQDILZSGB]${MRZ_SEX}${D}{6}[0-9<OQDILZSGB]`);

// OCR tends to add spaces inside MRZ lines and misread "<" as similar glyphs.
export function cleanMrzLine(line) {
    return line
        .toUpperCase()
        .replace(/[«‹]/g, "<")
        .replace(/\s+/g, "");
}

// Returns the MRZ lines found in the text. Either line may be null if OCR lost it.
export function findPassportMrz(text) {
    const lines = (text || "")
        .split(/\r?\n/)
        .map(cleanMrzLine)
        .filter((line) => line.length >= 30 && line.length <= 50);

    const line1 = lines.find((line) => MRZ_LINE_1.test(line)) || null;
    // Never the same line twice.
    const line2 = lines.find((line) => line !== line1 && MRZ_LINE_2.test(line)) || null;

    if (!line1 && !line2) {
        return null;
    }

    return { line1, line2 };
}

// ICAO check digit: weights 7-3-1 repeating, A=10 ... Z=35, "<" = 0.
export function computeCheckDigit(value) {
    let total = 0;

    for (let i = 0; i < value.length; i++) {
        const char = value[i];
        let charValue = 0;

        if (char >= "0" && char <= "9") charValue = char.charCodeAt(0) - 48;
        else if (char >= "A" && char <= "Z") charValue = char.charCodeAt(0) - 55;

        total += charValue * [7, 3, 1][i % 3];
    }

    return total % 10;
}

// In fields that can only hold digits, OCR often reads 0 as O, 1 as I, etc.
const DIGIT_LOOKALIKES = { O: "0", Q: "0", D: "0", I: "1", L: "1", Z: "2", S: "5", G: "6", B: "8" };

function toDigits(value) {
    return value.replace(/[OQDILZSGB]/g, (char) => DIGIT_LOOKALIKES[char]);
}

function isCheckDigitValid(value, checkChar) {
    const digit = checkChar === "<" ? "0" : toDigits(checkChar || "");
    return /^\d$/.test(digit) && computeCheckDigit(value) === Number(digit);
}

// MRZ dates are YYMMDD. A birth year can't be in the future, and expiry
// dates are always in the 2000s for passports issued today.
function mrzDateToIso(yymmdd, kind) {
    if (!/^\d{6}$/.test(yymmdd)) return null;

    const yy = Number(yymmdd.slice(0, 2));
    const month = Number(yymmdd.slice(2, 4));
    const day = Number(yymmdd.slice(4, 6));

    let year = 2000 + yy;
    if (kind === "birth" && year > new Date().getUTCFullYear()) {
        year -= 100;
    }

    return toIsoDate(year, month, day);
}

function mrzNameToText(value) {
    const text = (value || "").replace(/</g, " ").replace(/\s+/g, " ").trim();
    return text || null;
}

// Parse the fields we use from the MRZ. Check-digit results are returned
// with each field so callers can tell a clean read from a corrupted one.
export function parsePassportMrz({ line1, line2 } = {}) {
    const result = {
        surname: null,
        givenNames: null,
        passportNumber: null,
        passportNumberCheckValid: null,
        dateOfBirth: null,
        dateOfBirthCheckValid: null,
        expiryDate: null,
        expiryDateCheckValid: null,
        compositeCheckValid: null,
    };

    if (line1) {
        const [surname, ...givenNames] = line1.slice(5).split("<<");
        result.surname = mrzNameToText(surname);
        result.givenNames = mrzNameToText(givenNames.join("<"));
    }

    if (line2 && line2.length >= 28) {
        const line = line2.slice(0, 44);

        const numberField = line.slice(0, 9);
        const birthField = toDigits(line.slice(13, 19));
        const expiryField = toDigits(line.slice(21, 27));

        result.passportNumber = numberField.replace(/</g, "") || null;
        result.passportNumberCheckValid = isCheckDigitValid(numberField, line[9]);
        result.dateOfBirth = mrzDateToIso(birthField, "birth");
        result.dateOfBirthCheckValid = isCheckDigitValid(birthField, line[19]);
        result.expiryDate = mrzDateToIso(expiryField, "expiry");
        result.expiryDateCheckValid = isCheckDigitValid(expiryField, line[27]);

        // Only digit-only positions get lookalike correction. The passport
        // and personal numbers are alphanumeric, so their letters stay as read.
        if (line.length === 44) {
            const compositeInput =
                numberField + toDigits(line[9]) +
                birthField + toDigits(line[19]) +
                expiryField + toDigits(line[27]) +
                line.slice(28, 43);
            result.compositeCheckValid = isCheckDigitValid(compositeInput, line[43]);
        }
    }

    return result;
}
