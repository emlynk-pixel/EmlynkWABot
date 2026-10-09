// Audit Logs: candidate / stage activity is written to audit_logs, and the
// ADMIN-only read API (GET /api/admin/audit-logs) with its filters. On a
// REAL PostgreSQL (PGlite, every migration applied, so the append-only
// trigger and the user foreign key are real) through the real Prisma client.
// No Supabase: the signed-in user is set by a stand-in for requireActiveUser.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import {
    createCandidate,
    parseCandidateBody,
    parseStageBody,
    updateCandidateDetails,
    updateStage,
} from "../src/services/candidateService.js";
import { categoryOf, parseAuditLogQuery } from "../src/services/auditLogService.js";

const USERS = {
    ADMIN: { adminId: "user-admin", authUserId: "00000000-0000-4000-8000-000000000001", name: "Ada Admin", email: "ada@example.com", role: "ADMIN" },
    MANAGER: { adminId: "user-manager", authUserId: "00000000-0000-4000-8000-000000000002", name: "Mia Manager", email: "mia@example.com", role: "MANAGER" },
    ANALYST: { adminId: "user-analyst", authUserId: "00000000-0000-4000-8000-000000000003", name: "Ali Analyst", email: "ali@example.com", role: "ANALYST" },
    REGISTRATION_DESK: { adminId: "user-desk", authUserId: "00000000-0000-4000-8000-000000000004", name: "Dee Desk", email: "dee@example.com", role: "REGISTRATION_DESK" },
};
// What requireActiveUser puts on req.user: the profile, never a credential.
const profile = (role) => {
    const { authUserId, ...rest } = USERS[role];
    return { ...rest, authUserId, status: "ACTIVE" };
};

const REGISTRATION = {
    passportId: "N1023757", surname: "De Soysa", otherNames: "Anusha", nic: "965404378V",
    whatsappNumber: "+94771234567", jobTypes: ["Caregiver"], jobExperience: "2 years", passportIssueDate: "2020-01-15", passportExpiryDate: "2030-01-14",
};

let database;
let prisma;
let pg;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const user of Object.values(USERS)) await prisma.user.create({ data: user });
});
after(async () => database?.close());

beforeEach(async () => {
    // audit_logs is append-only: its triggers reject UPDATE, DELETE and
    // TRUNCATE. This throwaway database lifts them just to start each test
    // empty ("the log stays immutable" below checks they are back on).
    await pg.exec(`
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "documents"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
        DELETE FROM "sheet_sync_queue";
    `);
});

const auditRows = () => prisma.auditLog.findMany({ orderBy: [{ createdDate: "asc" }, { auditId: "asc" }] });

async function register(overrides = {}, actor = profile("ADMIN")) {
    const { values, errors } = parseCandidateBody({ ...REGISTRATION, ...overrides }, { creating: true });
    assert.equal(errors, undefined);
    return createCandidate({ db: prisma, values, actor });
}

const details = (overrides = {}) => parseCandidateBody({ ...REGISTRATION, ...overrides }, { creating: false }).values;
const stage = (name, body) => parseStageBody(body, name).values;

async function withServer(role, work) {
    const app = express();
    app.use(express.json());
    const requireAdmin = (req, res, next) => { req.user = profile(role); next(); };
    app.use("/api/admin", createAdminRouter({ db: prisma, requireAdmin, apiLimiter: noRateLimit }));
    app.use(errorHandler);
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/admin`;
    try {
        return await work(async (path, { method = "GET", body } = {}) => {
            const response = await fetch(`${base}${path}`, {
                method,
                headers: { "content-type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            const text = await response.text();
            return { status: response.status, body: text ? JSON.parse(text) : null, text };
        });
    } finally {
        server.close();
    }
}

describe("candidate activity is audited", () => {
    test("registering a candidate writes CREATE_CANDIDATE by the signed-in user", async () => {
        const { uniqueId } = await register();
        const rows = await auditRows();
        assert.equal(rows.length, 1);
        const [row] = rows;
        assert.equal(row.action, "CREATE_CANDIDATE");
        assert.equal(row.adminId, USERS.ADMIN.adminId);
        assert.equal(row.passportId, "N1023757");
        assert.equal(row.previousStatus, "NONE");
        assert.equal(row.newStatus, "CREATED");
        assert.match(row.reason, new RegExp(uniqueId));
        const summary = JSON.parse(row.newValue);
        assert.equal(summary.uniqueId, uniqueId);
        assert.ok(summary.fields.includes("nic") && summary.fields.includes("whatsappNumber"));
        // Which details were given, never their values.
        assert.ok(!row.newValue.includes("965404378V"));
    });

    test("a refused registration (duplicate passport) writes nothing", async () => {
        await register();
        await assert.rejects(register({ nic: "200012345678", whatsappNumber: "+94770000001" }));
        assert.equal((await auditRows()).length, 1);
    });

    test("updating details records only the changed fields, before and after", async () => {
        await register();
        await updateCandidateDetails({ db: prisma, passportId: "N1023757", values: details({ address: "12 Galle Road", jobExperience: "3 years" }), actor: profile("MANAGER") });
        const row = (await auditRows()).at(-1);
        assert.equal(row.action, "UPDATE_CANDIDATE");
        assert.equal(row.adminId, USERS.MANAGER.adminId);
        assert.deepEqual(JSON.parse(row.previousValue), { address: null, jobExperience: "2 years" });
        assert.deepEqual(JSON.parse(row.newValue), { address: "12 Galle Road", jobExperience: "3 years" });
        assert.match(row.reason, /address, jobExperience/);
    });

    test("saving the same details again is not audited", async () => {
        await register({ address: "12 Galle Road" });
        await updateCandidateDetails({ db: prisma, passportId: "N1023757", values: details({ address: "12 Galle Road" }), actor: profile("ADMIN") });
        assert.deepEqual((await auditRows()).map((r) => r.action), ["CREATE_CANDIDATE"]);
    });

    test("a date changed is recorded as YYYY-MM-DD; the same date resubmitted is not a change", async () => {
        await register({ dateOfBirth: "1996-02-23" });
        await updateCandidateDetails({ db: prisma, passportId: "N1023757", values: details({ dateOfBirth: "1996-02-23" }), actor: profile("ADMIN") });
        assert.equal((await auditRows()).length, 1);
        await updateCandidateDetails({ db: prisma, passportId: "N1023757", values: details({ dateOfBirth: "1996-03-01" }), actor: profile("ADMIN") });
        const row = (await auditRows()).at(-1);
        assert.deepEqual([JSON.parse(row.previousValue), JSON.parse(row.newValue)], [{ dateOfBirth: "1996-02-23" }, { dateOfBirth: "1996-03-01" }]);
    });

    test("a stage completed records the stage and its completion before and after", async () => {
        await register();
        await updateStage({ db: prisma, passportId: "N1023757", stage: "IVS_INTERVIEW", values: stage("IVS_INTERVIEW", { completed: true, notes: "Passed the interview" }), actor: profile("ANALYST") });
        const row = (await auditRows()).at(-1);
        assert.equal(row.action, "UPDATE_STAGE");
        assert.equal(row.adminId, USERS.ANALYST.adminId);
        assert.equal(row.previousStatus, "NOT_COMPLETED");
        assert.equal(row.newStatus, "COMPLETED");
        assert.equal(row.reason, "Passed the interview");
        assert.deepEqual(JSON.parse(row.previousValue), { stage: "IVS_INTERVIEW", completed: false, notes: null });
        assert.deepEqual(JSON.parse(row.newValue), { stage: "IVS_INTERVIEW", completed: true, notes: "Passed the interview" });
    });

    test("test details record only what changed; a no-op stage save is not audited", async () => {
        await register();
        const save = (body) => updateStage({ db: prisma, passportId: "N1023757", stage: "TEST_DETAILS", values: stage("TEST_DETAILS", body), actor: profile("ADMIN") });
        await save({ jobId: "J-1", testResult: "PASS", testDate: "2026-09-28" });
        await save({ jobId: "J-1", testResult: "PASS", testDate: "2026-09-28" });
        await save({ completed: false });
        const stages = (await auditRows()).filter((r) => r.action === "UPDATE_STAGE");
        assert.equal(stages.length, 1, "neither the repeat nor 'not completed' on a stage that isn't is a change");
        assert.deepEqual(JSON.parse(stages[0].newValue), { stage: "TEST_DETAILS", jobId: "J-1", testResult: "PASS", testDate: "2026-09-28" });
        assert.equal(stages[0].previousStatus, stages[0].newStatus);
        assert.equal(stages[0].reason, null);

        await save({ testResult: "FAIL" });
        const last = (await auditRows()).at(-1);
        assert.deepEqual([JSON.parse(last.previousValue), JSON.parse(last.newValue)], [{ stage: "TEST_DETAILS", testResult: "PASS" }, { stage: "TEST_DETAILS", testResult: "FAIL" }]);
    });

    test("notes on an automatic stage are audited; reopening a completed stage is recorded", async () => {
        await register();
        await updateStage({ db: prisma, passportId: "N1023757", stage: "CANDIDATE_DETAILS", values: stage("CANDIDATE_DETAILS", { notes: "Called about the address" }), actor: profile("ADMIN") });
        await updateStage({ db: prisma, passportId: "N1023757", stage: "VISA_APPROVAL", values: stage("VISA_APPROVAL", { completed: true }), actor: profile("ADMIN") });
        await updateStage({ db: prisma, passportId: "N1023757", stage: "VISA_APPROVAL", values: stage("VISA_APPROVAL", { completed: false }), actor: profile("ADMIN") });
        const rows = (await auditRows()).filter((r) => r.action === "UPDATE_STAGE");
        assert.deepEqual(rows.map((r) => [JSON.parse(r.newValue).stage, r.previousStatus, r.newStatus]), [
            ["CANDIDATE_DETAILS", "NOT_COMPLETED", "NOT_COMPLETED"],
            ["VISA_APPROVAL", "NOT_COMPLETED", "COMPLETED"],
            ["VISA_APPROVAL", "COMPLETED", "NOT_COMPLETED"],
        ]);
    });

    test("the candidate routes record req.user as the actor", async () => {
        await withServer("REGISTRATION_DESK", async (call) => {
            assert.equal((await call("/candidates", { method: "POST", body: REGISTRATION })).status, 201);
            assert.equal((await call("/candidates/N1023757", { method: "PUT", body: { ...REGISTRATION, address: "Kandy" } })).status, 200);
        });
        await withServer("ANALYST", async (call) => {
            assert.equal((await call("/candidates/N1023757/stages/FINALIZING_JOB", { method: "PUT", body: { completed: true } })).status, 200);
        });
        assert.deepEqual((await auditRows()).map((r) => [r.action, r.adminId]), [
            ["CREATE_CANDIDATE", USERS.REGISTRATION_DESK.adminId],
            ["UPDATE_CANDIDATE", USERS.REGISTRATION_DESK.adminId],
            ["UPDATE_STAGE", USERS.ANALYST.adminId],
        ]);
    });

    test("nothing of the user's account or session is ever written; unknown request fields are ignored", async () => {
        await withServer("ADMIN", async (call) => {
            const secretish = { password: "hunter2-secret", accessToken: "eyJhbGciOi.secret", sessionId: "sess-123" };
            assert.equal((await call("/candidates", { method: "POST", body: { ...REGISTRATION, ...secretish } })).status, 201);
            assert.equal((await call("/candidates/N1023757", { method: "PUT", body: { ...REGISTRATION, ...secretish, address: "Kandy" } })).status, 200);
            assert.equal((await call("/candidates/N1023757/stages/IVS_INTERVIEW", { method: "PUT", body: { notes: "ok", ...secretish } })).status, 200);
        });
        const stored = JSON.stringify(await auditRows());
        for (const forbidden of ["hunter2", "eyJhbGciOi", "sess-123", "password", "accessToken", USERS.ADMIN.authUserId, USERS.ADMIN.email]) {
            assert.ok(!stored.includes(forbidden), `${forbidden} must not be in the audit log`);
        }
    });
});

describe("GET /api/admin/audit-logs", () => {
    // Twelve entries: 3 registrations (ADMIN, DESK, DESK), 1 detail change
    // (MANAGER), 2 stage changes (ANALYST), and 6 user-management entries
    // written directly, spread over two days.
    async function seed() {
        await register({}, profile("ADMIN"));
        await register({ passportId: "P2000001", surname: "Perera", otherNames: "Kamal", nic: "200012345678", whatsappNumber: "+94770000001" }, profile("REGISTRATION_DESK"));
        await register({ passportId: "P2000002", surname: "Silva", otherNames: "Nimal", nic: "200012345679", whatsappNumber: "+94770000002" }, profile("REGISTRATION_DESK"));
        await updateCandidateDetails({ db: prisma, passportId: "P2000001", values: details({ passportId: undefined, surname: "Perera", otherNames: "Kamal", nic: "200012345678", whatsappNumber: "+94770000001", address: "Colombo 05" }), actor: profile("MANAGER") });
        await updateStage({ db: prisma, passportId: "N1023757", stage: "IVS_INTERVIEW", values: stage("IVS_INTERVIEW", { completed: true, notes: "Interview passed" }), actor: profile("ANALYST") });
        await updateStage({ db: prisma, passportId: "P2000002", stage: "VISA_APPROVAL", values: stage("VISA_APPROVAL", { completed: true }), actor: profile("ANALYST") });
        for (let i = 0; i < 6; i++) {
            await prisma.auditLog.create({
                data: {
                    auditId: `00000000-0000-4000-9000-00000000000${i}`, adminId: USERS.ADMIN.adminId, action: "UPDATE_USER_ROLE",
                    previousStatus: "ANALYST", newStatus: "MANAGER", reason: `Role changed for user u-${i}`, previousValue: "ANALYST", newValue: "MANAGER",
                    createdDate: new Date("2026-01-15T10:00:00Z"),
                },
            });
        }
    }

    for (const role of ["MANAGER", "ANALYST", "REGISTRATION_DESK"]) {
        test(`${role} is refused (403)`, async () => {
            await seed();
            await withServer(role, async (call) => {
                const response = await call("/audit-logs");
                assert.equal(response.status, 403);
                assert.ok(!response.text.includes("CREATE_CANDIDATE"));
            });
        });
    }

    test("ADMIN gets the newest entries first, with actor, candidate and pagination", async () => {
        await seed();
        await withServer("ADMIN", async (call) => {
            const { status, body } = await call("/audit-logs");
            assert.equal(status, 200);
            assert.deepEqual(body.pagination, { page: 1, pageSize: 25, total: 12, totalPages: 1 });
            assert.equal(body.items.length, 12);
            assert.equal(body.items[0].action, "UPDATE_STAGE", "newest first");
            assert.equal(body.items.at(-1).action, "UPDATE_USER_ROLE", "January's entries last");

            const visa = body.items[0];
            assert.deepEqual(visa.actor, { userId: USERS.ANALYST.adminId, name: "Ali Analyst", role: "ANALYST" });
            assert.equal(visa.candidate.passportId, "P2000002");
            assert.equal(visa.candidate.name, "Nimal Silva");
            assert.match(visa.candidate.uniqueId, /\S/);
            assert.equal(visa.category, "STAGE");
            assert.equal(visa.stage, "VISA_APPROVAL");
            assert.deepEqual(visa.changes, [{ field: "completed", from: false, to: true }]);

            const update = body.items.find((i) => i.action === "UPDATE_CANDIDATE");
            assert.deepEqual(update.changes, [{ field: "address", from: null, to: "Colombo 05" }]);
            assert.equal(update.category, "CANDIDATE");

            const role = body.items.at(-1);
            assert.equal(role.candidate, null);
            assert.deepEqual([role.previousValue, role.newValue, role.category], ["ANALYST", "MANAGER", "USER"]);

            assert.deepEqual(body.filters.users.map((u) => u.name), ["Ada Admin", "Ali Analyst", "Dee Desk", "Mia Manager"]);
            assert.ok(body.filters.actions.includes("UPDATE_STAGE"));
            assert.deepEqual(body.filters.categories.map((c) => c.category), ["CANDIDATE", "STAGE", "DOCUMENT", "REVIEW", "USER", "OTHER"]);
        });
    });

    test("the response carries no account, session or internal storage data", async () => {
        await seed();
        await withServer("ADMIN", async (call) => {
            const { text, body } = await call("/audit-logs");
            for (const user of Object.values(USERS)) {
                assert.ok(!text.includes(user.authUserId), "no Supabase identity");
                assert.ok(!text.includes(user.email), "no account email in the actor summary");
            }
            for (const key of ["authUserId", "fileSha256", "temporaryId", "password", "token", "session"]) {
                assert.ok(!text.includes(`"${key}"`), `no ${key} field`);
            }
            assert.deepEqual(Object.keys(body.items[0].actor).sort(), ["name", "role", "userId"]);
            assert.deepEqual(Object.keys(body.filters.users[0]).sort(), ["name", "role", "status", "userId"]);
        });
    });

    test("pages are cut on the server", async () => {
        await seed();
        await withServer("ADMIN", async (call) => {
            const first = (await call("/audit-logs?pageSize=5")).body;
            const third = (await call("/audit-logs?pageSize=5&page=3")).body;
            assert.deepEqual(first.pagination, { page: 1, pageSize: 5, total: 12, totalPages: 3 });
            assert.equal(first.items.length, 5);
            assert.equal(third.items.length, 2);
            const ids = new Set([...first.items, ...third.items].map((i) => i.auditId));
            assert.equal(ids.size, 7, "no entry repeats across pages");
            assert.equal((await call("/audit-logs?pageSize=101")).status, 400, "at most 100 a page");
            assert.equal((await call("/audit-logs?page=0")).status, 400);
        });
    });

    test("filter by the user who did it", async () => {
        await seed();
        await withServer("ADMIN", async (call) => {
            const { body } = await call(`/audit-logs?adminId=${USERS.REGISTRATION_DESK.adminId}`);
            assert.equal(body.pagination.total, 2);
            assert.ok(body.items.every((i) => i.actor.userId === USERS.REGISTRATION_DESK.adminId && i.action === "CREATE_CANDIDATE"));
        });
    });

    test("filter by candidate: passport ID (any case) or name / unique ID", async () => {
        await seed();
        await withServer("ADMIN", async (call) => {
            const byPassport = (await call("/audit-logs?passportId=n1023757")).body;
            assert.deepEqual(byPassport.items.map((i) => i.action), ["UPDATE_STAGE", "CREATE_CANDIDATE"]);
            const byName = (await call("/audit-logs?candidate=Kamal")).body;
            assert.deepEqual(byName.items.map((i) => [i.action, i.candidate.passportId]), [["UPDATE_CANDIDATE", "P2000001"], ["CREATE_CANDIDATE", "P2000001"]]);
            const uniqueId = byName.items[0].candidate.uniqueId;
            // The candidate search of the Candidates list: partial, so a short
            // numeric unique ID can also match other candidates' numbers.
            const byUniqueId = (await call(`/audit-logs?candidate=${encodeURIComponent(uniqueId)}`)).body;
            assert.equal(byUniqueId.items.filter((i) => i.candidate.passportId === "P2000001").length, 2);
            assert.ok(byUniqueId.items.every((i) => i.candidate), "only candidate entries");
            assert.equal((await call("/audit-logs?candidate=Nobody")).body.pagination.total, 0);
        });
    });

    test("filter by action and by category", async () => {
        await seed();
        await withServer("ADMIN", async (call) => {
            assert.equal((await call("/audit-logs?action=CREATE_CANDIDATE")).body.pagination.total, 3);
            assert.equal((await call("/audit-logs?category=STAGE")).body.pagination.total, 2);
            assert.equal((await call("/audit-logs?category=CANDIDATE")).body.pagination.total, 4);
            assert.equal((await call("/audit-logs?category=USER")).body.pagination.total, 6);
            assert.equal((await call("/audit-logs?category=OTHER")).body.pagination.total, 0);
            assert.equal((await call("/audit-logs?category=NOPE")).status, 400);
        });
    });

    test("filter by business-day dates and free-text search", async () => {
        await seed();
        await withServer("ADMIN", async (call) => {
            assert.equal((await call("/audit-logs?startDate=2026-01-15&endDate=2026-01-15")).body.pagination.total, 6);
            assert.equal((await call("/audit-logs?endDate=2026-01-14")).body.pagination.total, 0);
            assert.equal((await call("/audit-logs?startDate=2026-02-01&endDate=2026-01-01")).status, 400);
            assert.equal((await call("/audit-logs?startDate=2026-13-01")).status, 400);
            assert.deepEqual((await call("/audit-logs?search=interview%20passed")).body.items.map((i) => i.action), ["UPDATE_STAGE"]);
            assert.equal((await call("/audit-logs?search=Mia")).body.pagination.total, 1, "by the user's name");
            assert.equal((await call("/audit-logs?search=update%20user%20role")).body.pagination.total, 6, "by the action, as words");
        });
    });

    test("there is no route that changes or removes an entry", async () => {
        await seed();
        const router = createAdminRouter({ db: prisma, requireAdmin: (req, res, next) => next(), apiLimiter: noRateLimit });
        const auditRoutes = router.stack.filter((layer) => layer.route?.path.includes("audit")).map((layer) => [layer.route.path, Object.keys(layer.route.methods)]);
        assert.deepEqual(auditRoutes, [["/audit-logs", ["get"]]]);
        await withServer("ADMIN", async (call) => {
            const [entry] = (await call("/audit-logs?pageSize=1")).body.items;
            for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
                assert.equal((await call("/audit-logs", { method, body: {} })).status, 404, `${method} /audit-logs`);
                assert.equal((await call(`/audit-logs/${entry.auditId}`, { method, body: {} })).status, 404, `${method} /audit-logs/:id`);
            }
        });
        assert.equal((await auditRows()).length, 12, "every entry is still there");
    });

    test("the log stays immutable in the database", async () => {
        await seed();
        await assert.rejects(pg.exec(`UPDATE "audit_logs" SET "reason" = 'changed'`), /append-only/);
        await assert.rejects(pg.exec(`DELETE FROM "audit_logs"`), /append-only/);
        assert.equal((await auditRows()).length, 12);
    });
});

describe("query parsing", () => {
    test("defaults, limits and repeated parameters", () => {
        assert.deepEqual(parseAuditLogQuery({}).params, { page: 1, pageSize: 25 });
        assert.deepEqual(parseAuditLogQuery({ pageSize: "100" }).params.pageSize, 100);
        assert.ok(parseAuditLogQuery({ pageSize: "500" }).errors);
        assert.ok(parseAuditLogQuery({ adminId: ["a", "b"] }).errors);
        assert.ok(parseAuditLogQuery({ adminId: "bad id!" }).errors);
        assert.ok(parseAuditLogQuery({ action: "drop table" }).errors);
        assert.ok(parseAuditLogQuery({ search: "x".repeat(101) }).errors);
    });

    test("every action has a category; unknown ones are OTHER", () => {
        assert.equal(categoryOf("UPLOAD_DOCUMENT"), "DOCUMENT");
        assert.equal(categoryOf("APPROVE"), "REVIEW");
        assert.equal(categoryOf("DEACTIVATE_USER"), "USER");
        assert.equal(categoryOf("SOMETHING_OLD"), "OTHER");
    });
});
