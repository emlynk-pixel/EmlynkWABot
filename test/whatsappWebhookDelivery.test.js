import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";

import { createMessageIdCache } from "../src/utils/messageIdempotency.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

// Placeholders so the route's modules load without real credentials.
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-placeholder";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.META_APP_SECRET = "test-app-secret-placeholder";

const { createWhatsappRouter, listMessages } = await import("../src/routes/whatsapp.js");
const { MediaRejectedError } = await import("../src/services/whatsappMediaService.js");

// Synthetic senders, IDs and files only.
const SENDER = "94770000000";
const PDF_BYTES = Buffer.from("%PDF-1.4\n% synthetic test document\n%%EOF\n");

const documentMessage = (id, extra = {}) => ({
    from: SENDER, id, timestamp: "1790000000", type: "document",
    document: { id: `media-${id.replace(/\W/g, "")}`, filename: "scan.pdf", mime_type: "application/pdf" }, ...extra,
});
const textMessage = (id) => ({ from: SENDER, id, timestamp: "1790000000", type: "text", text: { body: "hello" } });
const delivery = (...entries) => ({
    object: "whatsapp_business_account",
    entry: entries.map((changes) => ({ changes: changes.map((messages) => ({ value: { messages } })) })),
});

const sign = (raw) => "sha256=" + crypto.createHmac("sha256", process.env.META_APP_SECRET).update(raw).digest("hex");

// Fake Meta, storage and database. Storage objects and temporary_data rows
// are tracked, so every test can check nothing was left behind.
// failures: { stage: [error, error, …] } — one error per call, in order.
function fakeWorld(failures = {}) {
    const objects = new Set();
    const records = [];
    const calls = { getMediaUrl: 0, download: 0, save: 0, record: 0, process: 0, remove: [] };
    const fail = (stage) => {
        const error = failures[stage]?.shift();
        if (error) throw error;
    };
    let n = 0;
    return {
        objects, records, calls,
        deps: {
            messageCache: createMessageIdCache(),
            getMediaUrl: async () => { calls.getMediaUrl += 1; fail("getMediaUrl"); return "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=synthetic"; },
            downloadMedia: async () => { calls.download += 1; fail("download"); return PDF_BYTES; },
            saveTemporary: async () => {
                calls.save += 1;
                fail("save");
                const storagePath = `temporary/object-${++n}.pdf`;
                objects.add(storagePath);
                return { storagePath, storedFileName: storagePath.slice(10) };
            },
            createTemporaryRecord: async ({ temporaryStoragePath }) => {
                calls.record += 1;
                fail("record");
                const row = { temporaryId: `tmp-${records.length + 1}`, temporaryStoragePath, processingStatus: "TEMPORARY_STORED" };
                records.push(row);
                return row;
            },
            processDocument: async ({ temporaryId }) => {
                calls.process += 1;
                fail("process");
                records.find((r) => r.temporaryId === temporaryId).processingStatus = "VERIFIED";
                return { summary: { stage: "COMPLETED", processingStatus: "VERIFIED" } };
            },
            removeTemporary: async (storagePath) => {
                calls.remove.push(storagePath);
                const error = failures.remove?.shift();
                if (error) return { removed: false, error: error.message };
                objects.delete(storagePath);
                return { removed: true, error: null };
            },
        },
    };
}

// No temporary object without a record, no record without its object.
function assertNoOrphans(world) {
    const referenced = new Set(world.records.map((r) => r.temporaryStoragePath));
    assert.deepEqual([...world.objects].filter((p) => !referenced.has(p)), [], "unreferenced temporary objects");
    assert.deepEqual([...referenced].filter((p) => !world.objects.has(p)), [], "records without their object");
}

async function withApp(world, run) {
    const app = express();
    app.use(express.json({ verify: (req, res, buffer) => { req.rawBody = buffer; } }));
    app.use("/whatsapp", createWhatsappRouter(world.deps));
    app.use(errorHandler);
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const post = async (body) => {
        const raw = JSON.stringify(body);
        const response = await fetch(`http://127.0.0.1:${server.address().port}/whatsapp/webhook`, {
            method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(raw) }, body: raw,
        });
        return response.status;
    };
    try {
        await run(post);
    } finally {
        server.close();
    }
}

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

describe("H1: every message of a delivery is handled", () => {
    test("several messages in one change -> all processed, 200", async () => {
        const world = fakeWorld();
        await withApp(world, async (post) => {
            assert.equal(await post(delivery([[documentMessage("wamid.a"), documentMessage("wamid.b"), documentMessage("wamid.c")]])), 200);
        });
        assert.equal(world.calls.process, 3);
        assert.equal(world.records.length, 3);
        assertNoOrphans(world);
    });

    test("messages spread over several entries and changes -> all processed", async () => {
        const world = fakeWorld();
        await withApp(world, async (post) => {
            assert.equal(await post(delivery([[documentMessage("wamid.e1")], [documentMessage("wamid.e2")]], [[documentMessage("wamid.e3")]])), 200);
        });
        assert.equal(world.calls.process, 3);
    });

    test("other message types in the batch are acknowledged; documents still processed", async () => {
        const world = fakeWorld();
        await withApp(world, async (post) => {
            assert.equal(await post(delivery([[textMessage("wamid.t1"), documentMessage("wamid.d1"), { from: SENDER, type: "document" }]])), 200);
        });
        assert.equal(world.calls.process, 1);
    });

    test("the same message ID twice in one delivery, and a resent delivery -> processed once", async () => {
        const world = fakeWorld();
        const body = delivery([[documentMessage("wamid.same"), documentMessage("wamid.same")]]);
        await withApp(world, async (post) => {
            assert.equal(await post(body), 200);
            assert.equal(await post(body), 200);
        });
        assert.equal(world.calls.download, 1);
        assert.equal(world.records.length, 1);
    });

    test("status updates and malformed shapes -> 200, nothing processed", async () => {
        const world = fakeWorld();
        await withApp(world, async (post) => {
            for (const body of [{ entry: [{ changes: [{ value: { statuses: [{ id: "x" }] } }] }] }, { entry: "x" }, { entry: [{ changes: {} }] }, { entry: [{ changes: [{ value: { messages: "x" } }] }] }, {}]) {
                assert.equal(await post(body), 200);
            }
        });
        assert.equal(world.calls.getMediaUrl, 0);
    });

    test("listMessages flattens entry -> changes -> messages", () => {
        assert.deepEqual(listMessages(delivery([[{ id: "1" }, { id: "2" }], [{ id: "3" }]], [[{ id: "4" }]])).map((m) => m.id), ["1", "2", "3", "4"]);
        assert.deepEqual(listMessages(null), []);
        assert.deepEqual(listMessages({ entry: [null, { changes: [null, { value: null }] }] }), []);
    });
});

describe("H2: failures before the record exists are retried, never marked processed", () => {
    for (const stage of ["getMediaUrl", "download", "save"]) {
        test(`${stage} fails -> 500, claim released, nothing left behind; Meta's retry succeeds`, async () => {
            const world = fakeWorld({ [stage]: [new Error("network timeout")] });
            const body = delivery([[documentMessage("wamid.retry")]]);
            await withApp(world, async (post) => {
                assert.equal(await post(body), 500);
                assert.equal(world.deps.messageCache.stateOf("wamid.retry"), null, "claim released");
                assert.equal(world.records.length, 0);
                assertNoOrphans(world);

                assert.equal(await post(body), 200); // Meta's retry
            });
            assert.equal(world.records.length, 1);
            assert.equal(world.calls.process, 1);
            assert.equal(world.deps.messageCache.stateOf("wamid.retry"), "PROCESSED");
            assertNoOrphans(world);
        });
    }

    test("record insert fails after the upload -> the uploaded object is removed, 500; retry stores it once", async () => {
        const world = fakeWorld({ record: [new Error("database unavailable")] });
        const body = delivery([[documentMessage("wamid.db")]]);
        await withApp(world, async (post) => {
            assert.equal(await post(body), 500);
            assert.deepEqual(world.calls.remove, ["temporary/object-1.pdf"]);
            assert.equal(world.objects.size, 0);
            assertNoOrphans(world);
            assert.equal(await post(body), 200);
        });
        assert.equal(world.records.length, 1);
        assert.equal(world.objects.size, 1);
        assertNoOrphans(world);
    });

    test("if removing the uploaded object also fails, it is logged (no path) and the message is still retried", async () => {
        const world = fakeWorld({ record: [new Error("database unavailable")], remove: [new Error("storage down")] });
        await withApp(world, async (post) => {
            assert.equal(await post(delivery([[documentMessage("wamid.leftover")]])), 500);
        });
        const logged = JSON.stringify(logs);
        assert.match(logged, /temporary file NOT removed/);
        assert.ok(!logged.includes("temporary/object-1"), "no storage path in logs");
        assert.equal(world.deps.messageCache.stateOf("wamid.leftover"), null);
    });

    test("one failing message in a batch: 500; on the retry only that message runs again", async () => {
        const world = fakeWorld({ download: [undefined, new Error("timeout")] }); // 2nd download fails once
        const body = delivery([[documentMessage("wamid.ok"), documentMessage("wamid.bad"), documentMessage("wamid.ok2")]]);
        await withApp(world, async (post) => {
            assert.equal(await post(body), 500);
            assert.equal(world.records.length, 2); // the other two were not held back
            assert.equal(await post(body), 200);
        });
        assert.equal(world.records.length, 3);
        assert.equal(world.calls.process, 3, "each message processed exactly once");
        assertNoOrphans(world);
    });

    test("once the record exists the message is handled: an unexpected processing error is not retried (no second record)", async () => {
        const world = fakeWorld({ process: [new Error("unexpected")] });
        const body = delivery([[documentMessage("wamid.recorded")]]);
        await withApp(world, async (post) => {
            assert.equal(await post(body), 200);
            assert.equal(await post(body), 200);
        });
        assert.equal(world.records.length, 1);
        assert.equal(world.calls.remove.length, 0, "the recorded file is kept");
        assertNoOrphans(world);
    });

    test("a refused file is still handled, not retried (unchanged)", async () => {
        const world = fakeWorld({ download: [new MediaRejectedError("FILE_TOO_LARGE")] });
        const body = delivery([[documentMessage("wamid.refused")]]);
        await withApp(world, async (post) => {
            assert.equal(await post(body), 200);
            assert.equal(await post(body), 200);
        });
        assert.equal(world.calls.download, 1);
        assert.equal(world.records.length, 0);
    });

    test("failure logs contain no phone number, file name, path, media ID or raw message ID", async () => {
        const world = fakeWorld({ download: [new Error("timeout for https://lookaside.fbsbx.com/x")], record: [new Error("insert failed for 94770000000")] });
        await withApp(world, async (post) => {
            await post(delivery([[documentMessage("wamid.HBgLOTQ3NzAw1"), documentMessage("wamid.HBgLOTQ3NzAw2")]]));
        });
        const logged = JSON.stringify(logs);
        for (const value of ["770000000", "scan.pdf", "temporary/", "media-", "wamid.", "lookaside"]) {
            assert.ok(!logged.includes(value), `log contains ${value}`);
        }
        assert.match(logged, /MEDIA_DOWNLOAD/);
        assert.match(logged, /RECORD_INSERT/);
    });
});
