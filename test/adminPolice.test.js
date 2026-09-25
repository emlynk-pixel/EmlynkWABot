import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import jwt from "jsonwebtoken";

import { createAdminRouter } from "../src/routes/admin.js";
import { createRequireActiveAdmin } from "../src/middleware/requireActiveAdmin.js";
import {
    POLICE_STATUS,
    POLICE_STATUS_ORDER,
    DUE_SOON_DAYS,
    daysBetween,
    policeCountdown,
    statusForDaysLeft,
    toYmd,
} from "../src/services/policeCountdownService.js";
import { listPoliceWorkflow, parsePoliceListQuery } from "../src/services/adminPoliceService.js";
import { parseReviewActionBody } from "../src/services/adminReviewActionService.js";
import { sha256Hex } from "../src/utils/fileChecksum.js";
import { createFakeReviewDb } from "./helpers/fakeReviewDb.js";
import { createFakeBucket } from "./helpers/fakeStorage.js";

Object.assign(process.env, {
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-placeholder",
    DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
    META_APP_SECRET: "test-app-secret-placeholder",
    JWT_SECRET: "test-jwt-secret-placeholder-0123456789",
});
const { createApp } = await import("../src/createApp.js");

// Synthetic data only. "Today" in these tests is 2026-09-25 in Sri Lanka.
const TODAY = "2026-09-25";
const date = (ymd) => new Date(`${ymd}T00:00:00.000Z`); // as Prisma returns a DATE column
const addDays = (ymd, days) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
// The submitted date that leaves `daysLeft` days until the 21-day due date.
const submittedFor = (daysLeft) => addDays(TODAY, daysLeft - 21);

const slip = (overrides = {}) => ({ documentId: "slip-1", verificationStatus: "VERIFIED", policeSubmittedDate: date(submittedFor(10)), receivedDate: new Date("2026-09-10T03:00:00Z"), ...overrides });
const report = (overrides = {}) => ({ documentId: "report-1", verificationStatus: "VERIFIED", receivedDate: new Date("2026-09-20T03:00:00Z"), ...overrides });

describe("police countdown (pure)", () => {
    test("thresholds in calendar days: >7 PENDING, 1-7 DUE_SOON, 0 DUE_TODAY, <0 OVERDUE", () => {
        assert.equal(DUE_SOON_DAYS, 7);
        const cases = [[30, "PENDING"], [8, "PENDING"], [7, "DUE_SOON"], [3, "DUE_SOON"], [1, "DUE_SOON"], [0, "DUE_TODAY"], [-1, "OVERDUE"], [-40, "OVERDUE"]];
        for (const [daysLeft, expected] of cases) {
            assert.equal(statusForDaysLeft(daysLeft), expected, `${daysLeft} days`);
            const result = policeCountdown({ slips: [slip({ policeSubmittedDate: date(submittedFor(daysLeft)) })], today: TODAY });
            assert.equal(result.status, expected, `${daysLeft} days (countdown)`);
            assert.equal(result.daysRemaining, daysLeft);
            assert.equal(result.submittedDate, submittedFor(daysLeft));
            assert.equal(result.dueDate, addDays(submittedFor(daysLeft), 21));
        }
    });

    test("due date is submitted + 21 days across month, year and leap-year boundaries", () => {
        assert.equal(policeCountdown({ slips: [slip({ policeSubmittedDate: date("2026-12-20") })], today: "2027-01-10" }).status, "DUE_TODAY");
        assert.equal(policeCountdown({ slips: [slip({ policeSubmittedDate: date("2028-02-15") })], today: "2028-03-07" }).dueDate, "2028-03-07");
        assert.equal(daysBetween("2026-09-25", "2026-10-02"), 7);
        assert.equal(daysBetween("2026-10-02", "2026-09-25"), -7);
    });

    test("no slip -> NOT_UPLOADED; slip without a date or waiting in pending/ -> DATE_MISSING", () => {
        assert.deepEqual(
            policeCountdown({ today: TODAY }),
            { status: "NOT_UPLOADED", submittedDate: null, dueDate: null, daysRemaining: null, slip: null, report: null, slipAwaitingReview: false }
        );
        const undated = policeCountdown({ slips: [slip({ policeSubmittedDate: null })], today: TODAY });
        assert.equal(undated.status, "DATE_MISSING");
        assert.equal(undated.slip.documentId, "slip-1");
        assert.equal(undated.slipAwaitingReview, false);
        const waiting = policeCountdown({ pendingSlips: 1, today: TODAY });
        assert.equal(waiting.status, "DATE_MISSING");
        assert.equal(waiting.slipAwaitingReview, true);
    });

    test("a VERIFIED police report completes the workflow, even one received before the slip; the countdown stops", () => {
        const overdueSlip = slip({ policeSubmittedDate: date(submittedFor(-5)) });
        const completed = policeCountdown({ slips: [overdueSlip], reports: [report()], today: TODAY });
        assert.equal(completed.status, "COMPLETED");
        assert.equal(completed.daysRemaining, null);
        assert.equal(completed.report.documentId, "report-1");
        assert.equal(completed.submittedDate, submittedFor(-5), "the slip is still shown");

        const early = policeCountdown({ slips: [slip({ receivedDate: new Date("2026-09-24T00:00:00Z") })], reports: [report({ receivedDate: new Date("2026-08-01T00:00:00Z") })], today: TODAY });
        assert.equal(early.status, "COMPLETED");
        assert.equal(policeCountdown({ reports: [report()], today: TODAY }).status, "COMPLETED", "report without any slip");
    });

    test("a REVIEW_REQUIRED police report does not complete it", () => {
        const result = policeCountdown({ slips: [slip({ policeSubmittedDate: date(submittedFor(-2)) })], reports: [report({ verificationStatus: "REVIEW_REQUIRED" })], today: TODAY });
        assert.equal(result.status, "OVERDUE");
        assert.equal(result.report, null);
    });

    test("a REVIEW_REQUIRED slip with a readable date starts the countdown", () => {
        const result = policeCountdown({ slips: [slip({ verificationStatus: "REVIEW_REQUIRED", policeSubmittedDate: date(submittedFor(5)) })], today: TODAY });
        assert.equal(result.status, "DUE_SOON");
        assert.equal(result.slip.verificationStatus, "REVIEW_REQUIRED");
    });

    test("several slips: the latest submitted date counts", () => {
        const result = policeCountdown({
            slips: [
                slip({ documentId: "old", policeSubmittedDate: date(submittedFor(-10)) }),
                slip({ documentId: "new", verificationStatus: "REVIEW_REQUIRED", policeSubmittedDate: date(submittedFor(12)) }),
                slip({ documentId: "undated", policeSubmittedDate: null, receivedDate: new Date("2026-09-24T00:00:00Z") }),
            ],
            today: TODAY,
        });
        assert.equal(result.slip.documentId, "new");
        assert.equal(result.status, "PENDING");
    });

    test("DATE columns and strings are read as YYYY-MM-DD", () => {
        assert.equal(toYmd(date("2026-09-01")), "2026-09-01");
        assert.equal(toYmd("2026-09-01"), "2026-09-01");
        assert.equal(toYmd("2026-02-30"), null);
        assert.equal(toYmd(null), null);
    });
});

// ---------------------------------------------------------------- API

const ADMINS = [
    { adminId: "admin-active", name: "Active Admin", email: "a@example.invalid", passwordHash: "x", role: "ADMIN", status: "ACTIVE" },
    { adminId: "admin-inactive", name: "Inactive Admin", email: "i@example.invalid", passwordHash: "x", role: "ADMIN", status: "INACTIVE" },
];
const user = (n, extra = {}) => ({ passportId: `N000000${n}`, uniqueId: `000${n}`, firstName: `CLIENT ${n}`, otherName: null, createdDate: new Date("2026-09-01T00:00:00Z"), updatedDate: new Date("2026-09-01T00:00:00Z"), ...extra });
const doc = (n, passportId, documentType, extra = {}) => ({
    documentId: `${n}${n}${n}${n}${n}${n}${n}${n}-0000-4000-8000-00000000000${n}`, passportId, documentType, originalFilename: "f.pdf", storedFilename: "f.pdf",
    storagePath: `clients/${passportId}/x/f${n}.pdf`, mimeType: "application/pdf", fileSize: 10n, receivedDate: new Date("2026-09-10T03:00:00Z"),
    processingStatus: "STORED", verificationStatus: "VERIFIED", ocrConfidence: 90, fileSha256: String(n).repeat(64), temporaryId: null, policeSubmittedDate: null, ...extra,
});
const tokenFor = (adminId) => jwt.sign({ adminId }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });

// One client per status (all relative to the real "today" so the API's clock can be used).
function policeFixture() {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const submitted = (daysLeft) => date(addDays(today, daysLeft - 21));
    return createFakeReviewDb({
        admins: ADMINS,
        users: [1, 2, 3, 4, 5, 6, 7].map((n) => user(n)),
        documents: [
            doc(1, "N0000001", "POLICE_SLIP", { policeSubmittedDate: submitted(-3) }),            // OVERDUE
            doc(2, "N0000002", "POLICE_SLIP", { policeSubmittedDate: submitted(0) }),             // DUE_TODAY
            doc(3, "N0000003", "POLICE_SLIP", { policeSubmittedDate: submitted(4), verificationStatus: "REVIEW_REQUIRED" }), // DUE_SOON
            doc(4, "N0000004", "POLICE_SLIP", { policeSubmittedDate: submitted(15) }),            // PENDING
            doc(5, "N0000005", "POLICE_SLIP", { policeSubmittedDate: submitted(-9) }),            // COMPLETED (report below)
            doc(6, "N0000005", "POLICE_REPORT"),
            doc(7, "N0000006", "POLICE_REPORT", { verificationStatus: "REVIEW_REQUIRED" }),      // NOT_UPLOADED (report not verified, no slip)
            doc(8, "N0000001", "PASSPORT"),
        ],
        temporaryData: [
            // client 7: a slip waiting in pending/ -> DATE_MISSING
            { temporaryId: "99999999-0000-4000-8000-000000000001", passportId: "N0000007", uniqueId: "0007", whatsappNumber: "94700000007", documentType: "POLICE_SLIP", temporaryStoragePath: "temporary/x", processingStatus: "MANUAL_REVIEW", createdDate: new Date(), pendingStoragePath: "pending/0007/undefined/uncleared-docs/a.pdf", reviewReason: "POLICE_DATE_UNRESOLVED" },
        ],
    });
}

async function start(db, bucket = createFakeBucket([])) {
    const app = createApp({ adminApiRouter: createAdminRouter({ db: db.client, bucket, requireAdmin: createRequireActiveAdmin({ db: db.client }) }) });
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/admin`;
    const call = async (method, path, { body, token = tokenFor("admin-active") } = {}) => {
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        if (body !== undefined) headers["Content-Type"] = "application/json";
        const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, body: await response.json().catch(() => null) };
    };
    return { server, call };
}

describe("GET /api/admin/police", () => {
    let http;
    let db;
    before(async () => { db = policeFixture(); http = await start(db); });
    after(() => http.server.close());

    test("every client's status, most urgent first, with counts per status", async () => {
        const { status, body } = await http.call("GET", "/police");
        assert.equal(status, 200);
        assert.deepEqual(body.items.map((i) => [i.client.passportId, i.status]), [
            ["N0000001", "OVERDUE"], ["N0000002", "DUE_TODAY"], ["N0000003", "DUE_SOON"], ["N0000004", "PENDING"],
            ["N0000007", "DATE_MISSING"], ["N0000006", "NOT_UPLOADED"], ["N0000005", "COMPLETED"],
        ]);
        assert.deepEqual(body.summary, { total: 7, byStatus: { OVERDUE: 1, DUE_TODAY: 1, DUE_SOON: 1, PENDING: 1, DATE_MISSING: 1, NOT_UPLOADED: 1, COMPLETED: 1 } });
        const overdue = body.items[0];
        assert.equal(overdue.daysRemaining, -3);
        assert.equal(overdue.client.name, "CLIENT 1");
        assert.equal(body.items.find((i) => i.status === "DATE_MISSING").slipAwaitingReview, true);
        assert.match(body.businessDate, /^\d{4}-\d{2}-\d{2}$/);
        assert.ok(!JSON.stringify(body).includes("clients/"), "no storage paths");
    });

    test("status filter and paging; the summary still counts everyone", async () => {
        const { body } = await http.call("GET", "/police?status=DUE_SOON");
        assert.deepEqual(body.items.map((i) => i.client.passportId), ["N0000003"]);
        assert.equal(body.summary.total, 7);
        assert.equal(body.pagination.total, 1);
        const page2 = await http.call("GET", "/police?page=2&pageSize=3");
        assert.deepEqual(page2.body.items.map((i) => i.status), ["PENDING", "DATE_MISSING", "NOT_UPLOADED"]);
        assert.equal(page2.body.pagination.totalPages, 3);
    });

    test("invalid parameters -> 400 with field messages", async () => {
        for (const query of ["status=LATE", "page=0", "pageSize=101", "status=DUE_SOON&status=OVERDUE", "passportId=../x"]) {
            const { status, body } = await http.call("GET", `/police?${query}`);
            assert.equal(status, 400, query);
            assert.ok(body.errors.length, query);
        }
        assert.deepEqual(parsePoliceListQuery({}).params, { page: 1, pageSize: 25 });
        assert.deepEqual(POLICE_STATUS_ORDER, ["OVERDUE", "DUE_TODAY", "DUE_SOON", "PENDING", "DATE_MISSING", "NOT_UPLOADED", "COMPLETED"]);
    });

    test("needs an ACTIVE admin", async () => {
        assert.equal((await http.call("GET", "/police", { token: null })).status, 401);
        assert.equal((await http.call("GET", "/police", { token: tokenFor("admin-inactive") })).status, 401);
    });

    test("read-only: no writes, three queries whatever the number of clients", async () => {
        const before = db.calls.length;
        await http.call("GET", "/police");
        const calls = db.calls.slice(before).filter((c) => !c.method.startsWith("admin"));
        assert.deepEqual(calls.map((c) => c.method).sort(), ["document.findMany", "temporaryData.groupBy", "user.findMany"]);
    });

    test("overview counts police reports due soon, due today and overdue", async () => {
        const { status, body } = await http.call("GET", "/overview");
        assert.equal(status, 200);
        assert.deepEqual(body.police, { dueSoon: 1, dueToday: 1, overdue: 1 });
    });

    test("client details carry the countdown", async () => {
        let { body } = await http.call("GET", "/clients/N0000001");
        assert.equal(body.police.countdown.status, "OVERDUE");
        assert.equal(body.police.countdown.daysRemaining, -3);
        assert.equal(body.police.latestSlip.policeSubmittedDate, body.police.countdown.submittedDate);
        ({ body } = await http.call("GET", "/clients/N0000005"));
        assert.equal(body.police.countdown.status, "COMPLETED");
        ({ body } = await http.call("GET", "/clients/N0000007"));
        assert.equal(body.police.countdown.status, "DATE_MISSING");
        assert.equal(body.police.countdown.slipAwaitingReview, true);
    });
});

describe("Sri Lanka calendar day", () => {
    test("the day changes at midnight in Colombo (18:30 UTC), not at UTC midnight", async () => {
        const db = createFakeReviewDb({ users: [user(1)], documents: [doc(1, "N0000001", "POLICE_SLIP", { policeSubmittedDate: date("2026-09-04") })] }); // due 2026-09-25
        const at = (iso) => listPoliceWorkflow({ db: db.client, params: { page: 1, pageSize: 25 }, now: new Date(iso) }).then((r) => r.items[0]);
        assert.deepEqual([(await at("2026-09-24T18:29:00Z")).status, (await at("2026-09-24T18:29:00Z")).daysRemaining], ["DUE_SOON", 1]);
        assert.deepEqual([(await at("2026-09-24T18:31:00Z")).status, (await at("2026-09-24T18:31:00Z")).daysRemaining], ["DUE_TODAY", 0]);
        assert.equal((await at("2026-09-25T18:31:00Z")).status, "OVERDUE");
    });
});

// ---------------------------------------------------------------- approving a police slip

const TEMP_SLIP = "11111111-1111-4111-8111-111111111111";
const DOC_SLIP = "22222222-2222-4222-8222-222222222222";
const PENDING_PATH = "pending/0001/undefined/uncleared-docs/document_20260924_010000.pdf";
const FILE = Buffer.from("%PDF-1.4 synthetic police slip");

function slipFixture({ storedSlip = null, pendingSlip = true } = {}) {
    const db = createFakeReviewDb({
        admins: ADMINS,
        users: [user(1)],
        temporaryData: pendingSlip ? [{
            temporaryId: TEMP_SLIP, passportId: "N0000001", uniqueId: "0001", whatsappNumber: "94700000001", documentType: "POLICE_SLIP",
            temporaryStoragePath: "temporary/s.pdf", processingStatus: "MANUAL_REVIEW", createdDate: new Date("2026-09-24T01:00:00Z"),
            pendingStoragePath: PENDING_PATH, fileSha256: sha256Hex(FILE), reviewReason: "POLICE_DATE_UNRESOLVED", processingSummary: { confidence: { document: 80 } },
        }] : [],
        documents: storedSlip ? [storedSlip] : [],
    });
    const bucket = createFakeBucket([PENDING_PATH, "clients/N0000001/police-slip/s.pdf"]);
    bucket.download = async (p) => (bucket.has(p) ? { data: FILE, error: null } : { data: null, error: { message: "not found" } });
    return { db, bucket };
}

describe("approving a police slip with its submitted date", () => {
    test("body: the date must be a real date from 2000 up to today (Sri Lanka)", () => {
        const now = new Date("2026-09-25T06:00:00Z");
        const parse = (value) => parseReviewActionBody({ policeSubmittedDate: value }, { reasonRequired: false, acceptsPoliceDate: true, now });
        assert.equal(parse("2026-09-01").policeSubmittedDate, "2026-09-01");
        assert.equal(parse("2026-09-25").policeSubmittedDate, "2026-09-25");
        for (const bad of ["2026-09-26", "1999-12-31", "2026-02-30", "01/09/2026", 20260901]) {
            assert.equal(parse(bad).errors?.[0].field, "policeSubmittedDate", String(bad));
        }
        assert.equal(parseReviewActionBody({ policeSubmittedDate: "2026-09-01" }, { reasonRequired: true }).errors[0].field, "reason", "Keep Pending ignores the date");
    });

    test("a waiting slip needs the date; with it the document and the audit entry both record it", async () => {
        const { db, bucket } = slipFixture();
        const http = await start(db, bucket);
        try {
            const detail = await http.call("GET", `/review/pending-${TEMP_SLIP}`);
            assert.equal(detail.body.actions.approve.needsPoliceDate, true);

            const missing = await http.call("POST", `/review/pending-${TEMP_SLIP}/approve`, { body: {} });
            assert.equal(missing.status, 400);
            assert.equal(missing.body.code, "POLICE_DATE_REQUIRED");
            assert.equal(db.tables.document.length, 0);
            assert.equal(db.tables.auditLog.length, 0);
            assert.ok(bucket.has(PENDING_PATH));

            const ok = await http.call("POST", `/review/pending-${TEMP_SLIP}/approve`, { body: { policeSubmittedDate: "2026-09-10" } });
            assert.equal(ok.status, 200);
            assert.equal(ok.body.document.policeSubmittedDate, "2026-09-10");
            assert.equal(ok.body.audit.policeSubmittedDate, "2026-09-10");
            assert.equal(toYmd(db.tables.document[0].policeSubmittedDate), "2026-09-10");
            assert.equal(db.tables.document[0].verificationStatus, "VERIFIED");
            assert.equal(toYmd(db.tables.auditLog[0].policeSubmittedDate), "2026-09-10");
            assert.equal(db.tables.auditLog[0].adminId, "admin-active");

            // The countdown now runs from that date.
            const client = await http.call("GET", "/clients/N0000001");
            assert.equal(client.body.police.countdown.submittedDate, "2026-09-10");
            assert.equal(client.body.police.countdown.dueDate, "2026-10-01");
        } finally { http.server.close(); }
    });

    test("a stored slip whose date OCR read: confirmed as is; a different date is refused", async () => {
        const stored = doc(2, "N0000001", "POLICE_SLIP", { documentId: DOC_SLIP, verificationStatus: "REVIEW_REQUIRED", policeSubmittedDate: date("2026-09-05"), storagePath: "clients/N0000001/police-slip/s.pdf" });
        const { db, bucket } = slipFixture({ storedSlip: stored, pendingSlip: false });
        const http = await start(db, bucket);
        try {
            const detail = await http.call("GET", `/review/document-${DOC_SLIP}`);
            assert.equal(detail.body.document.policeSubmittedDate, "2026-09-05");
            assert.equal(detail.body.actions.approve.needsPoliceDate, false);

            const different = await http.call("POST", `/review/document-${DOC_SLIP}/approve`, { body: { policeSubmittedDate: "2026-09-06" } });
            assert.equal(different.status, 409);
            assert.equal(different.body.code, "POLICE_DATE_ALREADY_SET");
            assert.equal(db.tables.document[0].verificationStatus, "REVIEW_REQUIRED");
            assert.equal(db.tables.auditLog.length, 0);

            const confirmed = await http.call("POST", `/review/document-${DOC_SLIP}/approve`, { body: {} });
            assert.equal(confirmed.status, 200);
            assert.equal(toYmd(db.tables.document[0].policeSubmittedDate), "2026-09-05");
            assert.equal(toYmd(db.tables.auditLog[0].policeSubmittedDate), "2026-09-05", "the confirmed date is recorded");
        } finally { http.server.close(); }
    });

    test("a stored slip without a date (older record) gets the entered date", async () => {
        const stored = doc(2, "N0000001", "POLICE_SLIP", { documentId: DOC_SLIP, verificationStatus: "REVIEW_REQUIRED", storagePath: "clients/N0000001/police-slip/s.pdf" });
        const { db, bucket } = slipFixture({ storedSlip: stored, pendingSlip: false });
        const http = await start(db, bucket);
        try {
            assert.equal((await http.call("POST", `/review/document-${DOC_SLIP}/approve`, { body: {} })).body.code, "POLICE_DATE_REQUIRED");
            const ok = await http.call("POST", `/review/document-${DOC_SLIP}/approve`, { body: { policeSubmittedDate: "2026-09-02" } });
            assert.equal(ok.status, 200);
            assert.equal(toYmd(db.tables.document[0].policeSubmittedDate), "2026-09-02");
        } finally { http.server.close(); }
    });

    test("other document types take no date; the one-verified-slip rule still applies", async () => {
        const passportDb = createFakeReviewDb({
            admins: ADMINS, users: [user(1)],
            documents: [doc(3, "N0000001", "MEDICAL", { documentId: DOC_SLIP, verificationStatus: "REVIEW_REQUIRED" })],
        });
        let http = await start(passportDb);
        try {
            const response = await http.call("POST", `/review/document-${DOC_SLIP}/approve`, { body: { policeSubmittedDate: "2026-09-02" } });
            assert.equal(response.status, 400);
            assert.equal(response.body.code, "POLICE_DATE_NOT_APPLICABLE");
        } finally { http.server.close(); }

        const { db, bucket } = slipFixture({ storedSlip: doc(4, "N0000001", "POLICE_SLIP", { policeSubmittedDate: date("2026-08-01") }) });
        http = await start(db, bucket);
        try {
            const blocked = await http.call("POST", `/review/pending-${TEMP_SLIP}/approve`, { body: { policeSubmittedDate: "2026-09-10" } });
            assert.equal(blocked.status, 409);
            assert.equal(blocked.body.code, "VERIFIED_DOCUMENT_EXISTS");
            assert.equal(db.tables.auditLog.length, 0);
        } finally { http.server.close(); }
    });
});

describe("migration 20260925170000_phase10_police_submitted_date", () => {
    const sql = fs.readFileSync(new URL("../prisma/migrations/20260925170000_phase10_police_submitted_date/migration.sql", import.meta.url), "utf8");
    const code = sql.replace(/--.*$/gm, "");
    const schema = fs.readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

    test("additive: two nullable DATE columns, nothing else", () => {
        const statements = code.split(";").map((s) => s.trim()).filter(Boolean);
        assert.deepEqual(statements.map((s) => s.replace(/\s+/g, " ")), [
            'ALTER TABLE "documents" ADD COLUMN "police_submitted_date" DATE',
            'ALTER TABLE "audit_logs" ADD COLUMN "police_submitted_date" DATE',
        ]);
        assert.match(schema, /policeSubmittedDate DateTime\? @map\("police_submitted_date"\) @db\.Date/);
    });

    test("no stored alert or reminder data: the status is always calculated", () => {
        assert.doesNotMatch(schema, /police_status|reminder|alert/i);
        assert.deepEqual(Object.keys(POLICE_STATUS).sort(), ["COMPLETED", "DATE_MISSING", "DUE_SOON", "DUE_TODAY", "NOT_UPLOADED", "OVERDUE", "PENDING"]);
    });
});
