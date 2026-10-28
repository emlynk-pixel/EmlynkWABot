// Candidate Form link architecture: job-bound GROUP links and passport-bound
// SINGLE links, plus the attack / negative cases (GROUP-LINK-*, SINGLE-LINK-*,
// SECURITY-*). Docs/CANDIDATE_EXTRA_DETAILS_FORM_SHARE_LINKS_DESIGN.md §13.
// On a REAL PostgreSQL (PGlite, every migration applied) through the real Prisma
// client, the real admin router and the real public router. Synthetic data only.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createPublicCandidateDetailsRouter, PUBLIC_CANDIDATE_DETAILS_PATH } from "../src/routes/publicCandidateDetails.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { FORM_LINK_SECRET_BYTES, hashLinkSecret, newLinkSecret } from "../src/services/candidateFormShareService.js";
import { issueCandidateFormToken, readCandidateFormToken } from "../src/services/candidateFormTokenService.js";
import { canonicalPassport } from "../src/services/candidateFormVerificationService.js";

const SECRET = "test-candidate-form-secret-0123456789-abcdefghijklmnop";
const ORIGIN = "https://candidate-form.example.test";
const user = (adminId, role, n) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const USERS = { ADMIN: user("u-admin", "ADMIN", 1), MANAGER: user("u-manager", "MANAGER", 2), DESK: user("u-desk", "REGISTRATION_DESK", 3), ANN: user("u-ann", "ANALYST", 4) };
const C = (i) => ({ passportId: `N800000${i}`, uniqueId: `800${i}`, firstName: `First${i}`, otherName: `Last${i}`, nic: `80000000${i}V`, sex: "M", whatsappNumber: `+9477100000${i}` });
// A, C3 on Job A; B on Job B; D on no job.
const [A, B, C3, D] = [C(1), C(2), C(3), C(4)];

let database;
let prisma;
let pg;
let ids;
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
        DELETE FROM "job_candidate"; DELETE FROM "job"; DELETE FROM "job_code_counter"; DELETE FROM "job_type"; DELETE FROM "agent_client"; DELETE FROM "client"; DELETE FROM "agent";
        DELETE FROM "candidate_allocation"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
        -- The active job types this suite's candidates use (Settings > Job Types).
        INSERT INTO "job_type" ("code", "name") VALUES ('WELDER_TIG_SEED', 'WELDER TIG') ON CONFLICT DO NOTHING;
    `);
    await prisma.candidate.createMany({ data: [A, B, C3, D] });
    // Only a candidate who passed the test can be assigned to a job (jobAssignmentTestPass.test.js).
    await prisma.candidateStage.createMany({ data: [A, B, C3, D].map((c) => ({ passportId: c.passportId, stage: "TEST_DETAILS", testResult: "PASS" })) });
    const [jobType, agent] = await Promise.all([
        prisma.jobType.create({ data: { code: "WELDER", name: "Welder" } }),
        prisma.agent.create({ data: { name: "Ion Popescu", countryCode: "RO" } }),
    ]);
    const client = await prisma.client.create({ data: { name: "Acme Construction", agentLinks: { create: { agentId: agent.id } } } });
    ids = { jobType: jobType.id, client: client.id, agent: agent.id };
});

function app(who, { limiters = true } = {}) {
    const server = express();
    const limits = limiters ? { verifyIpLimiter: noRateLimit, verifyPassportLimiter: noRateLimit } : {};
    server.use(PUBLIC_CANDIDATE_DETAILS_PATH, createPublicCandidateDetailsRouter({ db: prisma, tokenSecret: SECRET, allowedOrigin: ORIGIN, log: captureLog, ...limits }));
    server.use(express.json());
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: who.adminId }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
        next();
    };
    server.use("/api/admin", createAdminRouter({ db: prisma, bucket: {}, requireAdmin, apiLimiter: noRateLimit, candidateFormOrigin: ORIGIN }));
    server.use(errorHandler);
    return server;
}
async function call(server, method, path, { body, raw, token } = {}) {
    const listener = await new Promise((resolve) => { const s = server.listen(0, "127.0.0.1", () => resolve(s)); });
    try {
        const headers = { ...(body !== undefined || raw !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
        const res = await fetch(`http://127.0.0.1:${listener.address().port}${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
        const text = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, body: parsed, text };
    } finally {
        listener.close();
    }
}
const admin = (who, method, path, options) => call(app(who), method, `/api/admin${path}`, options);
const pub = (path, options, server = app(USERS.ADMIN)) => call(server, "POST", `${PUBLIC_CANDIDATE_DETAILS_PATH}${path}`, options);

const newJob = async () => {
    const r = await admin(USERS.MANAGER, "POST", "/jobs", { body: { jobTypeId: ids.jobType, clientId: ids.client, responsibleAgentId: ids.agent } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
};
const assign = async (job, ...candidates) => {
    for (const c of candidates) assert.equal((await admin(USERS.MANAGER, "POST", `/jobs/${job.jobId}/candidates`, { body: { passportId: c.passportId } })).status, 201);
};
const secretOf = (url) => url.split("#k=")[1];
const createGroup = async (job, who = USERS.MANAGER) => {
    const r = await admin(who, "POST", `/jobs/${job.jobId}/form-share`);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
};
const createSingle = async (c, who = USERS.MANAGER) => {
    const r = await admin(who, "POST", `/candidates/${c.passportId}/form-share`);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
};
const verify = (secret, c, overrides = {}, server) => pub("/verify", { body: { linkSecret: secret, passportNumber: c.passportId, nic: c.nic, ...overrides } }, server);
const VERIFY_FAILED = { status: 401, code: "VERIFICATION_FAILED" };
const expectGeneric = (r, label) => assert.deepEqual({ status: r.status, code: r.body?.code }, VERIFY_FAILED, label);
const session = async (secret, c, overrides) => {
    const r = await verify(secret, c, overrides);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.token;
};
const ANSWERS = () => ({
    basic: { fullName: "anusha de soysa", surname: "de soysa", otherNames: "anusha", sex: "FEMALE", civilStatus: "SINGLE", birthDate: "1990-05-01", birthPlace: "negombo", bloodGroup: "O+", height: "175 cm", weight: "70", drivingLicence: "YES", canReadDrawings: "NO", teamLeadingSkills: "YES", otherLanguages: "english, romanian" },
    contact: { address: "12 galle road", city: "negombo", district: "gampaha", dsDivision: "negombo", gnDivision: "kurana", alternativePhone: "0771234567", email: "a@example.com", cityInRomania: "cluj napoca" },
    passport: { issueDate: "2020-01-15", expiryDate: "2030-01-14" },
    qualifications: { jobCategory: "WELDER TIG", jobCategoryOther: "", experience: "5 years", otherSkills1: "n/a", otherSkills2: "N/A", englishKnowledge: "GOOD" },
    measurements: { shirtSize: "M", waistSize: "32", shoeSize: "eu 42" },
    family: {
        father: { name: "n/a", surname: "", passportNumber: "", birthDate: "" }, mother: { name: "kumari", surname: "de soysa", passportNumber: "N/A", birthDate: "1965-02-03" },
        spouse: { name: "", surname: "", passportNumber: "", birthDate: "" }, child1: "N/A", child2: "", child3: "", fatherAlive: "YES", motherAlive: "YES",
    },
    guardian: { name: "kamal perera", relationship: "uncle", nic: "901234567v", birthDate: "1960-01-01", phone: "+94 77 123 4567", address: "45 lake road" },
});
const submit = (token, key = "key-0000000000000001", extra = {}) => pub("/submit", { token, body: { answers: ANSWERS(), idempotencyKey: key, ...extra } });
const formOf = (token, body = {}) => pub("/form", { token, body });
const responses = (c) => prisma.candidateFormResponse.count({ where: { passportId: c.passportId } });

// Job A (A and C3) and Job B (B), each PROCESSING.
async function twoJobs() {
    const jobA = await newJob();
    const jobB = await newJob();
    await assign(jobA, A, C3);
    await assign(jobB, B);
    return { jobA, jobB };
}

describe("GROUP links: bound to ONE job (GROUP-LINK-001 to 010)", () => {
    test("GROUP-LINK-001 creating a group link binds it to the selected Job's UUID (and nothing else)", async () => {
        const { jobA } = await twoJobs();
        const created = await createGroup(jobA);
        const [row] = await prisma.candidateFormLink.findMany({ where: { revokedAt: null } });
        assert.equal(row.kind, "JOB_GROUP");
        assert.equal(row.jobId, jobA.jobId, "the authoritative relation is job.id");
        assert.equal(row.passportId, null);
        assert.equal(row.linkId, created.linkId);
        // FK to job(id): the link can never point at a job that does not exist.
        await assert.rejects(pg.exec(`UPDATE "candidate_form_link" SET "job_id" = '00000000-0000-4000-8000-00000000dead' WHERE "link_id" = '${row.linkId}'`), /foreign key/i);
    });

    test("GROUP-LINK-002 opening the link resolves the Job from the stored link, never from the request", async () => {
        const { jobA, jobB } = await twoJobs();
        const secret = secretOf((await createGroup(jobA)).url);
        // The verify body accepts only linkSecret, passportNumber and nic: a jobId is refused outright.
        for (const extra of [{ jobId: jobB.jobId }, { job: jobB.jobCode }, { kind: "JOB_GROUP" }]) {
            const r = await verify(secret, A, extra);
            assert.equal(r.status, 400, JSON.stringify(extra));
        }
        const token = await session(secret, A);
        const claims = readCandidateFormToken(token, { secret: SECRET });
        assert.deepEqual([claims.knd, claims.job, claims.sub], ["JOB_GROUP", jobA.jobId, A.passportId]);
    });

    test("GROUP-LINK-003 a candidate assigned to Job A can use Job A's link (Passport + NIC still required)", async () => {
        const { jobA } = await twoJobs();
        const secret = secretOf((await createGroup(jobA)).url);
        const token = await session(secret, A);
        const form = await formOf(token);
        assert.equal(form.status, 200);
        assert.equal(form.body.identity.passportNumber, A.passportId);
        // The link alone (no matching NIC) opens nothing.
        expectGeneric(await verify(secret, A, { nic: "800000009V" }), "wrong NIC");
    });

    test("GROUP-LINK-004 a candidate assigned to Job B cannot use Job A's link; nor can a candidate on no job", async () => {
        const { jobA, jobB } = await twoJobs();
        const secretA = secretOf((await createGroup(jobA)).url);
        expectGeneric(await verify(secretA, B), "Job B member on Job A link");
        expectGeneric(await verify(secretA, D), "candidate on no job");
        assert.equal((await prisma.candidateFormAccess.findUnique({ where: { passportId: B.passportId } }))?.status ?? "LOCKED", "LOCKED");
        // And the reverse: Job B's own link works for B only.
        const secretB = secretOf((await createGroup(jobB)).url);
        assert.equal((await verify(secretB, B)).status, 200);
        expectGeneric(await verify(secretB, A), "Job A member on Job B link");
    });

    test("GROUP-LINK-005 tampering with the job cannot bypass the binding: forged tokens and extra fields are refused", async () => {
        const { jobA, jobB } = await twoJobs();
        const secretA = secretOf((await createGroup(jobA)).url);
        await createGroup(jobB);
        const real = readCandidateFormToken(await session(secretA, A), { secret: SECRET });
        // A correctly-signed token naming Job B for Job A's link: the server re-checks the link's own job.
        const forged = issueCandidateFormToken({ secret: SECRET, passportId: A.passportId, linkId: real.lnk, version: real.ver, kind: "JOB_GROUP", jobId: jobB.jobId });
        assert.equal((await formOf(forged)).status, 401);
        // B (Job B) holding a token for Job A's link (as if stolen) is refused: B is not a member of Job A.
        const stolen = issueCandidateFormToken({ secret: SECRET, passportId: B.passportId, linkId: real.lnk, version: 1, kind: "JOB_GROUP", jobId: jobA.jobId });
        assert.equal((await formOf(stolen)).status, 401);
        // A token signed with another key is refused.
        const otherKey = issueCandidateFormToken({ secret: `${SECRET}-other`, passportId: A.passportId, linkId: real.lnk, version: real.ver, kind: "JOB_GROUP", jobId: jobA.jobId });
        assert.equal((await formOf(otherKey)).status, 401);
        // Submit bodies cannot carry a job or a candidate either.
        const token = await session(secretA, A);
        for (const extra of [{ jobId: jobB.jobId }, { passportId: B.passportId }]) assert.equal((await submit(token, "key-0000000000000002", extra)).status, 400);
        assert.equal(await responses(A) + await responses(B), 0);
    });

    test("GROUP-LINK-006 a released / removed job candidate cannot use the group link; an open session ends", async () => {
        const { jobA } = await twoJobs();
        const secret = secretOf((await createGroup(jobA)).url);
        const token = await session(secret, C3);
        assert.equal((await admin(USERS.MANAGER, "DELETE", `/jobs/${jobA.jobId}/candidates/${C3.passportId}`)).status, 200);
        const row = await prisma.jobCandidate.findFirst({ where: { jobId: jobA.jobId, passportId: C3.passportId } });
        assert.equal(row.isActive, false, "the history row stays, inactive");
        expectGeneric(await verify(secret, C3), "removed member");
        assert.equal((await formOf(token)).status, 401, "the open session stops on its next request");
    });

    test("GROUP-LINK-007 one candidate submitting does not invalidate the group link for the other members", async () => {
        const { jobA } = await twoJobs();
        const secret = secretOf((await createGroup(jobA)).url);
        const tokenA = await session(secret, A);
        assert.equal((await submit(tokenA)).status, 200);
        const link = await prisma.candidateFormLink.findFirst({ where: { jobId: jobA.jobId } });
        assert.equal(link.revokedAt, null, "the link itself is not marked used / submitted");
        const tokenC = await session(secret, C3);
        assert.equal((await submit(tokenC, "key-0000000000000003")).status, 200);
        assert.equal(await responses(A), 1);
        assert.equal(await responses(C3), 1);
        // A is done: the same link does not reopen A's form.
        assert.equal((await verify(secret, A)).status, 409);
    });

    test("GROUP-LINK-008 expired and revoked group links are rejected with the generic failure", async () => {
        const { jobA, jobB } = await twoJobs();
        const expired = secretOf((await createGroup(jobA)).url);
        await prisma.candidateFormLink.updateMany({ where: { jobId: jobA.jobId }, data: { expiresAt: new Date(Date.now() - 1000) } });
        expectGeneric(await verify(expired, A), "expired");
        const revoked = secretOf((await createGroup(jobB)).url);
        const token = await session(revoked, B);
        assert.equal((await admin(USERS.MANAGER, "POST", `/jobs/${jobB.jobId}/form-share/revoke`)).status, 200);
        expectGeneric(await verify(revoked, B), "revoked");
        assert.equal((await formOf(token)).status, 401, "revoking ends open sessions");
    });

    test("GROUP-LINK-009 an invalid token gets the same generic, safe response as a wrong NIC", async () => {
        const { jobA } = await twoJobs();
        const secret = secretOf((await createGroup(jobA)).url);
        const unknown = await verify(newLinkSecret(), A);
        const wrongNic = await verify(secret, A, { nic: "800000009V" });
        assert.equal(unknown.status, 401);
        assert.deepEqual(unknown.body, wrongNic.body, "same body: the caller cannot tell a real link from a fake one");
        assert.doesNotMatch(unknown.text, new RegExp(`${A.passportId}|${A.nic}|${jobA.jobId}|${jobA.jobCode}`));
    });

    test("GROUP-LINK-010 concurrent duplicate creation is deterministic: every request succeeds, exactly ONE link stays active", async () => {
        const { jobA } = await twoJobs();
        const results = await Promise.all([1, 2, 3].map(() => admin(USERS.MANAGER, "POST", `/jobs/${jobA.jobId}/form-share`)));
        assert.deepEqual(results.map((r) => r.status), [201, 201, 201], JSON.stringify(results.map((r) => r.body)));
        const active = await prisma.candidateFormLink.findMany({ where: { jobId: jobA.jobId, revokedAt: null } });
        assert.equal(active.length, 1, "one active group link per job");
        assert.equal(await prisma.candidateFormLink.count({ where: { jobId: jobA.jobId } }), 3, "the replaced ones are kept, revoked");
        const working = [];
        for (const r of results) if ((await verify(secretOf(r.body.url), A)).status === 200) working.push(r.body.linkId);
        assert.deepEqual(working, [active[0].linkId], "only the surviving link's secret works");
    });
});

describe("SINGLE links: bound to ONE candidate (SINGLE-LINK-001 to 010)", () => {
    test("SINGLE-LINK-001 a single link binds to the intended candidate's passport identity (FK), not to a job", async () => {
        const created = await createSingle(A);
        const row = await prisma.candidateFormLink.findUnique({ where: { linkId: created.linkId } });
        assert.deepEqual([row.kind, row.passportId, row.jobId], ["SINGLE", A.passportId, null]);
        await assert.rejects(pg.exec(`UPDATE "candidate_form_link" SET "passport_id" = 'NOPE0000' WHERE "link_id" = '${row.linkId}'`), /foreign key/i);
    });

    test("SINGLE-LINK-002 the raw Passport ID (and the NIC) never appear in the share URL; only the opaque secret, in the fragment", async () => {
        const { url } = await createSingle(A);
        assert.doesNotMatch(url, new RegExp(`${A.passportId}|${A.passportId.toLowerCase()}|${A.nic}|${A.uniqueId}`));
        const parsed = new URL(url);
        assert.equal(parsed.origin, ORIGIN);
        assert.equal(parsed.pathname, "/");
        assert.equal(parsed.search, "", "no query string: no ?passportId=, ?jobId=, ?nic=");
        assert.match(parsed.hash, /^#k=[A-Za-z0-9_-]{43}$/);
    });

    test("SINGLE-LINK-003 plain SHA256(passportId) is not the bearer credential and does not open the form", async () => {
        const { url } = await createSingle(A);
        const secret = secretOf(url);
        const row = await prisma.candidateFormLink.findFirst({ where: { passportId: A.passportId } });
        const sha = (v, enc) => crypto.createHash("sha256").update(v).digest(enc);
        for (const guess of [sha(A.passportId, "hex"), sha(A.passportId, "base64url"), sha(A.passportId.toLowerCase(), "base64url")]) {
            assert.notEqual(secret, guess);
            assert.notEqual(row.tokenHash, sha(A.passportId, "hex"));
            const r = await verify(guess, A);
            assert.ok([400, 401].includes(r.status), `a passport hash is not a link (${r.status})`);
        }
        // The stored value is the hash of the random secret only.
        assert.equal(row.tokenHash, hashLinkSecret(secret));
    });

    test("SINGLE-LINK-004 changing candidate / passport fields in requests cannot switch the target candidate", async () => {
        const secretA = secretOf((await createSingle(A)).url);
        await createSingle(B);
        // B's real Passport + NIC on A's link: generic failure.
        expectGeneric(await verify(secretA, B));
        // Mixing: A's passport with B's NIC, B's passport with A's NIC.
        expectGeneric(await verify(secretA, A, { nic: B.nic }));
        expectGeneric(await verify(secretA, A, { passportNumber: B.passportId }));
        const token = await session(secretA, A);
        // Unknown fields in the form request do not change who the session is for.
        const form = await formOf(token, { passportId: B.passportId });
        if (form.status === 200) assert.equal(form.body.identity.passportNumber, A.passportId);
        else assert.equal(form.status, 400);
        assert.equal((await submit(token, "key-0000000000000004", { passportId: B.passportId })).status, 400);
        assert.equal(await responses(B), 0);
    });

    test("SINGLE-LINK-005 correct Passport + NIC unlock the intended candidate (case, spaces and hyphens are canonicalised)", async () => {
        const { url } = await createSingle(A);
        const variant = ` ${A.passportId.slice(0, 4).toLowerCase()}-${A.passportId.slice(4)} `;
        assert.equal(canonicalPassport(variant), A.passportId);
        const token = await session(secretOf(url), A, { passportNumber: variant, nic: ` ${A.nic.toLowerCase()} ` });
        const claims = readCandidateFormToken(token, { secret: SECRET });
        assert.deepEqual([claims.sub, claims.knd, claims.job], [A.passportId, "SINGLE", null]);
        assert.equal((await prisma.candidateFormAccess.findUnique({ where: { passportId: A.passportId } })).status, "UNLOCKED");
    });

    test("SINGLE-LINK-006 a wrong NIC fails (and counts against the link)", async () => {
        const { url, linkId } = await createSingle(A);
        expectGeneric(await verify(secretOf(url), A, { nic: "800000009V" }));
        assert.equal((await prisma.candidateFormLink.findUnique({ where: { linkId } })).failedAttempts, 1);
    });

    test("SINGLE-LINK-007 the correct identity of ANOTHER candidate fails on this candidate's link", async () => {
        const { url } = await createSingle(A);
        expectGeneric(await verify(secretOf(url), C3));
        expectGeneric(await verify(secretOf(url), D));
    });

    test("SINGLE-LINK-008 expired and revoked single links fail; a replaced link stops working", async () => {
        const first = secretOf((await createSingle(A)).url);
        const second = secretOf((await createSingle(A)).url);
        expectGeneric(await verify(first, A), "replaced by a newer link");
        await prisma.candidateFormLink.updateMany({ where: { passportId: A.passportId, revokedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
        expectGeneric(await verify(second, A), "expired");
        const third = secretOf((await createSingle(A)).url);
        const token = await session(third, A);
        assert.equal((await admin(USERS.MANAGER, "POST", `/candidates/${A.passportId}/form-share/revoke`)).status, 200);
        expectGeneric(await verify(third, A), "revoked");
        assert.equal((await formOf(token)).status, 401);
    });

    test("SINGLE-LINK-009 an already-submitted candidate cannot submit twice, not even through a new link", async () => {
        const secret = secretOf((await createSingle(A)).url);
        const token = await session(secret, A);
        assert.equal((await submit(token)).status, 200);
        assert.equal((await submit(token, "key-0000000000000005")).status, 409, "a second submission is refused");
        assert.equal((await verify(secret, A)).status, 409, "the link says submitted, neutrally");
        const again = await admin(USERS.MANAGER, "POST", `/candidates/${A.passportId}/form-share`);
        if (again.status === 201) assert.equal((await verify(secretOf(again.body.url), A)).status, 409);
        assert.equal(await responses(A), 1);
    });

    test("SINGLE-LINK-010 concurrent verification and submission never create two responses", async () => {
        const secret = secretOf((await createSingle(A)).url);
        const verified = await Promise.all([verify(secret, A), verify(secret, A), verify(secret, A)]);
        assert.deepEqual(verified.map((r) => r.status), [200, 200, 200]);
        const submitted = await Promise.all(verified.map((r, i) => submit(r.body.token, `key-00000000000001${i}0`)));
        const statuses = submitted.map((r) => r.status).sort();
        assert.equal(statuses.filter((s) => s === 200).length, 1, JSON.stringify(statuses));
        assert.ok(statuses.filter((s) => s !== 200).every((s) => s === 409), JSON.stringify(statuses));
        assert.equal(await responses(A), 1);
        assert.equal((await prisma.candidateFormAccess.findUnique({ where: { passportId: A.passportId } })).status, "SUBMITTED");
    });
});

describe("SECURITY (SECURITY-001 to 010)", () => {
    test("SECURITY-001 no raw token is stored anywhere: only its SHA-256, and nothing in the audit log", async () => {
        const { jobA } = await twoJobs();
        const secrets = [secretOf((await createSingle(A)).url), secretOf((await createGroup(jobA)).url)];
        const dump = JSON.stringify([
            await prisma.candidateFormLink.findMany(), await prisma.candidateFormAccess.findMany(), (await pg.query(`SELECT * FROM "audit_logs"`)).rows,
        ]);
        for (const secret of secrets) {
            assert.ok(!dump.includes(secret), "raw secret stored");
            assert.ok(dump.includes(hashLinkSecret(secret)), "the hash is the stored key");
        }
    });

    test("SECURITY-002 no raw token, session token, passport or NIC appears in the logs", async () => {
        const { jobA } = await twoJobs();
        const single = secretOf((await createSingle(A)).url);
        const group = secretOf((await createGroup(jobA)).url);
        await verify(single, A, { nic: "800000009V" });
        await verify(group, B);
        await verify(newLinkSecret(), A);
        const token = await session(single, A);
        await formOf(`${token}x`);
        assert.ok(logs.length > 0, "failures are logged (as a keyed reference)");
        const text = JSON.stringify(logs);
        for (const secretValue of [single, group, token, A.passportId, B.passportId, A.nic, B.nic, SECRET]) assert.ok(!text.includes(secretValue), `leaked: ${secretValue.slice(0, 6)}…`);
    });

    test("SECURITY-003 security error responses never echo the passport or NIC", async () => {
        const secret = secretOf((await createSingle(A)).url);
        const replies = [
            await verify(secret, A, { nic: "800000009V" }),
            await verify(secret, A, { passportNumber: "N80000099" }),
            await verify(secret, A, { nic: "bad-nic-value" }),
            await verify(secret, A, { passportNumber: "N8000001<script>" }),
        ];
        for (const r of replies) {
            assert.ok([400, 401].includes(r.status));
            assert.doesNotMatch(r.text, /N8000001|N80000099|800000009V|800000001V|bad-nic|script/i);
        }
    });

    test("SECURITY-004 the public API cannot create (or list) links", async () => {
        const { jobA } = await twoJobs();
        for (const path of ["/form-share", "/links", `/jobs/${jobA.jobId}/form-share`, `/candidates/${A.passportId}/form-share`]) {
            const r = await pub(path, { body: { passportId: A.passportId, jobId: jobA.jobId } });
            assert.equal(r.status, 404, path);
        }
        assert.equal(await prisma.candidateFormLink.count(), 0);
    });

    test("SECURITY-005 roles: only ADMIN and MANAGER create / revoke / read group links; an Analyst cannot share an unallocated candidate", async () => {
        const { jobA } = await twoJobs();
        for (const who of [USERS.ANN, USERS.DESK]) {
            assert.equal((await admin(who, "POST", `/jobs/${jobA.jobId}/form-share`)).status, 403);
            assert.equal((await admin(who, "GET", `/jobs/${jobA.jobId}/form-share`)).status, 403);
            assert.equal((await admin(who, "POST", `/jobs/${jobA.jobId}/form-share/revoke`)).status, 403);
        }
        // Personal links follow the existing Candidates-area RBAC: an Analyst only within their allocation.
        assert.equal((await admin(USERS.ANN, "POST", `/candidates/${A.passportId}/form-share`)).status, 404);
        assert.equal(await prisma.candidateFormLink.count(), 0);
        assert.equal((await admin(USERS.ADMIN, "POST", `/jobs/${jobA.jobId}/form-share`)).status, 201);
    });

    test("SECURITY-006 link secrets come from a CSPRNG: 256 bits, unique, no Math.random / time / IDs in the generators", async () => {
        const seen = new Set();
        for (let i = 0; i < 500; i += 1) {
            const s = newLinkSecret();
            assert.match(s, /^[A-Za-z0-9_-]{43}$/);
            assert.equal(Buffer.from(s, "base64url").length, FORM_LINK_SECRET_BYTES);
            seen.add(s);
        }
        assert.equal(seen.size, 500);
        assert.equal(FORM_LINK_SECRET_BYTES, 32);
        for (const file of ["src/services/candidateFormShareService.js", "src/services/candidateFormJobGroupService.js", "src/services/candidateFormTokenService.js"]) {
            assert.doesNotMatch(fs.readFileSync(file, "utf8"), /Math\.random|Date\.now\(\)\s*\.toString/, file);
        }
        assert.match(fs.readFileSync("src/services/candidateFormShareService.js", "utf8"), /crypto\.randomBytes\(FORM_LINK_SECRET_BYTES\)/);
    });

    test("SECURITY-007 malformed link secrets and session tokens are refused without a server error", async () => {
        await createSingle(A);
        for (const linkSecret of ["", "short", "!".repeat(43), `${"a".repeat(42)}=`, 12345, null, ["a"], { $ne: null }]) {
            const r = await pub("/verify", { body: { linkSecret, passportNumber: A.passportId, nic: A.nic } });
            assert.ok([400, 401].includes(r.status), `${JSON.stringify(linkSecret)} -> ${r.status}`);
        }
        for (const token of ["cf1~x~y", "cf1~~", "not-a-token", "cf1~" + "A".repeat(16) + "~" + "B".repeat(40), "Bearer"]) {
            assert.equal((await formOf(token)).status, 401, token);
        }
        const broken = await pub("/verify", { raw: "{not json" });
        assert.equal(broken.status, 400);
        assert.ok(!logs.some((entry) => entry[0] === "Candidate form request failed"), "no 500 path was hit");
    });

    test("SECURITY-008 very long tokens and inputs are rejected safely", async () => {
        const secret = secretOf((await createSingle(A)).url);
        const long = "A".repeat(10_000);
        for (const body of [{ linkSecret: long, passportNumber: A.passportId, nic: A.nic }, { linkSecret: secret, passportNumber: long, nic: A.nic }, { linkSecret: secret, passportNumber: A.passportId, nic: long }]) {
            assert.equal((await pub("/verify", { body })).status, 400);
        }
        assert.equal((await pub("/verify", { body: { linkSecret: secret, passportNumber: A.passportId, nic: A.nic, pad: "x".repeat(20_000) } })).status, 413);
        // A 20 KB bearer header: Node itself answers 431 before the app; a shorter one gets the app's 401.
        assert.ok([401, 431].includes((await formOf("cf1~" + "A".repeat(20_000) + "~B")).status));
        assert.equal((await formOf("cf1~" + "A".repeat(4_000) + "~B")).status, 401);
        assert.equal((await prisma.candidateFormLink.findFirst({ where: { passportId: A.passportId } })).failedAttempts, 0, "rejected before any lookup");
    });

    test("SECURITY-009 SQL-injection-style identity input is treated as data (refused by the input rules), and nothing changes", async () => {
        const { jobA } = await twoJobs();
        const group = secretOf((await createGroup(jobA)).url);
        const before = await prisma.candidate.count();
        for (const passportNumber of ["' OR '1'='1", "N8000001'; DROP TABLE candidate; --", "%", "N800000_", "N800%"]) {
            const r = await verify(group, A, { passportNumber });
            assert.ok([400, 401].includes(r.status), passportNumber);
        }
        for (const nic of ["1' OR '1'='1", "800000001V' --"]) assert.equal((await verify(group, A, { nic })).status, 400);
        assert.equal(await prisma.candidate.count(), before);
        assert.equal((await prisma.candidateFormAccess.findUnique({ where: { passportId: A.passportId } })).status, "UNLOCKED", "unchanged by the attempts");
        assert.equal((await verify(group, A)).status, 200, "the real member still verifies");
    });

    test("SECURITY-010 repeated failed verification hits the existing per-IP and per-passport rate limits", async () => {
        const secret = secretOf((await createSingle(A)).url);
        const limited = app(USERS.ADMIN, { limiters: false });
        const statuses = [];
        for (let i = 0; i < 7; i += 1) statuses.push((await verify(secret, A, { nic: "800000009V" }, limited)).status);
        assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
        assert.ok(statuses.slice(5).every((s) => s === 429), JSON.stringify(statuses));
        // Even the right NIC is refused while the passport is limited (the limiter runs before any lookup).
        assert.equal((await verify(secret, A, {}, limited)).status, 429);
        assert.ok((await prisma.rateLimit.count()) > 0, "the counters live in the database (shared by every instance)");
    });
});
