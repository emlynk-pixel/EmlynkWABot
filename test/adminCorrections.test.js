import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import jwt from "jsonwebtoken";

import { createAdminRouter } from "../src/routes/admin.js";
import { createRequireActiveAdmin } from "../src/middleware/requireActiveAdmin.js";
import { parsePoliceDateBody, SETTABLE_DOCUMENT_TYPES } from "../src/services/adminCorrectionService.js";
import { getClientDetails } from "../src/services/adminDashboardService.js";
import { listPoliceWorkflow } from "../src/services/adminPoliceService.js";
import { businessDateOf } from "../src/utils/businessDay.js";
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

// Synthetic data only.
const TEMP = "11111111-1111-4111-8111-111111111111";
const DOC = "33333333-3333-4333-8333-333333333333";
const SLIP = "55555555-5555-4555-8555-555555555555";
const FILE = Buffer.from("synthetic file");
const PENDING_PATH = "pending/94770000009/undefined/uncleared-docs/document_20260924_063000.pdf";
const ADMINS = [
    { adminId: "admin-active", name: "Active Admin", email: "a@example.invalid", passwordHash: "x", role: "ADMIN", status: "ACTIVE" },
    { adminId: "admin-inactive", name: "Inactive Admin", email: "i@example.invalid", passwordHash: "x", role: "ADMIN", status: "INACTIVE" },
];
const USERS = [
    { passportId: "N1234567", uniqueId: "0001", firstName: "KAMAL", otherName: null, whatsappNumber: "94770000001" },
    { passportId: "N7654321", uniqueId: "0002", firstName: "SAMAN", otherName: null, whatsappNumber: null },
];
const pendingRow = (overrides = {}) => ({
    temporaryId: TEMP, passportId: null, uniqueId: null, whatsappNumber: "94770000009", documentType: "UNKNOWN",
    temporaryStoragePath: "temporary/aaaa.pdf", processingStatus: "UNDEFINED", createdDate: new Date("2026-09-24T01:00:00Z"),
    fileSha256: sha256Hex(FILE), pendingStoragePath: PENDING_PATH,
    processingSummary: { identity: { status: "UNIDENTIFIED", reviewRequired: true, provisional: false, notes: [] } },
    reviewReason: "DOCUMENT_TYPE_UNCLEAR", ...overrides,
});
const storedDoc = (overrides = {}) => ({
    documentId: DOC, passportId: "N1234567", documentType: "MEDICAL", originalFilename: "scan.pdf", storedFilename: "scan.pdf",
    storagePath: "clients/N1234567/medical/scan.pdf", mimeType: "application/pdf", fileSize: 10n, receivedDate: new Date("2026-09-20T03:00:00Z"),
    processingStatus: "STORED", verificationStatus: "REVIEW_REQUIRED", ocrConfidence: 50, fileSha256: "b".repeat(64), temporaryId: null, policeSubmittedDate: null,
    ...overrides,
});
const verifiedSlip = (overrides = {}) => storedDoc({
    documentId: SLIP, documentType: "POLICE_SLIP", verificationStatus: "VERIFIED", storagePath: "clients/N1234567/police/police_slip.pdf",
    storedFilename: "police_slip.pdf", fileSha256: "d".repeat(64), ...overrides,
});

function setup({ temporaryData = [pendingRow()], documents = [storedDoc(), verifiedSlip()] } = {}) {
    const db = createFakeReviewDb({ admins: ADMINS, users: USERS, temporaryData, documents });
    const bucket = createFakeBucket([PENDING_PATH]);
    bucket.download = async (p) => (bucket.has(p) ? { data: FILE, error: null } : { data: null, error: { message: "not found" } });
    return { db, bucket };
}

const tokenFor = (adminId) => jwt.sign({ adminId }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
let server;
let base;
let current;
before(async () => {
    const app = createApp({ adminApiRouter: (req, res, next) => current.router(req, res, next) });
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}/api/admin`;
});
after(() => server.close());
function use(fixture) {
    current = { ...fixture, router: createAdminRouter({ db: fixture.db.client, bucket: fixture.bucket, requireAdmin: createRequireActiveAdmin({ db: fixture.db.client }) }) };
    return fixture;
}
async function call(method, path, { body, token = tokenFor("admin-active") } = {}) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
}
const setType = (documentType, reason = "Content is a medical report", id = `pending-${TEMP}`) => call("POST", `/review/${id}/document-type`, { body: { documentType, reason } });
const assign = (passportId, reason = "Client confirmed by phone", id = `pending-${TEMP}`) => call("POST", `/review/${id}/assign-client`, { body: { passportId, reason } });
const setDate = (policeSubmittedDate, reason = "Date read from the slip", id = SLIP) => call("POST", `/documents/${id}/police-date`, { body: { policeSubmittedDate, reason } });

describe("POST /review/:reviewId/document-type", () => {
    test("sets the type; the file stays pending and in the queue; audited with before and after", async () => {
        const { db, bucket } = use(setup());
        const response = await setType("MEDICAL");
        assert.equal(response.status, 200);
        assert.equal(response.body.action, "SET_DOCUMENT_TYPE");
        assert.equal(response.body.documentType, "MEDICAL");
        assert.equal(response.body.audit.previousValue, "UNKNOWN");
        assert.equal(response.body.audit.newValue, "MEDICAL");

        const [row] = db.tables.temporaryData;
        assert.equal(row.documentType, "MEDICAL");
        assert.equal(row.pendingStoragePath, PENDING_PATH);
        assert.equal(row.processingStatus, "UNDEFINED");
        assert.equal(row.reviewReason, "DOCUMENT_TYPE_UNCLEAR");
        assert.ok(bucket.has(PENDING_PATH));

        const [entry] = db.tables.auditLog;
        assert.equal(entry.adminId, "admin-active");
        assert.equal(entry.temporaryId, TEMP);
        assert.equal(entry.reason, "Content is a medical report");
        assert.equal(entry.previousStatus, "UNDEFINED");
        assert.equal(entry.newStatus, "UNDEFINED");

        const queue = await call("GET", "/review");
        assert.equal(queue.body.items[0].documentType, "MEDICAL");
        const detail = await call("GET", `/review/pending-${TEMP}`);
        assert.equal(detail.body.auditLog[0].action, "SET_DOCUMENT_TYPE");
    });

    test("validation: a real type and a reason", async () => {
        const { db } = use(setup());
        for (const body of [{ documentType: "UNKNOWN", reason: "x" }, { documentType: "VISA", reason: "x" }, { documentType: "MEDICAL" }, { documentType: "MEDICAL", reason: "  " }, { documentType: "MEDICAL", reason: "x".repeat(501) }, { reason: "x" }]) {
            const response = await call("POST", `/review/pending-${TEMP}/document-type`, { body });
            assert.equal(response.status, 400, JSON.stringify(body));
        }
        assert.deepEqual(SETTABLE_DOCUMENT_TYPES, ["PASSPORT", "POLICE_SLIP", "POLICE_REPORT", "MEDICAL"]);
        assert.equal(db.tables.auditLog.length, 0);
        assert.equal(db.tables.temporaryData[0].documentType, "UNKNOWN");
    });

    test("same type 409; stored document 409; unknown or FAILED 404", async () => {
        use(setup({ temporaryData: [pendingRow({ documentType: "MEDICAL" }), pendingRow({ temporaryId: "44444444-4444-4444-8444-444444444444", pendingStoragePath: null, processingStatus: "FAILED" })] }));
        assert.equal((await setType("MEDICAL")).body.code, "SAME_DOCUMENT_TYPE");
        const stored = await setType("PASSPORT", "x", `document-${DOC}`);
        assert.equal(stored.status, 409);
        assert.equal(stored.body.code, "NOT_CORRECTABLE");
        assert.equal((await setType("PASSPORT", "x", "pending-44444444-4444-4444-8444-444444444444")).status, 404);
        assert.equal((await setType("PASSPORT", "x", "pending-99999999-9999-4999-8999-999999999999")).status, 404);
        assert.equal(current.db.tables.auditLog.length, 0);
    });

    test("a failed audit write changes nothing", async () => {
        const { db } = use(setup());
        db.failNext("auditLog.create", new Error("boom"));
        assert.equal((await setType("MEDICAL")).status, 500);
        assert.equal(db.tables.temporaryData[0].documentType, "UNKNOWN");
    });
});

describe("POST /review/:reviewId/assign-client", () => {
    test("links the file to an existing client; WhatsApp number and identity summary unchanged; then Approve works", async () => {
        const { db, bucket } = use(setup({ temporaryData: [pendingRow({ documentType: "PASSPORT" })], documents: [] }));
        let detail = await call("GET", `/review/pending-${TEMP}`);
        assert.equal(detail.body.actions.approve.code, "CLIENT_NOT_IDENTIFIED");

        const response = await assign("n7654321");
        assert.equal(response.status, 200);
        assert.deepEqual(response.body.client, { passportId: "N7654321", uniqueId: "0002" });
        const [row] = db.tables.temporaryData;
        assert.equal(row.passportId, "N7654321");
        assert.equal(row.uniqueId, "0002");
        assert.equal(row.whatsappNumber, "94770000009");
        assert.equal(row.processingSummary.identity.status, "UNIDENTIFIED");
        assert.equal(row.pendingStoragePath, PENDING_PATH);
        assert.equal(db.tables.user.find((u) => u.passportId === "N7654321").whatsappNumber, null, "client record untouched");
        assert.equal(db.tables.user.length, 2, "no client created");
        const [entry] = db.tables.auditLog;
        assert.deepEqual([entry.action, entry.previousValue, entry.newValue, entry.passportId], ["ASSIGN_CLIENT", null, "N7654321", "N7654321"]);

        detail = await call("GET", `/review/pending-${TEMP}`);
        assert.equal(detail.body.client.passportId, "N7654321");
        assert.equal(detail.body.actions.approve.available, true);
        const approved = await call("POST", `/review/pending-${TEMP}/approve`, { body: {} });
        assert.equal(approved.status, 200);
        assert.equal(db.tables.document[0].passportId, "N7654321");
        assert.ok(!bucket.has(PENDING_PATH));
    });

    test("reassignment keeps the previous link in the audit entry", async () => {
        const { db } = use(setup({ temporaryData: [pendingRow({ passportId: "N1234567", uniqueId: "0001" })] }));
        assert.equal((await assign("N7654321")).status, 200);
        assert.equal(db.tables.auditLog[0].previousValue, "N1234567");
    });

    test("unknown client 409 (nothing created); same client 409; stored document 409; validation 400", async () => {
        const { db } = use(setup({ temporaryData: [pendingRow({ passportId: "N1234567", uniqueId: "0001" })] }));
        const unknown = await assign("X0000000");
        assert.equal(unknown.status, 409);
        assert.equal(unknown.body.code, "CLIENT_NOT_FOUND");
        assert.equal((await assign("N1234567")).body.code, "SAME_CLIENT");
        assert.equal((await assign("N7654321", "x", `document-${DOC}`)).body.code, "NOT_CORRECTABLE");
        for (const body of [{ passportId: "N-1", reason: "x" }, { passportId: "N7654321" }, { passportId: 7, reason: "x" }]) {
            assert.equal((await call("POST", `/review/pending-${TEMP}/assign-client`, { body })).status, 400);
        }
        assert.equal(db.tables.temporaryData[0].passportId, "N1234567");
        assert.equal(db.tables.user.length, 2);
        assert.equal(db.tables.auditLog.length, 0);
    });

    test("the admin comes from the token; inactive admins can't act", async () => {
        const { db } = use(setup());
        await call("POST", `/review/pending-${TEMP}/assign-client`, { body: { passportId: "N1234567", reason: "x", adminId: "admin-inactive" } });
        assert.equal(db.tables.auditLog[0].adminId, "admin-active");
        assert.equal((await call("POST", `/review/pending-${TEMP}/document-type`, { body: { documentType: "MEDICAL", reason: "x" }, token: tokenFor("admin-inactive") })).status, 401);
        assert.equal((await call("POST", `/review/pending-${TEMP}/document-type`, { body: { documentType: "MEDICAL", reason: "x" }, token: null })).status, 401);
    });
});

describe("POST /documents/:documentId/police-date", () => {
    const NOW = new Date();
    const TODAY = businessDateOf(NOW);
    const daysAgo = (days) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

    test("an older verified slip without a date gets one: countdown starts; client page and Police Workflow agree", async () => {
        const { db } = use(setup());
        let details = await getClientDetails({ db: db.client, passportId: "N1234567" });
        assert.equal(details.police.countdown.status, "DATE_MISSING");

        const response = await setDate(daysAgo(18));
        assert.equal(response.status, 200);
        assert.equal(response.body.policeSubmittedDate, daysAgo(18));
        const slip = db.tables.document.find((d) => d.documentId === SLIP);
        assert.equal(slip.policeSubmittedDate.toISOString().slice(0, 10), daysAgo(18));
        assert.equal(slip.verificationStatus, "VERIFIED");
        assert.equal(db.tables.document.filter((d) => d.documentType === "POLICE_SLIP").length, 1, "no new slip created");

        details = await getClientDetails({ db: db.client, passportId: "N1234567" });
        assert.equal(details.police.countdown.status, "DUE_SOON");
        assert.equal(details.police.countdown.daysRemaining, 3);
        assert.deepEqual(details.police.dateChanges.map((c) => [c.previousDate, c.newDate, c.adminName]), [[null, daysAgo(18), "Active Admin"]]);
        const police = await listPoliceWorkflow({ db: db.client, params: { page: 1, pageSize: 25, passportId: "N1234567" } });
        assert.equal(police.items[0].status, "DUE_SOON");

        const [entry] = db.tables.auditLog;
        assert.deepEqual([entry.action, entry.documentId, entry.previousValue, entry.newValue, entry.previousStatus, entry.newStatus],
            ["SET_POLICE_DATE", SLIP, null, daysAgo(18), "VERIFIED", "VERIFIED"]);
    });

    test("a wrong date can be corrected; the old one stays in the audit log", async () => {
        const { db } = use(setup({ documents: [verifiedSlip({ policeSubmittedDate: new Date(`${daysAgo(30)}T00:00:00Z`) })] }));
        assert.equal((await setDate(daysAgo(20), "Typo on the first entry")).status, 200);
        assert.equal(db.tables.auditLog[0].previousValue, daysAgo(30));
        assert.equal((await setDate(daysAgo(20))).body.code, "SAME_POLICE_DATE");
    });

    test("future dates, non-dates and dates before 2000 are refused (Sri Lanka calendar)", async () => {
        const { db } = use(setup());
        const tomorrow = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
        for (const value of [tomorrow, "2026-02-30", "25/09/2026", "1999-12-31", "", null]) {
            assert.equal((await setDate(value)).status, 400, String(value));
        }
        assert.equal((await setDate(daysAgo(1), "")).status, 400, "reason required");
        assert.equal(db.tables.auditLog.length, 0);
        // 19:00 UTC on 25 Sep is already 26 Sep in Colombo.
        const late = new Date("2026-09-25T19:00:00Z");
        assert.ok(parsePoliceDateBody({ policeSubmittedDate: "2026-09-26", reason: "x" }, { now: late }).policeSubmittedDate);
        assert.ok(parsePoliceDateBody({ policeSubmittedDate: "2026-09-27", reason: "x" }, { now: late }).errors);
    });

    test("only police slips; unknown document 404; malformed ID 400", async () => {
        use(setup());
        const notSlip = await setDate(daysAgo(3), "x", DOC);
        assert.equal(notSlip.status, 409);
        assert.equal(notSlip.body.code, "NOT_A_POLICE_SLIP");
        assert.equal((await setDate(daysAgo(3), "x", "99999999-9999-4999-8999-999999999999")).status, 404);
        assert.equal((await setDate(daysAgo(3), "x", "not a uuid!")).status, 400);
        assert.equal(current.db.tables.auditLog.length, 0);
    });
});

describe("corrections: nothing is removed or rejected", () => {
    test("the correction service never deletes, moves or creates files, rows or clients", () => {
        const code = fs.readFileSync(new URL("../src/services/adminCorrectionService.js", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
        assert.ok(!/\.delete(Many)?\(|removeObject|copyToFreeName|\.create\(|user\.update|reject/i.test(code.replace(/createAudit/g, "")));
    });
});
