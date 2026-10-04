import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createApp, MAX_DOCUMENT_BYTES, BUSY_RETRY_AFTER_SECONDS } from "../src/app.js";
import { extractDocumentText, OcrResourceError, TEXT_EXTRACTION_METHODS } from "../src/ocrService.js";

// The HTTP API of the OCR service. Synthetic data only.
const loadFile = (name) => readFileSync(new URL(`./fixtures/files/${name}`, import.meta.url));

function pngHeader(width, height) {
    const buffer = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
    buffer.writeUInt32BE(13, 8);
    buffer.write("IHDR", 12, "ascii");
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer;
}

async function withService(options, run) {
    const logs = [];
    const log = Object.fromEntries(["log", "warn", "error"].map((level) => [level, (...args) => logs.push([level, ...args])]));
    const server = await new Promise((resolve) => {
        const s = createApp({ log, ...options }).listen(0, "127.0.0.1", () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (body, contentType) => fetch(`${base}/process`, {
        method: "POST",
        headers: contentType ? { "content-type": contentType } : {},
        body,
    });
    try {
        await run({ base, post, logs });
    } finally {
        server.close();
        server.closeAllConnections();
    }
}

const fakeExtraction = (result) => {
    const calls = [];
    const extractText = async (input) => {
        calls.push(input);
        return typeof result === "function" ? result(input) : result;
    };
    return { extractText, calls };
};

describe("POST /process: the extraction result, unchanged", () => {
    test("a text PDF is read by the real extraction; the response is exactly its result", async () => {
        const fileBuffer = loadFile("text-passport.pdf");
        await withService({}, async ({ post }) => {
            const response = await post(fileBuffer, "application/pdf");
            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.method, TEXT_EXTRACTION_METHODS.PDF_TEXT);
            assert.equal(body.success, true);
            assert.match(body.text, /Passport No N1234567/);
            assert.deepEqual(body, await extractDocumentText({ fileBuffer, mimeType: "application/pdf" }));
        });
    });

    test("every optional field of an OCR result survives the round trip", async () => {
        const result = {
            success: true, text: "line one\nline two", method: "PDF_OCR", confidence: 87.25,
            pagesProcessed: 2, totalPages: 5, thresholding: ["OTSU", "SAUVOLA"], rotateAuto: [false, true],
        };
        const image = { success: true, text: "x", method: "OCR", confidence: 54, thresholding: "SAUVOLA", rotateAuto: true, upscaled: true, rotation: 270 };
        for (const expected of [result, image]) {
            await withService(fakeExtraction(expected), async ({ post }) => {
                assert.deepEqual(await (await post(Buffer.from("doc"), "image/jpeg")).json(), expected);
            });
        }
    });

    test("the extraction gets the exact bytes and the MIME type from Content-Type (parameters ignored)", async () => {
        const fake = fakeExtraction({ success: true, text: "t", method: "OCR", confidence: 90 });
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 0]);
        await withService(fake, async ({ post }) => {
            assert.equal((await post(bytes, "Image/PNG; charset=binary")).status, 200);
        });
        assert.equal(fake.calls.length, 1);
        assert.equal(fake.calls[0].mimeType, "image/png");
        assert.ok(fake.calls[0].fileBuffer.equals(bytes));
    });

    test("an unsupported type is not an error: UNSUPPORTED_DOCUMENT_TYPE, as before", async () => {
        await withService({}, async ({ post }) => {
            const response = await post(Buffer.from("x"), "text/plain");
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { success: false, text: "", method: TEXT_EXTRACTION_METHODS.UNSUPPORTED_DOCUMENT_TYPE });
        });
    });
});

describe("POST /process: errors", () => {
    test("a malformed request is refused with 400 before any extraction", async () => {
        const fake = fakeExtraction({ success: true, text: "t", method: "OCR" });
        await withService(fake, async ({ post }) => {
            for (const [body, contentType] of [[Buffer.from("doc"), null], [Buffer.from("doc"), "not a type"], [Buffer.alloc(0), "application/pdf"]]) {
                const response = await post(body, contentType);
                assert.equal(response.status, 400, String(contentType));
                assert.equal((await response.json()).error.code, "INVALID_REQUEST");
            }
        });
        assert.equal(fake.calls.length, 0);
    });

    test("a refused document keeps its reason: 422 with the code and the reason-only message", async () => {
        for (const reason of ["IMAGE_TOO_LARGE", "IMAGE_UNREADABLE", "PDF_TOO_MANY_PAGES", "PDF_PAGE_TOO_LARGE", "OCR_TIMEOUT"]) {
            await withService({ extractText: async () => { throw new OcrResourceError(reason); } }, async ({ post }) => {
                const response = await post(Buffer.from("doc"), "image/jpeg");
                assert.equal(response.status, 422, reason);
                assert.deepEqual(await response.json(), { success: false, error: { code: reason, message: `OCR resource limit: ${reason}` } });
            });
        }
    });

    test("real refusals: an oversized image and a PDF with too many pages", async () => {
        await withService({}, async ({ post }) => {
            assert.equal((await (await post(pngHeader(30_000, 30_000), "image/png")).json()).error.code, "IMAGE_TOO_LARGE");
            assert.equal((await (await post(loadFile("many-pages.pdf"), "application/pdf")).json()).error.code, "PDF_TOO_MANY_PAGES");
        });
    });

    test("OCR_BUSY is load, not the document: 503 with Retry-After", async () => {
        await withService({ extractText: async () => { throw new OcrResourceError("OCR_BUSY"); } }, async ({ post }) => {
            const response = await post(Buffer.from("doc"), "image/jpeg");
            assert.equal(response.status, 503);
            assert.equal(response.headers.get("retry-after"), String(BUSY_RETRY_AFTER_SECONDS));
            assert.equal((await response.json()).error.code, "OCR_BUSY");
        });
    });

    test("an unexpected failure: 500 OCR_FAILED; its message is neither sent nor logged with data", async () => {
        const extractText = async () => { throw new Error('Tesseract failed on "N1234567" for 94771234567'); };
        await withService({ extractText }, async ({ post, logs }) => {
            const response = await post(Buffer.from("doc"), "image/jpeg");
            assert.equal(response.status, 500);
            assert.deepEqual(await response.json(), { success: false, error: { code: "OCR_FAILED", message: "OCR processing failed" } });
            const logged = JSON.stringify(logs);
            assert.match(logged, /OCR failed/);
            for (const value of ["N1234567", "94771234567"]) assert.ok(!logged.includes(value), `log contains ${value}`);
        });
    });

    test("a document over the size limit is refused with 413 before any extraction", async () => {
        assert.equal(MAX_DOCUMENT_BYTES, 10 * 1024 * 1024, "the backend's MAX_FILE_SIZE");
        const fake = fakeExtraction({ success: true, text: "t", method: "OCR" });
        await withService(fake, async ({ post }) => {
            const response = await post(Buffer.alloc(MAX_DOCUMENT_BYTES + 1), "image/jpeg");
            assert.equal(response.status, 413);
            assert.equal((await response.json()).error.code, "PAYLOAD_TOO_LARGE");
            assert.equal((await post(Buffer.alloc(MAX_DOCUMENT_BYTES), "image/jpeg")).status, 200, "exactly at the limit is accepted");
        });
        assert.equal(fake.calls.length, 1);
    });

    test("unknown paths and methods -> 404", async () => {
        await withService({}, async ({ base }) => {
            assert.equal((await fetch(`${base}/process`)).status, 404);
            assert.equal((await fetch(`${base}/other`, { method: "POST" })).status, 404);
        });
    });
});

describe("logging and health", () => {
    test("a successful request logs sizes, method and timing, never the text read", async () => {
        const fake = fakeExtraction({ success: true, text: "PASSPORT N1234567 KAMAL PERERA", method: "OCR", confidence: 91 });
        await withService(fake, async ({ post, logs }) => {
            await post(Buffer.from("doc"), "image/jpeg");
            const logged = JSON.stringify(logs);
            assert.match(logged, /OCR done/);
            for (const value of ["N1234567", "KAMAL", "PERERA"]) assert.ok(!logged.includes(value), `log contains ${value}`);
        });
    });

    test("GET /health", async () => {
        await withService({}, async ({ base }) => {
            const response = await fetch(`${base}/health`);
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { status: "OK" });
        });
    });
});

describe("server process", () => {
    const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));

    function startServer() {
        const child = spawn(process.execPath, [serverPath], { env: { ...process.env, PORT: "0", HOST: "127.0.0.1" } });
        const port = new Promise((resolve, reject) => {
            let out = "";
            child.stdout.on("data", (chunk) => {
                out += chunk;
                const match = out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
                if (match) resolve(Number(match[1]));
            });
            child.once("exit", (code) => reject(new Error(`server exited early (${code})`)));
        });
        return { child, port };
    }

    test("starts on the loopback address with the bundled language data and answers /health", async () => {
        const { child, port } = startServer();
        try {
            const response = await fetch(`http://127.0.0.1:${await port}/health`);
            assert.equal(response.status, 200);
        } finally {
            child.kill();
        }
    });

    test("SIGTERM: stops accepting work and exits cleanly (Cloud Run shutdown)", { skip: process.platform === "win32" && "POSIX signals only" }, async () => {
        const { child, port } = startServer();
        await port;
        const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
        child.kill("SIGTERM");
        assert.equal(await exited, 0);
    });
});
