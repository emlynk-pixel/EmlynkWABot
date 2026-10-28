// Per-field "Confirm candidate change": the server-side allowlist, the single-column
// update, stale-write protection, roles and audit. Real PostgreSQL (PGlite, every
// migration), real Prisma client and routers. No Supabase.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createPublicCandidateDetailsRouter, PUBLIC_CANDIDATE_DETAILS_PATH } from "../src/routes/publicCandidateDetails.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { CONFIRMABLE_FIELDS } from "../src/services/candidateFormFieldConfirmService.js";

const SECRET = "test-candidate-form-secret-0123456789-abcdefghijklmnop";
const ORIGIN = "https://candidate-form.example.test";
const user = (adminId, role, n) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const USERS = { ADMIN: user("u-admin", "ADMIN", 1), MANAGER: user("u-manager", "MANAGER", 2), DESK: user("u-desk", "REGISTRATION_DESK", 3), ANN: user("u-ann", "ANALYST", 4), BEN: user("u-ben", "ANALYST", 5) };
const A = {
    passportId: "N6000001", uniqueId: "6001", firstName: "Anusha", otherName: "De Soysa", nic: "600000001V", sex: "F", address: "1 old road", placeOfBirth: "Negombo",
    whatsappNumber: "+94760000001", contactNumber: "0771234567", dateOfBirth: new Date("2003-06-05"), jobExperience: "3 years", passportIssueDate: new Date("2020-01-15"), passportExpiryDate: new Date("2030-01-14"),
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
        DELETE FROM "rate_limits"; DELETE FROM "candidate_form_response"; DELETE FROM "candidate_form_prefill_snapshot"; DELETE FROM "candidate_form_access"; DELETE FROM "candidate_form_link";
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
const view = (who = USERS.ADMIN) => call(app(who), "GET", `/api/admin/candidates/${A.passportId}/form-submission`);
const confirm = (who, body, id = A.passportId) => call(app(who), "POST", `/api/admin/candidates/${id}/form-submission/confirm-field`, { body });
const pub = (path, options) => call(app(USERS.ADMIN), "POST", `${PUBLIC_CANDIDATE_DETAILS_PATH}${path}`, options);
const candidateRow = () => prisma.candidate.findUnique({ where: { passportId: A.passportId } });
const detailsRow = () => prisma.candidateAdditionalDetails.findUnique({ where: { passportId: A.passportId } });
const responseRow = () => prisma.candidateFormResponse.findUnique({ where: { passportId: A.passportId } });
const pendingOf = (r) => Object.fromEntries(r.body.pending.map((p) => [p.field, p]));

const answers = (overrides = {}) => ({
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
    ...overrides,
});
async function submitForm(body = answers()) {
    const link = (await call(app(USERS.ADMIN), "POST", `/api/admin/candidates/${A.passportId}/form-share`)).body.url.split("#k=")[1];
    const token = (await pub("/verify", { body: { linkSecret: link, passportNumber: A.passportId, nic: A.nic } })).body.token;
    assert.equal((await pub("/form", { token, body: {} })).status, 200);
    const r = await pub("/submit", { token, body: { answers: body, idempotencyKey: "key-0000000000000001" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return token;
}
const pendingFor = async (field) => pendingOf(await view())[field];
const body = async (field) => {
    const p = await pendingFor(field);
    return { field, expectedCurrentValue: p.current, expectedSubmittedValue: p.submitted };
};

describe("which changes are offered (CONFIRM-001, 002, 017)", () => {
    test("a changed mapped field is pending; equal ones, case-only differences and equivalent phone numbers are not; unmapped fields never are", async () => {
        await prisma.candidateAdditionalDetails.create({ data: { passportId: A.passportId, tshirtSize: "S" } });
        await submitForm();
        const pending = pendingOf(await view());
        assert.deepEqual(pending["basic.birthDate"], { field: "basic.birthDate", current: "2003-06-05", submitted: "2003-05-06" });
        assert.deepEqual(pending["contact.address"], { field: "contact.address", current: "1 old road", submitted: "12 GALLE ROAD" });
        assert.deepEqual(pending["measurements.shirtSize"], { field: "measurements.shirtSize", current: "S", submitted: "M" });
        assert.deepEqual(pending["passport.expiryDate"], { field: "passport.expiryDate", current: "2030-01-14", submitted: "2031-02-03" });
        assert.deepEqual(pending["basic.fullName"], { field: "basic.fullName", current: null, submitted: "ANUSHA DE SOYSA" });
        // Same value (CONFIRM-002): surname in capitals, birth place in capitals, sex, issue date, experience, and the same phone number written differently.
        for (const field of ["basic.surname", "basic.otherNames", "basic.birthPlace", "basic.sex", "passport.issueDate", "qualifications.experience", "contact.alternativePhone"]) assert.equal(pending[field], undefined, field);
        // CONFIRM-017: only allowlisted fields are ever offered. Every answer now has a canonical target (Guardian,
        // email, district, civil status, job category, ...); a parent's name is offered as name + surname together,
        // never as the two halves, and an "N/A" answer (children, passports) never.
        for (const field of Object.keys(pending)) assert.ok(Object.hasOwn(CONFIRMABLE_FIELDS, field), field);
        assert.deepEqual(pending["guardian.name"], { field: "guardian.name", current: null, submitted: "KAMAL PERERA" });
        assert.deepEqual(pending["basic.civilStatus"], { field: "basic.civilStatus", current: null, submitted: "SINGLE" });
        assert.deepEqual(pending["family.father.fullName"], { field: "family.father.fullName", current: null, submitted: "SUNIL DE SOYSA" });
        for (const field of ["family.father.name", "family.father.surname", "family.child1", "family.father.passportNumber", "qualifications.otherSkills1"]) assert.equal(pending[field], undefined, field);
    });

    test("nothing is pending before a submission", async () => {
        assert.deepEqual((await view()).body.pending, []);
    });
});

describe("confirming one field (CONFIRM-003, 004, 005, 010, 011, 016)", () => {
    test("Birthday only: the main value updates, the other pending changes stay, the response is unchanged, the audit entry is written, and the hint disappears", async () => {
        await submitForm();
        const responseBefore = JSON.stringify(await responseRow());
        const candidateBefore = await candidateRow();
        const r = await confirm(USERS.MANAGER, await body("basic.birthDate"));
        assert.equal(r.status, 200, JSON.stringify(r.body));
        // Only date_of_birth changed (CONFIRM-016): compare every other column.
        const after = await candidateRow();
        const { dateOfBirth: b1, updatedDate: u1, ...beforeRest } = candidateBefore;
        const { dateOfBirth: b2, updatedDate: u2, ...afterRest } = after;
        assert.equal(b2.toISOString().slice(0, 10), "2003-05-06");
        assert.deepEqual(afterRest, beforeRest);
        assert.equal(await detailsRow(), null, "no additional-details row was created by a core-field confirmation");
        // The returned state is refreshed: Birthday resolved, Address and the rest still pending.
        const pending = pendingOf(r);
        assert.equal(pending["basic.birthDate"], undefined);
        assert.equal(pending["contact.address"].current, "1 old road");
        assert.ok(pending["passport.expiryDate"]);
        assert.equal(JSON.stringify(await responseRow()), responseBefore, "candidate_form_response is exactly as submitted");
        // Audit: who, which candidate, the field, old and new value.
        const [audit] = await prisma.auditLog.findMany({ where: { action: "CANDIDATE_FORM_FIELD_CONFIRMED" } });
        assert.deepEqual([audit.adminId, audit.passportId, audit.previousStatus, audit.newStatus], [USERS.MANAGER.adminId, A.passportId, "PENDING_CONFIRMATION", "CONFIRMED"]);
        assert.deepEqual([JSON.parse(audit.previousValue), JSON.parse(audit.newValue)], [{ dateOfBirth: "2003-06-05" }, { dateOfBirth: "2003-05-06" }]);
        assert.match(audit.reason, /basic\.birthDate/);
        assert.ok(audit.createdDate);
        // A second Confirm of the same field has nothing left to confirm.
        const again = await confirm(USERS.ADMIN, { field: "basic.birthDate", expectedCurrentValue: "2003-05-06", expectedSubmittedValue: "2003-05-06" });
        assert.deepEqual([again.status, again.body.code], [409, "FORM_FIELD_NOT_PENDING"]);
        assert.equal(await prisma.auditLog.count({ where: { action: "CANDIDATE_FORM_FIELD_CONFIRMED" } }), 1);
    });

    test("an additional-details field: only that column is written, and an existing row's other columns are untouched; a missing row is created with that column alone", async () => {
        await prisma.candidateAdditionalDetails.create({ data: { passportId: A.passportId, tshirtSize: "S", pantSize: "30", otherJobSkills: "Forklift" } });
        await submitForm();
        const before = await detailsRow();
        assert.equal((await confirm(USERS.ADMIN, await body("measurements.shirtSize"))).status, 200);
        const after = await detailsRow();
        const strip = ({ tshirtSize, updatedDate, ...rest }) => rest;
        assert.equal(after.tshirtSize, "M");
        assert.deepEqual(strip(after), strip(before), "pantSize, skills, ... unchanged");
        assert.equal(after.pantSize, "30");
        // No details row yet: created with the one column.
        await pg.exec(`DELETE FROM "candidate_additional_details"`);
        assert.equal((await confirm(USERS.ADMIN, await body("basic.fullName"))).status, 200);
        const created = await detailsRow();
        assert.equal(created.nameAsInPassport, "ANUSHA DE SOYSA");
        assert.deepEqual(Object.entries(created).filter(([k, v]) => v !== null && !["passportId", "createdDate", "updatedDate", "nameAsInPassport"].includes(k)), []);
    });

    test("sex is translated to the record's code; the phone keeps its submitted form", async () => {
        await submitForm(answers({ basic: { ...answers().basic, sex: "MALE" }, contact: { ...answers().contact, alternativePhone: "0712345678" } }));
        assert.equal((await pendingFor("basic.sex")).current, "FEMALE");
        assert.equal((await confirm(USERS.ADMIN, await body("basic.sex"))).status, 200);
        assert.equal((await candidateRow()).sex, "M");
        assert.equal((await confirm(USERS.ADMIN, await body("contact.alternativePhone"))).status, 200);
        assert.equal((await candidateRow()).contactNumber, "0712345678");
    });
});

describe("the server decides (CONFIRM-005 to 009)", () => {
    test("CONFIRM-006 / 008 the browser cannot send a replacement value, a table or a column: extra keys are refused and nothing changes", async () => {
        await submitForm();
        const base = await body("contact.address");
        const before = JSON.stringify(await candidateRow());
        for (const extra of [{ value: "HACKED" }, { newValue: "HACKED" }, { table: "user", column: "role" }, { column: "passportId" }, { target: "candidate.nic" }]) {
            const r = await confirm(USERS.ADMIN, { ...base, ...extra });
            assert.equal(r.status, 400, JSON.stringify(extra));
        }
        assert.equal(JSON.stringify(await candidateRow()), before);
        // Whatever the screen claims, the stored response is what is written.
        assert.equal((await confirm(USERS.ADMIN, base)).status, 200);
        assert.equal((await candidateRow()).address, "12 GALLE ROAD");
    });

    test("CONFIRM-007 / 008 unmapped and made-up fields are rejected, including prototype and table-like names", async () => {
        await submitForm();
        const before = JSON.stringify(await candidateRow());
        for (const field of ["family.father.name", "family.father.surname", "family.spouse.name", "basic.nic", "contact.whatsappNumber", "contact.distanceToBucharestKm", "basic.heightCm",
            "candidate.passportId", "passportId", "nic", "user.role", "__proto__", "constructor", "toString", "basic.birthDate ", "BASIC.BIRTHDATE", "basic.birthDate; DROP TABLE candidate", ""]) {
            const r = await confirm(USERS.ADMIN, { field, expectedCurrentValue: null, expectedSubmittedValue: null });
            assert.deepEqual([r.status, r.body.code], [400, "FIELD_NOT_CONFIRMABLE"], JSON.stringify(field));
        }
        for (const bad of [{}, { field: 5 }, { field: ["basic.birthDate"] }, { field: "basic.birthDate", expectedCurrentValue: 3 }, "text", null]) {
            assert.equal((await confirm(USERS.ADMIN, bad)).status, 400, JSON.stringify(bad));
        }
        assert.equal(JSON.stringify(await candidateRow()), before);
        assert.equal(await prisma.user.count(), 5);
        // The name halves, the verified NIC and the derived values are never targets of their own.
        for (const key of ["family.father.name", "family.father.surname", "family.mother.name", "family.spouse.surname", "basic.nic", "basic.heightCm", "contact.distanceToBucharestKm"]) {
            assert.ok(!Object.hasOwn(CONFIRMABLE_FIELDS, key), key);
        }
    });

    test("no submission: nothing to confirm (409)", async () => {
        const r = await confirm(USERS.ADMIN, { field: "basic.birthDate", expectedCurrentValue: null, expectedSubmittedValue: "2003-05-06" });
        assert.deepEqual([r.status, r.body.code], [409, "NO_SUBMISSION"]);
    });
});

describe("stale screen (CONFIRM-009)", () => {
    test("another staff member changed the value after this screen loaded: 409 and nothing is overwritten", async () => {
        await submitForm();
        const seen = await body("contact.address"); // Admin A opens the page
        await prisma.candidate.update({ where: { passportId: A.passportId }, data: { address: "77 newer street" } }); // Admin B edits the address
        const r = await confirm(USERS.ADMIN, seen);
        assert.deepEqual([r.status, r.body.code], [409, "FORM_FIELD_STALE"]);
        assert.match(r.body.message, /changed since you opened the page/);
        assert.equal((await candidateRow()).address, "77 newer street");
        assert.equal(await prisma.auditLog.count({ where: { action: "CANDIDATE_FORM_FIELD_CONFIRMED" } }), 0);
        // After a refresh the new current value is what the Admin confirms against.
        assert.equal((await confirm(USERS.ADMIN, await body("contact.address"))).status, 200);
        assert.equal((await candidateRow()).address, "12 GALLE ROAD");
    });

    test("a wrong expected submitted value is also stale", async () => {
        await submitForm();
        const seen = await body("basic.birthDate");
        const r = await confirm(USERS.ADMIN, { ...seen, expectedSubmittedValue: "1999-01-01" });
        assert.deepEqual([r.status, r.body.code], [409, "FORM_FIELD_STALE"]);
        assert.equal((await candidateRow()).dateOfBirth.toISOString().slice(0, 10), "2003-06-05");
    });

    test("two Admins confirming the same field at once: one wins, the other is told it is no longer pending", async () => {
        await submitForm();
        const seen = await body("passport.expiryDate");
        const results = await Promise.all([confirm(USERS.ADMIN, seen), confirm(USERS.MANAGER, seen)]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        assert.equal(await prisma.auditLog.count({ where: { action: "CANDIDATE_FORM_FIELD_CONFIRMED" } }), 1);
    });
});

describe("roles and the public API (CONFIRM-013, 014, 015)", () => {
    test("ADMIN and MANAGER confirm; an Analyst, the Registration Desk and an unrelated Analyst cannot", async () => {
        await submitForm();
        const seen = await body("contact.address");
        for (const who of [USERS.ANN, USERS.DESK, USERS.BEN]) {
            assert.equal((await confirm(who, seen)).status, 403, who.role);
        }
        assert.equal((await candidateRow()).address, "1 old road");
        assert.equal((await confirm(USERS.MANAGER, seen)).status, 200);
        // They can still SEE the submitted change (Analyst within their scope).
        assert.ok((await view(USERS.ANN)).body.pending.length > 0);
        assert.ok((await view(USERS.DESK)).body.pending.length > 0);
        assert.equal((await confirm(USERS.ADMIN, { field: "basic.birthDate", expectedCurrentValue: null, expectedSubmittedValue: null }, "N9999999")).status, 404, "unknown candidate");
    });

    test("the public Candidate Form API cannot confirm anything, with or without a candidate session", async () => {
        const token = await submitForm();
        const before = JSON.stringify(await candidateRow());
        const seen = await body("contact.address");
        for (const path of ["/confirm-field", "/form-submission/confirm-field", `/candidates/${A.passportId}/form-submission/confirm-field`]) {
            assert.equal((await pub(path, { body: seen })).status, 404, path);
            assert.equal((await pub(path, { body: seen, token })).status, 404, path);
        }
        assert.equal(JSON.stringify(await candidateRow()), before);
    });
});
