// End-to-end verification of the Candidate Form lifecycle on a REAL PostgreSQL
// (PGlite, every migration applied), through the real Prisma client, the real
// admin router and the real public router. It fills the gaps left by
// candidateFormShare.test.js, jobGroupShare.test.js and publicCandidateDetails.test.js:
// expiry, revocation after submission, lock bypass attempts, request-selected
// candidates, group-link lockout, group double submit, and the database
// triggers / constraints themselves. No Supabase.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createPublicCandidateDetailsRouter, PUBLIC_CANDIDATE_DETAILS_PATH } from "../src/routes/publicCandidateDetails.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { FORM_LINK_TTL_MS } from "../src/services/candidateFormShareService.js";
import { GROUP_LINK_MAX_FAILURES } from "../src/services/candidateFormJobGroupService.js";
import { issueCandidateFormToken } from "../src/services/candidateFormTokenService.js";

const SECRET = "test-candidate-form-secret-0123456789-abcdefghijklmnop";
const ORIGIN = "https://candidate-form.example.test";
const user = (adminId, role, n) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const USERS = { ADMIN: user("u-admin", "ADMIN", 1), MANAGER: user("u-manager", "MANAGER", 2), DESK: user("u-desk", "REGISTRATION_DESK", 3), ANN: user("u-ann", "ANALYST", 4), BEN: user("u-ben", "ANALYST", 5) };
const C = (i) => ({ passportId: `N800000${i}`, uniqueId: `800${i}`, firstName: `First${i}`, otherName: `Last${i}`, nic: `80000000${i}V`, sex: "M", whatsappNumber: `+9476000000${i}`, address: `${i} Old Road` });
const [A, B, X] = [C(1), C(2), C(3)];

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
        DELETE FROM "rate_limits";
        DELETE FROM "candidate_form_response"; DELETE FROM "candidate_form_prefill_snapshot"; DELETE FROM "candidate_form_access"; DELETE FROM "candidate_form_link";
        DELETE FROM "job_candidate"; DELETE FROM "job"; DELETE FROM "job_code_counter"; DELETE FROM "job_type"; DELETE FROM "client"; DELETE FROM "agent";
        DELETE FROM "candidate_allocation"; DELETE FROM "candidate_additional_details"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
    `);
    await prisma.candidate.createMany({ data: [A, B, X] });
    // Only a candidate who passed the test can be assigned to a job (jobAssignmentTestPass.test.js).
    await prisma.candidateStage.createMany({ data: [A, B, X].map((c) => ({ passportId: c.passportId, stage: "TEST_DETAILS", testResult: "PASS" })) });
    await prisma.candidateAllocation.create({ data: { passportId: A.passportId, analystId: USERS.ANN.adminId } });
});

function app(who, { limiter = noRateLimit } = {}) {
    const server = express();
    server.use(PUBLIC_CANDIDATE_DETAILS_PATH, createPublicCandidateDetailsRouter({ db: prisma, tokenSecret: SECRET, allowedOrigin: ORIGIN, verifyIpLimiter: limiter, verifyPassportLimiter: noRateLimit, log: captureLog }));
    server.use(express.json());
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: who.adminId }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
        next();
    };
    server.use("/api/admin", createAdminRouter({ db: prisma, bucket: {}, requireAdmin, apiLimiter: noRateLimit, candidateFormOrigin: ORIGIN }));
    server.use(errorHandler);
    return server;
}
async function call(server, method, path, { body, token, headers: extra = {} } = {}) {
    const listener = await new Promise((resolve) => { const s = server.listen(0, "127.0.0.1", () => resolve(s)); });
    try {
        const headers = { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
        const res = await fetch(`http://127.0.0.1:${listener.address().port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
    } finally {
        listener.close();
    }
}
const admin = (who, method, path, options) => call(app(who), method, `/api/admin${path}`, options);
const pub = (path, options, who = USERS.ADMIN) => call(app(who), "POST", `${PUBLIC_CANDIDATE_DETAILS_PATH}${path}`, options);
const personalLink = async (c, who = USERS.MANAGER) => {
    const r = await admin(who, "POST", `/candidates/${c.passportId}/form-share`);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.url.split("#k=")[1];
};
const verify = (secret, c, extra = {}) => pub("/verify", { body: { linkSecret: secret, passportNumber: c.passportId, nic: c.nic, ...extra } });
const session = async (secret, c) => {
    const r = await verify(secret, c);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.token;
};
const ANSWERS = () => ({
    basic: { fullName: "anusha de soysa", surname: "de soysa", otherNames: "anusha", sex: "FEMALE", civilStatus: "SINGLE", birthDate: "1990-05-01", birthPlace: "negombo" },
    contact: { address: "12 galle road", city: "", district: "gampaha", dsDivision: "negombo", gnDivision: "", alternativePhone: "0771234567", email: "a@example.com" },
    passport: { issueDate: "2020-01-15", expiryDate: "2030-01-14" },
    qualifications: { jobCategory: "WELDER TIG", jobCategoryOther: "", experience: "5 years", otherSkills1: "", otherSkills2: "", englishKnowledge: "GOOD" },
    measurements: { shirtSize: "M", waistSize: "32", shoeSize: "eu 42" },
    family: {
        father: { name: "", surname: "", passportNumber: "", birthDate: "" }, mother: { name: "", surname: "", passportNumber: "", birthDate: "" },
        spouse: { name: "", surname: "", passportNumber: "", birthDate: "" }, child1: "", child2: "", child3: "",
    },
    guardian: { name: "kamal perera", relationship: "uncle", nic: "901234567v", birthDate: "", phone: "+94 77 123 4567", address: "45 lake road" },
});
const submit = (token, key = "key-0000000000000001") => pub("/submit", { token, body: { answers: ANSWERS(), idempotencyKey: key } });
const form = (token, options = {}) => pub("/form", { token, body: {}, ...options });
const access = (c) => prisma.candidateFormAccess.findUnique({ where: { passportId: c.passportId } });
const GENERIC = (r) => { assert.equal(r.status, 401); assert.equal(r.body.code, "VERIFICATION_FAILED"); };
const newJobWith = async (...members) => {
    const [jobType, agent] = await Promise.all([
        prisma.jobType.create({ data: { code: "T", name: "T" } }), prisma.agent.create({ data: { name: "Ag", countryCode: "RO" } }),
    ]);
    const client = await prisma.client.create({ data: { name: "Co", agentId: agent.id } });
    const job = (await admin(USERS.MANAGER, "POST", "/jobs", { body: { jobTypeId: jobType.id, clientId: client.id, responsibleAgentId: agent.id } })).body;
    for (const m of members) await admin(USERS.MANAGER, "POST", `/jobs/${job.jobId}/candidates`, { body: { passportId: m.passportId } });
    return job;
};
const groupLink = async (job) => (await admin(USERS.MANAGER, "POST", `/jobs/${job.jobId}/form-share`)).body.url.split("#k=")[1];

describe("EXPIRY: exact behaviour of link lifetime", () => {
    test("EXPIRY-001/002/003/004/005 a fresh link works for exactly 3 days; an expired one is the generic failure and cannot start a session", async () => {
        assert.equal(FORM_LINK_TTL_MS, 3 * 24 * 60 * 60 * 1000);
        const secret = await personalLink(A);
        const link = await prisma.candidateFormLink.findFirst();
        assert.ok(Math.abs(link.expiresAt - link.createdAt - FORM_LINK_TTL_MS) < 1000, "expires_at = created_at + 3 days");
        assert.equal((await verify(secret, A)).status, 200);
        // One millisecond before and after the boundary, by moving the stored expiry.
        await pg.exec(`UPDATE "candidate_form_link" SET "expires_at" = now() + interval '5 seconds'`);
        assert.equal((await verify(secret, A)).status, 200, "still valid just before");
        await pg.exec(`UPDATE "candidate_form_link" SET "expires_at" = now() - interval '1 second'`);
        const expired = await verify(secret, A);
        GENERIC(expired);
        assert.equal(JSON.stringify(expired.body), JSON.stringify((await verify("A".repeat(43), A)).body), "same body as an unknown link");
        assert.equal(JSON.stringify(expired.body), JSON.stringify((await verify(secret, A, { nic: B.nic })).body), "same body as a wrong NIC");
    });

    test("EXPIRY-006 an open session ends on its next request once the link expired (the design: the link is re-checked every request)", async () => {
        const secret = await personalLink(A);
        const token = await session(secret, A);
        assert.equal((await form(token)).status, 200);
        await pg.exec(`UPDATE "candidate_form_link" SET "expires_at" = now() - interval '1 second'`);
        const r = await form(token);
        assert.deepEqual([r.status, r.body.code], [401, "VERIFICATION_REQUIRED"]);
        assert.equal((await submit(token)).status, 401);
        assert.equal(await prisma.candidateFormResponse.count(), 0);
    });

    test("EXPIRY-007/008 a new link gets a new expiry; an expired link never reactivates by itself", async () => {
        const first = await personalLink(A);
        await pg.exec(`UPDATE "candidate_form_link" SET "expires_at" = now() - interval '1 hour'`);
        const before = await prisma.candidateFormLink.findFirst();
        GENERIC(await verify(first, A));
        GENERIC(await verify(first, A));
        const unchanged = await prisma.candidateFormLink.findFirst();
        assert.deepEqual([unchanged.expiresAt.getTime(), unchanged.revokedAt], [before.expiresAt.getTime(), null], "verify attempts did not touch the expiry");
        // Admin status says no active link; the candidate form stays locked for the expired link.
        assert.equal((await admin(USERS.MANAGER, "GET", `/candidates/${A.passportId}/form-share`)).body.state, "LOCKED");
        const second = await personalLink(A);
        const links = await prisma.candidateFormLink.findMany({ orderBy: { createdAt: "asc" } });
        assert.ok(links[1].expiresAt > new Date(Date.now() + FORM_LINK_TTL_MS - 60_000), "fresh 3 days");
        GENERIC(await verify(first, A));
        assert.equal((await verify(second, A)).status, 200);
    });
});

describe("PERSONAL: the candidate cannot choose who they are", () => {
    test("PERSONAL-015 another candidate's passport in the body, query or path changes nothing: the session decides", async () => {
        const secret = await personalLink(A);
        const token = await session(secret, A);
        const viaBody = await form(token, { body: { passportId: B.passportId, passportNumber: B.passportId, candidate: B.passportId } });
        assert.equal(viaBody.body.identity.passportNumber, A.passportId);
        const viaQuery = await call(app(USERS.ADMIN), "POST", `${PUBLIC_CANDIDATE_DETAILS_PATH}/form?passportId=${B.passportId}&candidate=${B.passportId}`, { token, body: {} });
        assert.equal(viaQuery.body.identity.passportNumber, A.passportId);
        const viaPath = await call(app(USERS.ADMIN), "POST", `${PUBLIC_CANDIDATE_DETAILS_PATH}/form/${B.passportId}`, { token, body: {} });
        assert.equal(viaPath.status, 404);
        const submitted = await pub("/submit", { token, body: { answers: ANSWERS(), idempotencyKey: "key-0000000000000009", passportId: B.passportId } });
        assert.equal(submitted.status, 400, "unknown top-level key refused");
        assert.equal(await prisma.candidateFormResponse.count(), 0);
        assert.equal((await submit(token)).status, 200);
        assert.deepEqual((await prisma.candidateFormResponse.findMany()).map((r) => r.passportId), [A.passportId], "stored under the verified candidate only");
        assert.equal((await access(B)), null);
    });
});

describe("LOCK: the lock lives on the server", () => {
    test("LOCK-001 valid Passport + NIC without any link, or with a link for someone else, never opens the form; a forged session for a LOCKED candidate is refused", async () => {
        GENERIC(await verify("B".repeat(43), A));
        const others = await personalLink(B);
        GENERIC(await verify(others, A));
        assert.equal((await access(A)), null, "A was never unlocked");
        const forged = issueCandidateFormToken({ secret: SECRET, passportId: A.passportId, linkId: (await prisma.candidateFormLink.findFirst()).linkId, version: 0 }).token;
        assert.equal((await form(forged)).status, 401, "the token is bound to B's link");
    });

    test("LOCK-004..011 after submission nothing re-opens it: new link, group link, a fresh device with the same details, a replayed token, a direct state change", async () => {
        const secret = await personalLink(A);
        const token = await session(secret, A);
        assert.equal((await submit(token)).status, 200);
        const finalAccess = await access(A);
        assert.equal(finalAccess.status, "SUBMITTED");
        assert.ok(finalAccess.submittedAt);

        // "Another browser / Incognito / device / cleared storage": the server only sees the request.
        const otherDevice = await verify(secret, A);
        assert.deepEqual([otherDevice.status, otherDevice.body.code], [409, "ALREADY_SUBMITTED"]);
        assert.equal((await form(token)).status, 409, "the old token cannot read the form");
        assert.equal((await submit(token, "key-other-0000000001")).status, 409);
        // A new personal link is refused; a group link does not reopen either.
        const again = await admin(USERS.MANAGER, "POST", `/candidates/${A.passportId}/form-share`);
        assert.deepEqual([again.status, again.body.code], [409, "FORM_SUBMITTED"]);
        const job = await newJobWith(A, B);
        const group = await groupLink(job);
        assert.equal((await verify(group, A)).status, 409);
        assert.equal((await access(A)).status, "SUBMITTED");
        // The frontend cannot change the state: there is no endpoint, and the database refuses a direct edit.
        await assert.rejects(pg.exec(`UPDATE "candidate_form_access" SET "status" = 'UNLOCKED' WHERE "passport_id" = '${A.passportId}'`), /submitted form cannot be changed/);
        await assert.rejects(pg.exec(`UPDATE "candidate_form_access" SET "version" = "version" + 1 WHERE "passport_id" = '${A.passportId}'`), /cannot be changed/);
        assert.equal((await verify(group, B)).status, 200, "B, who has not submitted, is unaffected");
    });

    test("LOCK-002/003 creating the link unlocks exactly the eligible candidates (personal: one; group: the job's members only)", async () => {
        await personalLink(A);
        assert.equal((await access(A)).status, "UNLOCKED");
        assert.equal(await access(B), null);
        const job = await newJobWith(B);
        await groupLink(job);
        assert.equal((await access(B)).status, "UNLOCKED");
        assert.equal(await access(X), null, "an outsider stays LOCKED");
    });
});

describe("REVOKE: after submission and in the audit", () => {
    test("REVOKE-005/006/007 revoking keeps the submitted data, does not unlock a submitted candidate, and the audit never holds the secret", async () => {
        const secret = await personalLink(A);
        assert.equal((await submit(await session(secret, A))).status, 200);
        const response = await prisma.candidateFormResponse.findUnique({ where: { passportId: A.passportId } });
        const revoked = await admin(USERS.MANAGER, "POST", `/candidates/${A.passportId}/form-share/revoke`);
        assert.equal(revoked.status, 200);
        assert.equal(revoked.body.state, "SUBMITTED", "still submitted, not locked or reopened");
        assert.equal((await access(A)).status, "SUBMITTED");
        assert.deepEqual(await prisma.candidateFormResponse.findUnique({ where: { passportId: A.passportId } }), response, "the answers are untouched");
        assert.equal(await prisma.candidateFormPrefillSnapshot.count(), 1);
        GENERIC(await verify(secret, B));
        const audit = JSON.stringify(await prisma.auditLog.findMany());
        assert.ok(audit.includes("REVOKE_FORM_LINK") && !audit.includes(secret));
        assert.ok(!logs.flat().join(" ").includes(secret));
    });
});

describe("GROUP: lockout and double submit", () => {
    test("VERIFY-013 a group link is locked after its (higher) failure limit, even for a correct candidate; the failures are counted per link", async () => {
        const job = await newJobWith(A);
        const secret = await groupLink(job);
        await pg.exec(`UPDATE "candidate_form_link" SET "failed_attempts" = ${GROUP_LINK_MAX_FAILURES - 1}`);
        GENERIC(await verify(secret, A, { nic: B.nic }));
        const link = await prisma.candidateFormLink.findFirst();
        assert.ok(link.lockedUntil && link.lockedUntil > new Date());
        GENERIC(await verify(secret, A));
        assert.equal((await admin(USERS.MANAGER, "GET", `/jobs/${job.jobId}/form-share`)).body.link.lockedUntil !== null, true);
        // A wrong-NIC attempt on a member below the limit is only counted.
        await pg.exec(`UPDATE "candidate_form_link" SET "locked_until" = NULL, "failed_attempts" = 0`);
        GENERIC(await verify(secret, A, { nic: B.nic }));
        assert.equal((await prisma.candidateFormLink.findFirst()).failedAttempts, 1);
    });

    test("RACE-002/003/004/006 two devices of the same group member submit at once: one wins, the other gets a safe conflict, one stored response", async () => {
        const job = await newJobWith(A);
        const secret = await groupLink(job);
        const [t1, t2] = [await session(secret, A), await session(secret, A)];
        const results = await Promise.all([submit(t1, "key-device-000000001"), submit(t2, "key-device-000000002")]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        assert.equal(results.find((r) => r.status === 409).body.code, "ALREADY_SUBMITTED");
        assert.equal(await prisma.candidateFormResponse.count(), 1);
        assert.equal((await access(A)).status, "SUBMITTED");
    });

    test("RACE-005 the same request retried with the same key returns the original success, and stores nothing twice", async () => {
        const secret = await personalLink(A);
        const token = await session(secret, A);
        const first = await submit(token, "key-retry-0000000001");
        const retry = await submit(token, "key-retry-0000000001");
        assert.deepEqual([first.status, retry.status], [200, 200]);
        assert.equal(first.body.submittedAt, retry.body.submittedAt);
        assert.equal(await prisma.candidateFormResponse.count(), 1);
    });
});

describe("SUBMIT / DBSEC: what the database itself enforces", () => {
    test("SUBMIT-007..013 / DBSEC-006..008 the answers go only to candidate_form_response; the main tables are untouched; response and snapshot cannot be edited", async () => {
        const candidateBefore = JSON.stringify(await prisma.candidate.findUnique({ where: { passportId: A.passportId } }));
        const secret = await personalLink(A);
        const token = await session(secret, A);
        assert.equal((await form(token)).status, 200);
        const snapshot = await prisma.candidateFormPrefillSnapshot.findUnique({ where: { passportId: A.passportId } });
        assert.equal((await submit(token)).status, 200);
        assert.equal(JSON.stringify(await prisma.candidate.findUnique({ where: { passportId: A.passportId } })), candidateBefore, "candidate row unchanged");
        assert.equal(await prisma.candidateAdditionalDetails.count(), 0);
        assert.equal(await prisma.candidateStage.count({ where: { NOT: { stage: "TEST_DETAILS" } } }), 0, "no stage written (only the seeded Test result PASS rows exist)");
        const response = await prisma.candidateFormResponse.findUnique({ where: { passportId: A.passportId } });
        assert.equal(response.fullName, "ANUSHA DE SOYSA", "server upper-cases English");
        assert.equal(response.nic, A.nic, "the verified NIC, not typed");
        assert.ok((await access(A)).submittedAt);
        await assert.rejects(pg.exec(`UPDATE "candidate_form_response" SET "full_name" = 'CHANGED' WHERE "passport_id" = '${A.passportId}'`), /cannot be changed/);
        await assert.rejects(pg.exec(`UPDATE "candidate_form_prefill_snapshot" SET "address" = 'CHANGED' WHERE "passport_id" = '${A.passportId}'`), /cannot be changed/);
        // A staff edit of the candidate later does not touch the snapshot either.
        await prisma.candidate.update({ where: { passportId: A.passportId }, data: { address: "New Address" } });
        assert.deepEqual(await prisma.candidateFormPrefillSnapshot.findUnique({ where: { passportId: A.passportId } }), snapshot);
    });

    test("SUBMIT-003/004 unknown and internal fields are refused, nothing is stored", async () => {
        const token = await session(await personalLink(A), A);
        for (const extra of [{ basic: { ...ANSWERS().basic, registerNumber: "1" } }, { staff: { notes: "x" } }, { basic: { ...ANSWERS().basic, uniqueId: "9" } }, { __proto__: { admin: true }, job: "x" }]) {
            const answers = { ...ANSWERS(), ...extra };
            assert.equal((await pub("/submit", { token, body: { answers, idempotencyKey: "key-0000000000000001" } })).status, 400, JSON.stringify(Object.keys(extra)));
        }
        assert.equal(await prisma.candidateFormResponse.count(), 0);
        assert.equal((await access(A)).status, "UNLOCKED");
    });

    test("DBSEC-005/009/010 foreign keys, the link target CHECK and the Client Job ID constraint hold", async () => {
        await assert.rejects(pg.exec(`INSERT INTO "candidate_form_link" ("link_id","kind","job_id","token_hash","created_by","expires_at") VALUES ('z1','JOB_GROUP', gen_random_uuid(), '${"e".repeat(64)}','u-admin', now())`), /foreign key/i);
        await assert.rejects(pg.exec(`INSERT INTO "candidate_form_link" ("link_id","kind","token_hash","created_by","expires_at") VALUES ('z2','SINGLE','${"f".repeat(64)}','u-admin', now())`), /check/i);
        await assert.rejects(pg.exec(`INSERT INTO "candidate_form_access" ("passport_id","status") VALUES ('${X.passportId}','SUBMITTED')`), /check/i, "SUBMITTED needs submitted_at");
        const job = await newJobWith();
        await assert.rejects(pg.exec(`UPDATE "job" SET "company_job_id" = 'bad value!' WHERE "id" = '${job.jobId}'`), /check/i);
    });
});
