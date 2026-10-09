// Google Sheet mirror: candidate aggregate -> 41-cell row (candidateSheetMapper.js).
// Pure mapping only: synthetic data, no database, no Google.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { SHEET_COLUMNS } from "../src/services/sheetSchema.js";
import {
    DOCUMENT_NOT_SUBMITTED,
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

    test("TEST NUMBER is always blank; DRIVING LICIAN and POLICE REP FM (no document type) are always \"Not Submitted\"", () => {
        const stages = [{ stage: "TEST_DETAILS", completed: true, jobId: "JOB-0001", testResult: "PASS", testDate: new Date("2026-10-03T00:00:00.000Z") }];
        const documents = [doc("POLICE_REPORT", "VERIFIED", { documentVariant: "SL_VERIFIED" }), doc("POLICE_REPORT", "VERIFIED", { documentVariant: "SL_NORMAL" })];
        const row = map({ user: user(), stages, documents });
        assert.equal(row[0], "", "TEST NUMBER (A)");
        assert.equal(cell(row, "testNumber"), "");
        assert.notEqual(row[0], "JOB-0001", "job_id is never mapped to TEST NUMBER");
        assert.equal(cell(row, "drivingLicence"), "Not Submitted");
        assert.equal(atColumn(row, "R"), "Not Submitted", "DRIVING LICIAN (R)");
        assert.equal(cell(row, "policeReportFm"), "Not Submitted");
        assert.equal(atColumn(row, "W"), "Not Submitted", "POLICE REP FM (W)");
        // Whatever documents exist (including police report variants), R and W never change.
        const empty = map({ user: user() });
        assert.deepEqual([atColumn(empty, "R"), atColumn(empty, "W")], ["Not Submitted", "Not Submitted"]);
        const everything = map({ user: user(), documents: ["PASSPORT", "NIC", "MEDICAL", "SCAN", "SKILL_VIDEO", "POLICE_SLIP", "VISA_SUBMISSION"].map((t) => doc(t)).concat(["SL_VERIFIED", "ROMANIA", "SL_NORMAL"].map((v) => doc("POLICE_REPORT", "VERIFIED", { documentVariant: v })), [doc("DRIVING_LICENCE"), doc("POLICE_REPORT", "VERIFIED", { documentVariant: "FM" })]) });
        assert.deepEqual([atColumn(everything, "R"), atColumn(everything, "W")], ["Not Submitted", "Not Submitted"], "no untracked type or variant is read");
        assert.equal(atColumn(everything, "U"), "", "SUBMIT DATE (U) unchanged: the slip has no submitted date");
    });

    test("police reports: N = SL_VERIFIED, V = SL_NORMAL, O = ROMANIA, each with its own submission date", () => {
        const documents = [
            doc("POLICE_REPORT", "VERIFIED", { documentVariant: "SL_VERIFIED", receivedDate: new Date("2026-10-07T04:00:00.000Z") }),
            doc("POLICE_REPORT", "REVIEW_REQUIRED", { documentVariant: "SL_NORMAL", receivedDate: new Date("2026-10-05T04:00:00.000Z") }),
        ];
        const row = map({ user: user(), documents });
        assert.equal(row[13], "2026-10-07", "first POLICE REP SRI LANKA (N) is SL_VERIFIED");
        assert.equal(row[21], "2026-10-05", "second POLICE REP SRI LANKA (V) is SL_NORMAL");
        assert.equal(row[14], DOCUMENT_NOT_SUBMITTED, "POLICE REP ROMANIA (O): none yet");

        const withRomania = map({ user: user(), documents: [doc("POLICE_REPORT", "VERIFIED", { documentVariant: "ROMANIA", receivedDate: new Date("2026-10-01T04:00:00.000Z") })] });
        assert.equal(withRomania[14], "2026-10-01");
        assert.equal(withRomania[13], DOCUMENT_NOT_SUBMITTED);
        assert.equal(withRomania[21], DOCUMENT_NOT_SUBMITTED);
    });

    test("a police report without a variant fills none of the variant columns", () => {
        const row = map({ user: user(), documents: [doc("POLICE_REPORT", "VERIFIED")] });
        assert.deepEqual([row[13], row[14], row[21]], [DOCUMENT_NOT_SUBMITTED, DOCUMENT_NOT_SUBMITTED, DOCUMENT_NOT_SUBMITTED]);
    });

    test("every document column: the current document's submission date, otherwise exactly \"Not Submitted\"", () => {
        assert.equal(DOCUMENT_NOT_SUBMITTED, "Not Submitted");
        const columns = [
            ["passportCopy", "M", { documentType: "PASSPORT" }],
            ["policeReportSriLankaVerified", "N", { documentType: "POLICE_REPORT", documentVariant: "SL_VERIFIED" }],
            ["policeReportRomania", "O", { documentType: "POLICE_REPORT", documentVariant: "ROMANIA" }],
            ["medical", "P", { documentType: "MEDICAL" }],
            ["scan", "Q", { documentType: "SCAN" }],
            ["nationalId", "S", { documentType: "NIC" }],
            ["policeReportApplied", "T", { documentType: "POLICE_SLIP" }],
            ["policeReportSriLankaNormal", "V", { documentType: "POLICE_REPORT", documentVariant: "SL_NORMAL" }],
            ["videos", "X", { documentType: "SKILL_VIDEO" }],
        ];
        const empty = map({ user: user() });
        for (const [field, column] of columns) {
            assert.equal(cell(empty, field), "Not Submitted", `${column} (${field}) without a document`);
        }
        columns.forEach(([field, column, { documentType, documentVariant = null }], i) => {
            const day = String(i + 1).padStart(2, "0");
            const row = map({ user: user(), documents: [doc(documentType, "VERIFIED", { documentVariant, receivedDate: new Date(`2026-09-${day}T06:00:00.000Z`) })] });
            assert.equal(cell(row, field), `2026-09-${day}`, `${column} (${field}) with a document`);
            assert.equal(atColumn(row, column), `2026-09-${day}`);
        });
    });

    test("one date format everywhere: YYYY-MM-DD, the Sri Lanka calendar date of the submission", () => {
        // 20:00 UTC on 8 October is 01:30 on 9 October in Sri Lanka.
        const late = map({ user: user(), documents: [doc("MEDICAL", "VERIFIED", { receivedDate: new Date("2026-10-08T20:00:00.000Z") })] });
        assert.equal(cell(late, "medical"), "2026-10-09");
        const early = map({ user: user(), documents: [doc("MEDICAL", "VERIFIED", { receivedDate: new Date("2026-10-08T18:00:00.000Z") })] });
        assert.equal(cell(early, "medical"), "2026-10-08", "23:30 in Sri Lanka is still the 8th");
        assert.match(cell(late, "medical"), /^\d{4}-\d{2}-\d{2}$/);
    });

    test("replaced document: the latest submission's date (the old one is SUPERSEDED), by the app's current-document rule", () => {
        const replaced = map({ user: user(), documents: [
            doc("PASSPORT", "SUPERSEDED", { receivedDate: new Date("2026-09-01T05:00:00.000Z") }),
            doc("PASSPORT", "VERIFIED", { receivedDate: new Date("2026-10-08T05:00:00.000Z") }),
        ] });
        assert.equal(cell(replaced, "passportCopy"), "2026-10-08");
        // Only a superseded document left: not submitted.
        const onlySuperseded = map({ user: user(), documents: [doc("NIC", "SUPERSEDED", { receivedDate: new Date("2026-09-01T05:00:00.000Z") })] });
        assert.equal(cell(onlySuperseded, "nationalId"), "Not Submitted");
        // A newer file still waiting for review does not displace the VERIFIED
        // one (the candidate page shows the same document).
        const pendingNewer = map({ user: user(), documents: [
            doc("MEDICAL", "VERIFIED", { receivedDate: new Date("2026-10-01T05:00:00.000Z") }),
            doc("MEDICAL", "REVIEW_REQUIRED", { receivedDate: new Date("2026-10-06T05:00:00.000Z") }),
        ] });
        assert.equal(cell(pendingNewer, "medical"), "2026-10-01");
        // With no VERIFIED one, the newest waiting file is current.
        const onlyPending = map({ user: user(), documents: [
            doc("SKILL_VIDEO", "REVIEW_REQUIRED", { receivedDate: new Date("2026-10-02T05:00:00.000Z") }),
            doc("SKILL_VIDEO", "REVIEW_REQUIRED", { receivedDate: new Date("2026-10-04T05:00:00.000Z") }),
        ] });
        assert.equal(cell(onlyPending, "videos"), "2026-10-04");
    });

    test("SUBMIT DATE (U) is unchanged: the police slip's submitted date, not its upload date", () => {
        const row = map({ user: user(), documents: [doc("POLICE_SLIP", "VERIFIED", { receivedDate: new Date("2026-09-20T05:00:00.000Z"), policeSubmittedDate: new Date("2026-09-15T00:00:00.000Z") })] });
        assert.equal(cell(row, "policeReportApplied"), "2026-09-20", "POLICE REPORT APPLIED (T): the slip's submission date");
        assert.equal(cell(row, "submitDate"), "2026-09-15", "SUBMIT DATE (U)");
    });

    test("a current document without a submission date is never shown with an invented date", () => {
        assert.throws(() => map({ user: user(), documents: [doc("MEDICAL", "VERIFIED", { receivedDate: null })] }), SheetMappingError);
    });

    test("one SCAN: a SCAN document fills Q, and only Q", () => {
        const without = map({ user: user() });
        const withScan = map({ user: user(), documents: [doc("SCAN", "VERIFIED", { receivedDate: new Date("2026-10-08T05:00:00.000Z") })] });
        assert.equal(withScan[16], "2026-10-08");
        assert.equal(without[16], "Not Submitted");
        const changed = withScan.map((value, i) => (value === without[i] ? null : SHEET_COLUMNS[i].column)).filter(Boolean);
        assert.deepEqual(changed, ["Q"], "the scan changes the SCAN column only (not the Document Submission stage, which needs more)");
        assert.equal(SHEET_COLUMNS.filter((c) => /SCAN/i.test(c.header)).length, 1, "exactly one SCAN column");
    });

    test("no Agreement, Affidavit or Contract columns exist", () => {
        assert.equal(SHEET_COLUMNS.length, 41);
        assert.deepEqual(SHEET_COLUMNS.filter((c) => /AGREEMENT|AFFIDAVIT|CONTRACT/i.test(`${c.header} ${c.field}`)), []);
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
