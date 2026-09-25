import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import jwt from "jsonwebtoken";

import { createAdminRouter } from "../src/routes/admin.js";
import { createRequireActiveAdmin } from "../src/middleware/requireActiveAdmin.js";
import { REVIEW_ACTION, REMOVED_STATUS } from "../src/services/adminReviewActionService.js";
import { findPendingDuplicate } from "../src/services/documentChecksumService.js";
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
const OTHER = "22222222-2222-4222-8222-222222222222";
const DOC = "33333333-3333-4333-8333-333333333333";
const FAILED = "44444444-4444-4444-8444-444444444444";
const PENDING_PATH = "pending/0001/undefined/uncleared-docs/document_20260924_063000.pdf";
const TEMP_PATH = "temporary/aaaa.pdf";
const OTHER_PENDING = "pending/0001/undefined/uncleared-docs/document_20260924_070000.pdf";
const OTHER_TEMP = "temporary/bbbb.pdf";
const SHA = sha256Hex(Buffer.from("synthetic file"));
const ADMINS = [
    { adminId: "admin-active", name: "Active Admin", email: "a@example.invalid", passwordHash: "x", role: "ADMIN", status: "ACTIVE" },
    { adminId: "admin-other", name: "Other Admin", email: "o@example.invalid", passwordHash: "x", role: "ADMIN", status: "ACTIVE" },
    { adminId: "admin-inactive", name: "Inactive Admin", email: "i@example.invalid", passwordHash: "x", role: "ADMIN", status: "INACTIVE" },
];
const pendingRow = (overrides = {}) => ({
    temporaryId: TEMP, passportId: "N1234567", uniqueId: "0001", whatsappNumber: "94770000000", documentType: "UNKNOWN",
    temporaryStoragePath: TEMP_PATH, processingStatus: "UNDEFINED", createdDate: new Date("2026-09-24T01:00:00Z"),
    fileSha256: SHA, pendingStoragePath: PENDING_PATH, processingSummary: null, reviewReason: "DOCUMENT_TYPE_UNCLEAR", ...overrides,
});
const storedReviewDoc = {
    documentId: DOC, passportId: "N1234567", documentType: "MEDICAL", originalFilename: "scan.pdf", storedFilename: "scan.pdf",
    storagePath: "clients/N1234567/medical/scan.pdf", mimeType: "application/pdf", fileSize: 10n, receivedDate: new Date("2026-09-24T03:00:00Z"),
    processingStatus: "STORED", verificationStatus: "REVIEW_REQUIRED", ocrConfidence: 50, fileSha256: "b".repeat(64), temporaryId: null, policeSubmittedDate: null,
};

function setup({ temporaryData = [pendingRow(), pendingRow({ temporaryId: OTHER, pendingStoragePath: OTHER_PENDING, temporaryStoragePath: OTHER_TEMP, fileSha256: "c".repeat(64) })], documents = [storedReviewDoc], bucketOptions = {} } = {}) {
    const db = createFakeReviewDb({ admins: ADMINS, users: [{ passportId: "N1234567", uniqueId: "0001", firstName: "KAMAL", otherName: null }], temporaryData, documents });
    const bucket = createFakeBucket([PENDING_PATH, TEMP_PATH, OTHER_PENDING, OTHER_TEMP, storedReviewDoc.storagePath], bucketOptions);
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
const remove = (id, options = { body: { reason: "Blank page sent by mistake; client confirmed" } }) => call("POST", `/review/${id}/remove`, options);

describe("POST /review/:reviewId/remove", () => {
    test("deletes the waiting file, its temporary original and its record; the audit entry is kept", async () => {
        const { db, bucket } = use(setup());
        const response = await remove(`pending-${TEMP}`);

        assert.equal(response.status, 200);
        assert.equal(response.body.action, "REMOVE_FROM_REVIEW");
        assert.equal(response.body.filesDeleted, true);
        assert.equal(response.body.audit.adminName, "Active Admin");
        assert.equal(response.body.audit.documentType, "UNKNOWN");
        assert.ok(!JSON.stringify(response.body).includes(SHA), "checksum not returned");

        // Gone: record and both files.
        assert.equal(db.tables.temporaryData.find((t) => t.temporaryId === TEMP), undefined);
        assert.ok(!bucket.has(PENDING_PATH));
        assert.ok(!bucket.has(TEMP_PATH));

        // Kept: the audit entry, with everything about what was removed.
        assert.equal(db.tables.auditLog.length, 1);
        const entry = db.tables.auditLog[0];
        assert.deepEqual(
            [entry.adminId, entry.action, entry.temporaryId, entry.documentId, entry.passportId, entry.previousStatus, entry.newStatus, entry.reason, entry.documentType, entry.fileSha256],
            ["admin-active", "REMOVE_FROM_REVIEW", TEMP, null, "N1234567", "UNDEFINED", REMOVED_STATUS, "Blank page sent by mistake; client confirmed", "UNKNOWN", SHA]
        );
        assert.ok(entry.createdDate instanceof Date);

        // Nothing else touched.
        assert.ok(db.tables.temporaryData.some((t) => t.temporaryId === OTHER));
        assert.ok(bucket.has(OTHER_PENDING) && bucket.has(OTHER_TEMP) && bucket.has(storedReviewDoc.storagePath));
        assert.deepEqual(bucket.calls.filter((c) => c.method === "remove").flatMap((c) => c.paths).sort(), [PENDING_PATH, TEMP_PATH].sort());

        // Out of the queue and the overview; the detail no longer exists; no undo.
        const queue = await call("GET", "/review");
        assert.deepEqual(queue.body.items.map((i) => i.reviewId).sort(), [`document-${DOC}`, `pending-${OTHER}`].sort());
        assert.equal((await call("GET", `/review/pending-${TEMP}`)).status, 404);
        assert.equal((await call("GET", "/overview")).body.reviewQueue.pendingFiles, 1);
        assert.equal((await remove(`pending-${TEMP}`)).status, 404);
    });

    test("the same file sent again afterwards is processed as new (not a pending duplicate)", async () => {
        const { db } = use(setup());
        assert.ok(await findPendingDuplicate({ whatsappNumber: "94770000000", fileSha256: SHA, temporaryId: "new" }, { db: db.client }));
        await remove(`pending-${TEMP}`);
        assert.equal(await findPendingDuplicate({ whatsappNumber: "94770000000", fileSha256: SHA, temporaryId: "new" }, { db: db.client }), null);
    });

    test("the reason is required (400, nothing deleted)", async () => {
        const { db, bucket } = use(setup());
        for (const body of [undefined, {}, { reason: "" }, { reason: "   " }, { reason: 7 }, { reason: "x".repeat(501) }]) {
            const response = await remove(`pending-${TEMP}`, { body });
            assert.equal(response.status, 400, JSON.stringify(body));
        }
        assert.equal(db.tables.temporaryData.length, 2);
        assert.equal(db.tables.auditLog.length, 0);
        assert.equal(bucket.calls.length, 0);
    });

    test("a stored document can't be removed (409); unknown or FAILED-without-pending-copy -> 404", async () => {
        const failed = pendingRow({ temporaryId: FAILED, processingStatus: "FAILED", pendingStoragePath: null, temporaryStoragePath: "temporary/f.pdf" });
        const { db, bucket } = use(setup({ temporaryData: [pendingRow(), failed] }));
        const stored = await remove(`document-${DOC}`);
        assert.equal(stored.status, 409);
        assert.equal(stored.body.code, "NOT_REMOVABLE");
        assert.equal((await remove("pending-99999999-9999-4999-8999-999999999999")).status, 404);
        assert.equal((await remove("document-99999999-9999-4999-8999-999999999999")).status, 404);
        assert.equal((await remove(`pending-${FAILED}`)).status, 404);
        assert.equal((await remove("pending-../../x")).status, 400);
        assert.equal(db.tables.document.length, 1);
        assert.equal(db.tables.temporaryData.length, 2);
        assert.equal(db.tables.auditLog.length, 0);
        assert.equal(bucket.calls.length, 0);
    });

    test("two removals at the same time: one succeeds, the other gets 409; one audit entry", async () => {
        const { db } = use(setup());
        // Both requests read the item (unlocked) before either locks it.
        const findFirst = db.client.temporaryData.findFirst;
        let waiting = [];
        db.client.temporaryData.findFirst = (args) => (waiting === null ? findFirst(args) : new Promise((resolve) => {
            waiting.push(() => resolve(findFirst(args)));
            if (waiting.length === 2) { const release = waiting; waiting = null; release.forEach((go) => go()); }
        }));
        const responses = await Promise.all([remove(`pending-${TEMP}`), remove(`pending-${TEMP}`, { body: { reason: "Duplicate of another file" }, token: tokenFor("admin-other") })]);
        assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
        assert.equal(responses.find((r) => r.status === 409).body.code, "ALREADY_RESOLVED");
        assert.equal(db.tables.auditLog.length, 1);
    });

    test("a database failure rolls back: record, files and audit unchanged", async () => {
        for (const failing of ["auditLog.create", "temporaryData.delete"]) {
            const { db, bucket } = use(setup());
            db.failNext(failing, new Error("synthetic database failure"));
            const response = await remove(`pending-${TEMP}`);
            assert.equal(response.status, 500, failing);
            assert.ok(db.tables.temporaryData.some((t) => t.temporaryId === TEMP), failing);
            assert.equal(db.tables.auditLog.length, 0, failing);
            assert.ok(bucket.has(PENDING_PATH) && bucket.has(TEMP_PATH), failing);
            assert.equal(bucket.calls.filter((c) => c.method === "remove").length, 0, failing);
        }
    });

    test("if deleting the files fails after the commit, the item is still removed (reported, audit kept)", async () => {
        const { db } = use(setup({ bucketOptions: { failRemove: true } }));
        const response = await remove(`pending-${TEMP}`);
        assert.equal(response.status, 200);
        assert.equal(response.body.filesDeleted, false);
        assert.equal(db.tables.temporaryData.find((t) => t.temporaryId === TEMP), undefined);
        assert.equal(db.tables.auditLog.length, 1);
    });

    test("only an ACTIVE admin can remove; the admin is taken from the token", async () => {
        const { db } = use(setup());
        for (const token of [null, "not-a-token", tokenFor("admin-inactive")]) {
            assert.equal((await remove(`pending-${TEMP}`, { body: { reason: "x" }, token })).status, 401);
        }
        assert.equal(db.tables.temporaryData.length, 2);
        await remove(`pending-${TEMP}`, { body: { reason: "x", adminId: "admin-other" } });
        assert.equal(db.tables.auditLog[0].adminId, "admin-active");
    });

    test("the detail says which items can be removed", async () => {
        use(setup());
        assert.deepEqual((await call("GET", `/review/pending-${TEMP}`)).body.actions.remove, { available: true, code: null, message: null });
        assert.equal((await call("GET", `/review/document-${DOC}`)).body.actions.remove.available, false);
    });
});

describe("no automatic removal", () => {
    test("only the Remove from Review action deletes temporary_data rows or pending files", () => {
        const sources = fs.readdirSync(new URL("../src/services/", import.meta.url)).map((f) => [f, fs.readFileSync(new URL(`../src/services/${f}`, import.meta.url), "utf8")]);
        const deletingRows = sources.filter(([, code]) => /temporaryData\.(delete|deleteMany)\(/.test(code)).map(([f]) => f);
        assert.deepEqual(deletingRows, ["adminReviewActionService.js"]);
        const action = sources.find(([f]) => f === "adminReviewActionService.js")[1];
        assert.equal(action.match(/temporaryData\.delete\(/g).length, 1, "one delete, inside removeFromReview");
        assert.ok(!/setInterval|setTimeout|cron|schedule/i.test(action), "no timers or schedules");
        assert.deepEqual(Object.values(REVIEW_ACTION).sort(), ["APPROVE", "KEEP_PENDING", "REMOVE_FROM_REVIEW"]);
    });
});

describe("migration 20260926090000_phase10_audit_removal_details", () => {
    test("additive: two nullable columns on audit_logs, nothing else", () => {
        const sql = fs.readFileSync(new URL("../prisma/migrations/20260926090000_phase10_audit_removal_details/migration.sql", import.meta.url), "utf8").replace(/--.*$/gm, "");
        const statements = sql.split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
        assert.deepEqual(statements, ['ALTER TABLE "audit_logs" ADD COLUMN "document_type" TEXT, ADD COLUMN "file_sha256" CHAR(64)']);
    });
});
