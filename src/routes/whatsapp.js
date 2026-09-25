import express from "express";
import crypto from "crypto";

// Middleware & Validation
import { verifyWhatsappSignature } from "../middleware/verifyWhatsAppSignature.js";
import { messageIdCache } from "../utils/messageIdempotency.js";
import { validateDocumentFile } from "../utils/fileValidation.js";
import { extractDocumentMetadata, SUPPORTED_MEDIA_MESSAGE_TYPES } from "../utils/whatsappMedia.js";
import { sha256Hex } from "../utils/fileChecksum.js";

// Services
import { getWhatsappMediaUrl, downloadWhatsappMedia, MediaRejectedError } from "../services/whatsappMediaService.js";
import { saveTemporaryFile } from "../services/temporaryStorageService.js";
import { createTemporaryDocumentRecord } from "../services/temporaryDataService.js";
import { classifyDocument } from "../services/documentClassificationService.js";
import { processDocument } from "../services/documentProcessingService.js";

// Logs never contain the sender's number, file names, storage paths, the
// media ID or the raw message ID. messageRef is a short one-way hash of the
// message ID, enough to connect the log lines of one message.
function messageRef(messageId) {
  return sha256Hex(Buffer.from(String(messageId))).slice(0, 12);
}

// WhatsApp sends the message time as Unix seconds (a string).
function messageReceivedAt(message) {
  const seconds = Number(message?.timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : undefined;
}

// Constant-time comparison that doesn't leak the expected value's length:
// both sides are hashed to the same size first.
function tokensMatch(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string") return false;
  const receivedHash = crypto.createHash("sha256").update(received).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(receivedHash, expectedHash);
}

// Download, validate, store and process one document/photo message.
// Errors that concern this file are logged and swallowed: the message is
// handled (Meta gets 200) even if the file was refused or processing failed.
async function handleMediaMessage({ message, ref, deps }) {
  const documentMetadata = extractDocumentMetadata(message);

  if (!documentMetadata.valid) {
    console.warn("Invalid Whatsapp document event", { messageRef: ref, reason: documentMetadata.reason });
    return;
  }

  const { mediaId, fileName, mimeType } = documentMetadata;

  try {
    const mediaUrl = await deps.getMediaUrl(mediaId);
    const fileBuffer = await deps.downloadMedia(mediaUrl);

    const fileValidation = validateDocumentFile({
      mimeType,
      fileSize: fileBuffer.length,
      fileBuffer,
    });

    if (!fileValidation.valid) {
      console.warn("WhatsApp document validation failed:", { messageRef: ref, reason: fileValidation.reason });
      return;
    }

    console.log("WhatsApp document validation passed", { messageRef: ref, mimeType, fileSize: fileBuffer.length });

    // Fingerprint of the exact bytes received, for duplicate detection.
    // Calculated once here and passed along; never logged.
    const fileSha256 = sha256Hex(fileBuffer);

    const temporaryFile = await deps.saveTemporary({ fileBuffer, mimeType });

    // Filename is only a hint. Content-based classification comes later.
    const classification = classifyDocument({ fileName, mimeType });

    console.log("Initial document classification", {
      messageRef: ref,
      documentType: classification.documentType,
      confidence: classification.confidence,
      source: classification.source,
    });

    const temporaryRecord = await deps.createTemporaryRecord({
      whatsappNumber: message.from,
      temporaryStoragePath: temporaryFile.storagePath,
      fileSha256,
    });

    console.log("Temporary document record created:", {
      messageRef: ref,
      temporaryId: temporaryRecord.temporaryId,
      processingStatus: temporaryRecord.processingStatus,
    });

    // OCR, classification, confidence, field extraction, identity checks,
    // storage. Never throws; failures are recorded on the temporary record.
    // The summary holds statuses and field names only, no document data.
    const { summary } = await deps.processDocument({
      temporaryId: temporaryRecord.temporaryId,
      whatsappNumber: message.from,
      fileName,
      mimeType,
      fileBuffer,
      fileSha256,
      temporaryStoragePath: temporaryFile.storagePath,
      receivedAt: messageReceivedAt(message),
      filenameClassification: classification,
    });

    console.log("Document processing result:", { messageRef: ref, temporaryId: temporaryRecord.temporaryId, ...summary });
  } catch (error) {
    // Too large or wrong type according to Meta's metadata or the download
    // itself: handled like any other failed validation.
    if (error instanceof MediaRejectedError) {
      console.warn("WhatsApp document validation failed:", { messageRef: ref, reason: error.reason });
      return;
    }

    // Covers download, upload and the DB insert. Only the error type is
    // logged: messages from the database can contain query values.
    console.error("WhatsApp document processing failed:", { messageRef: ref, errorType: error?.name ?? "Error" });
  }
}

// deps can be replaced in tests; production uses the real services.
export function createWhatsappRouter({
  messageCache = messageIdCache,
  getMediaUrl = getWhatsappMediaUrl,
  downloadMedia = downloadWhatsappMedia,
  saveTemporary = saveTemporaryFile,
  createTemporaryRecord = createTemporaryDocumentRecord,
  processDocument: processDocumentFn = processDocument,
} = {}) {
  const router = express.Router();
  const deps = { getMediaUrl, downloadMedia, saveTemporary, createTemporaryRecord, processDocument: processDocumentFn };

  /*
    GET /webhook
    Meta calls this once when the webhook URL is registered.
  */
  router.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN;

    // An unset env var must never match a missing token.
    if (expectedToken && mode === "subscribe" && tokensMatch(token, expectedToken) && typeof challenge === "string") {
      console.log("Webhook verified successfully!");
      // Plain text: the challenge is echoed back and must not be served as HTML.
      return res.status(200).type("text/plain").send(challenge);
    }

    return res.sendStatus(403);
  });

  /*
    POST /webhook
    Incoming WhatsApp events (messages, status updates, etc.).
  */
  router.post("/webhook", verifyWhatsappSignature, async (req, res) => {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    // Status updates and other events have no messages. Acknowledge and ignore them.
    if (!message) {
      return res.sendStatus(200);
    }

    const messageId = message.id;
    if (typeof messageId !== "string" || messageId.length === 0) {
      console.warn("WhatsApp message without an ID ignored");
      return res.sendStatus(200);
    }

    const ref = messageRef(messageId);

    // Claimed before any download or OCR: a retry or replay of the same
    // message, even one arriving while this one is still running, stops here.
    if (!messageCache.claim(messageId)) {
      console.log("Duplicate WhatsApp message ignored:", { messageRef: ref });
      return res.sendStatus(200);
    }

    try {
      // Only the first message in the event is handled for now.
      if (SUPPORTED_MEDIA_MESSAGE_TYPES.includes(message.type)) {
        await handleMediaMessage({ message, ref, deps });
      }

      console.log("WhatsApp Message Parsed:", { messageRef: ref, messageType: message.type });

      messageCache.complete(messageId);
      return res.sendStatus(200);
    } catch (error) {
      // Nothing was recorded for this message: let Meta's retry try again.
      messageCache.release(messageId);
      console.error("WhatsApp webhook parsing error:", { messageRef: ref, errorType: error?.name ?? "Error" });
      return res.sendStatus(500);
    }
  });

  return router;
}

export default createWhatsappRouter();
