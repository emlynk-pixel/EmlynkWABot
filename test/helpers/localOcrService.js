// The OCR service (ocr-worker/) running inside this test process on a
// loopback port, with OCR_SERVICE_URL pointing at it: for tests that use the
// real text extraction instead of injecting extractText. Nothing on Google
// Cloud is involved. Needs the service's dependencies: npm run ocr:install.
import { createApp } from "../../ocr-worker/src/app.js";

const quiet = { log() {}, warn() {}, error() {} };

const server = await new Promise((resolve) => {
    const s = createApp({ log: quiet }).listen(0, "127.0.0.1", () => resolve(s));
});
// Neither the server nor its connections keep the test process alive.
server.unref();
server.keepAliveTimeout = 1_000;
server.on("connection", (socket) => socket.unref());

export const ocrServiceUrl = `http://127.0.0.1:${server.address().port}`;
process.env.OCR_SERVICE_URL = ocrServiceUrl;
