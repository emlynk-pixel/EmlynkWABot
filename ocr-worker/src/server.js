import { accessSync } from "node:fs";
import path from "node:path";

import { createApp } from "./app.js";
import { LANGUAGE_DATA_PATH } from "./ocrService.js";

// Fail at startup, not on the first document, if the bundled English model
// is missing (e.g. dependencies installed without @tesseract.js-data/eng).
try {
    accessSync(path.join(LANGUAGE_DATA_PATH, "eng.traineddata.gz"));
} catch {
    console.error("Tesseract English language data not found; run npm install in ocr-worker/");
    process.exit(1);
}

const port = Number(process.env.PORT || 8080);
// Loopback unless told otherwise: run locally (npm start) the service is
// reachable from this machine only and needs no credentials. The container
// image sets HOST=0.0.0.0, where Cloud Run IAM guards every request.
const host = process.env.HOST || "127.0.0.1";

const server = createApp().listen(port, host, () => {
    console.log(`OCR service listening on http://${host}:${server.address().port}`);
});

// Cloud Run sends SIGTERM and stops the instance 10 s later. No new
// connection is accepted; running requests may finish until the deadline.
// The service keeps no state: a request cut off fails on the backend, whose
// queue processes that submission again later.
const SHUTDOWN_DEADLINE_MS = 9_000;
for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
        console.log("Shutting down:", { signal });
        server.close(() => process.exit(0));
        server.closeIdleConnections();
        setTimeout(() => process.exit(1), SHUTDOWN_DEADLINE_MS).unref();
    });
}
