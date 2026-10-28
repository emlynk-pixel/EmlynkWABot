// Per-field Reject ("Revoke") of a candidate-submitted value, sharing one review model with Confirm
// (candidate_form_field_review). Real PostgreSQL (PGlite, every migration), real Prisma client and routers.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createPublicCandidateDetailsRouter, PUBLIC_CANDIDATE_DETAILS_PATH } from "../src/routes/publicCandidateDetails.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

const SECRET = "test-candidate-form-secret-0123456789-abcdefghijklmnop";
const ORIGIN = "https://candidate-form.example.test";
const user = (adminId, role, n) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const USERS = { ADMIN: user("u-admin", "ADMIN", 1), MANAGER: user("u-manager", "MANAGER", 2), DESK: user("u-desk", "REGISTRATION_DESK", 3), ANN: user("u-ann", "ANALYST", 4), BEN: user("u-ben", "ANALYST", 5) };
const A = {
    passportId: "N6100001", uniqueId: "6101", firstName: "Anusha", otherName: "De Soysa", nic: "610000001V", sex: "F", address: "1 old road", placeOfBirth: "Negombo",
    whatsappNumber: "+94761000001", contactNumber: "0771234567", dateOfBirth: new Date("2003-06-05"), jobExperience: "3 years", passportIssueDate: new Date("2020-01-15"), passportExpiryDate: new Date("2030-01-14"),
};

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
        DELETE FROM "rate_limits"; DELETE FROM "candidate_form_field_review"; DELETE FROM "candidate_form_response"; DELETE FROM "candidate_form_prefill_snapshot"; DELETE FROM "candidate_form_access"; DELETE FROM "candidate_form_link";
        DELETE FROM "candidate_allocation"; DELETE FROM "candidate_additional_details"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
    `);
    await prisma.candidate.create({ data: A });
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
const ROOT = `/api/admin/candidates/${A.passportId}/form-submission`;
const view = (who = USERS.ADMIN) => call(app(who), "GET", ROOT);
const reject = (who, body, id = A.passportId) => call(app(who), "POST", `/api/admin/candidates/${id}/form-submission/reject-field`, { body });
const confirm = (who, body) => call(app(who), "POST", `${ROOT}/confirm-field`, { body });
const pub = (path, options) => call(app(USERS.ADMIN), "POST", `${PUBLIC_CANDIDATE_DETAILS_PATH}${path}`, options);
const candidateRow = () => prisma.candidate.findUnique({ where: { passportId: A.passportId } });
const responseRow = () => prisma.candidateFormResponse.findUnique({ where: { passportId: A.passportId } });
const reviewOf = (field) => prisma.candidateFormFieldReview.findUnique({ where: { passportId_fieldKey: { passportId: A.passportId, fieldKey: field } } });
const pendingOf = (r) => Object.fromEntries(r.body.pending.map((p) => [p.field, p]));

const answers = () => ({
    basic: { fullName: "anusha de soysa", surname: "de soysa", otherNames: "anusha", sex: "FEMALE", civilStatus: "SINGLE", birthDate: "2003-05-06", birthPlace: "negombo", bloodGroup: "O+", height: "175 cm", weight: "70", drivingLicence: "YES", canReadDrawings: "NO", teamLeadingSkills: "YES", otherLanguages: "english, romanian" },
    contact: { address: "12 galle road", city: "negombo", district: "gampaha", dsDivision: "negombo", gnDivision: "kurana", alternativePhone: "+94 77 123 4567", email: "new@example.com", cityInRomania: "cluj napoca" },
    passport: { issueDate: "2020-01-15", expiryDate: "2031-02-03" },
    qualifications: { jobCategory: "WELDER TIG", jobCategoryOther: "", experience: "3 years", otherSkills1: "n/a", otherSkills2: "N/A", englishKnowledge: "GOOD" },
    measurements: { shirtSize: "M", waistSize: "32", shoeSize: "eu 42" },
    family: {
        father: { name: "sunil", surname: "de soysa", passportNumber: "N/A", birthDate: "1960-03-02" }, mother: { name: "kumari", surname: "de soysa", passportNumber: "N/A", birthDate: "1965-02-03" },
        spouse: { name: "", surname: "", passportNumber: "", birthDate: "" }, child1: "N/A", child2: "", child3: "", fatherAlive: "YES", motherAlive: "YES",
    },
    guardian: { name: "kamal perera", relationship: "uncle", nic: "901234567v", birthDate: "1960-01-01", phone: "+94 77 123 4567", address: "45 lake road" },
});
async function submitForm() {
    const link = (await call(app(USERS.ADMIN), "POST", `/api/admin/candidates/${A.passportId}/form-share`)).body.url.split("#k=")[1];
    const token = (await pub("/verify", { body: { linkSecret: link, passportNumber: A.passportId, nic: A.nic } })).body.token;
    assert.equal((await pub("/form", { token, body: {} })).status, 200);
    const r = await pub("/submit", { token, body: { answers: answers(), idempotencyKey: "key-0000000000000001" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return token;
}
const body = async (field) => {
    const p = pendingOf(await view())[field];
    return { field, expectedCurrentValue: p.current, expectedSubmittedValue: p.submitted };
};

describe("Reject (Revoke) keeps the record, records the decision (REJECT-003 .. 009, 013)", () => {
    test("rejecting Birthday: the record and the response are unchanged, the review is REJECTED, only that hint goes, the audit entry is written", async () => {
        await submitForm();
        const candidateBefore = JSON.stringify(await candidateRow());
        const responseBefore = JSON.stringify(await responseRow());
        const r = await reject(USERS.MANAGER, await body("basic.birthDate"));
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(JSON.stringify(await candidateRow()), candidateBefore, "canonical record is exactly as it was");
        assert.equal(JSON.stringify(await responseRow()), responseBefore, "candidate_form_response is exactly as submitted");
        const review = await reviewOf("basic.birthDate");
        assert.deepEqual([review.status, review.submittedValue, review.currentValue, review.reviewedById], ["REJECTED", "2003-05-06", "2003-06-05", USERS.MANAGER.adminId]);
        // The refreshed state: Birthday is no longer pending (and shows as reviewed); Address and the others remain pending.
        const pending = pendingOf(r);
        assert.equal(pending["basic.birthDate"], undefined);
        assert.equal(pending["contact.address"].submitted, "12 GALLE ROAD");
        assert.ok(pending["passport.expiryDate"]);
        assert.deepEqual(r.body.reviews, [{ field: "basic.birthDate", status: "REJECTED" }]);
        // Audit: actor, candidate, field, current value and the rejected submitted value; never a secret.
        const [audit] = await prisma.auditLog.findMany({ where: { action: "CANDIDATE_FORM_FIELD_REJECTED" } });
        assert.deepEqual([audit.adminId, audit.passportId, audit.newStatus], [USERS.MANAGER.adminId, A.passportId, "REJECTED"]);
        assert.deepEqual(JSON.parse(audit.newValue), { field: "basic.birthDate", currentValue: "2003-06-05", rejectedSubmittedValue: "2003-05-06" });
        assert.ok(audit.createdDate);
        assert.equal(await prisma.auditLog.count({ where: { action: "CANDIDATE_FORM_FIELD_CONFIRMED" } }), 0);
    });

    test("REJECT-008 Confirm still works on another field, and the two decisions are independent", async () => {
        await submitForm();
        assert.equal((await reject(USERS.ADMIN, await body("basic.birthDate"))).status, 200);
        const c = await confirm(USERS.ADMIN, await body("contact.address"));
        assert.equal(c.status, 200);
        assert.equal((await candidateRow()).address, "12 GALLE ROAD");
        assert.equal((await candidateRow()).dateOfBirth.toISOString().slice(0, 10), "2003-06-05", "the rejected field was not applied");
        assert.deepEqual((await prisma.candidateFormFieldReview.findMany({ orderBy: { fieldKey: "asc" } })).map((r) => [r.fieldKey, r.status]), [["basic.birthDate", "REJECTED"], ["contact.address", "CONFIRMED"]]);
        assert.deepEqual(Object.fromEntries(c.body.reviews.map((x) => [x.field, x.status])), { "basic.birthDate": "REJECTED", "contact.address": "CONFIRMED" });
    });

    test("REJECT-009 a field is never both CONFIRMED and REJECTED: a decision is final in the API and in the database", async () => {
        await submitForm();
        const seen = await body("contact.address");
        assert.equal((await reject(USERS.ADMIN, seen)).status, 200);
        // Confirm after Reject: refused, nothing applied.
        const again = await confirm(USERS.MANAGER, seen);
        assert.deepEqual([again.status, again.body.code], [409, "FORM_FIELD_REVIEW_STALE"]);
        assert.equal((await candidateRow()).address, "1 old road");
        assert.equal((await reviewOf("contact.address")).status, "REJECTED");
        // Reject twice: refused.
        assert.equal((await reject(USERS.MANAGER, seen)).body.code, "FORM_FIELD_REVIEW_STALE");
        // Confirm then Reject: nothing left to review (the record equals the submitted value).
        const birth = await body("basic.birthDate");
        assert.equal((await confirm(USERS.ADMIN, birth)).status, 200);
        assert.equal((await reject(USERS.ADMIN, birth)).body.code, "FORM_FIELD_NOT_PENDING");
        assert.equal((await reviewOf("basic.birthDate")).status, "CONFIRMED");
        // Even if staff later edit the record again, a decided field does not come back as pending.
        await prisma.candidate.update({ where: { passportId: A.passportId }, data: { dateOfBirth: new Date("1999-01-01") } });
        await prisma.candidate.update({ where: { passportId: A.passportId }, data: { address: "9 changed road" } });
        const pending = pendingOf(await view());
        assert.equal(pending["basic.birthDate"], undefined);
        assert.equal(pending["contact.address"], undefined);
        const stale = await confirm(USERS.ADMIN, { field: "contact.address", expectedCurrentValue: "9 changed road", expectedSubmittedValue: "12 GALLE ROAD" });
        assert.equal(stale.status, 409);
        // The database itself: one decision per field, immutable, only the two statuses.
        await assert.rejects(pg.exec(`INSERT INTO "candidate_form_field_review" ("passport_id","field_key","status","reviewed_by") VALUES ('${A.passportId}','contact.address','CONFIRMED','u-admin')`), /duplicate|unique|pkey/i);
        await assert.rejects(pg.exec(`UPDATE "candidate_form_field_review" SET "status" = 'CONFIRMED' WHERE "field_key" = 'contact.address'`), /cannot be changed/);
        await assert.rejects(pg.exec(`INSERT INTO "candidate_form_field_review" ("passport_id","field_key","status","reviewed_by") VALUES ('${A.passportId}','basic.surname','PENDING','u-admin')`), /check/i);
    });
});

describe("stale and concurrent reviews (REJECT-010)", () => {
    test("the record changed since the screen loaded: 409 FORM_FIELD_STALE, nothing recorded", async () => {
        await submitForm();
        const seen = await body("contact.address");
        await prisma.candidate.update({ where: { passportId: A.passportId }, data: { address: "77 newer street" } });
        const r = await reject(USERS.ADMIN, seen);
        assert.deepEqual([r.status, r.body.code], [409, "FORM_FIELD_STALE"]);
        assert.equal(await reviewOf("contact.address"), null);
        assert.equal(await prisma.auditLog.count({ where: { action: "CANDIDATE_FORM_FIELD_REJECTED" } }), 0);
        const wrongSubmitted = await reject(USERS.ADMIN, { ...(await body("contact.address")), expectedSubmittedValue: "SOMETHING ELSE" });
        assert.equal(wrongSubmitted.body.code, "FORM_FIELD_STALE");
    });

    test("another Admin decided it first: 409 FORM_FIELD_REVIEW_STALE and no silent overwrite; two at once give one winner", async () => {
        await submitForm();
        const seen = await body("passport.expiryDate");
        const results = await Promise.all([reject(USERS.ADMIN, seen), reject(USERS.MANAGER, seen), confirm(USERS.ADMIN, seen)]);
        assert.equal(results.filter((r) => r.status === 200).length, 1);
        assert.ok(results.filter((r) => r.status === 409).every((r) => ["FORM_FIELD_REVIEW_STALE", "FORM_FIELD_NOT_PENDING"].includes(r.body.code)));
        assert.equal(await prisma.candidateFormFieldReview.count({ where: { fieldKey: "passport.expiryDate" } }), 1);
        const decisions = await prisma.auditLog.count({ where: { action: { in: ["CANDIDATE_FORM_FIELD_CONFIRMED", "CANDIDATE_FORM_FIELD_REJECTED"] } } });
        assert.equal(decisions, 1);
    });
});

describe("roles, allowlist and the public API (REJECT-011, 012, 014, 015)", () => {
    test("ADMIN and MANAGER reject; Analyst and Registration Desk cannot", async () => {
        await submitForm();
        const seen = await body("contact.address");
        for (const who of [USERS.ANN, USERS.DESK, USERS.BEN]) assert.equal((await reject(who, seen)).status, 403, who.role);
        assert.equal(await reviewOf("contact.address"), null);
        assert.equal((await reject(USERS.ADMIN, seen)).status, 200);
        assert.equal((await reject(USERS.MANAGER, await body("basic.birthDate"))).status, 200);
        assert.equal((await reject(USERS.ADMIN, { field: "basic.birthDate", expectedCurrentValue: null, expectedSubmittedValue: null }, "N9999999")).status, 404);
        // They still see the pending changes (Analyst within their scope).
        assert.ok((await view(USERS.ANN)).body.pending.length > 0);
    });

    test("unknown and unmapped fields are rejected, and the browser cannot supply a table, a column or a value", async () => {
        await submitForm();
        for (const field of ["family.father.name", "family.mother.surname", "candidate.passportId", "passportId", "__proto__", "constructor", "basic.birthDate ", ""]) {
            assert.deepEqual([(await reject(USERS.ADMIN, { field, expectedCurrentValue: null, expectedSubmittedValue: null })).body.code], ["FIELD_NOT_CONFIRMABLE"], JSON.stringify(field));
        }
        const seen = await body("contact.address");
        for (const extra of [{ value: "X" }, { newValue: "X" }, { table: "user" }, { column: "role" }, { status: "CONFIRMED" }, { decision: "CONFIRMED" }]) {
            assert.equal((await reject(USERS.ADMIN, { ...seen, ...extra })).status, 400, JSON.stringify(extra));
        }
        for (const bad of [{}, { field: 3 }, "x", null]) assert.equal((await reject(USERS.ADMIN, bad)).status, 400);
        assert.equal(await prisma.candidateFormFieldReview.count(), 0);
        assert.equal(await prisma.user.count(), 5);
    });

    test("no submission: nothing to reject; and the public Candidate Form API cannot reject", async () => {
        assert.equal((await reject(USERS.ADMIN, { field: "basic.birthDate", expectedCurrentValue: null, expectedSubmittedValue: "2003-05-06" })).body.code, "NO_SUBMISSION");
        const token = await submitForm();
        const seen = await body("contact.address");
        for (const path of ["/reject-field", "/form-submission/reject-field", `/candidates/${A.passportId}/form-submission/reject-field`]) {
            assert.equal((await pub(path, { body: seen })).status, 404, path);
            assert.equal((await pub(path, { body: seen, token })).status, 404, path);
        }
        assert.equal(await prisma.candidateFormFieldReview.count(), 0);
    });
});
