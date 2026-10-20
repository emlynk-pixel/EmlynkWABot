// Client Job ID (job.company_job_id, JOB-ID-*) and Candidate Form JOB_GROUP share links (GROUP-*).
// On a REAL PostgreSQL (PGlite, every migration applied) through the real Prisma
// client, the real admin router and the real public router. No Supabase.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createPublicCandidateDetailsRouter, PUBLIC_CANDIDATE_DETAILS_PATH } from "../src/routes/publicCandidateDetails.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { hashLinkSecret } from "../src/services/candidateFormShareService.js";
import { issueCandidateFormToken, readCandidateFormToken } from "../src/services/candidateFormTokenService.js";

const SECRET = "test-candidate-form-secret-0123456789-abcdefghijklmnop";
const ORIGIN = "https://candidate-form.example.test";
const user = (adminId, role, n) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const USERS = { ADMIN: user("u-admin", "ADMIN", 1), MANAGER: user("u-manager", "MANAGER", 2), DESK: user("u-desk", "REGISTRATION_DESK", 3), ANN: user("u-ann", "ANALYST", 4) };
// Four candidates (all with a NIC) and one stranger.
const C = (i) => ({ passportId: `N900000${i}`, uniqueId: `900${i}`, firstName: `First${i}`, otherName: `Last${i}`, nic: `90000000${i}V`, sex: "M", whatsappNumber: `+9477000000${i}` });
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
        DELETE FROM "job_candidate"; DELETE FROM "job"; DELETE FROM "job_code_counter"; DELETE FROM "job_type"; DELETE FROM "client"; DELETE FROM "agent";
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
    const client = await prisma.client.create({ data: { name: "Acme Construction", agentId: agent.id } });
    ids = { jobType: jobType.id, client: client.id, agent: agent.id };
});

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

const newJob = async (extra = {}) => {
    const r = await admin(USERS.MANAGER, "POST", "/jobs", { body: { jobTypeId: ids.jobType, clientId: ids.client, responsibleAgentId: ids.agent, ...extra } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
};
const assign = async (job, ...candidates) => {
    for (const c of candidates) assert.equal((await admin(USERS.MANAGER, "POST", `/jobs/${job.jobId}/candidates`, { body: { passportId: c.passportId } })).status, 201);
};
const groupLink = async (job, who = USERS.MANAGER) => {
    const r = await admin(who, "POST", `/jobs/${job.jobId}/form-share`);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.url.split("#k=")[1];
};
const singleLink = async (c) => (await admin(USERS.MANAGER, "POST", `/candidates/${c.passportId}/form-share`)).body.url.split("#k=")[1];
const verify = (secret, c, overrides = {}) => pub("/verify", { body: { linkSecret: secret, passportNumber: c.passportId, nic: c.nic, ...overrides } });
const GENERIC = { code: "VERIFICATION_FAILED" };
const expectGeneric = (r, label) => {
    assert.equal(r.status, 401, label);
    assert.equal(r.body.code, GENERIC.code, label);
};
const ANSWERS = () => ({
    basic: { fullName: "anusha de soysa", surname: "de soysa", otherNames: "anusha", sex: "FEMALE", civilStatus: "SINGLE", birthDate: "1990-05-01", birthPlace: "negombo" },
    contact: { address: "12 galle road", city: "negombo", district: "gampaha", dsDivision: "negombo", gnDivision: "kurana", alternativePhone: "0771234567", email: "a@example.com" },
    passport: { issueDate: "2020-01-15", expiryDate: "2030-01-14" },
    qualifications: { jobCategory: "WELDER TIG", jobCategoryOther: "", experience: "5 years", otherSkills1: "n/a", otherSkills2: "N/A", englishKnowledge: "GOOD" },
    measurements: { shirtSize: "M", waistSize: "32", shoeSize: "eu 42" },
    family: {
        father: { name: "n/a", surname: "", passportNumber: "", birthDate: "" }, mother: { name: "kumari", surname: "de soysa", passportNumber: "N/A", birthDate: "1965-02-03" },
        spouse: { name: "", surname: "", passportNumber: "", birthDate: "" }, child1: "N/A", child2: "", child3: "",
    },
    guardian: { name: "kamal perera", relationship: "uncle", nic: "901234567v", birthDate: "1960-01-01", phone: "+94 77 123 4567", address: "45 lake road" },
});
const submit = (token, key = "key-0000000000000001") => pub("/submit", { token, body: { answers: ANSWERS(), idempotencyKey: key } });
const formOf = (token) => pub("/form", { token, body: {} });
const access = (c) => prisma.candidateFormAccess.findUnique({ where: { passportId: c.passportId } });
async function groupSession(secret, c) {
    const r = await verify(secret, c);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.token;
}

describe("Client Job ID (JOB-ID-001 to JOB-ID-007)", () => {
    test("JOB-ID-001: a job can be created without one (null), and with one (normalised)", async () => {
        const bare = await newJob();
        assert.equal(bare.companyJobId, null);
        const named = await newJob({ companyJobId: "  y26s01 " });
        assert.equal(named.companyJobId, "Y26S01");
        assert.match(named.jobCode, /^JOB-\d{4}-\d{6}$/, "the internal code is unaffected");
    });

    test("JOB-ID-002 / 003: added later and changed by Admin or Manager; null clears it; any job status", async () => {
        const job = await newJob();
        const added = await admin(USERS.MANAGER, "PUT", `/jobs/${job.jobId}`, { body: { companyJobId: "il-2026-44" } });
        assert.deepEqual([added.status, added.body.companyJobId], [200, "IL-2026-44"]);
        const changed = await admin(USERS.ADMIN, "PUT", `/jobs/${job.jobId}`, { body: { companyJobId: "Y26S01" } });
        assert.equal(changed.body.companyJobId, "Y26S01");
        const audit = (await prisma.auditLog.findMany({ where: { action: "UPDATE_JOB" }, orderBy: { createdDate: "asc" } })).at(-1);
        assert.deepEqual([JSON.parse(audit.previousValue).companyJobId, JSON.parse(audit.newValue).companyJobId], ["IL-2026-44", "Y26S01"]);
        assert.equal((await admin(USERS.MANAGER, "PUT", `/jobs/${job.jobId}`, { body: { companyJobId: null } })).body.companyJobId, null);
        // A finished job can still get its employer's ID; other fields cannot change.
        await admin(USERS.MANAGER, "POST", `/jobs/${job.jobId}/complete`, { body: {} });
        assert.equal((await admin(USERS.MANAGER, "PUT", `/jobs/${job.jobId}`, { body: { companyJobId: "Z1" } })).body.companyJobId, "Z1");
        assert.equal((await admin(USERS.MANAGER, "PUT", `/jobs/${job.jobId}`, { body: { vacancies: 3 } })).status, 409);
    });

    test("validation: control characters, symbols, too long and non-strings are refused; unique per client only", async () => {
        const job = await newJob();
        for (const bad of ["ab\ncd", "a\u0000b", "<script>", "Y26;DROP", "x".repeat(41), 12, "සිංහල", "ID€"]) {
            assert.equal((await admin(USERS.MANAGER, "PUT", `/jobs/${job.jobId}`, { body: { companyJobId: bad } })).status, 400, JSON.stringify(bad));
        }
        await pg.exec(`UPDATE "job" SET "company_job_id" = NULL`);
        await assert.rejects(pg.exec(`UPDATE "job" SET "company_job_id" = 'bad value!' WHERE "id" = '${job.jobId}'`), /check/i, "the database refuses it too");
        await admin(USERS.MANAGER, "PUT", `/jobs/${job.jobId}`, { body: { companyJobId: "Y26S01" } });
        const second = await newJob();
        const clash = await admin(USERS.MANAGER, "PUT", `/jobs/${second.jobId}`, { body: { companyJobId: "y26s01" } });
        assert.deepEqual([clash.status, clash.body.code], [409, "COMPANY_JOB_ID_EXISTS"]);
        assert.equal((await admin(USERS.MANAGER, "POST", "/jobs", { body: { jobTypeId: ids.jobType, clientId: ids.client, responsibleAgentId: ids.agent, companyJobId: "Y26S01" } })).status, 409);
        // Another client may use the same identifier.
        const other = await prisma.client.create({ data: { name: "Other Co", agentId: ids.agent } });
        const r = await admin(USERS.MANAGER, "POST", "/jobs", { body: { jobTypeId: ids.jobType, clientId: other.id, responsibleAgentId: ids.agent, companyJobId: "Y26S01" } });
        assert.equal(r.status, 201);
        // Several jobs without one are fine.
        assert.equal((await prisma.job.count({ where: { companyJobId: null } })), 1);
    });

    test("JOB-ID-007: only ADMIN and MANAGER may change it", async () => {
        const job = await newJob({ companyJobId: "Y26S01" });
        for (const who of [USERS.ANN, USERS.DESK]) {
            assert.equal((await admin(who, "PUT", `/jobs/${job.jobId}`, { body: { companyJobId: "HACK" } })).status, 403, who.role);
        }
        assert.equal((await prisma.job.findUnique({ where: { id: job.jobId } })).companyJobId, "Y26S01");
    });

    test("JOB-ID-004 / 005 / 006: changing it never changes the job id, the assignments or the group link; the same link still verifies", async () => {
        const job = await newJob({ companyJobId: "OLD-1" });
        await assign(job, A, B);
        const secret = await groupLink(job);
        const link = await prisma.candidateFormLink.findFirst({ where: { jobId: job.jobId } });
        const members = JSON.stringify(await prisma.jobCandidate.findMany({ orderBy: { passportId: "asc" } }));
        const accessBefore = JSON.stringify(await prisma.candidateFormAccess.findMany({ orderBy: { passportId: "asc" } }));

        const changed = await admin(USERS.MANAGER, "PUT", `/jobs/${job.jobId}`, { body: { companyJobId: "NEW-2" } });
        assert.equal(changed.status, 200);
        const after = await prisma.job.findUnique({ where: { id: job.jobId } });
        assert.deepEqual([after.id, after.jobCode, after.companyJobId], [job.jobId, job.jobCode, "NEW-2"]);
        assert.equal(JSON.stringify(await prisma.jobCandidate.findMany({ orderBy: { passportId: "asc" } })), members, "job_candidate untouched");
        assert.equal(JSON.stringify(await prisma.candidateFormAccess.findMany({ orderBy: { passportId: "asc" } })), accessBefore, "candidate_form_access untouched");
        const linkAfter = await prisma.candidateFormLink.findFirst({ where: { jobId: job.jobId } });
        assert.deepEqual([linkAfter.linkId, linkAfter.jobId, linkAfter.revokedAt, linkAfter.tokenHash], [link.linkId, job.jobId, null, link.tokenHash], "candidate_form_link untouched");
        // The very same link still works, for a new member too, and the answers land on the same job.
        assert.equal((await verify(secret, A)).status, 200);
        const token = await groupSession(secret, B);
        assert.equal((await submit(token)).status, 200);
        assert.equal(await prisma.candidateFormResponse.count(), 1, "candidate_form_response written, nothing rewritten");
        assert.equal((await prisma.candidateFormLink.findFirst({ where: { jobId: job.jobId } })).jobId, job.jobId);
    });
});

describe("creating group links (GROUP-001 to GROUP-003, 023)", () => {
    test("GROUP-001: ADMIN and MANAGER create one for a PROCESSING job; the URL is a fragment link shown once; only a hash is stored; audited", async () => {
        const job = await newJob({ companyJobId: "Y26S01" });
        await assign(job, A, B);
        const r = await admin(USERS.ADMIN, "POST", `/jobs/${job.jobId}/form-share`);
        assert.equal(r.status, 201);
        const secret = r.body.url.split("#k=")[1];
        assert.match(r.body.url, new RegExp(`^${ORIGIN}/#k=[A-Za-z0-9_-]{43}$`));
        assert.deepEqual(r.body.status.counts, { candidates: 2, submitted: 0, remaining: 2 });
        assert.deepEqual([r.body.status.state, r.body.status.jobCode, r.body.status.companyJobId, r.body.status.client, r.body.status.jobType], ["OPEN", job.jobCode, "Y26S01", "Acme Construction", "Welder"]);
        assert.ok(Date.parse(r.body.expiresAt) - Date.now() > 3 * 24 * 60 * 60 * 1000 - 60_000, "3 days");
        const link = await prisma.candidateFormLink.findFirst({ where: { jobId: job.jobId } });
        assert.deepEqual([link.kind, link.jobId, link.passportId, link.tokenHash], ["JOB_GROUP", job.jobId, null, hashLinkSecret(secret)]);
        const dump = JSON.stringify(await pg.query(`SELECT * FROM candidate_form_link, candidate_form_access, audit_logs`));
        assert.ok(!dump.includes(secret), "the secret is not stored anywhere");
        assert.ok(!JSON.stringify((await admin(USERS.ADMIN, "GET", `/jobs/${job.jobId}/form-share`)).body).includes(secret), "not readable again");
        const audit = await prisma.auditLog.findMany({ where: { action: "CREATE_JOB_FORM_LINK" } });
        assert.equal(audit.length, 1);
        assert.equal(await prisma.candidateFormAccess.count({ where: { status: "UNLOCKED" } }), 2, "each member got their own unlocked form");
        assert.equal((await admin(USERS.MANAGER, "POST", `/jobs/${(await newJob()).jobId}/form-share`)).status, 201);
        for (const who of [USERS.ANN, USERS.DESK]) {
            assert.equal((await admin(who, "POST", `/jobs/${job.jobId}/form-share`)).status, 403, who.role);
            assert.equal((await admin(who, "GET", `/jobs/${job.jobId}/form-share`)).status, 403, who.role);
            assert.equal((await admin(who, "POST", `/jobs/${job.jobId}/form-share/revoke`)).status, 403, who.role);
        }
        assert.equal((await admin(USERS.MANAGER, "POST", "/jobs/not-a-uuid/form-share")).status, 404);
    });

    test("GROUP-002 / 003: not for a COMPLETED or CANCELLED job", async () => {
        const done = await newJob();
        const cancelled = await newJob();
        await admin(USERS.MANAGER, "POST", `/jobs/${done.jobId}/complete`, { body: {} });
        await admin(USERS.MANAGER, "POST", `/jobs/${cancelled.jobId}/cancel`, { body: { reason: "No demand" } });
        for (const job of [done, cancelled]) {
            const r = await admin(USERS.MANAGER, "POST", `/jobs/${job.jobId}/form-share`);
            assert.deepEqual([r.status, r.body.code], [409, "JOB_NOT_PROCESSING"]);
        }
        assert.equal(await prisma.candidateFormLink.count(), 0);
    });

    test("GROUP-023: one active group link per job; a new one revokes the previous; submitted candidates stay submitted", async () => {
        const job = await newJob();
        await assign(job, A, B);
        const first = await groupLink(job);
        const token = await groupSession(first, A);
        assert.equal((await submit(token)).status, 200);
        const second = await groupLink(job);
        assert.equal(await prisma.candidateFormLink.count({ where: { jobId: job.jobId, revokedAt: null } }), 1);
        expectGeneric(await verify(first, B), "old link");
        assert.equal((await verify(second, B)).status, 200, "an unsubmitted member uses the new link");
        assert.equal((await verify(second, A)).status, 409, "the submitted one stays submitted");
        assert.equal((await access(A)).status, "SUBMITTED");
        // The database also refuses a second active group link.
        await assert.rejects(pg.exec(`INSERT INTO "candidate_form_link" ("link_id","kind","job_id","token_hash","created_by","expires_at") VALUES ('x-1','JOB_GROUP','${job.jobId}','${"a".repeat(64)}','u-admin', now() + interval '1 day')`), /unique|one_active/i);
        // Scope CHECKs: a group link needs a job and no candidate; a single link the opposite.
        await assert.rejects(pg.exec(`INSERT INTO "candidate_form_link" ("link_id","kind","token_hash","created_by","expires_at") VALUES ('x-2','JOB_GROUP','${"b".repeat(64)}','u-admin', now())`), /check/i);
        await assert.rejects(pg.exec(`INSERT INTO "candidate_form_link" ("link_id","kind","passport_id","job_id","token_hash","created_by","expires_at") VALUES ('x-3','SINGLE','${A.passportId}','${job.jobId}','${"c".repeat(64)}','u-admin', now())`), /check/i);
        await assert.rejects(pg.exec(`INSERT INTO "candidate_form_link" ("link_id","kind","passport_id","job_id","token_hash","created_by","expires_at") VALUES ('x-4','JOB_GROUP','${A.passportId}','${job.jobId}','${"d".repeat(64)}','u-admin', now())`), /check/i);
    });
});

describe("verification through a group link (GROUP-004 to GROUP-012, 021, 022)", () => {
    test("GROUP-004: a candidate assigned to the exact job verifies; the token is bound to the link, its kind, the job and the version", async () => {
        const job = await newJob();
        await assign(job, A);
        const secret = await groupLink(job);
        const r = await verify(secret, A, { passportNumber: ` ${A.passportId.toLowerCase()} `, nic: A.nic.toLowerCase() });
        assert.equal(r.status, 200);
        const payload = readCandidateFormToken(r.body.token, { secret: SECRET });
        const link = await prisma.candidateFormLink.findFirst({ where: { jobId: job.jobId } });
        assert.deepEqual([payload.sub, payload.lnk, payload.knd, payload.job, payload.ver], [A.passportId, link.linkId, "JOB_GROUP", job.jobId, (await access(A)).version]);
        const form = await formOf(r.body.token);
        assert.equal(form.status, 200);
        assert.equal(form.body.identity.passportNumber, A.passportId);
        const text = JSON.stringify(form.body);
        for (const leak of [job.jobId, job.jobCode, "Acme", B.passportId, B.nic, "Y26S01"]) assert.ok(!text.includes(leak), `form response must not contain ${leak}`);
    });

    test("GROUP-005 / 006 / 007 / 008: outsiders, another job's candidate, wrong passport and wrong NIC all get the same generic failure", async () => {
        const job = await newJob();
        const other = await newJob();
        await assign(job, A);
        await assign(other, B);
        const secret = await groupLink(job);
        const wrongNic = await verify(secret, A, { nic: B.nic });
        const wrongPassport = await verify(secret, A, { passportNumber: "N9999999" });
        const outsider = await verify(secret, D);
        const otherJob = await verify(secret, B);
        const unknownLink = await verify("A".repeat(43), A);
        for (const [label, r] of Object.entries({ wrongNic, wrongPassport, outsider, otherJob, unknownLink })) expectGeneric(r, label);
        const bodies = new Set([wrongNic, wrongPassport, outsider, otherJob, unknownLink].map((r) => JSON.stringify(r.body)));
        assert.equal(bodies.size, 1, "byte-identical responses: no disclosure of membership");
        assert.equal(await prisma.candidateFormAccess.count({ where: { status: "UNLOCKED", passportId: { in: [D.passportId, B.passportId] } } }), 0);
    });

    test("GROUP-009 / 010: expired and revoked group links fail", async () => {
        const job = await newJob();
        await assign(job, A);
        const secret = await groupLink(job);
        await pg.exec(`UPDATE "candidate_form_link" SET "expires_at" = now() - interval '1 minute'`);
        expectGeneric(await verify(secret, A), "expired");
        await pg.exec(`UPDATE "candidate_form_link" SET "expires_at" = now() + interval '1 day'`);
        assert.equal((await verify(secret, A)).status, 200);
        assert.equal((await admin(USERS.MANAGER, "POST", `/jobs/${job.jobId}/form-share/revoke`)).status, 200);
        expectGeneric(await verify(secret, A), "revoked");
    });

    test("GROUP-011: a candidate added after the link was created can verify and submit; GROUP-012: one removed can no longer use it", async () => {
        const job = await newJob();
        await assign(job, A);
        const secret = await groupLink(job);
        expectGeneric(await verify(secret, B), "not yet a member");
        await assign(job, B);
        assert.equal((await access(B))?.status ?? "LOCKED", "LOCKED", "the link did not snapshot membership");
        const token = await groupSession(secret, B);
        assert.equal((await access(B)).status, "UNLOCKED", "unlocked for B alone on first verification");
        assert.equal((await submit(token)).status, 200);

        const tokenA = await groupSession(secret, A);
        assert.equal((await formOf(tokenA)).status, 200);
        assert.equal((await admin(USERS.MANAGER, "DELETE", `/jobs/${job.jobId}/candidates/${A.passportId}`)).status, 200);
        expectGeneric(await verify(secret, A), "removed member");
        const stale = await formOf(tokenA);
        assert.deepEqual([stale.status, stale.body.code], [401, "VERIFICATION_REQUIRED"], "the existing session stops too");
        assert.equal((await submit(tokenA)).status, 401);
        assert.equal(await prisma.candidateFormResponse.count({ where: { passportId: A.passportId } }), 0);
    });

    test("GROUP-021: the job and the candidate come only from the link and the token; request bodies cannot select or override them", async () => {
        const job = await newJob();
        const other = await newJob();
        await assign(job, A);
        await assign(other, B);
        const secret = await groupLink(job);
        for (const extra of [{ jobId: other.jobId }, { job: other.jobId }, { jobCode: other.jobCode }, { companyJobId: "X" }, { kind: "SINGLE" }, { passportId: B.passportId }]) {
            const r = await verify(secret, A, extra);
            assert.equal(r.status, 400, JSON.stringify(extra));
        }
        const token = await groupSession(secret, A);
        // The protected routes ignore anything but the token: B's id in the body changes nothing.
        const form = await pub("/form", { token, body: { passportId: B.passportId, jobId: other.jobId } });
        assert.equal(form.status, 200);
        assert.equal(form.body.identity.passportNumber, A.passportId);
        // A token for a group link is not accepted if its job claim disagrees with the stored link.
        const link = await prisma.candidateFormLink.findFirst({ where: { jobId: job.jobId } });
        const forged = issueCandidateFormToken({ secret: SECRET, passportId: A.passportId, linkId: link.linkId, version: (await access(A)).version, kind: "JOB_GROUP", jobId: other.jobId }).token;
        assert.equal((await formOf(forged)).status, 401, "token job must equal the link job");
        const asSingle = issueCandidateFormToken({ secret: SECRET, passportId: A.passportId, linkId: link.linkId, version: (await access(A)).version }).token;
        assert.equal((await formOf(asSingle)).status, 401, "token kind must equal the link kind");
        // B is not on `job`: a token for B through the job's link fails.
        const forgedB = issueCandidateFormToken({ secret: SECRET, passportId: B.passportId, linkId: link.linkId, version: 0, kind: "JOB_GROUP", jobId: job.jobId }).token;
        assert.equal((await formOf(forgedB)).status, 401);
    });

    test("GROUP-022: nothing in the public API lists a job's candidates; the group link's secret alone proves nothing", async () => {
        const job = await newJob();
        await assign(job, A, B);
        const secret = await groupLink(job);
        for (const path of ["/members", "/job", "/candidates", `/${job.jobId}`]) assert.equal((await pub(path, { body: { linkSecret: secret } })).status, 404, path);
        const asked = await pub("/verify", { body: { linkSecret: secret } });
        assert.equal(asked.status, 400);
        assert.ok(!JSON.stringify(asked.body).includes(A.passportId));
        assert.equal((await call(app(USERS.ADMIN), "GET", `${PUBLIC_CANDIDATE_DETAILS_PATH}/verify`)).status, 404);
        assert.ok(!logs.flat().join(" ").includes(secret), "no secret in logs");
        void (await groupSession(secret, A));
    });
});

describe("per-candidate locks and the SINGLE / GROUP interaction (GROUP-013 to GROUP-016)", () => {
    test("GROUP-013 / 014: A's submission does not affect B; A cannot reopen through the same link", async () => {
        const job = await newJob();
        await assign(job, A, B, C3);
        const secret = await groupLink(job);
        const tokenA = await groupSession(secret, A);
        const tokenB = await groupSession(secret, B);
        assert.equal((await submit(tokenA, "key-aaaaaaaaaaaaaaaa")).status, 200);
        assert.deepEqual([(await access(A)).status, (await access(B)).status, (await access(C3)).status], ["SUBMITTED", "UNLOCKED", "UNLOCKED"]);
        assert.equal((await formOf(tokenB)).status, 200, "B's session is untouched");
        assert.equal((await submit(tokenB, "key-bbbbbbbbbbbbbbbb")).status, 200);
        const again = await verify(secret, A);
        assert.deepEqual([again.status, again.body.code], [409, "ALREADY_SUBMITTED"]);
        assert.equal((await submit(tokenA, "key-other-0000000001")).status, 409);
        assert.equal((await formOf(tokenA)).status, 409);
        assert.equal((await access(C3)).status, "UNLOCKED");
        assert.equal((await admin(USERS.MANAGER, "GET", `/jobs/${job.jobId}/form-share`)).body.counts.submitted, 2);
        // Regenerating never reopens anyone.
        await groupLink(job);
        assert.deepEqual([(await access(A)).status, (await access(B)).status], ["SUBMITTED", "SUBMITTED"]);
        assert.equal(await prisma.candidateFormResponse.count(), 2);
    });

    test("GROUP-015: submitted through a SINGLE link, the candidate cannot reopen through a group link", async () => {
        const job = await newJob();
        await assign(job, A);
        const single = await singleLink(A);
        const token = (await verify(single, A)).body.token;
        assert.equal((await submit(token)).status, 200);
        const secret = await groupLink(job);
        const r = await verify(secret, A);
        assert.deepEqual([r.status, r.body.code], [409, "ALREADY_SUBMITTED"]);
        assert.equal((await access(A)).status, "SUBMITTED");
        assert.equal((await admin(USERS.MANAGER, "GET", `/jobs/${job.jobId}/form-share`)).body.counts.submitted, 1);
    });

    test("GROUP-016: submitted through a GROUP link, the candidate cannot reopen through a SINGLE link", async () => {
        const job = await newJob();
        await assign(job, A);
        const secret = await groupLink(job);
        assert.equal((await submit(await groupSession(secret, A))).status, 200);
        const r = await admin(USERS.MANAGER, "POST", `/candidates/${A.passportId}/form-share`);
        assert.deepEqual([r.status, r.body.code], [409, "FORM_SUBMITTED"]);
        assert.equal((await access(A)).status, "SUBMITTED");
    });

    test("a member already unlocked by a personal link keeps that session when the group link is created", async () => {
        const job = await newJob();
        await assign(job, A, B);
        const single = await singleLink(A);
        const token = (await verify(single, A)).body.token;
        const version = (await access(A)).version;
        await groupLink(job);
        assert.equal((await access(A)).version, version, "not bumped");
        assert.equal((await formOf(token)).status, 200);
    });
});

describe("job completion, cancellation and revoking (GROUP-017 to GROUP-020)", () => {
    for (const [label, close] of [
        ["GROUP-017/019: completing", (job) => admin(USERS.MANAGER, "POST", `/jobs/${(job).jobId}/complete`, { body: {} })],
        ["GROUP-018/019: cancelling", (job) => admin(USERS.MANAGER, "POST", `/jobs/${(job).jobId}/cancel`, { body: { reason: "Client withdrew" } })],
    ]) {
        test(`${label} the job stops new verification and ends open sessions on their next request; submissions and links are kept`, async () => {
            const job = await newJob();
            await assign(job, A, B, C3);
            const secret = await groupLink(job);
            const tokenA = await groupSession(secret, A);
            const tokenB = await groupSession(secret, B);
            assert.equal((await submit(tokenA, "key-aaaaaaaaaaaaaaaa")).status, 200);
            assert.equal((await formOf(tokenB)).status, 200);

            assert.equal((await close(job)).status, 200);
            expectGeneric(await verify(secret, C3), "new verification after close");
            expectGeneric(await verify(secret, B), "even for an unsubmitted member");
            const stale = await formOf(tokenB);
            assert.deepEqual([stale.status, stale.body.code], [401, "VERIFICATION_REQUIRED"]);
            assert.equal((await submit(tokenB)).status, 401);
            assert.equal((await access(A)).status, "SUBMITTED", "already submitted stays submitted");
            assert.equal(await prisma.candidateFormResponse.count(), 1, "responses intact");
            assert.equal(await prisma.candidateFormLink.count({ where: { jobId: job.jobId, revokedAt: null } }), 1, "the link is not deleted or revoked, just unusable");
            assert.equal((await admin(USERS.MANAGER, "GET", `/jobs/${job.jobId}/form-share`)).body.state, "NONE");
        });
    }

    test("a personal SINGLE link follows its own validity and survives the job closing", async () => {
        const job = await newJob();
        await assign(job, A);
        const single = await singleLink(A);
        await admin(USERS.MANAGER, "POST", `/jobs/${job.jobId}/complete`, { body: {} });
        assert.equal((await verify(single, A)).status, 200);
    });

    test("GROUP-020: revoking ends sessions of that link, locks the members it unlocked, keeps submissions, and does not touch assignments or other links", async () => {
        const job = await newJob();
        const other = await newJob();
        await assign(job, A, B);
        await assign(other, C3);
        const secret = await groupLink(job);
        const otherSecret = await groupLink(other);
        const tokenA = await groupSession(secret, A);
        const tokenB = await groupSession(secret, B);
        assert.equal((await submit(tokenB, "key-bbbbbbbbbbbbbbbb")).status, 200);
        const members = JSON.stringify(await prisma.jobCandidate.findMany({ orderBy: [{ jobId: "asc" }, { passportId: "asc" }] }));

        const r = await admin(USERS.ADMIN, "POST", `/jobs/${job.jobId}/form-share/revoke`);
        assert.deepEqual([r.status, r.body.state], [200, "NONE"]);
        const stale = await formOf(tokenA);
        assert.deepEqual([stale.status, stale.body.code], [401, "VERIFICATION_REQUIRED"]);
        expectGeneric(await verify(secret, A), "revoked");
        assert.deepEqual([(await access(A)).status, (await access(B)).status], ["LOCKED", "SUBMITTED"]);
        assert.equal(await prisma.candidateFormResponse.count(), 1);
        assert.equal(JSON.stringify(await prisma.jobCandidate.findMany({ orderBy: [{ jobId: "asc" }, { passportId: "asc" }] })), members);
        assert.equal((await verify(otherSecret, C3)).status, 200, "another job's link is unaffected");
        assert.equal((await admin(USERS.ADMIN, "POST", `/jobs/${job.jobId}/form-share/revoke`)).status, 404, "nothing left to revoke");
        const audits = await prisma.auditLog.findMany({ where: { action: { in: ["CREATE_JOB_FORM_LINK", "REVOKE_JOB_FORM_LINK"] } } });
        assert.equal(audits.filter((a) => a.action === "REVOKE_JOB_FORM_LINK").length, 1);
    });
});

describe("legacy and isolation", () => {
    test("the legacy candidate_stages.job_id, the job code and the Client Job ID never authorise anything", async () => {
        const job = await newJob({ companyJobId: "Y26S01" });
        await prisma.candidateStage.update({ where: { passportId_stage: { passportId: D.passportId, stage: "TEST_DETAILS" } }, data: { jobId: job.jobCode } });
        await prisma.candidateStage.create({ data: { passportId: D.passportId, stage: "FINALIZING_JOB", jobId: "Y26S01" } }).catch(() => null);
        const secret = await groupLink(job);
        expectGeneric(await verify(secret, D), "legacy text is not membership");
        assert.equal(await prisma.candidateFormLink.count({ where: { OR: [{ tokenHash: job.jobCode }, { tokenHash: "Y26S01" }] } }), 0);
    });

    test("the new schema keeps RLS: candidate_form_link has no API-role privileges", async () => {
        assert.deepEqual((await pg.query(`SELECT 1 FROM information_schema.role_table_grants WHERE grantee IN ('anon','authenticated') AND table_name IN ('candidate_form_link','job','job_candidate')`)).rows, []);
        const rls = (await pg.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'candidate_form_link'`)).rows;
        assert.equal(rls[0].relrowsecurity, true);
    });
});
