import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import jwt from "jsonwebtoken";

import { createMessageIdCache } from "../src/utils/messageIdempotency.js";
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
const { createWhatsappRouter } = await import("../src/routes/whatsapp.js");
const { createTemporaryDocumentRecord } = await import("../src/services/temporaryDataService.js");
const { saveTemporaryFile } = await import("../src/services/temporaryStorageService.js");
const { removeObject } = await import("../src/services/permanentStorageService.js");
const { processDocument } = await import("../src/services/documentProcessingService.js");
const { OcrResourceError } = await import("../src/services/ocrService.js");
const { claimNextSubmission, drainSubmissionQueue, processClaimedSubmission, startSubmissionWorker, QUEUE_DEFAULTS } = await import("../src/services/submissionQueue.js");
const { createAdminRouter } = await import("../src/routes/admin.js");
const { createRequireActiveAdmin } = await import("../src/middleware/requireActiveAdmin.js");

// M1 — asynchronous WhatsApp processing. Synthetic data only.
// text-passport.pdf belongs to N1234567 (unique ID 0001, WhatsApp 0771234567).
const PASSPORT_PDF = readFileSync(new URL("./fixtures/files/text-passport.pdf", import.meta.url));
const OTHER_PDF = (label) => Buffer.from(`%PDF-1.4\n% synthetic ${label}\n%%EOF\n`);
const SENDER_A = "94771234567";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sign = (raw) => "sha256=" + crypto.createHmac("sha256", process.env.META_APP_SECRET).update(raw).digest("hex");

// In-memory bucket that keeps the bytes (upload, copy, remove, download).
function memoryBucket({ failCopy = false } = {}) {
    const objects = new Map();
    const state = { failCopy, failDownload: false };
    return {
        objects, state,
        has: (p) => objects.has(p),
        async exists(p) { return objects.has(p) ? { data: true, error: null } : { data: false, error: { statusCode: "404", message: "not found" } }; },
        async upload(p, body) { objects.set(p, Buffer.from(body)); return { data: { path: p }, error: null }; },
        async copy(from, to) {
            if (state.failCopy) return { data: null, error: { statusCode: "500", message: "storage unavailable" } };
            if (!objects.has(from)) return { data: null, error: { statusCode: "404", message: "not found" } };
            if (objects.has(to)) return { data: null, error: { statusCode: "409", message: "The resource already exists" } };
            objects.set(to, objects.get(from)); return { data: { path: to }, error: null };
        },
        async remove(paths) { paths.forEach((p) => objects.delete(p)); return { data: paths, error: null }; },
        async download(p) { return !state.failDownload && objects.has(p) ? { data: objects.get(p), error: null } : { data: null, error: { message: "not found" } }; },
    };
}

// A world: fake DB + bucket, the real webhook router and the real worker.
function world({ media = {}, users = [{ passportId: "N1234567", uniqueId: "0001", whatsappNumber: "0771234567", firstName: "KAMAL NIMAL", otherName: "PERERA", dateOfBirth: null, placeOfBirth: null, passportExpiryDate: null }], documents = [], failRecord = false } = {}) {
    const db = createFakeReviewDb({ admins: [{ adminId: "admin-a", name: "A", email: "a@example.invalid", passwordHash: "x", role: "ADMIN", status: "ACTIVE" }], users, documents });
    const bucket = memoryBucket();
    const handoffs = [];
    const deps = {
        messageCache: createMessageIdCache(),
        getMediaUrl: async (id) => `https://lookaside.fbsbx.com/x?mid=${id}`,
        downloadMedia: async (url) => media[new URL(url).searchParams.get("mid")],
        saveTemporary: ({ fileBuffer, mimeType }) => saveTemporaryFile({ fileBuffer, mimeType, bucket }),
        createTemporaryRecord: (args) => {
            if (failRecord) throw new Error("database unavailable");
            return createTemporaryDocumentRecord(args, { db: db.client });
        },
        removeTemporary: (p) => removeObject(p, { bucket }),
        onRecorded: (row) => handoffs.push(row.temporaryId),
    };
    return { db, bucket, deps, handoffs };
}

async function withServer(deps, run, { admin } = {}) {
    const app = express();
    app.use(express.json({ verify: (req, res, b) => { req.rawBody = b; } }));
    app.use("/whatsapp", createWhatsappRouter(deps));
    if (admin) app.use("/api/admin", admin);
    app.use(errorHandler);
    const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        await run({
            base,
            post: async (body, { signature, raw } = {}) => {
                const text = raw ?? JSON.stringify(body);
                const t0 = performance.now();
                const response = await fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature ?? sign(text) }, body: text });
                return { status: response.status, ms: performance.now() - t0 };
            },
        });
    } finally {
        server.close();
    }
}

const doc = (id, mediaId, fileName = "scan.pdf", from = SENDER_A) => ({ from, id, timestamp: "1790000000", type: "document", document: { id: mediaId, mime_type: "application/pdf", filename: fileName } });
const delivery = (...messages) => ({ entry: [{ changes: [{ value: { messages } }] }] });
// The OCR boundary: text for a document type, as the reader would return it.
const textOf = (name, confidence = 97) => async () => ({ success: true, method: "OCR", text: loadDocumentText(name), confidence });

let logs;
const originals = {};
beforeEach(() => {
    logs = [];
    for (const level of ["log", "warn", "error"]) { originals[level] = console[level]; console[level] = (...a) => logs.push(a); }
});
afterEach(() => { for (const level of ["log", "warn", "error"]) console[level] = originals[level]; });

describe("M1 webhook: durable hand-off, no waiting for processing", () => {
    test("Test 1: the webhook answers after the row is committed, not after processing (5 s processing)", async () => {
        const w = world({ media: { m1: PASSPORT_PDF } });
        let processingDone = false;
        await withServer(w.deps, async ({ post }) => {
            const { status, ms } = await post(delivery(doc("wamid.A1", "m1", "Copy of passport.pdf")));
            assert.equal(status, 200);
            const [row] = w.db.tables.temporaryData;
            assert.equal(row.processingStatus, "TEMPORARY_STORED", "committed, not processed yet");
            assert.deepEqual([row.messageId, row.originalFilename, row.whatsappNumber], ["wamid.A1", "Copy of passport.pdf", SENDER_A]);
            assert.ok(w.bucket.has(row.temporaryStoragePath), "the file is safe before the answer");
            assert.deepEqual(w.handoffs, [row.temporaryId]);
            // The slow processing only starts now, in the worker.
            const slow = (args) => sleep(5_000).then(() => processDocument(args)).finally(() => { processingDone = true; });
            const t0 = performance.now();
            await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, processDocument: slow });
            const workerMs = performance.now() - t0;
            assert.ok(ms < 1_000 && ms * 5 < workerMs, `webhook ${Math.round(ms)} ms vs worker ${Math.round(workerMs)} ms`);
            console.info?.(`M1 timing: webhook ${ms.toFixed(1)} ms, worker ${workerMs.toFixed(0)} ms`);
        });
        assert.equal(processingDone, true);
        assert.equal(w.db.tables.temporaryData[0].processingStatus, "VERIFIED");
    });

    test("Test 3: the same message delivered twice (also after a restart) -> one submission, the second upload removed", async () => {
        const w = world({ media: { m1: PASSPORT_PDF } });
        await withServer(w.deps, async ({ post }) => {
            assert.equal((await post(delivery(doc("wamid.D1", "m1")))).status, 200);
            w.deps.messageCache = createMessageIdCache(); // in-memory claims lost, as after a restart
        });
        await withServer(w.deps, async ({ post }) => {
            assert.equal((await post(delivery(doc("wamid.D1", "m1")))).status, 200);
        });
        assert.equal(w.db.tables.temporaryData.length, 1);
        assert.equal([...w.bucket.objects.keys()].filter((p) => p.startsWith("temporary/")).length, 1, "no orphaned second upload");
        assert.equal(w.handoffs.length, 1);
    });

    test("Test 15: database down at the hand-off -> 500, nothing acknowledged, the upload removed, no job", async () => {
        const w = world({ media: { m1: PASSPORT_PDF }, failRecord: true });
        await withServer(w.deps, async ({ post }) => {
            const { status } = await post(delivery(doc("wamid.DB1", "m1")));
            assert.equal(status, 500, "Meta retries: work that was not persisted is never acknowledged");
        });
        assert.equal(w.db.tables.temporaryData.length, 0);
        assert.equal(w.bucket.objects.size, 0);
        assert.deepEqual(w.handoffs, []);
    });

    test("Test 13/14: forged signature -> 401, malformed JSON -> 400, nothing recorded", async () => {
        const w = world({ media: { m1: PASSPORT_PDF } });
        await withServer(w.deps, async ({ post }) => {
            assert.equal((await post(delivery(doc("wamid.S1", "m1")), { signature: "sha256=" + "0".repeat(64) })).status, 401);
            assert.equal((await post(null, { raw: "{bad" })).status, 400);
        });
        assert.equal(w.db.tables.temporaryData.length, 0);
    });

    test("a text message and refused files still never create a job", async () => {
        const w = world({ media: { big: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(10 * 1024 * 1024 + 1)]) } });
        await withServer(w.deps, async ({ post }) => {
            assert.equal((await post(delivery({ from: SENDER_A, id: "wamid.T1", type: "text", text: { body: "Hi" } }))).status, 200);
            assert.equal((await post(delivery(doc("wamid.B1", "big")))).status, 200);
        });
        assert.equal(w.db.tables.temporaryData.length, 0);
    });
});

describe("M1 worker", () => {
    async function recorded(files) {
        const media = Object.fromEntries(files.map(([id, buffer]) => [id, buffer]));
        const w = world({ media });
        await withServer(w.deps, async ({ post }) => {
            for (const [id, , name, from] of files) assert.equal((await post(delivery(doc(`wamid.${id}`, id, name, from)))).status, 200);
        });
        return w;
    }

    test("Test 2: a job survives a worker restart and a crash mid-processing (lease runs out, attempt 2)", async () => {
        const w = await recorded([["m1", PASSPORT_PDF, "passport.pdf"]]);
        // Worker 1 claims it and "crashes" (never finishes).
        const claimed = await claimNextSubmission({ db: w.db.client });
        assert.equal(claimed.processingAttempts, 1);
        // Within the lease nobody else takes it.
        assert.equal(await claimNextSubmission({ db: w.db.client }), null);
        // After a restart, once the lease has run out, it is claimed again and processed.
        const later = () => new Date(Date.now() + QUEUE_DEFAULTS.leaseMs + 1_000);
        const outcomes = await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, now: later });
        assert.deepEqual(outcomes.map((o) => [o.attempt, o.outcome]), [[2, "PROCESSED"]]);
        assert.equal(w.db.tables.temporaryData[0].processingStatus, "VERIFIED");
        assert.equal(w.db.tables.document.length, 1);
    });

    test("Test 4: the same job run twice (crash after storing, before finishing) -> one document, one client-folder file", async () => {
        const w = await recorded([["m1", PASSPORT_PDF, "passport.pdf"]]);
        // Attempt 1 stores the document, then the database fails on both final updates (as if the process died).
        // The final updates are conditional on the worker's claim (updateMany with a status); lease renewals are not affected.
        const first = await claimNextSubmission({ db: w.db.client });
        const updateMany = w.db.client.temporaryData.updateMany;
        let failures = 2;
        w.db.client.temporaryData.updateMany = async (args) => { if (args.data.processingStatus && failures-- > 0) throw new Error("connection lost"); return updateMany(args); };
        await processClaimedSubmission(first, { db: w.db.client, bucket: w.bucket });
        w.db.client.temporaryData.updateMany = updateMany;
        assert.equal(w.db.tables.temporaryData[0].processingStatus, "TEMPORARY_STORED", "not finished");
        assert.equal(w.db.tables.document.length, 1, "attempt 1 stored the document");
        // Attempt 2 (after the lease) recognises its own document instead of storing it again or calling it a duplicate.
        const outcomes = await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, now: () => new Date(Date.now() + QUEUE_DEFAULTS.leaseMs + 1_000) });
        assert.equal(outcomes[0].summary.storage.checksum, "ALREADY_STORED");
        const [row] = w.db.tables.temporaryData;
        assert.equal(row.processingStatus, "VERIFIED");
        assert.equal(row.reviewReason, null, "not an M4 duplicate of itself");
        assert.equal(row.pendingStoragePath, null);
        assert.equal(w.db.tables.document.length, 1);
        assert.equal([...w.bucket.objects.keys()].filter((p) => p.startsWith("clients/")).length, 1);
    });

    test("two workers claiming at the same time get different jobs, never the same one", async () => {
        const w = await recorded([["m1", PASSPORT_PDF, "p1.pdf"], ["m2", OTHER_PDF("x"), "p2.pdf"]]);
        const [a, b, c] = await Promise.all([1, 2, 3].map(() => claimNextSubmission({ db: w.db.client })));
        const ids = [a, b, c].filter(Boolean).map((r) => r.temporaryId);
        assert.equal(ids.length, 2);
        assert.equal(new Set(ids).size, 2);
    });

    test("Test 8: two documents from the same client at once -> both processed once, no race", async () => {
        const medical = OTHER_PDF("medical");
        const w = await recorded([["m1", PASSPORT_PDF, "passport.pdf"], ["m2", medical, "medical.pdf"]]);
        const extract = async ({ fileBuffer }) => (fileBuffer.equals(PASSPORT_PDF) ? { success: true, method: "OCR", text: loadDocumentText("passport-mrz"), confidence: 97 } : textOf("medical-gamca")());
        await Promise.all([1, 2].map(() => drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, extractText: extract })));
        assert.deepEqual(w.db.tables.temporaryData.map((r) => r.processingStatus).sort(), ["VERIFIED", "VERIFIED"]);
        assert.deepEqual(w.db.tables.document.map((d) => d.documentType).sort(), ["MEDICAL", "PASSPORT"]);
        assert.deepEqual(w.db.tables.temporaryData.map((r) => r.processingAttempts), [1, 1]);
    });

    test("Test 5/7: OCR failure in the worker -> FAILED (H3), visible in the dashboard, nothing stored", async () => {
        const w = await recorded([["m1", PASSPORT_PDF, "passport.pdf"]]);
        await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, extractText: async () => { throw new OcrResourceError("OCR_TIMEOUT"); } });
        const [row] = w.db.tables.temporaryData;
        assert.equal(row.processingStatus, "FAILED");
        assert.equal(row.reviewReason, "PROCESSING_FAILED");
        assert.equal(w.db.tables.document.length, 0);
        const list = await adminGet(w, "/review?kind=FAILED");
        assert.deepEqual(list.items.map((i) => i.failure), [{ code: "OCR_TIMEOUT", stage: "TEXT_EXTRACTION" }]);
    });

    test("Test 6: storage failure in the worker -> FAILED with the client and type kept, no client-folder file", async () => {
        const w = await recorded([["m1", PASSPORT_PDF, "passport.pdf"]]);
        w.bucket.state.failCopy = true;
        await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket });
        const [row] = w.db.tables.temporaryData;
        assert.deepEqual([row.processingStatus, row.passportId, row.documentType], ["FAILED", "N1234567", "PASSPORT"]);
        assert.ok(![...w.bucket.objects.keys()].some((p) => p.startsWith("clients/")));
        const list = await adminGet(w, "/review?kind=FAILED");
        assert.equal(list.items[0].failure.code, "STORAGE_FAILED");
        assert.equal(list.items[0].client.passportId, "N1234567");
    });

    test("bounded retries: the stored file missing -> tried again later, then FAILED (FILE_UNAVAILABLE); a job that never finishes -> FAILED (ATTEMPTS_EXHAUSTED)", async () => {
        const w = await recorded([["m1", PASSPORT_PDF, "passport.pdf"]]);
        w.bucket.state.failDownload = true;
        let clock = Date.now();
        const now = () => new Date(clock);
        for (let attempt = 1; attempt <= QUEUE_DEFAULTS.maxAttempts; attempt++) {
            const outcomes = await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, now });
            assert.equal(outcomes[0].outcome, attempt < QUEUE_DEFAULTS.maxAttempts ? "RETRY_LATER" : "GAVE_UP", `attempt ${attempt}`);
            clock += QUEUE_DEFAULTS.retryDelayMs + 1_000;
        }
        assert.equal(w.db.tables.temporaryData[0].processingStatus, "FAILED");
        assert.equal((await adminGet(w, "/review?kind=FAILED")).items[0].failure.code, "FILE_UNAVAILABLE");

        const w2 = await recorded([["m1", PASSPORT_PDF, "passport.pdf"]]);
        let t = Date.now();
        for (let i = 0; i < QUEUE_DEFAULTS.maxAttempts; i++) { await claimNextSubmission({ db: w2.db.client, now: new Date(t) }); t += QUEUE_DEFAULTS.leaseMs + 1_000; } // three crashes
        const outcomes = await drainSubmissionQueue({ db: w2.db.client, bucket: w2.bucket, now: () => new Date(t) });
        assert.equal(outcomes[0].outcome, "GAVE_UP");
        assert.equal((await adminGet(w2, "/review?kind=FAILED")).items[0].failure.code, "ATTEMPTS_EXHAUSTED");
        assert.equal(w2.db.tables.document.length, 0);
    });

    test("the worker logs IDs and outcomes only (no names, numbers, file names or paths)", async () => {
        const w = await recorded([["m1", PASSPORT_PDF, "Kamal Perera passport.pdf"]]);
        const worker = startSubmissionWorker({ db: w.db.client, bucket: w.bucket, pollMs: 20, concurrency: 1 });
        for (let i = 0; i < 100 && w.db.tables.temporaryData[0].processingStatus === "TEMPORARY_STORED"; i++) await sleep(20);
        await worker.stop();
        assert.equal(w.db.tables.temporaryData[0].processingStatus, "VERIFIED");
        const logged = JSON.stringify(logs);
        assert.match(logged, /Submission processed in background/);
        for (const value of ["Kamal", "Perera", "passport.pdf", "770000", "1234567", "temporary/", "clients/"]) assert.ok(!logged.includes(value), `log contains ${value}`);
    });

    test("a new submission wakes the running worker at once (no wait for the poll)", async () => {
        const w = world({ media: { m1: PASSPORT_PDF } });
        const { notifySubmissionQueued } = await import("../src/services/submissionQueue.js");
        const worker = startSubmissionWorker({ db: w.db.client, bucket: w.bucket, pollMs: 60_000, concurrency: 1 });
        await sleep(50); // first (empty) pass done; now sleeping for 60 s
        w.deps.onRecorded = () => notifySubmissionQueued();
        await withServer(w.deps, async ({ post }) => { assert.equal((await post(delivery(doc("wamid.W1", "m1")))).status, 200); });
        for (let i = 0; i < 100 && w.db.tables.temporaryData[0]?.processingStatus !== "VERIFIED"; i++) await sleep(20);
        await worker.stop();
        assert.equal(w.db.tables.temporaryData[0].processingStatus, "VERIFIED", "processed well before the 60 s poll");
    });
});

describe("M1 regression through webhook + worker", () => {
    async function run(files, { documents = [], extract } = {}) {
        const w = world({ media: Object.fromEntries(files.map(([id, b]) => [id, b])), documents });
        await withServer(w.deps, async ({ post }) => {
            for (const [id, , name] of files) assert.equal((await post(delivery(doc(`wamid.${id}`, id, name)))).status, 200);
        });
        await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, ...(extract ? { extractText: extract } : {}) });
        return w;
    }

    test("Test 11: passport -> VERIFIED in the client folder, file name kept as received", async () => {
        const w = await run([["m1", PASSPORT_PDF, "Copy of N1234567-PASS COPY.pdf"]]);
        const [d] = w.db.tables.document;
        assert.deepEqual([d.documentType, d.verificationStatus, d.storagePath, d.originalFilename], ["PASSPORT", "VERIFIED", "clients/N1234567/passport/passport.pdf", "Copy of N1234567-PASS COPY.pdf"]);
    });

    test("Test 9: M4 — exact copy of a VERIFIED document -> DUPLICATE pending, original untouched", async () => {
        const sha = crypto.createHash("sha256").update(PASSPORT_PDF).digest("hex");
        const original = { documentId: "d-verified", passportId: "N1234567", documentType: "PASSPORT", fileSha256: sha, verificationStatus: "VERIFIED", storagePath: "clients/N1234567/passport/passport.pdf", storedFilename: "passport.pdf", receivedDate: new Date("2026-09-20T00:00:00Z"), temporaryId: null };
        const w = await run([["m1", PASSPORT_PDF, "passport again.pdf"]], { documents: [original] });
        const [row] = w.db.tables.temporaryData;
        assert.deepEqual([row.processingStatus, row.reviewReason, row.pendingStoragePath !== null], ["DUPLICATE", "DUPLICATE_OF_VERIFIED", true]);
        assert.deepEqual(w.db.tables.document, [original]);
    });

    test("Test 10: police slip starts the countdown (date kept), police report stored as a report", async () => {
        const slipPdf = OTHER_PDF("slip"), reportPdf = OTHER_PDF("report");
        const w = await run([["s", slipPdf, "scan_0012.pdf"], ["r", reportPdf, "doc.pdf"]], {
            extract: async ({ fileBuffer }) => (fileBuffer.equals(slipPdf) ? textOf("police-slip", 90)() : textOf("police-clearance")()),
        });
        const slip = w.db.tables.document.find((d) => d.documentType === "POLICE_SLIP");
        const report = w.db.tables.document.find((d) => d.documentType === "POLICE_REPORT");
        assert.equal(slip.policeSubmittedDate.toISOString().slice(0, 10), "2026-09-01");
        assert.equal(report.policeSubmittedDate, null, "a report never starts a countdown");
    });

    test("Test 12: medical -> MEDICAL in the client folder", async () => {
        const w = await run([["m", OTHER_PDF("medical"), "IMG-20260927-WA0003.pdf"]], { extract: textOf("medical-gamca") });
        assert.deepEqual(w.db.tables.document.map((d) => [d.documentType, d.verificationStatus]), [["MEDICAL", "VERIFIED"]]);
    });
});

// Admin API over the same fake DB (failed submissions visible, H3).
async function adminGet(w, path) {
    const router = createAdminRouter({ db: w.db.client, bucket: w.bucket, requireAdmin: createRequireActiveAdmin({ db: w.db.client }) });
    const token = jwt.sign({ adminId: "admin-a" }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
    let body;
    await withServer(w.deps, async ({ base }) => {
        body = await (await fetch(`${base}/api/admin${path}`, { headers: { Authorization: `Bearer ${token}` } })).json();
    }, { admin: router });
    return body;
}
