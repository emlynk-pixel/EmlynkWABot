import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    getWhatsappMediaUrl,
    downloadWhatsappMedia,
    MediaRejectedError,
    MEDIA_METADATA_TIMEOUT_MS,
    MEDIA_DOWNLOAD_TIMEOUT_MS,
} from "../src/services/whatsappMediaService.js";
import { MAX_FILE_SIZE } from "../src/utils/fileValidation.js";

// Synthetic values only: no real token, media ID or URL.
const TOKEN = "test-access-token";
const MEDIA_URL = "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=synthetic&sig=secret-signature";
const MB = 1024 * 1024;
const loadFile = (name) => readFileSync(new URL(`./fixtures/files/${name}`, import.meta.url));

let realFetch;
let savedEnv;
let calls;

beforeEach(() => {
    realFetch = globalThis.fetch;
    savedEnv = { token: process.env.WHATSAPP_ACCESS_TOKEN, version: process.env.WHATSAPP_API_VERSION };
    process.env.WHATSAPP_ACCESS_TOKEN = TOKEN;
    process.env.WHATSAPP_API_VERSION = "v21.0";
    calls = [];
});

afterEach(() => {
    globalThis.fetch = realFetch;
    process.env.WHATSAPP_ACCESS_TOKEN = savedEnv.token;
    process.env.WHATSAPP_API_VERSION = savedEnv.version;
});

// Route the two request kinds to separate handlers and record every call.
function mockFetch({ metadata, download }) {
    globalThis.fetch = async (url, init) => {
        const isMetadata = String(url).startsWith("https://graph.facebook.com/");
        calls.push({ kind: isMetadata ? "metadata" : "download", hasSignal: Boolean(init?.signal) });
        return (isMetadata ? metadata : download)(url, init);
    };
}

const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const metadataFor = (overrides = {}) => () =>
    json({ url: MEDIA_URL, mime_type: "application/pdf", file_size: 1234, id: "media-1", ...overrides });

// A body delivered in fixed-size chunks, counting how many were pulled.
// highWaterMark 0: chunks are only produced when the code actually reads,
// so "pulled" counts real reads, not the stream pre-filling its queue.
function chunkedBody(totalChunks, chunkSize = MB, { headers = {} } = {}) {
    const state = { pulled: 0, cancelled: false };
    const stream = new ReadableStream({
        pull(controller) {
            if (state.pulled >= totalChunks) return controller.close();
            state.pulled += 1;
            controller.enqueue(new Uint8Array(chunkSize));
        },
        cancel() { state.cancelled = true; },
    }, { highWaterMark: 0 });
    return { response: new Response(stream, { status: 200, headers }), state };
}

// Keeps the process alive the way an open network connection would.
// AbortSignal.timeout() timers don't, so without this Node would end the
// test run before a mocked "hanging" request could time out.
function holdOpenUntil(signal) {
    const connection = setTimeout(() => {}, 60_000);
    signal.addEventListener("abort", () => clearTimeout(connection));
}

// A request that never answers until its abort signal fires.
const hangUntilAborted = (_url, init) => {
    holdOpenUntil(init.signal);
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
};

// Same order as the webhook route: metadata first, download only if accepted.
async function fetchLikeRoute(options = {}) {
    const mediaUrl = await getWhatsappMediaUrl("media-1", options.metadata);
    return downloadWhatsappMedia(mediaUrl, options.download);
}

describe("named timeouts", () => {
    test("both requests have a timeout constant", () => {
        assert.equal(MEDIA_METADATA_TIMEOUT_MS, 10_000);
        assert.equal(MEDIA_DOWNLOAD_TIMEOUT_MS, 30_000);
    });

    test("both fetch calls carry an abort signal", async () => {
        mockFetch({ metadata: metadataFor(), download: () => new Response(Buffer.from("%PDF-1.4")) });
        await fetchLikeRoute();

        assert.deepEqual(calls, [
            { kind: "metadata", hasSignal: true },
            { kind: "download", hasSignal: true },
        ]);
    });
});

describe("metadata pre-checks (before any bytes are downloaded)", () => {
    test("1. Meta reports more than 10 MB -> rejected, download never requested", async () => {
        mockFetch({ metadata: metadataFor({ file_size: MAX_FILE_SIZE + 1 }), download: () => assert.fail("download must not run") });

        await assert.rejects(fetchLikeRoute(), (error) => error instanceof MediaRejectedError && error.reason === "FILE_TOO_LARGE");
        assert.deepEqual(calls.map((c) => c.kind), ["metadata"]);
    });

    test("file_size given as a string is understood", async () => {
        mockFetch({ metadata: metadataFor({ file_size: String(100 * MB) }), download: () => assert.fail("download must not run") });
        await assert.rejects(fetchLikeRoute(), MediaRejectedError);
    });

    test("2. valid metadata -> download proceeds", async () => {
        mockFetch({ metadata: metadataFor({ file_size: 5 * MB }), download: () => new Response(Buffer.from("%PDF-1.4 body")) });

        const buffer = await fetchLikeRoute();
        assert.equal(buffer.toString(), "%PDF-1.4 body");
        assert.deepEqual(calls.map((c) => c.kind), ["metadata", "download"]);
    });

    test("7. unsupported MIME type in metadata -> rejected before download", async () => {
        for (const mimeType of ["image/webp", "application/x-msdownload", "text/html"]) {
            calls = [];
            mockFetch({ metadata: metadataFor({ mime_type: mimeType }), download: () => assert.fail("download must not run") });

            await assert.rejects(fetchLikeRoute(), (error) => error.reason === "UNSUPPORTED_FILE_TYPE", mimeType);
            assert.deepEqual(calls.map((c) => c.kind), ["metadata"]);
        }
    });

    test("MIME type with parameters is compared by type only", async () => {
        mockFetch({ metadata: metadataFor({ mime_type: "image/jpeg; charset=binary" }), download: () => new Response(Buffer.from([0xff, 0xd8, 0xff])) });
        const buffer = await fetchLikeRoute();
        assert.equal(buffer.length, 3);
    });

    test("missing size and type in metadata -> allowed; the download limit still applies", async () => {
        mockFetch({ metadata: metadataFor({ file_size: undefined, mime_type: undefined }), download: () => chunkedBody(11).response });
        await assert.rejects(fetchLikeRoute(), (error) => error.reason === "FILE_TOO_LARGE");
    });
});

describe("streaming byte limit", () => {
    test("3. body larger than 10 MB (no Content-Length) -> stopped just past the limit", async () => {
        const { response, state } = chunkedBody(1000); // would be ~1 GB if fully read
        mockFetch({ metadata: metadataFor(), download: () => response });

        await assert.rejects(fetchLikeRoute(), (error) => error instanceof MediaRejectedError && error.reason === "FILE_TOO_LARGE");
        assert.ok(state.pulled <= 12, `read ${state.pulled} MB before stopping`);
        assert.ok(state.cancelled, "the rest of the body must be cancelled");
    });

    test("Content-Length above 10 MB -> rejected without reading the body", async () => {
        const { response, state } = chunkedBody(20, MB, { headers: { "content-length": String(20 * MB) } });
        mockFetch({ metadata: metadataFor(), download: () => response });

        await assert.rejects(fetchLikeRoute(), (error) => error.reason === "FILE_TOO_LARGE");
        assert.equal(state.pulled, 0);
    });

    test("4. exactly 10 MB is accepted", async () => {
        const { response } = chunkedBody(10, MB, { headers: { "content-length": String(MAX_FILE_SIZE) } });
        mockFetch({ metadata: metadataFor({ file_size: MAX_FILE_SIZE }), download: () => response });

        const buffer = await fetchLikeRoute();
        assert.equal(buffer.length, MAX_FILE_SIZE);
    });

    test("10 MB + 1 byte is rejected", async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(MAX_FILE_SIZE));
                controller.enqueue(new Uint8Array(1));
                controller.close();
            },
        });
        mockFetch({ metadata: metadataFor(), download: () => new Response(stream) });

        await assert.rejects(fetchLikeRoute(), (error) => error.reason === "FILE_TOO_LARGE");
    });
});

describe("timeouts", () => {
    test("5. metadata request that never answers -> timed out", async () => {
        mockFetch({ metadata: hangUntilAborted, download: () => assert.fail("download must not run") });

        await assert.rejects(getWhatsappMediaUrl("media-1", { timeoutMs: 50 }), /metadata request timed out/);
    });

    test("6. download that never answers -> timed out", async () => {
        mockFetch({ metadata: metadataFor(), download: hangUntilAborted });

        await assert.rejects(downloadWhatsappMedia(MEDIA_URL, { timeoutMs: 50 }), /download timed out/);
    });

    test("6b. download that stalls halfway through the body -> timed out", async () => {
        mockFetch({
            metadata: metadataFor(),
            download: (_url, init) => {
                holdOpenUntil(init.signal);
                const stream = new ReadableStream({
                    start(controller) {
                        controller.enqueue(new Uint8Array(1024));
                        init.signal.addEventListener("abort", () => controller.error(init.signal.reason));
                    },
                });
                return new Response(stream);
            },
        });

        await assert.rejects(downloadWhatsappMedia(MEDIA_URL, { timeoutMs: 50 }), /download timed out/);
    });
});

describe("8. normal PDF / JPEG / PNG files still work", () => {
    const cases = [
        ["text-passport.pdf", "application/pdf"],
        ["passport-photo.jpg", "image/jpeg"],
        ["image-medical.png", "image/png"],
    ];

    for (const [file, mimeType] of cases) {
        test(`${mimeType} is downloaded unchanged`, async () => {
            const bytes = loadFile(file);
            mockFetch({
                metadata: metadataFor({ mime_type: mimeType, file_size: bytes.length }),
                download: () => new Response(bytes, { headers: { "content-length": String(bytes.length) } }),
            });

            const buffer = await fetchLikeRoute();
            assert.ok(buffer.equals(bytes));
        });
    }
});

describe("no secrets in error messages", () => {
    test("failed download mentions the status only, never the URL or token", async () => {
        mockFetch({ metadata: metadataFor(), download: () => new Response("forbidden body", { status: 403 }) });

        await assert.rejects(fetchLikeRoute(), (error) => {
            assert.equal(error.message, "Failed to download Whatsapp media: 403");
            assert.ok(!error.message.includes("fbsbx") && !error.message.includes(TOKEN));
            return true;
        });
    });

    test("timeout messages contain no URL or token", async () => {
        mockFetch({ metadata: metadataFor(), download: hangUntilAborted });

        await assert.rejects(downloadWhatsappMedia(MEDIA_URL, { timeoutMs: 20 }), (error) => {
            assert.ok(!error.message.includes("signature") && !error.message.includes(TOKEN));
            return true;
        });
    });

    test("metadata errors are capped in length", async () => {
        mockFetch({ metadata: () => new Response("x".repeat(5000), { status: 500 }), download: () => assert.fail() });

        await assert.rejects(fetchLikeRoute(), (error) => error.message.length < 400);
    });
});
