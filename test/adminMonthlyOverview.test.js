import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

import { createAdminRouter } from "../src/routes/admin.js";
import { createRequireActiveAdmin } from "../src/middleware/requireActiveAdmin.js";
import { businessMonthRange, getMonthlyOverview, parseMonthlyOverviewQuery } from "../src/services/adminReportService.js";
import { createFakeReviewDb } from "./helpers/fakeReviewDb.js";

Object.assign(process.env, {
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-placeholder",
    DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
    META_APP_SECRET: "test-app-secret-placeholder",
    JWT_SECRET: "test-jwt-secret-placeholder-0123456789",
});
const { createApp } = await import("../src/createApp.js");

// Synthetic data only. September 2026 in Colombo runs from 18:30 UTC on
// 31 Aug to 18:30 UTC on 30 Sep.
const NOW = new Date("2026-10-04T06:00:00Z");

describe("monthly overview: month", () => {
    test("default is this month in Sri Lanka, not UTC", () => {
        // 19:00 UTC on 30 Sep is 00:30 on 1 Oct in Colombo.
        assert.deepEqual(parseMonthlyOverviewQuery({}, { now: new Date("2026-09-30T19:00:00Z") }).params, { month: "2026-10" });
        assert.deepEqual(parseMonthlyOverviewQuery({}, { now: new Date("2026-09-30T18:29:00Z") }).params, { month: "2026-09" });
    });

    test("a selected past month; future, malformed and pre-2000 months refused", () => {
        assert.deepEqual(parseMonthlyOverviewQuery({ month: "2026-09" }, { now: NOW }).params, { month: "2026-09" });
        assert.deepEqual(parseMonthlyOverviewQuery({ month: "2026-10" }, { now: NOW }).params, { month: "2026-10" });
        for (const month of ["2026-11", "2026-13", "2026-00", "2026-9", "09-2026", "2026-09-01", "1999-12", ["2026-08", "2026-09"]]) {
            assert.ok(parseMonthlyOverviewQuery({ month }, { now: NOW }).errors, String(month));
        }
    });

    test("month boundaries are Colombo midnights, including December", () => {
        const range = (m) => Object.fromEntries(Object.entries(businessMonthRange(m)).map(([k, v]) => [k, v.toISOString()]));
        assert.deepEqual(range("2026-09"), { start: "2026-08-31T18:30:00.000Z", end: "2026-09-30T18:30:00.000Z" });
        assert.deepEqual(range("2026-12"), { start: "2026-11-30T18:30:00.000Z", end: "2026-12-31T18:30:00.000Z" });
    });
});

const user = (passportId, createdDate) => ({ passportId, uniqueId: passportId, firstName: "A", otherName: null, createdDate: new Date(createdDate) });
const sub = (temporaryId, createdDate, processingStatus, extra = {}) => ({
    temporaryId, passportId: null, documentType: "PASSPORT", processingStatus, createdDate: new Date(createdDate), pendingStoragePath: null, ...extra,
});
const doc = (documentId, receivedDate, verificationStatus) => ({
    documentId, passportId: "N0000001", documentType: "PASSPORT", processingStatus: "STORED", verificationStatus, receivedDate: new Date(receivedDate),
});
const audit = (auditId, action, createdDate) => ({ auditId, adminId: "admin-active", action, createdDate: new Date(createdDate) });

const USERS = [
    user("N0000000", "2026-08-31T18:29:59Z"), // August in Colombo
    user("N0000001", "2026-08-31T18:30:00Z"), // 00:00 on 1 Sep
    user("N0000002", "2026-09-15T00:00:00Z"),
    user("N0000003", "2026-09-30T18:30:00Z"), // October
];
const SUBMISSIONS = [
    sub("aug", "2026-08-31T18:29:59Z", "VERIFIED"),
    sub("verified", "2026-08-31T18:30:00Z", "VERIFIED"),
    sub("hc", "2026-09-02T00:00:00Z", "HIGH_CONFIDENCE"),
    sub("unclear", "2026-09-03T00:00:00Z", "UNCLEAR"),                     // stored as REVIEW_REQUIRED
    sub("manual", "2026-09-04T00:00:00Z", "MANUAL_REVIEW", { pendingStoragePath: "pending/m.pdf" }),
    sub("dup", "2026-09-05T00:00:00Z", "DUPLICATE"),
    sub("fail", "2026-09-06T00:00:00Z", "FAILED"),
    sub("busy", "2026-09-07T00:00:00Z", "TEMPORARY_STORED"),
    sub("last", "2026-09-30T18:29:59Z", "CONFLICT", { pendingStoragePath: "pending/c.pdf" }),
    sub("oct", "2026-09-30T18:30:00Z", "VERIFIED"),
];
const DOCUMENTS = [
    doc("d-aug", "2026-08-31T18:29:59Z", "REVIEW_REQUIRED"),
    doc("d-unclear", "2026-09-03T00:00:00Z", "REVIEW_REQUIRED"),
    doc("d-verified", "2026-08-31T18:30:00Z", "VERIFIED"),
    doc("d-upload", "2026-09-10T00:00:00Z", "VERIFIED"),
];
const AUDIT = [
    audit("up-aug", "UPLOAD_DOCUMENT", "2026-08-31T18:29:59Z"),
    audit("up-1", "UPLOAD_DOCUMENT", "2026-09-10T00:00:00Z"),
    audit("up-2", "UPLOAD_DOCUMENT", "2026-09-11T00:00:00Z"),
    audit("rm-1", "REMOVE_FROM_REVIEW", "2026-09-12T00:00:00Z"),
    audit("rm-oct", "REMOVE_FROM_REVIEW", "2026-09-30T18:30:00Z"),
    audit("approve", "APPROVE", "2026-09-13T00:00:00Z"),
];
const ADMINS = [{ adminId: "admin-active", name: "Active Admin", email: "a@example.invalid", passwordHash: "x", role: "ADMIN", status: "ACTIVE" }];
const monthDb = () => createFakeReviewDb({ admins: ADMINS, users: USERS, temporaryData: SUBMISSIONS, documents: DOCUMENTS, auditLogs: AUDIT });

describe("monthly overview: figures", () => {
    test("counts only that business month in Sri Lanka", async () => {
        const report = await getMonthlyOverview({ db: monthDb().client, month: "2026-09", now: NOW });
        assert.equal(report.month, "2026-09");
        assert.equal(report.isCurrentMonth, false);
        assert.deepEqual(report.range, { start: "2026-08-31T18:30:00.000Z", end: "2026-09-30T18:30:00.000Z" });
        assert.equal(report.candidatesRegistered, 2);
        // 8 WhatsApp submissions + 2 admin uploads; stored WhatsApp files are not counted again.
        assert.deepEqual(report.sources, { whatsappSubmissions: 8, adminUploads: 2 });
        assert.equal(report.documentsSubmitted, 10);
        // Daily Report rule (all but FAILED and still processing) + admin uploads.
        assert.equal(report.successfullyProcessed, 8);
        assert.equal(report.pending, 1);
        assert.equal(report.rejected, 1);
        // 2 files waiting in pending/ + 1 stored REVIEW_REQUIRED document.
        assert.equal(report.manualReview, 3);
    });

    test("an empty month: zeros, not all-time values", async () => {
        const report = await getMonthlyOverview({ db: monthDb().client, month: "2026-07", now: NOW });
        for (const key of ["candidatesRegistered", "documentsSubmitted", "successfullyProcessed", "pending", "rejected", "manualReview"]) {
            assert.equal(report[key], 0, key);
        }
    });

    test("counts are aggregated in the database, never by loading rows", async () => {
        const db = monthDb();
        await getMonthlyOverview({ db: db.client, month: "2026-09", now: NOW });
        const methods = db.calls.map((c) => c.method.split(".").pop());
        assert.ok(methods.length > 0, "the queries are recorded");
        assert.ok(methods.every((m) => m === "count" || m === "groupBy"), `only count/groupBy, got: ${methods.join(", ")}`);
    });
});

describe("GET /api/admin/reports/monthly", () => {
    let server;
    let base;
    before(async () => {
        const db = monthDb();
        const app = createApp({ adminApiRouter: createAdminRouter({ apiLimiter: (req, res, next) => next(), db: db.client, requireAdmin: createRequireActiveAdmin({ db: db.client }) }) });
        server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
        base = `http://127.0.0.1:${server.address().port}/api/admin`;
    });
    after(() => server.close());
    const token = jwt.sign({ adminId: "admin-active" }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
    const get = async (p, t = token) => {
        const response = await fetch(`${base}${p}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
        return { status: response.status, body: await response.json() };
    };

    test("returns the selected month as counts only; 400 for bad months; 401 without a session", async () => {
        const { status, body } = await get("/reports/monthly?month=2026-09");
        assert.equal(status, 200);
        assert.equal(body.documentsSubmitted, 10);
        assert.deepEqual(Object.keys(body).sort(), [
            "candidatesRegistered", "documentsSubmitted", "isCurrentMonth", "manualReview", "month", "pending",
            "range", "rejected", "sources", "successfullyProcessed", "thisMonth", "timeZone",
        ]);
        assert.equal((await get("/reports/monthly")).status, 200);
        const bad = await get("/reports/monthly?month=2999-01");
        assert.equal(bad.status, 400);
        assert.equal(bad.body.errors[0].field, "month");
        assert.equal((await get("/reports/monthly?month=september")).status, 400);
        assert.equal((await get("/reports/monthly", null)).status, 401);
    });
});
