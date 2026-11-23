// Scheduled notifications (notificationScanService.js runNotificationScan, POST /api/tasks/notification-scan).
// On a REAL PostgreSQL (PGlite, every migration applied) through the real Prisma client, with `now`
// injected. A stand-in auth.users table (Supabase's, absent on PGlite) carries the password-change
// times of A3 / C3 / D4.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { createTaskRouter, notificationScanSchedulerVerifier } from "../src/routes/tasks.js";
import { MESSAGES, isReviewMilestone, runNotificationScan, SCAN_RULES } from "../src/services/notificationScanService.js";
import { NOTIFICATION_TYPE, resetSystemAlertMemory } from "../src/services/notificationEvents.js";
import { getDailySummary, getDailySummaryCounts } from "../src/services/dailyReportService.js";
import { addBusinessDays, businessTimeOn } from "../src/utils/businessDay.js";

const quiet = { log() {}, warn() {}, error() {} };
const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;

const user = (adminId, role, name, n, status = "ACTIVE") => ({
    adminId, role, name, status, email: `${adminId}@example.invalid`,
    authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    activatedAt: new Date("2026-01-01T00:00:00Z"), createdDate: new Date("2026-01-01T00:00:00Z"),
});
const USERS = {
    OWNER: user("u-owner", "OWNER", "Olive Owner", 1),
    ADMIN: user("u-admin", "ADMIN", "Ada Admin", 2),
    LEAD: user("u-lead", "TEAM_LEAD", "Tia Lead", 3),
    ANN: user("u-ann", "ANALYST", "Ann Analyst", 4),
    BEN: user("u-ben", "ANALYST", "Ben Analyst", 5),
    DESK: user("u-desk", "REGISTRATION_DESK", "Dee Desk", 6),
    DESK2: user("u-desk2", "REGISTRATION_DESK", "Dan Desk", 7),
    JOBS: user("u-jobs", "JOB_HANDLER", "Jo Handler", 8),
    GONE: user("u-gone", "ADMIN", "Gus Gone", 9, "INACTIVE"),
};
const ADMIN_AUDIENCE_IDS = [USERS.ADMIN.adminId, USERS.LEAD.adminId, USERS.OWNER.adminId].sort();

// Monday 23 November 2026 (Asia/Colombo).
const MON = "2026-11-23";
const at = (ymd, hhmm) => businessTimeOn(ymd, hhmm);
const day = (n) => addBusinessDays(MON, n);
const minus = (date, ms) => new Date(date.getTime() - ms);

let database;
let prisma;
let pg;
let agentId;
let clientId;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    await pg.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users ("id" uuid PRIMARY KEY, "updated_at" timestamptz);`);
    for (const u of Object.values(USERS)) await prisma.user.create({ data: u });
    const agent = await prisma.agent.create({ data: { name: "Agent One", countryCode: "RO" } });
    const client = await prisma.client.create({ data: { name: "Client One", agentLinks: { create: { agentId: agent.id } } } });
    agentId = agent.id;
    clientId = client.id;
});
after(async () => database?.close());

beforeEach(async () => {
    resetSystemAlertMemory();
    await pg.exec(`
        DELETE FROM "notification";
        DELETE FROM "call_log_follow_up"; DELETE FROM "candidate_call_logs"; DELETE FROM "candidate_allocation";
        DELETE FROM "job_candidate"; DELETE FROM "job";
        DELETE FROM "documents"; DELETE FROM "temporary_data";
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "candidate_stages"; DELETE FROM "candidate"; DELETE FROM "candidate_import";
        DELETE FROM "user" WHERE "admin_id" = 'u-new';
        UPDATE "sheet_sync_state" SET "configured" = NULL, "worker_heartbeat_at" = NULL;
        DELETE FROM auth.users;
    `);
    for (const u of Object.values(USERS)) {
        await prisma.user.update({ where: { adminId: u.adminId }, data: { role: u.role, status: u.status, activatedAt: u.activatedAt } });
    }
    // Every password changed recently (no reminder is due unless a test says so).
    await setPasswordChanged(Object.values(USERS), new Date("2026-11-10T00:00:00Z"));
});

async function setPasswordChanged(users, when) {
    for (const u of users) {
        await pg.query(`INSERT INTO auth.users ("id", "updated_at") VALUES ($1, $2) ON CONFLICT ("id") DO UPDATE SET "updated_at" = EXCLUDED."updated_at"`, [u.authUserId, when ? when.toISOString() : null]);
    }
}

let seq = 0;
const nextId = () => `P${String(++seq).padStart(7, "0")}`;
async function candidate({ createdDate = new Date("2026-01-01T00:00:00Z"), departedAt = null } = {}) {
    const passportId = nextId();
    await prisma.candidate.create({ data: { passportId, uniqueId: passportId.slice(1), firstName: "Given", otherName: "Surname", createdDate, departedAt } });
    return passportId;
}
const allocate = (passportId, analystId) => prisma.candidateAllocation.create({ data: { passportId, analystId } });
async function callLog(passportId, adminId, createdDate) {
    const callLogId = randomUUID();
    await prisma.candidateCallLog.create({ data: { callLogId, passportId, adminId, note: "n", createdDate } });
    return callLogId;
}
async function followUp(passportId, flaggedDate, { status = "OPEN", by = USERS.ADMIN.adminId } = {}) {
    const callLogId = await callLog(passportId, by, minus(flaggedDate, HOUR));
    const followUpId = randomUUID();
    await prisma.callLogFollowUp.create({
        data: { followUpId, callLogId, status, flaggedById: by, flaggedDate, ...(status === "COMPLETED" ? { completedById: by, completedDate: flaggedDate } : {}) },
    });
    return followUpId;
}
const audit = (adminId, action, passportId, createdDate) => prisma.auditLog.create({
    data: { auditId: randomUUID(), adminId, action, passportId, previousStatus: "NONE", newStatus: "DONE", createdDate },
});
let jobSeq = 0;
async function job({ vacancies = 3, status = "PROCESSING", createdAt = new Date("2026-01-01T00:00:00Z") } = {}) {
    const jobCode = `JOB-2026-${String(++jobSeq).padStart(6, "0")}`;
    const row = await prisma.job.create({ data: { jobCode, clientId, responsibleAgentId: agentId, countryCode: "RO", vacancies, status, createdById: USERS.ADMIN.adminId, createdAt, ...(status === "COMPLETED" ? { completedAt: createdAt } : {}) } });
    return row;
}
const passTest = (passportId) => prisma.candidateStage.create({ data: { passportId, stage: "TEST_DETAILS", testResult: "PASS" } });
async function document(passportId, createdDate, verificationStatus = "REVIEW_REQUIRED") {
    const documentId = randomUUID();
    await prisma.document.create({
        data: {
            documentId, passportId, documentType: "MEDICAL", originalFilename: "a.pdf", storedFilename: `${documentId}.pdf`, storagePath: `x/${documentId}.pdf`,
            receivedDate: createdDate, processingStatus: "STORED", verificationStatus, createdDate,
        },
    });
    return documentId;
}

const scan = (now, options = {}) => runNotificationScan(prisma, { now, log: quiet, ...options });
const rowsOf = (type) => prisma.notification.findMany({ where: { type }, orderBy: [{ recipientId: "asc" }, { createdAt: "asc" }] });
const recipientsOf = async (type) => [...new Set((await rowsOf(type)).map((row) => row.recipientId))].sort();
const total = () => prisma.notification.count();

// ---------------------------------------------------------------- the clock

describe("scheduling (Asia/Colombo due times, dedupe keys only)", () => {
    test("before a rule's due time nothing of it is sent", async () => {
        const p = await candidate({ createdDate: at(MON, "09:00") });
        await followUp(p, minus(at(MON, "09:00"), 3 * DAY));
        await allocate(p, USERS.ANN.adminId);
        const early = await scan(at(MON, "05:59"));
        assert.equal(await total(), 0);
        assert.ok(early.rules.every((rule) => rule.status === "NOT_DUE"));
        await scan(at(MON, "17:59"));
        const types = new Set((await prisma.notification.findMany()).map((row) => row.type));
        for (const type of types) assert.ok([NOTIFICATION_TYPE.F2, NOTIFICATION_TYPE.D2].includes(type), `${type} is not due before 18:00`);
        assert.ok(types.has(NOTIFICATION_TYPE.D2), "D2 is due at 16:00");
        await scan(at(MON, "18:00"));
        assert.equal((await rowsOf(NOTIFICATION_TYPE.E3)).length, 3, "due at 18:00 exactly");
    });

    test("running twice, overlapping, and after a restart adds nothing", async () => {
        const p = await candidate({ createdDate: at(MON, "09:00") });
        await allocate(p, USERS.ANN.adminId);
        await followUp(p, minus(at(MON, "09:00"), 3 * DAY));
        await scan(at(MON, "18:00"));
        const first = await total();
        assert.ok(first > 0);
        await Promise.all([scan(at(MON, "18:15")), scan(at(MON, "18:15"))]);
        resetSystemAlertMemory(); // a new process
        await scan(at(MON, "23:45"));
        assert.equal(await total(), first);
    });

    test("a missed 18:00 run is made up later the same day, but a previous day is never backfilled", async () => {
        await candidate({ createdDate: at(day(-1), "10:00") });
        await candidate({ createdDate: at(MON, "10:00") });
        await scan(at(MON, "21:30"));
        const rows = await rowsOf(NOTIFICATION_TYPE.E3);
        assert.equal(rows.length, 3);
        assert.ok(rows.every((row) => row.dedupeKey === `E3:${MON}` && row.message === "1 new candidate has been added to the system today."));
    });

    test("one failing rule does not stop the others", async () => {
        await candidate({ createdDate: at(MON, "10:00") });
        const failing = { code: "BROKEN", due: "00:00", run: async () => { throw Object.assign(new Error("boom"), { code: "P2010" }); } };
        const e3 = SCAN_RULES.find((rule) => rule.code === "E3");
        const result = await scan(at(MON, "18:00"), { rules: [failing, e3] });
        assert.deepEqual(result.rules.map((rule) => [rule.rule, rule.status]), [["BROKEN", "FAILED"], ["E3", "DONE"]]);
        assert.equal((await rowsOf(NOTIFICATION_TYPE.E3)).length, 3);
    });

    test("an unreachable database: nothing thrown, only logged", async () => {
        const logged = [];
        const down = { $queryRaw: async () => { throw Object.assign(new Error("down"), { name: "PrismaClientInitializationError" }); } };
        const result = await runNotificationScan(down, { now: at(MON, "18:00"), log: { ...quiet, error: (line) => logged.push(line) } });
        assert.equal(result.databaseReachable, false);
        assert.match(logged[0], /notification_scan\.database_unreachable/);
    });
});

// ---------------------------------------------------------------- Analysts

describe("A2 Pending Follow-ups", () => {
    test("each Analyst gets only their own count; singular and plural; carried over daily; stops at 0", async () => {
        const [a1, a2, b1, free] = [await candidate(), await candidate(), await candidate(), await candidate()];
        await allocate(a1, USERS.ANN.adminId);
        await allocate(a2, USERS.ANN.adminId);
        await allocate(b1, USERS.BEN.adminId);
        const t = at(day(-1), "10:00");
        const annOpen = [await followUp(a1, t), await followUp(a2, t)];
        await followUp(a1, t, { status: "COMPLETED" });
        await followUp(b1, t);
        await followUp(free, t); // unallocated: nobody's

        await scan(at(MON, "18:00"));
        await scan(at(MON, "18:30"));
        const rows = await rowsOf(NOTIFICATION_TYPE.A2);
        assert.deepEqual(rows.map((r) => [r.recipientId, r.title, r.message]), [
            [USERS.ANN.adminId, "Pending Follow-ups", "You have 2 pending follow-ups in Need Attention. Please review them."],
            [USERS.BEN.adminId, "Pending Follow-ups", "You have 1 pending follow-up in Need Attention. Please review it."],
        ]);

        await scan(at(day(1), "18:00"));
        assert.equal((await rowsOf(NOTIFICATION_TYPE.A2)).length, 4, "carried over the next day");

        await prisma.callLogFollowUp.updateMany({ where: { followUpId: { in: annOpen } }, data: { status: "COMPLETED", completedById: USERS.ANN.adminId, completedDate: at(day(1), "19:00") } });
        await scan(at(day(2), "18:00"));
        const day2 = (await rowsOf(NOTIFICATION_TYPE.A2)).filter((r) => r.dedupeKey.endsWith(day(2)));
        assert.deepEqual(day2.map((r) => r.recipientId), [USERS.BEN.adminId], "Ann has none left");
    });

    test("an Analyst promoted to Team Lead no longer receives it", async () => {
        const a = await candidate();
        await allocate(a, USERS.ANN.adminId);
        await followUp(a, at(day(-1), "10:00"));
        await prisma.user.update({ where: { adminId: USERS.ANN.adminId }, data: { role: "TEAM_LEAD" } });
        await scan(at(MON, "18:00"));
        assert.equal((await rowsOf(NOTIFICATION_TYPE.A2)).length, 0);
    });
});

describe("A3 / C3 / D4 Password Change Reminder", () => {
    test("Analysts after 3 months, Job Handlers after 2, Team Leads after 30 days; nobody else; once per change", async () => {
        await setPasswordChanged([USERS.ANN], new Date("2026-08-22T20:00:00Z")); // 23 Aug in Colombo: due 23 Nov
        await setPasswordChanged([USERS.BEN], new Date("2026-08-24T05:00:00Z")); // due 24 Nov
        await setPasswordChanged([USERS.JOBS], new Date("2026-09-23T05:00:00Z")); // due 23 Nov
        await setPasswordChanged([USERS.LEAD], new Date("2026-10-24T05:00:00Z")); // + 30 days = 23 Nov
        await setPasswordChanged([USERS.ADMIN, USERS.OWNER, USERS.DESK], new Date("2025-01-01T00:00:00Z"));

        await scan(at(MON, "18:00"));
        const text = (period) => `It has been ${period} since your last password change. Please update your password for security.`;
        assert.deepEqual((await rowsOf(NOTIFICATION_TYPE.A3)).map((r) => [r.recipientId, r.title, r.message]), [[USERS.ANN.adminId, "Password Change Reminder", text("3 months")]]);
        assert.deepEqual((await rowsOf(NOTIFICATION_TYPE.C3)).map((r) => [r.recipientId, r.message]), [[USERS.JOBS.adminId, text("2 months")]]);
        assert.deepEqual((await rowsOf(NOTIFICATION_TYPE.D4)).map((r) => [r.recipientId, r.message]), [[USERS.LEAD.adminId, text("30 days")]]);

        await scan(at(day(1), "18:00"));
        await scan(at(day(5), "18:00"));
        assert.deepEqual(await recipientsOf(NOTIFICATION_TYPE.A3), [USERS.ANN.adminId, USERS.BEN.adminId].sort(), "Ben on his day; Ann not again");
        assert.equal((await rowsOf(NOTIFICATION_TYPE.A3)).length, 2);
        assert.equal((await rowsOf(NOTIFICATION_TYPE.C3)).length, 1);
        assert.equal((await rowsOf(NOTIFICATION_TYPE.D4)).length, 1);

        // A new password re-arms it only once its own period has passed.
        await setPasswordChanged([USERS.ANN], at(day(6), "09:00"));
        await scan(at(day(7), "18:00"));
        assert.equal((await rowsOf(NOTIFICATION_TYPE.A3)).length, 2);
        await scan(at("2027-02-27", "18:00"));
        assert.equal((await rowsOf(NOTIFICATION_TYPE.A3)).filter((r) => r.recipientId === USERS.ANN.adminId).length, 1);
        await scan(at("2027-02-28", "18:00"));
        assert.equal((await rowsOf(NOTIFICATION_TYPE.A3)).filter((r) => r.recipientId === USERS.ANN.adminId).length, 2, "29 Nov + 3 months: 28 Feb (2027 has no 29 Feb)");
    });

    test("no auth row (or no time): the account's activation time", async () => {
        await pg.query(`DELETE FROM auth.users WHERE "id" = $1`, [USERS.ANN.authUserId]);
        await setPasswordChanged([USERS.BEN], null);
        await scan(at(MON, "18:00"));
        assert.deepEqual(await recipientsOf(NOTIFICATION_TYPE.A3), [USERS.ANN.adminId, USERS.BEN.adminId].sort());
    });

    test("no auth schema (not Supabase): skipped silently", async () => {
        await pg.exec(`ALTER SCHEMA auth RENAME TO auth_hidden`);
        try {
            const result = await scan(at(MON, "18:00"));
            assert.equal(result.rules.find((r) => r.rule === "A3").status, "SKIPPED");
            assert.equal((await rowsOf(NOTIFICATION_TYPE.A3)).length + (await rowsOf(NOTIFICATION_TYPE.C3)).length + (await rowsOf(NOTIFICATION_TYPE.D4)).length, 0);
        } finally {
            await pg.exec(`ALTER SCHEMA auth_hidden RENAME TO auth`);
        }
    });
});

// ---------------------------------------------------------------- Registration Desk

describe("B1 Monthly Registration Summary", () => {
    async function registered(adminId, when) {
        const p = await candidate({ createdDate: when });
        await audit(adminId, "CREATE_CANDIDATE", p, when);
        return p;
    }

    test("only on the last day of the month; each desk user their own count; singular; 0 skipped; once", async () => {
        await registered(USERS.DESK.adminId, at("2026-11-01", "00:30"));
        await registered(USERS.DESK.adminId, at("2026-11-30", "17:00"));
        await registered(USERS.DESK.adminId, at("2026-10-31", "23:30")); // last month
        await registered(USERS.DESK2.adminId, at("2026-11-15", "10:00"));
        await registered(USERS.ADMIN.adminId, at("2026-11-15", "10:00")); // not a desk user

        await scan(at("2026-11-29", "18:00"));
        assert.equal((await rowsOf(NOTIFICATION_TYPE.B1)).length, 0, "29 November is not the last day");
        await scan(at("2026-11-30", "18:00"));
        await scan(at("2026-11-30", "23:45"));
        assert.deepEqual((await rowsOf(NOTIFICATION_TYPE.B1)).map((r) => [r.recipientId, r.title, r.message, r.dedupeKey]), [
            [USERS.DESK.adminId, "Monthly Registration Summary", "You have registered 2 candidates this month.", `B1:${USERS.DESK.adminId}:2026-11`],
            [USERS.DESK2.adminId, "Monthly Registration Summary", "You have registered 1 candidate this month.", `B1:${USERS.DESK2.adminId}:2026-11`],
        ]);
    });

    test("February: the 28th in a common year, the 29th in a leap year", async () => {
        await registered(USERS.DESK.adminId, at("2027-02-10", "10:00"));
        await registered(USERS.DESK.adminId, at("2028-02-10", "10:00"));
        await scan(at("2027-02-28", "18:00"));
        assert.deepEqual((await rowsOf(NOTIFICATION_TYPE.B1)).map((r) => r.dedupeKey), [`B1:${USERS.DESK.adminId}:2027-02`]);
        await scan(at("2028-02-28", "18:00"));
        assert.equal((await rowsOf(NOTIFICATION_TYPE.B1)).length, 1, "28 Feb 2028 is not the last day");
        await scan(at("2028-02-29", "18:00"));
        assert.deepEqual((await rowsOf(NOTIFICATION_TYPE.B1)).map((r) => r.dedupeKey).sort(), [`B1:${USERS.DESK.adminId}:2027-02`, `B1:${USERS.DESK.adminId}:2028-02`]);
    });
});

// ---------------------------------------------------------------- Team Leads

describe("D1 Unallocated Candidates (Team Leads only)", () => {
    test("the Unallocated count; Admins and Owners get nothing; 0 skipped", async () => {
        await candidate();
        await allocate(await candidate(), USERS.ANN.adminId);
        await candidate({ departedAt: new Date("2026-05-01T00:00:00Z") }); // a completed placement
        await scan(at(MON, "18:00"));
        assert.deepEqual((await rowsOf(NOTIFICATION_TYPE.D1)).map((r) => [r.recipientId, r.title, r.message]), [
            [USERS.LEAD.adminId, "Unallocated Candidates", "You have 1 unallocated candidate waiting for assignment."],
        ]);
        await pg.exec(`DELETE FROM "candidate" WHERE "passport_id" NOT IN (SELECT "passport_id" FROM "candidate_allocation") AND "departed_at" IS NULL`);
        await scan(at(day(1), "18:00"));
        assert.equal((await rowsOf(NOTIFICATION_TYPE.D1)).length, 1);
    });

    test("plural", () => assert.equal(MESSAGES.D1(4), "You have 4 unallocated candidates waiting for assignment."));
});

describe("D2 Daily Report Updated (16:00, Team Leads only)", () => {
    test("only the Daily Report items above 0, with its labels", async () => {
        const p = await candidate({ createdDate: at(MON, "09:00") });
        await callLog(p, USERS.ANN.adminId, at(MON, "10:00"));
        await callLog(p, USERS.ANN.adminId, at(MON, "11:00"));
        await scan(at(MON, "16:00"));
        assert.deepEqual((await rowsOf(NOTIFICATION_TYPE.D2)).map((r) => [r.recipientId, r.title, r.message]), [
            [USERS.LEAD.adminId, "Daily Report Updated", "The daily report has been updated: Candidates registered: 1, Calls taken: 2. Please review the latest information."],
        ]);
        const counts = await getDailySummaryCounts({ db: prisma, date: MON });
        const full = await getDailySummary({ db: prisma, date: MON, now: at(MON, "16:00") });
        assert.deepEqual(counts, full.summary, "the same figures as the Daily Report Summary");
    });

    test("a day with nothing in the report sends nothing", async () => {
        await scan(at(MON, "16:00"));
        assert.equal((await rowsOf(NOTIFICATION_TYPE.D2)).length, 0);
    });
});

describe("D3 New Vacancies Available (Team Leads only)", () => {
    test("jobs with vacancies and no active candidate, with the free eligible candidates; once per job", async () => {
        const empty = await job({ vacancies: 5 });
        const staffed = await job({ vacancies: 5 });
        await job({ vacancies: 5, status: "COMPLETED" });
        await job({ vacancies: null }); // no vacancies recorded
        const free1 = await candidate();
        const free2 = await candidate();
        const busy = await candidate();
        await candidate(); // no test result: not eligible
        for (const p of [free1, free2, busy]) await passTest(p);
        await prisma.jobCandidate.create({ data: { jobId: staffed.id, passportId: busy, assignedBy: USERS.ADMIN.adminId, isActive: true } });

        await scan(at(MON, "18:00"));
        assert.deepEqual((await rowsOf(NOTIFICATION_TYPE.D3)).map((r) => [r.recipientId, r.title, r.message, r.dedupeKey]), [
            [USERS.LEAD.adminId, "New Vacancies Available", `5 new vacancies are available for Job ${empty.jobCode}. 2 free candidates are eligible to be added to this job.`, `D3:${empty.id}`],
        ]);
        await scan(at(day(1), "18:00"));
        assert.equal((await rowsOf(NOTIFICATION_TYPE.D3)).length, 1, "no daily repeat");
    });

    test("no free candidate: the first sentence only; singular", async () => {
        const one = await job({ vacancies: 1 });
        await scan(at(MON, "18:00"));
        assert.deepEqual((await rowsOf(NOTIFICATION_TYPE.D3)).map((r) => r.message), [`1 new vacancy is available for Job ${one.jobCode}.`]);
        assert.equal(MESSAGES.D3(2, "JOB-X", 1), "2 new vacancies are available for Job JOB-X. 1 free candidate is eligible to be added to this job.");
    });
});

// ---------------------------------------------------------------- Admin audience (Owners, Admins, Team Leads)

describe("E3 New Candidates Added", () => {
    test("one summary a day to Owners, Admins and Team Leads only", async () => {
        await candidate({ createdDate: at(MON, "00:10") });
        await candidate({ createdDate: at(MON, "17:00") });
        await candidate({ createdDate: at(day(-1), "23:50") });
        await scan(at(MON, "18:00"));
        const rows = await rowsOf(NOTIFICATION_TYPE.E3);
        assert.deepEqual(rows.map((r) => r.recipientId), ADMIN_AUDIENCE_IDS);
        assert.ok(rows.every((r) => r.title === "New Candidates Added" && r.message === "2 new candidates have been added to the system today."));
    });

    test("0 skipped", async () => {
        await scan(at(MON, "18:00"));
        assert.equal((await rowsOf(NOTIFICATION_TYPE.E3)).length, 0);
    });
});

describe("E4 Missing Documents or Information", () => {
    test("candidates that crossed 3 days without activity today, with missing details or documents", async () => {
        const crossing = await candidate({ createdDate: minus(at(MON, "16:00"), 3 * DAY) }); // crosses at 16:00 today
        const called = await candidate({ createdDate: minus(at(MON, "16:00"), 3 * DAY) });
        await callLog(called, USERS.ANN.adminId, at(day(-1), "10:00")); // activity: not yet 3 days
        await candidate({ createdDate: minus(at(MON, "16:00"), 10 * DAY) }); // crossed a week ago
        await candidate({ createdDate: minus(at(MON, "16:00"), 3 * DAY), departedAt: at(day(-1), "10:00") });

        await scan(at(MON, "18:00"));
        const rows = await rowsOf(NOTIFICATION_TYPE.E4);
        assert.deepEqual(rows.map((r) => r.recipientId), ADMIN_AUDIENCE_IDS);
        assert.equal(rows[0].title, "Missing Documents or Information");
        assert.equal(rows[0].message, "1 candidate has had missing documents or information for more than 3 days without follow-up. Please review them.");

        await scan(at(day(1), "18:00"));
        assert.equal((await rowsOf(NOTIFICATION_TYPE.E4)).length, 3, "not repeated the next day");
        assert.ok(crossing);
    });

    test("plural", () => assert.equal(MESSAGES.E4(3), "3 candidates have had missing documents or information for more than 3 days without follow-up. Please review them."));
});

describe("E5 Need Attention Follow-ups Pending", () => {
    test("48 hours without an update: every day while it lasts, the days counted; stops once updated", async () => {
        const p = await candidate();
        await followUp(p, minus(at(MON, "18:00"), 50 * HOUR));
        await followUp(await candidate(), minus(at(MON, "18:00"), 47 * HOUR)); // not yet

        await scan(at(MON, "18:00"));
        const rows = await rowsOf(NOTIFICATION_TYPE.E5);
        assert.deepEqual(rows.map((r) => r.recipientId), ADMIN_AUDIENCE_IDS);
        assert.equal(rows[0].title, "Need Attention Follow-ups Pending");
        assert.equal(rows[0].message, "1 Need Attention follow-up has not been updated for more than 2 days. Please review it.");

        await scan(at(day(1), "18:00"));
        const tue = (await rowsOf(NOTIFICATION_TYPE.E5)).filter((r) => r.dedupeKey === `E5:${day(1)}`);
        assert.equal(tue[0].message, "2 Need Attention follow-ups have not been updated for more than 3 days. Please review them.");

        await callLog(p, USERS.ANN.adminId, at(day(1), "19:00"));
        await scan(at(day(2), "18:00"));
        const wed = (await rowsOf(NOTIFICATION_TYPE.E5)).filter((r) => r.dedupeKey === `E5:${day(2)}`);
        assert.equal(wed[0].message, "1 Need Attention follow-up has not been updated for more than 3 days. Please review it.", "the updated one left (95 hours: 3 whole days)");
    });
});

describe("E6 Jobs Stuck in Processing", () => {
    test("jobs crossing 3 days in Processing, on the day they cross", async () => {
        await job({ createdAt: minus(at(MON, "17:00"), 3 * DAY) });
        await job({ createdAt: minus(at(MON, "12:00"), 3 * DAY) });
        await job({ createdAt: minus(at(MON, "17:00"), 6 * DAY) }); // crossed earlier
        await job({ createdAt: minus(at(MON, "17:00"), 3 * DAY), status: "COMPLETED" });
        await scan(at(MON, "18:00"));
        const rows = await rowsOf(NOTIFICATION_TYPE.E6);
        assert.deepEqual(rows.map((r) => r.recipientId), ADMIN_AUDIENCE_IDS);
        assert.equal(rows[0].title, "Jobs Stuck in Processing");
        assert.equal(rows[0].message, "2 jobs have remained in Processing for more than 3 days. Please check their status.");
        await scan(at(day(1), "18:00"));
        assert.equal((await rowsOf(NOTIFICATION_TYPE.E6)).length, 3);
        assert.equal(MESSAGES.E6(1), "1 job has remained in Processing for more than 3 days. Please check its status.");
    });

    test("created_at is the time a job entered Processing: a closed job can never return to it (database trigger)", async () => {
        const closed = await job({ status: "COMPLETED", createdAt: minus(at(MON, "17:00"), 3 * DAY) });
        await assert.rejects(prisma.job.update({ where: { id: closed.id }, data: { status: "PROCESSING" } }));
        assert.equal((await prisma.job.findUnique({ where: { id: closed.id } })).status, "COMPLETED");
    });
});

describe("E7 Documents Awaiting Review", () => {
    test("at 3, 10 and 17 days; nothing in between; nothing once reviewed", async () => {
        const created = at(MON, "10:00");
        const p = await candidate();
        const doc = await document(p, created);
        await document(p, created, "VERIFIED");
        const sent = async (d) => {
            await scan(at(day(d), "18:00"));
            return (await rowsOf(NOTIFICATION_TYPE.E7)).filter((r) => r.dedupeKey.endsWith(`:${day(d)}`));
        };
        assert.equal((await sent(2)).length, 0);
        const three = await sent(3);
        assert.deepEqual(three.map((r) => r.recipientId), ADMIN_AUDIENCE_IDS);
        assert.equal(three[0].title, "Documents Awaiting Review");
        assert.equal(three[0].message, "1 document has been waiting for review for more than 3 days. Please review it.");
        for (const d of [4, 5, 9]) assert.equal((await sent(d)).length, 0, `day ${d}`);
        await document(p, at(day(7), "09:00")); // crosses 3 days on day 10 too
        const messages = (rows) => [...new Set(rows.map((r) => r.message))].sort();
        const ten = await sent(10);
        assert.equal(ten.length, 6, "two milestones, three recipients each");
        assert.deepEqual(messages(ten), [
            "1 document has been waiting for review for more than 10 days. Please review it.",
            "2 documents have been waiting for review for more than 3 days. Please review them.",
        ]);
        assert.deepEqual(messages(await sent(17)), [
            "1 document has been waiting for review for more than 17 days. Please review it.",
            "2 documents have been waiting for review for more than 10 days. Please review them.",
        ]);
        await prisma.document.update({ where: { documentId: doc }, data: { verificationStatus: "VERIFIED" } });
        assert.deepEqual(messages(await sent(24)), ["1 document has been waiting for review for more than 17 days. Please review it."], "the reviewed one is gone");
        await prisma.document.updateMany({ where: { verificationStatus: "REVIEW_REQUIRED" }, data: { verificationStatus: "VERIFIED" } });
        assert.equal((await sent(31)).length, 0);
        assert.deepEqual([3, 10, 17, 24, 4, 11, 2].map(isReviewMilestone), [true, true, true, true, false, false, false]);
    });
});

describe("E8 Staff Inactivity", () => {
    test("Analysts and Registration Desk only: no call and no upload on the last 2 working days; new and inactive accounts and other roles left out; once per spell", async () => {
        const p = await candidate();
        await callLog(p, USERS.ANN.adminId, at("2026-11-20", "10:00")); // Friday: active
        await callLog(p, USERS.BEN.adminId, at("2026-11-18", "10:00")); // Wednesday: inactive since
        await audit(USERS.ADMIN.adminId, "UPLOAD_DOCUMENT", p, at(MON, "09:00"));
        await audit(USERS.DESK.adminId, "UPLOAD_DOCUMENT", p, at("2026-11-22", "09:00")); // Sunday counts as activity
        await prisma.user.create({ data: { ...user("u-new", "ANALYST", "Nia New", 20), activatedAt: at("2026-11-20", "10:00") } });

        await scan(at(MON, "18:00"));
        const rows = await rowsOf(NOTIFICATION_TYPE.E8);
        const flagged = [...new Set(rows.map((r) => r.message))].sort();
        // The Owner, the Team Lead (no activity at all) and the Job Handler are never watched.
        assert.deepEqual(flagged, [
            "Ben Analyst has recorded no calls or documents for the last 2 working days. Please review their activity.",
            "Dan Desk has recorded no calls or documents for the last 2 working days. Please review their activity.",
        ]);
        assert.deepEqual([...new Set(rows.map((r) => r.recipientId))].sort(), ADMIN_AUDIENCE_IDS);
        assert.ok(rows.some((r) => r.dedupeKey === `E8:${USERS.BEN.adminId}:2026-11-18`));
        assert.ok(rows.some((r) => r.dedupeKey === `E8:${USERS.DESK2.adminId}:never`));
        for (const who of [USERS.OWNER, USERS.ADMIN, USERS.LEAD, USERS.JOBS]) assert.ok(!rows.some((r) => r.dedupeKey.startsWith(`E8:${who.adminId}:`)), who.role);
        assert.ok(rows.every((r) => r.title === "Staff Inactivity"));

        // Tuesday: the window is Monday and Tuesday. Ben and Dan are still in the same spell (no
        // repeat); Ann (last call Friday), Dee (last upload Sunday) and Nia (now judged) are new.
        const before = new Set(rows.map((r) => r.id));
        await scan(at(day(1), "18:00"));
        const after = await rowsOf(NOTIFICATION_TYPE.E8);
        assert.equal(after.filter((r) => r.message.startsWith("Ben")).length, 3, "not repeated while still inactive");
        assert.deepEqual([...new Set(after.filter((r) => !before.has(r.id)).map((r) => r.message.split(" has ")[0]))].sort(), ["Ann Analyst", "Dee Desk", "Nia New"]);
    });

    test("an Analyst promoted to Team Lead, or a Desk user made Admin, is no longer watched", async () => {
        await prisma.user.update({ where: { adminId: USERS.BEN.adminId }, data: { role: "TEAM_LEAD" } });
        await prisma.user.update({ where: { adminId: USERS.DESK2.adminId }, data: { role: "ADMIN" } });
        await scan(at(MON, "18:00"));
        const names = [...new Set((await rowsOf(NOTIFICATION_TYPE.E8)).map((r) => r.message.split(" has ")[0]))].sort();
        assert.deepEqual(names, ["Ann Analyst", "Dee Desk"]);
    });

    test("never on a weekend", async () => {
        const result = await scan(at("2026-11-28", "18:00")); // Saturday
        assert.equal(result.rules.find((r) => r.rule === "E8").status, "SKIPPED");
        await scan(at("2026-11-29", "18:00"));
        assert.equal((await rowsOf(NOTIFICATION_TYPE.E8)).length, 0);
    });
});

// ---------------------------------------------------------------- Owners

describe("F2 health check (06:00, Owners only)", () => {
    test("issues found are sent once a day as System Alerts; a healthy system sends nothing", async () => {
        await scan(at(MON, "06:00"));
        assert.equal((await rowsOf(NOTIFICATION_TYPE.F2)).length, 0, "healthy");

        await prisma.temporaryData.create({ data: { temporaryId: randomUUID(), whatsappNumber: "94770000000", documentType: "PASSPORT", temporaryStoragePath: "t/x", processingStatus: "FAILED", createdDate: at(MON, "02:00") } });
        await prisma.temporaryData.create({ data: { temporaryId: randomUUID(), whatsappNumber: "94770000000", documentType: "PASSPORT", temporaryStoragePath: "t/y", processingStatus: "TEMPORARY_STORED", createdDate: at(MON, "03:00") } });
        await prisma.sheetSyncState.update({ where: { stateId: "sheet-sync" }, data: { configured: true, workerHeartbeatAt: at(MON, "05:00") } });
        await scan(at(MON, "05:59"));
        assert.equal((await rowsOf(NOTIFICATION_TYPE.F2)).length, 0, "not before 06:00");
        await scan(at(MON, "06:15"));
        await scan(at(MON, "06:30"));
        resetSystemAlertMemory();
        await scan(at(MON, "09:00"));
        const rows = await rowsOf(NOTIFICATION_TYPE.F2);
        assert.deepEqual([...new Set(rows.map((r) => r.recipientId))], [USERS.OWNER.adminId]);
        assert.deepEqual(rows.map((r) => r.message).sort(), [
            "System alert: Document processing failed. Please check the system status.",
            "System alert: Document processing is delayed. Please check the system status.",
            "System alert: Sheet sync worker is not responding. Please check the system status.",
        ]);
        assert.ok(rows.every((r) => r.title === "System Alert" && r.dedupeKey.endsWith(`:${MON}`)));
    });

    test("an unconfigured sheet sync is not checked", async () => {
        await prisma.sheetSyncState.update({ where: { stateId: "sheet-sync" }, data: { configured: false, workerHeartbeatAt: null } });
        await scan(at(MON, "06:00"));
        assert.equal((await rowsOf(NOTIFICATION_TYPE.F2)).length, 0);
    });
});

describe("retention", () => {
    test("notifications older than 90 days are deleted during the 06:00 hour", async () => {
        await prisma.notification.create({ data: { recipientId: USERS.ADMIN.adminId, type: "X", dedupeKey: "old", createdAt: minus(at(MON, "06:00"), 91 * DAY) } });
        await prisma.notification.create({ data: { recipientId: USERS.ADMIN.adminId, type: "X", dedupeKey: "recent", createdAt: minus(at(MON, "06:00"), 89 * DAY) } });
        await scan(at(day(-1), "08:00"));
        assert.equal(await prisma.notification.count({ where: { type: "X" } }), 2, "outside the purge hour");
        const result = await scan(at(MON, "06:05"));
        assert.equal(result.rules.find((r) => r.rule === "PURGE").purged, 1);
        assert.deepEqual((await prisma.notification.findMany({ where: { type: "X" } })).map((r) => r.dedupeKey), ["recent"]);
    });
});

// ---------------------------------------------------------------- the task endpoint

describe("POST /api/tasks/notification-scan", () => {
    const appWith = (options) => {
        const app = express();
        app.use(express.json());
        app.use("/api/tasks", createTaskRouter({ db: prisma, log: quiet, env: {}, verifyScheduler: null, ...options }));
        app.use((error, req, res, next) => res.status(500).json({ message: "Internal server error" })); // eslint-disable-line no-unused-vars
        return app;
    };
    const call = async (app, headers = {}) => {
        const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
        try {
            const res = await fetch(`http://127.0.0.1:${server.address().port}/api/tasks/notification-scan`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
            return { status: res.status, body: res.status === 200 ? await res.json() : null };
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    };

    test("disabled (404) without its audience and invoker; never runs", async () => {
        assert.equal(notificationScanSchedulerVerifier({}), null);
        assert.equal(notificationScanSchedulerVerifier({ NOTIFICATION_SCAN_SCHEDULER_AUDIENCE: "https://x" }), null);
        assert.equal(notificationScanSchedulerVerifier({ IMPORT_RECOVERY_SCHEDULER_AUDIENCE: "https://x", IMPORT_RECOVERY_SCHEDULER_INVOKER: "a@b" }), null, "the import recovery's settings do not enable it");
        assert.equal(typeof notificationScanSchedulerVerifier({ NOTIFICATION_SCAN_SCHEDULER_AUDIENCE: "https://x", NOTIFICATION_SCAN_SCHEDULER_INVOKER: "a@b" }), "function");
        let ran = false;
        const { status } = await call(appWith({ runScan: async () => { ran = true; } }));
        assert.equal(status, 404);
        assert.equal(ran, false);
    });

    test("a call without a valid token is refused (401) and runs nothing", async () => {
        let ran = false;
        const verify = async (auth) => auth === "Bearer good";
        for (const headers of [{}, { authorization: "Bearer bad" }]) {
            const { status } = await call(appWith({ verifyNotificationScheduler: verify, runScan: async () => { ran = true; } }), headers);
            assert.equal(status, 401);
        }
        assert.equal(ran, false);
    });

    test("a valid scheduler call runs one scan and answers codes and counts only", async () => {
        await candidate({ createdDate: new Date(Date.now() - 60_000) });
        const { status, body } = await call(appWith({ verifyNotificationScheduler: async (auth) => auth === "Bearer good" }), { authorization: "Bearer good" });
        assert.equal(status, 200);
        assert.equal(body.databaseReachable, true);
        assert.ok(Array.isArray(body.rules) && body.rules.length === SCAN_RULES.length);
        assert.ok(!JSON.stringify(body).includes("Given"), "no names");
    });
});
