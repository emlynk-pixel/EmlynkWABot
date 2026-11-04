// Bulk candidate import: the process columns of the legacy sheet, end to end on a real PostgreSQL
// (PGlite, every migration): OFFICER -> allocation, the new errors / warnings and their messages,
// VISA STATUS -> stages, Interview -> the Test details stage and the Test ID, COMPANY / AGENT /
// COMPANY NUMBER -> Clients and Agents, re-import idempotency, and the API's roles.
// SYNTHETIC candidates, users, Clients and Agents only.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { authIdFor, fakeVerifyAccessToken, tokenFor } from "./helpers/fakeSupabaseAuth.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createRequireActiveUser } from "../src/middleware/requireActiveUser.js";
import { chunkRows, commitChunk, finishImport, previewImport } from "../src/services/candidateImportService.js";
import { ISSUE_CATALOG, describeIssues } from "../src/services/candidateImportIssues.js";
import { normalizeTestResult, normalizeVisaStatus } from "../src/services/candidateImportNormalizers.js";
import { formatTestId } from "../src/services/testId.js";
import { WORKFLOW_STATUS_SELECT, candidateWorkflowStatuses, updateStage } from "../src/services/candidateService.js";
import { createJob } from "../src/services/jobService.js";
import { listAllocationAnalysts, listAllocationCandidates, unassignCandidates } from "../src/services/workAllocationService.js";

const ADMIN = { adminId: "admin-ADMIN", role: "ADMIN", name: "ADMIN" };
// id -> [name, role, status]. First names: john (one active Analyst), mary (an Admin), owen (the
// Owner), kamal (inactive only), nimal (two active users), tara (a Team Lead).
const USERS = {
    "admin-ADMIN": ["Admin User", "ADMIN", "ACTIVE"],
    "admin-OWNER": ["Owen Owner", "OWNER", "ACTIVE"],
    "u-john": ["John Silva", "ANALYST", "ACTIVE"],
    "u-mary": ["Mary Perera", "ADMIN", "ACTIVE"],
    "u-kamal": ["Kamal Inactive", "ANALYST", "INACTIVE"],
    "u-nimal1": ["Nimal One", "ANALYST", "ACTIVE"],
    "u-nimal2": ["nimal Two", "TEAM_LEAD", "ACTIVE"],
    "u-tara": ["Tara Lead", "TEAM_LEAD", "ACTIVE"],
    "admin-ANALYST": ["Ann Analyst", "ANALYST", "ACTIVE"],
    "admin-TEAM_LEAD": ["Tim Lead", "TEAM_LEAD", "ACTIVE"],
    "admin-REGISTRATION_DESK": ["Rita Desk", "REGISTRATION_DESK", "ACTIVE"],
    "admin-JOB_HANDLER": ["Jay Handler", "JOB_HANDLER", "ACTIVE"],
};
const HEADERS = ["PASSPORT NUMBER", "SURNAME", "OTHER NAME", "NIC NUMBER", "WHATSAPP NUMBER", "JOB ROLE", "OFFICER", "VISA STATUS",
    "INTERVIEW DATE", "INTERVIEW PASS FAIL", "COMPANY", "COMPANY NUMBER", "AGENT"];
const TODAY = new Date("2026-11-04T06:00:00Z");

let database;
let prisma;
let pg;
let server;
let baseUrl;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const [adminId, [name, role, status]] of Object.entries(USERS)) {
        await prisma.user.create({ data: { adminId, authUserId: authIdFor(adminId), name, email: `${adminId}@example.invalid`, role, status } });
    }
    await prisma.jobType.upsert({ where: { code: "PLASTER" }, create: { code: "PLASTER", name: "PLASTER" }, update: {} }).catch(() => null);
    const app = express();
    app.use("/api/admin", createAdminRouter({ db: prisma, requireAdmin: createRequireActiveUser({ db: prisma, verifyAccessToken: fakeVerifyAccessToken }), apiLimiter: (req, res, next) => next() }));
    app.use((error, req, res, next) => res.status(500).json({ message: "Internal server error" })); // eslint-disable-line no-unused-vars
    await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await database?.close();
});
beforeEach(async () => {
    await pg.exec(`
        DELETE FROM "candidate_import"; DELETE FROM "candidate_allocation"; DELETE FROM "candidate_verification"; DELETE FROM "candidate_additional_details";
        DELETE FROM "job_candidate"; DELETE FROM "job_job_type"; DELETE FROM "job"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
        DELETE FROM "agent_client"; DELETE FROM "client"; DELETE FROM "agent"; DELETE FROM "sheet_sync_queue"; DELETE FROM "sheet_sync_runs";
    `);
});

const pad = (n, width) => String(n).padStart(width, "0");
const passportOf = (i) => `N8${pad(i, 6)}`;
function row(i, overrides = {}) {
    return {
        rowNumber: i + 1,
        values: {
            "PASSPORT NUMBER": passportOf(i), SURNAME: `SYNTHSURNAME${i}`, "OTHER NAME": `SYNTH GIVEN ${i}`, "NIC NUMBER": `${700000000 + i}V`,
            "WHATSAPP NUMBER": `076${pad(i, 7)}`, "JOB ROLE": "Plaster", OFFICER: "John", "VISA STATUS": "", "INTERVIEW DATE": "", "INTERVIEW PASS FAIL": "",
            COMPANY: "", "COMPANY NUMBER": "", AGENT: "",
            ...overrides,
        },
    };
}
const renumber = (rows) => rows.map((r, k) => ({ ...r, rowNumber: k + 2 }));
const preview = (rows) => previewImport({ db: prisma, actor: ADMIN, fileName: "legacy.xlsx", headers: HEADERS, rows, now: TODAY });
async function importRows(rows) {
    const p = await preview(rows);
    const chunks = [];
    for (const [index, chunk] of chunkRows(rows, p.chunkSize).entries()) chunks.push(await commitChunk({ db: prisma, actor: ADMIN, importId: p.importId, chunkIndex: index, rows: chunk, now: TODAY }));
    const finished = await finishImport({ db: prisma, actor: ADMIN, importId: p.importId });
    return { preview: p, chunks, finished };
}
const issuesOf = (p, rowNumber) => p.rowIssues.find((r) => r.rowNumber === rowNumber) ?? { errors: [], warnings: [] };
const allocationOf = async (i) => (await prisma.candidateAllocation.findUnique({ where: { passportId: passportOf(i) } }))?.analystId ?? null;
const statusOf = async (i) => {
    const users = await prisma.candidate.findMany({ where: { passportId: passportOf(i) }, select: WORKFLOW_STATUS_SELECT });
    return (await candidateWorkflowStatuses(prisma, users)).get(passportOf(i)).code;
};
const stageOf = (i, stage) => prisma.candidateStage.findUnique({ where: { passportId_stage: { passportId: passportOf(i), stage } } });

// ---------------------------------------------------------------- OFFICER

describe("OFFICER -> automatic allocation", () => {
    test("1-3. matched by first name, case-insensitively and with spaces trimmed; the candidate is assigned", async () => {
        const rows = renumber([row(1, { OFFICER: "John" }), row(2, { OFFICER: "  jOHN   " }), row(3, { OFFICER: "john Silva" })]);
        const { preview: p, chunks } = await importRows(rows);
        assert.equal(p.summary.allocations, 3);
        assert.deepEqual(p.actions.officers, [{ sheetName: "John", userName: "John Silva", rows: 3 }]);
        assert.equal(chunks[0].counts.allocated, 3);
        for (const i of [1, 2, 3]) assert.equal(await allocationOf(i), "u-john");
        const audits = await prisma.auditLog.findMany({ where: { action: "ASSIGN_CANDIDATE", passportId: { in: [1, 2, 3].map(passportOf) } } });
        assert.equal(audits.length, 3, "the allocation history is written like a manual allocation");
    });

    test("any active role can be the officer (Admin, Owner, Team Lead)", async () => {
        await importRows(renumber([row(1, { OFFICER: "Mary" }), row(2, { OFFICER: "Owen" }), row(3, { OFFICER: "Tara" })]));
        assert.deepEqual([await allocationOf(1), await allocationOf(2), await allocationOf(3)], ["u-mary", "admin-OWNER", "u-tara"]);
    });

    test("4-6. unmatched, ambiguous and inactive officers are ERRORS: the row is not imported, nobody is guessed", async () => {
        const rows = renumber([row(1, { OFFICER: "Nobody" }), row(2, { OFFICER: "Nimal" }), row(3, { OFFICER: "Kamal" }), row(4, { OFFICER: "" })]);
        const { preview: p, chunks } = await importRows(rows);
        assert.deepEqual(issuesOf(p, 2).errors, ["Officer does not match a system user"]);
        assert.deepEqual(issuesOf(p, 3).errors, ["Officer matches more than one active user with that first name"]);
        assert.deepEqual(issuesOf(p, 4).errors, ["Officer matches a user who is not active"]);
        assert.deepEqual(issuesOf(p, 5), { rowNumber: 5, errors: [], warnings: ["Officer is missing: the candidate is not assigned"] });
        assert.equal(p.summary.invalid, 3);
        assert.equal(chunks[0].counts.created, 1, "only the blank-officer row is imported (unassigned)");
        assert.equal(await prisma.candidateAllocation.count(), 0);
    });

    test("7/8. an existing candidate keeps its allocation (fill-only); a repeated import adds no allocation and no audit", async () => {
        await importRows(renumber([row(71, { OFFICER: "John" })]));
        const audits = () => prisma.auditLog.count({ where: { action: { in: ["ASSIGN_CANDIDATE", "REASSIGN_CANDIDATE"] }, passportId: passportOf(71) } });
        assert.equal(await audits(), 1);
        const again = await importRows(renumber([row(71, { OFFICER: "John" })]));
        assert.equal(again.preview.summary.noChange, 1);
        assert.equal(again.chunks[0].counts.allocated, 0);
        assert.equal(await audits(), 1);
        const other = await importRows(renumber([row(71, { OFFICER: "Mary" })]));
        assert.deepEqual(issuesOf(other.preview, 2).warnings, ["Candidate is already assigned to another user: not reassigned"]);
        assert.equal(await allocationOf(71), "u-john");
    });

    test("an officer deactivated after the preview: the row fails at commit, nothing is assigned to them", async () => {
        const rows = renumber([row(1, { OFFICER: "Tara" })]);
        const p = await preview(rows);
        await prisma.user.update({ where: { adminId: "u-tara" }, data: { status: "INACTIVE" } });
        try {
            const result = await commitChunk({ db: prisma, actor: ADMIN, importId: p.importId, chunkIndex: 0, rows, now: TODAY });
            assert.equal(result.counts.invalid, 1, "re-checked at commit: now not active");
            assert.equal(await prisma.candidate.count(), 0);
        } finally {
            await prisma.user.update({ where: { adminId: "u-tara" }, data: { status: "ACTIVE" } });
        }
    });

    test("Work Allocation lists a candidate held by a non-Analyst officer and can unassign it", async () => {
        await importRows(renumber([row(1, { OFFICER: "Mary" })]));
        const list = await listAllocationCandidates({ db: prisma, params: { page: 1, pageSize: 100, status: "ALLOCATED" } });
        assert.deepEqual(list.items.map((item) => [item.passportId, item.analyst.name, item.analyst.active]), [[passportOf(1), "Mary Perera", false]]);
        const analysts = await listAllocationAnalysts({ db: prisma });
        assert.deepEqual(analysts.unavailableAnalysts.map((a) => [a.name, a.assignedCount]), [["Mary Perera", 1]]);
        await unassignCandidates({ db: prisma, actor: ADMIN, candidateIds: [passportOf(1)] });
        assert.equal(await allocationOf(1), null);
    });
});

// ---------------------------------------------------------------- validation

describe("errors and warnings", () => {
    test("9-14. missing passport / job role and Cancelled visa are errors; passport format, missing and invalid NIC are reported", async () => {
        const rows = renumber([
            row(1, { "PASSPORT NUMBER": "" }), row(2, { "JOB ROLE": "" }), row(3, { "VISA STATUS": " cancelled " }),
            row(4, { "PASSPORT NUMBER": "N80000044" }), row(5, { "NIC NUMBER": "" }), row(6, { "NIC NUMBER": "12345" }),
        ]);
        const p = await preview(rows);
        assert.deepEqual(issuesOf(p, 2).errors, ["Passport number is missing"]);
        assert.deepEqual(issuesOf(p, 3).errors, ["Job role is missing"]);
        assert.deepEqual(issuesOf(p, 4).errors, ["Visa status is Cancelled"]);
        assert.deepEqual(issuesOf(p, 5), { rowNumber: 5, errors: [], warnings: ["Passport number is in the old format (8 digits)"] });
        assert.deepEqual(issuesOf(p, 6).warnings, ["NIC number is missing"]);
        assert.deepEqual(issuesOf(p, 7).warnings, ["NIC NUMBER format is invalid"]);
        assert.equal(p.summary.invalid, 3);
        // A passport in no known format stays an ERROR (it is the identity key).
        assert.deepEqual(issuesOf(await preview(renumber([row(1, { "PASSPORT NUMBER": "X12" })])), 2).errors, ["Passport number format is invalid (P or N followed by 7 digits)"]);
    });

    test("25/28. rowIssues and the problems table carry the same messages; no cell value is in them", async () => {
        const rows = renumber([row(1, { "NIC NUMBER": "", OFFICER: "Nobody", "JOB ROLE": "" }), row(2, { "NIC NUMBER": "12345", "WHATSAPP NUMBER": "" })]);
        const p = await preview(rows);
        for (const problem of p.problems) {
            const issues = issuesOf(p, problem.rowNumber);
            assert.deepEqual([problem.errors, problem.warnings], [issues.errors, issues.warnings]);
        }
        assert.deepEqual(issuesOf(p, 2).errors, ["Job role is missing"], "an invalid row stops at its own errors (the officer is not looked up)");
        assert.deepEqual(issuesOf(p, 2).warnings, ["NIC number is missing"]);
        assert.deepEqual(issuesOf(p, 3).warnings, ["NIC NUMBER format is invalid", "WhatsApp number is missing"]);
        const text = JSON.stringify(p.rowIssues);
        for (const secret of [passportOf(1), passportOf(2), "SYNTHSURNAME", "12345", "Nobody"]) assert.ok(!text.includes(secret), secret);
    });

    test("every code the importer emits has a message and a severity; the same message is listed once", () => {
        for (const [code, entry] of Object.entries(ISSUE_CATALOG)) {
            assert.ok(["ERROR", "WARNING"].includes(entry.severity), code);
            assert.ok(entry.message.length > 5, code);
        }
        assert.deepEqual(describeIssues([{ field: "nic", code: "MISSING_NIC" }, { field: "nic", code: "MISSING_NIC" }]), { errors: [], warnings: ["NIC number is missing"] });
        assert.deepEqual(describeIssues([{ field: "dateOfBirth", code: "INVALID_DATE" }]).warnings, ["BIRTH DATE is not a valid date (use DD.MM.YYYY)"]);
    });
});

// ---------------------------------------------------------------- visa

describe("VISA STATUS", () => {
    test("29/30. Submit -> Visa submission completed (VISA SUBMITTED), Departed -> recorded departed (DEPARTED), Finalizing job untouched", async () => {
        assert.deepEqual(normalizeVisaStatus("  submit "), { value: "VISA_SUBMITTED" });
        assert.deepEqual(normalizeVisaStatus("DEPARTED"), { value: "DEPARTED" });
        assert.deepEqual(normalizeVisaStatus("Approved"), { value: null, warning: "UNKNOWN_VISA_STATUS" });
        // Every VISA STATUS value of the sample workbook, as written there.
        assert.deepEqual(normalizeVisaStatus("NOT SUBMIT"), { value: null }, "no visa step yet: nothing to do, nothing to report");
        assert.deepEqual(normalizeVisaStatus(" not submit "), { value: null });
        assert.deepEqual(normalizeVisaStatus("SUBMIT"), { value: "VISA_SUBMITTED" });
        assert.deepEqual(normalizeVisaStatus("CANCELED"), { value: null, error: "VISA_CANCELLED" });
        assert.deepEqual(normalizeVisaStatus("Cancelled"), { value: null, error: "VISA_CANCELLED" });
        assert.deepEqual(normalizeVisaStatus("GOT VISA"), { value: "VISA_APPROVED" });
        assert.deepEqual(normalizeVisaStatus(" reject "), { value: null, error: "VISA_REJECTED" });
        assert.deepEqual(normalizeVisaStatus("GOT VISA NOT GOING"), { value: null, warning: "VISA_NOT_GOING" });
        const { preview: p } = await importRows(renumber([
            row(1, { "VISA STATUS": "Submit" }), row(2, { "VISA STATUS": "departed" }), row(3, { "VISA STATUS": "Pending" }), row(4, { "VISA STATUS": "NOT SUBMIT" }),
        ]));
        assert.ok(!p.rowIssues.some((r) => r.rowNumber === 5), "NOT SUBMIT: no issue at all");
        assert.equal(await stageOf(4, "VISA_SUBMISSION"), null);
        assert.deepEqual(p.actions.visa, { VISA_SUBMITTED: 1, VISA_APPROVED: 0, DEPARTED: 1 });
        assert.equal((await stageOf(1, "VISA_SUBMISSION")).completed, true);
        assert.equal(await stageOf(2, "FINALIZING_JOB"), null, "the Finalizing job stage is not touched");
        assert.ok((await prisma.candidate.findUnique({ where: { passportId: passportOf(2) } })).departedAt instanceof Date);
        assert.equal(await prisma.auditLog.count({ where: { action: "CANDIDATE_DEPARTED", passportId: passportOf(2) } }), 1);
        assert.equal(await stageOf(3, "VISA_SUBMISSION"), null);
        assert.deepEqual(issuesOf(p, 4).warnings, ["Visa status is not one Emlynk maps (Not Submit, Submit, Got Visa, Got Visa Not Going, Departed, Cancelled, Reject): ignored"]);
        assert.equal(await statusOf(1), "VISA_SUBMITTED");
        assert.equal(await statusOf(2), "DEPARTED");
    });

    test("Got Visa completes Visa approval; Reject is an error; Got Visa Not Going is a warning and changes nothing", async () => {
        const { preview: p, chunks } = await importRows(renumber([
            row(41, { "VISA STATUS": "GOT VISA" }), row(42, { "VISA STATUS": "REJECT" }), row(43, { "VISA STATUS": "GOT VISA NOT GOING" }),
        ]));
        assert.equal(p.actions.visa.VISA_APPROVED, 1);
        assert.equal((await stageOf(41, "VISA_APPROVAL")).completed, true);
        assert.equal(await stageOf(41, "VISA_SUBMISSION"), null, "only the approval stage");
        assert.deepEqual(issuesOf(p, 3).errors, ["Visa status is Reject"]);
        assert.equal(await prisma.candidate.count({ where: { passportId: passportOf(42) } }), 0, "a Reject row is not imported");
        assert.deepEqual(issuesOf(p, 4), { rowNumber: 4, errors: [], warnings: ["Visa status is Got Visa Not Going: no stage or status is changed"] });
        assert.equal(await prisma.candidateStage.count({ where: { passportId: passportOf(43) } }), 0);
        assert.equal((await prisma.candidate.findUnique({ where: { passportId: passportOf(43) } })).departedAt, null);
        assert.equal(chunks[0].counts.created, 2);
        // Re-import: the approval stage is already completed, nothing is written again.
        const again = await importRows(renumber([row(41, { "VISA STATUS": "GOT VISA" })]));
        assert.equal(again.preview.summary.noChange, 1);
    });

    test("a completed stage and a recorded departure are never touched again; a re-import changes nothing", async () => {
        await importRows(renumber([row(31, { "VISA STATUS": "Submit" }), row(32, { "VISA STATUS": "Departed" })]));
        const first = await stageOf(31, "VISA_SUBMISSION");
        const departed = (await prisma.candidate.findUnique({ where: { passportId: passportOf(32) } })).departedAt;
        const again = await importRows(renumber([row(31, { "VISA STATUS": "Submit" }), row(32, { "VISA STATUS": "Departed" })]));
        assert.equal(again.preview.summary.noChange, 2);
        assert.deepEqual(await stageOf(31, "VISA_SUBMISSION"), first);
        assert.deepEqual((await prisma.candidate.findUnique({ where: { passportId: passportOf(32) } })).departedAt, departed);
        assert.equal(await prisma.auditLog.count({ where: { action: "CANDIDATE_DEPARTED", passportId: passportOf(32) } }), 1);
    });
});

// ---------------------------------------------------------------- Test

describe("Interview -> Test details", () => {
    test("43-48. Interview Date -> Test date; PASS / FAIL kept; blank, spaces and EMPTY -> PASS", async () => {
        for (const [raw, expected] of [["PASS", "PASS"], [" fail ", "FAIL"], ["", "PASS"], ["   ", "PASS"], ["EMPTY", "PASS"], ["empty", "PASS"]]) {
            assert.equal(normalizeTestResult(raw).value, expected, JSON.stringify(raw));
        }
        assert.deepEqual(normalizeTestResult("Absent"), { value: null, warning: "INVALID_TEST_RESULT" });
        const rows = renumber([
            row(1, { "INTERVIEW DATE": "03.11.2026", "INTERVIEW PASS FAIL": "" }),
            row(2, { "INTERVIEW DATE": "03.11.2026", "INTERVIEW PASS FAIL": "FAIL" }),
            row(3, { "INTERVIEW DATE": "", "INTERVIEW PASS FAIL": "" }),
            row(4, { "INTERVIEW DATE": "2026-11-20", "INTERVIEW PASS FAIL": "" }),
            row(5, { "INTERVIEW DATE": "31.02.2026", "INTERVIEW PASS FAIL": "PASS" }),
        ]);
        const { preview: p } = await importRows(rows);
        assert.equal(p.actions.testsBlankResultAsPass, 1);
        const one = await stageOf(1, "TEST_DETAILS");
        assert.deepEqual([one.testDate.toISOString().slice(0, 10), one.testResult, one.testId, one.completed], ["2026-11-03", "PASS", "T261103", true]);
        assert.deepEqual([(await stageOf(2, "TEST_DETAILS")).testResult, await statusOf(2)], ["FAIL", "STOPPED_WITH_TEST"]);
        assert.equal(await stageOf(3, "TEST_DETAILS"), null, "no date and no result: no test is invented");
        const later = await stageOf(4, "TEST_DETAILS");
        assert.deepEqual([later.testResult, later.testId, later.completed], [null, "T261120", false], "a test scheduled for later has no result yet");
        const invalid = await stageOf(5, "TEST_DETAILS");
        assert.deepEqual([invalid.testDate, invalid.testResult, invalid.testId], [null, "PASS", null]);
        assert.deepEqual(issuesOf(p, 6).warnings, ["INTERVIEW DATE is not a valid date (use DD.MM.YYYY)"]);
    });

    test("49/50. the Test ID is T + YYMMDD, one central generator, shared by a day's session (not unique by design)", async () => {
        assert.equal(formatTestId(new Date("2026-01-05T00:00:00Z")), "T260105");
        assert.equal(formatTestId("2026-12-31"), "T261231");
        assert.equal(formatTestId(null), null);
        await importRows(renumber([row(1, { "INTERVIEW DATE": "02.11.2026" }), row(2, { "INTERVIEW DATE": "02.11.2026" }), row(3, { "INTERVIEW DATE": "01.11.2026" })]));
        assert.deepEqual([(await stageOf(1, "TEST_DETAILS")).testId, (await stageOf(2, "TEST_DETAILS")).testId, (await stageOf(3, "TEST_DETAILS")).testId], ["T261102", "T261102", "T261101"]);
    });

    test("the Test details stage generates the Test ID when saved with a date and no ID; a typed ID is kept", async () => {
        await importRows(renumber([row(1)]));
        await updateStage({ db: prisma, passportId: passportOf(1), stage: "TEST_DETAILS", values: { testDate: new Date("2026-10-10T00:00:00Z") }, actor: ADMIN });
        assert.equal((await stageOf(1, "TEST_DETAILS")).testId, "T261010");
        await updateStage({ db: prisma, passportId: passportOf(1), stage: "TEST_DETAILS", values: { testId: "TYPED-1", testDate: new Date("2026-10-11T00:00:00Z") }, actor: ADMIN });
        assert.equal((await stageOf(1, "TEST_DETAILS")).testId, "TYPED-1");
    });

    test("51. fill-only: an existing Test is never overwritten; a re-import creates nothing", async () => {
        await importRows(renumber([row(1, { "INTERVIEW DATE": "01.11.2026", "INTERVIEW PASS FAIL": "FAIL" })]));
        const first = await stageOf(1, "TEST_DETAILS");
        const same = await importRows(renumber([row(1, { "INTERVIEW DATE": "01.11.2026", "INTERVIEW PASS FAIL": "FAIL" })]));
        assert.equal(same.preview.summary.noChange, 1);
        const other = await importRows(renumber([row(1, { "INTERVIEW DATE": "02.11.2026", "INTERVIEW PASS FAIL": "PASS" })]));
        assert.deepEqual(issuesOf(other.preview, 2).warnings, ["Emlynk already has different test details: not changed"]);
        assert.deepEqual(await stageOf(1, "TEST_DETAILS"), first);
        assert.equal(await prisma.candidateStage.count({ where: { stage: "TEST_DETAILS" } }), 1);
    });
});

// ---------------------------------------------------------------- Client / Agent

describe("COMPANY / AGENT / COMPANY NUMBER", () => {
    const createAgent = (name, countryCode = "RO", isActive = true) => prisma.agent.create({ data: { name, countryCode, isActive } });
    const createClient = async (name, agentId, registrationNumber = null) => {
        const client = await prisma.client.create({ data: { name, registrationNumber } });
        if (agentId) await prisma.agentClient.create({ data: { agentId, clientId: client.id } });
        return client;
    };

    test("33/37/39. a new Company with a new Agent: both created (generated ids, country not set), linked, audited", async () => {
        const { preview: p, chunks } = await importRows(renumber([
            row(1, { COMPANY: "  ABC   Construction Ltd ", AGENT: "XYZ Agency", "COMPANY NUMBER": "PV 1234" }),
            row(2, { COMPANY: "abc construction LTD", AGENT: "xyz agency" }),
        ]));
        assert.deepEqual(p.actions.clients, [{ name: "ABC Construction Ltd", action: "CREATE", rows: 2 }]);
        assert.deepEqual(p.actions.agents, [{ name: "XYZ Agency", action: "CREATE", rows: 2 }]);
        assert.equal(chunks[0].counts.clientsCreated, 1);
        assert.equal(chunks[0].counts.agentsCreated, 1);
        const [client] = await prisma.client.findMany({ include: { agentLinks: { include: { agent: true } } } });
        assert.equal(client.name, "ABC Construction Ltd", "the sheet's name, trimmed");
        assert.equal(client.registrationNumber, "PV 1234");
        assert.match(client.id, /^[0-9a-f-]{36}$/, "the database generates the id");
        assert.deepEqual(client.agentLinks.map((l) => [l.agent.name, l.agent.countryCode]), [["XYZ Agency", null]]);
        assert.equal(await prisma.auditLog.count({ where: { action: { in: ["CLIENT_CREATED", "AGENT_CREATED"] }, reason: { contains: p.importId } } }), 2);
    });

    test("32/34/36/38. existing Client and Agent are reused, whatever the case and spacing; a re-import duplicates nothing", async () => {
        const agent = await createAgent("XYZ Agency");
        const client = await createClient("ABC Construction Ltd", agent.id);
        const rows = renumber([row(1, { COMPANY: "abc construction ltd", AGENT: "XYZ AGENCY" })]);
        const { preview: p } = await importRows(rows);
        assert.deepEqual(p.actions.clients, [{ name: "ABC Construction Ltd", action: "REUSE", rows: 1 }]);
        assert.deepEqual(p.actions.agents, [{ name: "XYZ AGENCY", action: "REUSE", rows: 1 }]);
        await importRows(rows);
        assert.equal(await prisma.client.count(), 1);
        assert.equal(await prisma.agent.count(), 1);
        assert.equal(await prisma.agentClient.count({ where: { clientId: client.id } }), 1);
    });

    test("whitespace: \"ABC Ltd\", \"ABC  Ltd\" and \" abc ltd \" are one Client; a new one keeps the cleaned sheet name", async () => {
        const { preview: p, chunks } = await importRows(renumber([
            row(1, { COMPANY: "ABC  Ltd", AGENT: "Space  Agent" }), row(2, { COMPANY: " abc ltd ", AGENT: "space agent" }), row(3, { COMPANY: "ABC Ltd", AGENT: " SPACE AGENT" }),
        ]));
        assert.deepEqual(p.actions.clients, [{ name: "ABC Ltd", action: "CREATE", rows: 3 }]);
        assert.equal(chunks[0].counts.clientsCreated, 1);
        assert.deepEqual((await prisma.client.findMany()).map((c) => c.name), ["ABC Ltd"], "trimmed, spaces collapsed, the sheet's case");
        assert.deepEqual((await prisma.agent.findMany()).map((a) => a.name), ["Space Agent"]);
    });

    test("whitespace: an existing record saved with extra spaces is found (preview and commit); nothing is duplicated", async () => {
        // Saved directly with the extra spaces an older record could have.
        const agent = await createAgent("  Old   Agent ");
        const client = await createClient("  Spaced   Builders  Ltd ", agent.id);
        const rows = renumber([row(1, { COMPANY: "spaced builders ltd", AGENT: "OLD AGENT" }), row(2, { COMPANY: "Spaced Builders Ltd", AGENT: "Old Agent" })]);
        const { preview: p } = await importRows(rows);
        assert.deepEqual(p.actions.clients.map((c) => c.action), ["REUSE"]);
        assert.deepEqual(p.actions.agents.map((a) => a.action), ["REUSE"]);
        assert.equal(await prisma.client.count(), 1);
        assert.equal(await prisma.agent.count(), 1);
        assert.equal((await prisma.client.findUnique({ where: { id: client.id } })).name, "  Spaced   Builders  Ltd ", "an existing name is never rewritten");
        // A Client created between the preview and the commit, with other spacing, is found at commit too.
        const late = renumber([row(3, { COMPANY: "Late   Co", AGENT: "Old Agent" })]);
        const preview = await previewImport({ db: prisma, actor: ADMIN, fileName: "legacy.xlsx", headers: HEADERS, rows: late, now: TODAY });
        await createClient(" LATE co", agent.id);
        await commitChunk({ db: prisma, actor: ADMIN, importId: preview.importId, chunkIndex: 0, rows: late, now: TODAY });
        assert.equal(await prisma.client.count({ where: { name: { contains: "late", mode: "insensitive" } } }), 1);
    });

    test("a new Agent for an existing Client is created and linked; an existing Agent is linked", async () => {
        const first = await createAgent("First Agent");
        const second = await createAgent("Second Agent", "LK");
        const client = await createClient("ABC Ltd", first.id);
        await importRows(renumber([row(1, { COMPANY: "ABC Ltd", AGENT: "Brand New Agent" }), row(2, { COMPANY: "ABC Ltd", AGENT: "second agent" })]));
        const links = await prisma.agentClient.findMany({ where: { clientId: client.id }, include: { agent: true } });
        assert.deepEqual(links.map((l) => l.agent.name).sort(), ["Brand New Agent", "First Agent", "Second Agent"]);
        assert.ok(links.some((l) => l.agentId === second.id));
    });

    test("no Agent for a new Company, an Agent without a Company, an ambiguous or inactive Agent: warnings, nothing created, the candidate imported", async () => {
        await createAgent("Twin Agent", "RO");
        await createAgent("Twin Agent", "LK");
        await createAgent("Sleepy Agent", "RO", false);
        const { preview: p, chunks } = await importRows(renumber([
            row(1, { COMPANY: "Lonely Co" }), row(2, { AGENT: "Free Agent" }), row(3, { COMPANY: "Twin Co", AGENT: "twin agent" }), row(4, { COMPANY: "Sleepy Co", AGENT: "Sleepy Agent" }),
        ]));
        assert.deepEqual(issuesOf(p, 2).warnings, ["Company is new and has no Agent: the Client is not created"]);
        assert.deepEqual(issuesOf(p, 3).warnings, ["Agent given without a Company: the Agent is not created"]);
        assert.deepEqual(issuesOf(p, 4).warnings, ["Agent name matches agents in more than one country: not linked"]);
        assert.deepEqual(issuesOf(p, 5).warnings, ["Agent is inactive: not linked to the Client"]);
        assert.equal(chunks[0].counts.created, 4);
        assert.equal(await prisma.client.count(), 0);
        assert.equal(await prisma.agent.count(), 3);
    });

    test("40-42. Company Number: saved for a new Client, fills a blank one, a different one is a conflict and never overwritten", async () => {
        const agent = await createAgent("Agent A");
        await createClient("Blank Co", agent.id);
        await createClient("Numbered Co", agent.id, "PV-1");
        await createClient("Cased Co", agent.id, "PV-3");
        const { preview: p } = await importRows(renumber([
            row(1, { COMPANY: "Blank Co", "COMPANY NUMBER": "PV-9" }),
            row(2, { COMPANY: "Numbered Co", "COMPANY NUMBER": "PV-2" }),
            row(3, { COMPANY: "Cased Co", "COMPANY NUMBER": "pv-3" }),
            row(4, { COMPANY: "Split Co", AGENT: "Agent A", "COMPANY NUMBER": "A1" }),
            row(5, { COMPANY: "split co", AGENT: "Agent A", "COMPANY NUMBER": "A2" }),
        ]));
        const number = async (name) => (await prisma.client.findFirst({ where: { name: { equals: name, mode: "insensitive" } } }))?.registrationNumber ?? null;
        assert.equal(await number("Blank Co"), "PV-9");
        assert.equal(await number("Numbered Co"), "PV-1");
        assert.deepEqual(issuesOf(p, 3).warnings, ["Company number differs from the Client's number (in Emlynk or on another row): not changed"]);
        assert.ok(!p.rowIssues.some((r) => r.rowNumber === 4), "the same number in another case is not a conflict");
        assert.equal(await number("Split Co"), null, "two numbers for one Company in the file: neither is written");
        assert.equal(issuesOf(p, 5).warnings.length, 1);
    });

    test("a Job can't be created with an Agent that has no country yet", async () => {
        await importRows(renumber([row(1, { COMPANY: "Jobless Co", AGENT: "Countryless Agent" })]));
        const client = await prisma.client.findFirst();
        const jobType = await prisma.jobType.findFirst();
        await assert.rejects(
            createJob({ db: prisma, actor: ADMIN, values: { clientId: client.id, jobTypeIds: [jobType.id], candidateIds: [] } }),
            (error) => error.code === "AGENT_COUNTRY_MISSING",
        );
    });
});

// ---------------------------------------------------------------- idempotency and transactions

describe("re-import and row atomicity", () => {
    test("19. the same sheet twice: no duplicate candidates, Clients, Agents, Tests, stages, allocations or audits", async () => {
        const rows = renumber([
            row(1, { COMPANY: "Idem Co", AGENT: "Idem Agent", "COMPANY NUMBER": "N-1", "INTERVIEW DATE": "01.11.2026", "VISA STATUS": "Submit" }),
            row(2, { COMPANY: "Idem Co", AGENT: "Idem Agent", OFFICER: "Mary", "INTERVIEW DATE": "01.11.2026", "INTERVIEW PASS FAIL": "FAIL" }),
        ]);
        await importRows(rows);
        const snapshot = async () => ({
            candidates: await prisma.candidate.count(), clients: await prisma.client.count(), agents: await prisma.agent.count(), links: await prisma.agentClient.count(),
            stages: await prisma.candidateStage.count(), allocations: await prisma.candidateAllocation.count(),
            audits: await prisma.auditLog.count({ where: { OR: [{ passportId: { in: [passportOf(1), passportOf(2)] } }, { action: { startsWith: "CLIENT_" } }, { action: { startsWith: "AGENT_" } }] } }),
        });
        const before = await snapshot();
        const again = await importRows(rows);
        assert.equal(again.preview.summary.noChange, 2);
        assert.deepEqual(again.preview.actions.clients, [{ name: "Idem Co", action: "REUSE", rows: 2 }]);
        assert.equal(again.chunks[0].counts.clientsCreated + again.chunks[0].counts.agentsCreated + again.chunks[0].counts.testsSet, 0);
        assert.deepEqual(await snapshot(), before);
    });

    test("18. a row that fails rolls back alone: its Client and Agent are not left behind", async () => {
        const rows = renumber([row(1, { COMPANY: "Orphan Co", AGENT: "Orphan Agent" })]);
        const p = await preview(rows);
        // The passport is taken (with another NIC) between the preview and the commit.
        await prisma.candidate.create({ data: { passportId: passportOf(1), uniqueId: "9999", firstName: "X", nic: "799999999V" } });
        const result = await commitChunk({ db: prisma, actor: ADMIN, importId: p.importId, chunkIndex: 0, rows, now: TODAY });
        assert.equal(result.counts.created, 0);
        assert.equal(await prisma.client.count(), 0);
        assert.equal(await prisma.agent.count(), 0);
    });

    test("verified details: no allocation, Test or stage is written either (SKIPPED_VERIFIED)", async () => {
        await importRows(renumber([row(1, { OFFICER: "" })]));
        await prisma.candidateVerification.create({ data: { passportId: passportOf(1), detailsVerifiedAt: new Date(), detailsVerifiedById: "admin-ADMIN" } });
        const { preview: p } = await importRows(renumber([row(1, { OFFICER: "John", "VISA STATUS": "Submit", "INTERVIEW DATE": "01.11.2026" })]));
        assert.equal(p.summary.skippedVerified, 1);
        assert.equal(await allocationOf(1), null);
        assert.equal(await prisma.candidateStage.count(), 0);
    });
});

// ---------------------------------------------------------------- API

async function call(method, path, adminId, body) {
    const headers = { Accept: "application/json", Authorization: `Bearer ${tokenFor(adminId)}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${baseUrl}/api/admin/settings/sheet-sync${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
}

describe("API: the validation data has the Upload's own roles", () => {
    for (const role of ["ANALYST", "TEAM_LEAD", "REGISTRATION_DESK", "JOB_HANDLER"]) {
        test(`27. ${role}: 403 on the preview (and so on its row issues)`, async () => {
            const result = await call("POST", "/import/preview", `admin-${role}`, { fileName: "legacy.xlsx", headers: HEADERS, rows: renumber([row(1)]) });
            assert.equal(result.status, 403);
            assert.equal(result.body.rowIssues, undefined);
        });
    }

    test("ADMIN and OWNER get rowIssues and actions over HTTP; there is no file endpoint (the sheet is built in the browser)", async () => {
        for (const actor of ["admin-ADMIN", "admin-OWNER"]) {
            const result = await call("POST", "/import/preview", actor, { fileName: "legacy.xlsx", headers: HEADERS, rows: renumber([row(1, { "NIC NUMBER": "" })]) });
            assert.equal(result.status, 200);
            assert.deepEqual(result.body.rowIssues, [{ rowNumber: 2, errors: [], warnings: ["NIC number is missing"] }]);
            assert.ok(result.body.actions);
            assert.equal((await call("GET", `/import/${result.body.importId}/validation-sheet`, actor)).status, 404);
        }
    });
});
