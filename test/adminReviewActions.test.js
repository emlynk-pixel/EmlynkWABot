import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import jwt from "jsonwebtoken";

import { createAdminRouter } from "../src/routes/admin.js";
import { createRequireActiveAdmin } from "../src/middleware/requireActiveAdmin.js";
import {
    REVIEW_ACTION,
    DUPLICATE_ACTION_WINDOW_MS,
    MAX_REASON_LENGTH,
    parseReviewActionBody,
} from "../src/services/adminReviewActionService.js";
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
const TEMP_2 = "22222222-2222-4222-8222-222222222222";
const TEMP_FAILED = "44444444-4444-4444-8444-444444444444";
const TEMP_UNLINKED = "55555555-5555-4555-8555-555555555555";
const DOC_REVIEW = "33333333-3333-4333-8333-333333333333";
const DOC_VERIFIED = "66666666-6666-4666-8666-666666666666";
const PASSPORT = "N1234567";
const PENDING_PATH = "pending/0001/undefined/uncleared-docs/document_20260924_063000.pdf";
const FILE = Buffer.from("%PDF-1.4 synthetic passport scan");
const ADMINS = [
    { adminId: "admin-active", name: "Active Admin", email: "a@example.invalid", passwordHash: "x", role: "ADMIN", status: "ACTIVE" },
    { adminId: "admin-other", name: "Other Admin", email: "o@example.invalid", passwordHash: "x", role: "ADMIN", status: "ACTIVE" },
    { adminId: "admin-inactive", name: "Inactive Admin", email: "i@example.invalid", passwordHash: "x", role: "ADMIN", status: "INACTIVE" },
];
const USER = { passportId: PASSPORT, uniqueId: "0001", firstName: "KAMAL NIMAL", otherName: "PERERA" };
const SUMMARY = { stage: "COMPLETED", confidence: { extraction: 71, classification: 100, document: 71.456, band: "SLIGHTLY_UNCLEAR", flags: [] } };

const pendingRow = (overrides = {}) => ({
    temporaryId: TEMP, passportId: PASSPORT, uniqueId: "0001", whatsappNumber: "94770000000", documentType: "PASSPORT",
    temporaryStoragePath: "temporary/aaaa.pdf", processingStatus: "MANUAL_REVIEW", createdDate: new Date("2026-09-24T01:00:00Z"),
    fileSha256: sha256Hex(FILE), pendingStoragePath: PENDING_PATH, processingSummary: SUMMARY, reviewReason: "IDENTITY_NOT_CONFIRMED",
    ...overrides,
});
const documentRow = (overrides = {}) => ({
    documentId: DOC_REVIEW, passportId: PASSPORT, documentType: "MEDICAL", originalFilename: "scan.pdf", storedFilename: "scan.pdf",
    storagePath: `clients/${PASSPORT}/medical/scan.pdf`, mimeType: "application/pdf", fileSize: 2048n, receivedDate: new Date("2026-09-24T03:00:00Z"),
    processingStatus: "STORED", verificationStatus: "REVIEW_REQUIRED", ocrConfidence: 50, fileSha256: "b".repeat(64), temporaryId: null,
    ...overrides,
});

function setup({ temporaryData = [pendingRow()], documents = [], bucketPaths = [PENDING_PATH, `clients/${PASSPORT}/medical/scan.pdf`], bucketOptions = {}, files = { [PENDING_PATH]: FILE } } = {}) {
    const db = createFakeReviewDb({ admins: ADMINS, users: [USER], temporaryData, documents });
    const bucket = createFakeBucket(bucketPaths, bucketOptions);
    bucket.download = async (path) => {
        bucket.calls.push({ method: "download", path });
        return bucket.has(path) ? { data: files[path] ?? Buffer.from(`bytes of ${path}`), error: null } : { data: null, error: { message: "Object not found" } };
    };
    return { db, bucket };
}

// Holds every download until `count` have started, so concurrent requests
// really overlap (each has read the item before any of them locks it).
function holdDownloads(bucket, count) {
    const download = bucket.download;
    let waiting = [];
    bucket.download = (path) => new Promise((resolve) => {
        waiting.push(() => resolve(download(path)));
        if (waiting.length === count) { waiting.forEach((release) => release()); waiting = []; }
    });
}

const tokenFor = (adminId) => jwt.sign({ adminId }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });

let server;
let base;
let current;
before(async () => {
    // One server; each test swaps in its own fake database and bucket.
    const router = (req, res, next) => current.router(req, res, next);
    const app = createApp({ adminApiRouter: router });
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function use(fixture) {
    current = { ...fixture, router: createAdminRouter({ db: fixture.db.client, bucket: fixture.bucket, requireAdmin: createRequireActiveAdmin({ db: fixture.db.client }) }) };
    return fixture;
}

async function call(method, path, { body, token = tokenFor("admin-active"), rawBody } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined || rawBody !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${base}/api/admin${path}`, { method, headers, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, body: json };
}
const approve = (id, options) => call("POST", `/review/${id}/approve`, options);
const keepPending = (id, options) => call("POST", `/review/${id}/keep-pending`, options);

describe("migration 20260925160000_phase10_review_audit_log", () => {
    const sql = fs.readFileSync(new URL("../prisma/migrations/20260925160000_phase10_review_audit_log/migration.sql", import.meta.url), "utf8");
    const code = sql.replace(/--.*$/gm, "");
    const schema = fs.readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

    test("is additive: a new table only; no existing table is altered or dropped", () => {
        assert.doesNotMatch(code, /\bDROP\b|\bRENAME\b|\bTRUNCATE\s+(TABLE\s+)?"|^\s*(UPDATE|DELETE)\b|ALTER TABLE "(users|admins|documents|temporary_data)"/im);
        assert.match(code, /CREATE TABLE "audit_logs"/);
        assert.match(code, /FOREIGN KEY \("admin_id"\) REFERENCES "admins"\("admin_id"\) ON DELETE RESTRICT/);
    });

    test("closed to Supabase's public roles, and append-only by trigger", () => {
        assert.match(code, /ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;/);
        assert.match(code, /REVOKE ALL PRIVILEGES ON TABLE "audit_logs" FROM anon, authenticated;/);
        assert.match(code, /BEFORE UPDATE OR DELETE ON "audit_logs"\s+FOR EACH ROW/);
        assert.match(code, /BEFORE TRUNCATE ON "audit_logs"/);
        assert.match(code, /RAISE EXCEPTION/);
    });

    test("schema model matches the migration", () => {
        assert.match(schema, /model AuditLog \{/);
        assert.match(schema, /@@map\("audit_logs"\)/);
        for (const column of ["audit_id", "admin_id", "temporary_id", "document_id", "passport_id", "previous_status", "new_status", "created_date"]) {
            assert.match(schema, new RegExp(`@map\\("${column}"\\)`));
            assert.match(code, new RegExp(`"${column}"`));
        }
    });
});

describe("request body", () => {
    test("Keep Pending needs a reason; Approve's is optional; trimmed and bounded", () => {
        assert.deepEqual(parseReviewActionBody({ reason: "  blurry photo  " }, { reasonRequired: true }), { reason: "blurry photo" });
        assert.equal(parseReviewActionBody({}, { reasonRequired: true }).errors[0].field, "reason");
        assert.equal(parseReviewActionBody({ reason: "   " }, { reasonRequired: true }).errors[0].message, "is required");
        assert.equal(parseReviewActionBody(undefined, { reasonRequired: true }).errors[0].field, "reason");
        assert.equal(parseReviewActionBody({ reason: 5 }, { reasonRequired: true }).errors[0].message, "must be text");
        assert.ok(parseReviewActionBody({ reason: "x".repeat(MAX_REASON_LENGTH + 1) }, { reasonRequired: true }).errors);
        assert.deepEqual(parseReviewActionBody({ reason: "x".repeat(MAX_REASON_LENGTH) }, { reasonRequired: true }), { reason: "x".repeat(MAX_REASON_LENGTH) });
        assert.deepEqual(parseReviewActionBody(undefined, { reasonRequired: false }), { reason: null });
        assert.deepEqual(parseReviewActionBody({}, { reasonRequired: false }), { reason: null });
        assert.equal(parseReviewActionBody([], { reasonRequired: false }).errors[0].field, "body");
    });
});

describe("POST /review/:reviewId/approve (waiting file)", () => {
    test("moves the pending file to the client folder, stores a VERIFIED document, resolves the item, writes the audit entry", async () => {
        const { db, bucket } = use(setup());
        const response = await approve(`pending-${TEMP}`, { body: { reason: "Checked against the client file" } });

        assert.equal(response.status, 200);
        assert.equal(response.body.action, "APPROVE");
        assert.deepEqual(response.body.document.storedFilename, "passport.pdf");
        assert.equal(response.body.document.verificationStatus, "VERIFIED");
        assert.equal(response.body.pendingCopyRemoved, true);

        // Storage: copied under the standard name, pending original removed.
        const clientPath = `clients/${PASSPORT}/passport/passport.pdf`;
        assert.ok(bucket.has(clientPath));
        assert.ok(!bucket.has(PENDING_PATH));
        assert.deepEqual(bucket.calls.find((c) => c.method === "copy"), { method: "copy", fromPath: PENDING_PATH, toPath: clientPath });

        // Database: new VERIFIED document linked to the submission.
        assert.equal(db.tables.document.length, 1);
        const doc = db.tables.document[0];
        assert.equal(doc.documentId, response.body.document.documentId);
        assert.equal(doc.passportId, PASSPORT);
        assert.equal(doc.documentType, "PASSPORT");
        assert.equal(doc.storagePath, clientPath);
        assert.equal(doc.verificationStatus, "VERIFIED");
        assert.equal(doc.processingStatus, "STORED");
        assert.equal(doc.fileSize, BigInt(FILE.length));
        assert.equal(doc.fileSha256, sha256Hex(FILE));
        assert.equal(doc.mimeType, "application/pdf");
        assert.equal(doc.ocrConfidence, 71.46);
        assert.equal(doc.temporaryId, TEMP);
        assert.equal(+doc.receivedDate, +new Date("2026-09-24T01:00:00Z"));

        // Submission resolved: no longer waiting in pending/.
        const temp = db.tables.temporaryData[0];
        assert.equal(temp.pendingStoragePath, null);
        assert.equal(temp.processingStatus, "VERIFIED");
        assert.equal(temp.reviewReason, "IDENTITY_NOT_CONFIRMED"); // why it was reviewed stays on record

        // Audit.
        assert.equal(db.tables.auditLog.length, 1);
        const audit = db.tables.auditLog[0];
        assert.equal(audit.adminId, "admin-active");
        assert.equal(audit.action, "APPROVE");
        assert.equal(audit.temporaryId, TEMP);
        assert.equal(audit.documentId, doc.documentId);
        assert.equal(audit.passportId, PASSPORT);
        assert.equal(audit.previousStatus, "MANUAL_REVIEW");
        assert.equal(audit.newStatus, "VERIFIED");
        assert.equal(audit.reason, "Checked against the client file");
        assert.ok(audit.createdDate instanceof Date);
        assert.match(audit.auditId, /^[0-9a-f-]{36}$/);
        assert.equal(response.body.audit.adminName, "Active Admin");

        // Gone from the queue; the detail is no longer a review item.
        const queue = await call("GET", "/review");
        assert.equal(queue.body.pagination.total, 0);
        assert.equal((await call("GET", `/review/pending-${TEMP}`)).status, 404);
    });

    test("the next version name is used when the client has other files of the type", async () => {
        const { bucket } = use(setup({
            documents: [documentRow({ documentType: "PASSPORT", storagePath: `clients/${PASSPORT}/passport/scan.pdf`, storedFilename: "scan.pdf" })],
            bucketPaths: [PENDING_PATH, `clients/${PASSPORT}/passport/scan.pdf`],
        }));
        const response = await approve(`pending-${TEMP}`);
        assert.equal(response.status, 200);
        assert.equal(response.body.document.storedFilename, "passport_v2.pdf");
        assert.ok(bucket.has(`clients/${PASSPORT}/passport/passport_v2.pdf`));
    });

    test("an existing VERIFIED document of the same type blocks approval; nothing changes, no audit entry", async () => {
        const existing = documentRow({ documentId: DOC_VERIFIED, documentType: "PASSPORT", verificationStatus: "VERIFIED", storagePath: `clients/${PASSPORT}/passport/passport.pdf`, storedFilename: "passport.pdf" });
        const { db, bucket } = use(setup({ documents: [existing], bucketPaths: [PENDING_PATH, existing.storagePath] }));
        const response = await approve(`pending-${TEMP}`);

        assert.equal(response.status, 409);
        assert.equal(response.body.code, "VERIFIED_DOCUMENT_EXISTS");
        assert.match(response.body.message, /already has a verified passport/);
        assert.deepEqual(db.tables.document, [existing]);
        assert.equal(db.tables.temporaryData[0].pendingStoragePath, PENDING_PATH);
        assert.equal(db.tables.auditLog.length, 0);
        assert.ok(bucket.has(PENDING_PATH));
        assert.equal(bucket.calls.filter((c) => c.method === "copy" || c.method === "remove").length, 0);
        // Still reviewable.
        assert.equal((await call("GET", "/review")).body.pagination.total, 1);
    });

    test("a database failure after the copy rolls back and removes the copy: no partial approval", async () => {
        for (const failing of ["document.create", "temporaryData.update", "auditLog.create"]) {
            const { db, bucket } = use(setup());
            db.failNext(failing, new Error("synthetic database failure"));
            const response = await approve(`pending-${TEMP}`);

            assert.equal(response.status, 500, failing);
            assert.equal(db.tables.document.length, 0, failing);
            assert.equal(db.tables.auditLog.length, 0, failing);
            assert.equal(db.tables.temporaryData[0].pendingStoragePath, PENDING_PATH, failing);
            assert.equal(db.tables.temporaryData[0].processingStatus, "MANUAL_REVIEW", failing);
            assert.ok(bucket.has(PENDING_PATH), failing);
            assert.ok(!bucket.has(`clients/${PASSPORT}/passport/passport.pdf`), `${failing}: copy removed`);
        }
    });

    test("a storage copy failure changes nothing (502)", async () => {
        const { db, bucket } = use(setup({ bucketOptions: { failCopy: true } }));
        const response = await approve(`pending-${TEMP}`);
        assert.equal(response.status, 502);
        assert.equal(response.body.code, "STORAGE_UNAVAILABLE");
        assert.equal(db.tables.document.length, 0);
        assert.equal(db.tables.auditLog.length, 0);
        assert.equal(db.tables.temporaryData[0].pendingStoragePath, PENDING_PATH);
        assert.ok(bucket.has(PENDING_PATH));
    });

    test("an unreadable pending file changes nothing (502)", async () => {
        const { db } = use(setup({ bucketPaths: [] }));
        const response = await approve(`pending-${TEMP}`);
        assert.equal(response.status, 502);
        assert.equal(db.tables.auditLog.length, 0);
        assert.equal(db.tables.temporaryData[0].pendingStoragePath, PENDING_PATH);
    });

    test("a pending file that no longer matches the received checksum is not approved", async () => {
        const { db } = use(setup({ files: { [PENDING_PATH]: Buffer.from("different bytes") } }));
        const response = await approve(`pending-${TEMP}`);
        assert.equal(response.status, 409);
        assert.equal(response.body.code, "FILE_CHANGED");
        assert.equal(db.tables.auditLog.length, 0);
    });

    test("the client already having this exact file blocks approval", async () => {
        const { db } = use(setup({ documents: [documentRow({ fileSha256: sha256Hex(FILE) })] }));
        const response = await approve(`pending-${TEMP}`);
        assert.equal(response.status, 409);
        assert.equal(response.body.code, "DUPLICATE_FILE");
        assert.equal(db.tables.document.length, 1);
        assert.equal(db.tables.auditLog.length, 0);
    });

    test("a file not linked to a client, or of a type without a client folder, can't be approved", async () => {
        let fixture = use(setup({ temporaryData: [pendingRow({ temporaryId: TEMP_UNLINKED, passportId: null, uniqueId: null })] }));
        let response = await approve(`pending-${TEMP_UNLINKED}`);
        assert.equal(response.status, 409);
        assert.equal(response.body.code, "CLIENT_NOT_IDENTIFIED");
        assert.equal(fixture.db.tables.auditLog.length, 0);

        fixture = use(setup({ temporaryData: [pendingRow({ documentType: "UNKNOWN" })] }));
        response = await approve(`pending-${TEMP}`);
        assert.equal(response.status, 409);
        assert.equal(response.body.code, "NO_CLIENT_FOLDER");
        assert.equal(fixture.db.tables.auditLog.length, 0);
    });

    test("a FAILED submission without a pending copy is not a review item: 404 for both actions, nothing changes", async () => {
        const failed = pendingRow({ temporaryId: TEMP_FAILED, processingStatus: "FAILED", pendingStoragePath: null, reviewReason: "PROCESSING_FAILED" });
        const { db, bucket } = use(setup({ temporaryData: [failed] }));
        assert.equal((await approve(`pending-${TEMP_FAILED}`)).status, 404);
        assert.equal((await keepPending(`pending-${TEMP_FAILED}`, { body: { reason: "try" } })).status, 404);
        assert.deepEqual(db.tables.temporaryData, [failed]);
        assert.equal(db.tables.document.length, 0);
        assert.equal(db.tables.auditLog.length, 0);
        assert.equal(bucket.calls.length, 0);
    });

    test("an item that was already approved can't be approved again", async () => {
        const { db } = use(setup());
        assert.equal((await approve(`pending-${TEMP}`)).status, 200);
        const again = await approve(`pending-${TEMP}`);
        assert.equal(again.status, 404);
        assert.equal(db.tables.document.length, 1);
        assert.equal(db.tables.auditLog.length, 1);
    });

    test("two approvals at the same time: one succeeds, the other gets 409; one document, one audit entry", async () => {
        const { db, bucket } = use(setup());
        holdDownloads(bucket, 2); // both requests pass the first (unlocked) read before either locks
        const responses = await Promise.all([approve(`pending-${TEMP}`), approve(`pending-${TEMP}`, { token: tokenFor("admin-other") })]);
        const statuses = responses.map((r) => r.status).sort();
        assert.deepEqual(statuses, [200, 409]);
        assert.equal(responses.find((r) => r.status === 409).body.code, "ALREADY_RESOLVED");
        assert.equal(db.tables.document.length, 1);
        assert.equal(db.tables.auditLog.length, 1);
        assert.equal(bucket.calls.filter((c) => c.method === "copy").length, 1);
        // The row locks were taken inside the transaction.
        assert.ok(db.calls.some((c) => c.method === "$queryRaw" && /FROM "temporary_data".*FOR UPDATE/s.test(c.sql)));
        assert.ok(db.calls.some((c) => c.method === "$queryRaw" && /FROM "users".*FOR UPDATE/s.test(c.sql)));
    });

    test("two different files of the same type for one client at the same time: only one becomes VERIFIED", async () => {
        const second = pendingRow({ temporaryId: TEMP_2, pendingStoragePath: PENDING_PATH.replace(".pdf", "_2.pdf"), fileSha256: sha256Hex(Buffer.from("second")) });
        const { db } = use(setup({
            temporaryData: [pendingRow(), second],
            bucketPaths: [PENDING_PATH, second.pendingStoragePath],
            files: { [PENDING_PATH]: FILE, [second.pendingStoragePath]: Buffer.from("second") },
        }));
        holdDownloads(current.bucket, 2);
        const responses = await Promise.all([approve(`pending-${TEMP}`), approve(`pending-${TEMP_2}`)]);
        assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
        assert.equal(responses.find((r) => r.status === 409).body.code, "VERIFIED_DOCUMENT_EXISTS");
        assert.equal(db.tables.document.filter((d) => d.verificationStatus === "VERIFIED").length, 1);
        assert.equal(db.tables.auditLog.length, 1);
    });
});

describe("POST /review/:reviewId/approve (stored REVIEW_REQUIRED document)", () => {
    test("marks the document VERIFIED in place (no storage change) and writes the audit entry", async () => {
        const { db, bucket } = use(setup({ temporaryData: [], documents: [documentRow({ temporaryId: TEMP })] }));
        const response = await approve(`document-${DOC_REVIEW}`);
        assert.equal(response.status, 200);
        assert.equal(response.body.document.documentId, DOC_REVIEW);
        assert.equal(db.tables.document[0].verificationStatus, "VERIFIED");
        assert.equal(db.tables.document[0].storagePath, `clients/${PASSPORT}/medical/scan.pdf`);
        assert.equal(bucket.calls.length, 0);
        const audit = db.tables.auditLog[0];
        assert.deepEqual(
            [audit.action, audit.documentId, audit.temporaryId, audit.passportId, audit.previousStatus, audit.newStatus, audit.reason],
            ["APPROVE", DOC_REVIEW, TEMP, PASSPORT, "REVIEW_REQUIRED", "VERIFIED", null]
        );
        assert.equal((await call("GET", `/review/document-${DOC_REVIEW}`)).status, 404);
    });

    test("blocked by another VERIFIED document of the same type", async () => {
        const { db } = use(setup({
            temporaryData: [],
            documents: [documentRow(), documentRow({ documentId: DOC_VERIFIED, verificationStatus: "VERIFIED", fileSha256: "c".repeat(64) })],
        }));
        const response = await approve(`document-${DOC_REVIEW}`);
        assert.equal(response.status, 409);
        assert.equal(response.body.code, "VERIFIED_DOCUMENT_EXISTS");
        assert.equal(db.tables.document[0].verificationStatus, "REVIEW_REQUIRED");
        assert.equal(db.tables.auditLog.length, 0);
    });
});

describe("POST /review/:reviewId/keep-pending", () => {
    test("records the decision; the file stays in pending/ and the item stays in the queue", async () => {
        const { db, bucket } = use(setup());
        const before = { ...db.tables.temporaryData[0] };
        const response = await keepPending(`pending-${TEMP}`, { body: { reason: "  Waiting for a clearer photo  " } });

        assert.equal(response.status, 200);
        assert.equal(response.body.action, "KEEP_PENDING");
        assert.deepEqual(db.tables.temporaryData[0], before);
        assert.ok(bucket.has(PENDING_PATH));
        assert.equal(bucket.calls.length, 0);
        assert.equal(db.tables.document.length, 0);

        const audit = db.tables.auditLog[0];
        assert.deepEqual(
            [audit.adminId, audit.action, audit.temporaryId, audit.documentId, audit.passportId, audit.previousStatus, audit.newStatus, audit.reason],
            ["admin-active", "KEEP_PENDING", TEMP, null, PASSPORT, "MANUAL_REVIEW", "MANUAL_REVIEW", "Waiting for a clearer photo"]
        );
        assert.ok(audit.createdDate instanceof Date);

        const queue = await call("GET", "/review");
        assert.deepEqual(queue.body.items.map((i) => i.reviewId), [`pending-${TEMP}`]);
        const detail = await call("GET", `/review/pending-${TEMP}`);
        assert.equal(detail.status, 200);
        assert.equal(detail.body.auditLog.length, 1);
        assert.deepEqual(
            { ...detail.body.auditLog[0], auditId: undefined, createdDate: undefined },
            { auditId: undefined, action: "KEEP_PENDING", adminId: "admin-active", adminName: "Active Admin", reason: "Waiting for a clearer photo", previousStatus: "MANUAL_REVIEW", newStatus: "MANUAL_REVIEW", createdDate: undefined }
        );
    });

    test("a stored REVIEW_REQUIRED document stays REVIEW_REQUIRED", async () => {
        const { db } = use(setup({ temporaryData: [], documents: [documentRow()] }));
        const response = await keepPending(`document-${DOC_REVIEW}`, { body: { reason: "Ask the client for a better scan" } });
        assert.equal(response.status, 200);
        assert.equal(db.tables.document[0].verificationStatus, "REVIEW_REQUIRED");
        assert.deepEqual([db.tables.auditLog[0].previousStatus, db.tables.auditLog[0].newStatus], ["REVIEW_REQUIRED", "REVIEW_REQUIRED"]);
    });

    test("the reason is required (400, no audit entry)", async () => {
        const { db } = use(setup());
        for (const body of [undefined, {}, { reason: "" }, { reason: "   " }, { reason: 12 }, { reason: "x".repeat(MAX_REASON_LENGTH + 1) }]) {
            const response = await keepPending(`pending-${TEMP}`, { body });
            assert.equal(response.status, 400, JSON.stringify(body));
            assert.equal(response.body.errors[0].field, "reason");
        }
        assert.equal(db.tables.auditLog.length, 0);
    });

    test("a repeated identical submit is rejected as a duplicate; a new reason or another admin is a new decision", async () => {
        const { db } = use(setup());
        const body = { reason: "Waiting for a clearer photo" };
        assert.equal((await keepPending(`pending-${TEMP}`, { body })).status, 200);
        const repeated = await keepPending(`pending-${TEMP}`, { body });
        assert.equal(repeated.status, 409);
        assert.equal(repeated.body.code, "DUPLICATE_ACTION");
        assert.equal((await keepPending(`pending-${TEMP}`, { body: { reason: "Client called; wait for the new scan" } })).status, 200);
        assert.equal((await keepPending(`pending-${TEMP}`, { body, token: tokenFor("admin-other") })).status, 200);
        assert.equal(db.tables.auditLog.length, 3);
        assert.ok(DUPLICATE_ACTION_WINDOW_MS >= 10_000);
    });

    test("two identical requests at the same time: one entry, one 409", async () => {
        const { db } = use(setup());
        const body = { reason: "Waiting for a clearer photo" };
        const responses = await Promise.all([keepPending(`pending-${TEMP}`, { body }), keepPending(`pending-${TEMP}`, { body })]);
        assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
        assert.equal(db.tables.auditLog.length, 1);
    });

    test("keep pending, then approve: both recorded, in order", async () => {
        const { db } = use(setup());
        assert.equal((await keepPending(`pending-${TEMP}`, { body: { reason: "Checking with the client" } })).status, 200);
        assert.equal((await approve(`pending-${TEMP}`, { token: tokenFor("admin-other") })).status, 200);
        assert.deepEqual(db.tables.auditLog.map((a) => [a.action, a.adminId]), [["KEEP_PENDING", "admin-active"], ["APPROVE", "admin-other"]]);
    });
});

describe("review detail: audit log and available actions", () => {
    test("audit entries newest first with the admin's name; stored documents also show entries made while pending", async () => {
        const { db } = use(setup({ temporaryData: [pendingRow({ pendingStoragePath: null, processingStatus: "UNCLEAR" })], documents: [documentRow({ temporaryId: TEMP })] }));
        db.tables.auditLog.push(
            { auditId: "a1", adminId: "admin-other", action: "KEEP_PENDING", temporaryId: TEMP, documentId: null, passportId: PASSPORT, previousStatus: "UNCLEAR", newStatus: "UNCLEAR", reason: "first", createdDate: new Date("2026-09-24T05:00:00Z") },
            { auditId: "a2", adminId: "admin-active", action: "KEEP_PENDING", temporaryId: TEMP, documentId: DOC_REVIEW, passportId: PASSPORT, previousStatus: "REVIEW_REQUIRED", newStatus: "REVIEW_REQUIRED", reason: "second", createdDate: new Date("2026-09-24T06:00:00Z") },
        );
        const detail = await call("GET", `/review/document-${DOC_REVIEW}`);
        assert.deepEqual(detail.body.auditLog.map((a) => [a.reason, a.adminName, a.createdDate]), [
            ["second", "Active Admin", "2026-09-24T06:00:00.000Z"],
            ["first", "Other Admin", "2026-09-24T05:00:00.000Z"],
        ]);
    });

    test("actions say whether Approve is possible and why not", async () => {
        use(setup());
        let detail = await call("GET", `/review/pending-${TEMP}`);
        assert.deepEqual(detail.body.auditLog, []);
        assert.deepEqual(detail.body.actions, {
            approve: { available: true, code: null, message: null },
            keepPending: { available: true, code: null, message: null },
        });
        assert.equal("reject" in detail.body.actions, false);

        use(setup({ temporaryData: [pendingRow({ passportId: null })] }));
        detail = await call("GET", `/review/pending-${TEMP}`);
        assert.equal(detail.body.actions.approve.available, false);
        assert.equal(detail.body.actions.approve.code, "CLIENT_NOT_IDENTIFIED");
    });
});

describe("security and error handling", () => {
    beforeEach(() => use(setup()));

    test("no token -> 401; bad token -> 401; inactive admin -> 401; nothing changes", async () => {
        for (const token of [null, "not-a-token", tokenFor("admin-inactive"), tokenFor("admin-deleted")]) {
            assert.equal((await approve(`pending-${TEMP}`, { token })).status, 401);
            assert.equal((await keepPending(`pending-${TEMP}`, { token, body: { reason: "x" } })).status, 401);
        }
        assert.equal(current.db.tables.auditLog.length, 0);
        assert.equal(current.db.tables.temporaryData[0].pendingStoragePath, PENDING_PATH);
    });

    test("malformed review ID -> 400; unknown -> 404; malformed JSON -> 400", async () => {
        assert.equal((await approve("pending-../../etc")).status, 400);
        assert.equal((await keepPending("nope", { body: { reason: "x" } })).status, 400);
        assert.equal((await approve("pending-99999999-9999-4999-8999-999999999999")).status, 404);
        assert.equal((await approve("document-99999999-9999-4999-8999-999999999999")).status, 404);
        assert.equal((await keepPending("pending-99999999-9999-4999-8999-999999999999", { body: { reason: "x" } })).status, 404);
        assert.equal((await approve(`pending-${TEMP}`, { rawBody: "{not json" })).status, 400);
        assert.equal((await approve(`pending-${TEMP}`, { body: ["x"] })).status, 400);
    });

    test("an unexpected error -> 500 with the generic message only", async () => {
        current.db.failNext("auditLog.create", new Error("secret internal detail"));
        const response = await keepPending(`pending-${TEMP}`, { body: { reason: "x" } });
        assert.equal(response.status, 500);
        assert.deepEqual(response.body, { message: "Internal server error" });
    });

    test("the admin recorded is the one in the token, never one from the body", async () => {
        await keepPending(`pending-${TEMP}`, { body: { reason: "x", adminId: "admin-other" } });
        assert.equal(current.db.tables.auditLog[0].adminId, "admin-active");
    });

    test("there is no reject action", async () => {
        assert.deepEqual(Object.keys(REVIEW_ACTION).sort(), ["APPROVE", "KEEP_PENDING"]);
        for (const path of [`/review/pending-${TEMP}/reject`, `/review/document-${DOC_REVIEW}/reject`, "/review/reject"]) {
            const response = await call("POST", path, { body: { reason: "x" } });
            assert.equal(response.status, 404, path);
        }
        assert.equal(current.db.tables.temporaryData[0].pendingStoragePath, PENDING_PATH);
        assert.equal(current.db.tables.auditLog.length, 0);
    });

    test("audit entries can't be edited or deleted through the API", async () => {
        await keepPending(`pending-${TEMP}`, { body: { reason: "x" } });
        const [entry] = current.db.tables.auditLog;
        const snapshot = { ...entry };
        for (const [method, path] of [
            ["PUT", `/review/pending-${TEMP}/audit/${entry.auditId}`],
            ["PATCH", `/review/pending-${TEMP}/audit/${entry.auditId}`],
            ["DELETE", `/review/pending-${TEMP}/audit/${entry.auditId}`],
            ["DELETE", `/audit/${entry.auditId}`],
            ["PATCH", `/audit/${entry.auditId}`],
            ["DELETE", `/review/pending-${TEMP}`],
            ["PUT", `/review/pending-${TEMP}`],
        ]) {
            assert.equal((await call(method, path, { body: { reason: "changed" } })).status, 404, `${method} ${path}`);
        }
        assert.deepEqual(current.db.tables.auditLog, [snapshot]);
    });

    test("the router only writes through the two review actions", () => {
        const router = createAdminRouter({ db: current.db.client, bucket: current.bucket, requireAdmin: (req, res, next) => next() });
        const writes = router.stack
            .filter((layer) => layer.route)
            .flatMap((layer) => Object.keys(layer.route.methods).filter((m) => m !== "get").map((m) => `${m.toUpperCase()} ${layer.route.path}`));
        assert.deepEqual(writes.sort(), ["POST /review/:reviewId/approve", "POST /review/:reviewId/keep-pending"]);
    });

    test("the fake database mirrors the append-only trigger", async () => {
        await keepPending(`pending-${TEMP}`, { body: { reason: "x" } });
        await assert.rejects(current.db.client.auditLog.update({ where: { auditId: current.db.tables.auditLog[0].auditId }, data: { reason: "y" } }), /append-only/);
        await assert.rejects(current.db.client.auditLog.deleteMany({}), /append-only/);
    });
});
