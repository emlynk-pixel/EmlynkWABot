// Candidate Form submissions in Candidate History (GET …/call-logs → activity):
// one CANDIDATE_FORM_SUBMITTED entry per successful submission, derived from
// candidate_form_response (written once, only on success). On a REAL
// PostgreSQL (PGlite, every migration applied) through the real Prisma
// client, the real admin router and the real public router.
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
const ADMIN = { adminId: "u-admin", role: "ADMIN", name: "ADMIN 1", email: "u-admin@example.invalid", authUserId: "00000000-0000-4000-8000-000000000001" };
const A = {
    passportId: "N1000001", uniqueId: "8001", firstName: "Anusha", otherName: "De Soysa", nic: "900000001V", sex: "F", dateOfBirth: new Date("1990-05-01"),
    placeOfBirth: "Negombo", address: "1 Old Road", contactNumber: "0112345678", whatsappNumber: "+94771111111", job: "Welder TIG", jobExperience: "5 years",
    passportIssueDate: new Date("2020-01-15"), passportExpiryDate: new Date("2030-01-14"),
};

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
    await prisma.candidate.create({ data: A });
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

async function session() {
    const shared = await admin("POST", `/candidates/${A.passportId}/form-share`);
    assert.equal(shared.status, 201, JSON.stringify(shared.body));
    const secret = shared.body.url.split("#k=")[1];
    const verified = await pub("/verify", { body: { linkSecret: secret, passportNumber: A.passportId, nic: A.nic } });
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
const submit = (token, answers = ANSWERS(), idempotencyKey = "key-0000000000000001") => pub("/submit", { token, body: { answers, idempotencyKey } });
const history = async () => {
    const r = await admin("GET", `/candidates/${A.passportId}/call-logs`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
};
const formEntries = (body) => body.activity.filter((a) => a.kind === "CANDIDATE_FORM_SUBMITTED");

describe("Candidate Form submissions in Candidate History", () => {
    test("FORM-LOG-001: a successful submission adds exactly one activity entry, attributed to no staff member", async () => {
        assert.deepEqual(formEntries(await history()), [], "nothing before submitting");
        const token = await session();
        assert.equal((await submit(token)).status, 200);
        const entries = formEntries(await history());
        assert.equal(entries.length, 1);
        assert.equal(entries[0].activityId, "form:submitted");
        assert.equal(entries[0].actorName, null);
        assert.equal(entries[0].formLink, "SINGLE");
        assert.equal(entries[0].jobCode, null);
    });

    test("FORM-LOG-002: the entry carries the submission's own date and time", async () => {
        const token = await session();
        const r = await submit(token);
        assert.equal(r.status, 200);
        const [entry] = formEntries(await history());
        const stored = await prisma.candidateFormResponse.findUnique({ where: { passportId: A.passportId }, select: { submittedAt: true } });
        assert.equal(new Date(entry.occurredAt).toISOString(), stored.submittedAt.toISOString());
        assert.equal(new Date(entry.occurredAt).toISOString(), r.body.submittedAt, "the time the candidate was told");
    });

    test("FORM-LOG-003: existing call logs are kept unchanged, with the entry beside them", async () => {
        assert.equal((await admin("POST", `/candidates/${A.passportId}/call-logs`, { body: { note: "Asked to fill in the form" } })).status, 201);
        assert.equal((await admin("POST", `/candidates/${A.passportId}/call-logs`, { body: { outcome: "NO_ANSWER" } })).status, 201);
        const before = await history();
        const rowsBefore = await prisma.candidateCallLog.findMany({ orderBy: { callLogId: "asc" } });

        assert.equal((await submit(await session())).status, 200);
        const afterSubmit = await history();
        assert.deepEqual(afterSubmit.items, before.items, "the call log list is the same");
        assert.deepEqual(await prisma.candidateCallLog.findMany({ orderBy: { callLogId: "asc" } }), rowsBefore, "no call log row added, changed or removed");
        assert.equal(formEntries(afterSubmit).length, 1);
        assert.deepEqual(afterSubmit.activity.filter((a) => a.kind !== "CANDIDATE_FORM_SUBMITTED"), before.activity, "the rest of the history is unchanged");
    });

    test("FORM-LOG-004: a refused or incomplete submission adds nothing", async () => {
        const token = await session();
        const incomplete = ANSWERS();
        incomplete.basic.fullName = "";
        assert.equal((await submit(token, incomplete)).status, 400);
        assert.equal((await submit("not-a-valid-session-token")).status, 401);
        await admin("POST", `/candidates/${A.passportId}/form-share/revoke`);
        assert.equal((await submit(token)).status, 401, "revoked link");
        assert.deepEqual(formEntries(await history()), []);
        assert.equal(await prisma.candidateFormResponse.count(), 0);
    });

    test("FORM-LOG-005: a retried or repeated submission is not logged twice", async () => {
        const token = await session();
        assert.equal((await submit(token, ANSWERS(), "key-retry-0000000001")).status, 200);
        assert.equal((await submit(token, ANSWERS(), "key-retry-0000000001")).status, 200, "safe retry");
        assert.equal((await submit(token, ANSWERS(), "key-other-0000000002")).status, 409, "a second submission");
        assert.equal(formEntries(await history()).length, 1);
        assert.equal(formEntries(await history()).length, 1, "reading the history again adds nothing");
    });

    test("the entry exposes no answers, NIC, passport number, token or link secret", async () => {
        const token = await session();
        assert.equal((await submit(token)).status, 200);
        const [entry] = formEntries(await history());
        assert.deepEqual(Object.keys(entry).sort(), ["activityId", "actorName", "documentType", "fields", "formLink", "jobCode", "kind", "occurredAt", "source", "stage", "variant"]);
        const text = JSON.stringify(entry);
        const link = await prisma.candidateFormLink.findFirst({ select: { linkId: true, tokenHash: true } });
        for (const secret of [A.nic, A.passportId, token, link.linkId, link.tokenHash, "ANUSHA", "901234567V", "N7654321"]) assert.ok(!text.includes(secret), secret);
    });
});
