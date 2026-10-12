// Daily Report: Summary and Summary by Roles (dailyReportService.js). On a
// REAL PostgreSQL (PGlite, every migration) through the real Prisma client
// and the real admin router. No Supabase: the signed-in user is set by a
// stand-in for requireActiveUser. Synthetic data only.
//
// Report day 2026-10-10 in Sri Lanka = 2026-10-09T18:30:00Z up to (not
// including) 2026-10-10T18:30:00Z.
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { createCandidate, parseCandidateBody } from "../src/services/candidateService.js";
import { getDailyRoleSummary, getDailySummary, getIncompleteCandidates } from "../src/services/dailyReportService.js";

const DAY = "2026-10-10";
const START = "2026-10-09T18:30:00.000Z"; // 00:00 Colombo
const LAST_MS = "2026-10-10T18:29:59.999Z"; // 23:59:59.999 Colombo
const NEXT = "2026-10-10T18:30:00.000Z"; // next day 00:00 Colombo
const BEFORE = "2026-10-09T18:29:59.999Z"; // previous day 23:59:59.999 Colombo
const NOW = new Date("2026-10-11T06:00:00.000Z");

const STAFF = {
    ADMIN: { adminId: "user-admin", authUserId: "00000000-0000-4000-8000-000000000001", name: "Ada Admin", email: "ada@example.invalid", role: "ADMIN" },
    MANAGER: { adminId: "user-manager", authUserId: "00000000-0000-4000-8000-000000000002", name: "Max Manager", email: "max@example.invalid", role: "MANAGER" },
    ANALYST: { adminId: "user-analyst", authUserId: "00000000-0000-4000-8000-000000000003", name: "Ann Analyst", email: "ann@example.invalid", role: "ANALYST" },
    ANALYST2: { adminId: "user-analyst-2", authUserId: "00000000-0000-4000-8000-000000000005", name: "Bob Analyst", email: "bob@example.invalid", role: "ANALYST" },
    REGISTRATION_DESK: { adminId: "user-desk", authUserId: "00000000-0000-4000-8000-000000000004", name: "Dee Desk", email: "dee@example.invalid", role: "REGISTRATION_DESK" },
};
const BASE = { surname: "Silva", jobTypes: ["Driver"], jobExperience: "2 years", passportIssueDate: "2020-01-15", passportExpiryDate: "2030-01-14", dateOfBirth: "1990-01-01" };
const A = "N1000001";
const B = "N1000002";
const C = "N1000003";

let database;
let prisma;

before(async () => {
    database = await createTestDatabase();
    ({ prisma } = database);
    for (const user of Object.values(STAFF)) await prisma.user.create({ data: user });
    for (const [passportId, otherNames, nic, whatsappNumber] of [[A, "Anil", "900000001V", "+94770000001"], [B, "Bimal", "900000002V", "+94770000002"], [C, "Chamari", "900000003V", "+94770000003"]]) {
        const { values } = parseCandidateBody({ ...BASE, passportId, otherNames, nic, whatsappNumber }, { creating: true });
        await createCandidate({ db: prisma, values });
    }
    await seed();
});
after(async () => database?.close());

const call = (passportId, adminId, at) => prisma.candidateCallLog.create({ data: { callLogId: crypto.randomUUID(), passportId, adminId, note: "Called", createdDate: new Date(at) } });
// A staff upload: the stored document and its UPLOAD_DOCUMENT audit entry.
async function upload(passportId, adminId, documentType, at, variant = null) {
    const documentId = crypto.randomUUID();
    await prisma.document.create({
        data: {
            documentId, passportId, documentType, documentVariant: variant, originalFilename: "f.pdf", storedFilename: `${documentId}.pdf`,
            storagePath: `clients/${passportId}/${documentId}.pdf`, receivedDate: new Date(at), processingStatus: "STORED", verificationStatus: "VERIFIED",
        },
    });
    await prisma.auditLog.create({
        data: { auditId: crypto.randomUUID(), adminId, action: "UPLOAD_DOCUMENT", documentId, passportId, previousStatus: "NONE", newStatus: "VERIFIED", documentType, newValue: variant, createdDate: new Date(at) },
    });
}
// A WhatsApp file as received (temporary_data): no staff member.
const whatsapp = (documentType, at, processingStatus = "VERIFIED") => prisma.temporaryData.create({
    data: { temporaryId: crypto.randomUUID(), whatsappNumber: "94770000009", documentType, temporaryStoragePath: `pending/${crypto.randomUUID()}`, processingStatus, createdDate: new Date(at) },
});
const stage = (passportId, name, data) => prisma.candidateStage.upsert({
    where: { passportId_stage: { passportId, stage: name } },
    create: { passportId, stage: name, ...data },
    update: data,
});

async function seed() {
    // Calls: 4 on the day (both edges included), 2 outside it.
    await call(A, STAFF.ANALYST.adminId, START);
    await call(A, STAFF.ANALYST2.adminId, "2026-10-10T05:00:00Z");
    await call(B, STAFF.REGISTRATION_DESK.adminId, "2026-10-10T08:00:00Z");
    await call(C, STAFF.ADMIN.adminId, LAST_MS);
    await call(A, STAFF.ANALYST.adminId, BEFORE);
    await call(B, STAFF.ANALYST.adminId, NEXT);

    // Staff uploads on the day: 3 (2 by analysts, 1 by the desk); 1 outside.
    await upload(A, STAFF.ANALYST.adminId, "PASSPORT", "2026-10-10T03:00:00Z");
    await upload(A, STAFF.ANALYST2.adminId, "POLICE_REPORT", "2026-10-10T04:00:00Z", "SL_VERIFIED");
    await upload(B, STAFF.REGISTRATION_DESK.adminId, "SCAN", "2026-10-10T06:00:00Z");
    await upload(C, STAFF.ANALYST.adminId, "MEDICAL", BEFORE);

    // WhatsApp files on the day: 3 (one unclassified, one failed); 1 outside.
    await whatsapp("PASSPORT", "2026-10-10T02:00:00Z");
    await whatsapp("MEDICAL", "2026-10-10T07:00:00Z", "FAILED");
    await whatsapp("UNKNOWN", LAST_MS, "MANUAL_REVIEW");
    await whatsapp("PASSPORT", NEXT);

    // Stages. A: final stage and visa approval completed on the day, IVS
    // interview NOT complete (out of order is valid). B: visa approval on the
    // day, test failed. C: final stage completed the day before.
    await stage(A, "FINALIZING_JOB", { completed: true, completedAt: new Date("2026-10-10T10:00:00Z") });
    await stage(A, "VISA_APPROVAL", { completed: true, completedAt: new Date("2026-10-10T09:00:00Z") });
    await stage(B, "VISA_APPROVAL", { completed: true, completedAt: new Date(START) });
    await stage(B, "TEST_DETAILS", { testResult: "FAIL", jobId: "J-1" });
    await stage(C, "FINALIZING_JOB", { completed: true, completedAt: new Date(BEFORE) });
    await stage(C, "VISA_APPROVAL", { completed: true, completedAt: new Date(BEFORE) });
}

async function withApi(role, work) {
    const app = express();
    app.use(express.json());
    const user = Object.values(STAFF).find((s) => s.role === role) ?? STAFF.ADMIN;
    app.use("/api/admin", createAdminRouter({ db: prisma, requireAdmin: (req, res, next) => { req.user = { ...user, role, status: "ACTIVE" }; next(); }, apiLimiter: noRateLimit }));
    app.use(errorHandler);
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    try {
        return await work(async (path) => {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin${path}`);
            return { status: response.status, body: await response.json() };
        });
    } finally {
        server.close();
    }
}

describe("Summary: daily figures on Sri Lanka day boundaries", () => {
    test("3, 7, 8-12. KPIs for the selected day: completed, visa completed, calls, documents (WhatsApp + manual)", async () => {
        const report = await getDailySummary({ db: prisma, date: DAY, now: NOW });
        assert.equal(report.businessDate, DAY);
        assert.equal(report.timeZone, "Asia/Colombo");
        assert.deepEqual(report.range, { start: START, end: NEXT });
        assert.deepEqual(report.summary, { candidatesCompleted: 1, visaCompleted: 2, callsTaken: 4, documentsSubmitted: 6 });
        assert.deepEqual([report.documents.total, report.documents.whatsapp, report.documents.manual], [6, 3, 3]);
    });

    test("the previous day is a different report (same boundaries applied)", async () => {
        const report = await getDailySummary({ db: prisma, date: "2026-10-09", now: NOW });
        assert.deepEqual(report.summary, { candidatesCompleted: 1, visaCompleted: 1, callsTaken: 1, documentsSubmitted: 1 });
        assert.deepEqual(report.completedCandidates.items.map((c) => c.passportId), [C]);
    });

    test("13-15. documents by type: candidate types only (ONE SCAN), WhatsApp / manual split; unclassified only when present", async () => {
        const { documents } = await getDailySummary({ db: prisma, date: DAY, now: NOW });
        const row = (type) => documents.byType.find((r) => r.type === type);
        assert.deepEqual(row("PASSPORT"), { type: "PASSPORT", total: 2, whatsapp: 1, manual: 1 });
        assert.deepEqual(row("POLICE_REPORT"), { type: "POLICE_REPORT", total: 1, whatsapp: 0, manual: 1 });
        assert.deepEqual(row("MEDICAL"), { type: "MEDICAL", total: 1, whatsapp: 1, manual: 0 });
        assert.deepEqual(row("SCAN"), { type: "SCAN", total: 1, whatsapp: 0, manual: 1 });
        assert.deepEqual(row("UNKNOWN"), { type: "UNKNOWN", total: 1, whatsapp: 1, manual: 0 });
        assert.equal(documents.byType.filter((r) => r.type === "SCAN").length, 1);
        for (const fake of ["AGREEMENT", "AFFIDAVIT", "CONTRACT", "SCAN_2"]) assert.equal(row(fake), undefined, fake);
        assert.equal(documents.byType.reduce((sum, r) => sum + r.total, 0), documents.total);
        const empty = await getDailySummary({ db: prisma, date: "2026-10-05", now: NOW });
        assert.equal(empty.documents.byType.find((r) => r.type === "UNKNOWN"), undefined, "no unclassified row when there are none");
    });

    test("calls list: time, candidate, passport number, handled by and role; newest first", async () => {
        const { calls } = await getDailySummary({ db: prisma, date: DAY, now: NOW });
        assert.equal(calls.total, 4);
        assert.deepEqual(calls.items.map((c) => [c.passportId, c.handledBy, c.role]), [
            [C, "Ada Admin", "ADMIN"], [B, "Dee Desk", "REGISTRATION_DESK"], [A, "Bob Analyst", "ANALYST"], [A, "Ann Analyst", "ANALYST"],
        ]);
        assert.equal(calls.items[0].candidateName, "Chamari Silva");
    });

    test("19-20. completed candidates: the final stage completed that day, with passport number, name, time and whether every stage is complete now", async () => {
        const { completedCandidates } = await getDailySummary({ db: prisma, date: DAY, now: NOW });
        assert.equal(completedCandidates.total, 1);
        assert.deepEqual(completedCandidates.items.map((c) => [c.passportId, c.name, new Date(c.completedAt).toISOString(), c.allStagesComplete]), [
            [A, "Anil Silva", "2026-10-10T10:00:00.000Z", false],
        ]);
    });

    test("WhatsApp processing outcomes are kept (received, failed, held for review)", async () => {
        const { whatsappProcessing } = await getDailySummary({ db: prisma, date: DAY, now: NOW });
        assert.equal(whatsappProcessing.received, 3);
        assert.equal(whatsappProcessing.failed, 1);
        assert.ok(whatsappProcessing.heldForReview + whatsappProcessing.successfullyProcessed >= 1);
    });

    test("34. police status is still reported (current snapshot)", async () => {
        const { current } = await getDailySummary({ db: prisma, date: DAY, now: NOW });
        assert.deepEqual(Object.keys(current.police).sort(), ["dueSoon", "dueToday", "missingSlipDate", "notUploaded", "overdue"].sort());
        assert.equal(current.asOf, NOW.toISOString());
    });
});

describe("Incomplete candidates (current snapshot)", () => {
    test("16-18. counts per stage with reasons from real data; out-of-order completion stays valid", async () => {
        const { current } = await getDailySummary({ db: prisma, date: DAY, now: NOW });
        const { incomplete } = current;
        assert.equal(incomplete.totalCandidates, 3);
        assert.equal(incomplete.incompleteCandidates, 3);
        const byStage = Object.fromEntries(incomplete.byStage.map((s) => [s.stage, s]));
        assert.deepEqual(incomplete.byStage.map((s) => s.stage), ["TEST_DETAILS", "CANDIDATE_DETAILS", "DOCUMENT_SUBMISSION", "IVS_INTERVIEW", "VISA_SUBMISSION", "VISA_APPROVAL", "FINALIZING_JOB"]);
        assert.equal(byStage.FINALIZING_JOB.count, 1, "A and C finalized (A out of order): only B");
        assert.equal(byStage.IVS_INTERVIEW.count, 3, "nobody completed the interview, finalized or not");
        assert.equal(byStage.VISA_APPROVAL.count, 0);
        // A has a passport upload; B and C have no passport document.
        assert.equal(byStage.CANDIDATE_DETAILS.count, 2);
        assert.deepEqual(byStage.CANDIDATE_DETAILS.reasons, [{ reason: "Passport document missing", count: 2 }]);
        const testReasons = Object.fromEntries(byStage.TEST_DETAILS.reasons.map((r) => [r.reason, r.count]));
        assert.deepEqual(testReasons, { "No test result recorded": 2, "Test failed": 1 });
        const submission = Object.fromEntries(byStage.DOCUMENT_SUBMISSION.reasons.map((r) => [r.reason, r.count]));
        assert.equal(submission["Romania police report missing"], 3);
        assert.equal(submission["SL Verified police report missing"], 2, "A uploaded its SL Verified report");
        assert.equal(submission["Scan missing"], 2, "B uploaded its scan");
        assert.equal(byStage.IVS_INTERVIEW.reasons[0].reason, "Not marked complete");
    });

    test("12. the candidates behind a stage, with their reasons, paged", async () => {
        const detail = await getIncompleteCandidates({ db: prisma, stage: "TEST_DETAILS", page: 1, pageSize: 2 });
        assert.equal(detail.pagination.total, 3);
        assert.equal(detail.pagination.totalPages, 2);
        assert.equal(detail.items.length, 2);
        const all = [...detail.items, ...(await getIncompleteCandidates({ db: prisma, stage: "TEST_DETAILS", page: 2, pageSize: 2 })).items];
        assert.deepEqual(Object.fromEntries(all.map((r) => [r.passportId, r.reasons])), { [A]: ["No test result recorded"], [B]: ["Test failed"], [C]: ["No test result recorded"] });
        assert.ok(all.every((r) => r.name));
    });
});

describe("Summary by Roles", () => {
    test("22-24. calls and staff uploads by role; WhatsApp files are never attributed", async () => {
        const analysts = await getDailyRoleSummary({ db: prisma, date: DAY, role: "ANALYST" });
        assert.equal(analysts.callsTaken, 2);
        assert.equal(analysts.documentsUploaded, 2);
        assert.deepEqual(analysts.documentsByType.filter((t) => t.count).map((t) => [t.type, t.count]), [["PASSPORT", 1], ["POLICE_REPORT", 1]]);
        assert.deepEqual(analysts.staff.map((s) => [s.name, s.calls, s.documents]), [["Ann Analyst", 1, 1], ["Bob Analyst", 1, 1]]);
        assert.equal(analysts.activity.length, 4);
        assert.ok(analysts.activity.every((a) => a.staff === "Ann Analyst" || a.staff === "Bob Analyst"));
        assert.ok(analysts.activity.some((a) => a.kind === "DOCUMENT_UPLOAD" && a.documentType === "POLICE_REPORT" && a.variant === "SL_VERIFIED" && a.candidateName === "Anil Silva"));

        const desk = await getDailyRoleSummary({ db: prisma, date: DAY, role: "REGISTRATION_DESK" });
        assert.deepEqual([desk.callsTaken, desk.documentsUploaded], [1, 1]);
        const manager = await getDailyRoleSummary({ db: prisma, date: DAY, role: "MANAGER" });
        assert.deepEqual([manager.callsTaken, manager.documentsUploaded, manager.activity.length], [0, 0, 0]);
        // Every role together: 4 calls, 3 uploads. The 3 WhatsApp files that day belong to no role.
        let calls = 0;
        let docs = 0;
        for (const role of ["ADMIN", "MANAGER", "ANALYST", "REGISTRATION_DESK"]) {
            const r = await getDailyRoleSummary({ db: prisma, date: DAY, role });
            calls += r.callsTaken;
            docs += r.documentsUploaded;
        }
        assert.deepEqual([calls, docs], [4, 3]);
    });

    test("the day boundary applies to role figures too", async () => {
        const analysts = await getDailyRoleSummary({ db: prisma, date: "2026-10-09", role: "ANALYST" });
        assert.deepEqual([analysts.callsTaken, analysts.documentsUploaded], [1, 1]);
    });
});

describe("API and permissions", () => {
    test("25-27. Summary: ADMIN, MANAGER, ANALYST (as the daily report); REGISTRATION_DESK 403", async () => {
        for (const role of ["ADMIN", "MANAGER", "ANALYST"]) {
            const { status, body } = await withApi(role, (get) => get(`/reports/daily/summary?date=${DAY}`));
            assert.equal(status, 200, role);
            assert.equal(body.summary.callsTaken, 4);
        }
        assert.equal((await withApi("REGISTRATION_DESK", (get) => get(`/reports/daily/summary?date=${DAY}`))).status, 403);
        assert.equal((await withApi("ADMIN", (get) => get("/reports/daily/summary?date=2999-01-01"))).status, 400);
    });

    test("Summary by Roles: ADMIN and MANAGER only; the role must be one of the four", async () => {
        for (const role of ["ADMIN", "MANAGER"]) {
            const { status, body } = await withApi(role, (get) => get(`/reports/daily/roles?date=${DAY}&role=ANALYST`));
            assert.equal(status, 200, role);
            assert.equal(body.role, "ANALYST");
        }
        for (const role of ["ANALYST", "REGISTRATION_DESK"]) assert.equal((await withApi(role, (get) => get(`/reports/daily/roles?date=${DAY}&role=ANALYST`))).status, 403, role);
        const bad = await withApi("ADMIN", (get) => get(`/reports/daily/roles?date=${DAY}&role=VIEWER`));
        assert.equal(bad.status, 400);
        assert.equal(bad.body.errors[0].field, "role");
    });

    test("incomplete details: ADMIN, MANAGER, ANALYST; an unknown stage is 400", async () => {
        const ok = await withApi("ANALYST", (get) => get("/reports/daily/incomplete?stage=VISA_APPROVAL"));
        assert.equal(ok.status, 200);
        assert.equal(ok.body.pagination.total, 0);
        assert.equal((await withApi("ADMIN", (get) => get("/reports/daily/incomplete?stage=NOPE"))).status, 400);
        assert.equal((await withApi("REGISTRATION_DESK", (get) => get("/reports/daily/incomplete?stage=VISA_APPROVAL"))).status, 403);
    });

    test("an empty day returns zeros and empty lists", async () => {
        const report = await getDailySummary({ db: prisma, date: "2026-09-01", now: NOW });
        assert.deepEqual(report.summary, { candidatesCompleted: 0, visaCompleted: 0, callsTaken: 0, documentsSubmitted: 0 });
        assert.deepEqual([report.calls.items, report.completedCandidates.items], [[], []]);
    });
});
