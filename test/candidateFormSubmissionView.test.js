// Admin view of the Candidate Form submission (GET /candidates/:id/form-submission).
// Real PostgreSQL (PGlite, every migration), real Prisma client and routers.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createPublicCandidateDetailsRouter, PUBLIC_CANDIDATE_DETAILS_PATH } from "../src/routes/publicCandidateDetails.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { ANSWER_FIELDS } from "../src/services/candidateFormDataService.js";

const SECRET = "test-candidate-form-secret-0123456789-abcdefghijklmnop";
const ORIGIN = "https://candidate-form.example.test";
const user = (adminId, role, n) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const USERS = { ADMIN: user("u-admin", "ADMIN", 1), DESK: user("u-desk", "REGISTRATION_DESK", 3), ANN: user("u-ann", "ANALYST", 4), BEN: user("u-ben", "ANALYST", 5) };
const A = { passportId: "N7000001", uniqueId: "7001", firstName: "Anusha", otherName: "De Soysa", nic: "700000001V", sex: "F", address: "1 old road", whatsappNumber: "+94750000001", placeOfBirth: "Negombo" };
const B = { passportId: "N7000002", uniqueId: "7002", firstName: "Bimal", otherName: "Perera", nic: "700000002V", sex: "M", whatsappNumber: "+94750000002" };

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
        DELETE FROM "rate_limits"; DELETE FROM "candidate_form_response"; DELETE FROM "candidate_form_prefill_snapshot"; DELETE FROM "candidate_form_access"; DELETE FROM "candidate_form_link";
        DELETE FROM "candidate_allocation"; DELETE FROM "candidate_additional_details"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
    `);
    await prisma.candidate.createMany({ data: [A, B] });
    await prisma.candidateAllocation.create({ data: { passportId: A.passportId, analystId: USERS.ANN.adminId } });
});

function app(who) {
    const server = express();
    server.use(PUBLIC_CANDIDATE_DETAILS_PATH, createPublicCandidateDetailsRouter({ db: prisma, tokenSecret: SECRET, allowedOrigin: ORIGIN, verifyIpLimiter: noRateLimit, verifyPassportLimiter: noRateLimit, log: { warn() {}, error() {}, info() {}, log() {} } }));
    server.use(express.json());
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: who.adminId }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
        next();
    };
    server.use("/api/admin", createAdminRouter({ db: prisma, bucket: {}, requireAdmin, apiLimiter: noRateLimit, candidateFormOrigin: ORIGIN }));
    server.use(errorHandler);
    return server;
}
async function call(server, method, path, { body, token } = {}) {
    const listener = await new Promise((resolve) => { const s = server.listen(0, "127.0.0.1", () => resolve(s)); });
    try {
        const headers = { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
        const res = await fetch(`http://127.0.0.1:${listener.address().port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: await res.json().catch(() => null) };
    } finally {
        listener.close();
    }
}
const admin = (who, path) => call(app(who), "GET", `/api/admin${path}`);
const pub = (path, options) => call(app(USERS.ADMIN), "POST", `${PUBLIC_CANDIDATE_DETAILS_PATH}${path}`, options);

const answers = (overrides = {}) => ({
    basic: { fullName: "anusha de soysa", surname: "de soysa", otherNames: "anusha", sex: "FEMALE", civilStatus: "MARRIED", birthDate: "1990-05-01", birthPlace: "negombo" },
    contact: { address: "12 galle road", city: "negombo", district: "gampaha", dsDivision: "negombo", gnDivision: "n 12", alternativePhone: "0771234567", email: "a@example.com" },
    passport: { issueDate: "2020-01-15", expiryDate: "2030-01-14" },
    qualifications: { jobCategory: "WELDER TIG", jobCategoryOther: "", experience: "5 years", otherSkills1: "forklift", otherSkills2: "N/A", englishKnowledge: "GOOD" },
    measurements: { shirtSize: "M", waistSize: "32", shoeSize: "eu 42" },
    family: {
        father: { name: "sunil", surname: "de soysa", passportNumber: "n7654321", birthDate: "1960-03-02" },
        mother: { name: "kamala", surname: "de soysa", passportNumber: "N/A", birthDate: "1962-04-03" },
        spouse: { name: "ruwan", surname: "perera", passportNumber: "n1111111", birthDate: "1988-07-12" },
        child1: "nimal", child2: "n/a", child3: "",
    },
    guardian: { name: "kamal perera", relationship: "uncle", nic: "901234567v", birthDate: "1965-02-20", phone: "+94 77 123 4567", address: "45 lake road" },
    ...overrides,
});
async function submitAs(candidate, body = answers()) {
    const link = (await call(app(USERS.ADMIN), "POST", `/api/admin/candidates/${candidate.passportId}/form-share`)).body.url.split("#k=")[1];
    const token = (await pub("/verify", { body: { linkSecret: link, passportNumber: candidate.passportId, nic: candidate.nic } })).body.token;
    assert.equal((await pub("/form", { token, body: {} })).status, 200);
    const r = await pub("/submit", { token, body: { answers: body, idempotencyKey: "key-0000000000000001" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
}

describe("Admin: Candidate Form submission", () => {
    test("before any form: LOCKED, nothing submitted", async () => {
        const r = await admin(USERS.ADMIN, `/candidates/${A.passportId}/form-submission`);
        assert.deepEqual([r.status, r.body.formStatus, r.body.submitted, r.body.original, r.body.changed, r.body.submittedAt], [200, "LOCKED", null, null, [], null]);
    });

    test("ADMIN-FORM-002..007/009 every submitted field, Guardian included, comes from candidate_form_response", async () => {
        await submitAs(A);
        const r = await admin(USERS.ADMIN, `/candidates/${A.passportId}/form-submission`);
        assert.equal(r.status, 200);
        assert.equal(r.body.formStatus, "SUBMITTED");
        assert.ok(r.body.submittedAt);
        const row = await prisma.candidateFormResponse.findUnique({ where: { passportId: A.passportId } });
        // Guardian: name, relationship, NIC, birth date, phone, address.
        assert.deepEqual(
            ["guardian.name", "guardian.relationship", "guardian.nic", "guardian.birthDate", "guardian.phone", "guardian.address"].map((path) => r.body.submitted[path]),
            [row.guardianName, row.guardianRelationship, row.guardianNic, "1965-02-20", row.guardianPhone, row.guardianAddress],
        );
        assert.equal(r.body.submitted["guardian.name"], "KAMAL PERERA");
        assert.equal(r.body.submitted["guardian.nic"], "901234567V");
        assert.equal(r.body.submitted["guardian.address"], "45 LAKE ROAD");
        // ADMIN-FORM-012: every field of the form is present (46 answers + the verified NIC), none dropped.
        assert.equal(ANSWER_FIELDS.length, 46);
        const keys = Object.keys(r.body.submitted).sort();
        assert.deepEqual(keys, [...ANSWER_FIELDS.map(([group, key]) => `${group}.${key}`), "nic"].sort());
        assert.equal(r.body.submitted.nic, A.nic);
        assert.equal(r.body.submitted["family.spouse.name"], "RUWAN");
        assert.equal(r.body.submitted["family.child1"], "NIMAL");
        assert.equal(r.body.submitted["qualifications.jobCategory"], "WELDER TIG");
        assert.equal(r.body.submitted["passport.expiryDate"], "2030-01-14", "dates are YYYY-MM-DD");
    });

    test("ADMIN-FORM-008 empty answers are null (the Admin shows Not recorded), never undefined", async () => {
        // Every shown answer is required now; Child 3 may still be empty (Child 2 is N/A: no more children).
        await submitAs(A);
        const r = await admin(USERS.ADMIN, `/candidates/${A.passportId}/form-submission`);
        assert.equal(r.body.submitted["family.child3"], null);
        assert.equal(r.body.submitted["family.child2"], "N/A");
        assert.ok(Object.values(r.body.submitted).every((value) => value === null || typeof value === "string"));
    });

    test("ADMIN-FORM-013 the original (prefill) is returned with the submission and the changes are listed", async () => {
        await submitAs(A);
        const r = await admin(USERS.ADMIN, `/candidates/${A.passportId}/form-submission`);
        assert.equal(r.body.original["contact.address"], "1 old road", "what the form was prefilled with");
        assert.equal(r.body.original["basic.surname"], "De Soysa");
        assert.ok(r.body.changed.includes("contact.address"), "1 old road -> 12 GALLE ROAD");
        assert.ok(!r.body.changed.includes("basic.surname"), "same text in capitals is not a change");
        assert.ok(!r.body.changed.includes("basic.birthPlace"), "NEGOMBO vs Negombo is not a change");
        assert.ok(r.body.changed.includes("guardian.name"), "new information is a change from empty");
    });

    test("ADMIN-FORM-010 reading and submitting never overwrite the candidate record", async () => {
        const before = JSON.stringify(await prisma.candidate.findUnique({ where: { passportId: A.passportId } }));
        await submitAs(A);
        await admin(USERS.ADMIN, `/candidates/${A.passportId}/form-submission`);
        assert.equal(JSON.stringify(await prisma.candidate.findUnique({ where: { passportId: A.passportId } })), before);
        assert.equal(await prisma.candidateAdditionalDetails.count(), 0);
    });

    test("roles and scope: staff roles read it; an Analyst only for their own candidates; unknown ids 404; the route is read only", async () => {
        await submitAs(A);
        assert.equal((await admin(USERS.DESK, `/candidates/${A.passportId}/form-submission`)).status, 200);
        assert.equal((await admin(USERS.ANN, `/candidates/${A.passportId}/form-submission`)).status, 200);
        assert.equal((await admin(USERS.BEN, `/candidates/${A.passportId}/form-submission`)).status, 404, "not Ben's candidate");
        assert.equal((await admin(USERS.ADMIN, "/candidates/N0000000/form-submission")).status, 404);
        assert.equal((await call(app(USERS.ADMIN), "POST", `/api/admin/candidates/${A.passportId}/form-submission`, { body: {} })).status, 404);
    });

    test("ADMIN-FORM-011 the public API gains nothing: no route returns the submission, the form response holds only the caller's own prefill, a candidate token can't reach the Admin route", async () => {
        await submitAs(A);
        for (const path of ["/form-submission", "/submission", "/response"]) assert.equal((await pub(path, { body: {} })).status, 404, path);
        assert.equal((await call(app(USERS.ADMIN), "GET", `${PUBLIC_CANDIDATE_DETAILS_PATH}/form-submission`)).status, 404);
        // B's form response (before submitting) has only B's own prefill, nothing of A's submission.
        const link = (await call(app(USERS.ADMIN), "POST", `/api/admin/candidates/${B.passportId}/form-share`)).body.url.split("#k=")[1];
        const token = (await pub("/verify", { body: { linkSecret: link, passportNumber: B.passportId, nic: B.nic } })).body.token;
        const form = await pub("/form", { token, body: {} });
        assert.deepEqual(Object.keys(form.body).sort(), ["answers", "draftSavedAt", "expiresAt", "identity", "jobCategories", "prefilled", "savedSteps"]);
        const text = JSON.stringify(form.body);
        assert.ok(!text.includes("KAMAL PERERA") && !text.includes("901234567V") && !text.includes(A.passportId));
    });
});
