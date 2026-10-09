// Google Sheet mirror: candidate aggregate -> 41-cell row (candidateSheetMapper.js).
// Pure mapping only: synthetic data, no database, no Google.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { SHEET_COLUMNS } from "../src/services/sheetSchema.js";
import {
    DOCUMENT_STATUS_MISSING,
    RECORD_STATUS,
    SheetMappingError,
    mapCandidateToSheetRow,
} from "../src/services/candidateSheetMapper.js";

const MIRRORED_AT = new Date("2026-10-07T09:15:30.456Z");

const cell = (row, field) => row[SHEET_COLUMNS.find((c) => c.field === field).index];

function user(overrides = {}) {
    return {
        passportId: "SYN000001",
        uniqueId: "0042",
        firstName: "TEST GIVEN",
        otherName: "TESTSURNAME",
        dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
        placeOfBirth: "EXAMPLE TOWN",
        passportExpiryDate: new Date("2030-01-01T00:00:00.000Z"),
        passportIssueDate: new Date("2020-01-01T00:00:00.000Z"),
        address: "1 Example Road, Example Town",
        job: "Job One, Job Two",
        nic: "000000000V",
        jobExperience: "5 years, example",
        whatsappNumber: "94700000001",
        contactNumber: "94700000002",
        nationality: "EXAMPLE",
        sex: "M",
        createdDate: new Date("2026-10-01T10:30:00.123Z"),
        ...overrides,
    };
}

let nextId = 1;
function doc(documentType, verificationStatus = "VERIFIED", extra = {}) {
    const documentId = `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
    return {
        documentId,
        documentType,
        documentVariant: null,
        verificationStatus,
        receivedDate: new Date("2026-10-02T00:00:00.000Z"),
        createdDate: new Date("2026-10-02T00:00:00.000Z"),
        policeSubmittedDate: null,
        ...extra,
    };
}

const map = (aggregate, options = {}) => mapCandidateToSheetRow(aggregate, { mirroredAt: MIRRORED_AT, ...options });

const atColumn = (cells, column) => cells[SHEET_COLUMNS.find((c) => c.column === column).index];

describe("candidate -> Sheet row", () => {
    test("always exactly 41 string cells, for a full and for an empty candidate", () => {
        const full = map({ user: user(), stages: [], documents: [doc("PASSPORT")] });
        assert.equal(full.length, 41);
        assert.ok(full.every((c) => typeof c === "string"));

        const minimal = map({ user: { uniqueId: "0007", passportId: "SYN000007", firstName: "ONLY" } });
        assert.equal(minimal.length, 41);
        assert.ok(minimal.every((c) => typeof c === "string"));
    });

    test("_SYSTEM_CANDIDATE_ID (AO) is users.unique_id, kept as text with leading zeros", () => {
        const row = map({ user: user({ uniqueId: "0042" }) });
        assert.equal(row[40], "0042");
        assert.equal(cell(row, "systemCandidateId"), "0042");
        assert.notEqual(row[40], "SYN000001");
    });

    test("a candidate without a unique ID is refused, never keyed on passport or NIC", () => {
        for (const uniqueId of [undefined, null, "", "  "]) {
            assert.throws(() => map({ user: user({ uniqueId }) }), SheetMappingError);
        }
        assert.throws(() => map({}), SheetMappingError);
    });

    test("TEST NUMBER, DRIVING LICIAN and POLICE REP FM are always blank", () => {
        const stages = [{ stage: "TEST_DETAILS", completed: true, jobId: "JOB-0001", testResult: "PASS", testDate: new Date("2026-10-03T00:00:00.000Z") }];
        const documents = [doc("POLICE_REPORT", "VERIFIED", { documentVariant: "SL_VERIFIED" }), doc("POLICE_REPORT", "VERIFIED", { documentVariant: "SL_NORMAL" })];
        const row = map({ user: user(), stages, documents });
        assert.equal(row[0], "", "TEST NUMBER (A)");
        assert.equal(cell(row, "testNumber"), "");
        assert.notEqual(row[0], "JOB-0001", "job_id is never mapped to TEST NUMBER");
        assert.equal(cell(row, "drivingLicence"), "");
        assert.equal(row[17], "", "DRIVING LICIAN (R)");
        assert.equal(cell(row, "policeReportFm"), "");
        assert.equal(row[22], "", "POLICE REP FM (W)");
    });

    test("police reports: N = SL_VERIFIED, V = SL_NORMAL, O = ROMANIA", () => {
        const documents = [
            doc("POLICE_REPORT", "VERIFIED", { documentVariant: "SL_VERIFIED" }),
            doc("POLICE_REPORT", "REVIEW_REQUIRED", { documentVariant: "SL_NORMAL" }),
        ];
        const row = map({ user: user(), documents });
        assert.equal(row[13], "VERIFIED", "first POLICE REP SRI LANKA (N) is SL_VERIFIED");
        assert.equal(row[21], "REVIEW_REQUIRED", "second POLICE REP SRI LANKA (V) is SL_NORMAL");
        assert.equal(row[14], DOCUMENT_STATUS_MISSING, "POLICE REP ROMANIA (O): none yet");

        const withRomania = map({ user: user(), documents: [doc("POLICE_REPORT", "VERIFIED", { documentVariant: "ROMANIA" })] });
        assert.equal(withRomania[14], "VERIFIED");
        assert.equal(withRomania[13], DOCUMENT_STATUS_MISSING);
        assert.equal(withRomania[21], DOCUMENT_STATUS_MISSING);
    });

    test("a police report without a variant fills none of the variant columns", () => {
        const row = map({ user: user(), documents: [doc("POLICE_REPORT", "VERIFIED")] });
        assert.deepEqual([row[13], row[14], row[21]], [DOCUMENT_STATUS_MISSING, DOCUMENT_STATUS_MISSING, DOCUMENT_STATUS_MISSING]);
    });

    test("document columns use the stored statuses and MISSING, with the app's current-document rule", () => {
        const documents = [
            doc("PASSPORT", "SUPERSEDED"),
            doc("PASSPORT", "VERIFIED"),
            doc("MEDICAL", "REVIEW_REQUIRED"),
            doc("NIC", "SUPERSEDED"),
            doc("SKILL_VIDEO", "VERIFIED"),
            doc("POLICE_SLIP", "VERIFIED", { policeSubmittedDate: new Date("2026-09-15T00:00:00.000Z") }),
        ];
        const row = map({ user: user(), documents });
        assert.equal(cell(row, "passportCopy"), "VERIFIED", "PASSPORT COPY (M)");
        assert.equal(cell(row, "medical"), "REVIEW_REQUIRED", "MEDICAL (P)");
        assert.equal(cell(row, "nationalId"), DOCUMENT_STATUS_MISSING, "NATIONAL ID (S): only a superseded NIC");
        assert.equal(cell(row, "videos"), "VERIFIED", "VIDEOS (X) = SKILL_VIDEO");
        assert.equal(cell(row, "policeReportApplied"), "VERIFIED", "POLICE REPORT APPLIED (T) = POLICE_SLIP");
        assert.equal(cell(row, "submitDate"), "2026-09-15", "SUBMIT DATE (U)");
        assert.equal(cell(row, "scan"), DOCUMENT_STATUS_MISSING, "SCAN (Q)");
    });

    test("one SCAN: a SCAN document fills Q, and only Q", () => {
        const without = map({ user: user() });
        const withScan = map({ user: user(), documents: [doc("SCAN", "VERIFIED")] });
        assert.equal(withScan[16], "VERIFIED");
        const changed = withScan.map((value, i) => (value === without[i] ? null : SHEET_COLUMNS[i].column)).filter(Boolean);
        assert.deepEqual(changed, ["Q"], "the scan changes the SCAN column only (not the Document Submission stage, which needs more)");
    });

    test("documents of types the candidate pages don't know are ignored", () => {
        const row = map({ user: user(), documents: [doc("AFFIDAVIT", "VERIFIED"), doc("AGREEMENT", "VERIFIED")] });
        assert.deepEqual(row, map({ user: user() }));
    });

    test("candidate fields land in their columns, formatted as specified", () => {
        const stages = [{ stage: "CANDIDATE_DETAILS", completed: false, notes: "Example note" }, { stage: "TEST_DETAILS", completed: false, testDate: new Date("2026-10-03T00:00:00.000Z") }];
        const row = map({ user: user(), stages });
        const expected = {
            B: "SYN000001", C: "TEST GIVEN", D: "TESTSURNAME", E: "2026-10-03", F: "1990-01-01", G: "2030-01-01",
            H: "Job One, Job Two", I: "000000000V", J: "1 Example Road, Example Town", K: "94700000001", L: "94700000002",
            Y: "EXAMPLE TOWN", Z: "M", AA: "EXAMPLE", AB: "2020-01-01", AC: "5 years, example", AD: "Example note",
            AL: "ACTIVE", AM: "2026-10-01T10:30:00Z", AN: "2026-10-07T09:15:30Z", AO: "0042",
        };
        for (const [column, value] of Object.entries(expected)) {
            assert.equal(row[SHEET_COLUMNS.find((c) => c.column === column).index], value, column);
        }
    });

    test("stage statuses: stored stages as saved, automatic stages from the record", () => {
        const complete = [
            doc("PASSPORT"), doc("MEDICAL"), doc("SCAN"),
            doc("POLICE_REPORT", "VERIFIED", { documentVariant: "SL_VERIFIED" }),
            doc("POLICE_REPORT", "REVIEW_REQUIRED", { documentVariant: "ROMANIA" }),
        ];
        const stages = [{ stage: "TEST_DETAILS", completed: true }, { stage: "VISA_SUBMISSION", completed: true }, { stage: "VISA_APPROVAL", completed: true }, { stage: "IVS_INTERVIEW", completed: false }];
        const row = map({ user: user(), stages, documents: complete });
        assert.deepEqual(
            ["testDetailsStatus", "candidateDetailsStatus", "documentSubmissionStatus", "ivsInterviewStatus", "visaSubmissionStatus", "visaApprovalStatus", "finalizingJobStatus"].map((f) => cell(row, f)),
            ["COMPLETED", "COMPLETED", "COMPLETED", "INCOMPLETE", "COMPLETED", "COMPLETED", "INCOMPLETE"],
        );
        // Same rules as the Admin page: the address is optional; the passport dates are required.
        const noAddress = map({ user: user({ address: null }), documents: complete });
        assert.equal(cell(noAddress, "candidateDetailsStatus"), "COMPLETED");
        const noIssueDate = map({ user: user({ passportIssueDate: null }), documents: complete });
        assert.equal(cell(noIssueDate, "candidateDetailsStatus"), "INCOMPLETE");
    });

    test("VISA SUBMISSION STATUS (AI) follows the Visa submission stage only", () => {
        const before = map({ user: user(), stages: [{ stage: "VISA_APPROVAL", completed: true }] });
        const after = map({ user: user(), stages: [{ stage: "VISA_APPROVAL", completed: true }, { stage: "VISA_SUBMISSION", completed: true }] });
        assert.equal(cell(before, "visaSubmissionStatus"), "INCOMPLETE");
        assert.equal(atColumn(after, "AI"), "COMPLETED");
        const changed = after.map((value, i) => (value === before[i] ? null : SHEET_COLUMNS[i].column)).filter(Boolean);
        assert.deepEqual(changed, ["AI"]);
    });

    test("missing optional values are blank and never shift a column", () => {
        const sparse = map({ user: user({ otherName: null, address: null, contactNumber: null, dateOfBirth: null, sex: null, nationality: null, passportIssueDate: null }) });
        const full = map({ user: user() });
        assert.equal(sparse.length, 41);
        for (const field of ["otherName", "address", "contactNumber", "birthday", "sex", "nationality", "passportIssueDate"]) {
            assert.equal(cell(sparse, field), "", field);
        }
        // Everything else is in the same place as for the full candidate.
        for (const field of ["passportNumber", "firstName", "idNumber", "whatsappNumber", "job", "registeredAt", "lastMirroredAt", "systemCandidateId"]) {
            assert.equal(cell(sparse, field), cell(full, field), field);
        }
        assert.ok(sparse.every((value) => value !== "null" && value !== "undefined"));
    });

    test("deterministic: same input, same row; mirroredAt is required", () => {
        const aggregate = { user: user(), documents: [doc("PASSPORT")] };
        assert.deepEqual(map(aggregate), map(aggregate));
        assert.throws(() => mapCandidateToSheetRow(aggregate), SheetMappingError);
        assert.throws(() => mapCandidateToSheetRow(aggregate, { mirroredAt: "not a date" }), SheetMappingError);
    });

    test("record status defaults to ACTIVE; only known statuses are accepted", () => {
        assert.equal(cell(map({ user: user() }), "recordStatus"), RECORD_STATUS.ACTIVE);
        assert.equal(cell(map({ user: user() }, { recordStatus: RECORD_STATUS.DELETED_INACTIVE }), "recordStatus"), "DELETED / INACTIVE");
        assert.throws(() => map({ user: user() }, { recordStatus: "GONE" }), SheetMappingError);
    });

    test("the input aggregate is not modified", () => {
        const aggregate = { user: user(), stages: [{ stage: "TEST_DETAILS", completed: true }], documents: [doc("PASSPORT")] };
        const before = structuredClone(aggregate);
        map(aggregate);
        assert.deepEqual(aggregate, before);
    });
});
