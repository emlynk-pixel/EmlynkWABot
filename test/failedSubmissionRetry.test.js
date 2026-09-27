import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import jwt from "jsonwebtoken";

import { errorHandler } from "../src/middleware/errorHandler.js";
import { createFakeReviewDb } from "./helpers/fakeReviewDb.js";
import { loadDocumentText } from "./helpers/fixtures.js";

// Placeholders so the modules load without real credentials.
Object.assign(process.env, {
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-placeholder",
    DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
    META_APP_SECRET: "test-app-secret-placeholder",
    JWT_SECRET: "test-jwt-secret-placeholder-0123456789",
});
const { createTemporaryDocumentRecord } = await import("../src/services/temporaryDataService.js");
const { OcrResourceError } = await import("../src/services/ocrService.js");
const { claimNextSubmission, drainSubmissionQueue, processClaimedSubmission, QUEUE_DEFAULTS } = await import("../src/services/submissionQueue.js");
const { retryFailedSubmission, REVIEW_ACTION } = await import("../src/services/adminReviewActionService.js");
const { createAdminRouter } = await import("../src/routes/admin.js");
const { createRequireActiveAdmin } = await import("../src/middleware/requireActiveAdmin.js");

// H3 — failed submissions: FAILED state, admin retry, safety. Synthetic data
// only. text-passport.pdf belongs to N1234567 (unique ID 0001, WhatsApp 0771234567).
const PASSPORT_PDF = readFileSync(new URL("./fixtures/files/text-passport.pdf", import.meta.url));
const SENDER = "94771234567";
const LEASE = QUEUE_DEFAULTS.leaseMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise(() => {});
const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const afterLease = () => () => new Date(Date.now() + LEASE + 1_000);
const ocrTimeout = async () => { throw new OcrResourceError("OCR_TIMEOUT"); };
const gate = () => { let open; const promise = new Promise((r) => { open = r; }); return { promise, open }; };

const ADMIN = { adminId: "admin-a", name: "Admin A", email: "a@example.invalid", passwordHash: "x", role: "ADMIN", status: "ACTIVE" };
const DISABLED = { adminId: "admin-off", name: "Old", email: "o@example.invalid", passwordHash: "x", role: "ADMIN", status: "DISABLED" };
const USER = { passportId: "N1234567", uniqueId: "0001", whatsappNumber: "0771234567", firstName: "KAMAL NIMAL", otherName: "PERERA", dateOfBirth: null, placeOfBirth: null, passportExpiryDate: null };

// In-memory bucket keeping the bytes. hooks.<method>(...args) runs first (to delay or hang a call).
function memoryBucket() {
    const objects = new Map();
    const hooks = {};
    const before = async (name, args) => { if (hooks[name]) await hooks[name](...args); };
    return {
        objects, hooks,
        keys: (prefix) => [...objects.keys()].filter((p) => p.startsWith(prefix)),
        async exists(p) { await before("exists", [p]); return objects.has(p) ? { data: true, error: null } : { data: false, error: { statusCode: "404", message: "Object not found" } }; },
        async upload(p, body) { objects.set(p, Buffer.from(body)); return { data: { path: p }, error: null }; },
        async copy(from, to) {
            if (objects.has(to)) return { data: null, error: { statusCode: "409", message: "The resource already exists" } };
            if (!objects.has(from)) return { data: null, error: { statusCode: "404", message: "Object not found" } };
            objects.set(to, objects.get(from));
            await before("copy", [from, to]); // after the copy: the object exists even if the answer never comes
            return { data: { path: to }, error: null };
        },
        async remove(paths) { paths.forEach((p) => objects.delete(p)); return { data: paths, error: null }; },
        async download(p) { return objects.has(p) ? { data: objects.get(p), error: null } : { data: null, error: { message: "not found" } }; },
    };
}

function world() {
    const db = createFakeReviewDb({ admins: [ADMIN, DISABLED], users: [USER] });
    const bucket = memoryBucket();
    return { db, bucket };
}

// What the webhook commits (M1): the file in temporary/ and its row.
async function receive(w, label = "m1", buffer = PASSPORT_PDF) {
    const temporaryStoragePath = `temporary/${label}.pdf`;
    await w.bucket.upload(temporaryStoragePath, buffer);
    return createTemporaryDocumentRecord({ whatsappNumber: SENDER, temporaryStoragePath, fileSha256: sha(buffer), messageId: `wamid.${label}`, originalFilename: "passport.pdf", receivedAt: new Date("2026-09-27T08:00:00Z") }, { db: w.db.client });
}
const rowOf = (w, id) => w.db.tables.temporaryData.find((r) => r.temporaryId === id);

// A received submission that failed in the worker (OCR timeout).
async function failedSubmission(w, label = "m1") {
    const job = await receive(w, label);
    await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, extractText: ocrTimeout });
    assert.equal(rowOf(w, job.temporaryId).processingStatus, "FAILED");
    return job;
}

const tokenFor = (adminId) => jwt.sign({ adminId }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });

async function api(w, method, path, { body, token = tokenFor(ADMIN.adminId) } = {}) {
    const app = express();
    app.use(express.json());
    app.use("/api/admin", createAdminRouter({ db: w.db.client, bucket: w.bucket, requireAdmin: createRequireActiveAdmin({ db: w.db.client }) }));
    app.use(errorHandler);
    const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    try {
        const headers = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, body: await response.json().catch(() => null) };
    } finally {
        server.close();
    }
}
const retry = (w, id, options = {}) => api(w, "POST", `/review/failed-${id}/retry`, { body: {}, ...options });

let logs;
const originals = {};
beforeEach(() => {
    logs = [];
    for (const level of ["log", "warn", "error"]) { originals[level] = console[level]; console[level] = (...a) => logs.push(a); }
});
afterEach(() => { for (const level of ["log", "warn", "error"]) console[level] = originals[level]; });

describe("H3: a processing failure is recorded, kept and visible", () => {
    test("an exception in processing -> FAILED; the submission stays traceable and its original is kept", async () => {
        const w = world();
        const job = await failedSubmission(w);
        const row = rowOf(w, job.temporaryId);
        assert.deepEqual(
            [row.processingStatus, row.reviewReason, row.messageId, row.processingAttempts, row.fileSha256, row.processingSummary.stage],
            ["FAILED", "PROCESSING_FAILED", "wamid.m1", 1, sha(PASSPORT_PDF), "TEXT_EXTRACTION"],
        );
        assert.ok(w.bucket.objects.has(row.temporaryStoragePath), "the original stays in temporary/");
        assert.equal(w.db.tables.document.length, 0);
    });

    test("admin visibility: listed under Failed processing; the detail offers Retry and nothing else", async () => {
        const w = world();
        const job = await failedSubmission(w);
        const list = await api(w, "GET", "/review?kind=FAILED");
        assert.deepEqual(list.body.items.map((i) => [i.reviewId, i.kind, i.failure.code]), [[`failed-${job.temporaryId}`, "FAILED", "OCR_TIMEOUT"]]);
        const detail = await api(w, "GET", `/review/failed-${job.temporaryId}`);
        assert.equal(detail.body.actions.retry.available, true);
        for (const other of ["approve", "keepPending", "remove", "setDocumentType", "assignClient"]) assert.equal(detail.body.actions[other].available, false, other);
        assert.ok(!JSON.stringify(detail.body).includes("OCR resource limit"), "the error text itself is never returned");
    });

    test("a storage failure is not taken for a stored file: FAILED, no document, no client-folder file", async () => {
        const w = world();
        const job = await receive(w);
        w.bucket.copy = async () => ({ data: null, error: { statusCode: "500", message: "storage unavailable" } });
        await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket });
        const row = rowOf(w, job.temporaryId);
        assert.deepEqual([row.processingStatus, row.processingSummary.stage], ["FAILED", "STORAGE"]);
        assert.equal(w.db.tables.document.length, 0);
        assert.equal(w.bucket.keys("clients/").length, 0);
    });
});

describe("H3: Retry processing (admin)", () => {
    test("retry: FAILED -> waiting for the worker again, audited with the failure it replaces", async () => {
        const w = world();
        const job = await failedSubmission(w);
        const response = await retry(w, job.temporaryId, { body: { reason: "OCR was overloaded" } });
        assert.equal(response.status, 200);
        assert.deepEqual([response.body.action, response.body.processingStatus], ["RETRY_PROCESSING", "TEMPORARY_STORED"]);

        const row = rowOf(w, job.temporaryId);
        assert.deepEqual(
            [row.processingStatus, row.processingAttempts, row.processingStartedAt, row.reviewReason, row.documentType, row.passportId, row.messageId],
            ["TEMPORARY_STORED", 0, null, null, "UNCLASSIFIED", null, "wamid.m1"],
        );
        const [entry] = w.db.tables.auditLog;
        assert.deepEqual(
            [entry.action, entry.adminId, entry.temporaryId, entry.previousStatus, entry.newStatus, entry.previousValue, entry.reason, entry.fileSha256],
            [REVIEW_ACTION.RETRY_PROCESSING, ADMIN.adminId, job.temporaryId, "FAILED", "TEMPORARY_STORED", "OCR_TIMEOUT", "OCR was overloaded", sha(PASSPORT_PDF)],
        );
        assert.ok(entry.createdDate instanceof Date);
        assert.equal((await api(w, "GET", "/review?kind=FAILED")).body.items.length, 0, "no longer listed as failed");
        assert.equal((await api(w, "GET", `/review/failed-${job.temporaryId}`)).status, 404);
    });

    test("retry success: the worker processes it like a new submission -> VERIFIED, one document; the history is kept", async () => {
        const w = world();
        const job = await failedSubmission(w);
        assert.equal((await retry(w, job.temporaryId)).status, 200);
        const [out] = await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket });
        assert.deepEqual([out.attempt, out.summary.processingStatus], [1, "VERIFIED"]);
        const row = rowOf(w, job.temporaryId);
        assert.deepEqual([row.processingStatus, row.documentType, row.passportId], ["VERIFIED", "PASSPORT", "N1234567"]);
        assert.equal(w.db.tables.document.length, 1);
        assert.equal(w.db.tables.document[0].temporaryId, job.temporaryId);
        // The document's review history shows the retry.
        const actions = w.db.tables.auditLog.filter((a) => a.temporaryId === job.temporaryId).map((a) => a.action);
        assert.deepEqual(actions, ["RETRY_PROCESSING"]);
    });

    test("retry failure: failing again -> FAILED again, listed again with the retry in its history, and can be retried again", async () => {
        const w = world();
        const job = await failedSubmission(w);
        assert.equal((await retry(w, job.temporaryId)).status, 200);
        await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, extractText: ocrTimeout });
        assert.equal(rowOf(w, job.temporaryId).processingStatus, "FAILED");
        const detail = await api(w, "GET", `/review/failed-${job.temporaryId}`);
        assert.equal(detail.status, 200);
        assert.deepEqual(detail.body.auditLog.map((e) => [e.action, e.previousValue]), [["RETRY_PROCESSING", "OCR_TIMEOUT"]]);
        assert.equal((await retry(w, job.temporaryId)).status, 200);
        assert.equal(w.db.tables.auditLog.length, 2);
    });

    test("duplicate protection: failure after the document was stored -> retry uses it (ALREADY_STORED): one document, one file", async () => {
        const w = world();
        const job = await receive(w);
        // The success update fails once after the document and its file were stored.
        const updateMany = w.db.client.temporaryData.updateMany;
        let failNext = true;
        w.db.client.temporaryData.updateMany = async (args) => {
            if (failNext && args.data.processingStatus === "VERIFIED") { failNext = false; throw new Error("connection lost"); }
            return updateMany(args);
        };
        await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket });
        w.db.client.temporaryData.updateMany = updateMany;
        assert.equal(rowOf(w, job.temporaryId).processingStatus, "FAILED");
        assert.equal(w.db.tables.document.length, 1);

        assert.equal((await retry(w, job.temporaryId)).status, 200);
        const [out] = await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket });
        assert.equal(out.summary.storage.checksum, "ALREADY_STORED");
        assert.equal(rowOf(w, job.temporaryId).processingStatus, "VERIFIED");
        assert.equal(w.db.tables.document.length, 1);
        assert.deepEqual(w.bucket.keys("clients/"), ["clients/N1234567/passport/passport.pdf"]);
    });

    test("duplicate protection: a copy that timed out but landed -> the retry reuses it (no passport_v2.pdf)", async () => {
        const w = world();
        const job = await receive(w);
        let hang = true;
        w.bucket.hooks.copy = async () => { if (hang) await never(); };
        await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, storageTimeoutMs: 100 });
        hang = false;
        const failed = rowOf(w, job.temporaryId);
        assert.deepEqual([failed.processingStatus, failed.processingSummary.stage], ["FAILED", "STORAGE"]);
        assert.deepEqual(w.bucket.keys("clients/"), ["clients/N1234567/passport/passport.pdf"], "the copy landed after the time limit");
        assert.equal(failed.placementPath, "clients/N1234567/passport/passport.pdf", "recorded before the copy (M1)");

        assert.equal((await retry(w, job.temporaryId)).status, 200);
        assert.equal(rowOf(w, job.temporaryId).placementPath, failed.placementPath, "kept by the retry");
        const [out] = await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket });
        assert.equal(out.summary.processingStatus, "VERIFIED");
        assert.deepEqual(w.bucket.keys("clients/"), ["clients/N1234567/passport/passport.pdf"]);
        assert.equal(w.db.tables.document[0].storedFilename, "passport.pdf");
    });

    test("lease safety: an old attempt that outlived its lease can't overwrite the retried result", async () => {
        const w = world();
        const job = await receive(w);
        const rowA = await claimNextSubmission({ db: w.db.client });
        const slow = gate();
        const attemptA = processClaimedSubmission(rowA, { db: w.db.client, bucket: w.bucket, extractText: async () => { await slow.promise; return ocrTimeout(); } });
        // B takes over after the lease and fails; the admin retries; C succeeds.
        await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, extractText: ocrTimeout, now: afterLease() });
        assert.equal(rowOf(w, job.temporaryId).processingStatus, "FAILED");
        assert.equal((await retry(w, job.temporaryId)).status, 200);
        await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket });
        const afterC = structuredClone(rowOf(w, job.temporaryId));
        assert.equal(afterC.processingStatus, "VERIFIED");

        slow.open(); // A fails late: its FAILED must not replace C's VERIFIED
        assert.equal((await attemptA).outcome, "STALE_DISCARDED");
        assert.deepEqual(rowOf(w, job.temporaryId), afterC);
    });

    test("a submission that is being processed (or already retried) can't be retried: 409, nothing changed", async () => {
        const w = world();
        const job = await receive(w);
        await claimNextSubmission({ db: w.db.client }); // a worker holds it
        const before = structuredClone(rowOf(w, job.temporaryId));
        const response = await retry(w, job.temporaryId);
        assert.deepEqual([response.status, response.body.code], [409, "NOT_FAILED"]);
        assert.deepEqual(rowOf(w, job.temporaryId), before);
        assert.equal(w.db.tables.auditLog.length, 0);
    });

    test("concurrent retry: two requests at once -> one 200, one 409; queued once, one audit entry", async () => {
        const w = world();
        const job = await failedSubmission(w);
        const results = await Promise.all([retry(w, job.temporaryId), retry(w, job.temporaryId)]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        assert.equal(results.find((r) => r.status === 409).body.code, "NOT_FAILED");
        assert.equal(w.db.tables.auditLog.length, 1);
        const outcomes = await Promise.all([1, 2].map(() => drainSubmissionQueue({ db: w.db.client, bucket: w.bucket })));
        assert.equal(outcomes.flat().length, 1, "processed once");
        assert.equal(w.db.tables.document.length, 1);
    });

    test("the original is no longer in storage -> 409 FILE_MISSING; storage unreachable -> 503; nothing changed either way", async () => {
        const w = world();
        const job = await failedSubmission(w);
        const before = structuredClone(rowOf(w, job.temporaryId));
        w.bucket.objects.delete(before.temporaryStoragePath);
        let response = await retry(w, job.temporaryId);
        assert.deepEqual([response.status, response.body.code], [409, "FILE_MISSING"]);

        w.bucket.exists = async () => ({ data: null, error: { statusCode: "500", message: "Internal error at 10.0.0.12" } });
        response = await retry(w, job.temporaryId);
        assert.deepEqual([response.status, response.body.code], [503, "STORAGE_UNAVAILABLE"]);
        assert.ok(!JSON.stringify(response.body).includes("10.0.0.12"), "no infrastructure details");

        assert.deepEqual(rowOf(w, job.temporaryId), before);
        assert.equal(w.db.tables.auditLog.length, 0);
    });

    test("only failed-<id> can be retried; bad IDs and bodies are refused", async () => {
        const w = world();
        const job = await failedSubmission(w);
        assert.equal((await api(w, "POST", `/review/pending-${job.temporaryId}/retry`, { body: {} })).status, 404);
        assert.equal((await api(w, "POST", `/review/document-${job.temporaryId}/retry`, { body: {} })).status, 404);
        assert.equal((await api(w, "POST", `/review/failed-${crypto.randomUUID()}/retry`, { body: {} })).status, 404);
        assert.equal((await api(w, "POST", "/review/nonsense/retry", { body: {} })).status, 400);
        assert.equal((await retry(w, job.temporaryId, { body: { reason: "x".repeat(501) } })).status, 400);
        assert.equal(rowOf(w, job.temporaryId).processingStatus, "FAILED");
    });

    test("authorization: no token, a bad token or a deactivated admin can't retry (401), nothing changed", async () => {
        const w = world();
        const job = await failedSubmission(w);
        for (const token of [null, "not-a-jwt", jwt.sign({ adminId: ADMIN.adminId }, "wrong-secret"), tokenFor(DISABLED.adminId), tokenFor("no-such-admin")]) {
            const response = await retry(w, job.temporaryId, { token });
            assert.equal(response.status, 401, String(token));
        }
        assert.equal(rowOf(w, job.temporaryId).processingStatus, "FAILED");
        assert.equal(w.db.tables.auditLog.length, 0);
    });

    test("the worker is woken after the commit (not before); a failing wake-up doesn't undo the retry", async () => {
        const w = world();
        const job = await failedSubmission(w);
        let statusAtWake = null;
        const admin = { adminId: ADMIN.adminId, name: ADMIN.name };
        await retryFailedSubmission({ db: w.db.client, bucket: w.bucket, admin, reviewId: `failed-${job.temporaryId}`, reason: null, onQueued: () => { statusAtWake = rowOf(w, job.temporaryId).processingStatus; } });
        assert.equal(statusAtWake, "TEMPORARY_STORED");

        const job2 = await failedSubmission(w, "m2");
        const result = await retryFailedSubmission({ db: w.db.client, bucket: w.bucket, admin, reviewId: `failed-${job2.temporaryId}`, reason: null, onQueued: () => { throw new Error("emitter broken"); } });
        assert.equal(result.processingStatus, "TEMPORARY_STORED");
        assert.equal(rowOf(w, job2.temporaryId).processingStatus, "TEMPORARY_STORED");
    });

    test("audit entries of a retry are append-only like every other entry", async () => {
        const w = world();
        const job = await failedSubmission(w);
        await retry(w, job.temporaryId);
        await assert.rejects(w.db.client.auditLog.update({ where: { auditId: w.db.tables.auditLog[0].auditId }, data: { reason: "changed" } }));
        await assert.rejects(w.db.client.auditLog.delete({ where: { auditId: w.db.tables.auditLog[0].auditId } }));
        await sleep(0);
    });
});
