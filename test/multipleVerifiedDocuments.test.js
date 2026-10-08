import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

import { processDocument, PROCESSING_STATUS } from "../src/services/documentProcessingService.js";
import { decidePlacement, PLACEMENT, CLIENT_BANDS } from "../src/services/storagePlacementService.js";
import { VERIFICATION_STATUS } from "../src/services/clientDocumentService.js";
import { REVIEW_REASON, deriveReviewReason } from "../src/services/reviewReason.js";
import { REVIEW_ACTION, replaceVerifiedDocument, keepDocumentAsVersion, reviewActionAvailability, ReviewActionError } from "../src/services/adminReviewActionService.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createRequireActiveUser } from "../src/middleware/requireActiveUser.js";
import { sha256Hex } from "../src/utils/fileChecksum.js";
import { createFakePrisma } from "./helpers/fakePrisma.js";
import { createFakeReviewDb } from "./helpers/fakeReviewDb.js";
import { createFakeBucket } from "./helpers/fakeStorage.js";
import { loadDocumentText } from "./helpers/fixtures.js";
import { fakeVerifyAccessToken, tokenFor } from "./helpers/fakeSupabaseAuth.js";

Object.assign(process.env, {
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-placeholder",
    DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
    META_APP_SECRET: "test-app-secret-placeholder",
});
const { createApp } = await import("../src/createApp.js");

// M4 (Policy B): multiple VERIFIED documents of the same type. A client
// already has a VERIFIED document of a type; a *different*, well-read file
// of the same type must never automatically become a second VERIFIED
// document. It waits in pending/ for an admin: Replace (the old one is kept,
// marked SUPERSEDED), Keep as a separate version (stored REVIEW_REQUIRED,
// the existing VERIFIED document stays current), or Remove (the existing
// Remove-from-Review action, unchanged). Synthetic data only.
// text-passport.pdf belongs to N1234567 (unique ID 0001, WhatsApp 0771234567).
const PASSPORT_PDF = readFileSync(new URL("./fixtures/files/text-passport.pdf", import.meta.url));
const OTHER_PDF = (label) => Buffer.from(`%PDF-1.4\n% synthetic ${label}\n%%EOF\n`);
const sha = (buffer) => sha256Hex(buffer);
const textOf = (name, confidence = 97) => async () => ({ success: true, method: "OCR", text: loadDocumentText(name), confidence });
const users = () => [{ passportId: "N1234567", uniqueId: "0001", whatsappNumber: "0771234567", firstName: "KAMAL NIMAL", otherName: null, dateOfBirth: null, placeOfBirth: null, passportExpiryDate: null }];

// ---------------------------------------------------------------- pipeline (items 1-4, 6-7)

const TEMP_PATH = "temporary/tmp-1.pdf";

async function runPipeline({ documentType, folder, existingFilename, newFileBuffer, extractText, documents = [] }) {
    const existingPath = `clients/N1234567/${folder}/${existingFilename}`;
    const db = createFakePrisma(users(), { documents });
    // The existing file in storage only exists when there is a matching row for it.
    const bucket = createFakeBucket(documents.length ? [TEMP_PATH, existingPath] : [TEMP_PATH]);
    const { summary } = await processDocument({
        temporaryId: "tmp-1", whatsappNumber: "94771234567", fileName: `${folder}.pdf`, mimeType: "application/pdf",
        fileBuffer: newFileBuffer, temporaryStoragePath: TEMP_PATH,
        deps: { db, bucket, now: new Date("2026-09-27T07:00:00Z"), extractText },
    });
    const update = db.calls.filter((c) => c.method === "temporaryData.update").at(-1)?.data;
    return { summary, db, bucket, update, objects: [...bucket.objects.keys()], documentType };
}

const CASES = [
    { name: "passport", documentType: "PASSPORT", folder: "passport", existingFilename: "passport.pdf", newFileBuffer: OTHER_PDF("different passport"), extractText: textOf("passport-mrz") },
    { name: "medical", documentType: "MEDICAL", folder: "medical", existingFilename: "medical.pdf", newFileBuffer: OTHER_PDF("different medical"), extractText: textOf("medical-gamca") },
    { name: "police report", documentType: "POLICE_REPORT", folder: "police-report", existingFilename: "police_report.pdf", newFileBuffer: OTHER_PDF("different police report"), extractText: textOf("police-clearance") },
];

describe("M4 Policy B: pipeline — a different, well-read file of an already-verified type", () => {
    for (const { name, documentType, folder, existingFilename, newFileBuffer, extractText } of CASES) {
        // Items 1, 2, 3: passport / medical / police -> pending review.
        test(`${name}: existing VERIFIED + different high-confidence file -> pending review, not a second VERIFIED document`, async () => {
            const existingPath = `clients/N1234567/${folder}/${existingFilename}`;
            const existingDoc = { documentId: "d-verified", passportId: "N1234567", documentType, fileSha256: sha(Buffer.from(`original ${name}`)), verificationStatus: "VERIFIED", storagePath: existingPath, storedFilename: existingFilename };
            const { summary, db, update, objects } = await runPipeline({ documentType, folder, existingFilename, newFileBuffer, extractText, documents: [existingDoc] });

            assert.equal(summary.storage.placement, "PENDING", name);
            assert.equal(summary.storage.checksum, "NEW", name);
            assert.notEqual(summary.processingStatus, "FAILED", name);
            assert.ok(update.pendingStoragePath?.startsWith("pending/0001/undefined/uncleared-docs/"), name);
            // Item 7: no passport_v2.pdf-style file, no second document row.
            assert.equal(db.documentRows.length, 1, `${name}: no second document row created`);
            assert.equal(objects.filter((p) => p.startsWith("clients/")).length, 1, `${name}: no new file in the client folder`);
            // Item 6: the existing VERIFIED document is byte-for-byte unchanged.
            assert.deepEqual(db.documentRows[0], existingDoc, `${name}: existing verified document unchanged`);
            assert.ok(objects.includes(existingPath), `${name}: existing file still present`);
            // Item 9 (reason): EXISTING_VERIFIED_DOCUMENT, except the H4 UNCLEAR
            // case, which keeps its own LOW_CONFIDENCE reason (unchanged, tested elsewhere).
            assert.equal(update.reviewReason, REVIEW_REASON.EXISTING_VERIFIED_DOCUMENT, name);
            assert.equal(update.passportId, "N1234567", `${name}: still linked to the client`);
            assert.equal(update.documentType, documentType, name);
        });
    }

    // Item 4: no existing VERIFIED document -> unchanged behaviour (still becomes VERIFIED).
    test("no existing VERIFIED document of the type -> unchanged: the new file is stored and VERIFIED", async () => {
        const { summary, db, objects } = await runPipeline({
            documentType: "MEDICAL", folder: "medical", existingFilename: "medical.pdf", newFileBuffer: OTHER_PDF("first medical"), extractText: textOf("medical-gamca"), documents: [],
        });
        assert.equal(summary.storage.placement, "CLIENT");
        assert.equal(summary.processingStatus, "VERIFIED");
        assert.equal(db.documentRows.length, 1);
        assert.equal(db.documentRows[0].verificationStatus, "VERIFIED");
        assert.equal(objects.filter((p) => p.startsWith("clients/")).length, 1);
    });

    // Item 5: exact checksum duplicate of a VERIFIED document -> unchanged M4 DUPLICATE flow.
    test("exact checksum duplicate of the existing VERIFIED document -> unchanged DUPLICATE flow (not this policy)", async () => {
        const existingDoc = { documentId: "d-verified", passportId: "N1234567", documentType: "MEDICAL", fileSha256: sha(PASSPORT_PDF), verificationStatus: "VERIFIED", storagePath: "clients/N1234567/medical/medical.pdf", storedFilename: "medical.pdf" };
        const { summary, db, update } = await runPipeline({
            documentType: "MEDICAL", folder: "medical", existingFilename: "medical.pdf", newFileBuffer: PASSPORT_PDF, extractText: textOf("medical-gamca"), documents: [existingDoc],
        });
        assert.equal(summary.processingStatus, "DUPLICATE");
        assert.equal(summary.storage.checksum, "DUPLICATE");
        assert.equal(update.reviewReason, REVIEW_REASON.DUPLICATE_OF_VERIFIED, "the exact-duplicate reason, not EXISTING_VERIFIED_DOCUMENT");
        assert.equal(db.documentRows.length, 1, "no second document row");
    });

    // Regression: H4 (UNCLEAR band) keeps its own, unchanged reason and behaviour.
    test("H4 unchanged: an UNCLEAR-band different file of an already-verified type still uses LOW_CONFIDENCE, not the new M4 reason", async () => {
        const existingDoc = { documentId: "d-verified", passportId: "N1234567", documentType: "MEDICAL", fileSha256: sha(Buffer.from("original medical")), verificationStatus: "VERIFIED", storagePath: "clients/N1234567/medical/medical.pdf", storedFilename: "medical.pdf" };
        const { summary, update } = await runPipeline({
            documentType: "MEDICAL", folder: "medical", existingFilename: "medical.pdf", newFileBuffer: OTHER_PDF("unclear medical"),
            extractText: async () => ({ success: true, method: "OCR", text: loadDocumentText("medical-gamca"), confidence: 50 }), documents: [existingDoc],
        });
        assert.equal(summary.processingStatus, "UNCLEAR");
        assert.equal(summary.storage.placement, "PENDING");
        assert.equal(update.reviewReason, REVIEW_REASON.LOW_CONFIDENCE);
    });

    test("units: decidePlacement and deriveReviewReason", () => {
        const base = { processingStatus: "VERIFIED", band: "VERIFIED", documentType: "PASSPORT", clientIdentified: true, uniqueId: "0001", checksumOutcome: "NEW" };
        assert.deepEqual(decidePlacement({ ...base, verifiedOfTypeExists: true }), { placement: PLACEMENT.PENDING, processingStatus: "VERIFIED", pendingOwner: "0001" });
        assert.equal(decidePlacement({ ...base, verifiedOfTypeExists: false }).placement, PLACEMENT.CLIENT);
        for (const band of CLIENT_BANDS) {
            assert.equal(decidePlacement({ ...base, band, processingStatus: band, verifiedOfTypeExists: true }).placement, PLACEMENT.PENDING, band);
        }
        assert.equal(deriveReviewReason({ processingStatus: "VERIFIED", confidence: { band: "VERIFIED" }, verifiedOfTypeExists: true }), REVIEW_REASON.EXISTING_VERIFIED_DOCUMENT);
        assert.equal(deriveReviewReason({ processingStatus: "HIGH_CONFIDENCE", confidence: { band: "HIGH_CONFIDENCE" }, verifiedOfTypeExists: false }), null);
        // Every other reason still takes priority (verifiedOfTypeExists never overrides them).
        assert.equal(deriveReviewReason({ processingStatus: "MANUAL_REVIEW", confidence: { band: "SLIGHTLY_UNCLEAR" }, identity: { reviewRequired: true }, verifiedOfTypeExists: true }), REVIEW_REASON.IDENTITY_NOT_CONFIRMED);
    });
});

// ---------------------------------------------------------------- admin review (items 8-16)

const V = "11111111-1111-4111-8111-111111111111"; // the existing VERIFIED document
const T = "22222222-2222-4222-8222-222222222222"; // the waiting file
const OTHER_T = "33333333-3333-4333-8333-333333333333";
const PENDING_PATH = "pending/0001/undefined/uncleared-docs/document_20260927_070000.pdf";
const OTHER_PENDING_PATH = "pending/0001/undefined/uncleared-docs/document_20260927_070100.pdf";
const VERIFIED_PATH = "clients/N1234567/medical/medical.pdf";
const TEMP = "temporary/bbbb.pdf";
const OTHER_TEMP = "temporary/cccc.pdf";
const ADMINS = [
    { adminId: "admin-active", name: "Active Admin", email: "a@example.invalid", passwordHash: "x", role: "ADMIN", status: "ACTIVE" },
    { adminId: "admin-other", name: "Other Admin", email: "o@example.invalid", passwordHash: "x", role: "ADMIN", status: "ACTIVE" },
    { adminId: "admin-disabled", name: "Disabled Admin", email: "d@example.invalid", passwordHash: "x", role: "ADMIN", status: "DISABLED" },
];
const verifiedRow = {
    documentId: V, passportId: "N1234567", documentType: "MEDICAL", originalFilename: "medical.pdf", storedFilename: "medical.pdf", storagePath: VERIFIED_PATH,
    mimeType: "application/pdf", fileSize: 10n, receivedDate: new Date("2026-09-20T03:00:00Z"), processingStatus: "STORED", verificationStatus: "VERIFIED",
    ocrConfidence: 96, fileSha256: sha(Buffer.from("original medical")), temporaryId: null, policeSubmittedDate: null,
};
const NEW_FILE = Buffer.from("a different, well-read medical scan");
const pendingRow = (overrides = {}) => ({
    temporaryId: T, passportId: "N1234567", uniqueId: "0001", whatsappNumber: "94771234567", documentType: "MEDICAL", temporaryStoragePath: TEMP,
    processingStatus: "VERIFIED", createdDate: new Date("2026-09-27T07:00:00Z"), fileSha256: sha(NEW_FILE), pendingStoragePath: PENDING_PATH,
    processingSummary: { stage: "COMPLETED", confidence: { document: 95 }, storage: { checksum: "NEW", placement: "PENDING" } },
    reviewReason: "EXISTING_VERIFIED_DOCUMENT",
    ...overrides,
});
function setup({ documents = [verifiedRow], temporaryData = [pendingRow()], bucketPaths = [VERIFIED_PATH, PENDING_PATH, TEMP], files = {} } = {}) {
    const db = createFakeReviewDb({ admins: ADMINS, users: [{ passportId: "N1234567", uniqueId: "0001", firstName: "KAMAL", otherName: "PERERA" }], documents, temporaryData });
    const bucket = createFakeBucket(bucketPaths);
    // Approve, Replace and Keep-as-Version all read the pending file once to
    // verify its checksum still matches what was received (fakeStorage.js has
    // no download(); every review-action test file provides its own, as here).
    const contents = { [PENDING_PATH]: NEW_FILE, [OTHER_PENDING_PATH]: Buffer.from("yet another medical scan"), ...files };
    bucket.download = async (path) => (bucket.has(path) ? { data: contents[path] ?? Buffer.from(`bytes of ${path}`), error: null } : { data: null, error: { message: "Object not found" } });
    return { db, bucket };
}
const token = tokenFor("admin-active");
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
    current = { ...fixture, router: createAdminRouter({ apiLimiter: (req, res, next) => next(), db: fixture.db.client, bucket: fixture.bucket, requireAdmin: createRequireActiveUser({ db: fixture.db.client, verifyAccessToken: fakeVerifyAccessToken }) }) };
    return fixture;
}
async function call(method, path, body, { authToken = token } = {}) {
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
}
const replace = (reviewId, body, opts) => call("POST", `/review/${reviewId}/replace-verified`, body, opts);
const keepVersion = (reviewId, body, opts) => call("POST", `/review/${reviewId}/keep-as-version`, body, opts);

describe("M4 Policy B: admin review", () => {
    // Item 8.
    test("the waiting file is in the Review Queue with its reason, filterable, counted as pending review", async () => {
        use(setup());
        const queue = await call("GET", "/review");
        assert.equal(queue.body.items.length, 1);
        const [item] = queue.body.items;
        assert.deepEqual([item.reviewId, item.kind, item.documentType, item.reviewReason, item.client.passportId],
            [`pending-${T}`, "PENDING", "MEDICAL", "EXISTING_VERIFIED_DOCUMENT", "N1234567"]);
        assert.equal((await call("GET", "/review?reviewReason=EXISTING_VERIFIED_DOCUMENT")).body.items.length, 1);
        assert.equal((await call("GET", "/overview")).body.kpis.pendingReview, 1);
    });

    // Item 9.
    test("Review Detail identifies the incoming file, its type, the client, the existing verified document and the reason", async () => {
        use(setup());
        const { status, body } = await call("GET", `/review/pending-${T}`);
        assert.equal(status, 200);
        assert.equal(body.reviewReason, "EXISTING_VERIFIED_DOCUMENT");
        assert.equal(body.document.documentType, "MEDICAL");
        assert.deepEqual(body.client, { passportId: "N1234567", uniqueId: "0001", name: "KAMAL PERERA" });
        assert.deepEqual(body.existingVerified, { documentId: V, documentType: "MEDICAL", storedFilename: "medical.pdf", verificationStatus: "VERIFIED", receivedDate: "2026-09-20T03:00:00.000Z" });
        assert.equal(body.actions.approve.available, false);
        assert.equal(body.actions.approve.code, "VERIFIED_DOCUMENT_EXISTS");
        assert.equal(body.actions.replaceVerified.available, true);
        assert.equal(body.actions.keepAsVersion.available, true);
        assert.equal(body.actions.remove.available, true);
        const text = JSON.stringify(body);
        assert.ok(!text.includes(verifiedRow.fileSha256) && !text.includes(VERIFIED_PATH) && !text.includes(PENDING_PATH), "no checksums or storage paths");
    });

    // Item 10.
    test("Replace: the old document is kept and marked SUPERSEDED; the new one is VERIFIED; audited; the old file is never touched", async () => {
        const { db, bucket } = use(setup());
        const response = await replace(`pending-${T}`, { documentId: V, reason: "Client sent a clearer scan" });
        assert.equal(response.status, 200);
        assert.equal(response.body.action, "REPLACE_VERIFIED");
        assert.deepEqual(response.body.document, { documentId: response.body.document.documentId, storedFilename: "medical_v2.pdf", verificationStatus: "VERIFIED", location: "CLIENT", policeSubmittedDate: null });
        assert.deepEqual(response.body.replaced, { documentId: V, verificationStatus: "SUPERSEDED" });

        const old = db.tables.document.find((d) => d.documentId === V);
        const fresh = db.tables.document.find((d) => d.documentId === response.body.document.documentId);
        assert.equal(old.verificationStatus, "SUPERSEDED");
        assert.deepEqual({ ...old, verificationStatus: "VERIFIED" }, verifiedRow, "nothing else about the old document changed");
        assert.equal(bucket.has(VERIFIED_PATH), true, "the old file is never touched or removed");
        assert.equal(fresh.verificationStatus, "VERIFIED");
        assert.equal(fresh.storagePath, "clients/N1234567/medical/medical_v2.pdf");
        assert.equal(bucket.has("clients/N1234567/medical/medical_v2.pdf"), true);
        assert.equal(db.tables.temporaryData[0].processingStatus, "VERIFIED");
        assert.equal(db.tables.temporaryData[0].pendingStoragePath, null);
        assert.equal(bucket.has(PENDING_PATH), false, "the pending copy is removed after the move");

        const [entry] = db.tables.auditLog;
        assert.deepEqual(
            [entry.action, entry.adminId, entry.temporaryId, entry.documentId, entry.previousValue, entry.newValue, entry.passportId, entry.reason, entry.documentType],
            [REVIEW_ACTION.REPLACE_VERIFIED, "admin-active", T, fresh.documentId, V, fresh.documentId, "N1234567", "Client sent a clearer scan", "MEDICAL"],
        );
        assert.equal((await call("GET", "/review")).body.items.length, 0, "no longer a review item");
    });

    // Item 11.
    test("Keep as Version: the new file is stored REVIEW_REQUIRED; the existing document stays VERIFIED and current; the new one can never itself become VERIFIED while the other stays VERIFIED", async () => {
        const { db, bucket } = use(setup());
        const response = await keepVersion(`pending-${T}`, { reason: "Keep both on file for now" });
        assert.equal(response.status, 200);
        assert.equal(response.body.action, "KEEP_AS_VERSION");
        assert.equal(response.body.document.verificationStatus, "REVIEW_REQUIRED");

        const old = db.tables.document.find((d) => d.documentId === V);
        const fresh = db.tables.document.find((d) => d.documentId === response.body.document.documentId);
        assert.deepEqual(old, verifiedRow, "the existing verified document is completely unchanged");
        assert.equal(fresh.verificationStatus, "REVIEW_REQUIRED");
        assert.equal(bucket.has(VERIFIED_PATH), true);
        assert.equal(bucket.has(fresh.storagePath), true);

        // Design gap (reported, not solved): a true second, simultaneously
        // VERIFIED row has no field to mark it "current" — see the M4
        // Implementation Report. The safe interpretation is enforced by the
        // existing Approve blocker: the kept version can never itself become
        // VERIFIED while the original stays VERIFIED.
        const availability = await reviewActionAvailability({ db: db.client, reviewId: `document-${fresh.documentId}` });
        assert.equal(availability.approve.available, false);
        assert.equal(availability.approve.code, "VERIFIED_DOCUMENT_EXISTS");

        const [entry] = db.tables.auditLog;
        assert.deepEqual([entry.action, entry.newStatus, entry.documentType], [REVIEW_ACTION.KEEP_AS_VERSION, "REVIEW_REQUIRED", "MEDICAL"]);
    });

    // Item 12.
    test("Remove: the waiting file is removed from review; the existing verified document is untouched; the audit entry remains", async () => {
        const { db, bucket } = use(setup());
        const response = await call("POST", `/review/pending-${T}/remove`, { reason: "Ask the client to confirm which one is correct" });
        assert.equal(response.status, 200);
        assert.equal(db.tables.temporaryData.length, 0);
        assert.equal(bucket.has(PENDING_PATH), false);
        assert.equal(bucket.has(TEMP), false);
        assert.deepEqual(db.tables.document, [verifiedRow], "existing verified document unchanged");
        assert.equal(bucket.has(VERIFIED_PATH), true);
        const [entry] = db.tables.auditLog;
        assert.deepEqual([entry.action, entry.temporaryId, entry.previousStatus, entry.newStatus], ["REMOVE_FROM_REVIEW", T, "VERIFIED", "REMOVED"]);
        assert.equal((await call("GET", "/review")).body.items.length, 0);
    });

    // Item 13.
    test("unauthorized: no token, a garbage token, or the wrong secret cannot Replace or Keep as Version; nothing changes", async () => {
        use(setup());
        for (const authToken of [null, "not-a-jwt", "forged.signature.token"]) {
            const r1 = await replace(`pending-${T}`, { documentId: V }, { authToken });
            const r2 = await keepVersion(`pending-${T}`, {}, { authToken });
            assert.equal(r1.status, 401, String(authToken));
            assert.equal(r2.status, 401, String(authToken));
        }
        assert.equal(current.db.tables.document.length, 1);
        assert.equal(current.db.tables.auditLog.length, 0);
    });

    // Item 14.
    test("a deactivated admin cannot Replace or Keep as Version; nothing changes", async () => {
        use(setup());
        const disabledToken = tokenFor("admin-disabled");
        assert.equal((await replace(`pending-${T}`, { documentId: V }, { authToken: disabledToken })).status, 403);
        assert.equal((await keepVersion(`pending-${T}`, {}, { authToken: disabledToken })).status, 403);
        assert.equal(current.db.tables.document.length, 1);
        assert.equal(current.db.tables.auditLog.length, 0);
    });

    // Item 15a: two admins try to Replace the same waiting item at once.
    test("concurrent Replace on the same waiting item: one succeeds, the other is rejected; exactly one new document", async () => {
        const { db } = use(setup());
        const results = await Promise.all([
            replace(`pending-${T}`, { documentId: V, reason: "first" }, { authToken: tokenFor("admin-active") }),
            replace(`pending-${T}`, { documentId: V, reason: "second" }, { authToken: tokenFor("admin-other") }),
        ]);
        // One wins (200). The other loses — 409 if it is still mid-flight when
        // the winner commits, or 404 if by the time it re-checks the item has
        // already been resolved (fully realistic depending on exact timing);
        // either way it never wins too.
        assert.equal(results.filter((r) => r.status === 200).length, 1);
        assert.equal(results.filter((r) => r.status === 409 || r.status === 404).length, 1);
        assert.equal(db.tables.document.filter((d) => d.verificationStatus === "VERIFIED").length, 1, "exactly one current verified document");
        assert.equal(db.tables.document.filter((d) => d.verificationStatus === "SUPERSEDED").length, 1);
        assert.equal(db.tables.document.length, 2, "no duplicate created by the loser");
        assert.equal(db.tables.auditLog.length, 1, "only the winner is audited");
    });

    // Item 15b: two different waiting items both try to replace the SAME existing document.
    test("concurrent Replace of the same target document from two different waiting items: one succeeds, the other sees it has changed", async () => {
        const other = pendingRow({ temporaryId: OTHER_T, temporaryStoragePath: OTHER_TEMP, pendingStoragePath: OTHER_PENDING_PATH, fileSha256: sha(Buffer.from("yet another medical scan")) });
        const { db, bucket } = use(setup({ temporaryData: [pendingRow(), other], bucketPaths: [VERIFIED_PATH, PENDING_PATH, TEMP, OTHER_PENDING_PATH, OTHER_TEMP] }));
        const results = await Promise.all([
            replace(`pending-${T}`, { documentId: V }, { authToken: tokenFor("admin-active") }),
            replace(`pending-${OTHER_T}`, { documentId: V }, { authToken: tokenFor("admin-other") }),
        ]);
        const statuses = results.map((r) => r.status).sort();
        assert.deepEqual(statuses, [200, 409]);
        const loser = results.find((r) => r.status === 409);
        assert.equal(loser.body.code, "VERIFIED_DOCUMENT_CHANGED");
        assert.equal(db.tables.document.filter((d) => d.verificationStatus === "VERIFIED").length, 1);
        assert.equal(db.tables.document.filter((d) => d.verificationStatus === "SUPERSEDED").length, 1);
        // The losing waiting item is untouched and can be retried once it re-reads the new current document.
        const stillPending = db.tables.temporaryData.find((r) => r.pendingStoragePath !== null);
        assert.ok(stillPending, "the loser's item is still pending, not lost");
    });

    // Item 16.
    test("a failed transaction leaves the existing verified document unchanged; nothing partial is committed", async () => {
        const { db, bucket } = use(setup());
        const create = db.client.document.create;
        db.client.document.create = async () => { throw new Error("connection lost"); };
        await assert.rejects(replaceVerifiedDocument({ db: db.client, bucket, admin: { adminId: "admin-active", name: "Active Admin" }, reviewId: `pending-${T}`, documentId: V }));
        db.client.document.create = create;

        assert.deepEqual(db.tables.document, [verifiedRow], "the existing document was never changed (its SUPERSEDED update rolled back too)");
        assert.equal(db.tables.temporaryData[0].pendingStoragePath, PENDING_PATH, "the waiting item is still pending, unresolved");
        assert.equal(db.tables.temporaryData[0].processingStatus, "VERIFIED");
        assert.equal(db.tables.auditLog.length, 0);
        assert.equal(bucket.has(VERIFIED_PATH), true);
    });

    test("Replace and Keep as Version refuse a mismatched or missing document ID, and a review item that is not this case", async () => {
        use(setup());
        assert.equal((await replace(`pending-${T}`, {})).status, 400, "documentId required");
        assert.equal((await replace(`pending-${T}`, { documentId: "00000000-0000-4000-8000-000000000000" })).status, 409, "well-formed but non-existent document ID");
        assert.equal((await replace(`document-${V}`, { documentId: V })).status, 404, "only a waiting file, not a stored document, in this version");
        const noVerifiedRow = pendingRow({ temporaryId: OTHER_T, temporaryStoragePath: OTHER_TEMP, pendingStoragePath: OTHER_PENDING_PATH, reviewReason: null });
        use(setup({ documents: [], temporaryData: [noVerifiedRow], bucketPaths: [OTHER_PENDING_PATH, OTHER_TEMP] }));
        assert.equal((await keepVersion(`pending-${OTHER_T}`, {})).status, 409, "keep-as-version only applies when a verified document already exists");
    });

    test("a police slip replacement takes the submitted date, exactly like Approve", async () => {
        const policeVerified = { ...verifiedRow, documentId: "44444444-4444-4444-8444-444444444444", documentType: "POLICE_SLIP", storedFilename: "police_slip.pdf", storagePath: "clients/N1234567/police-slip/police_slip.pdf", fileSha256: sha(Buffer.from("original slip")) };
        const policePending = pendingRow({ documentType: "POLICE_SLIP", processingStatus: "SLIGHTLY_UNCLEAR" });
        use(setup({ documents: [policeVerified], temporaryData: [policePending], bucketPaths: [policeVerified.storagePath, PENDING_PATH, TEMP] }));
        const missingDate = await replace(`pending-${T}`, { documentId: "44444444-4444-4444-8444-444444444444" });
        assert.equal(missingDate.status, 400);
        assert.equal(missingDate.body.code, "POLICE_DATE_REQUIRED");
        const ok = await replace(`pending-${T}`, { documentId: "44444444-4444-4444-8444-444444444444", policeSubmittedDate: "2026-09-20" });
        assert.equal(ok.status, 200);
        assert.equal(ok.body.document.policeSubmittedDate, "2026-09-20");
    });
});
