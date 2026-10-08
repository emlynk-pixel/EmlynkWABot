import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { readFileSync } from "node:fs";
import express from "express";
import { createClient } from "@supabase/supabase-js";

import { createMessageIdCache } from "../src/utils/messageIdempotency.js";
import { createFakeReviewDb } from "./helpers/fakeReviewDb.js";
import { loadDocumentText } from "./helpers/fixtures.js";
import "./helpers/localOcrService.js";

// Placeholders so the modules load without real credentials.
Object.assign(process.env, {
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-placeholder",
    DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
    META_APP_SECRET: "test-app-secret-placeholder",
    JWT_SECRET: "test-jwt-secret-placeholder-0123456789",
});
const { createWhatsappRouter, DUPLICATE_WAIT_MS } = await import("../src/routes/whatsapp.js");
const { createTemporaryDocumentRecord } = await import("../src/services/temporaryDataService.js");
const { saveTemporaryFile } = await import("../src/services/temporaryStorageService.js");
const { removeObject } = await import("../src/services/permanentStorageService.js");
const { placementCopyHooks } = await import("../src/services/placementRecovery.js");
const { claimNextSubmission, drainSubmissionQueue, processClaimedSubmission, startSubmissionWorker, createClaim, QUEUE_DEFAULTS } = await import("../src/services/submissionQueue.js");
const { STORAGE_TIMEOUT_MS, withStorageTimeout, createTimeoutFetch } = await import("../src/utils/storageTimeout.js");
const { createShutdown, SHUTDOWN_DEADLINE_MS, WORKER_STOP_MS } = await import("../src/shutdown.js");

// M1 critical fixes: webhook duplicate race, stale worker attempts, storage
// time limits, graceful shutdown, repeatable storage copies. Synthetic data
// only. text-passport.pdf belongs to N1234567 (unique ID 0001, WhatsApp 0771234567).
const PASSPORT_PDF = readFileSync(new URL("./fixtures/files/text-passport.pdf", import.meta.url));
const OTHER_PDF = (label) => Buffer.from(`%PDF-1.4\n% synthetic ${label}\n%%EOF\n`);
const SENDER = "94771234567";
const LEASE = QUEUE_DEFAULTS.leaseMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise(() => {});
const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const sign = (raw) => "sha256=" + crypto.createHmac("sha256", process.env.META_APP_SECRET).update(raw).digest("hex");
const afterLease = (extra = 1_000) => () => new Date(Date.now() + LEASE + extra);
const textOf = (name, confidence = 97) => async () => ({ success: true, method: "OCR", text: loadDocumentText(name), confidence });
const invoiceText = textOf("random-invoice", 90); // unknown document -> pending/
const gate = () => { let open; const promise = new Promise((r) => { open = r; }); return { promise, open }; };

// In-memory bucket. hooks.<method>(...args) runs before the call (to delay or hang it).
function memoryBucket() {
    const objects = new Map();
    const hooks = {};
    const before = async (name, args) => { if (hooks[name]) await hooks[name](...args); };
    return {
        objects, hooks,
        keys: (prefix) => [...objects.keys()].filter((p) => p.startsWith(prefix)),
        async exists(p) { await before("exists", [p]); return objects.has(p) ? { data: true, error: null } : { data: false, error: { statusCode: "404", message: "not found" } }; },
        async upload(p, body) { await before("upload", [p]); objects.set(p, Buffer.from(body)); return { data: { path: p }, error: null }; },
        async copy(from, to) {
            await before("copy", [from, to]);
            if (!objects.has(from)) return { data: null, error: { statusCode: "404", message: "not found" } };
            if (objects.has(to)) return { data: null, error: { statusCode: "409", message: "The resource already exists" } };
            objects.set(to, objects.get(from)); return { data: { path: to }, error: null };
        },
        async remove(paths) { await before("remove", [paths]); paths.forEach((p) => objects.delete(p)); return { data: paths, error: null }; },
        async download(p) { await before("download", [p]); return objects.has(p) ? { data: objects.get(p), error: null } : { data: null, error: { message: "not found" } }; },
    };
}

const USER = { passportId: "N1234567", uniqueId: "0001", whatsappNumber: "0771234567", firstName: "KAMAL NIMAL", otherName: "PERERA", dateOfBirth: null, placeOfBirth: null, passportExpiryDate: null };

function world({ media = {}, download } = {}) {
    const db = createFakeReviewDb({ users: [USER] });
    const bucket = memoryBucket();
    const counts = { downloads: 0, recorded: 0 };
    const deps = {
        messageCache: createMessageIdCache(),
        getMediaUrl: async (id) => `https://lookaside.fbsbx.com/x?mid=${id}`,
        downloadMedia: async (url) => {
            counts.downloads += 1;
            const id = new URL(url).searchParams.get("mid");
            return download ? download(counts.downloads, id) : media[id];
        },
        saveTemporary: ({ fileBuffer, mimeType }) => saveTemporaryFile({ fileBuffer, mimeType, bucket }),
        createTemporaryRecord: async (args) => {
            const row = await createTemporaryDocumentRecord(args, { db: db.client });
            if (!row.duplicate) { counts.recorded += 1; counts.recordedAt = performance.now(); }
            return row;
        },
        removeTemporary: (p) => removeObject(p, { bucket }),
        onRecorded: () => {},
    };
    return { db, bucket, deps, counts };
}

async function withServer(deps, run) {
    const app = express();
    app.use(express.json({ verify: (req, res, b) => { req.rawBody = b; } }));
    app.use("/whatsapp", createWhatsappRouter(deps));
    const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        await run({
            post: async (body) => {
                const text = JSON.stringify(body);
                const response = await fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(text) }, body: text });
                return { status: response.status, at: performance.now() };
            },
        });
    } finally {
        server.close();
    }
}

const doc = (id, mediaId, fileName = "scan.pdf") => ({ from: SENDER, id, timestamp: "1790000000", type: "document", document: { id: mediaId, mime_type: "application/pdf", filename: fileName } });
const delivery = (...messages) => ({ entry: [{ changes: [{ value: { messages } }] }] });

// A submission recorded directly (what the webhook commits), for worker tests.
async function recordJob(w, label, buffer, fileName = `${label}.pdf`) {
    const temporaryStoragePath = `temporary/${label}.pdf`;
    await w.bucket.upload(temporaryStoragePath, buffer);
    return createTemporaryDocumentRecord({ whatsappNumber: SENDER, temporaryStoragePath, fileSha256: sha(buffer), messageId: `wamid.${label}`, originalFilename: fileName, receivedAt: new Date("2026-09-27T08:00:00Z") }, { db: w.db.client });
}
const rowOf = (w, temporaryId) => w.db.tables.temporaryData.find((r) => r.temporaryId === temporaryId);
const until = async (condition, what) => { for (let i = 0; i < 200 && !condition(); i++) await sleep(5); assert.ok(condition(), what); };

let logs;
const originals = {};
beforeEach(() => {
    logs = [];
    for (const level of ["log", "warn", "error"]) { originals[level] = console[level]; console[level] = (...a) => logs.push(a); }
});
afterEach(() => { for (const level of ["log", "warn", "error"]) console[level] = originals[level]; });

describe("M1 fix 1: a duplicate delivery is never acknowledged before the message is recorded", () => {
    test("Test 1: the same message three times at once -> one submission; every 200 comes after it was recorded", async () => {
        const w = world({ download: async () => { await sleep(150); return PASSPORT_PDF; } });
        await withServer(w.deps, async ({ post }) => {
            const results = await Promise.all([1, 2, 3].map(() => post(delivery(doc("wamid.C1", "m1")))));
            assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
            for (const r of results) assert.ok(r.at >= w.counts.recordedAt, "acknowledged only once the submission existed");
        });
        assert.equal(w.db.tables.temporaryData.length, 1);
        assert.equal(w.counts.downloads, 1, "the duplicates waited instead of downloading again");
        assert.equal(w.bucket.keys("temporary/").length, 1);
    });

    test("Test 1b: two app instances (separate memory) get the same message at once -> one submission, the other upload removed", async () => {
        const w = world({ download: async () => { await sleep(100); return PASSPORT_PDF; } });
        const otherInstance = { ...w.deps, messageCache: createMessageIdCache() };
        let statuses;
        await withServer(w.deps, async (a) => {
            await withServer(otherInstance, async (b) => {
                statuses = (await Promise.all([a.post(delivery(doc("wamid.X1", "m1"))), b.post(delivery(doc("wamid.X1", "m1")))])).map((r) => r.status);
            });
        });
        assert.deepEqual(statuses, [200, 200], "each answered 200 only after its insert committed or hit the existing row");
        assert.equal(w.db.tables.temporaryData.length, 1);
        assert.equal(w.bucket.keys("temporary/").length, 1);
    });

    test("Test 2: the first delivery fails before anything is recorded while a duplicate waits -> the duplicate records it; exactly one submission", async () => {
        const w = world({ download: async (n) => { if (n === 1) { await sleep(150); throw new Error("download timed out"); } return PASSPORT_PDF; } });
        await withServer(w.deps, async ({ post }) => {
            const first = post(delivery(doc("wamid.F1", "m1")));
            await sleep(30);
            const second = await post(delivery(doc("wamid.F1", "m1")));
            assert.equal((await first).status, 500, "the failed delivery asks Meta to retry");
            assert.equal(second.status, 200);
            assert.ok(second.at >= w.counts.recordedAt);
            // Meta's retry of the failed delivery: already recorded now.
            assert.equal((await post(delivery(doc("wamid.F1", "m1")))).status, 200);
        });
        assert.equal(w.db.tables.temporaryData.length, 1);
        assert.equal(w.counts.downloads, 2);
        assert.equal(w.bucket.keys("temporary/").length, 1);
    });

    test("Test 2b: the first delivery fails at the record insert (after its upload) while a duplicate waits -> upload removed, the duplicate records it once", async () => {
        const w = world({ media: { m1: PASSPORT_PDF } });
        const insert = w.deps.createTemporaryRecord;
        let calls = 0;
        w.deps.createTemporaryRecord = async (args) => { calls += 1; if (calls === 1) { await sleep(100); throw new Error("database unavailable"); } return insert(args); };
        await withServer(w.deps, async ({ post }) => {
            const [a, b] = await Promise.all([post(delivery(doc("wamid.F2", "m1"))), sleep(20).then(() => post(delivery(doc("wamid.F2", "m1"))))]);
            assert.deepEqual([a.status, b.status], [500, 200]);
        });
        assert.equal(w.db.tables.temporaryData.length, 1);
        assert.equal(w.bucket.keys("temporary/").length, 1, "the failed attempt's upload was removed");
    });

    test("a duplicate while the first is still running past the wait -> 500, never 200 without a record; the later retry -> 200; one submission", async () => {
        const w = world({ download: async () => { await sleep(300); return PASSPORT_PDF; } });
        w.deps.duplicateWaitMs = 50;
        await withServer(w.deps, async ({ post }) => {
            const first = post(delivery(doc("wamid.S1", "m1")));
            await sleep(20);
            assert.equal((await post(delivery(doc("wamid.S1", "m1")))).status, 500);
            assert.equal(w.db.tables.temporaryData.length, 0, "nothing was recorded when the duplicate was answered");
            assert.equal((await first).status, 200);
            assert.equal((await post(delivery(doc("wamid.S1", "m1")))).status, 200);
        });
        assert.equal(w.db.tables.temporaryData.length, 1);
        assert.equal(w.counts.downloads, 1);
        assert.ok(logs.some((l) => /still being recorded; Meta will retry/.test(l[0])));
        assert.ok(!JSON.stringify(logs).includes("wamid.S1"), "raw message IDs are never logged");
    });

    test("the default wait is bounded and well below Meta's webhook timeout", () => {
        assert.ok(DUPLICATE_WAIT_MS > 0 && DUPLICATE_WAIT_MS <= 10_000);
    });
});

describe("M1 fix 2: a stale worker attempt can't write after losing its claim", () => {
    test("Test 3: attempt A outlives its lease, B takes over and finishes, then A finishes -> B's result stays, no second copy", async () => {
        const w = world();
        const job = await recordJob(w, "inv", OTHER_PDF("invoice"));
        const rowA = await claimNextSubmission({ db: w.db.client });
        const slowOcr = gate();
        const attemptA = processClaimedSubmission(rowA, { db: w.db.client, bucket: w.bucket, extractText: async (a) => { await slowOcr.promise; return invoiceText(a); } });

        const [b] = await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, extractText: invoiceText, now: afterLease() });
        assert.deepEqual([b.attempt, b.outcome], [2, "PROCESSED"]);
        const afterB = structuredClone(rowOf(w, job.temporaryId));

        slowOcr.open();
        assert.equal((await attemptA).outcome, "STALE_DISCARDED");
        assert.deepEqual(rowOf(w, job.temporaryId), afterB, "A wrote nothing");
        assert.equal(w.bucket.keys("pending/").length, 1, "no second pending copy");
        assert.equal(afterB.pendingStoragePath, w.bucket.keys("pending/")[0]);
    });

    test("Test 3b: A is inside a slow client-folder copy when B takes over -> one document, one file, no _v2", async () => {
        const w = world();
        const job = await recordJob(w, "pass", PASSPORT_PDF, "passport.pdf");
        const rowA = await claimNextSubmission({ db: w.db.client });
        const slowCopy = gate();
        let blocked = false;
        w.bucket.hooks.copy = async () => { if (!blocked) { blocked = true; await slowCopy.promise; } };
        const attemptA = processClaimedSubmission(rowA, { db: w.db.client, bucket: w.bucket });
        await until(() => blocked, "A reached its copy");

        const [b] = await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, now: afterLease() });
        assert.equal(b.summary.processingStatus, "VERIFIED");
        slowCopy.open(); // A's copy runs now: the name is taken, and A may not copy under another name
        assert.equal((await attemptA).outcome, "STALE_DISCARDED");
        assert.equal(w.db.tables.document.length, 1);
        assert.deepEqual(w.bucket.keys("clients/"), ["clients/N1234567/passport/passport.pdf"]);
        assert.equal(rowOf(w, job.temporaryId).processingStatus, "VERIFIED");
    });

    test("Test 3c: A's copy landed, then A stalls before its insert; B takes over -> B uses A's copy; A inserts and removes nothing", async () => {
        const w = world();
        await recordJob(w, "pass", PASSPORT_PDF, "passport.pdf");
        const rowA = await claimNextSubmission({ db: w.db.client });
        const transaction = w.db.client.$transaction;
        const stall = gate();
        let stalled = false;
        // A's insert transaction (claim check + insert) starts late: as if the process froze.
        w.db.client.$transaction = async (...args) => { if (!stalled) { stalled = true; await stall.promise; } return transaction(...args); };
        const attemptA = processClaimedSubmission(rowA, { db: w.db.client, bucket: w.bucket });
        await until(() => stalled, "A copied and is about to insert");

        const [b] = await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, now: afterLease() });
        assert.equal(b.summary.processingStatus, "VERIFIED");
        assert.deepEqual(w.bucket.keys("clients/"), ["clients/N1234567/passport/passport.pdf"], "B reused A's copy");
        stall.open();
        assert.equal((await attemptA).outcome, "STALE_DISCARDED");
        w.db.client.$transaction = transaction;
        assert.equal(w.db.tables.document.length, 1);
        assert.deepEqual(w.bucket.keys("clients/"), ["clients/N1234567/passport/passport.pdf"], "A did not remove B's file");
    });

    test("the claim check and the documents insert are one transaction (a stale insert can't commit)", async () => {
        const w = world();
        await recordJob(w, "tx", PASSPORT_PDF, "passport.pdf");
        await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket });
        const i = w.db.calls.findIndex((c) => c.method === "document.create") - 2;
        assert.deepEqual(w.db.calls.slice(i, i + 3).map((c) => c.method), ["$transaction", "temporaryData.updateMany", "document.create"]);
        assert.ok(w.db.calls[i].options.timeout < LEASE);
        // The client record (passport reconciliation) is written the same way.
        const r = w.db.calls.findIndex((c) => c.method === "candidate.updateMany") - 2;
        assert.deepEqual(w.db.calls.slice(r, r + 3).map((c) => c.method), ["$transaction", "temporaryData.updateMany", "user.updateMany"]);
    });

    test("Test 4: the job was given up (FAILED) while A was still running -> FAILED stays FAILED, never VERIFIED", async () => {
        const w = world();
        const job = await recordJob(w, "late", PASSPORT_PDF, "passport.pdf");
        const rowA = await claimNextSubmission({ db: w.db.client });
        const slowOcr = gate();
        const attemptA = processClaimedSubmission(rowA, { db: w.db.client, bucket: w.bucket, extractText: async () => { await slowOcr.promise; return textOf("passport-mrz")(); } });
        let t = Date.now();
        for (let i = 0; i < 3; i++) { t += LEASE + 1_000; await claimNextSubmission({ db: w.db.client, now: new Date(t) }); }
        const [gaveUp] = await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, now: () => new Date(t + LEASE + 1_000) });
        assert.equal(gaveUp.outcome, "GAVE_UP");

        slowOcr.open();
        assert.equal((await attemptA).outcome, "STALE_DISCARDED");
        const row = rowOf(w, job.temporaryId);
        assert.equal(row.processingStatus, "FAILED");
        assert.equal(row.processingSummary.stage, "WORKER");
        assert.equal(w.db.tables.document.length, 0);
        assert.equal(w.bucket.keys("clients/").length, 0);
    });

    test("Test 4b: B's processing failed (FAILED, H3) while A was running -> A can't turn it into VERIFIED", async () => {
        const w = world();
        const job = await recordJob(w, "late2", PASSPORT_PDF, "passport.pdf");
        const rowA = await claimNextSubmission({ db: w.db.client });
        const slowOcr = gate();
        const attemptA = processClaimedSubmission(rowA, { db: w.db.client, bucket: w.bucket, extractText: async () => { await slowOcr.promise; return textOf("passport-mrz")(); } });
        await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, now: afterLease(), extractText: async () => { throw new Error("OCR worker crashed"); } });
        assert.equal(rowOf(w, job.temporaryId).processingStatus, "FAILED");

        slowOcr.open();
        assert.equal((await attemptA).outcome, "STALE_DISCARDED");
        assert.equal(rowOf(w, job.temporaryId).processingStatus, "FAILED");
        assert.equal(w.db.tables.document.length, 0);
    });

    test("a stale attempt writes no client record either (passport reconciliation)", async () => {
        const w = world();
        await recordJob(w, "rec", PASSPORT_PDF, "passport.pdf");
        const rowA = await claimNextSubmission({ db: w.db.client });
        await claimNextSubmission({ db: w.db.client, now: afterLease()() }); // B took it over (and crashed)
        const updates = () => w.db.calls.filter((c) => c.method.startsWith("candidate.update")).length;
        const before = updates();
        assert.equal((await processClaimedSubmission(rowA, { db: w.db.client, bucket: w.bucket })).outcome, "STALE_DISCARDED");
        assert.equal(updates(), before);
        assert.equal(w.db.tables.document.length, 0);
        assert.equal(w.bucket.keys("clients/").length, 0);
    });

    test("the worker logs a discarded stale attempt (IDs only)", async () => {
        const w = world();
        const job = await recordJob(w, "log", PASSPORT_PDF, "Kamal Perera passport.pdf");
        const slowOcr = gate();
        const worker = startSubmissionWorker({ db: w.db.client, bucket: w.bucket, concurrency: 1, pollMs: 60_000, extractText: async () => { await slowOcr.promise; return textOf("passport-mrz")(); } });
        await until(() => rowOf(w, job.temporaryId).processingAttempts === 1, "claimed");
        await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, now: afterLease(), extractText: textOf("passport-mrz") });
        slowOcr.open();
        await worker.stop();
        assert.ok(logs.some((l) => /Stale background attempt discarded/.test(l[0]) && l[1].temporaryId === job.temporaryId));
        for (const value of ["Kamal", "Perera", "clients/", "temporary/"]) assert.ok(!JSON.stringify(logs).includes(value), value);
    });
});

describe("M1 fix 3: storage calls are bounded", () => {
    test("the storage limit is far below the worker lease; the shutdown deadline below Docker's 10 s", () => {
        assert.equal(QUEUE_DEFAULTS.storageTimeoutMs, STORAGE_TIMEOUT_MS);
        assert.ok(STORAGE_TIMEOUT_MS * 2 < LEASE);
        assert.ok(SHUTDOWN_DEADLINE_MS < 10_000 && WORKER_STOP_MS < SHUTDOWN_DEADLINE_MS);
    });

    test("Test 5: loading the received file hangs -> times out, tried again later (existing retry policy), then processed", async () => {
        const w = world();
        const job = await recordJob(w, "hang", PASSPORT_PDF, "passport.pdf");
        w.bucket.hooks.download = never;
        const t0 = performance.now();
        const [first] = await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, storageTimeoutMs: 100 });
        assert.equal(first.outcome, "RETRY_LATER");
        assert.ok(performance.now() - t0 < 2_000, "the worker did not hang");
        assert.equal(rowOf(w, job.temporaryId).processingStatus, "TEMPORARY_STORED");
        delete w.bucket.hooks.download;
        const [second] = await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, now: () => new Date(Date.now() + QUEUE_DEFAULTS.retryDelayMs + 1_000) });
        assert.equal(second.summary.processingStatus, "VERIFIED");
    });

    test("Test 5b: the client-folder copy hangs -> times out, FAILED (storage failure, H3), no document, the worker goes on", async () => {
        const w = world();
        const job = await recordJob(w, "copyhang", PASSPORT_PDF, "passport.pdf");
        w.bucket.hooks.copy = never;
        const t0 = performance.now();
        const [out] = await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, storageTimeoutMs: 100 });
        assert.ok(performance.now() - t0 < 2_000);
        assert.equal(out.summary.processingStatus, "FAILED");
        const row = rowOf(w, job.temporaryId);
        assert.deepEqual([row.processingStatus, row.processingSummary.stage, row.passportId, row.documentType], ["FAILED", "STORAGE", "N1234567", "PASSPORT"]);
        assert.match(row.processingSummary.error, /timed out/);
        assert.equal(w.db.tables.document.length, 0);
    });

    test("Test 5c: the name check hangs -> the name is not treated as free: no copy is made, FAILED", async () => {
        const w = world();
        await recordJob(w, "existshang", PASSPORT_PDF, "passport.pdf");
        w.bucket.hooks.exists = never;
        let copies = 0;
        w.bucket.hooks.copy = async () => { copies += 1; };
        const [out] = await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, storageTimeoutMs: 100 });
        assert.equal(out.summary.processingStatus, "FAILED");
        assert.equal(copies, 0);
    });

    test("withStorageTimeout passes results through and answers a hung call like a Supabase error", async () => {
        const bucket = { ok: async () => "kept", download: async () => ({ data: "x", error: null }), copy: never, label: "b" };
        const timed = withStorageTimeout(bucket, 50);
        assert.deepEqual(await timed.download("p"), { data: "x", error: null });
        assert.equal(await timed.ok(), "kept");
        assert.equal(timed.label, "b");
        const { data, error } = await timed.copy("a", "b");
        assert.equal(data, null);
        assert.equal(error.name, "StorageTimeoutError");
        assert.ok(!/404|400|409/.test(`${error.statusCode} ${error.message}`), "never mistaken for not-found or a name collision");
    });

    test("the Supabase client's fetch aborts a storage request that never answers", async () => {
        const hanging = http.createServer(() => {}); // accepts, never responds
        await new Promise((r) => hanging.listen(0, "127.0.0.1", r));
        try {
            const client = createClient(`http://127.0.0.1:${hanging.address().port}`, "placeholder-key", { auth: { persistSession: false }, global: { fetch: createTimeoutFetch(150) } });
            const t0 = performance.now();
            const { data, error } = await client.storage.from("bucket").download("temporary/x.pdf");
            assert.equal(data, null);
            assert.ok(error);
            assert.ok(performance.now() - t0 < 3_000, "aborted after the limit");
        } finally {
            hanging.closeAllConnections();
            hanging.close();
        }
    });
});

describe("M1 fix 4: graceful shutdown", () => {
    const fastOcr = (ms) => async (a) => { await sleep(ms); return textOf("medical-gamca")(a); };

    test("idle worker, nothing waiting -> stops at once", async () => {
        const w = world();
        const worker = startSubmissionWorker({ db: w.db.client, bucket: w.bucket, concurrency: 2, pollMs: 60_000, log: { log() {}, error() {} } });
        await sleep(20);
        const t0 = performance.now();
        assert.deepEqual(await worker.stop({ timeoutMs: 1_000 }), { finished: true, released: 0 });
        assert.ok(performance.now() - t0 < 200);
    });

    test("Test 6: several waiting jobs -> only the running one finishes; no new job is started", async () => {
        const w = world();
        for (let i = 0; i < 4; i++) await recordJob(w, `b${i}`, OTHER_PDF(`medical ${i}`));
        const worker = startSubmissionWorker({ db: w.db.client, bucket: w.bucket, concurrency: 1, pollMs: 60_000, extractText: fastOcr(200), log: { log() {}, error() {} } });
        await until(() => w.db.tables.temporaryData.some((r) => r.processingAttempts === 1), "first job running");
        const result = await worker.stop({ timeoutMs: 2_000 });
        assert.deepEqual(result, { finished: true, released: 0 });
        const rows = w.db.tables.temporaryData;
        assert.equal(rows.filter((r) => r.processingStatus === "VERIFIED").length, 1);
        assert.deepEqual(rows.filter((r) => r.processingStatus === "TEMPORARY_STORED").map((r) => r.processingAttempts), [0, 0, 0], "never claimed");
    });

    test("OCR still running at the deadline -> released (attempt not counted, resumed in about a minute); the late result is discarded", async () => {
        const w = world();
        const job = await recordJob(w, "ocr", OTHER_PDF("medical slow"));
        const slowOcr = gate();
        const worker = startSubmissionWorker({ db: w.db.client, bucket: w.bucket, concurrency: 1, pollMs: 60_000, extractText: async (a) => { await slowOcr.promise; return textOf("medical-gamca")(a); }, log: { log() {}, warn() {}, error() {} } });
        await until(() => rowOf(w, job.temporaryId).processingAttempts === 1, "running");
        const t0 = performance.now();
        assert.deepEqual(await worker.stop({ timeoutMs: 100 }), { finished: false, released: 1 });
        assert.ok(performance.now() - t0 < 1_000, "stop() is bounded");
        let row = rowOf(w, job.temporaryId);
        assert.equal(row.processingAttempts, 0);
        assert.equal(await claimNextSubmission({ db: w.db.client }), null, "not before the retry delay");

        slowOcr.open();
        await sleep(50);
        row = rowOf(w, job.temporaryId);
        assert.equal(row.processingStatus, "TEMPORARY_STORED", "the released attempt wrote nothing");
        assert.equal(w.db.tables.document.length, 0);

        const [next] = await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, extractText: textOf("medical-gamca"), now: () => new Date(Date.now() + QUEUE_DEFAULTS.retryDelayMs + 1_000) });
        assert.deepEqual([next.attempt, next.summary.processingStatus], [1, "VERIFIED"]);
    });

    test("a storage copy still running at the deadline -> released; the next run reuses that copy (no _v2)", async () => {
        const w = world();
        const job = await recordJob(w, "copy", PASSPORT_PDF, "passport.pdf");
        const slowCopy = gate();
        let blocked = false;
        w.bucket.hooks.copy = async () => { if (!blocked) { blocked = true; await slowCopy.promise; } };
        const worker = startSubmissionWorker({ db: w.db.client, bucket: w.bucket, concurrency: 1, pollMs: 60_000, log: { log() {}, warn() {}, error() {} } });
        await until(() => blocked, "copy running");
        assert.deepEqual(await worker.stop({ timeoutMs: 100 }), { finished: false, released: 1 });
        slowCopy.open(); // the copy lands after the release; the attempt inserts nothing
        await sleep(50);
        assert.equal(w.db.tables.document.length, 0);

        const [next] = await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, now: () => new Date(Date.now() + QUEUE_DEFAULTS.retryDelayMs + 1_000) });
        assert.equal(next.summary.processingStatus, "VERIFIED");
        assert.deepEqual(w.bucket.keys("clients/"), ["clients/N1234567/passport/passport.pdf"]);
        assert.equal(w.db.tables.document[0].storagePath, "clients/N1234567/passport/passport.pdf");
        assert.equal(rowOf(w, job.temporaryId).processingAttempts, 1);
    });

    test("shutdown sequence: server closed, worker stopped, Prisma disconnected, then exit(0) — well inside the deadline", async () => {
        const w = world();
        await recordJob(w, "s1", OTHER_PDF("medical s1"));
        await recordJob(w, "s2", OTHER_PDF("medical s2"));
        const events = [];
        const worker = startSubmissionWorker({ db: w.db.client, bucket: w.bucket, concurrency: 1, pollMs: 60_000, extractText: fastOcr(100), log: { log() {}, error() {} } });
        const server = http.createServer((req, res) => res.end("ok"));
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        server.on("close", () => events.push("server closed"));
        w.db.client.$disconnect = async () => { events.push("prisma disconnected"); };
        const stop = worker.stop;
        const trackedWorker = { stop: async (o) => { const r = await stop(o); events.push("worker stopped"); return r; } };
        await until(() => w.db.tables.temporaryData.some((r) => r.processingAttempts === 1), "running");

        const t0 = performance.now();
        await createShutdown({ server, worker: trackedWorker, db: w.db.client, exit: (code) => events.push(`exit ${code}`), log: { log() {}, error() {} } })("SIGTERM");
        assert.ok(performance.now() - t0 < SHUTDOWN_DEADLINE_MS);
        assert.deepEqual(events.slice(-2), ["prisma disconnected", "exit 0"]);
        assert.ok(events.indexOf("server closed") < events.indexOf("prisma disconnected"));
        assert.ok(events.indexOf("worker stopped") < events.indexOf("prisma disconnected"));
        assert.equal(w.db.tables.temporaryData.filter((r) => r.processingAttempts === 0).length, 1, "the waiting job was left for the next run");
    });

    test("a request still running at the deadline -> exit(1) at the deadline, exactly once", async () => {
        const server = http.createServer(() => {}); // never answers
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const request = fetch(`http://127.0.0.1:${server.address().port}/`).catch(() => {});
        await sleep(50);
        const exits = [];
        const t0 = performance.now();
        const done = createShutdown({ server, worker: { stop: async () => ({ finished: true, released: 0 }) }, db: { $disconnect: async () => {} }, deadlineMs: 200, exit: (code) => exits.push([code, performance.now() - t0]), log: { log() {}, error() {} } })("SIGTERM");
        await sleep(400);
        assert.equal(exits.length, 1);
        assert.equal(exits[0][0], 1);
        assert.ok(exits[0][1] >= 190 && exits[0][1] < 400);
        server.closeAllConnections();
        await done;
        await request;
        assert.equal(exits.length, 1, "not a second time when the rest completes");
    });

    test("SIGTERM twice -> one shutdown", async () => {
        let stops = 0;
        const exits = [];
        const shutdown = createShutdown({ server: { close: (cb) => cb() }, worker: { stop: async () => { stops += 1; return { finished: true, released: 0 }; } }, db: { $disconnect: async () => {} }, exit: (c) => exits.push(c), log: { log() {}, error() {} } });
        await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
        assert.equal(stops, 1);
        assert.deepEqual(exits, [0]);
    });
});

describe("M1 fix 5: retrying a job never makes a second copy", () => {
    test("Test 7: crash after the client-folder copy, before the documents insert -> the retry reuses the copy: one file, one document, no _v2", async () => {
        const w = world();
        const job = await recordJob(w, "crash", PASSPORT_PDF, "passport.pdf");
        // The process dies after the copy, before its insert transaction (a transaction
        // in flight would be rolled back by the database when the process dies).
        const transaction = w.db.client.$transaction;
        w.db.client.$transaction = (...args) => (w.bucket.keys("clients/").length ? never() : transaction(...args));
        const rowA = await claimNextSubmission({ db: w.db.client });
        processClaimedSubmission(rowA, { db: w.db.client, bucket: w.bucket });
        await until(() => w.bucket.keys("clients/").length === 1, "copied");
        await sleep(20);
        w.db.client.$transaction = transaction;

        const [retry] = await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, now: afterLease() });
        assert.deepEqual([retry.attempt, retry.summary.processingStatus], [2, "VERIFIED"]);
        assert.deepEqual(w.bucket.keys("clients/"), ["clients/N1234567/passport/passport.pdf"]);
        assert.equal(w.db.tables.document.length, 1);
        assert.deepEqual([w.db.tables.document[0].storedFilename, w.db.tables.document[0].temporaryId], ["passport.pdf", job.temporaryId]);
    });

    test("Test 8: crash after the pending copy, before the row update -> the retry reuses it: one pending file, referenced by the row", async () => {
        const w = world();
        const job = await recordJob(w, "pcrash", OTHER_PDF("invoice p"));
        const updateMany = w.db.client.temporaryData.updateMany;
        w.db.client.temporaryData.updateMany = (args) => (args.data.processingStatus ? never() : updateMany(args)); // dies at the final update
        const rowA = await claimNextSubmission({ db: w.db.client });
        processClaimedSubmission(rowA, { db: w.db.client, bucket: w.bucket, extractText: invoiceText });
        await until(() => w.bucket.keys("pending/").length === 1, "copied");
        await sleep(20);
        w.db.client.temporaryData.updateMany = updateMany;

        const [retry] = await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, extractText: invoiceText, now: afterLease() });
        assert.equal(retry.summary.processingStatus, "UNDEFINED");
        const pending = w.bucket.keys("pending/");
        assert.equal(pending.length, 1, "no second pending file");
        assert.equal(rowOf(w, job.temporaryId).pendingStoragePath, pending[0]);
    });

    test("only this submission's own earlier copy is reused (recorded path, not referenced elsewhere, same checksum)", async () => {
        const w = world();
        const job = await recordJob(w, "own", PASSPORT_PDF, "passport.pdf");
        const path = "clients/N1234567/passport/passport.pdf";
        await w.bucket.upload(path, PASSPORT_PDF);
        const row = { ...rowOf(w, job.temporaryId), processingAttempts: 2, processingStartedAt: new Date() };
        const hooks = (overrides = {}) => placementCopyHooks({ claim: { ...createClaim({ ...row, placementPath: path }, { db: w.db.client }), ...overrides }, fileSha256: sha(PASSPORT_PDF) }, { db: w.db.client, bucket: w.bucket });

        assert.equal(await hooks().reuseExisting(path), true);
        assert.equal(await hooks({ earlierPlacementPath: null }).reuseExisting(path), false, "not recorded by this submission");
        assert.equal(await placementCopyHooks({ claim: createClaim({ ...row, placementPath: path }, { db: w.db.client }), fileSha256: sha(OTHER_PDF("different")) }, { db: w.db.client, bucket: w.bucket }).reuseExisting(path), false, "different content");
        w.db.tables.temporaryData.push({ temporaryId: "other-submission", placementPath: path, processingStatus: "TEMPORARY_STORED" });
        assert.equal(await hooks().reuseExisting(path), false, "another submission recorded the same name");
        w.db.tables.temporaryData.pop();
        w.db.tables.document.push({ documentId: "d-other", passportId: "N1234567", storagePath: path });
        assert.equal(await hooks().reuseExisting(path), false, "a document already refers to it");
        assert.deepEqual(placementCopyHooks({ claim: null, fileSha256: "x" }, { db: w.db.client, bucket: w.bucket }), {}, "callers other than the worker: unchanged");
    });

    test("an object at the name that this submission did not record is left alone -> the next version (unchanged behaviour)", async () => {
        const w = world();
        await recordJob(w, "fresh", PASSPORT_PDF, "passport.pdf");
        await w.bucket.upload("clients/N1234567/passport/passport.pdf", OTHER_PDF("someone else's upload"));
        const [out] = await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket });
        assert.equal(out.summary.processingStatus, "VERIFIED");
        assert.equal(w.db.tables.document[0].storedFilename, "passport_v2.pdf");
        assert.deepEqual(w.bucket.objects.get("clients/N1234567/passport/passport.pdf"), OTHER_PDF("someone else's upload"), "untouched");
    });
});
