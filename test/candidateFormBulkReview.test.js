// Confirm All / Reject All of the candidate-submitted changes: one transaction per request, the same
// per-field rules, review rows and audit entries as Confirm / Reject, all or nothing.
// Real PostgreSQL (PGlite, every migration), real Prisma client and routers.
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
const USERS = {
    ADMIN: user("u-admin", "ADMIN", 1), OWNER: user("u-owner", "OWNER", 2), DESK: user("u-desk", "REGISTRATION_DESK", 3), ANN: user("u-ann", "ANALYST", 4),
    LEAD: user("u-lead", "TEAM_LEAD", 5), JOBS: user("u-jobs", "JOB_HANDLER", 6),
};
const A = {
    passportId: "N6200001", uniqueId: "6201", firstName: "Anusha", otherName: "De Soysa", nic: "620000001V", sex: "F", address: "1 old road", placeOfBirth: "Negombo",
    whatsappNumber: "+94762000001", contactNumber: "0771234567", dateOfBirth: new Date("2003-06-05"), jobExperience: "3 years", passportIssueDate: new Date("2020-01-15"), passportExpiryDate: new Date("2030-01-14"),
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
const confirmAll = (who, body) => call(app(who), "POST", `${ROOT}/confirm-all`, { body });
const rejectAll = (who, body) => call(app(who), "POST", `${ROOT}/reject-all`, { body });
const confirm = (who, body) => call(app(who), "POST", `${ROOT}/confirm-field`, { body });
const reject = (who, body) => call(app(who), "POST", `${ROOT}/reject-field`, { body });
const pub = (path, options) => call(app(USERS.ADMIN), "POST", `${PUBLIC_CANDIDATE_DETAILS_PATH}${path}`, options);
const candidateRow = () => prisma.candidate.findUnique({ where: { passportId: A.passportId } });
const detailsRow = () => prisma.candidateAdditionalDetails.findUnique({ where: { passportId: A.passportId } });
const responseRow = () => prisma.candidateFormResponse.findUnique({ where: { passportId: A.passportId } });
const reviews = async () => Object.fromEntries((await prisma.candidateFormFieldReview.findMany()).map((r) => [r.fieldKey, r.status]));
const decisionAudits = () => prisma.auditLog.findMany({ where: { action: { in: ["CANDIDATE_FORM_FIELD_CONFIRMED", "CANDIDATE_FORM_FIELD_REJECTED"] } } });
const seenBody = (pending) => ({ changes: pending.map((p) => ({ field: p.field, expectedCurrentValue: p.current, expectedSubmittedValue: p.submitted })) });
const seen = async () => seenBody((await view()).body.pending);

const answers = (overrides = {}) => {
    const base = {
        basic: { fullName: "anusha de soysa", surname: "de soysa", otherNames: "anusha", sex: "FEMALE", civilStatus: "SINGLE", birthDate: "2003-05-06", birthPlace: "negombo", bloodGroup: "O+", height: "175 cm", weight: "70", drivingLicence: "YES", canReadDrawings: "NO", teamLeadingSkills: "YES", otherLanguages: "english, romanian" },
        contact: { address: "12 galle road", city: "negombo", district: "gampaha", dsDivision: "negombo", gnDivision: "kurana", alternativePhone: "+94 77 123 4567", email: "new@example.com", cityInRomania: "cluj napoca" },
        passport: { issueDate: "2020-01-15", expiryDate: "2031-02-03" },
        qualifications: { jobCategory: "WELDER TIG", jobCategoryOther: "", experience: "3 years", otherSkills1: "n/a", otherSkills2: "N/A", englishKnowledge: "GOOD" },
        measurements: { shirtSize: "M", waistSize: "32", shoeSize: "42" },
        family: {
            father: { name: "sunil", surname: "de soysa", passportNumber: "N/A", birthDate: "1960-03-02" }, mother: { name: "kumari", surname: "de soysa", passportNumber: "N/A", birthDate: "1965-02-03" },
            spouse: { name: "", surname: "", passportNumber: "", birthDate: "" }, child1: "N/A", child2: "", child3: "", fatherAlive: "YES", motherAlive: "YES",
        },
        guardian: { name: "kamal perera", relationship: "uncle", nic: "901234567v", birthDate: "1960-01-01", phone: "+94 77 123 4567", address: "45 lake road" },
    };
    for (const [group, values] of Object.entries(overrides)) base[group] = { ...base[group], ...values };
    return base;
};
async function submitForm(values = answers()) {
    const link = (await call(app(USERS.ADMIN), "POST", `/api/admin/candidates/${A.passportId}/form-share`)).body.url.split("#k=")[1];
    const token = (await pub("/verify", { body: { linkSecret: link, passportNumber: A.passportId, nic: A.nic } })).body.token;
    assert.equal((await pub("/form", { token, body: {} })).status, 200);
    const r = await pub("/submit", { token, body: { answers: values, idempotencyKey: "key-0000000000000001" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return token;
}

describe("Confirm All (BULK-001 .. 006)", () => {
    test("applies every pending change through the per-field rules; reviews CONFIRMED; one audit entry per field marked (Confirm All); the submission is untouched", async () => {
        await submitForm();
        const before = (await view()).body;
        assert.ok(before.pending.length > 10, "a fresh submission has many pending changes");
        const responseBefore = JSON.stringify(await responseRow());
        const r = await confirmAll(USERS.OWNER, seenBody(before.pending));
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(r.body.pending, [], "nothing is left to review");
        assert.deepEqual(Object.keys(await reviews()).sort(), before.pending.map((p) => p.field).sort());
        assert.ok(Object.values(await reviews()).every((status) => status === "CONFIRMED"));
        // Main candidate record and Additional details, written as the single Confirm writes them.
        const c = await candidateRow();
        assert.deepEqual([c.address, c.dateOfBirth.toISOString().slice(0, 10), c.passportExpiryDate.toISOString().slice(0, 10), c.job], ["12 GALLE ROAD", "2003-05-06", "2031-02-03", "WELDER TIG"]);
        const d = await detailsRow();
        assert.deepEqual([d.shoeSize, d.tshirtSize, d.bloodGroup, d.email, d.guardianName, d.guardianNic, d.drivingLicence, String(d.weightKg)], ["42", "M", "O+", "new@example.com", "KAMAL PERERA", "901234567V", true, "70"]);
        assert.equal(JSON.stringify(await responseRow()), responseBefore, "candidate_form_response is exactly as submitted");
        // Audit: one CONFIRMED entry per field, by the actor, for the candidate, with the field and its old -> new values.
        const audits = await decisionAudits();
        assert.equal(audits.length, before.pending.length);
        assert.ok(audits.every((a) => a.action === "CANDIDATE_FORM_FIELD_CONFIRMED" && a.adminId === USERS.OWNER.adminId && a.passportId === A.passportId && a.reason.endsWith("(Confirm All)")));
        const address = audits.find((a) => a.reason.includes("contact.address"));
        assert.deepEqual([JSON.parse(address.previousValue), JSON.parse(address.newValue)], [{ address: "1 old road" }, { address: "12 GALLE ROAD" }]);
        // The refreshed view: every reviewable field now shows the record's value.
        assert.equal(r.body.current["contact.email"], "new@example.com");
        assert.equal(r.body.current["measurements.shoeSize"], "42");
    });

    test("already-reviewed changes are not reprocessed: a rejected field stays rejected and its record value unchanged", async () => {
        await submitForm();
        const address = (await view()).body.pending.find((p) => p.field === "contact.address");
        assert.equal((await reject(USERS.ADMIN, { field: address.field, expectedCurrentValue: address.current, expectedSubmittedValue: address.submitted })).status, 200);
        const pending = (await view()).body.pending;
        assert.equal(pending.find((p) => p.field === "contact.address"), undefined);
        assert.equal((await confirmAll(USERS.ADMIN, seenBody(pending))).status, 200);
        assert.equal((await candidateRow()).address, "1 old road");
        assert.equal((await reviews())["contact.address"], "REJECTED");
        assert.equal((await prisma.auditLog.count({ where: { reason: { contains: "contact.address" } } })), 1, "only the earlier single Reject");
    });

    test("Civil Status is applied first: a submitted MARRIED with a spouse is confirmed together with the spouse fields", async () => {
        await prisma.candidateAdditionalDetails.create({ data: { passportId: A.passportId, maritalStatus: "SINGLE" } });
        await submitForm(answers({ basic: { civilStatus: "MARRIED" }, family: { spouse: { name: "nimali", surname: "perera", passportNumber: "N7654321", birthDate: "1998-04-03" } } }));
        const pending = (await view()).body.pending;
        assert.ok(["basic.civilStatus", "family.spouse.fullName", "family.spouse.passportNumber", "family.spouse.birthDate"].every((f) => pending.some((p) => p.field === f)));
        const r = await confirmAll(USERS.ADMIN, seenBody(pending));
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const d = await detailsRow();
        assert.deepEqual([d.maritalStatus, d.wifeFullName, d.spousePassportNumber, d.wifeBirthday.toISOString().slice(0, 10)], ["MARRIED", "NIMALI PERERA", "N7654321", "1998-04-03"]);
        assert.deepEqual(r.body.pending, []);
    });

    test("all or nothing: one field whose rules refuse it rolls the whole request back (409 FORM_FIELD_PREREQUISITE, nothing written)", async () => {
        // The record has a child; the candidate says Single: confirming Single must be refused.
        await prisma.candidateAdditionalDetails.create({ data: { passportId: A.passportId, maritalStatus: "WIDOWED", child1Name: "KASUN" } });
        await submitForm();
        const candidateBefore = JSON.stringify(await candidateRow());
        const detailsBefore = JSON.stringify(await detailsRow());
        const pending = (await view()).body.pending;
        assert.ok(pending.some((p) => p.field === "basic.civilStatus"));
        const r = await confirmAll(USERS.ADMIN, seenBody(pending));
        assert.deepEqual([r.status, r.body.code], [409, "FORM_FIELD_PREREQUISITE"]);
        assert.match(r.body.message, /^Nothing was confirmed \(basic\.civilStatus\)/);
        assert.equal(JSON.stringify(await candidateRow()), candidateBefore);
        assert.equal(JSON.stringify(await detailsRow()), detailsBefore);
        assert.deepEqual(await reviews(), {});
        assert.equal((await decisionAudits()).length, 0);
        // The same changes are still pending; that one can be decided on its own, then Confirm All works.
        const civil = pending.find((p) => p.field === "basic.civilStatus");
        assert.equal((await reject(USERS.ADMIN, { field: civil.field, expectedCurrentValue: civil.current, expectedSubmittedValue: civil.submitted })).status, 200);
        assert.equal((await confirmAll(USERS.ADMIN, await seen())).status, 200);
        assert.equal((await detailsRow()).maritalStatus, "WIDOWED");
    });

    test("a stale screen refuses the whole request: a change missing, an extra one, a different value, a duplicate (409 FORM_FIELD_STALE, nothing written)", async () => {
        await submitForm();
        const { changes } = await seen();
        const variants = [
            { changes: changes.slice(1) },
            { changes: [...changes.slice(0, -1), changes[0]] },
            { changes: changes.map((c, i) => (i === 0 ? { ...c, expectedSubmittedValue: "SOMETHING ELSE" } : c)) },
            { changes: changes.map((c, i) => (i === 0 ? { ...c, expectedCurrentValue: "OLD THING" } : c)) },
        ];
        for (const body of variants) {
            const r = await confirmAll(USERS.ADMIN, body);
            assert.deepEqual([r.status, r.body.code], [409, "FORM_FIELD_STALE"]);
        }
        // The record changed after the screen loaded.
        await prisma.candidate.update({ where: { passportId: A.passportId }, data: { address: "77 newer street" } });
        assert.equal((await confirmAll(USERS.ADMIN, { changes })).body.code, "FORM_FIELD_STALE");
        assert.equal((await rejectAll(USERS.ADMIN, { changes })).body.code, "FORM_FIELD_STALE");
        assert.deepEqual(await reviews(), {});
        assert.equal((await decisionAudits()).length, 0);
    });

    test("double submit: two Confirm All at once give one winner; the other is refused and nothing is decided twice", async () => {
        await submitForm();
        const body = await seen();
        const results = await Promise.all([confirmAll(USERS.ADMIN, body), confirmAll(USERS.OWNER, body), rejectAll(USERS.ADMIN, body)]);
        assert.equal(results.filter((r) => r.status === 200).length, 1);
        assert.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 409 && ["FORM_FIELD_STALE", "FORM_FIELD_NOT_PENDING"].includes(r.body.code)));
        assert.equal(await prisma.candidateFormFieldReview.count(), body.changes.length);
        assert.equal((await decisionAudits()).length, body.changes.length);
    });

    test("nothing pending: 409 FORM_FIELD_NOT_PENDING; no submission: 409 NO_SUBMISSION", async () => {
        const one = { changes: [{ field: "basic.birthDate", expectedCurrentValue: "2003-06-05", expectedSubmittedValue: "2003-05-06" }] };
        assert.equal((await confirmAll(USERS.ADMIN, one)).body.code, "NO_SUBMISSION");
        await submitForm();
        assert.equal((await confirmAll(USERS.ADMIN, await seen())).status, 200);
        assert.equal((await confirmAll(USERS.ADMIN, one)).body.code, "FORM_FIELD_NOT_PENDING");
        assert.equal((await rejectAll(USERS.ADMIN, one)).body.code, "FORM_FIELD_NOT_PENDING");
    });
});

describe("Reject All (BULK-007 .. 009)", () => {
    test("rejects every pending change, changes nothing in the record, audits each field (Reject All); reviewed ones stay as they were", async () => {
        await submitForm();
        const birth = (await view()).body.pending.find((p) => p.field === "basic.birthDate");
        assert.equal((await confirm(USERS.ADMIN, { field: birth.field, expectedCurrentValue: birth.current, expectedSubmittedValue: birth.submitted })).status, 200);
        const candidateBefore = JSON.stringify(await candidateRow());
        const detailsBefore = JSON.stringify(await detailsRow());
        const pending = (await view()).body.pending;
        const r = await rejectAll(USERS.ADMIN, seenBody(pending));
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(r.body.pending, []);
        assert.equal(JSON.stringify(await candidateRow()), candidateBefore, "the main record is unchanged");
        assert.equal(JSON.stringify(await detailsRow()), detailsBefore, "Additional details are unchanged");
        const decided = await reviews();
        assert.equal(decided["basic.birthDate"], "CONFIRMED", "the earlier Confirm is kept");
        assert.ok(pending.every((p) => decided[p.field] === "REJECTED"));
        const audits = (await decisionAudits()).filter((a) => a.action === "CANDIDATE_FORM_FIELD_REJECTED");
        assert.equal(audits.length, pending.length);
        assert.ok(audits.every((a) => a.reason.endsWith("(Reject All)") && a.adminId === USERS.ADMIN.adminId));
        const shoe = audits.find((a) => a.reason.includes("measurements.shoeSize"));
        assert.deepEqual(JSON.parse(shoe.newValue), { field: "measurements.shoeSize", currentValue: null, rejectedSubmittedValue: "42" });
    });
});

describe("RBAC and request shape (BULK-010 .. 012)", () => {
    test("ADMIN and OWNER may; TEAM_LEAD, ANALYST, REGISTRATION_DESK and JOB_HANDLER get 403 and nothing is decided", async () => {
        await submitForm();
        const body = await seen();
        for (const who of [USERS.LEAD, USERS.ANN, USERS.DESK, USERS.JOBS]) {
            assert.equal((await confirmAll(who, body)).status, 403, who.role);
            assert.equal((await rejectAll(who, body)).status, 403, who.role);
        }
        assert.deepEqual(await reviews(), {});
        assert.equal((await decisionAudits()).length, 0);
        // The roles that can read the submission still can (unchanged).
        for (const who of [USERS.LEAD, USERS.ANN, USERS.JOBS]) assert.equal((await view(who)).status, 200, who.role);
        assert.equal((await rejectAll(USERS.OWNER, body)).status, 200);
    });

    test("only { changes: [{ field, expectedCurrentValue, expectedSubmittedValue }] } with known field keys is accepted (400 otherwise)", async () => {
        await submitForm();
        const { changes } = await seen();
        for (const bad of [{}, { changes: [] }, { changes: "x" }, { changes, extra: 1 }, { changes: [{ ...changes[0], value: "X" }] }, { changes: [{ ...changes[0], field: "candidate.passportId" }] }, { changes: [{ ...changes[0], expectedCurrentValue: 3 }] }, [changes]]) {
            assert.equal((await confirmAll(USERS.ADMIN, bad)).status, 400, JSON.stringify(bad).slice(0, 80));
        }
        assert.deepEqual(await reviews(), {});
    });

    test("the public Candidate Form API has no bulk review", async () => {
        const token = await submitForm();
        const body = await seen();
        for (const path of ["/confirm-all", "/reject-all", "/form-submission/confirm-all"]) assert.equal((await pub(path, { body, token })).status, 404, path);
        assert.deepEqual(await reviews(), {});
    });
});

describe("Admin view: the record's value of every reviewable field (FIELD-MAP)", () => {
    test("current holds the record value of each reviewable field, so the fields with no Admin form can be compared old -> new", async () => {
        await prisma.candidateAdditionalDetails.create({ data: { passportId: A.passportId, email: "old@example.com", guardianName: "OLD GUARDIAN", shoeSize: "9" } });
        await submitForm();
        const { body } = await view();
        assert.deepEqual(
            [body.current["contact.email"], body.current["guardian.name"], body.current["basic.bloodGroup"], body.current["measurements.shoeSize"], body.current["contact.address"]],
            ["old@example.com", "OLD GUARDIAN", null, "9", "1 old road"],
        );
        const email = body.pending.find((p) => p.field === "contact.email");
        assert.deepEqual([email.current, email.submitted], ["old@example.com", "new@example.com"]);
        // A UK size on record is a change against the EU size submitted; it is offered, never converted.
        assert.deepEqual(body.pending.find((p) => p.field === "measurements.shoeSize"), { field: "measurements.shoeSize", current: "9", submitted: "42" });
        // Individual Confirm / Reject still work on these fields, and current follows.
        assert.equal((await confirm(USERS.ADMIN, { field: "contact.email", expectedCurrentValue: "old@example.com", expectedSubmittedValue: "new@example.com" })).body.current["contact.email"], "new@example.com");
        assert.equal((await reject(USERS.ADMIN, { field: "guardian.name", expectedCurrentValue: "OLD GUARDIAN", expectedSubmittedValue: "KAMAL PERERA" })).body.current["guardian.name"], "OLD GUARDIAN");
    });

    test("no submission: current is null", async () => {
        assert.equal((await view()).body.current, null);
    });
});
