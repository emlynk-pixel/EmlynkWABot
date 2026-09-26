import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import jwt from "jsonwebtoken";

import { processDocument } from "../src/services/documentProcessingService.js";
import { decidePlacement, PLACEMENT } from "../src/services/storagePlacementService.js";
import { CHECKSUM_OUTCOME } from "../src/services/documentChecksumService.js";
import { REVIEW_REASON, deriveReviewReason } from "../src/services/reviewReason.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createRequireActiveAdmin } from "../src/middleware/requireActiveAdmin.js";
import { sha256Hex } from "../src/utils/fileChecksum.js";
import { createFakePrisma } from "./helpers/fakePrisma.js";
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

// M4 — Duplicate Verified-Document Policy. Synthetic data only.
// text-passport.pdf belongs to N1234567 (unique ID 0001, WhatsApp 0771234567).
const PASSPORT_PDF = readFileSync(new URL("./fixtures/files/text-passport.pdf", import.meta.url));
const SHA = sha256Hex(PASSPORT_PDF);
const TEMP_PATH = "temporary/tmp-1.pdf";
const VERIFIED_PATH = "clients/N1234567/passport/passport.pdf";
const users = () => [
    { passportId: "N1234567", uniqueId: "0001", whatsappNumber: "0771234567", firstName: "KAMAL NIMAL", otherName: null, dateOfBirth: null, placeOfBirth: null, passportExpiryDate: null },
    { passportId: "N7654321", uniqueId: "0002", whatsappNumber: "0772223333", firstName: "NIMAL" },
];
const existing = (overrides = {}) => ({
    documentId: "d-verified", passportId: "N1234567", documentType: "PASSPORT", fileSha256: SHA, verificationStatus: "VERIFIED",
    storagePath: VERIFIED_PATH, storedFilename: "passport.pdf", ...overrides,
});

async function run({ documents = [], temporaryData = [], sender = "94771234567" } = {}) {
    const db = createFakePrisma(users(), { documents, temporaryData });
    const bucket = createFakeBucket([TEMP_PATH, VERIFIED_PATH]);
    const { summary } = await processDocument({
        temporaryId: "tmp-1", whatsappNumber: sender, fileName: "passport.pdf", mimeType: "application/pdf",
        fileBuffer: PASSPORT_PDF, temporaryStoragePath: TEMP_PATH, deps: { db, bucket, now: new Date("2026-09-26T07:05:03Z") },
    });
    const update = db.calls.filter((c) => c.method === "temporaryData.update").at(-1).data;
    return { summary, db, bucket, update, objects: [...bucket.objects.keys()] };
}

describe("M4 pipeline", () => {
    test("TEST 1: same client + exact same file + existing VERIFIED -> DUPLICATE, pending/, review; verified document untouched", async () => {
        const before = existing();
        const { summary, db, update, objects } = await run({ documents: [before] });

        assert.equal(summary.processingStatus, "DUPLICATE");
        assert.deepEqual(summary.storage, { checksum: "DUPLICATE", placement: "PENDING", verificationStatus: null, documentStored: false, pendingCopy: true });
        assert.equal(update.processingStatus, "DUPLICATE");
        assert.equal(update.reviewReason, REVIEW_REASON.DUPLICATE_OF_VERIFIED);
        assert.equal(update.passportId, "N1234567", "linked to the client");
        assert.ok(update.pendingStoragePath.startsWith("pending/0001/undefined/uncleared-docs/"));
        assert.ok(objects.includes(update.pendingStoragePath), "the copy exists for the admin review");
        assert.ok(objects.includes(TEMP_PATH), "temporary original kept (Phase 8)");
        // Existing verified document: row and file unchanged; nothing new in the client folder.
        assert.deepEqual(db.documentRows, [existing()]);
        assert.ok(objects.includes(VERIFIED_PATH));
        assert.equal(objects.filter((p) => p.startsWith("clients/")).length, 1);
        assert.ok(!db.calls.some((c) => c.method === "document.create"));
        assert.ok(!db.calls.some((c) => c.method === "user.updateMany"), "no client record writes");
    });

    test("TEST 2: exact duplicate of a NON-verified document -> existing policy (DUPLICATE, nothing stored, no review)", async () => {
        for (const verificationStatus of ["REVIEW_REQUIRED", undefined]) {
            const { summary, update, objects } = await run({ documents: [existing({ verificationStatus })] });
            assert.equal(summary.processingStatus, "DUPLICATE", String(verificationStatus));
            assert.equal(summary.storage.placement, "NONE");
            assert.equal(update.pendingStoragePath, undefined);
            assert.equal(update.reviewReason, null);
            assert.deepEqual(objects.sort(), [VERIFIED_PATH, TEMP_PATH].sort());
        }
    });

    test("TEST 3: same client + same type + DIFFERENT file -> not a duplicate: existing version workflow", async () => {
        const { summary, db, update } = await run({ documents: [existing({ fileSha256: sha256Hex(Buffer.from("an older scan")) })] });
        assert.notEqual(summary.processingStatus, "DUPLICATE");
        assert.equal(summary.storage.checksum, "NEW");
        assert.equal(summary.storage.placement, "CLIENT");
        assert.equal(db.documentRows.at(-1).storedFilename, "passport_v2.pdf");
        assert.deepEqual(db.documentRows[0], existing({ fileSha256: sha256Hex(Buffer.from("an older scan")) }));
        assert.notEqual(update.reviewReason, REVIEW_REASON.DUPLICATE_OF_VERIFIED);
    });

    test("TEST 4: another client has the same file (even VERIFIED) -> cross-client CONFLICT workflow unchanged", async () => {
        const { summary, db, update, objects } = await run({ documents: [existing({ passportId: "N7654321", storagePath: "clients/N7654321/passport/passport.pdf" })] });
        assert.equal(summary.processingStatus, "CONFLICT");
        assert.equal(summary.storage.checksum, "CROSS_CLIENT_CONFLICT");
        assert.equal(update.reviewReason, REVIEW_REASON.CROSS_CLIENT_DUPLICATE);
        assert.ok(update.pendingStoragePath.startsWith("pending/unidentified/"), "neither client's folder name is used");
        assert.equal(update.passportId, undefined, "not linked to either client");
        assert.deepEqual(objects.filter((p) => p.startsWith("clients/")), [VERIFIED_PATH], "nothing new in any client folder");
        assert.equal(db.documentRows.length, 1);
    });

    test("a resend while the duplicate is already waiting -> no second pending copy", async () => {
        const temporaryData = [{ temporaryId: "tmp-0", whatsappNumber: "94771234567", fileSha256: SHA, pendingStoragePath: "pending/0001/undefined/uncleared-docs/document_1.pdf" }];
        const { summary, update } = await run({ documents: [existing()], temporaryData });
        assert.equal(summary.processingStatus, "DUPLICATE");
        assert.equal(summary.storage.placement, "NONE");
        assert.equal(update.pendingStoragePath, undefined);
    });

    test("units: placement and review reason", () => {
        const base = { processingStatus: "VERIFIED", band: "VERIFIED", documentType: "PASSPORT", clientIdentified: true, uniqueId: "0001", checksumOutcome: CHECKSUM_OUTCOME.DUPLICATE };
        assert.deepEqual(decidePlacement({ ...base, duplicateOfVerified: true }), { placement: PLACEMENT.PENDING, processingStatus: "DUPLICATE", pendingOwner: "0001" });
        assert.deepEqual(decidePlacement(base), { placement: PLACEMENT.NONE, processingStatus: "DUPLICATE", pendingOwner: null });
        assert.equal(decidePlacement({ ...base, duplicateOfVerified: true, checksumOutcome: CHECKSUM_OUTCOME.CROSS_CLIENT_CONFLICT }).processingStatus, "CONFLICT");
        assert.equal(deriveReviewReason({ processingStatus: "DUPLICATE", checksum: { outcome: "DUPLICATE", existingVerified: true } }), REVIEW_REASON.DUPLICATE_OF_VERIFIED);
        assert.equal(deriveReviewReason({ processingStatus: "DUPLICATE", checksum: { outcome: "DUPLICATE", existingVerified: false } }), null);
    });
});

// ---------------------------------------------------------------- admin review

const V = "11111111-1111-4111-8111-111111111111";
const T = "22222222-2222-4222-8222-222222222222";
const PENDING = "pending/0001/undefined/uncleared-docs/document_20260926_070503.pdf";
const TEMP = "temporary/bbbb.pdf";
const ADMINS = [{ adminId: "admin-active", name: "Active Admin", email: "a@example.invalid", passwordHash: "x", role: "ADMIN", status: "ACTIVE" }];
const verifiedRow = {
    documentId: V, passportId: "N1234567", documentType: "PASSPORT", originalFilename: "passport.pdf", storedFilename: "passport.pdf", storagePath: VERIFIED_PATH,
    mimeType: "application/pdf", fileSize: 10n, receivedDate: new Date("2026-09-20T03:00:00Z"), processingStatus: "STORED", verificationStatus: "VERIFIED",
    ocrConfidence: 98, fileSha256: SHA, temporaryId: null, policeSubmittedDate: null,
};
const duplicateRow = {
    temporaryId: T, passportId: "N1234567", uniqueId: "0001", whatsappNumber: "94771234567", documentType: "PASSPORT", temporaryStoragePath: TEMP,
    processingStatus: "DUPLICATE", createdDate: new Date("2026-09-26T07:05:03Z"), fileSha256: SHA, pendingStoragePath: PENDING,
    processingSummary: { stage: "COMPLETED", storage: { checksum: "DUPLICATE", placement: "PENDING", verificationStatus: null, documentStored: false, pendingCopy: true } },
    reviewReason: "DUPLICATE_OF_VERIFIED",
};
function setup() {
    const db = createFakeReviewDb({ admins: ADMINS, users: [{ passportId: "N1234567", uniqueId: "0001", firstName: "KAMAL", otherName: "PERERA" }], documents: [verifiedRow], temporaryData: [duplicateRow] });
    const bucket = createFakeBucket([VERIFIED_PATH, PENDING, TEMP]);
    return { db, bucket };
}
const token = jwt.sign({ adminId: "admin-active" }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
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
async function call(method, path, body) {
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
}

describe("M4 admin review", () => {
    test("the duplicate is in the Review Queue and the Overview's Pending review count", async () => {
        use(setup());
        const queue = await call("GET", "/review");
        assert.equal(queue.body.items.length, 1);
        const [item] = queue.body.items;
        assert.deepEqual([item.reviewId, item.kind, item.documentType, item.processingStatus, item.reviewReason, item.client.passportId],
            [`pending-${T}`, "PENDING", "PASSPORT", "DUPLICATE", "DUPLICATE_OF_VERIFIED", "N1234567"]);
        assert.equal((await call("GET", "/review?reviewReason=DUPLICATE_OF_VERIFIED")).body.items.length, 1);
        assert.equal((await call("GET", "/overview")).body.kpis.pendingReview, 1);
    });

    test("TEST 5: Review Detail explains the duplicate and names the existing verified document; Approve blocked with the reason", async () => {
        use(setup());
        const { status, body } = await call("GET", `/review/pending-${T}`);
        assert.equal(status, 200);
        assert.equal(body.reviewReason, "DUPLICATE_OF_VERIFIED");
        assert.deepEqual(body.duplicateOf, { documentId: V, documentType: "PASSPORT", verificationStatus: "VERIFIED", receivedDate: "2026-09-20T03:00:00.000Z" });
        assert.equal(body.actions.approve.available, false);
        assert.equal(body.actions.approve.code, "DUPLICATE_FILE");
        assert.match(body.actions.approve.message, /exact duplicate of the client's existing verified passport/);
        assert.equal(body.actions.keepPending.available, true);
        assert.equal(body.actions.remove.available, true);
        const text = JSON.stringify(body);
        assert.ok(!text.includes(SHA) && !text.includes(VERIFIED_PATH) && !text.includes(PENDING), "no checksums or storage paths");
    });

    test("Approve is refused (nothing stored, nothing changed)", async () => {
        const { db, bucket } = use(setup());
        const response = await call("POST", `/review/pending-${T}/approve`, {});
        assert.equal(response.status, 409);
        assert.equal(response.body.code, "DUPLICATE_FILE");
        assert.deepEqual(db.tables.document, [verifiedRow]);
        assert.equal(db.tables.temporaryData[0].pendingStoragePath, PENDING);
        assert.ok(!bucket.calls.some((c) => c.method === "copy" || c.method === "remove"));
    });

    test("TEST 6 + 7: Remove from Review closes only the incoming duplicate; verified document untouched; audited", async () => {
        const { db, bucket } = use(setup());
        const response = await call("POST", `/review/pending-${T}/remove`, { reason: "Same passport sent twice" });
        assert.equal(response.status, 200);
        assert.equal(db.tables.temporaryData.length, 0);
        assert.equal(bucket.has(PENDING), false);
        assert.equal(bucket.has(TEMP), false);
        assert.deepEqual(db.tables.document, [verifiedRow], "existing verified document unchanged");
        assert.equal(bucket.has(VERIFIED_PATH), true);
        assert.equal((await call("GET", "/review")).body.items.length, 0);

        const [entry] = db.tables.auditLog;
        assert.equal(db.tables.auditLog.length, 1);
        assert.equal(entry.adminId, "admin-active");
        assert.equal(entry.action, "REMOVE_FROM_REVIEW");
        assert.equal(entry.temporaryId, T, "the duplicate reviewed");
        assert.equal(entry.documentId, V, "the existing document that caused the match");
        assert.equal(entry.passportId, "N1234567");
        assert.deepEqual([entry.previousStatus, entry.newStatus], ["DUPLICATE", "REMOVED"]);
        assert.equal(entry.reason, "Same passport sent twice");
        assert.equal(entry.fileSha256, SHA);
        assert.ok(entry.createdDate instanceof Date);
        await assert.rejects(db.client.auditLog.update({ where: { auditId: entry.auditId }, data: { reason: "x" } }), /append-only/);
    });

    test("TEST 7: Keep Pending keeps the duplicate and records the matched document", async () => {
        const { db } = use(setup());
        assert.equal((await call("POST", `/review/pending-${T}/keep-pending`, { reason: "Checking with the client" })).status, 200);
        assert.equal(db.tables.temporaryData[0].pendingStoragePath, PENDING);
        const [entry] = db.tables.auditLog;
        assert.deepEqual([entry.action, entry.adminId, entry.temporaryId, entry.documentId, entry.previousStatus, entry.newStatus],
            ["KEEP_PENDING", "admin-active", T, V, "DUPLICATE", "DUPLICATE"]);
        assert.deepEqual(db.tables.document, [verifiedRow]);
        const detail = await call("GET", `/review/pending-${T}`);
        assert.equal(detail.body.auditLog[0].action, "KEEP_PENDING");
    });

    test("an ordinary waiting file has no duplicateOf and its audit entries no document link", async () => {
        const { db } = use(setup());
        db.tables.temporaryData[0] = { ...duplicateRow, processingStatus: "MANUAL_REVIEW", reviewReason: "IDENTITY_NOT_CONFIRMED", fileSha256: "c".repeat(64) };
        const detail = await call("GET", `/review/pending-${T}`);
        assert.equal(detail.body.duplicateOf, null);
        await call("POST", `/review/pending-${T}/keep-pending`, { reason: "x" });
        assert.equal(db.tables.auditLog[0].documentId, null);
    });
});
