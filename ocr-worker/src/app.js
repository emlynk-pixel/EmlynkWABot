// Internal HTTP API of the OCR service. Its only caller is the Emlynk
// backend's submission worker (src/services/ocrClient.js). On Cloud Run the
// service is private: IAM rejects any request without a valid Google
// identity token of an allowed caller before it reaches this code.
//
//   POST /process   body: the document bytes, Content-Type: its MIME type
//   200   the text-extraction result, exactly as extractDocumentText returns it
//   4xx/5xx   { success: false, error: { code, message } }
//
// Logs hold sizes, methods, reason codes and timings only: never document
// text, file names or anything read from the document.
import express from "express";

import { extractDocumentText, OcrResourceError } from "./ocrService.js";
import { safeErrorInfo } from "./utils/safeLog.js";

// The backend never accepts a larger file from WhatsApp (MAX_FILE_SIZE).
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

// OCR_BUSY is load, not a problem with the document: the caller tries again.
export const BUSY_RETRY_AFTER_SECONDS = 30;

const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

function sendError(res, status, code, message) {
    return res.status(status).json({ success: false, error: { code, message } });
}

export function createApp({ extractText = extractDocumentText, log = console } = {}) {
    const app = express();
    app.disable("x-powered-by");

    app.get("/health", (req, res) => res.json({ status: "OK" }));

    app.post("/process", express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES }), async (req, res) => {
        const mimeType = (req.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (!MIME_TYPE.test(mimeType)) {
            return sendError(res, 400, "INVALID_REQUEST", "Content-Type must be the document's MIME type");
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return sendError(res, 400, "INVALID_REQUEST", "The request body must be the document");
        }

        const bytes = req.body.length;
        const started = Date.now();
        try {
            const result = await extractText({ fileBuffer: req.body, mimeType });
            log.log("OCR done:", { mimeType, bytes, method: result.method, success: result.success, ms: Date.now() - started });
            return res.json(result);
        } catch (error) {
            const ms = Date.now() - started;
            if (error instanceof OcrResourceError) {
                log.warn("OCR refused:", { mimeType, bytes, reason: error.reason, ms });
                if (error.reason === "OCR_BUSY") {
                    res.set("Retry-After", String(BUSY_RETRY_AFTER_SECONDS));
                    return sendError(res, 503, error.reason, error.message);
                }
                return sendError(res, 422, error.reason, error.message);
            }
            log.error("OCR failed:", { mimeType, bytes, ms, ...safeErrorInfo(error) });
            return sendError(res, 500, "OCR_FAILED", "OCR processing failed");
        }
    });

    app.use((req, res) => sendError(res, 404, "NOT_FOUND", "Not found"));

    // Body errors (too large, aborted or malformed upload) and anything unexpected.
    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        if (error?.type === "entity.too.large") {
            return sendError(res, 413, "PAYLOAD_TOO_LARGE", "The document is larger than the service accepts");
        }
        if (error?.status >= 400 && error.status < 500) {
            return sendError(res, 400, "INVALID_REQUEST", "The request could not be read");
        }
        log.error("Request failed:", safeErrorInfo(error));
        return sendError(res, 500, "OCR_FAILED", "OCR processing failed");
    });

    return app;
}
