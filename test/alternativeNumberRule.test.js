// The alternative (contact) number must differ from the candidate's WhatsApp number, compared in any
// written form (utils/phoneNumber.js): the Candidate Form (submit and draft), Admin's Candidate
// Details save (PUT /api/admin/candidates/:passportId), registration (POST /api/admin/candidates;
// never the Google Sheet import) and the per-field Confirm of the form's
// alternative number. Pure rules first, then on a REAL PostgreSQL (PGlite, every migration applied)
// through the real Prisma client and routers. Synthetic data only.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createPublicCandidateDetailsRouter, PUBLIC_CANDIDATE_DETAILS_PATH } from "../src/routes/publicCandidateDetails.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { ALTERNATIVE_SAME_AS_CONTACT, parseSubmission } from "../src/services/candidateFormDataService.js";
import { CONTACT_SAME_AS_WHATSAPP_MESSAGE } from "../src/services/candidateService.js";
import { canonicalPhoneNumber, isSamePhoneNumber, phoneKey } from "../src/utils/phoneNumber.js";
import { DIFFERENT_PHONE_NUMBER_CASES, SAME_PHONE_NUMBER_CASES } from "./helpers/samePhoneNumberCases.js";

const SECRET = "test-candidate-form-secret-0123456789-abcdefghijklmnop";
const ORIGIN = "https://candidate-form.example.test";
const user = (adminId, role, n) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const ADMIN = user("u-admin", "ADMIN", 1);
const WHATSAPP = "+94771234567";
const A = {
    passportId: "N6100001", uniqueId: "6101", firstName: "Anusha", otherName: "De Soysa", nic: "610000001V", sex: "F", address: "1 old road",
    whatsappNumber: WHATSAPP, contactNumber: "0112345678", job: "PLASTER", jobExperience: "3 years",
    passportIssueDate: new Date("2020-01-15"), passportExpiryDate: new Date("2030-01-14"),
};
const SAME_FORMS = ["+94 77 123 4567", "0094771234567", "0771234567", "94771234567", "+94771234567", "077-123-4567"];

describe("the comparison (utils/phoneNumber.js)", () => {
    test("the same number in different written forms is the same; a different number is not", () => {
        for (const form of SAME_FORMS) assert.equal(isSamePhoneNumber(form, WHATSAPP), true, form);
        assert.equal(phoneKey("0094771234567"), "94771234567", "0094 is the international prefix");
        for (const other of ["0771234568", "+94 77 123 4568", "+40771234567", "0112345678"]) assert.equal(isSamePhoneNumber(other, WHATSAPP), false, other);
    });

    test("N/A, empty or no number is never the same", () => {
        for (const value of ["N/A", "n/a", "NA", "", null, undefined]) assert.equal(isSamePhoneNumber(value, WHATSAPP), false, String(value));
        assert.equal(isSamePhoneNumber("0771234567", null), false, "no WhatsApp number on record");
        assert.equal(isSamePhoneNumber(null, null), false);
    });

    test("the shared table (test/helpers/samePhoneNumberCases.js, mirrored by the clients), both ways round", () => {
        for (const [whatsapp, other] of SAME_PHONE_NUMBER_CASES) {
            assert.equal(isSamePhoneNumber(other, whatsapp), true, `${other} = ${whatsapp}`);
            assert.equal(isSamePhoneNumber(whatsapp, other), true, `${whatsapp} = ${other}`);
        }
        for (const [whatsapp, other] of DIFFERENT_PHONE_NUMBER_CASES) {
            assert.equal(isSamePhoneNumber(other, whatsapp), false, `${other} != ${whatsapp}`);
            assert.equal(isSamePhoneNumber(whatsapp, other), false, `${whatsapp} != ${other}`);
        }
    });

    test("phoneKey and canonicalPhoneNumber (the SQL candidate_phone_key() twin) are unchanged by the stricter comparison", () => {
        assert.equal(phoneKey("+94 0771234567"), "940771234567");
        assert.equal(canonicalPhoneNumber("+94 0771234567"), "+940771234567");
        assert.equal(phoneKey("771234567"), "94771234567");
        assert.equal(phoneKey("0112345678"), "94112345678");
        assert.equal(phoneKey("+919876543210"), "919876543210");
        assert.equal(phoneKey("N/A"), null);
    });

    test("the admin sentence uses the admin labels 'Contact number' and 'WhatsApp number'", () => {
        assert.equal(CONTACT_SAME_AS_WHATSAPP_MESSAGE, "Contact number must be different from the WhatsApp number.");
    });
});

// The whole form, with the alternative number as given.
const answers = (alternativePhone) => ({
    basic: { fullName: "anusha de soysa", surname: "de soysa", otherNames: "anusha", sex: "FEMALE", civilStatus: "SINGLE", birthDate: "2003-05-06", birthPlace: "negombo", bloodGroup: "O+", height: "175 cm", weight: "70", drivingLicence: "YES", canReadDrawings: "NO", teamLeadingSkills: "YES", otherLanguages: "english, romanian" },
    contact: { address: "12 galle road", city: "negombo", district: "gampaha", dsDivision: "negombo", gnDivision: "kurana", alternativePhone, email: "new@example.com", cityInRomania: "cluj napoca" },
    passport: { issueDate: "2020-01-15", expiryDate: "2031-02-03" },
    qualifications: { jobCategory: "PLASTER", jobCategoryOther: "", experience: "3 years", otherSkills1: "n/a", otherSkills2: "N/A", englishKnowledge: "GOOD" },
    measurements: { shirtSize: "M", waistSize: "32", shoeSize: "eu 42" },
    family: {
        father: { name: "sunil", surname: "de soysa", passportNumber: "N/A", birthDate: "1960-03-02" }, mother: { name: "kumari", surname: "de soysa", passportNumber: "N/A", birthDate: "1965-02-03" },
        spouse: { name: "", surname: "", passportNumber: "", birthDate: "" }, child1: "N/A", child2: "", child3: "", fatherAlive: "YES", motherAlive: "YES",
    },
    guardian: { name: "kamal perera", relationship: "uncle", nic: "901234567v", birthDate: "1960-01-01", phone: "+94 77 123 4567", address: "45 lake road" },
});
const KEY = "key-alt-00000000001";
const fieldErrors = (errors, field) => (errors ?? []).filter((e) => e.field === field);

describe("the form's rule (parseSubmission)", () => {
    const parse = (alternativePhone, whatsappNumber = WHATSAPP) => parseSubmission({ answers: answers(alternativePhone), idempotencyKey: KEY }, { jobCategories: ["PLASTER"], whatsappNumber });

    test("the WhatsApp number in any form is refused on contact.alternativePhone with code same_as_contact", () => {
        for (const form of SAME_FORMS) {
            const { errors } = parse(form);
            assert.deepEqual(fieldErrors(errors, "contact.alternativePhone"), [{ field: "contact.alternativePhone", ...ALTERNATIVE_SAME_AS_CONTACT }], form);
        }
        assert.equal(ALTERNATIVE_SAME_AS_CONTACT.message, "Alternative number must be different from your contact number.");
    });

    test("a different number, N/A, and no WhatsApp number on record pass; empty stays 'required'", () => {
        for (const ok of ["0771234568", "N/A", "na"]) assert.equal(parse(ok).errors, undefined, ok);
        assert.equal(parse("0771234567", null).errors, undefined, "nothing to compare with");
        assert.deepEqual(fieldErrors(parse("").errors, "contact.alternativePhone").map((e) => e.code), ["required"]);
        assert.deepEqual(fieldErrors(parse("12").errors, "contact.alternativePhone").map((e) => e.code), ["invalid"], "an invalid number keeps its one error");
    });
});

let database;
let prisma;
let pg;
before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    await prisma.user.create({ data: ADMIN });
});
after(async () => database?.close());
beforeEach(async () => {
    await pg.exec(`
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "notification"; DELETE FROM "rate_limits"; DELETE FROM "candidate_form_field_review"; DELETE FROM "candidate_form_sheet_sync"; DELETE FROM "candidate_form_draft";
        DELETE FROM "candidate_form_response"; DELETE FROM "candidate_form_prefill_snapshot"; DELETE FROM "candidate_form_access"; DELETE FROM "candidate_form_link";
        DELETE FROM "candidate_allocation"; DELETE FROM "candidate_additional_details"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
    `);
    await prisma.candidate.create({ data: A });
});

function app() {
    const server = express();
    server.use(PUBLIC_CANDIDATE_DETAILS_PATH, createPublicCandidateDetailsRouter({ db: prisma, tokenSecret: SECRET, allowedOrigin: ORIGIN, verifyIpLimiter: noRateLimit, verifyPassportLimiter: noRateLimit, log: { warn() {}, error() {}, info() {}, log() {} } }));
    server.use(express.json());
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: ADMIN.adminId }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
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
const pub = (path, options) => call("POST", `${PUBLIC_CANDIDATE_DETAILS_PATH}${path}`, options);
async function session() {
    const shared = await call("POST", `/api/admin/candidates/${A.passportId}/form-share`);
    assert.equal(shared.status, 201, JSON.stringify(shared.body));
    const verified = await pub("/verify", { body: { linkSecret: shared.body.url.split("#k=")[1], passportNumber: A.passportId, nic: A.nic } });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    return verified.body.token;
}
const SAME_AS_CONTACT_400 = { message: "Some answers are missing or not valid.", errors: [{ field: "contact.alternativePhone", code: "same_as_contact", message: "same_as_contact" }] };

describe("the Candidate Form API", () => {
    test("submit: the WhatsApp number as the alternative number is 400 with the field code, and nothing is stored; a different number is accepted", async () => {
        const token = await session();
        const refused = await pub("/submit", { token, body: { answers: answers("0094 77 123 4567"), idempotencyKey: KEY } });
        assert.equal(refused.status, 400);
        assert.deepEqual(refused.body, SAME_AS_CONTACT_400);
        assert.equal(await prisma.candidateFormResponse.count(), 0);
        assert.equal((await prisma.candidateFormAccess.findUnique({ where: { passportId: A.passportId } })).status, "UNLOCKED", "the form stays open");

        const accepted = await pub("/submit", { token, body: { answers: answers("0771234568"), idempotencyKey: KEY } });
        assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    });

    test("submit with N/A is accepted", async () => {
        const res = await pub("/submit", { token: await session(), body: { answers: answers("N/A"), idempotencyKey: KEY } });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal((await prisma.candidateFormResponse.findUnique({ where: { passportId: A.passportId } })).alternativePhone, "N/A");
    });

    test("draft (the Personal step): the same rule, nothing saved", async () => {
        const token = await session();
        const { basic, contact } = answers("+94 77 123 4567");
        const refused = await pub("/draft", { token, body: { step: "personal", answers: { basic, contact } } });
        assert.equal(refused.status, 400);
        assert.deepEqual(refused.body, SAME_AS_CONTACT_400);
        assert.equal(await prisma.candidateFormDraft.count(), 0);
        const saved = await pub("/draft", { token, body: { step: "personal", answers: { basic, contact: { ...contact, alternativePhone: "0771234568" } } } });
        assert.equal(saved.status, 200, JSON.stringify(saved.body));
    });
});

describe("Admin: Candidate Details save (PUT /api/admin/candidates/:passportId)", () => {
    const details = (extra) => ({
        surname: "De Soysa", otherNames: "Anusha", nic: A.nic, jobExperience: "3 years", passportIssueDate: "2020-01-15", passportExpiryDate: "2030-01-14", jobTypes: ["PLASTER"], ...extra,
    });
    const put = (body) => call("PUT", `/api/admin/candidates/${A.passportId}`, { body });
    const REFUSED = {
        message: CONTACT_SAME_AS_WHATSAPP_MESSAGE, code: "CONTACT_SAME_AS_WHATSAPP",
        errors: [{ field: "contactNumber", code: "same_as_contact", message: CONTACT_SAME_AS_WHATSAPP_MESSAGE }],
    };

    test("the stored WhatsApp number as the contact number (only contactNumber sent, or both) is 400; nothing changes", async () => {
        for (const body of [details({ contactNumber: "0771234567" }), details({ whatsappNumber: WHATSAPP, contactNumber: "+94 77 123 4567" })]) {
            const res = await put(body);
            assert.equal(res.status, 400, JSON.stringify(res.body));
            assert.deepEqual(res.body, REFUSED);
        }
        assert.equal((await prisma.candidate.findUnique({ where: { passportId: A.passportId } })).contactNumber, "0112345678");
    });

    test("adding a WhatsApp number to an empty record: the incoming one is compared", async () => {
        await prisma.candidate.update({ where: { passportId: A.passportId }, data: { whatsappNumber: null } });
        const res = await put(details({ whatsappNumber: "0779999999", contactNumber: "+94779999999" }));
        assert.equal(res.status, 400);
        assert.deepEqual(res.body, REFUSED);
        assert.equal((await prisma.candidate.findUnique({ where: { passportId: A.passportId } })).whatsappNumber, null);
        const ok = await put(details({ whatsappNumber: "0779999999", contactNumber: "0771234568" }));
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
    });

    test("a different number, or none, is saved; WHATSAPP_LOCKED is unchanged", async () => {
        assert.equal((await put(details({ contactNumber: "0771234568" }))).status, 200);
        assert.equal((await put(details({}))).status, 200);
        const locked = await put(details({ whatsappNumber: "0770000000", contactNumber: "0770000000" }));
        assert.deepEqual([locked.status, locked.body.code], [409, "WHATSAPP_LOCKED"], "a WhatsApp change is still refused first");
    });

    test("a record saved earlier with the two equal stays editable while its contact number is unchanged", async () => {
        await prisma.candidate.update({ where: { passportId: A.passportId }, data: { contactNumber: "0771234567" } });
        const res = await put(details({ contactNumber: "+94771234567", address: "2 new road" }));
        assert.equal(res.status, 200, JSON.stringify(res.body));
    });
});

describe("Admin: registration (POST /api/admin/candidates)", () => {
    const NEW = { passportId: "N6100002", surname: "Perera", otherNames: "Nimal", nic: "610000002V", whatsappNumber: "+94779876543", jobTypes: ["PLASTER"], jobExperience: "2 years", passportIssueDate: "2020-01-15", passportExpiryDate: "2030-01-14" };
    const register = (extra) => call("POST", "/api/admin/candidates", { body: { ...NEW, ...extra } });
    const REFUSED = {
        message: CONTACT_SAME_AS_WHATSAPP_MESSAGE, code: "CONTACT_SAME_AS_WHATSAPP",
        errors: [{ field: "contactNumber", code: "same_as_contact", message: CONTACT_SAME_AS_WHATSAPP_MESSAGE }],
    };

    test("the WhatsApp number given as the contact number, in any written form, is 400 and nothing is registered", async () => {
        for (const contactNumber of ["0779876543", "+94 77 987 6543", "0094779876543", "+94 0779876543", "779876543"]) {
            const res = await register({ contactNumber });
            assert.equal(res.status, 400, `${contactNumber}: ${JSON.stringify(res.body)}`);
            assert.deepEqual(res.body, REFUSED, contactNumber);
        }
        assert.equal(await prisma.candidate.count({ where: { passportId: NEW.passportId } }), 0);
        assert.equal(await prisma.auditLog.count(), 0, "nothing audited");
    });

    test("a different contact number, or none, is registered", async () => {
        const res = await register({ contactNumber: "0779876544" });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        await prisma.candidate.delete({ where: { passportId: NEW.passportId } });
        const none = await register({});
        assert.equal(none.status, 201, JSON.stringify(none.body));
    });

    test("an existing passport ID is still 409 CANDIDATE_EXISTS first", async () => {
        const res = await register({ passportId: A.passportId, contactNumber: "0779876543" });
        assert.deepEqual([res.status, res.body.code], [409, "CANDIDATE_EXISTS"]);
    });
});

describe("Admin: confirming the form's alternative number", () => {
    test("Confirm is refused (409, nothing written) when it equals the WhatsApp number; Reject still works", async () => {
        const token = await session();
        const submitted = await pub("/submit", { token, body: { answers: answers("0771234568"), idempotencyKey: KEY } });
        assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
        // A submission stored before the rule (or a WhatsApp number recorded since): the two are now equal.
        await prisma.candidate.update({ where: { passportId: A.passportId }, data: { whatsappNumber: "+94771234568" } });

        const view = await call("GET", `/api/admin/candidates/${A.passportId}/form-submission`);
        const pending = view.body.pending.find((p) => p.field === "contact.alternativePhone");
        assert.ok(pending, "still shown as a pending change");
        const body = { field: "contact.alternativePhone", expectedCurrentValue: pending.current, expectedSubmittedValue: pending.submitted };
        const refused = await call("POST", `/api/admin/candidates/${A.passportId}/form-submission/confirm-field`, { body });
        assert.deepEqual([refused.status, refused.body.code, refused.body.message], [409, "FORM_FIELD_PREREQUISITE", CONTACT_SAME_AS_WHATSAPP_MESSAGE]);
        assert.equal((await prisma.candidate.findUnique({ where: { passportId: A.passportId } })).contactNumber, "0112345678");
        assert.equal(await prisma.candidateFormFieldReview.count(), 0);

        const rejected = await call("POST", `/api/admin/candidates/${A.passportId}/form-submission/reject-field`, { body });
        assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    });

    test("a different number is confirmed as before", async () => {
        const token = await session();
        assert.equal((await pub("/submit", { token, body: { answers: answers("0771234568"), idempotencyKey: KEY } })).status, 200);
        const view = await call("GET", `/api/admin/candidates/${A.passportId}/form-submission`);
        const pending = view.body.pending.find((p) => p.field === "contact.alternativePhone");
        const res = await call("POST", `/api/admin/candidates/${A.passportId}/form-submission/confirm-field`, { body: { field: pending.field, expectedCurrentValue: pending.current, expectedSubmittedValue: pending.submitted } });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal((await prisma.candidate.findUnique({ where: { passportId: A.passportId } })).contactNumber, "+94771234568");
    });
});
