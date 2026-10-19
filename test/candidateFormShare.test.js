// Candidate Form share links, the single-submission lock, the prefill and the
// submission. On a REAL PostgreSQL (PGlite, every migration applied) through
// the real Prisma client, the real admin router and the real public router.
// No Supabase: the signed-in staff user is set by a stand-in for
// requireActiveUser, read from the database on every request.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createPublicCandidateDetailsRouter, PUBLIC_CANDIDATE_DETAILS_PATH } from "../src/routes/publicCandidateDetails.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { FORM_LINK_MAX_FAILURES, FORM_LINK_TTL_MS, hashLinkSecret } from "../src/services/candidateFormShareService.js";
import { ANSWER_FIELDS } from "../src/services/candidateFormDataService.js";

const SECRET = "test-candidate-form-secret-0123456789-abcdefghijklmnop";
const ORIGIN = "https://candidate-form.example.test";
const user = (adminId, role, n) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const USERS = { ADMIN: user("u-admin", "ADMIN", 1), MANAGER: user("u-manager", "MANAGER", 2), DESK: user("u-desk", "REGISTRATION_DESK", 3), ANN: user("u-ann", "ANALYST", 4), BEN: user("u-ben", "ANALYST", 5) };

// A: full records (core + additional details). P: partial (core only, some
// blanks). E: almost empty. All have a NIC.
const A = {
    passportId: "N1000001", uniqueId: "8001", firstName: "Anusha", otherName: "De Soysa", nic: "900000001V", sex: "F", dateOfBirth: new Date("1990-05-01"),
    placeOfBirth: "Negombo", address: "1 Old Road", contactNumber: "0112345678", whatsappNumber: "+94771111111", job: "Welder TIG", jobExperience: "5 years",
    passportIssueDate: new Date("2020-01-15"), passportExpiryDate: new Date("2030-01-14"),
};
const A_DETAILS = {
    passportId: A.passportId, nameAsInPassport: "ANUSHA DE SOYSA", permanentAddress: "12 Galle Road, Negombo", birthday: new Date("1990-05-01"), tshirtSize: "M", pantSize: "32", shoeSize: "8",
    fatherAlive: true, fatherFullName: "Sunil De Soysa", fatherBirthday: new Date("1960-03-02"), motherAlive: true, motherFullName: "Kamala De Soysa", maritalStatus: "MARRIED",
    wifeFullName: "Ruwan Perera", wifeBirthday: new Date("1988-07-12"), child1Name: "Nimal", otherJobSkills: "Forklift",
};
const P = { passportId: "N2000002", uniqueId: "8002", firstName: "Kamal", otherName: "Perera", nic: "199012345678", sex: "M", whatsappNumber: "+94772222222" };
const E = { passportId: "N3000003", uniqueId: "8003", firstName: "Eranga", nic: "900000003V" };

let database;
let prisma;
let pg;
const logs = [];
const captureLog = { warn: (...a) => logs.push(a), error: (...a) => logs.push(a), info: (...a) => logs.push(a), log: (...a) => logs.push(a) };

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const u of Object.values(USERS)) await prisma.user.create({ data: u });
});
after(async () => database?.close());
beforeEach(async () => {
    logs.length = 0;
    await pg.exec(`
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "rate_limits"; DELETE FROM "candidate_allocation";
        DELETE FROM "candidate_form_response"; DELETE FROM "candidate_form_prefill_snapshot"; DELETE FROM "candidate_form_access"; DELETE FROM "candidate_form_link";
        DELETE FROM "candidate_additional_details"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
    `);
    await prisma.candidate.createMany({ data: [A, P, E] });
    await prisma.candidateAdditionalDetails.create({ data: A_DETAILS });
    await prisma.candidateAllocation.create({ data: { passportId: A.passportId, analystId: USERS.ANN.adminId } });
});

// One app: the admin router (as `who`) and the public router.
function app(who, { formOrigin = ORIGIN } = {}) {
    const server = express();
    server.use(PUBLIC_CANDIDATE_DETAILS_PATH, createPublicCandidateDetailsRouter({ db: prisma, tokenSecret: SECRET, allowedOrigin: ORIGIN, verifyIpLimiter: noRateLimit, verifyPassportLimiter: noRateLimit, log: captureLog }));
    server.use(express.json());
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: who.adminId }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
        next();
    };
    server.use("/api/admin", createAdminRouter({ db: prisma, bucket: {}, requireAdmin, apiLimiter: noRateLimit, candidateFormOrigin: formOrigin }));
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
const admin = (who, method, path, options) => call(app(who), method, `/api/admin${path}`, options);
const pub = (path, options) => call(app(USERS.ADMIN), "POST", `${PUBLIC_CANDIDATE_DETAILS_PATH}${path}`, options);

const share = async (candidate, who = USERS.ADMIN) => {
    const r = await admin(who, "POST", `/candidates/${candidate.passportId}/form-share`);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.url.split("#k=")[1];
};
const verify = (secret, candidate, overrides = {}) => pub("/verify", { body: { linkSecret: secret, passportNumber: candidate.passportId, nic: candidate.nic, ...overrides } });
async function session(candidate) {
    const secret = await share(candidate);
    const r = await verify(secret, candidate);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { secret, token: r.body.token };
}

// Answers that pass every rule.
const ANSWERS = () => ({
    basic: { fullName: "anusha de soysa", surname: "de soysa", otherNames: "anusha", sex: "FEMALE", civilStatus: "SINGLE", birthDate: "1990-05-01", birthPlace: "negombo" },
    contact: { address: "12 galle road", city: "", district: "gampaha", dsDivision: "negombo", gnDivision: "", alternativePhone: "0771234567", email: "Anusha.D@example.com" },
    passport: { issueDate: "2020-01-15", expiryDate: "2030-01-14" },
    qualifications: { jobCategory: "WELDER TIG", jobCategoryOther: "", experience: "5 years", otherSkills1: "", otherSkills2: "", englishKnowledge: "GOOD" },
    measurements: { shirtSize: "M", waistSize: "32", shoeSize: "eu 42" },
    family: {
        father: { name: "sunil", surname: "de soysa", passportNumber: "n7654321", birthDate: "1960-03-02" },
        mother: { name: "", surname: "", passportNumber: "", birthDate: "" },
        spouse: { name: "kept but hidden", surname: "", passportNumber: "", birthDate: "" },
        child1: "", child2: "", child3: "",
    },
    guardian: { name: "kamal perera", relationship: "uncle", nic: "901234567v", birthDate: "", phone: "+94 77 123 4567", address: "45 lake road" },
});
const submit = (token, answers = ANSWERS(), idempotencyKey = "key-0000000000000001") => pub("/submit", { token, body: { answers, idempotencyKey } });
const rowOf = async (passportId) => ({
    candidate: await prisma.candidate.findUnique({ where: { passportId } }),
    details: await prisma.candidateAdditionalDetails.findUnique({ where: { passportId } }),
    stages: await prisma.candidateStage.findMany({ where: { passportId } }),
});

describe("share links (Admin)", () => {
    test("creating a link: 256-bit secret in the URL fragment, shown once, stored only as a hash; the form unlocks; audited without the secret", async () => {
        const before = await admin(USERS.ADMIN, "GET", `/candidates/${A.passportId}/form-share`);
        assert.deepEqual([before.status, before.body.state, before.body.link], [200, "LOCKED", null]);

        const r = await admin(USERS.ADMIN, "POST", `/candidates/${A.passportId}/form-share`);
        assert.equal(r.status, 201);
        const secret = r.body.url.split("#k=")[1];
        assert.match(r.body.url, new RegExp(`^${ORIGIN}/#k=[A-Za-z0-9_-]{43}$`), "fragment, not query string");
        assert.equal(Buffer.from(secret, "base64url").length, 32, "256 bits");
        assert.equal(r.body.status.state, "OPEN");
        assert.equal(Date.parse(r.body.expiresAt) - Date.now() > FORM_LINK_TTL_MS - 60_000, true);
        assert.equal(FORM_LINK_TTL_MS, 3 * 24 * 60 * 60 * 1000, "3 days");

        const [link] = await prisma.candidateFormLink.findMany();
        assert.equal(link.tokenHash, hashLinkSecret(secret));
        assert.equal((await prisma.candidateFormAccess.findUnique({ where: { passportId: A.passportId } })).status, "UNLOCKED");
        // The secret is nowhere in the database or the status response.
        const dump = JSON.stringify(await pg.query(`SELECT * FROM candidate_form_link, candidate_form_access, audit_logs`));
        assert.ok(!dump.includes(secret));
        const status = await admin(USERS.ADMIN, "GET", `/candidates/${A.passportId}/form-share`);
        assert.ok(!JSON.stringify(status.body).includes(secret));
        const audits = await prisma.auditLog.findMany();
        assert.deepEqual(audits.map((a) => [a.action, a.passportId, a.adminId, a.previousStatus, a.newStatus]), [["CREATE_FORM_LINK", A.passportId, USERS.ADMIN.adminId, "LOCKED", "UNLOCKED"]]);
    });

    test("a new link replaces the old one; revoking locks the form again; both are audited", async () => {
        const first = await share(A);
        const second = await share(A);
        assert.equal((await verify(first, A)).status, 401, "the old link no longer works");
        assert.equal((await verify(second, A)).status, 200);
        const revoked = await admin(USERS.MANAGER, "POST", `/candidates/${A.passportId}/form-share/revoke`);
        assert.deepEqual([revoked.status, revoked.body.state], [200, "LOCKED"]);
        assert.equal((await verify(second, A)).status, 401);
        assert.equal((await admin(USERS.MANAGER, "POST", `/candidates/${A.passportId}/form-share/revoke`)).status, 404, "nothing left to revoke");
        assert.deepEqual((await prisma.auditLog.findMany({ orderBy: { createdDate: "asc" } })).map((a) => a.action), ["CREATE_FORM_LINK", "CREATE_FORM_LINK", "REVOKE_FORM_LINK"]);
    });

    test("roles: ADMIN, MANAGER, REGISTRATION_DESK for any candidate; an ANALYST only for their own; others 404 like a missing candidate", async () => {
        for (const who of [USERS.ADMIN, USERS.MANAGER, USERS.DESK]) assert.equal((await admin(who, "POST", `/candidates/${P.passportId}/form-share`)).status, 201, who.role);
        assert.equal((await admin(USERS.ANN, "POST", `/candidates/${A.passportId}/form-share`)).status, 201, "Ann's own candidate");
        for (const path of [`/candidates/${P.passportId}/form-share`, `/candidates/${P.passportId}/form-share/revoke`]) {
            assert.equal((await admin(USERS.ANN, "POST", path)).status, 404, path);
        }
        assert.equal((await admin(USERS.BEN, "GET", `/candidates/${A.passportId}/form-share`)).status, 404);
    });

    test("no configured form origin: no link can be created (503), nothing changes", async () => {
        const r = await call(app(USERS.ADMIN, { formOrigin: null }), "POST", `/api/admin/candidates/${A.passportId}/form-share`);
        assert.deepEqual([r.status, r.body.code], [503, "FORM_NOT_CONFIGURED"]);
        assert.equal(await prisma.candidateFormLink.count(), 0);
        assert.equal(await prisma.candidateFormAccess.count(), 0);
    });

    test("a link locks after too many wrong Passport + NIC attempts, even for the right details", async () => {
        const secret = await share(A);
        for (let i = 0; i < FORM_LINK_MAX_FAILURES; i++) assert.equal((await verify(secret, A, { nic: "900000009V" })).status, 401);
        assert.equal((await verify(secret, A)).status, 401, "locked");
        const status = await admin(USERS.ADMIN, "GET", `/candidates/${A.passportId}/form-share`);
        assert.ok(status.body.link.lockedUntil, "staff can see the link is locked");
        const fresh = await share(A);
        assert.equal((await verify(fresh, A)).status, 200, "a new link works");
    });

    test("logs never contain the link secret, the passport or the NIC", async () => {
        const secret = await share(A);
        await verify(secret, A, { nic: "900000009V" });
        await verify(secret, A, { passportNumber: "N9999999" });
        const text = JSON.stringify(logs);
        assert.ok(logs.length > 0);
        for (const value of [secret, A.passportId, A.nic, "900000009V", "N9999999"]) assert.ok(!text.includes(value), value);
    });
});

describe("the form: identity and prefill", () => {
    test("nothing is returned before verification", async () => {
        for (const token of [undefined, "cf1~x~y", "not-a-token"]) {
            const r = await pub("/form", { token, body: {} });
            assert.equal(r.status, 401, String(token));
            assert.equal(r.body.answers, undefined);
        }
    });

    test("full records: every mapped field is prefilled, with the codes and name fields mapped; identity is read-only data", async () => {
        const { token } = await session(A);
        const r = await pub("/form", { token, body: {} });
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.identity, { passportNumber: A.passportId, nic: A.nic, whatsappNumber: A.whatsappNumber });
        const { basic, contact, passport, qualifications, measurements, family } = r.body.answers;
        assert.deepEqual(basic, { fullName: "ANUSHA DE SOYSA", surname: "De Soysa", otherNames: "Anusha", sex: "FEMALE", civilStatus: "MARRIED", birthDate: "1990-05-01", birthPlace: "Negombo" });
        assert.equal(contact.address, "12 Galle Road, Negombo", "the permanent address before the core address");
        assert.equal(contact.alternativePhone, "0112345678");
        assert.equal(contact.email, null);
        assert.deepEqual(passport, { issueDate: "2020-01-15", expiryDate: "2030-01-14" });
        assert.equal(qualifications.jobCategory, "WELDER TIG", "a job that is exactly a category");
        assert.equal(qualifications.experience, "5 years");
        assert.equal(qualifications.otherSkills1, "Forklift");
        assert.deepEqual(measurements, { shirtSize: "M", waistSize: "32", shoeSize: "8" });
        assert.deepEqual(family.father, { name: "Sunil De Soysa", surname: null, passportNumber: null, birthDate: "1960-03-02" });
        assert.equal(family.spouse.name, "Ruwan Perera");
        assert.equal(family.child1, "Nimal");
        assert.ok(r.body.prefilled.includes("basic.fullName") && !r.body.prefilled.includes("contact.email"));
    });

    test("partial and empty records: what exists is filled, the rest is empty", async () => {
        const partial = await pub("/form", { token: (await session(P)).token, body: {} });
        assert.deepEqual(partial.body.answers.basic, { fullName: null, surname: "Perera", otherNames: "Kamal", sex: "MALE", civilStatus: null, birthDate: null, birthPlace: null });
        assert.deepEqual(partial.body.prefilled.sort(), ["basic.otherNames", "basic.sex", "basic.surname"]);
        const empty = await pub("/form", { token: (await session(E)).token, body: {} });
        assert.deepEqual(empty.body.prefilled, ["basic.otherNames"]);
    });

    test("the response holds only the form's fields: no stages, documents, allocation, job assignment or IDs", async () => {
        const r = await pub("/form", { token: (await session(A)).token, body: {} });
        assert.deepEqual(Object.keys(r.body).sort(), ["answers", "expiresAt", "identity", "prefilled"]);
        const keys = (value, prefix = "") => Object.entries(value).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
        assert.deepEqual(keys(r.body.answers).sort(), ANSWER_FIELDS.map(([group, key]) => `${group}.${key}`).sort());
        const text = JSON.stringify(r.body);
        for (const word of [A.uniqueId, "u-ann", "allocation", "stage", "document", "analyst"]) assert.ok(!text.includes(word), word);
    });

    test("the snapshot of the original values is taken once and never changes, even when the records change", async () => {
        const { token } = await session(A);
        await pub("/form", { token, body: {} });
        await prisma.candidate.update({ where: { passportId: A.passportId }, data: { placeOfBirth: "Kandy" } });
        const again = await pub("/form", { token, body: {} });
        assert.equal(again.body.answers.basic.birthPlace, "Negombo", "the snapshot, not the changed record");
        const snapshot = await prisma.candidateFormPrefillSnapshot.findUnique({ where: { passportId: A.passportId } });
        assert.equal(snapshot.birthPlace, "Negombo");
        await assert.rejects(pg.exec(`UPDATE candidate_form_prefill_snapshot SET birth_place = 'X'`), /cannot be changed/);
    });
});

describe("submission (once)", () => {
    test("a valid submission is stored in the response table, normalised, with nulls for empty answers; the main tables are untouched", async () => {
        const { token } = await session(A);
        await pub("/form", { token, body: {} });
        const before = await rowOf(A.passportId);
        const r = await submit(token);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const saved = await prisma.candidateFormResponse.findUnique({ where: { passportId: A.passportId } });
        assert.equal(saved.fullName, "ANUSHA DE SOYSA");
        assert.equal(saved.nic, A.nic, "the verified NIC, from the record");
        assert.equal(saved.email, "Anusha.D@example.com", "email as typed");
        assert.equal(saved.alternativePhone, "0771234567");
        assert.equal(saved.shoeSize, "EU 42");
        assert.equal(saved.fatherPassportNumber, "N7654321");
        assert.equal(saved.guardianNic, "901234567V");
        assert.equal(saved.city, null);
        assert.equal(saved.spouseName, null, "hidden spouse answers are never stored (civil status SINGLE)");
        assert.equal(saved.jobCategoryOther, null);
        assert.deepEqual(await rowOf(A.passportId), before, "candidate, additional details and stages are unchanged");
        assert.equal((await prisma.candidateFormAccess.findUnique({ where: { passportId: A.passportId } })).status, "SUBMITTED");
        await assert.rejects(pg.exec(`UPDATE candidate_form_response SET full_name = 'X'`), /cannot be changed/);
    });

    test("after submitting: no resubmit, the session ends, verify says 'already submitted' only to the right details, no new link", async () => {
        const { secret, token } = await session(A);
        assert.equal((await submit(token)).status, 200);
        const again = await submit(token, ANSWERS(), "key-0000000000000002");
        assert.deepEqual([again.status, again.body.code], [409, "ALREADY_SUBMITTED"]);
        assert.equal((await pub("/form", { token, body: {} })).status, 409);
        const right = await verify(secret, A);
        assert.deepEqual([right.status, right.body.code], [409, "ALREADY_SUBMITTED"]);
        assert.equal(right.body.token, undefined);
        const wrong = await verify(secret, A, { nic: "900000009V" });
        assert.deepEqual([wrong.status, wrong.body.code], [401, "VERIFICATION_FAILED"], "wrong details never learn it was submitted");
        const reshare = await admin(USERS.ADMIN, "POST", `/candidates/${A.passportId}/form-share`);
        assert.deepEqual([reshare.status, reshare.body.code], [409, "FORM_SUBMITTED"]);
        assert.equal((await admin(USERS.ADMIN, "GET", `/candidates/${A.passportId}/form-share`)).body.state, "SUBMITTED");
        assert.equal(await prisma.candidateFormResponse.count(), 1);
    });

    test("a safe retry with the same idempotency key gets the same success, and stores nothing twice", async () => {
        const { token } = await session(A);
        const first = await submit(token, ANSWERS(), "key-retry-0000000001");
        const retry = await submit(token, ANSWERS(), "key-retry-0000000001");
        assert.deepEqual([first.status, retry.status], [200, 200]);
        assert.equal(retry.body.submittedAt, first.body.submittedAt);
        assert.equal(await prisma.candidateFormResponse.count(), 1);
    });

    test("two submissions at the same moment: exactly one wins, the other gets 409; one stored response", async () => {
        const { token } = await session(A);
        const results = await Promise.all([submit(token, ANSWERS(), "key-race-00000000001"), submit(token, ANSWERS(), "key-race-00000000002")]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        assert.equal(await prisma.candidateFormResponse.count(), 1);
    });

    test("a revoked or replaced link ends the session before it can submit", async () => {
        const { token } = await session(A);
        await admin(USERS.ADMIN, "POST", `/candidates/${A.passportId}/form-share/revoke`);
        assert.equal((await submit(token)).status, 401);
        const second = await session(A);
        await share(A);
        assert.equal((await submit(second.token)).status, 401);
        assert.equal(await prisma.candidateFormResponse.count(), 0);
    });

    test("the server checks the answers: unknown keys, required answers, formats, codes; hidden answers and OTHER", async () => {
        const { token } = await session(A);
        const bad = ANSWERS();
        bad.basic.fullName = "";
        bad.basic.sex = "M";
        bad.contact.email = "not-an-email";
        bad.guardian.nic = "12345";
        bad.passport.expiryDate = "2019-01-01";
        bad.qualifications.jobCategory = "OTHER";
        bad.basic.nic = "999999999V"; // identity is not an answer
        const r = await submit(token, bad);
        assert.equal(r.status, 400);
        const fields = r.body.errors.map((e) => e.field).sort();
        assert.deepEqual(fields, ["basic.nic"], "an unknown key is refused before anything else");
        delete bad.basic.nic;
        const r2 = await submit(token, bad);
        assert.deepEqual(r2.body.errors.map((e) => `${e.field}:${e.code}`).sort(), [
            "basic.fullName:required", "basic.sex:invalid", "contact.email:invalid", "guardian.nic:invalid", "passport.expiryDate:invalid", "qualifications.jobCategoryOther:required",
        ]);
        assert.ok(!JSON.stringify(r2.body).includes("not-an-email"), "values are never echoed");
        for (const body of [{}, { answers: ANSWERS() }, { answers: ANSWERS(), idempotencyKey: "short" }, { answers: [], idempotencyKey: "key-0000000000000001" }, { answers: ANSWERS(), idempotencyKey: "key-0000000000000001", extra: 1 }]) {
            assert.equal((await pub("/submit", { token, body })).status, 400, JSON.stringify(Object.keys(body)));
        }
        assert.equal(await prisma.candidateFormResponse.count(), 0);
        assert.equal((await prisma.candidateFormAccess.findUnique({ where: { passportId: A.passportId } })).status, "UNLOCKED", "a refused submission keeps the form open");
    });

    test("Married keeps the spouse; OTHER keeps the other category, in capitals", async () => {
        const { token } = await session(A);
        const answers = ANSWERS();
        answers.basic.civilStatus = "MARRIED";
        answers.qualifications.jobCategory = "OTHER";
        answers.qualifications.jobCategoryOther = "scaffolder";
        assert.equal((await submit(token, answers)).status, 200);
        const saved = await prisma.candidateFormResponse.findUnique({ where: { passportId: A.passportId } });
        assert.deepEqual([saved.spouseName, saved.jobCategoryOther], ["KEPT BUT HIDDEN", "SCAFFOLDER"]);
    });

    test("Sinhala answers are stored unchanged, and a large answer set fits the submit body limit", async () => {
        const { token } = await session(A);
        const answers = ANSWERS();
        answers.basic.birthPlace = "කොළඹ colombo";
        answers.qualifications.experience = "ම".repeat(1000);
        answers.contact.address = "ලිපිනය ".repeat(70).slice(0, 500);
        assert.equal((await submit(token, answers)).status, 200);
        const saved = await prisma.candidateFormResponse.findUnique({ where: { passportId: A.passportId } });
        assert.equal(saved.birthPlace, "කොළඹ COLOMBO");
        assert.equal(saved.experience.length, 1000);
    });
});
