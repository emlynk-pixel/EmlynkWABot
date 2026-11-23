// In-app notifications (notificationService.js, notificationEvents.js, notificationRecipients.js and
// GET/POST /api/admin/notifications). On a REAL PostgreSQL (PGlite, every migration applied) through
// the real Prisma client and the real admin router; the signed-in user is read from the database on
// every request, like requireActiveUser.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createErrorHandler, errorHandler } from "../src/middleware/errorHandler.js";
import { notify, notifyAll, parseNotificationListQuery } from "../src/services/notificationService.js";
import { AUDIENCE, resolveRecipients, tierRoles } from "../src/services/notificationRecipients.js";
import {
    NOTIFICATION_TYPE,
    allocationMessage,
    createSystemAlertReporter,
    isFormLinkSystemError,
    notifyAgentsMissingCountry,
    notifyNewJobs,
    notifyRoleUpdated,
    notifySheetSyncFailed,
    notifySystemAlert,
    resetSystemAlertMemory,
    systemAlertDedupeKey,
} from "../src/services/notificationEvents.js";
import { updateUserRole } from "../src/services/userAccountService.js";
import { createSheetSyncStore, RUN_KIND, RUN_STATUS, RUN_TRIGGER } from "../src/services/sheetSyncStore.js";

const user = (adminId, role, name, n, status = "ACTIVE") => ({
    adminId, role, name, status, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
});
const USERS = {
    OWNER: user("u-owner", "OWNER", "Olive Owner", 1),
    ADMIN: user("u-admin", "ADMIN", "Ada Admin", 2),
    LEAD: user("u-lead", "TEAM_LEAD", "Tia Lead", 3),
    ANN: user("u-ann", "ANALYST", "Ann Analyst", 4),
    BEN: user("u-ben", "ANALYST", "Ben Analyst", 5),
    DESK: user("u-desk", "REGISTRATION_DESK", "Dee Desk", 6),
    JOBS: user("u-jobs", "JOB_HANDLER", "Jo Handler", 7),
    GONE: user("u-gone", "ADMIN", "Gus Gone", 8, "INACTIVE"),
};
const pid = (i) => `P${String(i).padStart(7, "0")}`;

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
    resetSystemAlertMemory();
    await pg.exec(`
        DELETE FROM "notification";
        DROP TRIGGER IF EXISTS "notification_test_fail" ON "notification";
        DELETE FROM "call_log_follow_up"; DELETE FROM "candidate_call_logs"; DELETE FROM "candidate_allocation";
        DELETE FROM "candidate_form_link"; DELETE FROM "candidate_form_access";
        DELETE FROM "candidate_stages"; DELETE FROM "candidate";
        DELETE FROM "sheet_sync_runs";
        UPDATE "user" SET "role" = 'ANALYST', "status" = 'ACTIVE' WHERE "admin_id" IN ('u-ann', 'u-ben');
        UPDATE "user" SET "role" = 'REGISTRATION_DESK' WHERE "admin_id" = 'u-desk';
        INSERT INTO "candidate" ("passport_id", "unique_id", "first_name", "other_name", "created_date", "updated_date")
        SELECT 'P' || lpad(i::text, 7, '0'), lpad(i::text, 4, '0'), 'Given' || i, 'Surname',
               timestamp '2026-01-01 00:00:00' + i * interval '1 minute', now()
        FROM generate_series(1, 6) AS i;
    `);
});

// A failing insert into "notification" (a trigger), to prove the triggering action is unaffected.
const breakNotificationInserts = () => pg.exec(`
    CREATE OR REPLACE FUNCTION "notification_test_fail_fn"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'notification insert refused'; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER "notification_test_fail" BEFORE INSERT ON "notification" FOR EACH ROW EXECUTE FUNCTION "notification_test_fail_fn"();
`);

async function api(who, method, path, body, routerOptions = {}) {
    const app = express();
    app.use(express.json());
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: who.adminId }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
        next();
    };
    app.use("/api/admin", createAdminRouter({ db: prisma, bucket: {}, requireAdmin, apiLimiter: noRateLimit, candidateFormOrigin: "", ...routerOptions }));
    app.use(errorHandler);
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin${path}`, {
            method,
            headers: body === undefined ? {} : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    } finally {
        server.close();
    }
}

// recipient -> [type, ...] of every notification row, for the whole table.
async function inbox() {
    const rows = await prisma.notification.findMany({ orderBy: [{ recipientId: "asc" }, { type: "asc" }] });
    const by = {};
    for (const row of rows) (by[row.recipientId] ??= []).push(row.type);
    return by;
}
const rowsOf = (who) => prisma.notification.findMany({ where: { recipientId: who.adminId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
const ADMIN_TEAM_IDS = [USERS.ADMIN.adminId, USERS.LEAD.adminId, USERS.OWNER.adminId].sort();

describe("recipients (notificationRecipients.js)", () => {
    test("the Admin audience follows hasRole: OWNER inherits ADMIN; TEAM_LEAD is named; no other role", () => {
        assert.deepEqual([...tierRoles(["ADMIN"])].sort(), ["ADMIN", "OWNER"]);
        assert.deepEqual([...AUDIENCE.ADMIN_TEAM].sort(), ["ADMIN", "OWNER", "TEAM_LEAD"]);
        assert.deepEqual([...AUDIENCE.SHEET_SYNC_STAFF].sort(), ["ADMIN", "TEAM_LEAD"], "E9: exact roles, never an Owner");
        assert.deepEqual([...AUDIENCE.OWNERS], ["OWNER"]);
    });

    test("only ACTIVE users, exact roles, each once", async () => {
        const users = await resolveRecipients(prisma, { roles: ["ADMIN"], userIds: [USERS.ADMIN.adminId, USERS.GONE.adminId, USERS.ANN.adminId] });
        assert.deepEqual(users.map((u) => u.adminId).sort(), [USERS.ADMIN.adminId, USERS.ANN.adminId].sort(), "the INACTIVE admin gets nothing");
        assert.deepEqual(await resolveRecipients(prisma, {}), []);
    });

    test("excludeUserIds: never those users, whatever their role; per spec in notifyAll", async () => {
        const users = await resolveRecipients(prisma, { roles: AUDIENCE.ADMIN_TEAM, excludeUserIds: [USERS.ADMIN.adminId] });
        assert.deepEqual(users.map((u) => u.adminId).sort(), [USERS.LEAD.adminId, USERS.OWNER.adminId].sort());
        await notifyAll(prisma, [
            { type: "X1", dedupeKey: "x:1", roles: AUDIENCE.ADMIN_TEAM, excludeUserIds: [USERS.LEAD.adminId] },
            { type: "X2", dedupeKey: "x:2", roles: AUDIENCE.ADMIN_TEAM },
        ]);
        assert.deepEqual(await inbox(), {
            [USERS.ADMIN.adminId]: ["X1", "X2"],
            [USERS.LEAD.adminId]: ["X2"],
            [USERS.OWNER.adminId]: ["X1", "X2"],
        });
    });
});

describe("A1 New Candidates Allocated", () => {
    test("singular and plural", () => {
        assert.equal(allocationMessage(1), "You have received 1 new candidate.");
        assert.equal(allocationMessage(2), "You have received 2 new candidates.");
        assert.equal(allocationMessage(25), "You have received 25 new candidates.");
    });

    test("only the allocated Analyst, once per action with that action's count; another Analyst and the managers get nothing", async () => {
        const res = await api(USERS.ADMIN, "POST", "/work-allocation/assign", { candidateIds: [pid(1), pid(2), pid(3)], allocations: [{ analystId: USERS.ANN.adminId, count: 2 }, { analystId: USERS.BEN.adminId, count: 1 }] });
        assert.equal(res.status, 200);
        const ann = await rowsOf(USERS.ANN);
        const ben = await rowsOf(USERS.BEN);
        assert.equal(ann.length, 1);
        assert.deepEqual([ann[0].type, ann[0].title, ann[0].message], [NOTIFICATION_TYPE.A1, "New Candidates Allocated", "You have received 2 new candidates."]);
        assert.equal(ben.length, 1);
        assert.equal(ben[0].message, "You have received 1 new candidate.");
        assert.deepEqual(Object.keys(await inbox()).sort(), [USERS.ANN.adminId, USERS.BEN.adminId].sort());

        // Analyst A only: Analyst B receives nothing from it.
        await api(USERS.LEAD, "POST", "/work-allocation/assign", { candidateIds: [pid(4)], allocations: [{ analystId: USERS.ANN.adminId, count: 1 }] });
        assert.equal((await rowsOf(USERS.ANN)).length, 2);
        assert.equal((await rowsOf(USERS.BEN)).length, 1);
    });

    test("a reassignment counts only the candidates moved TO the Analyst; one that stays with them is not notified", async () => {
        await api(USERS.ADMIN, "POST", "/work-allocation/assign", { candidateIds: [pid(1)], allocations: [{ analystId: USERS.ANN.adminId, count: 1 }] });
        await prisma.notification.deleteMany();
        const same = await api(USERS.ADMIN, "POST", "/work-allocation/assign", { candidateIds: [pid(1)], allocations: [{ analystId: USERS.ANN.adminId, count: 1 }], reassign: true });
        assert.equal(same.status, 200);
        assert.equal((await prisma.notification.count()), 0, "nothing changed: no notification");
        const moved = await api(USERS.ADMIN, "POST", "/work-allocation/assign", { candidateIds: [pid(1), pid(2)], allocations: [{ analystId: USERS.BEN.adminId, count: 2 }], reassign: true });
        assert.equal(moved.status, 200);
        assert.equal((await rowsOf(USERS.BEN))[0].message, "You have received 2 new candidates.");
        assert.equal((await rowsOf(USERS.ANN)).length, 0);
    });

    test("auto-allocate: each Analyst once, with their equal share", async () => {
        const res = await api(USERS.ADMIN, "POST", "/work-allocation/auto-allocate", { candidateIds: [pid(1), pid(2), pid(3), pid(4), pid(5)], analystIds: [USERS.ANN.adminId, USERS.BEN.adminId] });
        assert.equal(res.status, 200);
        assert.equal((await rowsOf(USERS.ANN))[0].message, "You have received 2 new candidates.");
        assert.equal((await rowsOf(USERS.BEN))[0].message, "You have received 2 new candidates.");
        assert.equal(await prisma.notification.count(), 2);
    });

    test("a Team Lead receiving candidates is not sent A1 (Analyst notification)", async () => {
        const res = await api(USERS.ADMIN, "POST", "/work-allocation/assign", { candidateIds: [pid(1)], allocations: [{ analystId: USERS.LEAD.adminId, count: 1 }] });
        assert.equal(res.status, 200);
        assert.equal(await prisma.notification.count(), 0);
    });

    test("a failing notification write never breaks the allocation", async () => {
        await breakNotificationInserts();
        const logged = [];
        const original = console.error;
        console.error = (line) => logged.push(String(line));
        try {
            const res = await api(USERS.ADMIN, "POST", "/work-allocation/assign", { candidateIds: [pid(1)], allocations: [{ analystId: USERS.ANN.adminId, count: 1 }] });
            assert.equal(res.status, 200);
        } finally {
            console.error = original;
        }
        assert.equal((await prisma.candidateAllocation.findUnique({ where: { passportId: pid(1) } })).analystId, USERS.ANN.adminId, "the allocation is committed");
        const line = logged.find((l) => l.includes("notification.write_failed"));
        assert.ok(line, "logged");
        const parsed = JSON.parse(line);
        assert.deepEqual(parsed.types, [NOTIFICATION_TYPE.A1]);
        assert.doesNotMatch(line, /Given|Surname|P000000|Ann Analyst|received/, "no names, identifiers or text in the log");
    });
});

describe("E1 Candidate Cancelled and E2 Need Attention: Admins, Owners and Team Leads, never the acting user", () => {
    test("E1: the Admin tier and Team Leads except the user who cancelled; never an Analyst, Desk or Job Handler; once per cancellation", async () => {
        const res = await api(USERS.ADMIN, "POST", `/candidates/${pid(1)}/final-status`, { status: "CANCELLED" });
        assert.equal(res.status, 200);
        assert.deepEqual(Object.keys(await inbox()).sort(), [USERS.LEAD.adminId, USERS.OWNER.adminId].sort(), "not the Admin who cancelled");
        const [row] = await rowsOf(USERS.LEAD);
        assert.deepEqual([row.type, row.title, row.message], [NOTIFICATION_TYPE.E1, "Candidate Cancelled", "Ada Admin marked Given1 Surname as Cancelled."]);
        // The same status again changes nothing: no new notification.
        await api(USERS.ADMIN, "POST", `/candidates/${pid(1)}/final-status`, { status: "CANCELLED" });
        assert.equal(await prisma.notification.count(), 2);
        // Another final status is not E1.
        await api(USERS.ADMIN, "POST", `/candidates/${pid(2)}/final-status`, { status: "REJECTED" });
        assert.equal(await prisma.notification.count(), 2);
        // Cancelled by the Owner: the Admin and the Team Lead get it, the Owner does not.
        assert.equal((await api(USERS.OWNER, "POST", `/candidates/${pid(3)}/final-status`, { status: "CANCELLED" })).status, 200);
        const third = await prisma.notification.findMany({ where: { message: { contains: "Given3" } } });
        assert.deepEqual(third.map((r) => r.recipientId).sort(), [USERS.ADMIN.adminId, USERS.LEAD.adminId].sort());
        assert.equal(third[0].message, "Olive Owner marked Given3 Surname as Cancelled.");
    });

    test("E2: a call added with Need Attention and a call flagged later; once per follow-up", async () => {
        const added = await api(USERS.ANN, "POST", `/candidates/${pid(1)}/call-logs`, { note: "call back", needsAttention: true }).catch(() => null);
        // The Analyst may only act on their own candidates.
        assert.equal(added.status, 404);
        await prisma.candidateAllocation.create({ data: { passportId: pid(1), analystId: USERS.ANN.adminId } });
        const ok = await api(USERS.ANN, "POST", `/candidates/${pid(1)}/call-logs`, { note: "call back", needsAttention: true });
        assert.equal(ok.status, 201);
        assert.deepEqual(Object.keys(await inbox()).sort(), ADMIN_TEAM_IDS, "not the Analyst who flagged it");
        const [row] = await rowsOf(USERS.OWNER);
        assert.deepEqual([row.type, row.title, row.message], [NOTIFICATION_TYPE.E2, "Candidate Moved to Need Attention", "Given1 Surname has been moved to the Need Attention tab."]);

        const plain = await api(USERS.ADMIN, "POST", `/candidates/${pid(2)}/call-logs`, { note: "no flag" });
        assert.equal(plain.status, 201);
        assert.equal(await prisma.notification.count(), 3, "a call without Need Attention notifies nobody");
        const callLogId = (await prisma.candidateCallLog.findFirst({ where: { passportId: pid(2) } })).callLogId;
        const flagged = await api(USERS.ADMIN, "POST", `/candidates/${pid(2)}/call-logs/${callLogId}/follow-up`);
        assert.equal(flagged.status, 201);
        assert.equal(await prisma.notification.count(), 5);
        const second = await prisma.notification.findMany({ where: { message: { contains: "Given2" } } });
        assert.deepEqual(second.map((r) => r.recipientId).sort(), [USERS.LEAD.adminId, USERS.OWNER.adminId].sort(), "not the Admin who flagged it");

        // A Team Lead adding a call with Need Attention: the Admin and the Owner get it, the Team Lead does not.
        assert.equal((await api(USERS.LEAD, "POST", `/candidates/${pid(3)}/call-logs`, { note: "check", needsAttention: true })).status, 201);
        const third = await prisma.notification.findMany({ where: { message: { contains: "Given3" } } });
        assert.deepEqual(third.map((r) => r.recipientId).sort(), [USERS.ADMIN.adminId, USERS.OWNER.adminId].sort());
    });
});

describe("E9 / F1 Google Sheet Sync: one event, split by exact role", () => {
    test("ADMIN and TEAM_LEAD get E9 only, OWNER gets F1 only; nobody else; the same event twice adds nothing", async () => {
        await notifySheetSyncFailed(prisma, { eventKey: "run:test-1" });
        await notifySheetSyncFailed(prisma, { eventKey: "run:test-1" });
        assert.deepEqual(await inbox(), {
            [USERS.ADMIN.adminId]: [NOTIFICATION_TYPE.E9],
            [USERS.LEAD.adminId]: [NOTIFICATION_TYPE.E9],
            [USERS.OWNER.adminId]: [NOTIFICATION_TYPE.F1],
        });
        const [e9] = await rowsOf(USERS.ADMIN);
        const [f1] = await rowsOf(USERS.OWNER);
        assert.deepEqual([e9.title, e9.message], ["Google Sheet Sync Failed", "Google Sheet Sync has failed. Please check the connection and synchronization status."]);
        assert.deepEqual([f1.title, f1.message], ["Google Sheet Sync Error", "Google Sheet Sync has encountered an error. Please check the synchronization status."]);
    });

    test("the store: a run that ends FAILED notifies once; a SUCCEEDED run does not; an abandoned run does", async () => {
        const store = createSheetSyncStore({ db: prisma });
        const now = new Date();
        const { run } = await store.requestRun({ kind: RUN_KIND.RECONCILE, triggerSource: RUN_TRIGGER.ADMIN, now });
        const claimed = await store.claimRun({ owner: "w1", now, leaseMs: 60_000, maxAttempts: 3 });
        assert.equal(claimed.runId, run.runId);
        assert.equal(await store.finishRun(claimed, { status: RUN_STATUS.FAILED, errorClass: "NETWORK", now }), true);
        assert.equal(await store.finishRun(claimed, { status: RUN_STATUS.FAILED, errorClass: "NETWORK", now }), false, "a lost claim changes nothing");
        assert.equal(await prisma.notification.count(), 3);

        const ok = await store.requestRun({ kind: RUN_KIND.TEST_CONNECTION, triggerSource: RUN_TRIGGER.ADMIN, now });
        const claimedOk = await store.claimRun({ owner: "w1", now, leaseMs: 60_000, maxAttempts: 3 });
        assert.equal(claimedOk.runId, ok.run.runId);
        await store.finishRun(claimedOk, { status: RUN_STATUS.SUCCEEDED, now });
        assert.equal(await prisma.notification.count(), 3);

        await store.requestRun({ kind: RUN_KIND.RECONCILE, triggerSource: RUN_TRIGGER.SCHEDULER, now });
        assert.equal(await store.claimRun({ owner: "w1", now, leaseMs: 60_000, maxAttempts: 0 }), null, "abandoned");
        assert.equal(await prisma.notification.count(), 6);
    });
});

describe("owner-only and job-handler notifications", () => {
    test("F2 System Alert: Owners only (not an Admin or Team Lead); one per issue per business day", async () => {
        const now = new Date("2026-11-23T05:00:00Z");
        await notifySystemAlert(prisma, { issue: "DATABASE_ERROR", now });
        resetSystemAlertMemory(); // the database's dedupe, not only the process memory
        await notifySystemAlert(prisma, { issue: "DATABASE_ERROR", now: new Date("2026-11-23T15:00:00Z") });
        assert.deepEqual(await inbox(), { [USERS.OWNER.adminId]: [NOTIFICATION_TYPE.F2] });
        const [row] = await rowsOf(USERS.OWNER);
        assert.deepEqual([row.title, row.message], ["System Alert", "System alert: Database error. Please check the system status."]);
        assert.equal(row.dedupeKey, systemAlertDedupeKey("DATABASE_ERROR", now));
        assert.equal(row.dedupeKey, "F2:DATABASE_ERROR:2026-11-23");
        // The next business day in Colombo (UTC+5:30): a new alert.
        resetSystemAlertMemory();
        await notifySystemAlert(prisma, { issue: "DATABASE_ERROR", now: new Date("2026-11-23T19:00:00Z") });
        assert.equal((await rowsOf(USERS.OWNER)).length, 2);
        assert.deepEqual((await notifySystemAlert(prisma, { issue: "NOT_AN_ISSUE" })), { created: 0 });
    });

    test("F2 from the API error handler: a 500 reports, a 400 does not; a throwing reporter never changes the answer", async () => {
        const seen = [];
        const handler = createErrorHandler({ onServerError: (error) => { seen.push(error.code ?? "none"); throw new Error("reporter failed"); } });
        const app = express();
        app.use(express.json());
        app.get("/boom", () => { const e = new Error("secret"); e.code = "P2024"; throw e; });
        app.post("/body", (req, res) => res.json({}));
        app.use(handler);
        const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
        const original = console.error;
        console.error = () => {};
        try {
            const base = `http://127.0.0.1:${server.address().port}`;
            const boom = await fetch(`${base}/boom`);
            assert.equal(boom.status, 500);
            assert.deepEqual(await boom.json(), { message: "Internal server error" });
            const bad = await fetch(`${base}/body`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
            assert.equal(bad.status, 400);
        } finally {
            console.error = original;
            server.close();
        }
        assert.deepEqual(seen, ["P2024"]);

        // The real reporter: fire-and-forget, a Prisma error is a database error.
        createSystemAlertReporter({ getDb: () => prisma })(Object.assign(new Error("x"), { code: "P1001" }));
        for (let i = 0; i < 50 && !(await prisma.notification.count()); i++) await new Promise((r) => setTimeout(r, 20));
        const [row] = await rowsOf(USERS.OWNER);
        assert.equal(row.message, "System alert: Database error. Please check the system status.");
    });

    test("C1 New Job Added: Job Handlers only, only while an eligible candidate is on no job", async () => {
        await notifyNewJobs(prisma, [{ jobId: "00000000-0000-4000-8000-000000000001", jobCode: "JOB-2026-0001" }]);
        assert.equal(await prisma.notification.count(), 0, "no candidate passed the test");
        await prisma.candidateStage.create({ data: { passportId: pid(1), stage: "TEST_DETAILS", testResult: "FAIL" } });
        await notifyNewJobs(prisma, [{ jobId: "00000000-0000-4000-8000-000000000001", jobCode: "JOB-2026-0001" }]);
        assert.equal(await prisma.notification.count(), 0, "a FAIL is not eligible");
        await prisma.candidateStage.create({ data: { passportId: pid(2), stage: "TEST_DETAILS", testResult: "PASS" } });
        await notifyNewJobs(prisma, [{ jobId: "00000000-0000-4000-8000-000000000001", jobCode: "JOB-2026-0001" }]);
        await notifyNewJobs(prisma, [{ jobId: "00000000-0000-4000-8000-000000000001", jobCode: "JOB-2026-0001" }]);
        assert.deepEqual(await inbox(), { [USERS.JOBS.adminId]: [NOTIFICATION_TYPE.C1] });
        const [row] = await rowsOf(USERS.JOBS);
        assert.deepEqual([row.title, row.message], ["New Job Added", "A new job has been added. Job ID: JOB-2026-0001. Please review the details."]);
    });

    test("C2 Missing Country Information: Job Handlers only, once per Agent", async () => {
        await notifyAgentsMissingCountry(prisma, [{ agentId: "a-1", name: "Sunrise Agency" }]);
        await notifyAgentsMissingCountry(prisma, [{ agentId: "a-1", name: "Sunrise Agency" }]);
        assert.deepEqual(await inbox(), { [USERS.JOBS.adminId]: [NOTIFICATION_TYPE.C2] });
        assert.equal((await rowsOf(USERS.JOBS))[0].message, "Country information is missing for Sunrise Agency. Please update the details.");
    });
});

describe("B2 Role Updated", () => {
    test("the Registration Desk user whose role was changed, with the new role's label; nobody else", async () => {
        await updateUserRole({ db: prisma, actor: USERS.ADMIN, userId: USERS.DESK.adminId, role: "ANALYST" });
        assert.deepEqual(await inbox(), { [USERS.DESK.adminId]: [NOTIFICATION_TYPE.B2] });
        const [row] = await rowsOf(USERS.DESK);
        assert.deepEqual([row.title, row.message], ["Role Updated", "Your role has been changed to Analyst."]);
        // A change not involving Registration Desk: nothing.
        await updateUserRole({ db: prisma, actor: USERS.ADMIN, userId: USERS.BEN.adminId, role: "JOB_HANDLER" });
        assert.equal(await prisma.notification.count(), 1);
        await prisma.user.update({ where: { adminId: USERS.BEN.adminId }, data: { role: "ANALYST" } });
        // Becoming Registration Desk.
        await updateUserRole({ db: prisma, actor: USERS.ADMIN, userId: USERS.ANN.adminId, role: "REGISTRATION_DESK" });
        assert.equal((await rowsOf(USERS.ANN))[0].message, "Your role has been changed to Registration Desk.");
    });

    test("the same role is no change; an INACTIVE account gets nothing", async () => {
        assert.deepEqual(await notifyRoleUpdated(prisma, { userId: USERS.DESK.adminId, previousRole: "REGISTRATION_DESK", newRole: "REGISTRATION_DESK" }), { created: 0 });
        assert.deepEqual(await notifyRoleUpdated(prisma, { userId: USERS.GONE.adminId, previousRole: "REGISTRATION_DESK", newRole: "ADMIN" }), { created: 0 });
    });
});

describe("E10 Candidate Form Link Failed", () => {
    test("a system problem (form not configured) notifies the Admin tier and Team Leads, at most once an hour; the answer is unchanged", async () => {
        const first = await api(USERS.ADMIN, "POST", `/candidates/${pid(1)}/form-share`);
        assert.equal(first.status, 503);
        assert.equal(first.body.code, "FORM_NOT_CONFIGURED");
        await api(USERS.LEAD, "POST", `/candidates/${pid(2)}/form-share`);
        assert.deepEqual(Object.keys(await inbox()).sort(), ADMIN_TEAM_IDS);
        assert.equal(await prisma.notification.count(), 3, "throttled to one an hour");
        const [row] = await rowsOf(USERS.ADMIN);
        assert.deepEqual([row.type, row.title, row.message], [NOTIFICATION_TYPE.E10, "Candidate Form Link Failed", "A Candidate Form link could not be generated. Please check the issue."]);
    });

    test("a refusal (already submitted, unknown candidate) is not a system problem", async () => {
        await pg.exec(`INSERT INTO "candidate_form_access" ("passport_id", "status", "submitted_at") VALUES ('${pid(1)}', 'SUBMITTED', now())`);
        const options = { candidateFormOrigin: "https://form.example.com" };
        assert.equal((await api(USERS.ADMIN, "POST", `/candidates/${pid(1)}/form-share`, undefined, options)).status, 409);
        assert.equal((await api(USERS.ADMIN, "POST", "/candidates/NOPE123/form-share", undefined, options)).status, 404);
        assert.equal(await prisma.notification.count(), 0);
        assert.equal(isFormLinkSystemError({ status: 409 }), false);
        assert.equal(isFormLinkSystemError({ status: 503 }), true);
        assert.equal(isFormLinkSystemError(new Error("unexpected")), true);
    });
});

describe("the API: the caller's own notifications only", () => {
    const seed = async () => {
        await notifySheetSyncFailed(prisma, { eventKey: "run:a" }); // ADMIN, LEAD: E9; OWNER: F1
        await notify(prisma, { type: "A1_NEW_CANDIDATES_ALLOCATED", title: "New Candidates Allocated", message: allocationMessage(3), dedupeKey: "A1:x", userIds: [USERS.ANN.adminId] });
    };

    test("list, unread count, mark read (idempotent); another user's row is 404 and stays unread", async () => {
        await seed();
        const list = await api(USERS.ADMIN, "GET", "/notifications");
        assert.equal(list.status, 200);
        assert.equal(list.body.items.length, 1);
        assert.deepEqual(Object.keys(list.body.items[0]).sort(), ["createdAt", "id", "message", "readAt", "title", "type"]);
        assert.equal(list.body.items[0].type, NOTIFICATION_TYPE.E9);
        assert.equal(list.body.unreadCount, 1);
        assert.equal(list.body.nextCursor, null);
        assert.deepEqual((await api(USERS.ADMIN, "GET", "/notifications/unread-count")).body, { unreadCount: 1 });

        // Every role can read its own.
        for (const who of [USERS.DESK, USERS.JOBS]) assert.deepEqual((await api(who, "GET", "/notifications")).body, { items: [], unreadCount: 0, nextCursor: null });
        const annList = await api(USERS.ANN, "GET", "/notifications");
        assert.equal(annList.body.items[0].message, "You have received 3 new candidates.");

        const annId = annList.body.items[0].id;
        const stolen = await api(USERS.ADMIN, "POST", `/notifications/${annId}/read`);
        assert.equal(stolen.status, 404);
        assert.equal(stolen.body.code, "NOTIFICATION_NOT_FOUND");
        assert.equal((await prisma.notification.findUnique({ where: { id: annId } })).readAt, null, "not marked");
        assert.equal((await api(USERS.ADMIN, "POST", "/notifications/not-a-uuid/read")).status, 404);
        assert.equal((await api(USERS.ADMIN, "POST", "/notifications/00000000-0000-4000-8000-000000000000/read")).status, 404);

        const adminId = list.body.items[0].id;
        const first = await api(USERS.ADMIN, "POST", `/notifications/${adminId}/read`);
        assert.equal(first.status, 200);
        assert.equal(first.body.id, adminId);
        assert.equal(first.body.unreadCount, 0);
        assert.ok(first.body.readAt);
        const again = await api(USERS.ADMIN, "POST", `/notifications/${adminId}/read`);
        assert.equal(again.body.readAt, first.body.readAt, "idempotent: the first time is kept");

        // The same event's row of the Team Lead is still unread: read state is per user.
        assert.deepEqual((await api(USERS.LEAD, "GET", "/notifications/unread-count")).body, { unreadCount: 1 });
        assert.deepEqual((await api(USERS.OWNER, "GET", "/notifications/unread-count")).body, { unreadCount: 1 });
    });

    test("pages newest first with nextCursor; a cursor of another user or a bad limit is 400", async () => {
        for (let i = 1; i <= 5; i++) {
            await notify(prisma, { type: "E2_CANDIDATE_NEED_ATTENTION", title: "t", message: `m${i}`, dedupeKey: `E2:${i}`, roles: ["ADMIN"] });
        }
        const seen = [];
        let cursor = null;
        for (let page = 0; page < 5; page++) {
            const res = await api(USERS.ADMIN, "GET", `/notifications?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
            assert.equal(res.status, 200);
            seen.push(...res.body.items.map((item) => item.message));
            cursor = res.body.nextCursor;
            if (!cursor) break;
        }
        assert.deepEqual(seen, ["m5", "m4", "m3", "m2", "m1"]);

        await seed();
        const ownerRow = (await rowsOf(USERS.OWNER))[0];
        assert.equal((await api(USERS.ADMIN, "GET", `/notifications?cursor=${ownerRow.id}`)).status, 400);
        for (const q of ["limit=0", "limit=101", "limit=abc", "cursor=zzz"]) assert.equal((await api(USERS.ADMIN, "GET", `/notifications?${q}`)).status, 400, q);
        assert.deepEqual(parseNotificationListQuery({}), { params: { limit: 30, cursor: null } });
    });

    test("an INACTIVE recipient's account receives nothing; the dedupe key makes a repeated event idempotent", async () => {
        const spec = { type: "E1_CANDIDATE_CANCELLED", title: "Candidate Cancelled", message: "x", dedupeKey: "E1:same", roles: AUDIENCE.ADMIN_TEAM };
        assert.equal((await notify(prisma, spec)).created, 3);
        assert.equal((await notify(prisma, spec)).created, 0);
        assert.equal(await prisma.notification.count({ where: { recipientId: USERS.GONE.adminId } }), 0);
    });
});

describe("notify never throws and never breaks a transaction", () => {
    test("a database client whose insert throws: { failed: true }, logged without text", async () => {
        const broken = { user: prisma.user, notification: { createMany: async () => { throw Object.assign(new Error("boom"), { name: "PrismaClientKnownRequestError", code: "P2003" }); } } };
        const logged = [];
        const original = console.error;
        console.error = (line) => logged.push(String(line));
        try {
            assert.deepEqual(await notifyAll(broken, [{ type: "F2_SYSTEM_ALERT", title: "System Alert", message: "secret text", dedupeKey: "k", roles: ["OWNER"] }]), { created: 0, failed: true });
        } finally {
            console.error = original;
        }
        assert.equal(logged.length, 1);
        assert.deepEqual(JSON.parse(logged[0]), { event: "notification.write_failed", types: ["F2_SYSTEM_ALERT"], errorClass: "PrismaClientKnownRequestError", prismaCode: "P2003" });
        assert.deepEqual(await notifyAll({}, [{ type: "x", dedupeKey: "y", roles: ["OWNER"] }]), { created: 0 }, "a client without the table (test fakes) is skipped");
        assert.deepEqual(await notifyAll(prisma, []), { created: 0 });
    });

    test("inside a transaction, a failed insert is rolled back to a savepoint: the outer transaction still commits", async () => {
        await breakNotificationInserts();
        const original = console.error;
        console.error = () => {};
        try {
            await prisma.$transaction(async (tx) => {
                await tx.candidateAllocation.create({ data: { passportId: pid(1), analystId: USERS.ANN.adminId } });
                const result = await notify(tx, { type: "A1_NEW_CANDIDATES_ALLOCATED", title: "t", message: "m", dedupeKey: "A1:tx", userIds: [USERS.ANN.adminId] });
                assert.equal(result.failed, true);
                await tx.candidateAllocation.create({ data: { passportId: pid(2), analystId: USERS.ANN.adminId } });
            });
        } finally {
            console.error = original;
        }
        assert.equal(await prisma.candidateAllocation.count(), 2);
        assert.equal(await prisma.notification.count(), 0);
    });
});
