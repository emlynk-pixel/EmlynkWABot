// Bulk candidate import: the legacy source mapping, normalizers and row validation (pure; no
// database). SYNTHETIC values only: patterns modelled on the legacy sheet, never its data.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    LEGACY_SOURCE_COLUMNS, REQUIRED_SOURCE_HEADERS, SOURCE_CLASSIFICATION, analyzeSourceHeaders, sourceColumnFor, sourceColumnsForClient,
} from "../src/services/candidateImportSourceMapping.js";
import {
    isNotApplicable, maskIdentifier, normalizeBloodGroup, normalizeDate, normalizeEmail, normalizeFamilyPassport, normalizeHeight, normalizeJobRoles,
    normalizeMaritalStatus, normalizeNic, normalizePassport, normalizePhones, normalizeSex, normalizeShirtSize, normalizeShoeSize,
    normalizeWaistSize, normalizeWeight, normalizeYesNo, parseLegacyDate,
} from "../src/services/candidateImportNormalizers.js";
import { FIELD_TARGETS, ROW_STATUS, sourceCells, toColumns, validateLegacyRow } from "../src/services/candidateImportRowValidator.js";
import { parseCandidateBody } from "../src/services/candidateService.js";

const ACTIVE = ["PLASTER", "PLUMBER", "ELECTRICIAN", "TILER", "WELDER TIG", "WELDER MIG", "EXCAVATOR OPERATOR"];
const TODAY = new Date("2026-10-28T00:00:00.000Z");
const day = (date) => date.toISOString().slice(0, 10);
const validate = (values, rowNumber = 2) => validateLegacyRow({ rowNumber, values }, { activeJobTypes: ACTIVE, today: TODAY });
const BASE = { "PASSPORT NUMBER": "N9000001", SURNAME: "SYNTHSURNAME", "OTHER NAME": "SYNTH GIVEN", "NIC NUMBER": "900000001V", "WHATSAPP NUMBER": "0770000001" };
const codes = (row) => row.issues.map((i) => i.code);

describe("legacy source mapping (centralized)", () => {
    test("every column has one classification; required headings are passport, surname and other name", () => {
        const allowed = new Set(Object.values(SOURCE_CLASSIFICATION));
        assert.ok(LEGACY_SOURCE_COLUMNS.every((c) => allowed.has(c.classification)));
        assert.equal(new Set(LEGACY_SOURCE_COLUMNS.map((c) => c.header)).size, LEGACY_SOURCE_COLUMNS.length, "no header is listed twice");
        assert.deepEqual([...REQUIRED_SOURCE_HEADERS].sort(), ["OTHER NAME", "PASSPORT NUMBER", "SURNAME"]);
    });

    test("system-owned columns (statuses, documents, legacy IDs) are never accepted from a file", () => {
        for (const header of ["UNIQUE NUMBER", "ACTIVE STATUS", "VISA STATUS", "REGISTER DATE", "PASSPORT", "MEDICAL", "SCAN", "POLICE REPORT", "VIDEO", "INTERVIEW PASS FAIL"]) {
            assert.equal(sourceColumnFor(header).classification, SOURCE_CLASSIFICATION.SYSTEM_GENERATED, header);
            assert.equal(sourceColumnFor(header).field, undefined);
        }
        const { allowed } = sourceColumnsForClient();
        assert.ok(!allowed.includes("ACTIVE STATUS") && !allowed.includes("UNIQUE NUMBER") && !allowed.includes("VISA STATUS"));
    });

    test("ambiguous columns are unresolved, not guessed (family / child names, remark, interview date)", () => {
        for (const header of ["FATHER NAME", "FATHER SURNAME", "SPOUSE NAME", "CHILD1 NAME", "REMARK", "INTERVIEW DATE", "OTHER SKILLS DESCRIPTION"]) {
            const column = sourceColumnFor(header);
            assert.equal(column.classification, SOURCE_CLASSIFICATION.IGNORE, header);
            assert.ok(column.unresolved, header);
        }
    });

    test("headers match in any case and spacing; the semantic name targets are the stored meaning", () => {
        assert.equal(sourceColumnFor("  job   role ").field, "jobRole");
        assert.equal(sourceColumnFor("Marital Status").field, "maritalStatus");
        assert.equal(sourceColumnFor("SURNAME").target, "candidate.other_name");
        assert.equal(sourceColumnFor("OTHER NAME").target, "candidate.first_name");
        assert.equal(sourceColumnFor("FULL NAME").target, "candidate_additional_details.name_as_in_passport");
        assert.deepEqual(FIELD_TARGETS.surname, ["candidate", "otherName"]);
        assert.deepEqual(FIELD_TARGETS.otherNames, ["candidate", "firstName"]);
        assert.deepEqual(FIELD_TARGETS.fullName, ["details", "nameAsInPassport"]);
    });

    test("missing required headings are named; extra and unknown columns are reported, not imported", () => {
        const result = analyzeSourceHeaders(["PASSPORT NUMBER", "OTHER NAME", "LOAN APPLY AMOUNT", "Some Operator Column", "ACTIVE STATUS", "FATHER NAME"]);
        assert.deepEqual(result.missingRequired, ["SURNAME"]);
        assert.deepEqual(result.ignored, ["LOAN APPLY AMOUNT"]);
        assert.deepEqual(result.unknown, ["SOME OPERATOR COLUMN"]);
        assert.deepEqual(result.systemGenerated, ["ACTIVE STATUS"]);
        assert.deepEqual(result.unresolved, ["FATHER NAME"]);
        // A cell of an ignored column is dropped before validation, whatever the browser sent.
        assert.deepEqual(Object.keys(sourceCells({ ...BASE, "LOAN APPLY AMOUNT": "1", "ACTIVE STATUS": "INACTIVE", "UNIQUE NUMBER": "12" })).sort(), ["nic", "otherNames", "passport", "surname", "whatsapp"]);
    });
});

describe("normalizers", () => {
    test("passport: P/N + 7 digits valid; P/N + 8 digits LEGACY_PASSPORT_FORMAT warning; anything else invalid", () => {
        assert.deepEqual(normalizePassport(" n9000001 "), { value: "N9000001" });
        assert.deepEqual(normalizePassport("N 900-0001"), { value: "N9000001" });
        assert.deepEqual(normalizePassport("N90000012"), { value: "N90000012", warning: "LEGACY_PASSPORT_FORMAT" });
        assert.deepEqual(normalizePassport("P90000012"), { value: "P90000012", warning: "LEGACY_PASSPORT_FORMAT" });
        for (const bad of ["A9000001", "N900001", "N900000123", "PN9000001"]) assert.deepEqual(normalizePassport(bad), { value: null, error: "INVALID_PASSPORT" }, bad);
        assert.deepEqual(normalizePassport(""), { value: null, error: "MISSING_PASSPORT" });
        assert.deepEqual(normalizePassport("N/A"), { value: null, error: "MISSING_PASSPORT" });
    });

    test("normal registration's passport rule is unchanged: N + 8 digits is still refused there", () => {
        const body = { passportId: "N90000012", surname: "SYNTHSURNAME", otherNames: "SYNTH GIVEN", nic: "900000001V", whatsappNumber: "0770000001", jobTypes: ["PLASTER"] };
        assert.ok(parseCandidateBody(body, { creating: true }).errors.some((e) => e.field === "passportId"));
        assert.equal(parseCandidateBody({ ...body, passportId: "N9000001" }, { creating: true }).errors, undefined);
    });

    test("NIC: case and spaces normalized; old and new formats; corrupted (scientific) and malformed values dropped, never guessed", () => {
        assert.deepEqual(normalizeNic("900000001v"), { value: "900000001V" });
        assert.deepEqual(normalizeNic("900000001 X"), { value: "900000001X" });
        assert.deepEqual(normalizeNic("199000000001"), { value: "199000000001" });
        assert.deepEqual(normalizeNic("1.99E+11"), { value: null, warning: "NIC_CORRUPTED" });
        assert.deepEqual(normalizeNic("1990000000011"), { value: null, warning: "INVALID_NIC" });
        assert.deepEqual(normalizeNic("NO NIC"), { value: null, warning: "INVALID_NIC" });
        assert.deepEqual(normalizeNic(""), { value: null, warning: "MISSING_NIC" });
    });

    test("Sri Lankan phone numbers become +94 E.164", () => {
        for (const input of ["0770000001", "770000001", "94770000001", "+94770000001", "+94 77 000 0001", "0094770000001", "077-000-0001"]) {
            assert.deepEqual(normalizePhones(input), { numbers: ["+94770000001"], warnings: [] }, input);
        }
    });

    test("foreign numbers keep their country code ('+' added); unknown codes are flagged, junk is dropped", () => {
        assert.deepEqual(normalizePhones("40700000001"), { numbers: ["+40700000001"], warnings: [] });
        assert.deepEqual(normalizePhones("+40 700 000 001"), { numbers: ["+40700000001"], warnings: [] });
        assert.deepEqual(normalizePhones("4915100000001"), { numbers: ["+4915100000001"], warnings: ["FOREIGN_PHONE_UNVERIFIED"] });
        assert.deepEqual(normalizePhones("T1234"), { numbers: [], warnings: ["INVALID_PHONE"] });
        assert.deepEqual(normalizePhones("9.4770E+10"), { numbers: [], warnings: ["INVALID_PHONE"] });
    });

    test("several numbers in one cell: every one is kept in order, with MULTIPLE_PHONE_NUMBERS", () => {
        assert.deepEqual(normalizePhones("94770000001 / 94770000002"), { numbers: ["+94770000001", "+94770000002"], warnings: ["MULTIPLE_PHONE_NUMBERS"] });
        assert.deepEqual(normalizePhones("94770000001 40700000001"), { numbers: ["+94770000001", "+40700000001"], warnings: ["MULTIPLE_PHONE_NUMBERS"] });
        // Spaces inside one number are grouping, not a second number.
        assert.deepEqual(normalizePhones("94 77 000 0001"), { numbers: ["+94770000001"], warnings: [] });
    });

    test("dates: DD.MM.YYYY, DD/MM/YYYY, unpadded, ISO (with a time) and Excel serial days; never locale parsing", () => {
        assert.equal(day(parseLegacyDate("05.03.1990")), "1990-03-05", "day first");
        assert.equal(day(parseLegacyDate("5/3/1990")), "1990-03-05");
        assert.equal(day(parseLegacyDate("25-12-1990")), "1990-12-25");
        assert.equal(day(parseLegacyDate("1990-03-05")), "1990-03-05");
        assert.equal(day(parseLegacyDate("1990-03-05 00:00:00")), "1990-03-05");
        assert.equal(day(parseLegacyDate("32937")), "1990-03-05", "Excel serial");
        assert.equal(day(parseLegacyDate("45000")), "2023-03-15");
    });

    test("invalid dates are flagged: impossible days, two-digit years, overflow (####), text, future birth dates", () => {
        for (const bad of ["31.02.1990", "05.03.90", "####", "March 5 1990", "00.01.1990", "1990-13-01"]) {
            assert.deepEqual(normalizeDate(bad), { value: null, warning: "INVALID_DATE" }, bad);
        }
        assert.deepEqual(normalizeDate("01.01.2030", { notFuture: true, today: TODAY }), { value: null, warning: "INVALID_DATE" });
        assert.equal(day(normalizeDate("01.01.2030").value), "2030-01-01", "an expiry date may be in the future");
        assert.deepEqual(normalizeDate("N/A"), { value: null });
    });

    test("sex, civil status and Yes / No: known variants, including bilingual '<text> (English)' answers", () => {
        assert.deepEqual(["M", "male", "MALE", "f", "Female"].map((v) => normalizeSex(v).value), ["M", "M", "M", "F", "F"]);
        assert.equal(normalizeSex("UNKNOWN").warning, "INVALID_SEX");
        assert.equal(normalizeMaritalStatus("??????? (Married)").value, "MARRIED");
        assert.equal(normalizeMaritalStatus("single").value, "SINGLE");
        assert.equal(normalizeMaritalStatus("Widowed").value, "WIDOWED");
        assert.equal(normalizeMaritalStatus("engaged").warning, "INVALID_CIVIL_STATUS");
        assert.deepEqual(["??? (Yes)", "??? (No)", "YES", "n", "Y"].map((v) => normalizeYesNo(v).value), [true, false, true, false, true]);
        assert.equal(normalizeYesNo("maybe").warning, "INVALID_YES_NO");
    });

    test("blood group: descriptive forms to codes", () => {
        assert.deepEqual(["B Positive (B+)", "AB Negative (AB-)", "O+", "a -", "AB POSITIVE"].map((v) => normalizeBloodGroup(v).value), ["B+", "AB-", "O+", "A-", "AB+"]);
        assert.equal(normalizeBloodGroup("C+").warning, "INVALID_BLOOD_GROUP");
    });

    test("N/A variants mean 'not given' (case-insensitive)", () => {
        for (const v of ["N/A", "NA", "na", "n/a", "N.A", "-"]) assert.equal(isNotApplicable(v), true, v);
        for (const v of ["Nathan", "NAB", "N/A X"]) assert.equal(isNotApplicable(v), false, v);
    });

    test("sizes: 2XL -> XXL, W32 -> 32, shoe text with a size -> the UK size", () => {
        assert.deepEqual(["M", "xl", "2XL", "XXL"].map((v) => normalizeShirtSize(v).value), ["M", "XL", "XXL", "XXL"]);
        assert.equal(normalizeShirtSize("3XL").warning, "INVALID_SIZE");
        assert.deepEqual(["W32", "w 34", "30"].map((v) => normalizeWaistSize(v).value), ["32", "34", "30"]);
        assert.equal(normalizeWaistSize("W99").warning, "INVALID_SIZE");
        assert.deepEqual(["26.5 cm - size 8", "27.0 cm - size 10", "UK 9", "8.5"].map((v) => normalizeShoeSize(v).value), ["8", "10", "9", "8.5"]);
        assert.equal(normalizeShoeSize("size 40").warning, "INVALID_SIZE");
    });

    test("height and weight reuse the Candidate Form parsers", () => {
        assert.equal(normalizeHeight("170 cm").value, "170 cm");
        assert.equal(normalizeHeight("170").value, "170 cm");
        assert.equal(normalizeHeight("cm 170").warning, "INVALID_HEIGHT");
        assert.equal(normalizeWeight("70 kg").value, 70);
        assert.equal(normalizeWeight("70").value, 70);
        assert.equal(normalizeWeight("700").warning, "INVALID_WEIGHT");
    });

    test("family passport: a NIC-shaped value is not a passport", () => {
        assert.equal(normalizeFamilyPassport("N9000002").value, "N9000002");
        assert.equal(normalizeFamilyPassport("900000002V").warning, "FAMILY_PASSPORT_LOOKS_LIKE_NIC");
        assert.equal(normalizeFamilyPassport("?????").warning, "INVALID_FAMILY_PASSPORT");
        assert.equal(normalizeEmail("Synth@Example.invalid").value, "synth@example.invalid");
    });

    test("job roles: matched to ACTIVE job types by name; aliases only when confirmed; unknown roles never created", () => {
        assert.deepEqual(normalizeJobRoles("Plaster", { activeJobTypes: ACTIVE }), { value: ["PLASTER"] });
        assert.deepEqual(normalizeJobRoles("plumber, Electrician", { activeJobTypes: ACTIVE }), { value: ["PLUMBER", "ELECTRICIAN"] });
        // A generic Welder is never guessed to be a specific TIG / MIG type.
        assert.deepEqual(normalizeJobRoles("Welder", { activeJobTypes: ACTIVE }), { value: null, warning: "UNKNOWN_JOB_TYPE" });
        assert.deepEqual(normalizeJobRoles("Excavator", { activeJobTypes: ACTIVE }), { value: null, warning: "UNKNOWN_JOB_TYPE" });
        // A confirmed alias maps to an active type.
        assert.deepEqual(normalizeJobRoles("Excavator", { activeJobTypes: ACTIVE, aliases: { EXCAVATOR: "EXCAVATOR OPERATOR" } }), { value: ["EXCAVATOR OPERATOR"] });
        assert.deepEqual(normalizeJobRoles("Plaster, Foreman", { activeJobTypes: ACTIVE }), { value: ["PLASTER"], warning: "UNKNOWN_JOB_TYPE" });
    });

    test("masking shows only the first and last two characters", () => {
        assert.equal(maskIdentifier("N90000012"), "N9*****12");
        assert.equal(maskIdentifier("N9000001"), "N9****01");
        assert.equal(maskIdentifier("AB"), "***");
    });
});

describe("row validation", () => {
    test("SURNAME -> other_name (surname), OTHER NAME -> first_name (other names), FULL NAME -> name_as_in_passport", () => {
        const row = validate({ ...BASE, "FULL NAME": "SYNTH GIVEN SYNTHSURNAME" });
        assert.equal(row.status, ROW_STATUS.VALID);
        const { candidate, details } = toColumns(row.values);
        assert.equal(candidate.otherName, "SYNTHSURNAME");
        assert.equal(candidate.firstName, "SYNTH GIVEN");
        assert.equal(details.nameAsInPassport, "SYNTH GIVEN SYNTHSURNAME");
    });

    test("legacy N + 8 passport: WARNING only, the row stays importable", () => {
        const row = validate({ ...BASE, "PASSPORT NUMBER": "N90000012" });
        assert.equal(row.status, ROW_STATUS.WARNING);
        assert.deepEqual(codes(row), ["LEGACY_PASSPORT_FORMAT"]);
        assert.equal(row.passport, "N90000012");
        assert.equal(row.maskedPassport, "N9*****12");
    });

    test("surname present, other names missing: INVALID (both names are required; none is invented)", () => {
        const row = validate({ ...BASE, "OTHER NAME": "" });
        assert.equal(row.status, ROW_STATUS.INVALID);
        assert.deepEqual(codes(row), ["MISSING_OTHER_NAMES"]);
        // A literal N/A is the form's own "not applicable" answer: kept as N/A, with a warning.
        const na = validate({ ...BASE, "OTHER NAME": "N/A" });
        assert.equal(na.status, ROW_STATUS.WARNING);
        assert.equal(na.values.otherNames, "N/A");
        assert.equal(validate({ ...BASE, SURNAME: "" }).status, ROW_STATUS.INVALID);
        assert.equal(validate({ ...BASE, "PASSPORT NUMBER": "X12" }).status, ROW_STATUS.INVALID);
    });

    test("an unusable optional value is dropped with a warning; the row is still imported", () => {
        const row = validate({ ...BASE, "NIC NUMBER": "1.99E+11", "BIRTH DATE": "####", "Job Role": "Welder", SEX: "MALE", "HIP SIZE": "W32" });
        assert.equal(row.status, ROW_STATUS.WARNING);
        assert.deepEqual(codes(row).sort(), ["INVALID_DATE", "NIC_CORRUPTED", "UNKNOWN_JOB_TYPE"]);
        assert.equal(row.values.nic, undefined);
        assert.equal(row.values.jobRole, undefined, "job left unset, never a default");
        assert.equal(row.values.sex, "M");
        assert.equal(row.values.waistSize, "32");
    });

    test("two WhatsApp numbers: the first is WhatsApp, the second becomes the contact number when there is none", () => {
        const row = validate({ ...BASE, "WHATSAPP NUMBER": "0770000001 / 40700000001" });
        assert.equal(row.values.whatsapp, "+94770000001");
        assert.equal(row.values.contact, "+40700000001");
        assert.ok(codes(row).includes("MULTIPLE_PHONE_NUMBERS"));
        assert.ok(codes(validate({ ...BASE, "WHATSAPP NUMBER": "" })).includes("MISSING_WHATSAPP"));
    });

    test("passport issue date not before expiry: the issue date is dropped", () => {
        const row = validate({ ...BASE, "PASSPORT ISSUE DATE": "01.01.2025", "PASSPORT EXPIRE DATE": "01.01.2024" });
        assert.equal(row.values.passportIssueDate, undefined);
        assert.ok(codes(row).includes("PASSPORT_DATES_INCONSISTENT"));
    });

    test("MARITAL STATUS and CIVIL STATUS disagreeing is not guessed between", () => {
        const row = validate({ ...BASE, "Marital Status": "x (Married)", "CIVIL STATUS": "Single" });
        assert.equal(row.values.maritalStatus, undefined);
        assert.ok(codes(row).includes("CIVIL_STATUS_CONFLICT"));
    });

    test("issue codes never carry a value", () => {
        const row = validate({ ...BASE, "NIC NUMBER": "SECRETVALUE", "BIRTH DATE": "SECRETDATE", EMAIL: "SECRET" });
        assert.ok(!JSON.stringify(row.issues).includes("SECRET"));
    });
});
