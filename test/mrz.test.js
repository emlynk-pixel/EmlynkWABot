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
