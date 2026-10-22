// Settings > Job Types (the managed list), "No Preferred Type", and the job type
// choices everywhere they are offered (JOB-TYPE-*, DYNAMIC-JOB-TYPE-* server side,
// JOB-ASSIGN-TYPE-*). A REAL PostgreSQL (PGlite, every migration) through the real
// Prisma client and the real admin and public routers. Synthetic data only.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createPublicCandidateDetailsRouter, PUBLIC_CANDIDATE_DETAILS_PATH } from "../src/routes/publicCandidateDetails.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { JOB_CATEGORIES } from "../src/services/candidateFormDataService.js";
import { jobTypesLabel, NO_PREFERRED_JOB_TYPE } from "../src/services/jobTypeCatalog.js";
import { mapCandidateToSheetRow } from "../src/services/candidateSheetMapper.js";
import { SHEET_COLUMNS } from "../src/services/sheetSchema.js";

const SECRET = "test-candidate-form-secret-0123456789-abcdefghijklmnop";
const ORIGIN = "https://candidate-form.example.test";
const SEED_MIGRATION = "20261024120000_seed_job_types";
const SEEDED = JOB_CATEGORIES.filter((name) => name !== "OTHER");
const user = (adminId, role, n) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const USERS = { ADMIN: user("u-admin", "ADMIN", 1), MANAGER: user("u-manager", "MANAGER", 2), ANALYST: user("u-analyst", "ANALYST", 3), DESK: user("u-desk", "REGISTRATION_DESK", 4) };

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
        DELETE FROM "rate_limits";
        DELETE FROM "candidate_form_response"; DELETE FROM "candidate_form_prefill_snapshot"; DELETE FROM "candidate_form_access"; DELETE FROM "candidate_form_link";
        DELETE FROM "job_candidate"; DELETE FROM "job"; DELETE FROM "job_code_counter"; DELETE FROM "agent_client"; DELETE FROM "client"; DELETE FROM "agent";
        DELETE FROM "candidate_allocation"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
        -- Back to exactly the seeded list (the migration's 17), all active.
        DELETE FROM "job_type" WHERE "code" NOT IN (${SEEDED.map((name) => `'${name.replace(/ /g, "_")}'`).join(", ")});
        UPDATE "job_type" SET "is_active" = true;
    `);
});

function app(who) {
    const server = express();
    server.use(PUBLIC_CANDIDATE_DETAILS_PATH, createPublicCandidateDetailsRouter({ db: prisma, tokenSecret: SECRET, allowedOrigin: ORIGIN, verifyIpLimiter: noRateLimit, verifyPassportLimiter: noRateLimit, log: { warn() {}, error() {}, info() {} } }));
    server.use(express.json());
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: who.adminId }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
        next();
    };
    server.use("/api/admin", createAdminRouter({ db: prisma, bucket: {}, requireAdmin, apiLimiter: noRateLimit, candidateFormOrigin: ORIGIN }));
    server.use(errorHandler);
    return server;
}
async function call(who, method, url, body) {
    const listener = await new Promise((resolve) => { const s = app(who).listen(0, "127.0.0.1", () => resolve(s)); });
    try {
        const res = await fetch(`http://127.0.0.1:${listener.address().port}${url}`, { method, headers: body === undefined ? {} : { "Content-Type": "application/json", ...(body.__token ? { Authorization: `Bearer ${body.__token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify({ ...body, __token: undefined }) });
        return { status: res.status, body: await res.json().catch(() => null) };
    } finally {
        listener.close();
    }
}
const admin = (who, method, url, body) => call(who, method, `/api/admin${url}`, body);
const pub = (url, token, body) => call(USERS.ADMIN, "POST", `${PUBLIC_CANDIDATE_DETAILS_PATH}${url}`, { ...body, __token: token });

const createType = async (name, who = USERS.ADMIN) => admin(who, "POST", "/job-types", { name });
const typeByName = (name) => prisma.jobType.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
let seq = 0;
const register = async (jobTypes, who = USERS.ADMIN) => {
    seq += 1;
    const passportId = `N60000${String(seq).padStart(2, "0")}`;
    const r = await admin(who, "POST", "/candidates", {
        passportId, surname: "Perera", otherNames: "Kamal", nic: `6000000${String(seq).padStart(2, "0")}V`, whatsappNumber: `9477300${String(seq).padStart(4, "0")}`, jobTypes,
    });
    return { ...r, passportId };
};
const pass = (passportId) => prisma.candidateStage.create({ data: { passportId, stage: "TEST_DETAILS", testResult: "PASS" } });
async function newJob(jobTypeName) {
    const agent = await prisma.agent.create({ data: { name: `Agent ${jobTypeName}`, countryCode: "RO" } });
    const client = await prisma.client.create({ data: { name: `Client ${jobTypeName}`, agentLinks: { create: { agentId: agent.id } } } });
    const jobType = await typeByName(jobTypeName);
    const r = await admin(USERS.MANAGER, "POST", "/jobs", { jobTypeId: jobType.id, clientId: client.id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
}
const assign = (job, passportId) => admin(USERS.MANAGER, "POST", `/jobs/${job.jobId}/candidates`, { passportId });
const auditActions = async () => (await prisma.auditLog.findMany({ orderBy: { createdDate: "asc" }, select: { action: true } })).map((row) => row.action);

describe("Settings > Job Types (management)", () => {
    test("JOB-TYPE-001 an ADMIN creates a job type; it is audited; the list shows it with its status; No Preferred Type is a separate system option", async () => {
        const r = await createType("  Scaffolder ");
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.deepEqual([r.body.name, r.body.code], ["Scaffolder", "SCAFFOLDER"]);
        const list = await admin(USERS.ADMIN, "GET", "/job-types");
        assert.equal(list.status, 200);
        const row = list.body.items.find((item) => item.name === "Scaffolder");
        assert.deepEqual([row.isActive, row.jobCount], [true, 0]);
        assert.equal(list.body.items.length, SEEDED.length + 1);
        assert.deepEqual(list.body.noPreference, { code: "NO_PREFERENCE", label: "No Preferred Type" });
        assert.ok(!list.body.items.some((item) => /no.?pref/i.test(item.name)), "No Preferred Type is not a job type row");
        assert.deepEqual(await auditActions(), ["CREATE_JOB_TYPE"]);
    });

    test("JOB-TYPE-002 only ADMIN manages the list (Settings); ADMIN and MANAGER may add a type (the New Job dialog); others are refused, on the server", async () => {
        const created = await createType("Rigger");
        for (const who of [USERS.ANALYST, USERS.DESK]) {
            assert.equal((await createType("Painter", who)).status, 403, who.role);
            assert.equal((await admin(who, "GET", "/job-types")).status, 403, who.role);
            assert.equal((await admin(who, "PATCH", `/job-types/${created.body.id}`, { name: "X" })).status, 403, who.role);
        }
        assert.equal((await admin(USERS.MANAGER, "GET", "/job-types")).status, 403, "the Settings list is ADMIN only");
        assert.equal((await admin(USERS.MANAGER, "PATCH", `/job-types/${created.body.id}`, { isActive: false })).status, 403, "rename / status are ADMIN only");
        assert.equal((await createType("Painter", USERS.MANAGER)).status, 201, "MANAGER keeps the existing inline add");
        assert.equal((await typeByName("Rigger")).isActive, true);
    });

    test("JOB-TYPE-003 / 004 a blank or over-long name is refused; a case-insensitive duplicate is refused (create and rename)", async () => {
        for (const name of ["", "   ", "x".repeat(121)]) assert.equal((await createType(name)).status, 400, JSON.stringify(name));
        assert.equal((await createType("!!!")).status, 400, "no letters or digits");
        await createType("Carpenter");
        for (const name of ["carpenter", " CARPENTER ", "CarPenter"]) {
            const r = await createType(name);
            assert.deepEqual([r.status, r.body.code], [409, "DUPLICATE"], name);
        }
        const other = await createType("Mason");
        const rename = await admin(USERS.ADMIN, "PATCH", `/job-types/${other.body.id}`, { name: "CARPENTER" });
        assert.deepEqual([rename.status, rename.body.code], [409, "DUPLICATE"]);
        assert.equal((await prisma.jobType.count({ where: { name: { equals: "carpenter", mode: "insensitive" } } })), 1);
    });

    test("JOB-TYPE-005 rename keeps the id and code (jobs follow it); deactivate / activate; every change is audited; nothing is deleted", async () => {
        const created = await createType("Fitter");
        const job = await newJob("Fitter");
        const renamed = await admin(USERS.ADMIN, "PATCH", `/job-types/${created.body.id}`, { name: "Pipe Fitter" });
        assert.deepEqual([renamed.status, renamed.body.name, renamed.body.code, renamed.body.jobCount], [200, "Pipe Fitter", "FITTER", 1]);
        assert.equal((await admin(USERS.MANAGER, "GET", `/jobs/${job.jobId}`)).body.jobType.name, "Pipe Fitter");
        const off = await admin(USERS.ADMIN, "PATCH", `/job-types/${created.body.id}`, { isActive: false });
        assert.equal(off.body.isActive, false);
        const on = await admin(USERS.ADMIN, "PATCH", `/job-types/${created.body.id}`, { isActive: true });
        assert.equal(on.body.isActive, true);
        assert.deepEqual((await auditActions()).filter((a) => a.endsWith("JOB_TYPE")), ["CREATE_JOB_TYPE", "UPDATE_JOB_TYPE", "DEACTIVATE_JOB_TYPE", "ACTIVATE_JOB_TYPE"]);
        // No change, no audit; unknown fields and bad values refused.
        await admin(USERS.ADMIN, "PATCH", `/job-types/${created.body.id}`, { isActive: true });
        assert.equal((await auditActions()).filter((a) => a.endsWith("JOB_TYPE")).length, 4);
        assert.equal((await admin(USERS.ADMIN, "PATCH", `/job-types/${created.body.id}`, { code: "X" })).status, 400);
        assert.equal((await admin(USERS.ADMIN, "PATCH", `/job-types/${created.body.id}`, { isActive: "no" })).status, 400);
        assert.equal((await admin(USERS.ADMIN, "PATCH", `/job-types/00000000-0000-4000-8000-000000000000`, { isActive: false })).status, 404);
        assert.equal((await admin(USERS.ADMIN, "DELETE", `/job-types/${created.body.id}`)).status, 404, "there is no delete");
    });

    test("JOB-TYPE-006 / 007 an inactive type is not offered for new candidate choices or new jobs, and cannot be picked by a new request", async () => {
        const created = await createType("Glazier");
        await admin(USERS.ADMIN, "PATCH", `/job-types/${created.body.id}`, { isActive: false });
        const choices = await admin(USERS.DESK, "GET", "/job-type-choices");
        assert.equal(choices.status, 200);
        assert.ok(!choices.body.jobTypes.includes("Glazier"));
        assert.ok(!(await admin(USERS.MANAGER, "GET", "/job-options")).body.jobTypes.some((t) => t.name === "Glazier"));
        const refused = await register(["Glazier"]);
        assert.equal(refused.status, 400);
        assert.match(refused.body.errors[0].message, /not an active job type/);
        const agent = await prisma.agent.create({ data: { name: "A", countryCode: "RO" } });
        const client = await prisma.client.create({ data: { name: "C", agentLinks: { create: { agentId: agent.id } } } });
        assert.equal((await admin(USERS.MANAGER, "POST", "/jobs", { jobTypeId: created.body.id, clientId: client.id })).status, 400);
    });

    test("JOB-TYPE-008 records keep a type deactivated later: the job still shows it and can be edited; the candidate keeps it and can save", async () => {
        await createType("Steel Fixer");
        const job = await newJob("Steel Fixer");
        const candidate = await register(["Steel Fixer"]);
        assert.equal(candidate.status, 201, JSON.stringify(candidate.body));
        const type = await typeByName("Steel Fixer");
        await admin(USERS.ADMIN, "PATCH", `/job-types/${type.id}`, { isActive: false });
        const shown = await admin(USERS.MANAGER, "GET", `/jobs/${job.jobId}`);
        assert.equal(shown.body.jobType.name, "Steel Fixer");
        // Editing the job (same type sent back) works; switching TO an inactive type does not.
        assert.equal((await admin(USERS.MANAGER, "PUT", `/jobs/${job.jobId}`, { jobTypeId: type.id, vacancies: 4 })).status, 200);
        const details = await admin(USERS.ADMIN, "GET", `/candidates/${candidate.passportId}`);
        assert.deepEqual(details.body.candidate.jobTypes, ["Steel Fixer"]);
        // Saving Candidate Details keeps the historical type (and may add an active one).
        const saved = await admin(USERS.ADMIN, "PUT", `/candidates/${candidate.passportId}`, {
            surname: "Perera", otherNames: "Kamal", nic: details.body.candidate.nic, jobTypes: ["steel fixer", "PLUMBER"], jobExperience: "5 years", passportIssueDate: "2020-01-15", passportExpiryDate: "2030-01-14",
        });
        assert.equal(saved.status, 200, JSON.stringify(saved.body));
        assert.deepEqual(saved.body.candidate.jobTypes, ["Steel Fixer", "PLUMBER"]);
        // Legacy free text saved before the list existed is kept too, never rewritten.
        await prisma.candidate.update({ where: { passportId: candidate.passportId }, data: { job: "Uber driver, Steel Fixer" } });
        const legacy = await admin(USERS.ADMIN, "PUT", `/candidates/${candidate.passportId}`, {
            surname: "Perera", otherNames: "Kamal", nic: details.body.candidate.nic, jobTypes: ["Uber driver"], jobExperience: "5 years", passportIssueDate: "2020-01-15", passportExpiryDate: "2030-01-14",
        });
        assert.deepEqual(legacy.body.candidate.jobTypes, ["Uber driver"]);
        assert.equal((await register(["Uber driver"])).status, 400, "but a NEW candidate cannot pick free text");
    });

    test("JOB-TYPE-010 No Preferred Type is a system option: no row to rename / deactivate / delete; a job can never use it", async () => {
        assert.equal((await prisma.jobType.count({ where: { OR: [{ code: "NO_PREFERENCE" }, { name: { equals: "No Preferred Type", mode: "insensitive" } }] } })), 0);
        assert.equal((await admin(USERS.ADMIN, "PATCH", "/job-types/NO_PREFERENCE", { isActive: false })).status, 404);
        assert.ok(!(await admin(USERS.MANAGER, "GET", "/job-options")).body.jobTypes.some((t) => /no.?pref/i.test(t.name)), "never offered for a Job");
        const agent = await prisma.agent.create({ data: { name: "A", countryCode: "RO" } });
        const client = await prisma.client.create({ data: { name: "C", agentLinks: { create: { agentId: agent.id } } } });
        for (const jobTypeId of ["NO_PREFERENCE", "No Preferred Type"]) {
            assert.equal((await admin(USERS.MANAGER, "POST", "/jobs", { jobTypeId, clientId: client.id })).status, 400, jobTypeId);
        }
    });
});

describe("job type choices (server side)", () => {
    test("DYNAMIC-JOB-TYPE-001 / 002 / 005 / 006 the candidate choices are the active list plus No Preferred Type; a new type appears at once", async () => {
        const before = await admin(USERS.DESK, "GET", "/job-type-choices");
        assert.deepEqual(before.body.jobTypes, [...SEEDED].sort((a, b) => a.localeCompare(b)));
        assert.deepEqual(before.body.noPreference, NO_PREFERRED_JOB_TYPE);
        await createType("Crane Operator");
        assert.ok((await admin(USERS.ANALYST, "GET", "/job-type-choices")).body.jobTypes.includes("Crane Operator"));
        // Registration: the new type (any case, stored with the list's spelling), or No Preferred Type.
        const typed = await register(["crane operator"]);
        assert.equal(typed.status, 201, JSON.stringify(typed.body));
        assert.deepEqual((await prisma.candidate.findUnique({ where: { passportId: typed.passportId } })).job, "Crane Operator");
        const open = await register(["No Preferred Type"]);
        assert.equal(open.status, 201);
        assert.equal((await prisma.candidate.findUnique({ where: { passportId: open.passportId } })).job, "NO_PREFERENCE", "stored as the stable code");
        assert.deepEqual((await admin(USERS.ADMIN, "GET", `/candidates/${open.passportId}`)).body.candidate.jobTypes, ["NO_PREFERENCE"]);
        // It means "any type": it cannot be combined with a type. Job type stays required.
        const mixed = await register(["NO_PREFERENCE", "PLUMBER"]);
        assert.equal(mixed.status, 400);
        assert.match(mixed.body.errors[0].message, /cannot be combined/);
        assert.equal((await register([])).status, 400);
    });

    test("DYNAMIC-JOB-TYPE-004 / 007 new jobs use the active types only, never No Preferred Type", async () => {
        await createType("Rebar Worker");
        const options = (await admin(USERS.MANAGER, "GET", "/job-options")).body.jobTypes.map((t) => t.name);
        assert.ok(options.includes("Rebar Worker"));
        assert.ok(!options.some((name) => /no.?pref|NO_PREFERENCE/i.test(name)));
    });

    test("No Preferred Type shows as its label in the Google Sheet and wherever the stored text is turned into labels", () => {
        assert.equal(jobTypesLabel("NO_PREFERENCE"), "No Preferred Type");
        assert.equal(jobTypesLabel("Driver, Welder"), "Driver, Welder");
        const now = new Date("2026-10-20T06:00:00.000Z");
        const row = mapCandidateToSheetRow({ user: { passportId: "N1", uniqueId: "1", job: "NO_PREFERENCE", createdDate: now }, stages: [], documents: [] }, { mirroredAt: now });
        assert.equal(row[SHEET_COLUMNS.findIndex((c) => c.field === "job")], "No Preferred Type");
    });
});

describe("Candidate Form job types (server side)", () => {
    async function formSession(passportId, nic) {
        const share = await admin(USERS.ADMIN, "POST", `/candidates/${passportId}/form-share`);
        const linkSecret = share.body.url.split("#k=")[1];
        const verified = await pub("/verify", undefined, { linkSecret, passportNumber: passportId, nic });
        assert.equal(verified.status, 200, JSON.stringify(verified.body));
        return verified.body.token;
    }
    const ANSWERS = (jobCategory, jobCategoryOther = "") => ({
        basic: { fullName: "anusha de soysa", surname: "de soysa", otherNames: "n/a", sex: "FEMALE", civilStatus: "SINGLE", birthDate: "1990-05-01", birthPlace: "negombo" },
        contact: { address: "12 galle road", city: "negombo", district: "gampaha", dsDivision: "negombo", gnDivision: "kurana", alternativePhone: "N/A", email: "a@example.com" },
        passport: { issueDate: "2020-01-15", expiryDate: "2030-01-14" },
        qualifications: { jobCategory, jobCategoryOther, experience: "5 years", otherSkills1: "N/A", otherSkills2: "N/A", englishKnowledge: "GOOD" },
        measurements: { shirtSize: "M", waistSize: "32", shoeSize: "9" },
        family: { father: { name: "N/A", surname: "", passportNumber: "", birthDate: "" }, mother: { name: "kumari", surname: "de soysa", passportNumber: "N/A", birthDate: "1965-02-03" }, spouse: { name: "", surname: "", passportNumber: "", birthDate: "" }, child1: "n/a", child2: "", child3: "" },
        guardian: { name: "kamal perera", relationship: "uncle", nic: "901234567v", birthDate: "1960-01-01", phone: "+94 77 123 4567", address: "45 lake road" },
    });

    test("DYNAMIC-JOB-TYPE-003 the form's choices are the active job types (names only); a new type, No Preferred Type and OTHER are accepted; an inactive one is not", async () => {
        await createType("Scaffolder");
        const glazier = await createType("Glazier");
        await admin(USERS.ADMIN, "PATCH", `/job-types/${glazier.body.id}`, { isActive: false });
        const a = await register(["PLUMBER"]);
        const nic = (await prisma.candidate.findUnique({ where: { passportId: a.passportId } })).nic;
        const token = await formSession(a.passportId, nic);
        const form = await pub("/form", token, {});
        assert.ok(form.body.jobCategories.includes("Scaffolder"));
        assert.ok(!form.body.jobCategories.includes("Glazier"));
        assert.ok(form.body.jobCategories.every((value) => typeof value === "string"), "names only");
        assert.equal(form.body.answers.qualifications.jobCategory, "PLUMBER", "the record's (active) type is prefilled");
        assert.equal((await pub("/submit", token, { answers: ANSWERS("Glazier"), idempotencyKey: "jobtype-key-000001" })).status, 400, "inactive refused");
        assert.equal((await pub("/submit", token, { answers: ANSWERS("Made Up"), idempotencyKey: "jobtype-key-000002" })).status, 400, "unknown refused");
        const ok = await pub("/submit", token, { answers: ANSWERS("scaffolder"), idempotencyKey: "jobtype-key-000003" });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal((await prisma.candidateFormResponse.findUnique({ where: { passportId: a.passportId } })).jobCategory, "Scaffolder");
        // Deactivated after the submission: the stored answer stays readable for review.
        const scaffolder = await typeByName("Scaffolder");
        await admin(USERS.ADMIN, "PATCH", `/job-types/${scaffolder.id}`, { isActive: false });
        const review = await admin(USERS.ADMIN, "GET", `/candidates/${a.passportId}/form-submission`);
        assert.equal(review.body.submitted["qualifications.jobCategory"], "Scaffolder");

        const b = await register(["No Preferred Type"]);
        const tokenB = await formSession(b.passportId, (await prisma.candidate.findUnique({ where: { passportId: b.passportId } })).nic);
        const formB = await pub("/form", tokenB, {});
        assert.equal(formB.body.answers.qualifications.jobCategory, "NO_PREFERENCE", "No Preferred Type is prefilled from the record");
        assert.equal((await pub("/submit", tokenB, { answers: ANSWERS("NO_PREFERENCE"), idempotencyKey: "jobtype-key-000004" })).status, 200);
        assert.equal((await prisma.candidateFormResponse.findUnique({ where: { passportId: b.passportId } })).jobCategory, "NO_PREFERENCE");
    });
});

describe("job assignment and No Preferred Type", () => {
    test("JOB-ASSIGN-TYPE-001 / 003 / 004 a matching candidate, and a No Preferred Type candidate on two jobs of different types, can be assigned", async () => {
        const plumberJob = await newJob("PLUMBER");
        const welderJob = await newJob("WELDER TIG");
        const plumber = await register(["PLUMBER"]);
        const open = await register(["No Preferred Type"]);
        for (const c of [plumber, open]) await pass(c.passportId);
        assert.equal((await assign(plumberJob, plumber.passportId)).status, 201);
        assert.equal((await assign(plumberJob, open.passportId)).status, 201, "No Preferred Type -> type A");
        // Off job A, then onto job B (it could also have stayed on A: a candidate may hold several jobs).
        assert.equal((await admin(USERS.MANAGER, "DELETE", `/jobs/${plumberJob.jobId}/candidates/${open.passportId}`)).status, 200);
        assert.equal((await assign(welderJob, open.passportId)).status, 201, "No Preferred Type -> type B");
    });

    test("JOB-ASSIGN-TYPE-002 assignment does not compare types today (business decision): a non-matching candidate is NOT newly blocked", async () => {
        const welderJob = await newJob("WELDER TIG");
        const plumber = await register(["PLUMBER"]);
        await pass(plumber.passportId);
        assert.equal((await assign(welderJob, plumber.passportId)).status, 201);
    });

    test("JOB-ASSIGN-TYPE-005 / 006 No Preferred Type bypasses nothing: Test PASS, a PROCESSING job and never the same job twice still apply", async () => {
        const job = await newJob("PLUMBER");
        const open = await register(["No Preferred Type"]);
        const notPassed = await assign(job, open.passportId);
        assert.deepEqual([notPassed.status, notPassed.body.code], [409, "CANDIDATE_TEST_NOT_PASSED"]);
        await pass(open.passportId);
        const done = await newJob("TILER");
        assert.equal((await admin(USERS.MANAGER, "POST", `/jobs/${done.jobId}/complete`, {})).status, 200);
        assert.equal((await assign(done, open.passportId)).body.code, "JOB_NOT_PROCESSING");
        assert.equal((await assign(job, open.passportId)).status, 201);
        assert.equal((await assign(job, open.passportId)).body.code, "CANDIDATE_ALREADY_IN_JOB");
        const other = await newJob("ELECTRICIAN");
        assert.equal((await assign(other, open.passportId)).status, 201, "a second job is allowed");
    });

    test("JOB-ASSIGN-TYPE-007 the Add-to-job candidate list (PASS search) and the server agree: both list / accept typed and No Preferred Type candidates", async () => {
        const job = await newJob("PLUMBER");
        const plumber = await register(["PLUMBER"]);
        const open = await register(["No Preferred Type"]);
        const failed = await register(["PLUMBER"]);
        await pass(plumber.passportId);
        await pass(open.passportId);
        await prisma.candidateStage.create({ data: { passportId: failed.passportId, stage: "TEST_DETAILS", testResult: "FAIL" } });
        const listed = await admin(USERS.MANAGER, "GET", "/candidates?testResult=PASS&pageSize=100");
        const ids = listed.body.items.map((item) => item.passportId);
        assert.ok(ids.includes(plumber.passportId) && ids.includes(open.passportId) && !ids.includes(failed.passportId));
        assert.deepEqual(listed.body.items.find((item) => item.passportId === open.passportId).jobTypes, ["NO_PREFERENCE"]);
        for (const id of [plumber.passportId, open.passportId]) assert.equal((await assign(job, id)).status, 201, id);
        assert.equal((await assign(job, failed.passportId)).body.code, "CANDIDATE_TEST_NOT_PASSED");
    });
});

describe("migration", () => {
    test("JOB-TYPE-009 the seed adds the 17 trades once: existing types (any spelling) are kept as they are, nothing is duplicated, renamed or reactivated", async () => {
        const old = await createTestDatabase({ upTo: "20261023120000_reconcile_job_company_job_id" });
        try {
            await old.pg.exec(`
                INSERT INTO "job_type" ("code", "name", "is_active") VALUES ('CAPENTER', 'capenter', true), ('PLUMBING', 'plumber', false), ('WELDER_TIG', 'Tig Welder', true);
            `);
            const sql = fs.readFileSync(path.join("prisma", "migrations", SEED_MIGRATION, "migration.sql"), "utf8");
            await old.pg.exec(sql);
            await old.pg.exec(sql); // idempotent
            const rows = (await old.pg.query(`SELECT "code", "name", "is_active" FROM "job_type" ORDER BY "code"`)).rows;
            const byCode = Object.fromEntries(rows.map((row) => [row.code, row]));
            assert.deepEqual(byCode.CAPENTER, { code: "CAPENTER", name: "capenter", is_active: true });
            assert.deepEqual(byCode.PLUMBING, { code: "PLUMBING", name: "plumber", is_active: false }, "an existing 'plumber' (another case) is kept, still inactive");
            assert.deepEqual(byCode.WELDER_TIG, { code: "WELDER_TIG", name: "Tig Welder", is_active: true }, "an existing code is kept as it is");
            assert.equal(rows.filter((row) => row.name.toLowerCase() === "plumber").length, 1);
            // 3 existing + 17 seeded - PLUMBER (name exists) - WELDER TIG (code exists) = 18.
            assert.equal(rows.length, 18);
            const candidates = (await old.pg.query(`SELECT count(*)::int AS n FROM "candidate"`)).rows[0].n;
            assert.equal(candidates, 0, "no candidate data is touched by the migration");
        } finally {
            await old.close();
        }
    });
});
