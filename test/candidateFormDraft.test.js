// Candidate Form: N/A variations and the saved progress (draft). On a REAL PostgreSQL (PGlite,
// every migration applied) through the real Prisma client, the real admin router (to create
// share links) and the real public router. Synthetic data only.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createPublicCandidateDetailsRouter, PUBLIC_CANDIDATE_DETAILS_PATH } from "../src/routes/publicCandidateDetails.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { isNotApplicableFor, NOT_APPLICABLE_FIELDS, parseSubmission } from "../src/services/candidateFormDataService.js";

const SECRET = "test-candidate-form-secret-0123456789-abcdefghijklmnop";
const ORIGIN = "https://candidate-form.example.test";
const ADMIN = { adminId: "u-admin", role: "ADMIN", name: "ADMIN 1", email: "u-admin@example.invalid", authUserId: "00000000-0000-4000-8000-000000000001" };
const A = {
    passportId: "N1000001", uniqueId: "8001", firstName: "Anusha", otherName: "De Soysa", nic: "900000001V", sex: "F", dateOfBirth: new Date("1990-05-01"),
    placeOfBirth: "Negombo", address: "1 Old Road", contactNumber: "0112345678", whatsappNumber: "+94771111111", job: "Welder TIG", jobExperience: "5 years",
    passportIssueDate: new Date("2020-01-15"), passportExpiryDate: new Date("2030-01-14"),
};
const B = { passportId: "N2000002", uniqueId: "8002", firstName: "Kamal", otherName: "Perera", nic: "199012345678", sex: "M", whatsappNumber: "+94772222222" };

let database;
let prisma;
let pg;
const quiet = { warn() {}, error() {}, info() {}, log() {} };

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    await prisma.user.create({ data: ADMIN });
});
after(async () => database?.close());
beforeEach(async () => {
    await pg.exec(`
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "rate_limits"; DELETE FROM "candidate_call_logs";
        DELETE FROM "candidate_form_response"; DELETE FROM "candidate_form_prefill_snapshot"; DELETE FROM "candidate_form_access"; DELETE FROM "candidate_form_link";
        DELETE FROM "candidate_additional_details"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
    `);
    await prisma.candidate.createMany({ data: [A, B] });
});

function app() {
    const server = express();
    server.use(PUBLIC_CANDIDATE_DETAILS_PATH, createPublicCandidateDetailsRouter({ db: prisma, tokenSecret: SECRET, allowedOrigin: ORIGIN, verifyIpLimiter: noRateLimit, verifyPassportLimiter: noRateLimit, log: quiet }));
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
const admin = (method, path, options) => call(method, `/api/admin${path}`, options);
const pub = (path, options) => call("POST", `${PUBLIC_CANDIDATE_DETAILS_PATH}${path}`, options);

const share = async (candidate) => {
    const r = await admin("POST", `/candidates/${candidate.passportId}/form-share`);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.url.split("#k=")[1];
};
const verify = (secret, candidate) => pub("/verify", { body: { linkSecret: secret, passportNumber: candidate.passportId, nic: candidate.nic } });
async function session(candidate) {
    const verified = await verify(await share(candidate), candidate);
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    return verified.body.token;
}

const ANSWERS = () => ({
    basic: { fullName: "anusha de soysa", surname: "de soysa", otherNames: "anusha", sex: "FEMALE", civilStatus: "SINGLE", birthDate: "1990-05-01", birthPlace: "negombo" },
    contact: { address: "12 galle road", city: "negombo", district: "gampaha", dsDivision: "negombo", gnDivision: "kurana", alternativePhone: "0771234567", email: "Anusha.D@example.com" },
    passport: { issueDate: "2020-01-15", expiryDate: "2030-01-14" },
    qualifications: { jobCategory: "WELDER TIG", jobCategoryOther: "", experience: "5 years", otherSkills1: "n/a", otherSkills2: "N/A", englishKnowledge: "GOOD" },
    measurements: { shirtSize: "M", waistSize: "32", shoeSize: "eu 42" },
    family: {
        father: { name: "sunil", surname: "de soysa", passportNumber: "n7654321", birthDate: "1960-03-02" },
        mother: { name: "kumari", surname: "de soysa", passportNumber: "N/A", birthDate: "1965-02-03" },
        spouse: { name: "", surname: "", passportNumber: "", birthDate: "" },
        child1: "N/A", child2: "", child3: "",
    },
    guardian: { name: "kamal perera", relationship: "uncle", nic: "901234567v", birthDate: "1960-01-01", phone: "+94 77 123 4567", address: "45 lake road" },
});
const PERSONAL = ["basic", "contact"];
const WORK = ["passport", "qualifications", "measurements", "family", "guardian"];
const pick = (answers, groups) => Object.fromEntries(groups.map((group) => [group, answers[group]]));
const saveStep = (token, step, answers = ANSWERS()) => pub("/draft", { token, body: { step, answers: pick(answers, step === "personal" ? PERSONAL : WORK) } });
const submit = (token, answers = ANSWERS(), idempotencyKey = "key-0000000000000001") => pub("/submit", { token, body: { answers, idempotencyKey } });
const loadForm = (token) => pub("/form", { token, body: {} });
const drafts = () => prisma.candidateFormDraft.findMany();
const accessOf = (candidate) => prisma.candidateFormAccess.findUnique({ where: { passportId: candidate.passportId } });

describe("N/A variations", () => {
    const parse = (change) => {
        const answers = ANSWERS();
        change(answers);
        return parseSubmission({ answers, idempotencyKey: "key-0000000000000001" });
    };

    test("N/A, NA, na, n/a, Na and N/a (with spaces around) are accepted where N/A is allowed, and stored as N/A", () => {
        for (const spelling of ["N/A", "n/a", "N/a", "n/A", "NA", "na", "Na", "nA", "  na  ", " N/A "]) {
            const parsed = parse((a) => {
                a.basic.otherNames = spelling;
                a.contact.city = spelling;
                a.contact.alternativePhone = spelling;
                a.qualifications.experience = spelling;
                a.qualifications.otherSkills1 = spelling;
                a.family.father.name = spelling;
                a.family.mother.passportNumber = spelling;
                a.family.child1 = spelling;
            });
            assert.equal(parsed.errors, undefined, `${spelling}: ${JSON.stringify(parsed.errors)}`);
            for (const column of ["otherNames", "city", "alternativePhone", "experience", "otherSkills1", "fatherName", "motherPassportNumber", "child1Name"]) {
                assert.equal(parsed.values[column], "N/A", `${spelling} -> ${column}`);
            }
        }
    });

    test("only the fields that allow N/A take it: n/a is refused elsewhere, and a real answer reading 'Na' is not mistaken for N/A", () => {
        const refused = parse((a) => { a.basic.surname = "n/a"; a.guardian.name = "N/A"; a.contact.address = "n/a"; });
        assert.deepEqual(refused.errors.map((e) => e.field).sort(), ["basic.surname", "contact.address", "guardian.name"]);
        const real = parse((a) => { a.basic.surname = "Na"; a.guardian.name = "na"; });
        assert.equal(real.errors, undefined);
        assert.deepEqual([real.values.surname, real.values.guardianName], ["NA", "NA"], "kept as typed (capitalised), not turned into N/A");
        assert.equal(isNotApplicableFor("basic.surname", "na"), false);
        assert.equal(isNotApplicableFor("basic.otherNames", "na"), true);
        assert.ok(NOT_APPLICABLE_FIELDS.has("family.child1") && !NOT_APPLICABLE_FIELDS.has("guardian.name"));
    });

    test("required fields stay required, and a field's own rules still apply around N/A", () => {
        const missing = parse((a) => { a.basic.otherNames = ""; a.family.child1 = "  "; });
        assert.deepEqual(missing.errors.map((e) => [e.field, e.code]).sort(), [["basic.otherNames", "required"], ["family.child1", "required"]]);
        const badPhone = parse((a) => { a.contact.alternativePhone = "not a phone"; });
        assert.deepEqual(badPhone.errors.map((e) => e.field), ["contact.alternativePhone"]);
        // A parent named NA does not apply: the rest of that parent is no longer needed.
        const noFather = parse((a) => { a.family.father = { name: "na", surname: "", passportNumber: "", birthDate: "" }; });
        assert.equal(noFather.errors, undefined);
        // Children: Child 2 is needed only after a real Child 1 ("NA" is not a real child).
        const noChildren = parse((a) => { a.family.child1 = "na"; });
        assert.equal(noChildren.errors, undefined);
        const aChild = parse((a) => { a.family.child1 = "nimal"; });
        assert.deepEqual(aChild.errors.map((e) => e.field), ["family.child2"]);
    });

    test("a draft step takes the same variations, saved as N/A", async () => {
        const token = await session(A);
        const answers = ANSWERS();
        answers.basic.otherNames = "na";
        answers.contact.city = "Na";
        assert.equal((await saveStep(token, "personal", answers)).status, 200);
        const [row] = await drafts();
        assert.equal(row.answers.basic.otherNames, "N/A");
        assert.equal(row.answers.contact.city, "N/A");
    });
});

describe("saving a step (Next)", () => {
    test("a valid step is saved: one draft row, the step reported as saved, the form still open and nothing submitted", async () => {
        const token = await session(A);
        const r = await saveStep(token, "personal");
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(r.body.savedSteps, ["personal"]);
        assert.ok(Date.parse(r.body.savedAt) > 0);
        const rows = await drafts();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].passportId, A.passportId);
        assert.deepEqual(Object.keys(rows[0].answers).sort(), ["basic", "contact"]);
        assert.equal(rows[0].answers.basic.fullName, "ANUSHA DE SOYSA", "normalised like a submission");
        assert.equal(rows[0].answers.basic.birthDate, "1990-05-01");
        assert.equal((await accessOf(A)).status, "UNLOCKED", "a draft does not lock the form");
        assert.equal(await prisma.candidateFormResponse.count(), 0, "a draft is not a submission");
        // The candidate's own NIC and passport number are never part of the saved answers.
        assert.ok(!JSON.stringify(rows[0].answers).includes(A.nic));
    });

    test("the second step is saved beside the first, never over it", async () => {
        const token = await session(A);
        await saveStep(token, "personal");
        const r = await saveStep(token, "work");
        assert.deepEqual(r.body.savedSteps, ["personal", "work"]);
        const [row] = await drafts();
        assert.deepEqual(Object.keys(row.answers).sort(), [...PERSONAL, ...WORK].sort());
        assert.equal(row.answers.family.father.passportNumber, "N7654321");
        assert.equal(row.answers.guardian.nic, "901234567V");
    });

    test("a step with a problem saves nothing (and says which fields)", async () => {
        const token = await session(A);
        const bad = ANSWERS();
        bad.basic.fullName = "";
        bad.contact.email = "not-an-email";
        const r = await saveStep(token, "personal", bad);
        assert.equal(r.status, 400);
        assert.deepEqual(r.body.errors.map((e) => e.field).sort(), ["basic.fullName", "contact.email"]);
        assert.deepEqual(await drafts(), []);
        // An earlier good save is not damaged by a later bad one.
        await saveStep(token, "personal");
        const before = (await drafts())[0].answers;
        assert.equal((await saveStep(token, "personal", bad)).status, 400);
        assert.deepEqual((await drafts())[0].answers, before);
    });

    test("the spouse is needed for a step only when the saved Civil Status is Married", async () => {
        const token = await session(A);
        const married = ANSWERS();
        married.basic.civilStatus = "MARRIED";
        await saveStep(token, "personal", married);
        const withoutSpouse = await saveStep(token, "work", married);
        assert.equal(withoutSpouse.status, 400);
        assert.deepEqual(withoutSpouse.body.errors.map((e) => e.field).sort(), ["family.spouse.birthDate", "family.spouse.name", "family.spouse.passportNumber", "family.spouse.surname"]);
        married.family.spouse = { name: "nadeesha", surname: "silva", passportNumber: "na", birthDate: "1992-07-08" };
        assert.equal((await saveStep(token, "work", married)).status, 200);
        assert.equal((await drafts())[0].answers.family.spouse.passportNumber, "N/A");
    });

    test("saving the same step again (a double click, a retry after a lost response) leaves one row and the same answers", async () => {
        const token = await session(A);
        const [first, second] = await Promise.all([saveStep(token, "personal"), saveStep(token, "personal")]);
        assert.deepEqual([first.status, second.status], [200, 200]);
        const again = await saveStep(token, "personal");
        assert.equal(again.status, 200);
        assert.deepEqual(again.body.savedSteps, ["personal"]);
        const rows = await drafts();
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0].answers.basic, { fullName: "ANUSHA DE SOYSA", surname: "DE SOYSA", otherNames: "ANUSHA", sex: "FEMALE", civilStatus: "SINGLE", birthDate: "1990-05-01", birthPlace: "NEGOMBO" });
    });

    test("two different steps saved at the same moment both stay", async () => {
        const token = await session(A);
        const results = await Promise.all([saveStep(token, "personal"), saveStep(token, "work")]);
        assert.deepEqual(results.map((r) => r.status), [200, 200]);
        const rows = await drafts();
        assert.equal(rows.length, 1);
        assert.deepEqual(Object.keys(rows[0].answers).sort(), [...PERSONAL, ...WORK].sort());
    });

    test("an earlier step can be revisited and saved again: it changes, the other step does not", async () => {
        const token = await session(A);
        await saveStep(token, "personal");
        await saveStep(token, "work");
        const workBefore = pick((await drafts())[0].answers, WORK);
        const changed = ANSWERS();
        changed.basic.birthPlace = "kandy";
        changed.contact.city = "kandy";
        const r = await saveStep(token, "personal", changed);
        assert.equal(r.status, 200);
        const [row] = await drafts();
        assert.equal(row.answers.basic.birthPlace, "KANDY");
        assert.equal(row.answers.contact.city, "KANDY");
        assert.deepEqual(pick(row.answers, WORK), workBefore);
        assert.deepEqual(r.body.savedSteps, ["personal", "work"]);
    });

    test("only the form's own shape is accepted: unknown fields, other steps' groups, a missing or unknown step", async () => {
        const token = await session(A);
        const attempts = [
            { step: "personal", answers: { ...pick(ANSWERS(), PERSONAL), passport: ANSWERS().passport } },
            { step: "personal", answers: { ...pick(ANSWERS(), PERSONAL), nic: "900000001V" } },
            { step: "personal", answers: pick(ANSWERS(), PERSONAL), passportId: B.passportId },
            { step: "review", answers: {} },
            { answers: pick(ANSWERS(), PERSONAL) },
            { step: "personal", answers: [] },
            { step: "personal", answers: { basic: { ...ANSWERS().basic, passportNumber: "N1" }, contact: ANSWERS().contact } },
        ];
        for (const body of attempts) assert.equal((await pub("/draft", { token, body })).status, 400, JSON.stringify(Object.keys(body)));
        assert.deepEqual(await drafts(), []);
        // A step that sends only part of its groups is missing answers, not partly saved.
        assert.equal((await pub("/draft", { token, body: { step: "personal", answers: { basic: ANSWERS().basic } } })).status, 400);
        assert.deepEqual(await drafts(), []);
    });

    test("opening the form saves nothing by itself", async () => {
        const token = await session(A);
        assert.equal((await loadForm(token)).status, 200);
        assert.equal((await loadForm(token)).status, 200);
        assert.deepEqual(await drafts(), []);
    });
});

describe("recovering saved progress", () => {
    test("opening the form again (a refresh, a new session) restores the saved steps over the prefill", async () => {
        const first = await session(A);
        const untouched = await loadForm(first);
        assert.deepEqual([untouched.body.savedSteps, untouched.body.draftSavedAt], [[], null]);
        assert.equal(untouched.body.answers.basic.birthPlace, "Negombo", "the record's prefill before anything is saved");
        assert.ok(untouched.body.prefilled.includes("basic.birthPlace"));

        const answers = ANSWERS();
        answers.basic.birthPlace = "galle";
        await saveStep(first, "personal", answers);

        // Verify again (the page was reloaded): same candidate, new session.
        const second = await loadForm(await session(A));
        assert.equal(second.status, 200);
        assert.deepEqual(second.body.savedSteps, ["personal"]);
        assert.ok(Date.parse(second.body.draftSavedAt) > 0);
        assert.equal(second.body.answers.basic.birthPlace, "GALLE", "the saved answer, not the record's");
        assert.equal(second.body.answers.contact.email, "Anusha.D@example.com");
        assert.equal(second.body.answers.family.child1, null, "an unsaved step keeps its prefill (here nothing)");
        assert.ok(!second.body.prefilled.some((path) => path.startsWith("basic.") || path.startsWith("contact.")), "saved groups are no longer 'prefilled from your records'");
        assert.equal(second.body.identity.passportNumber, A.passportId);
    });

    test("with both steps saved, everything is restored and the step list says so", async () => {
        const token = await session(A);
        await saveStep(token, "personal");
        await saveStep(token, "work");
        const form = (await loadForm(await session(A))).body;
        assert.deepEqual(form.savedSteps, ["personal", "work"]);
        const restored = { ...pick(form.answers, PERSONAL), ...pick(form.answers, WORK) };
        const expected = ANSWERS();
        assert.equal(restored.family.father.passportNumber, "N7654321");
        assert.equal(restored.qualifications.otherSkills1, "N/A");
        assert.equal(restored.measurements.shoeSize, "EU 42");
        assert.equal(restored.guardian.phone, expected.guardian.phone);
    });

    test("a second device with the candidate's own (new) link sees the same saved progress; the old link no longer works", async () => {
        const oldToken = await session(A);
        await saveStep(oldToken, "personal");
        const newToken = await session(A); // creating a link replaces the previous one
        assert.equal((await loadForm(oldToken)).status, 401);
        assert.deepEqual((await loadForm(newToken)).body.savedSteps, ["personal"]);
        assert.equal((await saveStep(oldToken, "work")).status, 401, "the replaced session cannot save any more");
        assert.equal((await saveStep(newToken, "work")).status, 200);
    });

    test("a draft belongs to its candidate: another candidate never sees it, and a token cannot save for someone else", async () => {
        const tokenA = await session(A);
        await saveStep(tokenA, "personal");
        const tokenB = await session(B);
        const formB = (await loadForm(tokenB)).body;
        assert.deepEqual([formB.savedSteps, formB.draftSavedAt], [[], null]);
        assert.ok(!JSON.stringify(formB).includes("ANUSHA"));
        // B saves: it lands on B's own row only.
        const b = ANSWERS();
        b.basic.fullName = "kamal perera";
        assert.equal((await saveStep(tokenB, "personal", b)).status, 200);
        const rows = await drafts();
        assert.deepEqual(rows.map((row) => row.passportId).sort(), [A.passportId, B.passportId]);
        assert.equal(rows.find((row) => row.passportId === A.passportId).answers.basic.fullName, "ANUSHA DE SOYSA");
        assert.equal(rows.find((row) => row.passportId === B.passportId).answers.basic.fullName, "KAMAL PERERA");
    });

    test("no session, a malformed or another purpose's token cannot read or write a draft", async () => {
        const token = await session(A);
        await saveStep(token, "personal");
        assert.equal((await pub("/draft", { body: { step: "personal", answers: pick(ANSWERS(), PERSONAL) } })).status, 401);
        assert.equal((await pub("/draft", { token: "garbage", body: { step: "personal", answers: pick(ANSWERS(), PERSONAL) } })).status, 401);
        assert.equal((await pub("/form", { body: {} })).status, 401);
        // The public API still has no route that returns a draft.
        for (const path of ["/draft/N1000001", "/drafts", "/saved"]) assert.equal((await pub(path, { token, body: {} })).status, 404, path);
        assert.equal((await call("GET", `${PUBLIC_CANDIDATE_DETAILS_PATH}/draft`)).status, 404);
    });

    test("a revoked link ends saving; the draft is kept for the candidate's next link", async () => {
        const token = await session(A);
        await saveStep(token, "personal");
        await admin("POST", `/candidates/${A.passportId}/form-share/revoke`);
        assert.equal((await saveStep(token, "work")).status, 401);
        assert.equal((await drafts()).length, 1);
        assert.deepEqual((await loadForm(await session(A))).body.savedSteps, ["personal"]);
    });
});

describe("the final submission", () => {
    test("a candidate with saved steps still submits once, the draft does not count, and the draft is gone afterwards", async () => {
        const token = await session(A);
        await saveStep(token, "personal");
        await saveStep(token, "work");
        assert.equal(await prisma.candidateFormResponse.count(), 0, "saved steps are not a submission");
        const r = await submit(token);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(await prisma.candidateFormResponse.count(), 1);
        assert.equal((await accessOf(A)).status, "SUBMITTED");
        assert.deepEqual(await drafts(), [], "the saved answers are not kept next to the submitted ones");
        const saved = await prisma.candidateFormResponse.findUnique({ where: { passportId: A.passportId } });
        assert.equal(saved.fullName, "ANUSHA DE SOYSA");
    });

    test("without any saved step the submission works exactly as before", async () => {
        const token = await session(A);
        assert.equal((await submit(token)).status, 200);
        assert.equal(await prisma.candidateFormResponse.count(), 1);
        assert.deepEqual(await drafts(), []);
    });

    test("a submitted form cannot be saved to or reopened: 409, and no draft appears", async () => {
        const token = await session(A);
        await submit(token);
        const r = await saveStep(token, "personal");
        assert.deepEqual([r.status, r.body.code], [409, "ALREADY_SUBMITTED"]);
        assert.equal((await loadForm(token)).status, 409);
        assert.deepEqual(await drafts(), []);
        const reshare = await admin("POST", `/candidates/${A.passportId}/form-share`);
        assert.deepEqual([reshare.status, reshare.body.code], [409, "FORM_SUBMITTED"]);
    });

    test("a submit that races a save: the form ends submitted with no stray draft, whichever came first", async () => {
        const token = await session(A);
        await saveStep(token, "personal");
        const [save, sent] = await Promise.all([saveStep(token, "work"), submit(token)]);
        assert.equal(sent.status, 200);
        assert.ok([200, 409].includes(save.status), String(save.status));
        assert.deepEqual(await drafts(), []);
        assert.equal(await prisma.candidateFormResponse.count(), 1);
    });
});
