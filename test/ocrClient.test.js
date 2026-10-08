import { describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createOcrClient, isLoopbackUrl, OCR_REQUEST_TIMEOUT_MS } from "../src/services/ocrClient.js";
import {
    OCR_RESOURCE_REASONS,
    OcrRequestRejectedError,
    OcrResourceError,
    OcrServiceUnavailableError,
} from "../src/services/ocrContract.js";
import { describeFailure, OCR_FAILURE_CODES } from "../src/services/failureReason.js";
import { findEnvProblems } from "../src/config/env.js";

// The backend's OCR client against a stand-in OCR service. Synthetic data only.

// `handle(request)` returns { status, json | text, headers } or null (never answers).
async function withFakeService(handle, run) {
    const requests = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const request = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
        requests.push(request);
        const reply = await handle(request);
        if (!reply) return;
        const isText = reply.text !== undefined;
        res.writeHead(reply.status, { "content-type": isText ? "text/html" : "application/json", ...reply.headers });
        res.end(isText ? reply.text : JSON.stringify(reply.json));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
        await run({ url, requests });
    } finally {
        server.closeAllConnections();
        server.close();
    }
}

const RESULT = { success: true, text: "SRI LANKA POLICE\nPolice Clearance Certificate", method: "OCR", confidence: 88, thresholding: "OTSU", rotateAuto: false, upscaled: false, rotation: 0 };
const DOCUMENT = { fileBuffer: Buffer.from("%PDF-1.4 synthetic"), mimeType: "application/pdf" };
const errorReply = (status, code, headers) => ({ status, json: { success: false, error: { code, message: `x ${code}` } }, headers });

describe("request and result", () => {
    test("POST /process with the document bytes and its MIME type; the result comes back unchanged", async () => {
        await withFakeService(() => ({ status: 200, json: RESULT }), async ({ url, requests }) => {
            const result = await createOcrClient({ serviceUrl: url })(DOCUMENT);
            assert.deepEqual(result, RESULT);
            assert.equal(requests.length, 1);
            assert.equal(requests[0].method, "POST");
            assert.equal(requests[0].url, "/process");
            assert.equal(requests[0].headers["content-type"], "application/pdf");
            assert.ok(requests[0].body.equals(DOCUMENT.fileBuffer));
        });
    });

    test("a result without a document (e.g. PDF_PARSE_FAILED) is a result, not an error", async () => {
        const parseFailed = { success: false, text: "", method: "PDF_PARSE_FAILED" };
        await withFakeService(() => ({ status: 200, json: parseFailed }), async ({ url }) => {
            assert.deepEqual(await createOcrClient({ serviceUrl: url })(DOCUMENT), parseFailed);
        });
    });
});

describe("authentication (Cloud Run IAM)", () => {
    test("a loopback URL (the service run locally) gets no Authorization header", async () => {
        await withFakeService(() => ({ status: 200, json: RESULT }), async ({ url, requests }) => {
            await createOcrClient({ serviceUrl: url })(DOCUMENT);
            assert.equal(requests[0].headers.authorization, undefined);
        });
    });

    test("any other URL: every request carries the identity token, sent to the service URL", async () => {
        const sent = [];
        const fetch = async (target, init) => {
            sent.push({ target: String(target), headers: init.headers });
            return new Response(JSON.stringify(RESULT), { status: 200, headers: { "content-type": "application/json" } });
        };
        const client = createOcrClient({ serviceUrl: "https://ocr-worker-abc123-el.a.run.app", fetch, authHeaders: async () => ({ authorization: "Bearer test-identity-token" }) });
        await client(DOCUMENT);
        await client(DOCUMENT);
        assert.deepEqual(sent.map((s) => s.target), ["https://ocr-worker-abc123-el.a.run.app/process", "https://ocr-worker-abc123-el.a.run.app/process"]);
        for (const { headers } of sent) {
            assert.equal(headers.authorization, "Bearer test-identity-token");
            assert.equal(headers["content-type"], "application/pdf");
        }
    });

    test("no Google credentials -> no request is sent unauthenticated; the service counts as unavailable", async () => {
        const saved = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        process.env.GOOGLE_APPLICATION_CREDENTIALS = "does-not-exist/ocr-invoker-key.json";
        let fetched = false;
        try {
            const client = createOcrClient({ serviceUrl: "https://ocr-worker.invalid", fetch: async () => { fetched = true; } });
            await assert.rejects(client(DOCUMENT), (error) => error instanceof OcrServiceUnavailableError && /credentials unavailable/.test(error.message) && !error.message.includes("does-not-exist"));
        } finally {
            if (saved === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
            else process.env.GOOGLE_APPLICATION_CREDENTIALS = saved;
        }
        assert.equal(fetched, false);
    });

    test("a failing token lookup makes the service unavailable (retried later), and is tried again next time", async () => {
        let lookups = 0;
        const authHeaders = async () => { lookups += 1; throw new Error("metadata server unreachable"); };
        const client = createOcrClient({ serviceUrl: "https://ocr-worker.invalid", fetch: async () => assert.fail("no request without a token"), authHeaders });
        await assert.rejects(client(DOCUMENT), OcrServiceUnavailableError);
        await assert.rejects(client(DOCUMENT), OcrServiceUnavailableError);
        assert.equal(lookups, 2);
    });

    test("loopback detection", () => {
        for (const url of ["http://127.0.0.1:8080", "http://localhost:8080", "http://[::1]:8080"]) assert.equal(isLoopbackUrl(url), true, url);
        for (const url of ["https://ocr-worker-abc123-el.a.run.app", "http://10.0.0.5:8080", "http://127.0.0.1.example.com", "not a url", ""]) assert.equal(isLoopbackUrl(url), false, url);
    });

    test("startup check: OCR_SERVICE_URL required; plain http only to a loopback address", () => {
        const valid = {
            DATABASE_URL: "postgresql://x", SUPABASE_URL: "https://x.example", SUPABASE_SERVICE_ROLE_KEY: "x", SUPABASE_BUCKET: "x",
            META_APP_SECRET: "x", WHATSAPP_VERIFY_TOKEN: "x", WHATSAPP_ACCESS_TOKEN: "x", WHATSAPP_API_VERSION: "v21.0", APP_BASE_URL: "http://localhost:5173",
        };
        for (const url of ["https://ocr-worker-abc123-el.a.run.app", "http://127.0.0.1:8080", "http://localhost:8080"]) {
            assert.deepEqual(findEnvProblems({ ...valid, OCR_SERVICE_URL: url }), [], url);
        }
        assert.deepEqual(findEnvProblems(valid), ["OCR_SERVICE_URL is missing"]);
        assert.deepEqual(findEnvProblems({ ...valid, OCR_SERVICE_URL: "http://ocr.example.com" }), ["OCR_SERVICE_URL must use https:// unless it is a loopback address"]);
        assert.deepEqual(findEnvProblems({ ...valid, OCR_SERVICE_URL: "ocr worker" }), ["OCR_SERVICE_URL is not a valid URL"]);
    });
});

describe("errors across the HTTP boundary", () => {
    test("a refused document (422) is the same OcrResourceError as before: final, reason and message kept", async () => {
        const documentReasons = OCR_RESOURCE_REASONS.filter((reason) => reason !== "OCR_BUSY");
        assert.deepEqual([...OCR_RESOURCE_REASONS].sort(), [...OCR_FAILURE_CODES].sort(), "every code the dashboard knows");
        for (const reason of documentReasons) {
            await withFakeService(() => errorReply(422, reason), async ({ url }) => {
                await assert.rejects(createOcrClient({ serviceUrl: url })(DOCUMENT), (error) =>
                    error instanceof OcrResourceError && error.reason === reason && error.message === `OCR resource limit: ${reason}`);
            });
        }
    });

    test("OCR_BUSY (503) is load: retried later, and still shows as OCR_BUSY if finally given up", async () => {
        await withFakeService(() => errorReply(503, "OCR_BUSY", { "retry-after": "30" }), async ({ url }) => {
            const error = await createOcrClient({ serviceUrl: url })(DOCUMENT).catch((e) => e);
            assert.ok(error instanceof OcrServiceUnavailableError);
            assert.equal(error.message, "OCR resource limit: OCR_BUSY");
            assert.equal(describeFailure({ stage: "TEXT_EXTRACTION", error: error.message }).code, "OCR_BUSY");
        });
    });

    test("service problems are retried later, never recorded against the document", async () => {
        const replies = [
            errorReply(401, "UNAUTHENTICATED"), { status: 403, text: "<html>Forbidden</html>" }, { status: 404, text: "Not Found" },
            { status: 429, text: "Rate exceeded." }, errorReply(500, "OCR_FAILED"), { status: 502, text: "Bad Gateway" },
            { status: 503, text: "Service Unavailable" }, { status: 504, text: "upstream request timeout" },
            { status: 200, text: "<html>not the OCR service</html>" }, { status: 200, json: { success: true } },
        ];
        for (const reply of replies) {
            await withFakeService(() => reply, async ({ url }) => {
                await assert.rejects(createOcrClient({ serviceUrl: url })(DOCUMENT), OcrServiceUnavailableError, `HTTP ${reply.status}`);
            });
        }
    });

    test("an unusable request (400, 413) is final: sending it again can't help", async () => {
        for (const [status, code] of [[400, "INVALID_REQUEST"], [413, "PAYLOAD_TOO_LARGE"]]) {
            await withFakeService(() => errorReply(status, code), async ({ url }) => {
                await assert.rejects(createOcrClient({ serviceUrl: url })(DOCUMENT), (error) =>
                    error instanceof OcrRequestRejectedError && error.message.includes(String(status)) && error.message.includes(code));
            });
        }
    });

    test("no answer in time -> unavailable (timed out); the request is abandoned", async () => {
        await withFakeService(() => null, async ({ url }) => {
            const started = Date.now();
            await assert.rejects(createOcrClient({ serviceUrl: url, timeoutMs: 100 })(DOCUMENT), (error) =>
                error instanceof OcrServiceUnavailableError && error.message === "OCR service timed out");
            assert.ok(Date.now() - started < 5_000);
        });
    });

    test("unreachable or not configured -> unavailable", async () => {
        const closed = await new Promise((resolve) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
        await assert.rejects(createOcrClient({ serviceUrl: `http://127.0.0.1:${closed}` })(DOCUMENT), (error) =>
            error instanceof OcrServiceUnavailableError && error.message === "OCR service unreachable");
        await assert.rejects(createOcrClient({ serviceUrl: "" })(DOCUMENT), (error) =>
            error instanceof OcrServiceUnavailableError && /OCR_SERVICE_URL/.test(error.message));
    });

    test("error messages hold statuses and codes only: never the token, a response body or document data", async () => {
        const authHeaders = async () => ({ authorization: "Bearer secret-identity-token" });
        const replies = [{ status: 500, text: "stack trace near N1234567" }, errorReply(403, "FORBIDDEN"), { status: 422, json: { error: { code: "N1234567 leaked", message: "N1234567" } } }];
        for (const reply of replies) {
            const fetch = async (target, init) => new Response(reply.text ?? JSON.stringify(reply.json), { status: reply.status });
            const error = await createOcrClient({ serviceUrl: "https://ocr.invalid", fetch, authHeaders })(DOCUMENT).catch((e) => e);
            for (const value of ["secret-identity-token", "N1234567", "stack trace"]) assert.ok(!error.message.includes(value), `${reply.status}: ${error.message}`);
        }
    });

    test("the request timeout covers the service's worst case (60 s wait + 120 s OCR) with room for a cold start", () => {
        assert.ok(OCR_REQUEST_TIMEOUT_MS > 180_000 + 30_000);
    });
});
