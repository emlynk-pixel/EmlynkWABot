import { describe, test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";

import { createMessageIdCache } from "../src/utils/messageIdempotency.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

// Placeholders so the route's modules load without real credentials
// (dotenv never overrides variables that are already set).
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-placeholder";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.META_APP_SECRET = "test-app-secret-placeholder";
process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token-placeholder";

const { createWhatsappRouter } = await import("../src/routes/whatsapp.js");
const { MediaRejectedError } = await import("../src/services/whatsappMediaService.js");

// Synthetic sender, IDs and file.
const SENDER = "94770000000";
const PDF_BYTES = Buffer.from("%PDF-1.4\n% synthetic test document\n%%EOF\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function documentEvent(messageId, { fileName = "Kamal Perera passport.pdf" } = {}) {
    return {
        object: "whatsapp_business_account",
        entry: [{
            changes: [{
                value: {
                    messages: [{
                        from: SENDER,
                        id: messageId,
                        timestamp: "1790000000",
                        type: "document",
                        document: { id: "media-synthetic-1", filename: fileName, mime_type: "application/pdf" },
                    }],
                },
            }],
        }],
    };
}

const sign = (raw) => "sha256=" + crypto.createHmac("sha256", process.env.META_APP_SECRET).update(raw).digest("hex");

// Fake external services; processDocument counts calls and can be slowed down.
function fakeServices({ processDelayMs = 0, downloadError = null, fileBytes = PDF_BYTES } = {}) {
    const calls = { processDocument: 0, download: 0, saveTemporary: 0 };
    return {
        calls,
        deps: {
            messageCache: createMessageIdCache(),
            getMediaUrl: async () => "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=synthetic",
            downloadMedia: async () => {
                calls.download += 1;
                if (downloadError) throw downloadError;
                return fileBytes;
            },
            saveTemporary: async () => {
                calls.saveTemporary += 1;
                return { storagePath: "temporary/3f2b8c1e.pdf", storedFileName: "3f2b8c1e.pdf" };
            },
            createTemporaryRecord: async () => ({ temporaryId: "tmp-synthetic", processingStatus: "TEMPORARY_STORED" }),
            processDocument: async () => {
                calls.processDocument += 1;
                await sleep(processDelayMs);
                return { summary: { stage: "COMPLETED", processingStatus: "VERIFIED" } };
            },
        },
    };
}

async function startApp(deps) {
    const app = express();
    app.use(express.json({ verify: (req, res, buffer) => { req.rawBody = buffer; } }));
    app.use("/whatsapp", createWhatsappRouter(deps));
    app.use(errorHandler);
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function postEvent(baseUrl, body, { signature } = {}) {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const headers = { "Content-Type": "application/json" };
    if (signature !== null) headers["X-Hub-Signature-256"] = signature ?? sign(raw);
    const response = await fetch(`${baseUrl}/whatsapp/webhook`, { method: "POST", headers, body: raw });
    return { status: response.status, text: await response.text() };
}

// Collect everything the route logs, and keep test output quiet.
let logs;
const originals = {};
beforeEach(() => {
    logs = [];
    for (const level of ["log", "warn", "error"]) {
        originals[level] = console[level];
        console[level] = (...args) => logs.push(args);
    }
});
afterEach(() => {
    for (const level of ["log", "warn", "error"]) console[level] = originals[level];
});

describe("POST /whatsapp/webhook: signature", () => {
    let app;
    let services;
    before(async () => { services = fakeServices(); app = await startApp(services.deps); });
    after(() => app.server.close());

    test("missing signature -> 401, nothing processed", async () => {
        const result = await postEvent(app.baseUrl, documentEvent("wamid.nosig"), { signature: null });
        assert.equal(result.status, 401);
        assert.equal(services.calls.download, 0);
    });

    test("invalid signature -> 401, nothing processed", async () => {
        const result = await postEvent(app.baseUrl, documentEvent("wamid.badsig"), { signature: `sha256=${"0".repeat(64)}` });
        assert.equal(result.status, 401);
        assert.equal(services.calls.download, 0);
    });

    test("signature over different bytes -> 401", async () => {
        const result = await postEvent(app.baseUrl, documentEvent("wamid.tampered"), { signature: sign("{}") });
        assert.equal(result.status, 401);
    });

    test("valid signature -> 200 and processed", async () => {
        const result = await postEvent(app.baseUrl, documentEvent("wamid.valid"));
        assert.equal(result.status, 200);
        assert.equal(services.calls.processDocument, 1);
    });

    test("malformed JSON -> safe 400 JSON", async () => {
        const result = await postEvent(app.baseUrl, "{not json");
        assert.equal(result.status, 400);
        assert.deepEqual(JSON.parse(result.text), { message: "Invalid request body" });
    });

    test("event without messages (e.g. status update) -> 200, nothing processed", async () => {
        const before = services.calls.download;
        const result = await postEvent(app.baseUrl, { entry: [{ changes: [{ value: { statuses: [{ id: "x" }] } }] }] });
        assert.equal(result.status, 200);
        assert.equal(services.calls.download, before);
    });

    test("message without an ID is ignored safely", async () => {
        const event = documentEvent("x");
        delete event.entry[0].changes[0].value.messages[0].id;
        const before = services.calls.download;

        const result = await postEvent(app.baseUrl, event);
        assert.equal(result.status, 200);
        assert.equal(services.calls.download, before);
    });
});

describe("POST /whatsapp/webhook: replay and duplicates (SEC-006)", () => {
    test("same signed message twice in a row -> processed once", async () => {
        const services = fakeServices();
        const app = await startApp(services.deps);
        try {
            const event = documentEvent("wamid.sequential");
            assert.equal((await postEvent(app.baseUrl, event)).status, 200);
            assert.equal((await postEvent(app.baseUrl, event)).status, 200);

            assert.equal(services.calls.download, 1);
            assert.equal(services.calls.processDocument, 1);
        } finally {
            app.server.close();
        }
    });

    test("same message twice at the same time (retry during slow OCR) -> processed once", async () => {
        const services = fakeServices({ processDelayMs: 150 });
        const app = await startApp(services.deps);
        try {
            const event = documentEvent("wamid.parallel");
            const results = await Promise.all([postEvent(app.baseUrl, event), postEvent(app.baseUrl, event), postEvent(app.baseUrl, event)]);

            assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
            assert.equal(services.calls.download, 1);
            assert.equal(services.calls.processDocument, 1);
        } finally {
            app.server.close();
        }
    });

    test("different message IDs -> each processed", async () => {
        const services = fakeServices();
        const app = await startApp(services.deps);
        try {
            await postEvent(app.baseUrl, documentEvent("wamid.one"));
            await postEvent(app.baseUrl, documentEvent("wamid.two"));
            assert.equal(services.calls.processDocument, 2);
        } finally {
            app.server.close();
        }
    });

    test("a refused file still counts as handled: a replay is not downloaded again", async () => {
        const services = fakeServices({ downloadError: new MediaRejectedError("FILE_TOO_LARGE") });
        const app = await startApp(services.deps);
        try {
            const event = documentEvent("wamid.refused");
            await postEvent(app.baseUrl, event);
            await postEvent(app.baseUrl, event);

            assert.equal(services.calls.download, 1);
            assert.equal(services.calls.processDocument, 0);
        } finally {
            app.server.close();
        }
    });
});

describe("POST /whatsapp/webhook: file content (SEC-009)", () => {
    test("an executable sent as application/pdf is refused: not stored, not processed", async () => {
        const services = fakeServices({ fileBytes: Buffer.from("MZ  synthetic executable") });
        const app = await startApp(services.deps);
        try {
            const result = await postEvent(app.baseUrl, documentEvent("wamid.disguised"));
            assert.equal(result.status, 200);
            assert.equal(services.calls.saveTemporary, 0);
            assert.equal(services.calls.processDocument, 0);
            assert.match(JSON.stringify(logs), /FILE_SIGNATURE_MISMATCH/);
        } finally {
            app.server.close();
        }
    });
});

describe("GET /whatsapp/webhook: verification (SEC-018)", () => {
    let app;
    before(async () => { app = await startApp(fakeServices().deps); });
    after(() => app.server.close());

    const verify = (params) => fetch(`${app.baseUrl}/whatsapp/webhook?${new URLSearchParams(params)}`);

    test("correct token -> 200 with the challenge as plain text", async () => {
        const response = await verify({ "hub.mode": "subscribe", "hub.verify_token": process.env.WHATSAPP_VERIFY_TOKEN, "hub.challenge": "1158201444" });

        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /^text\/plain/);
        assert.equal(await response.text(), "1158201444");
    });

    test("a challenge containing HTML is returned as text, not HTML", async () => {
        const response = await verify({ "hub.mode": "subscribe", "hub.verify_token": process.env.WHATSAPP_VERIFY_TOKEN, "hub.challenge": "<script>x</script>" });
        assert.match(response.headers.get("content-type"), /^text\/plain/);
    });

    test("wrong, missing or wrong-mode requests -> 403", async () => {
        const cases = [
            { "hub.mode": "subscribe", "hub.verify_token": "wrong-token", "hub.challenge": "1" },
            { "hub.mode": "subscribe", "hub.challenge": "1" },
            { "hub.mode": "unsubscribe", "hub.verify_token": process.env.WHATSAPP_VERIFY_TOKEN, "hub.challenge": "1" },
            { "hub.mode": "subscribe", "hub.verify_token": process.env.WHATSAPP_VERIFY_TOKEN.slice(0, -1), "hub.challenge": "1" },
        ];
        for (const params of cases) {
            const response = await verify(params);
            assert.equal(response.status, 403, JSON.stringify(params));
            assert.ok(!(await response.text()).includes(process.env.WHATSAPP_VERIFY_TOKEN));
        }
    });

    test("with no token configured, verification always fails", async () => {
        const saved = process.env.WHATSAPP_VERIFY_TOKEN;
        delete process.env.WHATSAPP_VERIFY_TOKEN;
        try {
            const response = await verify({ "hub.mode": "subscribe", "hub.challenge": "1" });
            assert.equal(response.status, 403);
        } finally {
            process.env.WHATSAPP_VERIFY_TOKEN = saved;
        }
    });
});

describe("webhook logging (SEC-011)", () => {
    test("logs contain no phone number, file name, storage path, media ID or raw message ID", async () => {
        const services = fakeServices();
        const app = await startApp(services.deps);
        try {
            await postEvent(app.baseUrl, documentEvent("wamid.HBgLOTQ3NzAwMDAwMDAVAgARGBI5", { fileName: "Kamal Perera passport.pdf" }));
            await postEvent(app.baseUrl, documentEvent("wamid.HBgLOTQ3NzAwMDAwMDAVAgARGBI5")); // duplicate
        } finally {
            app.server.close();
        }

        const logged = JSON.stringify(logs);
        for (const value of ["770000000", "0000", "Kamal", "Perera", "passport.pdf", "temporary/", "media-synthetic", "wamid.", "lookaside"]) {
            assert.ok(!logged.includes(value), `log contains ${value}`);
        }
        assert.match(logged, /messageRef/, "log lines are still connected by a message reference");
    });
});
