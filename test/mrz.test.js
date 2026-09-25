import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { computeCheckDigit, findPassportMrz, parsePassportMrz } from "../src/utils/mrz.js";

// ICAO 9303 specimen (fictional "Utopia" passport), with published check digits.
const SPECIMEN_LINE_1 = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<";
const SPECIMEN_LINE_2 = "L898902C36UTO7408122F1204159ZE184226B<<<<<10";

describe("computeCheckDigit", () => {
    test("matches the ICAO specimen check digits", () => {
        assert.equal(computeCheckDigit("L898902C3"), 6);
        assert.equal(computeCheckDigit("740812"), 2);
        assert.equal(computeCheckDigit("120415"), 9);
    });
});

describe("findPassportMrz", () => {
    test("finds both lines", () => {
        assert.deepEqual(findPassportMrz(`${SPECIMEN_LINE_1}\n${SPECIMEN_LINE_2}`), {
            line1: SPECIMEN_LINE_1,
            line2: SPECIMEN_LINE_2,
        });
    });

    test("tolerates OCR spaces and « for <", () => {
        const noisy = "P < UTOERIKSSON «< ANNA < MARIA <<<<<<<<<<<<<<<<<<<";
        assert.equal(findPassportMrz(noisy).line1, SPECIMEN_LINE_1);
    });

    test("returns null when there is no MRZ", () => {
        assert.equal(findPassportMrz("Just a normal letter.\nNothing machine readable here."), null);
    });
});

describe("parsePassportMrz", () => {
    test("parses the ICAO specimen with every check digit valid", () => {
        assert.deepEqual(parsePassportMrz({ line1: SPECIMEN_LINE_1, line2: SPECIMEN_LINE_2 }), {
            surname: "ERIKSSON",
            givenNames: "ANNA MARIA",
            passportNumber: "L898902C3",
            passportNumberCheckValid: true,
            dateOfBirth: "1974-08-12",
            dateOfBirthCheckValid: true,
            expiryDate: "2012-04-15",
            expiryDateCheckValid: true,
            compositeCheckValid: true,
        });
    });

    test("corrects O/I lookalikes in digit-only fields", () => {
        const line2 = SPECIMEN_LINE_2.replace("7408122", "74O8I22");
        const result = parsePassportMrz(findPassportMrz(`${SPECIMEN_LINE_1}\n${line2}`));

        assert.equal(result.dateOfBirth, "1974-08-12");
        assert.equal(result.dateOfBirthCheckValid, true);
        assert.equal(result.compositeCheckValid, true);
    });

    test("leaves letters in the alphanumeric passport number alone", () => {
        const result = parsePassportMrz({ line2: SPECIMEN_LINE_2 });
        assert.equal(result.passportNumber, "L898902C3");
    });

    test("detects a corrupted passport number", () => {
        const line2 = SPECIMEN_LINE_2.replace("L898902C3", "L898902C8");
        const result = parsePassportMrz({ line2 });

        assert.equal(result.passportNumberCheckValid, false);
        assert.equal(result.compositeCheckValid, false);
    });

    test("birth years in the future are moved to the 1900s", () => {
        const result = parsePassportMrz({ line2: SPECIMEN_LINE_2 });
        assert.equal(result.dateOfBirth.slice(0, 4), "1974");
    });
});

describe("MRZ line 2: OCR-misread sex position", () => {
    // Specimen line 2 has "F" at index 20 (sex).
    const withSex = (char) => SPECIMEN_LINE_2.slice(0, 20) + char + SPECIMEN_LINE_2.slice(21);
    const withChar = (index, char) => SPECIMEN_LINE_2.slice(0, index) + char + SPECIMEN_LINE_2.slice(index + 1);
    const find = (line2) => findPassportMrz(`${SPECIMEN_LINE_1}\n${line2}`)?.line2 ?? null;

    test("valid sex values M, F, X and < are found", () => {
        for (const char of ["M", "F", "X", "<"]) {
            assert.equal(find(withSex(char)), withSex(char), char);
        }
    });

    test("an OCR misread at the sex position (H, N, 1) no longer hides the line", () => {
        for (const char of ["H", "N", "1"]) {
            assert.equal(find(withSex(char)), withSex(char), char);
        }
    });

    test("the check digits still decide: a misread sex character doesn't change them", () => {
        const result = parsePassportMrz({ line1: SPECIMEN_LINE_1, line2: withSex("N") });
        assert.equal(result.passportNumberCheckValid, true);
        assert.equal(result.dateOfBirthCheckValid, true);
        assert.equal(result.expiryDateCheckValid, true);
    });

    test("malformed lines elsewhere are still rejected", () => {
        const malformed = [
            withChar(9, "A"),   // passport-number check digit must be a digit (or lookalike)
            withChar(10, "1"),  // country code must be letters
            withChar(13, "A"),  // birth date must be digits (or lookalikes)
            withChar(19, "A"),  // birth-date check digit
            withChar(21, "A"),  // expiry date
            withChar(27, "A"),  // expiry check digit
            withChar(3, "#"),   // not an MRZ character
        ];
        for (const line2 of malformed) {
            assert.equal(find(line2), null, line2);
        }
    });

    test("failed check digits stay failed (never verified by the relaxed detection)", () => {
        const badNumber = parsePassportMrz({ line2: withChar(9, "7") });
        const badBirth = parsePassportMrz({ line2: withChar(19, "3") });
        const badExpiry = parsePassportMrz({ line2: withChar(27, "8") });

        assert.equal(badNumber.passportNumberCheckValid, false);
        assert.equal(badBirth.dateOfBirthCheckValid, false);
        assert.equal(badExpiry.expiryDateCheckValid, false);
    });

    test("line 1 is never also taken as line 2", () => {
        assert.equal(findPassportMrz(SPECIMEN_LINE_1).line2, null);
    });
});
