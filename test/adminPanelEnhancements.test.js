// Admin Panel enhancements: Candidate Form conflict indicator data (GET /candidates formConflicts),
// Work Allocation filters, and the candidate passport number rule. Real PostgreSQL (PGlite, every
// migration applied), the real Prisma client and the real admin router. Synthetic data only.
// (Multiple job assignments are covered in jobManagement.test.js, jobHandlerRole.test.js and
// jobManagementEnhancements.test.js.)
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { CANDIDATE_PASSPORT_PATTERN, parseCandidatePassportNumber } from "../src/utils/passportId.js";
import { parseCandidateBody } from "../src/services/candidateService.js";
import { parseAllocationListQuery } from "../src/services/workAllocationService.js";

const ROLES = ["ADMIN", "MANAGER", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"];
const user = (role, n) => ({ adminId: `u-${role.toLowerCase()}`, role, name: `${role} user`, email: `${role.toLowerCase()}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, status: "ACTIVE" });
const USERS = Object.fromEntries(ROLES.map((role, n) => [role, user(role, n + 1)]));

let database;
let prisma;
let pg;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const u of Object.values(USERS)) await prisma.user.create({ data: u });
});
after(async () => database?.close());
beforeEach(async () => {
    await pg.exec(`
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        ALTER TABLE "candidate_form_response" DISABLE TRIGGER USER; DELETE FROM "candidate_form_response"; ALTER TABLE "candidate_form_response" ENABLE TRIGGER USER;
        ALTER TABLE "candidate_form_field_review" DISABLE TRIGGER USER; DELETE FROM "candidate_form_field_review"; ALTER TABLE "candidate_form_field_review" ENABLE TRIGGER USER;
        DELETE FROM "candidate_form_sheet_sync"; DELETE FROM "candidate_form_access";
        DELETE FROM "candidate_allocation"; DELETE FROM "candidate_additional_details"; DELETE FROM "documents"; DELETE FROM "candidate_stages";
        DELETE FROM "job_candidate"; DELETE FROM "job"; DELETE FROM "candidate";
    `);
});

function app() {
    const server = express();
    server.use(express.json());
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: req.headers["x-test-user"] }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
        next();
    };
    server.use("/api/admin", createAdminRouter({ db: prisma, bucket: {}, requireAdmin, apiLimiter: noRateLimit }));
    server.use(errorHandler);
    return server;
}
async function api(who, method, path, body) {
    const listener = await new Promise((resolve) => { const s = app().listen(0, "127.0.0.1", () => resolve(s)); });
    try {
        const res = await fetch(`http://127.0.0.1:${listener.address().port}/api/admin${path}`, {
            method, headers: { "x-test-user": who.adminId, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    } finally {
        listener.close();
    }
}

// A candidate with a record, and (optionally) a Candidate Form submission.
const A = { passportId: "N1000001", uniqueId: "8001", firstName: "ANUSHA", otherName: "DE SOYSA", placeOfBirth: "NEGOMBO", address: "12 GALLE ROAD", contactNumber: "0771234567", jobExperience: "5 YEARS", dateOfBirth: new Date("1990-05-01") };
const submit = (passportId, values) => prisma.candidateFormResponse.create({ data: { passportId, submittedAt: new Date(), ...values } });
const listItem = async (who, passportId) => (await api(who, "GET", `/candidates?search=${passportId}`)).body.items.find((item) => item.passportId === passportId);
const review = (who, action, passportId, field, current, submitted) => api(who, "POST", `/candidates/${passportId}/form-submission/${action}`, { field, expectedCurrentValue: current, expectedSubmittedValue: submitted });

describe("Candidate Form conflict indicator (GET /candidates formConflicts)", () => {
    test("CONFLICT-001: no submission, or a submission identical to the record, has no conflict", async () => {
        await prisma.candidate.create({ data: A });
        assert.deepEqual((await listItem(USERS.ADMIN, A.passportId)).formConflicts, []);
        await submit(A.passportId, { surname: "DE SOYSA", otherNames: "ANUSHA", birthPlace: "NEGOMBO", address: "12 GALLE ROAD", birthDate: new Date("1990-05-01") });
        assert.deepEqual((await listItem(USERS.ADMIN, A.passportId)).formConflicts, []);
    });

    test("CONFLICT-002: a real change to a mapped field is a conflict, and it is the same as the candidate page's pending list", async () => {
        await prisma.candidate.create({ data: A });
        await submit(A.passportId, { birthPlace: "KANDY" });
        assert.deepEqual((await listItem(USERS.ADMIN, A.passportId)).formConflicts, ["basic.birthPlace"]);
        const page = await api(USERS.ADMIN, "GET", `/candidates/${A.passportId}/form-submission`);
        assert.deepEqual(page.body.pending.map((p) => p.field), ["basic.birthPlace"]);
    });

    test("CONFLICT-003: normalised equivalents are not conflicts: case, surrounding spaces, phone formats, N/A, empty answers, unmapped fields", async () => {
        await prisma.candidate.create({ data: A });
        await submit(A.passportId, {
            birthPlace: "  negombo ", address: "12 galle road", contactNumber: undefined, alternativePhone: "+94771234567",
            otherNames: "N/A", experience: null, guardianName: "n/a", email: "   ", fatherSurname: "PERERA",
        });
        assert.deepEqual((await listItem(USERS.ADMIN, A.passportId)).formConflicts, []);
    });

    test("CONFLICT-004: several conflicts are all listed (record and Additional details fields)", async () => {
        await prisma.candidate.create({ data: A });
        await prisma.candidateAdditionalDetails.create({ data: { passportId: A.passportId, shoeSize: "8" } });
        await submit(A.passportId, { birthPlace: "KANDY", address: "1 NEW ROAD", shoeSize: "9", fullName: "ANUSHA DE SOYSA" });
        assert.deepEqual((await listItem(USERS.ADMIN, A.passportId)).formConflicts.sort(), ["basic.birthPlace", "basic.fullName", "contact.address", "measurements.shoeSize"]);
    });

    test("CONFLICT-005 / 006: confirming one leaves the others; rejecting the rest clears the indicator (nothing is stored about it)", async () => {
        await prisma.candidate.create({ data: A });
        await submit(A.passportId, { birthPlace: "KANDY", address: "1 NEW ROAD" });
        assert.equal((await review(USERS.MANAGER, "confirm-field", A.passportId, "basic.birthPlace", "NEGOMBO", "KANDY")).status, 200);
        assert.deepEqual((await listItem(USERS.ADMIN, A.passportId)).formConflicts, ["contact.address"], "partial resolution leaves the rest");
        assert.equal((await prisma.candidate.findUnique({ where: { passportId: A.passportId } })).placeOfBirth, "KANDY");
        assert.equal((await review(USERS.ADMIN, "reject-field", A.passportId, "contact.address", "12 GALLE ROAD", "1 NEW ROAD")).status, 200);
        assert.deepEqual((await listItem(USERS.ADMIN, A.passportId)).formConflicts, [], "all resolved");
        assert.equal((await prisma.candidate.findUnique({ where: { passportId: A.passportId } })).address, "12 GALLE ROAD", "a rejection leaves the record");
        assert.ok(!Object.keys(await prisma.candidate.findUnique({ where: { passportId: A.passportId } })).some((key) => /conflict/i.test(key)), "no stored flag");
    });

    test("CONFLICT-007: an admin editing the record to the submitted value also resolves it", async () => {
        await prisma.candidate.create({ data: A });
        await submit(A.passportId, { birthPlace: "KANDY" });
        await prisma.candidate.update({ where: { passportId: A.passportId }, data: { placeOfBirth: "kandy" } });
        assert.deepEqual((await listItem(USERS.ADMIN, A.passportId)).formConflicts, []);
    });

    test("CONFLICT-008 RBAC: only ADMIN and MANAGER may confirm or reject; JOB_HANDLER, ANALYST and REGISTRATION_DESK get 403 and nothing changes", async () => {
        await prisma.candidate.create({ data: A });
        await prisma.candidateAllocation.create({ data: { passportId: A.passportId, analystId: USERS.ANALYST.adminId } });
        await submit(A.passportId, { birthPlace: "KANDY" });
        for (const role of ["JOB_HANDLER", "ANALYST", "REGISTRATION_DESK"]) {
            for (const action of ["confirm-field", "reject-field"]) {
                assert.equal((await review(USERS[role], action, A.passportId, "basic.birthPlace", "NEGOMBO", "KANDY")).status, 403, `${role} ${action}`);
            }
        }
        assert.equal(await prisma.candidateFormFieldReview.count(), 0);
        assert.equal((await prisma.candidate.findUnique({ where: { passportId: A.passportId } })).placeOfBirth, "NEGOMBO");
        // Reading the indicator follows the existing read rules (JOB_HANDLER reads candidates; an ANALYST their own).
        assert.deepEqual((await listItem(USERS.JOB_HANDLER, A.passportId)).formConflicts, ["basic.birthPlace"]);
        assert.deepEqual((await listItem(USERS.ANALYST, A.passportId)).formConflicts, ["basic.birthPlace"]);
    });

    test("CONFLICT-009: only the listed page's candidates are looked at, and other candidates' data never leaks into an item", async () => {
        await prisma.candidate.createMany({ data: [A, { passportId: "N2000002", uniqueId: "8002", firstName: "KAMAL", otherName: "PERERA", placeOfBirth: "GALLE" }] });
        await submit("N2000002", { birthPlace: "MATARA" });
        const items = (await api(USERS.ADMIN, "GET", "/candidates")).body.items;
        assert.deepEqual(Object.fromEntries(items.map((item) => [item.passportId, item.formConflicts])), { N1000001: [], N2000002: ["basic.birthPlace"] });
    });
});

// ---------------------------------------------------------------- Work Allocation filters

const day = (ymd, hour = 4) => new Date(`${ymd}T${String(hour).padStart(2, "0")}:00:00.000Z`);
async function seedAllocationCandidates() {
    const rows = [
        // passportId, uniqueId, job types, registered (UTC; Sri Lanka is UTC+5:30)
        ["N0000001", "9001", "WELDER TIG, PLUMBER", day("2026-10-01")],
        ["N0000002", "9002", "PLUMBER", day("2026-10-05")],
        ["N0000003", "9003", "WELDER TIG", day("2026-10-10")],
        ["N0000004", "9004", "ELECTRICIAN", day("2026-10-15")],
        // 23:00 UTC on Oct 15 = Oct 16, 04:30 in Sri Lanka.
        ["N0000005", "9005", "WELDER", new Date("2026-10-15T23:00:00.000Z")],
    ];
    await prisma.candidate.createMany({ data: rows.map(([passportId, uniqueId, job, createdDate]) => ({ passportId, uniqueId, firstName: `F${uniqueId}`, otherName: `S${uniqueId}`, job, createdDate })) });
    // N0000002: test FAIL (Stopped with Test). N0000003: test PASS, completed (current stage = Job details) and on a job.
    await prisma.candidateStage.createMany({ data: [
        { passportId: "N0000002", stage: "TEST_DETAILS", testResult: "FAIL", completed: true, completedAt: new Date() },
        { passportId: "N0000003", stage: "TEST_DETAILS", testResult: "PASS", completed: true, completedAt: new Date() },
    ] });
    return rows.map((row) => row[0]);
}
const allocation = async (query = "") => (await api(USERS.MANAGER, "GET", `/work-allocation/candidates${query}`)).body;
const ids = (body) => body.items.map((item) => item.passportId);

describe("Work Allocation filters (server-side, before paging)", () => {
    test("WA-001: Unallocated means no Analyst allocation; jobs (one, several, finished, removed) never change it", async () => {
        await seedAllocationCandidates();
        await prisma.candidateAllocation.create({ data: { passportId: "N0000004", analystId: USERS.ANALYST.adminId } });
        const agent = await prisma.agent.create({ data: { name: "Agent", countryCode: "RO" } });
        const client = await prisma.client.create({ data: { name: "Client", agentLinks: { create: { agentId: agent.id } } } });
        const type = await prisma.jobType.findFirst({ where: { isActive: true } });
        const job = (code, status = "PROCESSING") => prisma.job.create({ data: { jobCode: code, jobTypeId: type.id, clientId: client.id, responsibleAgentId: agent.id, countryCode: "RO", status, createdById: USERS.ADMIN.adminId } });
        const [j1, j2, j3] = [await job("JOB-2026-900001"), await job("JOB-2026-900002"), await job("JOB-2026-900003")];
        await prisma.jobCandidate.createMany({ data: [
            { jobId: j1.id, passportId: "N0000003", assignedBy: USERS.ADMIN.adminId },
            { jobId: j2.id, passportId: "N0000003", assignedBy: USERS.ADMIN.adminId },
            { jobId: j3.id, passportId: "N0000001", assignedBy: USERS.ADMIN.adminId, isActive: false, releasedAt: new Date() },
        ] });
        const body = await allocation();
        assert.deepEqual(ids(body).sort(), ["N0000001", "N0000002", "N0000003", "N0000005"], "two active jobs, a removed job: all still unallocated; the allocated one is not");
        assert.equal(body.pagination.total, 4);
        assert.deepEqual(ids(await allocation("?status=ALLOCATED")), ["N0000004"]);
    });

    test("WA-002: registration date range uses whole Sri Lanka calendar days, inclusive", async () => {
        await seedAllocationCandidates();
        assert.deepEqual(ids(await allocation("?registeredFrom=2026-10-05&registeredTo=2026-10-10")), ["N0000003", "N0000002"]);
        assert.deepEqual(ids(await allocation("?registeredFrom=2026-10-16")), ["N0000005"], "registered at 04:30 on Oct 16 in Sri Lanka");
        assert.deepEqual(ids(await allocation("?registeredTo=2026-10-15")).sort(), ["N0000001", "N0000002", "N0000003", "N0000004"]);
        assert.deepEqual(ids(await allocation("?registeredFrom=2026-10-15&registeredTo=2026-10-15")), ["N0000004"]);
    });

    test("WA-003: job type matches one of the candidate's job types exactly (any case), never a substring", async () => {
        await seedAllocationCandidates();
        assert.deepEqual(ids(await allocation("?jobType=welder%20tig")).sort(), ["N0000001", "N0000003"]);
        assert.deepEqual(ids(await allocation("?jobType=WELDER")), ["N0000005"], "WELDER is not WELDER TIG");
        assert.deepEqual(ids(await allocation("?jobType=PLUMBER")).sort(), ["N0000001", "N0000002"]);
    });

    test("WA-004: Status and current stage filters use the Candidates list's own derivation", async () => {
        await seedAllocationCandidates();
        assert.deepEqual(ids(await allocation("?workflowStatus=STOPPED_WITH_TEST")), ["N0000002"]);
        assert.deepEqual(ids(await allocation("?workflowStatus=REGISTERED")).sort(), ["N0000001", "N0000003", "N0000004", "N0000005"]);
        assert.deepEqual(ids(await allocation("?stage=JOB_DETAILS")).sort(), ["N0000002", "N0000003"], "test details completed: the current stage is Job details");
        assert.deepEqual(ids(await allocation("?stage=TEST_DETAILS")).sort(), ["N0000001", "N0000004", "N0000005"]);
        assert.deepEqual(ids(await allocation("?stage=COMPLETE")), []);
        const item = (await allocation("?workflowStatus=STOPPED_WITH_TEST")).items[0];
        assert.deepEqual(item.workflowStatus, { code: "STOPPED_WITH_TEST", label: "Stopped with Test" });
    });

    test("WA-005: filters combine (with search and the view too)", async () => {
        await seedAllocationCandidates();
        assert.deepEqual(ids(await allocation("?jobType=PLUMBER&workflowStatus=REGISTERED")), ["N0000001"]);
        assert.deepEqual(ids(await allocation("?jobType=WELDER%20TIG&stage=JOB_DETAILS&registeredFrom=2026-10-06")), ["N0000003"]);
        assert.deepEqual(ids(await allocation("?jobType=PLUMBER&search=N0000002")), ["N0000002"]);
        assert.deepEqual(ids(await allocation("?jobType=PLUMBER&status=ALLOCATED")), []);
        // Reset: no filters -> everything again.
        assert.equal((await allocation()).pagination.total, 5);
    });

    test("WA-006: pagination stays globally correct with derived filters: totals and pages cover the whole filtered list", async () => {
        const many = Array.from({ length: 230 }, (_, i) => ({
            passportId: `P${String(i).padStart(7, "0")}`, uniqueId: `7${String(i).padStart(4, "0")}`, firstName: `F${i}`, otherName: `S${i}`,
            job: i % 2 ? "PLUMBER" : "TILER", createdDate: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000),
        }));
        await prisma.candidate.createMany({ data: many });
        const first = await allocation("?jobType=PLUMBER");
        assert.deepEqual([first.pagination.total, first.pagination.totalPages, first.items.length], [115, 2, 100]);
        const second = await allocation("?jobType=PLUMBER&page=2");
        assert.equal(second.items.length, 15);
        const all = [...ids(first), ...ids(second)];
        assert.equal(new Set(all).size, 115, "no candidate on two pages, none skipped");
        assert.ok(all.every((id) => Number(id.slice(1)) % 2 === 1));
        // Newest registered first, across both pages.
        const dates = [...first.items, ...second.items].map((item) => item.registeredDate);
        assert.deepEqual(dates, [...dates].sort().reverse());
        assert.equal((await allocation("?jobType=PLUMBER&page=3")).items.length, 0);
    });

    test("WA-007: invalid filters are refused with 400; filters are echoed back", async () => {
        for (const query of ["registeredFrom=2026-13-01", "registeredTo=yesterday", "registeredFrom=2026-10-10&registeredTo=2026-10-01", "workflowStatus=NOPE", "stage=NOPE", `jobType=${"x".repeat(121)}`]) {
            assert.equal((await api(USERS.MANAGER, "GET", `/work-allocation/candidates?${query}`)).status, 400, query);
        }
        const parsed = parseAllocationListQuery({ registeredFrom: "2026-10-01", jobType: " PLUMBER ", workflowStatus: "REGISTERED", stage: "COMPLETE" });
        assert.deepEqual([parsed.params.registeredFrom, parsed.params.jobType, parsed.params.workflowStatus, parsed.params.stage], ["2026-10-01", "PLUMBER", "REGISTERED", "COMPLETE"]);
        await seedAllocationCandidates();
        assert.deepEqual((await allocation("?jobType=PLUMBER&stage=TEST_DETAILS")).filters, { status: "UNALLOCATED", analystId: null, search: null, registeredFrom: null, registeredTo: null, jobType: "PLUMBER", workflowStatus: null, stage: "TEST_DETAILS" });
    });

    test("WA-008 RBAC: still ADMIN and MANAGER only", async () => {
        for (const role of ["ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]) {
            assert.equal((await api(USERS[role], "GET", "/work-allocation/candidates?jobType=PLUMBER")).status, 403, role);
        }
        assert.equal((await api(USERS.ADMIN, "GET", "/work-allocation/candidates?jobType=PLUMBER")).status, 200);
    });
});

// ---------------------------------------------------------------- passport number rule

const REGISTRATION = {
    surname: "De Soysa", otherNames: "Anusha", nic: "965404378V", address: "Negombo", dateOfBirth: "1996-02-23",
    whatsappNumber: "+94771234567", jobTypes: ["Caregiver"], jobExperience: "2 years", passportIssueDate: "2020-01-15", passportExpiryDate: "2030-01-14",
};

describe("Candidate passport number: P or N + 7 digits", () => {
    test("PASSPORT-001: the rule itself", () => {
        for (const valid of ["P1234567", "N1234567"]) assert.equal(parseCandidatePassportNumber(valid), valid);
        assert.equal(parseCandidatePassportNumber("p1234567"), "P1234567", "lowercase is normalised");
        assert.equal(parseCandidatePassportNumber(" n7654321 "), "N7654321", "surrounding spaces are trimmed");
        for (const invalid of ["PN1234567", "NP1234567", "A1234567", "P123456", "P12345678", "P1234ABC", "P 1234567", "12345678", "", "P-1234567", "P1234567!", null, undefined, 1234567]) {
            assert.equal(parseCandidatePassportNumber(invalid), null, String(invalid));
        }
        assert.equal(CANDIDATE_PASSPORT_PATTERN.source, "^[PN][0-9]{7}$");
    });

    test("PASSPORT-002: registration accepts valid numbers (lowercase stored in capitals) and refuses everything else with 400", async () => {
        await prisma.jobType.upsert({ where: { code: "CAREGIVER" }, create: { code: "CAREGIVER", name: "Caregiver", isActive: true }, update: { isActive: true } });
        const created = await api(USERS.REGISTRATION_DESK, "POST", "/candidates", { ...REGISTRATION, passportId: "p1234567" });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        assert.ok(await prisma.candidate.findUnique({ where: { passportId: "P1234567" } }));
        for (const invalid of ["PN1234567", "NP1234567", "A1234567", "P123456", "P12345678", "P1234ABC", "P 1234567", "12345678", ""]) {
            const r = await api(USERS.REGISTRATION_DESK, "POST", "/candidates", { ...REGISTRATION, passportId: invalid });
            assert.equal(r.status, 400, invalid);
            assert.ok(r.body.errors.some((e) => e.field === "passportId"), invalid);
        }
        const parsed = parseCandidateBody({ ...REGISTRATION, passportId: "PN1234567" }, { creating: true });
        assert.deepEqual(parsed.errors.find((e) => e.field === "passportId").message, "must start with P or N followed by 7 digits (e.g. P1234567)");
    });

    test("PASSPORT-003: older candidates whose numbers predate the rule still open, update and are found", async () => {
        const legacy = { passportId: "PN12345", uniqueId: "8100", firstName: "OLD", otherName: "RECORD", nic: "965404378V", whatsappNumber: "+94771234567", job: "Caregiver", jobExperience: "2 years", passportIssueDate: new Date("2020-01-15"), passportExpiryDate: new Date("2030-01-14") };
        await prisma.candidate.create({ data: legacy });
        assert.equal((await api(USERS.ADMIN, "GET", "/candidates/PN12345")).status, 200, "lookup");
        assert.equal((await api(USERS.ADMIN, "GET", "/candidates/pn12345")).status, 200, "lookup ignores case");
        assert.deepEqual(ids((await api(USERS.ADMIN, "GET", "/candidates?search=PN12345")).body), ["PN12345"], "search");
        const update = await api(USERS.ADMIN, "PUT", "/candidates/PN12345", { ...REGISTRATION, surname: "Renamed" });
        assert.equal(update.status, 200, JSON.stringify(update.body));
        assert.equal((await prisma.candidate.findUnique({ where: { passportId: "PN12345" } })).otherName, "Renamed", "the update never re-checks the stored number");
    });

    test("PASSPORT-004: unrelated identifiers are not affected (document linking and lookups keep their own permissive rule)", async () => {
        const { parseAssignClientBody } = await import("../src/services/adminCorrectionService.js");
        assert.equal(parseAssignClientBody({ passportId: "pn12345", reason: "Matched by hand" }).passportId, "PN12345");
    });
});
