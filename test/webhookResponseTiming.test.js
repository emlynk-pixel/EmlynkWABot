import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import express from "express";

import { createMessageIdCache } from "../src/utils/messageIdempotency.js";
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
const { drainSubmissionQueue, startSubmissionWorker } = await import("../src/services/submissionQueue.js");

// M1 "Webhook Response Timing": the webhook must acknowledge Meta right
// after the submission is durably recorded, never after OCR, classification
// or storage placement, which the existing background worker (M1) does.
// This is already how the webhook and worker are wired (23404f1, f59cffe);
// these tests pin that behaviour down explicitly, with slow OCR and slow
// storage placement measured independently. Synthetic data only.
const PASSPORT_PDF = readFileSync(new URL("./fixtures/files/text-passport.pdf", import.meta.url));
const SENDER = "94771234567";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sign = (raw) => "sha256=" + crypto.createHmac("sha256", process.env.META_APP_SECRET).update(raw).digest("hex");
const textOf = (name, confidence = 97) => async () => ({ success: true, method: "OCR", text: loadDocumentText(name), confidence });
const USER = { passportId: "N1234567", uniqueId: "0001", whatsappNumber: "0771234567", firstName: "KAMAL NIMAL", otherName: "PERERA", dateOfBirth: null, placeOfBirth: null, passportExpiryDate: null };

// In-memory bucket. hooks.<method>(...args) runs first, so a hook can delay a call.
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
        async remove(paths) { paths.forEach((p) => objects.delete(p)); return { data: paths, error: null }; },
        async download(p) { return objects.has(p) ? { data: objects.get(p), error: null } : { data: null, error: { message: "not found" } }; },
    };
}

const OTHER_PDF = (label) => Buffer.from(`%PDF-1.4\n% synthetic ${label}\n%%EOF\n`);

function world({ media = { m1: PASSPORT_PDF } } = {}) {
    const db = createFakeReviewDb({ users: [USER] });
    const bucket = memoryBucket();
    const handoffs = [];
    const deps = {
        messageCache: createMessageIdCache(),
        getMediaUrl: async (mediaId) => `https://lookaside.fbsbx.com/x?mid=${mediaId}`,
        downloadMedia: async (url) => media[new URL(url).searchParams.get("mid")],
        saveTemporary: ({ fileBuffer, mimeType }) => saveTemporaryFile({ fileBuffer, mimeType, bucket }),
        createTemporaryRecord: (args) => createTemporaryDocumentRecord(args, { db: db.client }),
        removeTemporary: (p) => removeObject(p, { bucket }),
        onRecorded: (row) => handoffs.push(row.temporaryId),
    };
    return { db, bucket, deps, handoffs };
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
                const t0 = performance.now();
                const response = await fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(text) }, body: text });
                return { status: response.status, ms: performance.now() - t0 };
            },
        });
    } finally {
        server.close();
    }
}

const doc = (id, mediaId, fileName = "passport.pdf") => ({ from: SENDER, id, timestamp: "1790000000", type: "document", document: { id: mediaId, mime_type: "application/pdf", filename: fileName } });
const delivery = (...messages) => ({ entry: [{ changes: [{ value: { messages } }] }] });

let logs;
const originals = {};
beforeEach(() => {
    logs = [];
    for (const level of ["log", "warn", "error"]) { originals[level] = console[level]; console[level] = (...a) => logs.push(a); }
});
afterEach(() => { for (const level of ["log", "warn", "error"]) console[level] = originals[level]; });

describe("Webhook response timing: acknowledgement never waits for OCR, classification or storage placement", () => {
    test("slow OCR (3 s) in the worker: the webhook still answers in well under 1 s", async () => {
        const w = world();
        let ackMs;
        await withServer(w.deps, async ({ post }) => {
            const { status, ms } = await post(delivery(doc("wamid.OCR1", "m1")));
            assert.equal(status, 200);
            ackMs = ms;
        });
        const [row] = w.db.tables.temporaryData;
        assert.equal(row.processingStatus, "TEMPORARY_STORED", "the webhook committed the job; OCR has not run yet");

        const slowOcr = async (args) => { await sleep(3_000); return textOf("passport-mrz")(args); };
        const t0 = performance.now();
        const [outcome] = await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, extractText: slowOcr });
        const workerMs = performance.now() - t0;

        assert.ok(ackMs < 1_000, `webhook ack was ${Math.round(ackMs)} ms`);
        assert.ok(workerMs >= 3_000, `worker should have waited for the slow OCR (${Math.round(workerMs)} ms)`);
        assert.ok(ackMs * 5 < workerMs, `ack ${Math.round(ackMs)} ms should be far less than worker ${Math.round(workerMs)} ms`);
        assert.equal(outcome.summary.processingStatus, "VERIFIED");
    });

    test("slow storage placement (copy into the client folder, 2 s): the webhook still answers in well under 1 s", async () => {
        const w = world();
        let ackMs;
        await withServer(w.deps, async ({ post }) => {
            const { status, ms } = await post(delivery(doc("wamid.STORE1", "m1")));
            assert.equal(status, 200);
            ackMs = ms;
        });
        const [row] = w.db.tables.temporaryData;
        assert.equal(row.processingStatus, "TEMPORARY_STORED", "committed before any storage placement runs");

        w.bucket.hooks.copy = async () => { await sleep(2_000); };
        const t0 = performance.now();
        const [outcome] = await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket });
        const workerMs = performance.now() - t0;

        assert.ok(ackMs < 1_000, `webhook ack was ${Math.round(ackMs)} ms`);
        assert.ok(workerMs >= 2_000, `worker should have waited for the slow copy (${Math.round(workerMs)} ms)`);
        assert.ok(ackMs * 5 < workerMs, `ack ${Math.round(ackMs)} ms should be far less than worker ${Math.round(workerMs)} ms`);
        assert.equal(outcome.summary.processingStatus, "VERIFIED");
        assert.equal(w.bucket.keys("clients/").length, 1);
    });

    test("slow OCR and slow storage together: acknowledgement is unaffected, and only one submission exists", async () => {
        const w = world();
        let ackMs;
        await withServer(w.deps, async ({ post }) => {
            const { status, ms } = await post(delivery(doc("wamid.BOTH1", "m1")));
            assert.equal(status, 200);
            ackMs = ms;
        });
        w.bucket.hooks.copy = async () => { await sleep(1_000); };
        const slowOcr = async (args) => { await sleep(1_500); return textOf("passport-mrz")(args); };
        const t0 = performance.now();
        await drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, extractText: slowOcr });
        const workerMs = performance.now() - t0;

        assert.ok(ackMs < 1_000, `webhook ack was ${Math.round(ackMs)} ms`);
        assert.ok(workerMs >= 2_000, `worker should reflect both delays (${Math.round(workerMs)} ms)`);
        assert.equal(w.db.tables.temporaryData.length, 1);
        assert.equal(w.db.tables.temporaryData[0].processingStatus, "VERIFIED");
    });

    test("a background worker running continuously (real startSubmissionWorker) never blocks new webhook acknowledgements", async () => {
        // Two distinct files of different types, so both are stored cleanly (not
        // one colliding with the other on checksum or identity) — the point here
        // is ack timing, not checksum/dedup or classification behaviour.
        const secondFile = OTHER_PDF("second");
        const w = world({ media: { m1: PASSPORT_PDF, m2: secondFile } });
        const slowOcr = async (args) => {
            await sleep(1_500);
            return args.fileBuffer.equals(PASSPORT_PDF) ? textOf("passport-mrz")(args) : textOf("medical-gamca")(args);
        };
        const worker = startSubmissionWorker({ db: w.db.client, bucket: w.bucket, extractText: slowOcr, pollMs: 50, concurrency: 1, log: { log() {}, error() {} } });
        try {
            await withServer(w.deps, async ({ post }) => {
                // Two messages back to back: the first's slow OCR must not delay the second's ack.
                const first = await post(delivery(doc("wamid.WK1", "m1")));
                assert.equal(first.status, 200);
                assert.ok(first.ms < 1_000, `first ack ${Math.round(first.ms)} ms`);
                await sleep(50); // let the worker pick up the first job (still mid-OCR)
                const second = await post(delivery(doc("wamid.WK2", "m2")));
                assert.equal(second.status, 200);
                assert.ok(second.ms < 1_000, `second ack ${Math.round(second.ms)} ms, while the worker's OCR was still running`);
            });
            for (let i = 0; i < 200 && w.db.tables.temporaryData.some((r) => r.processingStatus === "TEMPORARY_STORED"); i++) await sleep(20);
        } finally {
            await worker.stop();
        }
        // The point here is that both acks were fast regardless of the worker's slow
        // OCR; the exact terminal classification/identity outcome is out of scope
        // (covered by the pipeline's own tests) — only that both finished processing.
        assert.equal(w.db.tables.temporaryData.length, 2);
        assert.ok(w.db.tables.temporaryData.every((r) => r.processingStatus !== "TEMPORARY_STORED"), "both jobs finished processing");
    });

    test("duplicate delivery while the worker is deep in slow OCR still resolves quickly (200, no second submission)", async () => {
        const w = world();
        await withServer(w.deps, async ({ post }) => {
            assert.equal((await post(delivery(doc("wamid.DUP1", "m1")))).status, 200);
        });
        // The job is now durable and recorded; the worker starts slow OCR on it.
        const slowOcr = async (args) => { await sleep(2_000); return textOf("passport-mrz")(args); };
        const workerRun = drainSubmissionQueue({ db: w.db.client, bucket: w.bucket, extractText: slowOcr });

        // Meta re-delivers the same message while OCR is still running in the worker.
        await withServer(w.deps, async ({ post }) => {
            const { status, ms } = await post(delivery(doc("wamid.DUP1", "m1")));
            assert.equal(status, 200);
            assert.ok(ms < 1_000, `duplicate ack was ${Math.round(ms)} ms (worker OCR unrelated to webhook dedup)`);
        });
        await workerRun;
        assert.equal(w.db.tables.temporaryData.length, 1, "still exactly one submission");
        assert.equal(w.bucket.keys("temporary/").length, 1, "no orphaned second upload");
    });

    test("no second processing pipeline: the webhook route never imports OCR or document-processing services", () => {
        const source = fs.readFileSync(new URL("../src/routes/whatsapp.js", import.meta.url), "utf8");
        assert.ok(!/documentProcessingService|ocrService|documentClassificationService/.test(source), "the webhook must hand off to the single worker pipeline, not run its own");
        // It may only ever notify the worker to wake up.
        const submissionQueueImports = [...source.matchAll(/from ["']\.\.\/services\/submissionQueue\.js["'];?\s*\n?\s*import\s*{([^}]*)}/g)];
        const imported = source.match(/import\s*{\s*([^}]*)\s*}\s*from\s*["']\.\.\/services\/submissionQueue\.js["']/);
        assert.ok(imported, "expected an import from submissionQueue.js");
        assert.deepEqual(imported[1].split(",").map((s) => s.trim()).filter(Boolean).sort(), ["notifySubmissionQueued"]);
    });

    test("recording failure still returns 500 promptly (no waiting) so Meta retries, and doesn't leave an orphaned upload", async () => {
        const w = world();
        w.deps.createTemporaryRecord = async () => { throw new Error("database unavailable"); };
        await withServer(w.deps, async ({ post }) => {
            const { status, ms } = await post(delivery(doc("wamid.FAIL1", "m1")));
            assert.equal(status, 500);
            assert.ok(ms < 1_000, `failure response was ${Math.round(ms)} ms`);
        });
        assert.equal(w.db.tables.temporaryData.length, 0);
        assert.equal(w.bucket.keys("temporary/").length, 0, "the failed upload was cleaned up");
    });
});
