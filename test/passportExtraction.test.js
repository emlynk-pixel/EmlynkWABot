import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    extractPassportFields,
    PASSPORT_EXTRACTION_STATUS,
    CROSS_CHECK,
} from "../src/services/passportExtractionService.js";
import { loadDocumentText } from "./helpers/fixtures.js";

const { COMPLETE, PARTIAL, PASSPORT_ID_MISSING, NO_TEXT } = PASSPORT_EXTRACTION_STATUS;

const values = (result) =>
    Object.fromEntries(Object.entries(result.fields).map(([field, { value }]) => [field, value]));

describe("extractPassportFields", () => {
    describe("valid passports", () => {
        test("ICAO 9303 specimen: every field read, MRZ and printed zone agree", () => {
            const result = extractPassportFields(loadDocumentText("passport-icao-specimen"));

            assert.equal(result.status, COMPLETE);
            assert.deepEqual(values(result), {
                passportId: "L898902C3",
                surname: "ERIKSSON",
                givenNames: "ANNA MARIA",
                dateOfBirth: "1974-08-12",
                placeOfBirth: "ZENITH",
                passportExpiryDate: "2012-04-15",
            });
            assert.equal(result.mrz.linesFound, 2);
            assert.equal(result.mrz.compositeCheckValid, true);
            assert.equal(result.fields.passportId.source, "MRZ");
            assert.equal(result.fields.passportId.checkDigitValid, true);
            assert.equal(result.fields.passportId.crossCheck, CROSS_CHECK.MATCH);
            assert.equal(result.fields.dateOfBirth.crossCheck, CROSS_CHECK.MATCH);
        });

        test("Sri Lankan layout with DD/MM/YYYY dates", () => {
            const result = extractPassportFields(loadDocumentText("passport-mrz"));

            assert.equal(result.status, COMPLETE);
            assert.deepEqual(values(result), {
                passportId: "N1234567",
                surname: "PERERA",
                givenNames: "KAMAL NIMAL",
                dateOfBirth: "1990-03-12",
                placeOfBirth: "COLOMBO",
                passportExpiryDate: "2030-05-11",
            });
            assert.equal(result.mrz.compositeCheckValid, true);
        });

        test("printed values on the line below their labels", () => {
            const result = extractPassportFields(loadDocumentText("passport-viz-values-next-line"));

            assert.equal(result.fields.passportId.value, "N1234567");
            assert.equal(result.fields.surname.value, "PERERA");
            assert.equal(result.fields.givenNames.value, "KAMAL NIMAL");
            assert.equal(result.fields.dateOfBirth.value, "1990-03-12");
            assert.equal(result.fields.passportExpiryDate.value, "2030-05-11");
            assert.equal(result.fields.passportId.source, "VIZ");
        });
    });

    describe("damaged or blurry passports", () => {
        test("blurry passport where only the MRZ was readable", () => {
            const result = extractPassportFields(loadDocumentText("passport-mrz-only-noisy"));

            assert.equal(result.status, PARTIAL);
            assert.equal(result.fields.passportId.value, "N1234567");
            assert.equal(result.fields.dateOfBirth.value, "1990-03-12");
            assert.deepEqual(result.missingFields, ["placeOfBirth"]);
        });

        test("cropped passport: only MRZ line 2 survived", () => {
            const result = extractPassportFields(loadDocumentText("passport-one-mrz-line"));

            assert.equal(result.status, PARTIAL);
            assert.equal(result.fields.passportId.value, "N1234567");
            assert.equal(result.fields.passportExpiryDate.value, "2030-05-11");
            assert.equal(result.fields.surname.value, null);
            assert.equal(result.fields.givenNames.value, null);
            assert.equal(result.mrz.linesFound, 1);
        });

        test("corrupted MRZ check digit falls back to the printed number", () => {
            const result = extractPassportFields(loadDocumentText("passport-mrz-bad-check-digit"));
            const { passportId } = result.fields;

            assert.equal(passportId.value, "N1234567");
            assert.equal(passportId.source, "VIZ");
            assert.equal(passportId.checkDigitValid, false);
            assert.equal(result.mrz.compositeCheckValid, false);
        });

        test("MRZ and printed passport numbers disagree: flagged, not hidden", () => {
            const result = extractPassportFields(loadDocumentText("passport-mrz-viz-mismatch"));
            const { passportId } = result.fields;

            assert.equal(passportId.value, "N1234567");
            assert.equal(passportId.source, "MRZ");
            assert.equal(passportId.crossCheck, CROSS_CHECK.MISMATCH);
        });

        test("an impossible printed date is left empty, not guessed", () => {
            const result = extractPassportFields(loadDocumentText("passport-invalid-date"));

            assert.equal(result.fields.dateOfBirth.value, null);
            assert.equal(result.fields.passportExpiryDate.value, "2030-05-11");
            assert.ok(result.missingFields.includes("dateOfBirth"));
        });
    });

    describe("missing passport ID", () => {
        test("passport without a readable number", () => {
            const result = extractPassportFields(loadDocumentText("passport-no-id"));

            assert.equal(result.status, PASSPORT_ID_MISSING);
            assert.equal(result.fields.passportId.value, null);
            assert.equal(result.fields.surname.value, "PERERA");
        });

        test("malformed OCR output yields no fields", () => {
            const result = extractPassportFields(loadDocumentText("malformed-ocr"));

            assert.equal(result.status, PASSPORT_ID_MISSING);
            assert.ok(Object.values(values(result)).every((value) => value === null));
        });

        test("empty text", () => {
            const result = extractPassportFields("");

            assert.equal(result.status, NO_TEXT);
            assert.equal(result.missingFields.length, 6);
        });

        test("a police certificate's 'Passport No' is still readable (type decides later)", () => {
            const result = extractPassportFields(loadDocumentText("police-clearance"));
            assert.equal(result.fields.passportId.value, "N1234567");
            assert.equal(result.mrz.linesFound, 0);
        });
    });
});
