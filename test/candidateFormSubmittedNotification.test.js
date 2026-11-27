// A4 Candidate Form Submitted (notificationEvents.js notifyCandidateFormSubmitted, sent by
// candidateFormDataService.js submitCandidateForm after its commit). On a REAL PostgreSQL (PGlite,
// every migration applied) through the real Prisma client, the real admin router (to create share
// links) and the real public router. Synthetic data only.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createPublicCandidateDetailsRouter, PUBLIC_CANDIDATE_DETAILS_PATH } from "../src/routes/publicCandidateDetails.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { formSubmittedMessage, NOTIFICATION_TYPE, notifyCandidateFormSubmitted } from "../src/services/notificationEvents.js";

const SECRET = "test-candidate-form-secret-0123456789-abcdefghijklmnop";
const ORIGIN = "https://candidate-form.example.test";
const user = (adminId, role, name, n, status = "ACTIVE") => ({
    adminId, role, name, status, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
});
const USERS = {
    OWNER: user("u-owner", "OWNER", "Olive Owner", 1),
    ADMIN: user("u-admin", "ADMIN", "Ada Admin", 2),
    LEAD: user("u-lead", "TEAM_LEAD", "Tia Lead", 3),
    ANN: user("u-ann", "ANALYST", "Ann Analyst", 4),
    BEN: user("u-ben", "ANALYST", "Ben Analyst", 5),
};
const A = { passportId: "N1000001", uniqueId: "8001", firstName: "Anusha", otherName: "De Soysa", nic: "900000001V", sex: "F", whatsappNumber: "+94771111111" };

let database;
let prisma;
let pg;
const quiet = { warn() {}, error() {}, info() {}, log() {} };

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const u of Object.values(USERS)) await prisma.user.create({ data: u });
});
after(async () => database?.close());
beforeEach(async () => {
    await pg.exec(`
        DROP TRIGGER IF EXISTS "notification_test_fail" ON "notification";
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "notification"; DELETE FROM "rate_limits"; DELETE FROM "candidate_allocation";
        DELETE FROM "candidate_form_sheet_sync"; DELETE FROM "candidate_form_draft";
        DELETE FROM "candidate_form_response"; DELETE FROM "candidate_form_prefill_snapshot"; DELETE FROM "candidate_form_access"; DELETE FROM "candidate_form_link";
        DELETE FROM "candidate_additional_details"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
        UPDATE "user" SET "status" = 'ACTIVE';
    `);
    await prisma.candidate.create({ data: A });
});

const breakNotificationInserts = () => pg.exec(`
    CREATE OR REPLACE FUNCTION "notification_test_fail_fn"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'notification insert refused'; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER "notification_test_fail" BEFORE INSERT ON "notification" FOR EACH ROW EXECUTE FUNCTION "notification_test_fail_fn"();
`);

function app() {
    const server = express();
    server.use(PUBLIC_CANDIDATE_DETAILS_PATH, createPublicCandidateDetailsRouter({ db: prisma, tokenSecret: SECRET, allowedOrigin: ORIGIN, verifyIpLimiter: noRateLimit, verifyPassportLimiter: noRateLimit, log: quiet }));
    server.use(express.json());
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: USERS.ADMIN.adminId }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
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

async function session(candidate) {
    const shared = await call("POST", `/api/admin/candidates/${candidate.passportId}/form-share`);
    assert.equal(shared.status, 201, JSON.stringify(shared.body));
    const verified = await pub("/verify", { body: { linkSecret: shared.body.url.split("#k=")[1], passportNumber: candidate.passportId, nic: candidate.nic } });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    return verified.body.token;
}

const ANSWERS = () => ({
    basic: { fullName: "anusha de soysa", surname: "de soysa", otherNames: "anusha", sex: "FEMALE", civilStatus: "SINGLE", birthDate: "1990-05-01", birthPlace: "negombo", bloodGroup: "O+", height: "175 cm", weight: "70", drivingLicence: "YES", canReadDrawings: "NO", teamLeadingSkills: "YES", otherLanguages: "english, romanian" },
    contact: { address: "12 galle road", city: "negombo", district: "gampaha", dsDivision: "negombo", gnDivision: "kurana", alternativePhone: "0771234567", email: "Anusha.D@example.com", cityInRomania: "cluj napoca" },
    passport: { issueDate: "2020-01-15", expiryDate: "2030-01-14" },
    qualifications: { jobCategory: "WELDER TIG", jobCategoryOther: "", experience: "5 years", otherSkills1: "n/a", otherSkills2: "N/A", englishKnowledge: "GOOD" },
    measurements: { shirtSize: "M", waistSize: "32", shoeSize: "eu 42" },
    family: {
        father: { name: "sunil", surname: "de soysa", passportNumber: "n7654321", birthDate: "1960-03-02" },
        mother: { name: "kumari", surname: "de soysa", passportNumber: "N/A", birthDate: "1965-02-03" },
        spouse: { name: "", surname: "", passportNumber: "", birthDate: "" },
        child1: "N/A", child2: "", child3: "", fatherAlive: "YES", motherAlive: "YES",
    },
    guardian: { name: "kamal perera", relationship: "uncle", nic: "901234567v", birthDate: "1960-01-01", phone: "+94 77 123 4567", address: "45 lake road" },
});
const KEY = "key-a4-000000000001";
const submit = (token, idempotencyKey = KEY) => pub("/submit", { token, body: { answers: ANSWERS(), idempotencyKey } });
const allocate = (analyst) => prisma.candidateAllocation.create({ data: { passportId: A.passportId, analystId: analyst.adminId } });
const rowsOf = (who) => prisma.notification.findMany({ where: { recipientId: who.adminId } });
const allRows = () => prisma.notification.findMany({ where: { type: NOTIFICATION_TYPE.A4 } });

describe("A4 Candidate Form Submitted", () => {
    test("only the allocated Analyst, with the candidate's name; another Analyst, Team Lead, Admin and Owner get nothing", async () => {
        await allocate(USERS.ANN);
        const token = await session(A);
        const res = await submit(token);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        const ann = await rowsOf(USERS.ANN);
        assert.equal(ann.length, 1);
        assert.deepEqual([ann[0].type, ann[0].title, ann[0].message], [NOTIFICATION_TYPE.A4, "Candidate Form Submitted", "Anusha De Soysa has submitted the candidate form."]);
        assert.equal(ann[0].dedupeKey, `A4:${A.passportId}:${res.body.submittedAt}`);
        for (const other of [USERS.BEN, USERS.LEAD, USERS.ADMIN, USERS.OWNER]) assert.equal((await rowsOf(other)).length, 0, other.adminId);
        assert.equal((await allRows()).length, 1);
    });

    test("a repeated submit request (same idempotency key) succeeds again and adds no second notification", async () => {
        await allocate(USERS.ANN);
        const token = await session(A);
        const first = await submit(token);
        assert.equal(first.status, 200);
        const again = await submit(token);
        assert.equal(again.status, 200);
        assert.equal(again.body.submittedAt, first.body.submittedAt);
        const other = await submit(token, "key-a4-000000000002");
        assert.equal(other.status, 409, "a different submission of a submitted form is refused");
        assert.equal((await rowsOf(USERS.ANN)).length, 1);
    });

    test("an unallocated candidate: the submission succeeds and nobody is notified", async () => {
        const res = await submit(await session(A));
        assert.equal(res.status, 200);
        assert.equal(await prisma.notification.count(), 0);
    });

    test("a candidate allocated to a Team Lead, or to an INACTIVE Analyst: the submission succeeds and nobody is notified", async () => {
        await allocate(USERS.LEAD);
        assert.equal((await submit(await session(A))).status, 200);
        assert.equal(await prisma.notification.count(), 0);

        await pg.exec(`
            DELETE FROM "candidate_form_sheet_sync"; DELETE FROM "candidate_form_response"; DELETE FROM "candidate_form_access";
            UPDATE "candidate_allocation" SET "analyst_id" = 'u-ann'; UPDATE "user" SET "status" = 'INACTIVE' WHERE "admin_id" = 'u-ann';
        `);
        assert.equal((await submit(await session(A), "key-a4-000000000003")).status, 200);
        assert.equal(await prisma.notification.count(), 0);
    });

    test("a failing notification write never breaks the submission", async () => {
        await allocate(USERS.ANN);
        const token = await session(A);
        await breakNotificationInserts();
        const logged = [];
        const original = console.error;
        console.error = (line) => logged.push(String(line));
        let res;
        try {
            res = await submit(token);
        } finally {
            console.error = original;
        }
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal((await prisma.candidateFormAccess.findUnique({ where: { passportId: A.passportId } })).status, "SUBMITTED", "the submission is committed");
        assert.equal(await prisma.candidateFormResponse.count({ where: { passportId: A.passportId } }), 1);
        assert.equal(await prisma.notification.count(), 0);
        const line = logged.find((l) => l.includes("notification.write_failed"));
        assert.ok(line, "logged");
        assert.deepEqual(JSON.parse(line).types, [NOTIFICATION_TYPE.A4]);
        assert.doesNotMatch(line, /Anusha|Soysa|N1000001|submitted the candidate form/, "no names, identifiers or text in the log");
    });

    test("an empty name is 'A candidate', never the passport number; a failing candidate lookup sends nothing and does not throw", async () => {
        assert.equal(formSubmittedMessage("Anusha De Soysa"), "Anusha De Soysa has submitted the candidate form.");
        assert.equal(formSubmittedMessage(null), "A candidate has submitted the candidate form.");
        await pg.exec(`UPDATE "candidate" SET "first_name" = '', "other_name" = NULL`);
        await allocate(USERS.ANN);
        const at = new Date("2026-11-24T10:00:00.000Z");
        assert.equal((await notifyCandidateFormSubmitted(prisma, { passportId: A.passportId, submittedAt: at })).created, 1);
        const [row] = await rowsOf(USERS.ANN);
        assert.equal(row.message, "A candidate has submitted the candidate form.");
        assert.doesNotMatch(`${row.title} ${row.message}`, /N1000001/, "no passport number in the text");
        assert.equal(row.candidateId, A.passportId, "which candidate travels as candidateId");

        const broken = { candidate: { findUnique: async () => { throw new Error("down"); } }, notification: prisma.notification, user: prisma.user };
        assert.deepEqual(await notifyCandidateFormSubmitted(broken, { passportId: A.passportId, submittedAt: at }), { created: 0, failed: true });
    });
});
