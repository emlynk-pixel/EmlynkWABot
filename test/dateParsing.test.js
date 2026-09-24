import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { findDocumentDates, parseDocumentDate, toIsoDate } from "../src/utils/dateParsing.js";
import { normalizePassportId } from "../src/utils/passportId.js";

describe("toIsoDate", () => {
    test("valid date", () => assert.equal(toIsoDate(2026, 9, 1), "2026-09-01"));
    test("31 February does not exist", () => assert.equal(toIsoDate(1990, 2, 31), null));
    test("29 February only in leap years", () => {
        assert.equal(toIsoDate(2024, 2, 29), "2024-02-29");
        assert.equal(toIsoDate(2025, 2, 29), null);
    });
    test("month 13 does not exist", () => assert.equal(toIsoDate(2026, 13, 1), null));
});

describe("parseDocumentDate", () => {
    const cases = [
        ["12/03/1990", "1990-03-12"],
        ["12-03-1990", "1990-03-12"],
        ["12.03.1990", "1990-03-12"],
        ["1990-03-12", "1990-03-12"],
        ["12 MAR 1990", "1990-03-12"],
        ["12-Mar-1990", "1990-03-12"],
        ["12 AUG/AOUT 1974", "1974-08-12"],
        ["1 September 2026", "2026-09-01"],
        ["March 12, 1990", "1990-03-12"],
    ];

    for (const [input, expected] of cases) {
        test(`${input} -> ${expected}`, () => assert.equal(parseDocumentDate(input), expected));
    }

    test("numeric dates are day-first: 03/04/2026 is 3 April", () => {
        assert.equal(parseDocumentDate("03/04/2026"), "2026-04-03");
    });

    test("invalid calendar date returns null", () => assert.equal(parseDocumentDate("31/02/1990"), null));
    test("a non-month word is not read as a month", () => assert.equal(parseDocumentDate("12 marks 1990"), null));
    test("no date", () => assert.equal(parseDocumentDate("no date here"), null));
});

describe("findDocumentDates", () => {
    test("returns every valid date in reading order", () => {
        const dates = findDocumentDates("Issued 02/09/2026, submitted 01 Sep 2026, bad 31/02/2026");
        assert.deepEqual(dates.map((d) => d.date), ["2026-09-02", "2026-09-01"]);
    });
});

describe("normalizePassportId", () => {
    test("uppercases and strips spaces and MRZ filler", () => {
        assert.equal(normalizePassportId(" n 1234567< "), "N1234567");
    });
    test("rejects values without digits", () => assert.equal(normalizePassportId("PASSPORT"), null));
    test("rejects values that are too short or too long", () => {
        assert.equal(normalizePassportId("N123"), null);
        assert.equal(normalizePassportId("N1234567890"), null);
    });
    test("empty input", () => assert.equal(normalizePassportId(undefined), null));
});
