import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";

import { createAdminRouter } from "../src/routes/admin.js";
import { createRequireActiveAdmin } from "../src/middleware/requireActiveAdmin.js";
import { getDailyReport, parseDailyReportQuery } from "../src/services/adminReportService.js";
import { listPoliceWorkflow, parsePoliceListQuery } from "../src/services/adminPoliceService.js";
import { listReviewQueue, REVIEW_QUEUE_DEFAULTS } from "../src/services/adminReviewService.js";
import { PROCESSING_STATUS } from "../src/services/documentProcessingService.js";
import {
    RECEIVED_STATUS,
    SUBMISSION_OUTCOME,
    UNCLEAR_STATUSES,
    isSuccessfullyProcessed,
    statusesFor,
    submissionOutcome,
} from "../src/services/statusMapping.js";
import { createFakeReviewDb } from "./helpers/fakeReviewDb.js";

Object.assign(process.env, {
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-placeholder",
    DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
    META_APP_SECRET: "test-app-secret-placeholder",
    JWT_SECRET: "test-jwt-secret-placeholder-0123456789",
});
const { createApp } = await import("../src/createApp.js");

// Synthetic data only.
describe("status mapping (proposal words -> implementation)", () => {
    test("every processing status the pipeline writes has exactly one outcome", () => {
        const all = [RECEIVED_STATUS, ...Object.values(PROCESSING_STATUS)];
        const mapped = Object.values(SUBMISSION_OUTCOME).flatMap(statusesFor);
        assert.deepEqual([...mapped].sort(), [...all].sort());
    });

    test("outcomes", () => {
        assert.equal(submissionOutcome("TEMPORARY_STORED"), "PROCESSING");
        for (const s of ["VERIFIED", "HIGH_CONFIDENCE", "SLIGHTLY_UNCLEAR", "UNCLEAR"]) assert.equal(submissionOutcome(s), "STORED", s);
        for (const s of ["UNDEFINED", "MANUAL_REVIEW", "CONFLICT"]) assert.equal(submissionOutcome(s), "NEEDS_REVIEW", s);
        assert.equal(submissionOutcome("DUPLICATE"), "DUPLICATE");
        assert.equal(submissionOutcome("FAILED"), "FAILED");
        assert.equal(submissionOutcome("SOMETHING_NEW"), "PROCESSING", "unknown codes never count as success");
        assert.deepEqual(UNCLEAR_STATUSES, ["UNCLEAR", "UNDEFINED"]);
        assert.equal(isSuccessfullyProcessed("FAILED"), false);
        assert.equal(isSuccessfullyProcessed("TEMPORARY_STORED"), false);
        assert.equal(isSuccessfullyProcessed("DUPLICATE"), true);
    });

    test("there is no REJECTED status anywhere in the implementation", () => {
        assert.ok(!Object.values(PROCESSING_STATUS).includes("REJECTED"));
        assert.ok(!Object.values(SUBMISSION_OUTCOME).includes("REJECTED"));
        const sources = fs.readdirSync(new URL("../src/services/", import.meta.url)).map((f) => fs.readFileSync(new URL(`../src/services/${f}`, import.meta.url), "utf8"));
        assert.ok(!sources.some((code) => /["']REJECTED["']/.test(code)));
    });

    test("FAILED stays distinct from review: a FAILED submission without a pending copy is not in the Review Queue", async () => {
        const db = createFakeReviewDb({
            temporaryData: [
                { temporaryId: "t-fail", passportId: null, documentType: "UNKNOWN", processingStatus: "FAILED", createdDate: new Date(), pendingStoragePath: null },
                { temporaryId: "t-wait", passportId: null, documentType: "UNKNOWN", processingStatus: "UNDEFINED", createdDate: new Date(), pendingStoragePath: "pending/x.pdf" },
            ],
        });
        const queue = await listReviewQueue({ db: db.client, params: { ...REVIEW_QUEUE_DEFAULTS } });
        assert.deepEqual(queue.items.map((i) => i.reviewId), ["pending-t-wait"]);
    });
});

describe("daily report: date", () => {
    test("default is today in Sri Lanka, not UTC", () => {
        // 19:00 UTC on 25 Sep is 00:30 on 26 Sep in Colombo.
        assert.deepEqual(parseDailyReportQuery({}, { now: new Date("2026-09-25T19:00:00Z") }).params, { date: "2026-09-26" });
        assert.deepEqual(parseDailyReportQuery({}, { now: new Date("2026-09-25T18:29:00Z") }).params, { date: "2026-09-25" });
    });

    test("a selected past date; future, invalid and pre-2000 dates refused", () => {
        const now = new Date("2026-09-25T06:00:00Z");
        assert.deepEqual(parseDailyReportQuery({ date: "2026-09-01" }, { now }).params, { date: "2026-09-01" });
        assert.deepEqual(parseDailyReportQuery({ date: "2026-09-25" }, { now }).params, { date: "2026-09-25" });
        for (const date of ["2026-09-26", "2026-02-30", "25-09-2026", "1999-12-31", ["2026-09-01", "2026-09-02"]]) {
            assert.ok(parseDailyReportQuery({ date }, { now }).errors, String(date));
        }
    });
});

// Submissions around the Colombo day 2026-09-24 (18:30 UTC on the 23rd to 18:30 UTC on the 24th).
const sub = (temporaryId, createdDate, processingStatus, documentType, extra = {}) => ({
    temporaryId, passportId: null, documentType, processingStatus, createdDate: new Date(createdDate), pendingStoragePath: null, ...extra,
});
const SUBMISSIONS = [
    sub("before", "2026-09-23T18:29:59Z", "VERIFIED", "PASSPORT"),                       // 23 Sep in Colombo
    sub("first", "2026-09-23T18:30:00Z", "VERIFIED", "PASSPORT"),                        // 00:00 on 24 Sep
    sub("hc", "2026-09-24T02:00:00Z", "HIGH_CONFIDENCE", "MEDICAL"),
    sub("unclear", "2026-09-24T03:00:00Z", "UNCLEAR", "POLICE_REPORT"),
    sub("undefined", "2026-09-24T04:00:00Z", "UNDEFINED", "UNKNOWN", { pendingStoragePath: "pending/u.pdf" }),
    sub("slip", "2026-09-24T05:00:00Z", "MANUAL_REVIEW", "POLICE_SLIP", { pendingStoragePath: "pending/s.pdf" }),
    sub("dup", "2026-09-24T06:00:00Z", "DUPLICATE", "PASSPORT"),
    sub("fail", "2026-09-24T07:00:00Z", "FAILED", "UNKNOWN"),
    sub("busy", "2026-09-24T08:00:00Z", "TEMPORARY_STORED", "UNKNOWN"),
    sub("last", "2026-09-24T18:29:59Z", "CONFLICT", "PASSPORT", { pendingStoragePath: "pending/c.pdf" }), // 23:59:59 on 24 Sep
    sub("after", "2026-09-24T18:30:00Z", "VERIFIED", "MEDICAL"),                         // 25 Sep
];
const AUDIT = [
    { auditId: "a1", adminId: "admin-active", action: "APPROVE", createdDate: new Date("2026-09-24T09:00:00Z") },
    { auditId: "a2", adminId: "admin-active", action: "REMOVE_FROM_REVIEW", createdDate: new Date("2026-09-24T10:00:00Z") },
    { auditId: "a3", adminId: "admin-active", action: "APPROVE", createdDate: new Date("2026-09-25T09:00:00Z") },
];
const ADMINS = [{ adminId: "admin-active", name: "Active Admin", email: "a@example.invalid", passwordHash: "x", role: "ADMIN", status: "ACTIVE" }];
const USERS = [{ passportId: "N0000001", uniqueId: "0001", firstName: "A", otherName: null }];
const reportDb = () => createFakeReviewDb({ admins: ADMINS, users: USERS, temporaryData: SUBMISSIONS, auditLogs: AUDIT });

describe("daily report: figures", () => {
    test("daily figures count only that business day in Sri Lanka", async () => {
        const report = await getDailyReport({ db: reportDb().client, date: "2026-09-24", now: new Date("2026-09-25T06:00:00Z") });
        assert.equal(report.businessDate, "2026-09-24");
        assert.equal(report.isToday, false);
        assert.deepEqual(report.range, { start: "2026-09-23T18:30:00.000Z", end: "2026-09-24T18:30:00.000Z" });
        const { daily } = report;
        assert.equal(daily.totalReceived, 9);
        assert.equal(daily.successfullyProcessed, 7); // everything except FAILED and still processing
        assert.equal(daily.failed, 1);
        assert.equal(daily.stillProcessing, 1);
        assert.equal(daily.storedInClientFolder, 3);
        assert.equal(daily.heldForReview, 3);
        assert.equal(daily.duplicates, 1);
        assert.equal(daily.unclear, 2); // UNCLEAR + UNDEFINED
        assert.equal(daily.temporary, 3); // still waiting in pending/
        assert.deepEqual(daily.byType, { PASSPORT: 3, POLICE_SLIP: 1, POLICE_REPORT: 1, MEDICAL: 1, UNKNOWN: 3 });
        assert.deepEqual(daily.adminActions, { APPROVE: 1, REMOVE_FROM_REVIEW: 1 });
    });

    test("current figures are labelled with the time they were taken, not the selected day", async () => {
        const now = new Date("2026-09-25T06:00:00Z");
        const report = await getDailyReport({ db: reportDb().client, date: "2026-09-24", now });
        assert.equal(report.current.asOf, now.toISOString());
        assert.deepEqual(report.current.clients, { total: 1, complete: 0, incomplete: 1, withMissing: 1, missingDocuments: 3, missingByType: { PASSPORT: 1, POLICE_REPORT: 1, MEDICAL: 1 } });
        assert.deepEqual(report.current.police, { dueSoon: 0, dueToday: 0, overdue: 0 });
    });

    test("a day without submissions: zeros, not all-time values", async () => {
        const report = await getDailyReport({ db: reportDb().client, date: "2026-09-01", now: new Date("2026-09-25T06:00:00Z") });
        assert.equal(report.daily.totalReceived, 0);
        assert.equal(report.daily.successfullyProcessed, 0);
        assert.deepEqual(report.daily.byType, { PASSPORT: 0, POLICE_SLIP: 0, POLICE_REPORT: 0, MEDICAL: 0, UNKNOWN: 0 });
    });
});

describe("GET /api/admin/reports/daily", () => {
    let server;
    let base;
    let db;
    before(async () => {
        db = reportDb();
        const app = createApp({ adminApiRouter: createAdminRouter({ db: db.client, requireAdmin: createRequireActiveAdmin({ db: db.client }) }) });
        server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
        base = `http://127.0.0.1:${server.address().port}/api/admin`;
    });
    after(() => server.close());
    const token = jwt.sign({ adminId: "admin-active" }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
    const get = async (p, t = token) => {
        const response = await fetch(`${base}${p}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
        return { status: response.status, body: await response.json() };
    };

    test("returns the selected day; 400 for bad dates; 401 without a session", async () => {
        const { status, body } = await get("/reports/daily?date=2026-09-24");
        assert.equal(status, 200);
        assert.equal(body.daily.totalReceived, 9);
        assert.equal((await get("/reports/daily")).status, 200);
        const bad = await get("/reports/daily?date=2999-01-01");
        assert.equal(bad.status, 400);
        assert.equal(bad.body.errors[0].field, "date");
        assert.equal((await get("/reports/daily?date=yesterday")).status, 400);
        assert.equal((await get("/reports/daily", null)).status, 401);
    });
});

describe("police workflow search", () => {
    const db = () => createFakeReviewDb({
        users: [
            { passportId: "N0000001", uniqueId: "0001", firstName: "KAMAL", otherName: "PERERA" },
            { passportId: "N0000002", uniqueId: "0002", firstName: "SAMAN", otherName: "SILVA" },
        ],
    });

    test("by passport ID, unique ID or name; statuses unchanged", async () => {
        const run = async (search) => (await listPoliceWorkflow({ db: db().client, params: { page: 1, pageSize: 25, search } })).items.map((i) => i.client.passportId);
        assert.deepEqual(await run("n0000002"), ["N0000002"]);
        assert.deepEqual(await run("0001"), ["N0000001"]);
        assert.deepEqual(await run("silva saman"), ["N0000002"]);
        assert.deepEqual(await run("nobody"), []);
        const all = await listPoliceWorkflow({ db: db().client, params: { page: 1, pageSize: 25 } });
        const one = await listPoliceWorkflow({ db: db().client, params: { page: 1, pageSize: 25, search: "kamal" } });
        assert.equal(one.items[0].status, all.items.find((i) => i.client.passportId === "N0000001").status);
        assert.equal(one.summary.total, 1);
        assert.equal(one.filters.search, "kamal");
    });

    test("validation", () => {
        assert.equal(parsePoliceListQuery({ search: "  kamal " }).params.search, "kamal");
        assert.ok(parsePoliceListQuery({ search: "x".repeat(101) }).errors);
    });
});

describe("no automatic removal of pending items", () => {
    const srcFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? srcFiles(full) : full.endsWith(".js") ? [full] : [];
    });
    const sources = srcFiles(fileURLToPath(new URL("../src/", import.meta.url)))
        .map((file) => [path.basename(file), fs.readFileSync(file, "utf8").replace(/\/\/.*$/gm, "")]);

    test("no timer, schedule or cleanup job exists anywhere in the backend", () => {
        for (const [file, code] of sources) {
            assert.ok(!/setInterval\(|node-cron|cron\.schedule|agenda|bull(mq)?\b/i.test(code), file);
        }
        // The only timeouts are bounded waits (OCR, concurrency limiter); none touches data or files.
        const timeouts = sources.filter(([, code]) => /setTimeout\(/.test(code));
        assert.deepEqual(timeouts.map(([f]) => f).sort(), ["concurrencyLimiter.js", "ocrService.js"]);
        for (const [file, code] of timeouts) assert.ok(!/temporaryData\.|removeObject|\.remove\(/.test(code), file);
    });

    test("only Remove from Review deletes a submission row; only admin actions and the pipeline remove pending files", () => {
        const deleting = sources.filter(([, code]) => /temporaryData\.(delete|deleteMany)\(/.test(code)).map(([f]) => f);
        assert.deepEqual(deleting, ["adminReviewActionService.js"]);
        const clearing = sources.filter(([, code]) => /pendingStoragePath:\s*null/.test(code)).map(([f]) => f);
        // Approve clears it after filing the file; storage placement only says a *new* file got no pending copy.
        assert.deepEqual(clearing.sort(), ["adminReviewActionService.js", "storagePlacementService.js"]);
        // Age, expiry, restart, duplicate detection or OCR timeouts never lead to a removal.
        const pipeline = sources.find(([f]) => f === "documentProcessingService.js")[1];
        assert.ok(!/\.delete\(|removeObject\(\s*[^)]*pending/i.test(pipeline));
    });
});
