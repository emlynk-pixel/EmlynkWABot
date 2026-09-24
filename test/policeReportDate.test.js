import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    extractPoliceReportDate,
    POLICE_DATE_STATUS,
    POLICE_DATE_KIND,
} from "../src/services/policeReportDateService.js";
import { loadDocumentText } from "./helpers/fixtures.js";

const now = new Date("2026-09-24T00:00:00Z");
const extract = (text) => extractPoliceReportDate(text, { now });

const { RESOLVED, AMBIGUOUS, INVALID, NOT_FOUND } = POLICE_DATE_STATUS;
const { SUBMITTED, ISSUED, UNLABELLED } = POLICE_DATE_KIND;

describe("extractPoliceReportDate", () => {
    describe("valid dates", () => {
        test("police slip: submitted date", () => {
            const result = extract(loadDocumentText("police-slip"));

            assert.equal(result.status, RESOLVED);
            assert.equal(result.date, "2026-09-01");
            assert.equal(result.kind, SUBMITTED);
            assert.equal(result.confidence, 95);
        });

        test("police certificate: issue date", () => {
            const result = extract(loadDocumentText("police-clearance"));

            assert.equal(result.status, RESOLVED);
            assert.equal(result.date, "2026-09-02");
            assert.equal(result.kind, ISSUED);
        });

        test("label on the line above the date", () => {
            const result = extract("Receipt of application\nDate of Submission:\n01 Sep 2026");

            assert.equal(result.date, "2026-09-01");
            assert.equal(result.kind, SUBMITTED);
        });

        test("a single unlabelled date is used, with review-level confidence", () => {
            const result = extract("SRI LANKA POLICE\nClearance request\n05-09-2026");

            assert.equal(result.status, RESOLVED);
            assert.equal(result.kind, UNLABELLED);
            assert.equal(result.confidence, 60);
        });
    });

    describe("multiple dates", () => {
        test("submitted date wins over issue date", () => {
            const result = extract("Application submitted on 01/09/2026\nPrinted and issued 03/09/2026");

            assert.equal(result.date, "2026-09-01");
            assert.equal(result.kind, SUBMITTED);
        });

        test("birth and expiry dates are never used", () => {
            const result = extract("Date of Birth 12/03/1990\nPassport expiry 11/05/2030\nSubmitted 01/09/2026");

            assert.equal(result.date, "2026-09-01");
            assert.equal(result.candidates.length, 1);
        });

        test("two different submitted dates are ambiguous, not guessed", () => {
            const result = extract("Submitted: 01/09/2026\nApplication date: 04/09/2026");

            assert.equal(result.status, AMBIGUOUS);
            assert.equal(result.date, null);
            assert.equal(result.candidates.length, 2);
        });

        test("the same submitted date repeated is fine", () => {
            const result = extract("Submitted: 01/09/2026\nApplication received 01 Sep 2026");
            assert.equal(result.status, RESOLVED);
            assert.equal(result.date, "2026-09-01");
        });

        test("two unlabelled dates are ambiguous", () => {
            const result = extract("Police\n01/09/2026\n04/09/2026");
            assert.equal(result.status, AMBIGUOUS);
        });
    });

    describe("missing or invalid dates", () => {
        test("no date at all", () => {
            const result = extract("SRI LANKA POLICE\nApplication for clearance");

            assert.equal(result.status, NOT_FOUND);
            assert.equal(result.date, null);
            assert.equal(result.confidence, 0);
        });

        test("empty text", () => assert.equal(extract("").status, NOT_FOUND));

        test("impossible calendar date is ignored", () => {
            assert.equal(extract("Submitted date: 31/02/2026").status, NOT_FOUND);
        });

        test("future submitted date is invalid", () => {
            const result = extract("Submitted date: 01/12/2026");

            assert.equal(result.status, INVALID);
            assert.equal(result.candidates[0].valid, false);
        });

        test("implausibly old date is invalid", () => {
            assert.equal(extract("Submitted date: 01/09/1995").status, INVALID);
        });

        test("only a birth date on the page", () => {
            assert.equal(extract("Date of birth 12/03/1990").status, NOT_FOUND);
        });
    });
});
