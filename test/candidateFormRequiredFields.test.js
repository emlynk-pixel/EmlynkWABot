// Candidate Form: every answer required, "N/A" only where allowed, conditional
// sections (FORM-REQ-*), and the link / session security unchanged by it
// (SECURITY-REGRESSION-*). Pure parseSubmission checks plus the real public and
// admin routers on a REAL PostgreSQL (PGlite, every migration). Synthetic data.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createPublicCandidateDetailsRouter, PUBLIC_CANDIDATE_DETAILS_PATH } from "../src/routes/publicCandidateDetails.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { ANSWER_FIELDS, NOT_APPLICABLE_FIELDS, parseSubmission } from "../src/services/candidateFormDataService.js";
import { pendingChange } from "../src/services/candidateFormFieldConfirmService.js";

const NOW = new Date("2026-10-20T06:00:00.000Z");
const KEY = "key-required-000001";

// Every answer, N/A where allowed (no other names, no second phone, father N/A, no children).
const ANSWERS = () => ({
    basic: { fullName: "anusha de soysa", surname: "de soysa", otherNames: "n/a", sex: "FEMALE", civilStatus: "SINGLE", birthDate: "1990-05-01", birthPlace: "negombo" },
    contact: { address: "12 galle road", city: "negombo", district: "gampaha", dsDivision: "negombo", gnDivision: "kurana", alternativePhone: "N/a", email: "a@example.com" },
    passport: { issueDate: "2020-01-15", expiryDate: "2030-01-14" },
    qualifications: { jobCategory: "WELDER TIG", jobCategoryOther: "", experience: "5 years", otherSkills1: "N/A", otherSkills2: "n/A", englishKnowledge: "GOOD" },
    measurements: { shirtSize: "M", waistSize: "32", shoeSize: "9" },
    family: {
        father: { name: "N/A", surname: "", passportNumber: "", birthDate: "" },
        mother: { name: "kumari", surname: "de soysa", passportNumber: "N/A", birthDate: "1965-02-03" },
        spouse: { name: "", surname: "", passportNumber: "", birthDate: "" }, child1: "n/a", child2: "", child3: "",
    },
    guardian: { name: "kamal perera", relationship: "uncle", nic: "901234567v", birthDate: "1960-01-01", phone: "+94 77 123 4567", address: "45 lake road" },
});
const parse = (answers) => parseSubmission({ answers, idempotencyKey: KEY }, { now: NOW });
const fields = (result) => (result.errors ?? []).map((e) => `${e.field}:${e.code}`).sort();
const set = (answers, path, value) => {
    const parts = path.split(".");
    let target = answers;
    for (const part of parts.slice(0, -1)) target = target[part];
    target[parts.at(-1)] = value;
    return answers;
};

describe("server: every answer is required (parseSubmission)", () => {
    test("FORM-REQ-010 (server) a complete submission is accepted; N/A in any letter case is stored as N/A", () => {
        const result = parse(ANSWERS());
        assert.deepEqual(result.errors, undefined);
        const v = result.values;
        assert.deepEqual([v.otherNames, v.alternativePhone, v.otherSkills1, v.otherSkills2, v.fatherName, v.motherPassportNumber, v.child1Name], ["N/A", "N/A", "N/A", "N/A", "N/A", "N/A", "N/A"]);
        assert.deepEqual([v.fatherSurname, v.fatherBirthDate, v.child2Name, v.child3Name], [null, null, null, null], "not applicable: allowed to stay empty");
        assert.equal(v.shoeSize, "9", "the UK shoe size is stored as before");
    });

    test("FORM-REQ-009 a manipulated submission that leaves out or blanks any always-required answer is refused, field by field", () => {
        const always = ANSWER_FIELDS
            .map(([group, key]) => `${group}.${key}`)
            .filter((path) => !path.startsWith("family.spouse.") && !["qualifications.jobCategoryOther", "family.child2", "family.child3", "family.father.surname", "family.father.passportNumber", "family.father.birthDate"].includes(path));
        assert.equal(always.length, 36); // 46 answers less the 4 spouse, Other Job Category, Child 2 / 3 and the 3 conditional father answers
        for (const path of always) {
            for (const blank of ["", "   ", null, undefined]) {
                const answers = ANSWERS();
                if (blank === undefined) {
                    const parts = path.split(".");
                    let target = answers;
                    for (const part of parts.slice(0, -1)) target = target[part];
                    delete target[parts.at(-1)];
                } else set(answers, path, blank);
                // Blanking the father's "N/A" name makes him applicable: his other answers are then needed too.
                const expected = path === "family.father.name"
                    ? ["family.father.birthDate:required", "family.father.name:required", "family.father.passportNumber:required", "family.father.surname:required"]
                    : [`${path}:required`];
                assert.deepEqual(fields(parse(answers)), expected, `${path} = ${JSON.stringify(blank)}`);
            }
        }
        // No answers at all: every always-required answer is reported, plus the father's three
        // (with no "N/A" name he applies): 39, the same total the form shows for an empty form.
        assert.equal(fields(parse({})).length, always.length + 3);
    });

    test("FORM-REQ-009b N/A is refused on the server wherever the form refuses it, and never reaches a format check", () => {
        const allowed = new Set(NOT_APPLICABLE_FIELDS);
        for (const [group, key] of ANSWER_FIELDS) {
            const path = `${group}.${key}`;
            if (allowed.has(path) || path.startsWith("family.spouse.") || path === "qualifications.jobCategoryOther") continue;
            const result = parse(set(ANSWERS(), path, "n/a"));
            assert.ok(result.errors?.some((e) => e.field === path && e.code === "invalid"), `${path}: ${JSON.stringify(result.errors)}`);
        }
        // Sizes: "N/A" fits the size pattern, but a real size is required.
        assert.deepEqual(fields(parse(set(ANSWERS(), "measurements.shoeSize", "N/A"))), ["measurements.shoeSize:invalid"]);
        // The spouse of a married candidate exists: only the passport may be N/A.
        const married = ANSWERS();
        married.basic.civilStatus = "MARRIED";
        married.family.spouse = { name: "N/A", surname: "silva", passportNumber: "n/a", birthDate: "1992-07-08" };
        assert.deepEqual(fields(parse(married)), ["family.spouse.name:invalid"]);
    });

    test("FORM-REQ-007 (server) conditional answers: Married -> spouse; a real parent -> their details; a real child -> the next; OTHER -> its category", () => {
        const married = ANSWERS();
        married.basic.civilStatus = "MARRIED";
        assert.deepEqual(fields(parse(married)), ["family.spouse.birthDate:required", "family.spouse.name:required", "family.spouse.passportNumber:required", "family.spouse.surname:required"]);

        const father = ANSWERS();
        father.family.father = { name: "sunil", surname: "", passportNumber: "", birthDate: "" };
        assert.deepEqual(fields(parse(father)), ["family.father.birthDate:required", "family.father.passportNumber:required", "family.father.surname:required"]);
        father.family.father = { name: "sunil", surname: "de soysa", passportNumber: "N/A", birthDate: "1960-03-02" };
        assert.deepEqual(fields(parse(father)), []);

        const children = ANSWERS();
        children.family.child1 = "nimal";
        assert.deepEqual(fields(parse(children)), ["family.child2:required"]);
        children.family.child2 = "kasun";
        assert.deepEqual(fields(parse(children)), ["family.child3:required"]);
        children.family.child3 = "N/A";
        assert.deepEqual(fields(parse(children)), []);

        const other = ANSWERS();
        other.qualifications.jobCategory = "OTHER";
        assert.deepEqual(fields(parse(other)), ["qualifications.jobCategoryOther:required"]);
        other.qualifications.jobCategoryOther = "N/A";
        assert.deepEqual(fields(parse(other)), ["qualifications.jobCategoryOther:invalid"]);
    });

    test("FORM-REQ-006 (server) hidden answers never block and are never stored: a stale spouse when Single, an old other category", () => {
        const answers = ANSWERS();
        answers.family.spouse = { name: "N/A", surname: "", passportNumber: "bad passport!!", birthDate: "not a date" };
        answers.qualifications.jobCategoryOther = "N/A";
        const result = parse(answers);
        assert.equal(result.errors, undefined, JSON.stringify(result.errors));
        assert.deepEqual([result.values.spouseName, result.values.spousePassportNumber, result.values.spouseBirthDate, result.values.jobCategoryOther], [null, null, null, null]);
    });

    test("N/A is never offered to staff as a value for the candidate's record", () => {
        const candidate = { firstName: "ANUSHA", contactNumber: "0771234567", jobExperience: "3 YEARS" };
        for (const [field, raw] of [["basic.otherNames", "N/A"], ["contact.alternativePhone", "n/a"], ["qualifications.experience", "N/A"]]) {
            assert.equal(pendingChange(field, { candidate, details: null, submitted: { [field]: raw } }), null, field);
        }
        assert.notEqual(pendingChange("qualifications.experience", { candidate, details: null, submitted: { "qualifications.experience": "5 YEARS" } }), null, "a real change is still offered");
    });
});

// ---------------------------------------------------------------- real routers, real database

const SECRET = "test-candidate-form-secret-0123456789-abcdefghijklmnop";
const ORIGIN = "https://candidate-form.example.test";
const user = (adminId, role, n) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const MANAGER = user("u-manager", "MANAGER", 2);
const C = (i) => ({ passportId: `N700000${i}`, uniqueId: `700${i}`, firstName: `First${i}`, otherName: `Last${i}`, nic: `70000000${i}V`, sex: "F", whatsappNumber: `+9477200000${i}` });
const [A, B, D] = [C(1), C(2), C(3)];

let database;
let prisma;
let pg;
let ids;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    await prisma.user.create({ data: MANAGER });
});
after(async () => database?.close());
beforeEach(async () => {
    await pg.exec(`
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "rate_limits";
        DELETE FROM "candidate_form_response"; DELETE FROM "candidate_form_prefill_snapshot"; DELETE FROM "candidate_form_access"; DELETE FROM "candidate_form_link";
        DELETE FROM "job_candidate"; DELETE FROM "job"; DELETE FROM "job_code_counter"; DELETE FROM "job_type"; DELETE FROM "agent_client"; DELETE FROM "client"; DELETE FROM "agent";
        DELETE FROM "candidate_allocation"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
        -- The active job types this suite's candidates use (Settings > Job Types).
        INSERT INTO "job_type" ("code", "name") VALUES ('WELDER_TIG_SEED', 'WELDER TIG') ON CONFLICT DO NOTHING;
    `);
    await prisma.candidate.createMany({ data: [A, B, D] });
    await prisma.candidateStage.createMany({ data: [A, B, D].map((c) => ({ passportId: c.passportId, stage: "TEST_DETAILS", testResult: "PASS" })) });
    const [jobType, agent] = await Promise.all([prisma.jobType.create({ data: { code: "WELDER", name: "Welder" } }), prisma.agent.create({ data: { name: "Ion Popescu", countryCode: "RO" } })]);
    const client = await prisma.client.create({ data: { name: "Acme Construction", agentLinks: { create: { agentId: agent.id } } } });
    ids = { jobType: jobType.id, client: client.id, agent: agent.id };
});

function app() {
    const server = express();
    server.use(PUBLIC_CANDIDATE_DETAILS_PATH, createPublicCandidateDetailsRouter({ db: prisma, tokenSecret: SECRET, allowedOrigin: ORIGIN, verifyIpLimiter: noRateLimit, verifyPassportLimiter: noRateLimit, log: { warn() {}, error() {}, info() {} } }));
    server.use(express.json());
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: MANAGER.adminId }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
        next();
    };
    server.use("/api/admin", createAdminRouter({ db: prisma, bucket: {}, requireAdmin, apiLimiter: noRateLimit, candidateFormOrigin: ORIGIN }));
    server.use(errorHandler);
    return server;
}
async function call(method, path, { body, token } = {}) {
    const listener = await new Promise((resolve) => { const s = app().listen(0, "127.0.0.1", () => resolve(s)); });
    try {
        const headers = { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
        const res = await fetch(`http://127.0.0.1:${listener.address().port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: await res.json().catch(() => null) };
    } finally {
        listener.close();
    }
}
const admin = (method, path, options) => call(method, `/api/admin${path}`, options);
const pub = (path, options) => call("POST", `${PUBLIC_CANDIDATE_DETAILS_PATH}${path}`, options);
const secretOf = (url) => url.split("#k=")[1];
const singleLink = async (c) => secretOf((await admin("POST", `/candidates/${c.passportId}/form-share`)).body.url);
const newJob = async (...members) => {
    const job = (await admin("POST", "/jobs", { body: { jobTypeId: ids.jobType, clientId: ids.client, responsibleAgentId: ids.agent } })).body;
    for (const m of members) assert.equal((await admin("POST", `/jobs/${job.jobId}/candidates`, { body: { passportId: m.passportId } })).status, 201);
    return job;
};
const groupLink = async (job) => secretOf((await admin("POST", `/jobs/${job.jobId}/form-share`)).body.url);
const verify = (secret, c) => pub("/verify", { body: { linkSecret: secret, passportNumber: c.passportId, nic: c.nic } });
const session = async (secret, c) => {
    const r = await verify(secret, c);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.token;
};
const submit = (token, answers = ANSWERS(), key = "key-required-000002") => pub("/submit", { token, body: { answers, idempotencyKey: key } });
const stored = (c) => prisma.candidateFormResponse.count({ where: { passportId: c.passportId } });
const accessOf = async (c) => (await prisma.candidateFormAccess.findUnique({ where: { passportId: c.passportId } }))?.status;

describe("server: required answers over the real API", () => {
    test("FORM-REQ-009 (API) an incomplete or N/A-misused manipulated payload is refused with field codes; nothing is stored; the form stays open", async () => {
        const token = await session(await singleLink(A), A);
        const incomplete = ANSWERS();
        incomplete.contact.city = "";
        delete incomplete.measurements.shoeSize;
        incomplete.guardian.birthDate = "   ";
        const r = await submit(token, incomplete);
        assert.equal(r.status, 400);
        assert.deepEqual(r.body.errors.map((e) => `${e.field}:${e.code}`).sort(), ["contact.city:required", "guardian.birthDate:required", "measurements.shoeSize:required"]);
        const misused = set(ANSWERS(), "basic.fullName", "N/A");
        assert.deepEqual((await submit(token, misused, "key-required-000003")).body.errors.map((e) => `${e.field}:${e.code}`), ["basic.fullName:invalid"]);
        assert.equal(await stored(A), 0);
        assert.equal(await accessOf(A), "UNLOCKED", "a refused submission does not use up the form");
    });

    test("FORM-REQ-010 (API) a complete submission still succeeds, once, and is stored with N/A normalised", async () => {
        const token = await session(await singleLink(A), A);
        const r = await submit(token);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const saved = await prisma.candidateFormResponse.findUnique({ where: { passportId: A.passportId } });
        assert.deepEqual([saved.alternativePhone, saved.otherNames, saved.fatherName, saved.child1Name, saved.shoeSize], ["N/A", "N/A", "N/A", "N/A", "9"]);
        assert.equal(await accessOf(A), "SUBMITTED");
    });
});

describe("security unchanged (SECURITY-REGRESSION)", () => {
    test("SECURITY-REGRESSION-001 single link: Passport + NIC open the form for that candidate only, and it submits", async () => {
        const secret = await singleLink(A);
        assert.equal((await verify(secret, B)).status, 401, "another candidate's details on A's link");
        const token = await session(secret, A);
        assert.equal((await pub("/form", { token, body: {} })).body.identity.passportNumber, A.passportId);
        assert.equal((await submit(token)).status, 200);
    });

    test("SECURITY-REGRESSION-002 group link: a member of the job verifies and submits; the link stays usable for the next member", async () => {
        const job = await newJob(A, B);
        const secret = await groupLink(job);
        assert.equal((await submit(await session(secret, A))).status, 200);
        assert.equal((await submit(await session(secret, B), ANSWERS(), "key-required-000004")).status, 200);
        assert.deepEqual([await stored(A), await stored(B)], [1, 1]);
    });

    test("SECURITY-REGRESSION-003 after submitting: no second submit, no reopening through a new link", async () => {
        const token = await session(await singleLink(A), A);
        assert.equal((await submit(token)).status, 200);
        assert.equal((await submit(token, ANSWERS(), "key-required-000005")).status, 409);
        const again = await admin("POST", `/candidates/${A.passportId}/form-share`);
        if (again.status === 201) assert.equal((await verify(secretOf(again.body.url), A)).status, 409);
        else assert.equal(again.status, 409);
        assert.equal(await stored(A), 1);
    });

    test("SECURITY-REGRESSION-004 a wrong candidate and a candidate of another job are refused with the same generic answer", async () => {
        const jobA = await newJob(A);
        await newJob(B);
        const secretA = await groupLink(jobA);
        const outsider = await verify(secretA, B);
        const stranger = await verify(secretA, D);
        assert.deepEqual([outsider.status, outsider.body.code], [401, "VERIFICATION_FAILED"]);
        assert.deepEqual(stranger.body, outsider.body, "no difference between another job's candidate and a stranger");
        assert.equal(await accessOf(B) ?? "LOCKED", "LOCKED");
    });
});
