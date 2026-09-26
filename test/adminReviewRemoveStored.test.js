import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import jwt from "jsonwebtoken";

import { createAdminRouter } from "../src/routes/admin.js";
import { createRequireActiveAdmin } from "../src/middleware/requireActiveAdmin.js";
import { removeFromReview } from "../src/services/adminReviewActionService.js";
import { decidePlacement, PLACEMENT } from "../src/services/storagePlacementService.js";
import { processDocument } from "../src/services/documentProcessingService.js";
import { createFakeReviewDb } from "./helpers/fakeReviewDb.js";
import { createFakeBucket } from "./helpers/fakeStorage.js";
import { createFakePrisma } from "./helpers/fakePrisma.js";
import { loadDocumentText } from "./helpers/fixtures.js";

Object.assign(process.env, {
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-placeholder",
    DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
    META_APP_SECRET: "test-app-secret-placeholder",
    JWT_SECRET: "test-jwt-secret-placeholder-0123456789",
});
const { createApp } = await import("../src/createApp.js");

// H4: a stored REVIEW_REQUIRED document next to a VERIFIED one of the same
// type could never be approved and never leave the Review Queue.
// Synthetic data only.
const PASSPORT = "N1234567";
const VERIFIED_ID = "11111111-1111-4111-8111-111111111111";
const REVIEW_ID = "22222222-2222-4222-8222-222222222222";
const TEMP = "33333333-3333-4333-8333-333333333333";
const VERIFIED_PATH = `clients/${PASSPORT}/passport/passport.pdf`;
const REVIEW_PATH = `clients/${PASSPORT}/passport/scan.pdf`;
const TEMP_PATH = "temporary/aaaa.pdf";
const ADMINS = [
    { adminId: "admin-active", name: "Active Admin", email: "a@example.invalid", passwordHash: "x", role: "ADMIN", status: "ACTIVE" },
    { adminId: "admin-inactive", name: "Inactive Admin", email: "i@example.invalid", passwordHash: "x", role: "ADMIN", status: "INACTIVE" },
];
const doc = (overrides) => ({
    passportId: PASSPORT, documentType: "PASSPORT", originalFilename: "scan.pdf", mimeType: "application/pdf", fileSize: 10n,
    receivedDate: new Date("2026-09-20T03:00:00Z"), processingStatus: "STORED", ocrConfidence: 34, temporaryId: null, policeSubmittedDate: null, ...overrides,
});
const verifiedDoc = doc({ documentId: VERIFIED_ID, storedFilename: "passport.pdf", storagePath: VERIFIED_PATH, verificationStatus: "VERIFIED", ocrConfidence: 98, fileSha256: "a".repeat(64) });
const reviewDoc = doc({ documentId: REVIEW_ID, storedFilename: "scan.pdf", storagePath: REVIEW_PATH, verificationStatus: "REVIEW_REQUIRED", fileSha256: "b".repeat(64), temporaryId: TEMP });
const submission = {
    temporaryId: TEMP, passportId: PASSPORT, uniqueId: "0001", whatsappNumber: "94770000000", documentType: "PASSPORT", temporaryStoragePath: TEMP_PATH,
    processingStatus: "UNCLEAR", createdDate: new Date("2026-09-20T03:00:00Z"), pendingStoragePath: null, fileSha256: "b".repeat(64), reviewReason: "LOW_CONFIDENCE",
};

function setup({ documents = [verifiedDoc, reviewDoc], bucketOptions = {} } = {}) {
    const db = createFakeReviewDb({
        admins: ADMINS, users: [{ passportId: PASSPORT, uniqueId: "0001", firstName: "ANURA", otherName: "KUMARA" }],
        documents, temporaryData: [submission],
    });
    const bucket = createFakeBucket([VERIFIED_PATH, REVIEW_PATH, TEMP_PATH], bucketOptions);
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
const remove = (id, reason = "Blurry duplicate; the verified passport is correct") => call("POST", `/review/${id}/remove`, { body: { reason } });

describe("A: Remove from Review for a stored REVIEW_REQUIRED document", () => {
    test("the stuck item: Approve is blocked, Remove is offered", async () => {
        use(setup());
        const detail = await call("GET", `/review/document-${REVIEW_ID}`);
        assert.equal(detail.body.actions.approve.available, false);
        assert.equal(detail.body.actions.approve.code, "VERIFIED_DOCUMENT_EXISTS");
        assert.deepEqual(detail.body.actions.remove, { available: true, code: null, message: null });
    });

    test("removes only that document and its file; the VERIFIED document is untouched; audited", async () => {
        const { db, bucket } = use(setup());
        const verifiedBefore = structuredClone(db.tables.document.find((d) => d.documentId === VERIFIED_ID));
        const submissionBefore = structuredClone(db.tables.temporaryData[0]);

        const response = await remove(`document-${REVIEW_ID}`);
        assert.equal(response.status, 200);
        assert.equal(response.body.action, "REMOVE_FROM_REVIEW");
        assert.equal(response.body.reviewId, `document-${REVIEW_ID}`);
        assert.equal(response.body.filesDeleted, true);

        // Removed: the REVIEW_REQUIRED row and its file.
        assert.equal(db.tables.document.some((d) => d.documentId === REVIEW_ID), false);
        assert.equal(bucket.has(REVIEW_PATH), false);
        // Untouched: the VERIFIED document (row and file), the submission and its original.
        assert.deepEqual(db.tables.document.find((d) => d.documentId === VERIFIED_ID), verifiedBefore);
        assert.equal(bucket.has(VERIFIED_PATH), true);
        assert.deepEqual(db.tables.temporaryData[0], submissionBefore);
        assert.equal(bucket.has(TEMP_PATH), true);
        assert.deepEqual(bucket.calls.filter((c) => c.method === "remove").map((c) => c.paths), [[REVIEW_PATH]]);

        const [entry] = db.tables.auditLog;
        assert.equal(db.tables.auditLog.length, 1);
        assert.deepEqual(
            { action: entry.action, adminId: entry.adminId, documentId: entry.documentId, temporaryId: entry.temporaryId, passportId: entry.passportId, previousStatus: entry.previousStatus, newStatus: entry.newStatus, reason: entry.reason, documentType: entry.documentType, fileSha256: entry.fileSha256 },
            { action: "REMOVE_FROM_REVIEW", adminId: "admin-active", documentId: REVIEW_ID, temporaryId: TEMP, passportId: PASSPORT, previousStatus: "REVIEW_REQUIRED", newStatus: "REMOVED", reason: "Blurry duplicate; the verified passport is correct", documentType: "PASSPORT", fileSha256: "b".repeat(64) }
        );
        assert.equal("fileSha256" in response.body.audit, false, "checksum never returned");
    });

    test("afterwards: gone from the queue and the Overview count; detail 404; the entry can't be changed", async () => {
        const { db } = use(setup());
        assert.equal((await call("GET", "/review")).body.summary.total, 1);
        await remove(`document-${REVIEW_ID}`);
        assert.equal((await call("GET", "/review")).body.summary.total, 0);
        assert.equal((await call("GET", "/overview")).body.kpis.pendingReview, 0);
        assert.equal((await call("GET", `/review/document-${REVIEW_ID}`)).status, 404);
        assert.equal((await remove(`document-${REVIEW_ID}`)).status, 404, "no second removal");
        await assert.rejects(db.client.auditLog.delete({ where: { auditId: db.tables.auditLog[0].auditId } }), /append-only/);
        // The client still has its verified passport (required-document status unchanged).
        const client = await call("GET", `/clients/${PASSPORT}`);
        assert.equal(client.body.requiredDocuments.find((r) => r.documentType === "PASSPORT").status, "VERIFIED");
    });

    test("a VERIFIED document can never be removed (404, nothing changed)", async () => {
        const { db, bucket } = use(setup());
        const response = await remove(`document-${VERIFIED_ID}`);
        assert.equal(response.status, 404);
        assert.equal(db.tables.document.length, 2);
        assert.equal(db.tables.auditLog.length, 0);
        assert.equal(bucket.calls.length, 0);
    });

    test("reason required; admin from the token; inactive admin refused", async () => {
        const { db } = use(setup());
        for (const body of [{}, { reason: "" }, { reason: "   " }, { reason: 5 }, { reason: "x".repeat(501) }]) {
            assert.equal((await call("POST", `/review/document-${REVIEW_ID}/remove`, { body })).status, 400, JSON.stringify(body));
        }
        assert.equal((await call("POST", `/review/document-${REVIEW_ID}/remove`, { body: { reason: "x" }, token: tokenFor("admin-inactive") })).status, 401);
        assert.equal(db.tables.document.length, 2);
        await call("POST", `/review/document-${REVIEW_ID}/remove`, { body: { reason: "x", adminId: "admin-inactive" } });
        assert.equal(db.tables.auditLog[0].adminId, "admin-active");
    });

    test("two removals at once: one succeeds, the other is refused; one audit entry", async () => {
        const { db } = use(setup());
        const results = await Promise.all([remove(`document-${REVIEW_ID}`), remove(`document-${REVIEW_ID}`)]);
        const statuses = results.map((r) => r.status).sort();
        assert.equal(statuses[0], 200);
        assert.ok([404, 409].includes(statuses[1]), `second removal refused (${statuses[1]})`); // 409 while locked, 404 once gone
        assert.equal(db.tables.auditLog.length, 1);
        assert.ok(db.tables.document.some((d) => d.documentId === VERIFIED_ID));
    });

    test("if the document was approved meanwhile, nothing is removed (the delete only matches REVIEW_REQUIRED)", async () => {
        const { db, bucket } = setup();
        const findFirst = db.client.document.findFirst;
        let reads = 0;
        db.client.document.findFirst = async (args) => {
            const result = await findFirst(args);
            if (++reads === 1) db.tables.document.find((d) => d.documentId === REVIEW_ID).verificationStatus = "VERIFIED"; // approved by someone else
            return result;
        };
        await assert.rejects(removeFromReview({ db: db.client, bucket, admin: { adminId: "admin-active" }, reviewId: `document-${REVIEW_ID}`, reason: "x" }), { code: "ALREADY_RESOLVED" });
        assert.equal(db.tables.document.length, 2);
        assert.equal(db.tables.auditLog.length, 0);
        assert.equal(bucket.has(REVIEW_PATH), true);
    });

    test("a failed audit write or row delete changes nothing", async () => {
        for (const failing of ["auditLog.create", "document.deleteMany"]) {
            const { db, bucket } = use(setup());
            db.failNext(failing, new Error("boom"));
            assert.equal((await remove(`document-${REVIEW_ID}`)).status, 500, failing);
            assert.equal(db.tables.document.length, 2, failing);
            assert.equal(db.tables.auditLog.length, 0, failing);
            assert.equal(bucket.has(REVIEW_PATH), true, failing);
        }
    });

    test("a file still used by another document row is not deleted", async () => {
        const other = doc({ documentId: "44444444-4444-4444-8444-444444444444", storedFilename: "scan.pdf", storagePath: REVIEW_PATH, verificationStatus: "VERIFIED", documentType: "MEDICAL", fileSha256: "c".repeat(64) });
        const { db, bucket } = use(setup({ documents: [verifiedDoc, reviewDoc, other] }));
        assert.equal((await remove(`document-${REVIEW_ID}`)).status, 200);
        assert.equal(bucket.has(REVIEW_PATH), true);
        assert.equal(db.tables.document.length, 2);
    });

    test("file deletion failing after the commit: the item is still gone, filesDeleted false", async () => {
        const { db } = use(setup({ bucketOptions: { failRemove: true } }));
        const response = await remove(`document-${REVIEW_ID}`);
        assert.equal(response.status, 200);
        assert.equal(response.body.filesDeleted, false);
        assert.equal(db.tables.document.some((d) => d.documentId === REVIEW_ID), false);
    });

    test("only Remove from Review deletes document rows, and only REVIEW_REQUIRED ones", () => {
        const sources = fs.readdirSync(new URL("../src/services/", import.meta.url)).map((f) => [f, fs.readFileSync(new URL(`../src/services/${f}`, import.meta.url), "utf8")]);
        assert.deepEqual(sources.filter(([, code]) => /document\.(delete|deleteMany)\(/.test(code)).map(([f]) => f), ["adminReviewActionService.js"]);
        const code = sources.find(([f]) => f === "adminReviewActionService.js")[1];
        assert.equal(code.match(/document\.(delete|deleteMany)\(/g).length, 1);
        assert.match(code, /tx\.document\.deleteMany\(\{\s*where: \{ documentId: row\.documentId, verificationStatus: VERIFICATION_STATUS\.REVIEW_REQUIRED \}/);
    });
});

describe("B: a new low-confidence document of a type the client already has verified goes to pending/", () => {
    const base = { processingStatus: "UNCLEAR", band: "UNCLEAR", documentType: "MEDICAL", clientIdentified: true, uniqueId: "0001", checksumOutcome: "NEW" };

    test("decidePlacement: UNCLEAR + verified of that type -> pending; everything else unchanged", () => {
        assert.deepEqual(decidePlacement({ ...base, verifiedOfTypeExists: true }), { placement: PLACEMENT.PENDING, processingStatus: "UNCLEAR", pendingOwner: "0001" });
        assert.equal(decidePlacement({ ...base, verifiedOfTypeExists: false }).placement, PLACEMENT.CLIENT);
        assert.equal(decidePlacement(base).placement, PLACEMENT.CLIENT, "default: no verified document");
        // Bands stored as VERIFIED keep today's versioning (M4, not changed here).
        for (const band of ["VERIFIED", "HIGH_CONFIDENCE", "SLIGHTLY_UNCLEAR"]) {
            assert.equal(decidePlacement({ ...base, band, processingStatus: band, verifiedOfTypeExists: true }).placement, PLACEMENT.CLIENT, band);
        }
    });

    // text-passport / medical fixtures belong to N1234567, WhatsApp 0771234567.
    const users = () => [{ passportId: "N1234567", uniqueId: "0001", whatsappNumber: "0771234567", firstName: "KAMAL NIMAL", otherName: null, dateOfBirth: null, placeOfBirth: null, passportExpiryDate: null }];
    const existingVerified = { documentId: "d-verified", passportId: "N1234567", documentType: "MEDICAL", verificationStatus: "VERIFIED", fileSha256: "e".repeat(64), storagePath: "clients/N1234567/medical/medical.pdf" };
    async function run(documents) {
        const db = createFakePrisma(users(), { documents });
        const bucket = createFakeBucket(["temporary/tmp-1.pdf", "clients/N1234567/medical/medical.pdf"]);
        const { summary } = await processDocument({
            temporaryId: "tmp-1", whatsappNumber: "94771234567", fileName: "medical scan.pdf", mimeType: "application/pdf",
            fileBuffer: Buffer.from("%PDF-1.4 synthetic low quality medical"), temporaryStoragePath: "temporary/tmp-1.pdf",
            deps: { db, bucket, now: new Date("2026-09-24T07:05:03Z"), extractText: async () => ({ success: true, method: "OCR", text: loadDocumentText("medical-gamca"), confidence: 50 }) },
        });
        return { summary, db, bucket, update: db.calls.filter((c) => c.method === "temporaryData.update").at(-1) };
    }

    test("pipeline: the new UNCLEAR medical waits in pending/, not in the client folder; the verified one is untouched", async () => {
        const verifiedBefore = { ...existingVerified };
        const { summary, db, bucket, update } = await run([existingVerified]);
        assert.equal(summary.processingStatus, "UNCLEAR");
        assert.equal(summary.storage.placement, "PENDING");
        assert.equal(summary.storage.documentStored, false);
        assert.equal(db.documentRows.length, 1, "no REVIEW_REQUIRED document created");
        assert.deepEqual(db.documentRows[0], verifiedBefore);
        assert.ok(update.data.pendingStoragePath.startsWith("pending/0001/undefined/uncleared-docs/"));
        assert.ok(bucket.has(update.data.pendingStoragePath));
        assert.equal(bucket.has("clients/N1234567/medical/medical.pdf"), true);
        assert.equal([...bucket.objects.keys()].filter((p) => p.startsWith("clients/")).length, 1, "nothing new in the client folder");
        assert.equal(update.data.passportId, "N1234567", "still linked to the client");
        assert.equal(update.data.reviewReason, "LOW_CONFIDENCE");
    });

    test("pipeline: without a verified medical the UNCLEAR medical is still stored as REVIEW_REQUIRED (unchanged)", async () => {
        const { summary, db } = await run([{ ...existingVerified, verificationStatus: "REVIEW_REQUIRED" }]);
        assert.equal(summary.storage.placement, "CLIENT");
        assert.equal(db.documentRows.at(-1).verificationStatus, "REVIEW_REQUIRED");
    });

    test("the waiting file is not stuck: it can be removed from review (Approve stays blocked by the verified one)", async () => {
        const db = createFakeReviewDb({
            admins: ADMINS, users: [{ passportId: "N1234567", uniqueId: "0001", firstName: "KAMAL" }],
            documents: [existingVerified],
            temporaryData: [{ ...submission, passportId: "N1234567", documentType: "MEDICAL", pendingStoragePath: "pending/0001/undefined/uncleared-docs/document_1.pdf" }],
        });
        use({ db, bucket: createFakeBucket(["pending/0001/undefined/uncleared-docs/document_1.pdf", TEMP_PATH, existingVerified.storagePath]) });
        const detail = await call("GET", `/review/pending-${TEMP}`);
        assert.equal(detail.body.actions.approve.code, "VERIFIED_DOCUMENT_EXISTS");
        assert.equal(detail.body.actions.remove.available, true);
        assert.equal((await remove(`pending-${TEMP}`)).status, 200);
        assert.deepEqual(db.tables.document, [existingVerified]);
    });
});
