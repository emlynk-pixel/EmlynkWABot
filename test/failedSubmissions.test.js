import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { processDocument } from "../src/services/documentProcessingService.js";
import { OcrResourceError } from "../src/services/ocrContract.js";
import { describeFailure, FAILURE_CODE } from "../src/services/failureReason.js";
import { parseReviewQueueQuery } from "../src/services/adminReviewService.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createRequireActiveUser } from "../src/middleware/requireActiveUser.js";
import { sha256Hex } from "../src/utils/fileChecksum.js";
import { createFakePrisma } from "./helpers/fakePrisma.js";
import { createFakeReviewDb } from "./helpers/fakeReviewDb.js";
import { createFakeBucket } from "./helpers/fakeStorage.js";
import { fakeVerifyAccessToken, tokenFor } from "./helpers/fakeSupabaseAuth.js";
import "./helpers/localOcrService.js";

Object.assign(process.env, {
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-placeholder",
    DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
    META_APP_SECRET: "test-app-secret-placeholder",
});
const { createApp } = await import("../src/createApp.js");

// H3 — Failed submission visibility. Synthetic data only.
// text-passport.pdf belongs to N1234567 (unique ID 0001, WhatsApp 0771234567).
const file = (name) => readFileSync(new URL(`./fixtures/files/${name}`, import.meta.url));
const users = () => [{ passportId: "N1234567", uniqueId: "0001", whatsappNumber: "0771234567", firstName: "KAMAL NIMAL", otherName: null, dateOfBirth: null, placeOfBirth: null, passportExpiryDate: null }];

// Real processDocument; failures come from the real code or are injected at a boundary.
async function processFailing({ name, mimeType = "application/pdf", sender = "94771234567", bucketOptions = {}, extractText, temporaryId }) {
    const buffer = file(name);
    const db = createFakePrisma(users());
    const tempPath = `temporary/${temporaryId}.pdf`;
    const bucket = createFakeBucket([tempPath], bucketOptions);
    const { summary } = await processDocument({
        temporaryId, whatsappNumber: sender, fileName: name, mimeType, fileBuffer: buffer, temporaryStoragePath: tempPath,
        deps: { db, bucket, now: new Date("2026-09-27T06:00:00Z"), ...(extractText ? { extractText } : {}) },
    });
    const update = db.calls.filter((c) => c.method === "temporaryData.update").at(-1).data;
    // The row as it now stands in temporary_data (created on arrival, updated here).
    const row = {
        temporaryId, passportId: null, uniqueId: null, whatsappNumber: sender, documentType: "UNCLASSIFIED", temporaryStoragePath: tempPath,
        processingStatus: "TEMPORARY_STORED", createdDate: new Date("2026-09-27T06:00:00Z"), fileSha256: sha256Hex(buffer), pendingStoragePath: null, ...update,
    };
    return { summary, db, bucket, update, row, buffer };
}

const T_PAGES = "aaaaaaaa-0000-4000-8000-000000000001";
const T_STORAGE = "aaaaaaaa-0000-4000-8000-000000000002";
const T_BUSY = "aaaaaaaa-0000-4000-8000-000000000003";

describe("H3 pipeline: failures stay recorded, nothing is stored", () => {
    test("Test 1/6/7/8: a PDF over the page limit (real OCR check) -> FAILED row, unknown client, no document, no client or pending copy", async () => {
        const { summary, db, bucket, update } = await processFailing({ name: "many-pages.pdf", temporaryId: T_PAGES });
        assert.equal(summary.processingStatus, "FAILED");
        assert.equal(update.processingStatus, "FAILED");
        assert.equal(update.reviewReason, "PROCESSING_FAILED");
        assert.equal(update.processingSummary.stage, "TEXT_EXTRACTION");
        assert.equal(update.passportId, undefined, "failed before identity: no client, none invented");
        assert.equal(update.documentType, undefined, "failed before classification: type stays as received");
        assert.equal(update.pendingStoragePath, undefined);
        assert.ok(!db.calls.some((c) => c.method === "document.create" || c.method === "candidate.updateMany"));
        assert.deepEqual([...bucket.objects.keys()], [`temporary/${T_PAGES}.pdf`], "only the temporary original");
        assert.equal(describeFailure(update.processingSummary).code, "PDF_TOO_MANY_PAGES");
    });

    test("Test 5/7/8: storage failure after identification -> FAILED, linked to the client, no document, no client-folder file", async () => {
        const { summary, db, bucket, update } = await processFailing({ name: "text-passport.pdf", temporaryId: T_STORAGE, bucketOptions: { failCopy: true } });
        assert.equal(summary.processingStatus, "FAILED");
        assert.equal(update.processingSummary.stage, "STORAGE");
        assert.deepEqual([update.passportId, update.uniqueId], ["N1234567", "0001"], "the identified client is kept");
        assert.equal(update.documentType, "PASSPORT", "the detected type is kept");
        assert.equal(summary.storage, null);
        assert.ok(!db.calls.some((c) => c.method === "document.create"));
        assert.ok(![...bucket.objects.keys()].some((p) => p.startsWith("clients/")));
        assert.equal(describeFailure(update.processingSummary).code, "STORAGE_FAILED");
    });

    test("OCR queue full (injected at the text-reading boundary) -> FAILED with OCR_BUSY", async () => {
        const { update } = await processFailing({ name: "text-passport.pdf", temporaryId: T_BUSY, extractText: async () => { throw new OcrResourceError("OCR_BUSY"); } });
        assert.equal(update.processingStatus, "FAILED");
        assert.equal(describeFailure(update.processingSummary).code, "OCR_BUSY");
    });

    test("describeFailure: only real codes; unknown text never leaks", () => {
        assert.deepEqual(describeFailure({ stage: "TEXT_EXTRACTION", error: "OCR resource limit: OCR_TIMEOUT" }), { code: "OCR_TIMEOUT", stage: "TEXT_EXTRACTION" });
        assert.deepEqual(describeFailure({ stage: "TEXT_EXTRACTION", error: "OCR resource limit: SOMETHING_ELSE" }), { code: "TEXT_EXTRACTION_FAILED", stage: "TEXT_EXTRACTION" });
        assert.deepEqual(describeFailure({ stage: "IDENTITY", error: "connection refused [redacted]" }), { code: "PROCESSING_FAILED", stage: "IDENTITY" });
        assert.deepEqual(describeFailure({ stage: "STORAGE", error: "x" }), { code: "STORAGE_FAILED", stage: "STORAGE" });
        assert.deepEqual(describeFailure(null), { code: FAILURE_CODE.NOT_RECORDED, stage: null });
        assert.deepEqual(describeFailure({ stage: "whatever" }), { code: FAILURE_CODE.NOT_RECORDED, stage: null });
    });
});

// ---------------------------------------------------------------- admin API (rows from the pipeline above)

const ADMINS = [
    { adminId: "admin-active", name: "Active Admin", email: "a@example.invalid", passwordHash: "x", role: "ADMIN", status: "ACTIVE" },
    { adminId: "admin-inactive", name: "Inactive", email: "i@example.invalid", passwordHash: "x", role: "ADMIN", status: "INACTIVE" },
];
const T_WAITING = "bbbbbbbb-0000-4000-8000-000000000009";
let fixture;
let server;
let base;
before(async () => {
    const pages = await processFailing({ name: "many-pages.pdf", temporaryId: T_PAGES });
    const storage = await processFailing({ name: "text-passport.pdf", temporaryId: T_STORAGE, bucketOptions: { failCopy: true } });
    const waiting = { // an ordinary waiting item and a FAILED one that has a pending copy: both stay normal review items
        temporaryId: T_WAITING, passportId: null, uniqueId: null, whatsappNumber: "94779999999", documentType: "UNKNOWN", temporaryStoragePath: "temporary/w.pdf",
        processingStatus: "FAILED", createdDate: new Date("2026-09-27T05:00:00Z"), fileSha256: "c".repeat(64), pendingStoragePath: "pending/unidentified/w/undefined/uncleared-docs/w.pdf",
        processingSummary: { stage: "RECORD_UPDATE", error: "x" }, reviewReason: "PROCESSING_FAILED",
    };
    const db = createFakeReviewDb({ admins: ADMINS, users: [{ passportId: "N1234567", uniqueId: "0001", firstName: "KAMAL NIMAL", otherName: "PERERA" }], temporaryData: [pages.row, storage.row, waiting] });
    const bucket = createFakeBucket([pages.row.temporaryStoragePath, storage.row.temporaryStoragePath, waiting.pendingStoragePath]);
    const files = { [pages.row.temporaryStoragePath]: pages.buffer, [storage.row.temporaryStoragePath]: storage.buffer };
    bucket.download = async (p) => (files[p] ? { data: files[p], error: null } : { data: null, error: { message: "not found" } });
    fixture = { db, bucket };
    const app = createApp({ adminApiRouter: createAdminRouter({ apiLimiter: (req, res, next) => next(), db: db.client, bucket, requireAdmin: createRequireActiveUser({ db: db.client, verifyAccessToken: fakeVerifyAccessToken }) }) });
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}/api/admin`;
});
after(() => server.close());
const token = (adminId = "admin-active") => tokenFor(adminId);
async function call(method, path, { body, auth = token() } = {}) {
    const headers = auth ? { Authorization: `Bearer ${auth}` } : {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null), headers: response.headers, raw: response };
}

describe("H3 admin API", () => {
    test("Test 2/4/5/6: kind=FAILED lists failed submissions with a safe reason, the client when known, none invented", async () => {
        const { status, body } = await call("GET", "/review?kind=FAILED&order=desc");
        assert.equal(status, 200);
        assert.deepEqual(body.items.map((i) => i.reviewId).sort(), [`failed-${T_PAGES}`, `failed-${T_STORAGE}`]);
        const pages = body.items.find((i) => i.reviewId === `failed-${T_PAGES}`);
        const storage = body.items.find((i) => i.reviewId === `failed-${T_STORAGE}`);
        assert.deepEqual([pages.kind, pages.processingStatus, pages.reviewReason, pages.client], ["FAILED", "FAILED", "PROCESSING_FAILED", null]);
        assert.deepEqual(pages.failure, { code: "PDF_TOO_MANY_PAGES", stage: "TEXT_EXTRACTION" });
        assert.deepEqual(storage.client, { passportId: "N1234567", uniqueId: "0001", name: "KAMAL NIMAL PERERA" });
        assert.deepEqual(storage.failure, { code: "STORAGE_FAILED", stage: "STORAGE" });
        const text = JSON.stringify(body);
        assert.ok(!/OCR resource limit|Storage copy failed|temporary\/|fileSha256|error"/.test(text), "no raw error text, paths or checksums");
        assert.equal(fixture.db.tables.candidate.length, 1, "no client created");
    });

    test("the normal queue and Pending review are unchanged; failed submissions are counted on their own", async () => {
        const all = (await call("GET", "/review")).body;
        assert.deepEqual(all.items.map((i) => i.reviewId), [`pending-${T_WAITING}`], "a FAILED row with a pending copy stays a normal item");
        assert.equal(all.summary.total, 1);
        assert.equal(all.summary.failed, 2);
        assert.equal((await call("GET", "/review?kind=PENDING")).body.items.length, 1);
        const overview = (await call("GET", "/overview")).body;
        assert.equal(overview.kpis.pendingReview, 1, "FAILED not added to Pending review");
        assert.equal(overview.reviewQueue.failedSubmissions, 2);
        assert.equal(overview.submissionsByStatus.FAILED, 3, "the status breakdown already counted them");
    });

    test("filters and validation follow the queue conventions", async () => {
        assert.equal((await call("GET", "/review?kind=FAILED&documentType=PASSPORT")).body.items.length, 1);
        assert.equal((await call("GET", "/review?kind=FAILED&passportId=N1234567")).body.items.length, 1);
        assert.equal((await call("GET", "/review?kind=FAILED&reviewReason=LOW_CONFIDENCE")).body.items.length, 0);
        assert.equal((await call("GET", "/review?kind=BROKEN")).status, 400);
        assert.equal(parseReviewQueueQuery({ kind: "FAILED" }).params.kind, "FAILED");
    });

    test("Test 3/4: detail shows the failure, the sender and the original file; every action is unavailable", async () => {
        const { status, body } = await call("GET", `/review/failed-${T_PAGES}`);
        assert.equal(status, 200);
        assert.equal(body.kind, "FAILED");
        assert.deepEqual(body.failure, { code: "PDF_TOO_MANY_PAGES", stage: "TEXT_EXTRACTION" });
        assert.equal(body.client, null);
        assert.equal(body.submission.whatsappNumber, "94771234567");
        assert.equal(body.file.location, "TEMPORARY");
        assert.equal(body.file.previewUrl, `/api/admin/review/failed-${T_PAGES}/file`);
        for (const action of ["approve", "keepPending", "remove", "setDocumentType", "assignClient"]) {
            assert.equal(body.actions[action].available, false, action);
            assert.equal(body.actions[action].code, "PROCESSING_FAILED", action);
        }
        assert.deepEqual(body.auditLog, []);
        const fileResponse = await call("GET", `/review/failed-${T_PAGES}/file`);
        assert.equal(fileResponse.status, 200);
        assert.equal(fileResponse.headers.get("content-type"), "application/pdf");
        assert.match(fileResponse.headers.get("content-security-policy"), /sandbox/);
    });

    test("no action changes a failed submission (no retry, nothing invented); no audit entries", async () => {
        const before = JSON.stringify(fixture.db.tables.temporaryData);
        for (const [path, body] of [
            ["approve", {}], ["keep-pending", { reason: "x" }], ["remove", { reason: "x" }],
            ["document-type", { documentType: "MEDICAL", reason: "x" }], ["assign-client", { passportId: "N1234567", reason: "x" }],
        ]) {
            const response = await call("POST", `/review/failed-${T_PAGES}/${path}`, { body });
            assert.equal(response.status, 404, path);
        }
        assert.equal(JSON.stringify(fixture.db.tables.temporaryData), before);
        assert.equal(fixture.db.tables.auditLog.length, 0);
        assert.equal(fixture.db.tables.document.length, 0, "never a document");
    });

    test("Test 10: failed submissions need an ACTIVE admin", async () => {
        for (const path of ["/review?kind=FAILED", `/review/failed-${T_PAGES}`, `/review/failed-${T_PAGES}/file`, "/overview"]) {
            assert.equal((await call("GET", path, { auth: null })).status, 401, path);
            assert.equal((await call("GET", path, { auth: token("admin-inactive") })).status, 403, path);
        }
        assert.equal((await call("GET", "/review/failed-not-an-id")).status, 400);
        assert.equal((await call("GET", "/review/failed-99999999-9999-4999-8999-999999999999")).status, 404);
        assert.equal((await call("GET", `/review/failed-${T_WAITING}`)).status, 404, "a row with a pending copy is not a failed item");
    });
});
