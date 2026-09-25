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
import { removeObject } from "../services/permanentStorageService.js";
import { createTemporaryDocumentRecord } from "../services/temporaryDataService.js";
import { classifyDocument } from "../services/documentClassificationService.js";
import { processDocument } from "../services/documentProcessingService.js";

// Logs never contain the sender's number, file names, storage paths, the
// media ID or the raw message ID. messageRef is a short one-way hash of the
// message ID, enough to connect the log lines of one message.
function messageRef(messageId) {
  return sha256Hex(Buffer.from(String(messageId))).slice(0, 12);
}

// Every message of a webhook delivery: entry[] -> changes[] -> value.messages[].
// Anything that isn't an array is treated as empty.
export function listMessages(body) {
  const list = (value) => (Array.isArray(value) ? value : []);
  return list(body?.entry).flatMap((entry) =>
    list(entry?.changes).flatMap((change) => list(change?.value?.messages)));
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

// A failure that happened before anything was recorded for the message
// (media lookup, download, temporary upload, record insert). The message
// must be retried: the route releases its claim and answers 500, so Meta
// sends it again.
export class RetryableMessageError extends Error {
  constructor(stage, cause) {
    super(`WhatsApp message not recorded (${stage})`);
    this.name = "RetryableMessageError";
    this.stage = stage;
    this.causeType = cause?.name ?? "Error";
  }
}

// Download, validate, store and process one document/photo message.
// - A file refused on purpose (type, size, content) is logged and counts as
//   handled: Meta gets 200 and doesn't send it again.
// - A failure before the temporary_data record exists throws
//   RetryableMessageError; an uploaded temporary object is removed first,
//   so nothing is left behind and the retry starts clean.
// - Once the record exists the message is handled: processing records its
//   own outcome (FAILED included) on that record.
async function handleMediaMessage({ message, ref, deps }) {
  const documentMetadata = extractDocumentMetadata(message);

  if (!documentMetadata.valid) {
    console.warn("Invalid Whatsapp document event", { messageRef: ref, reason: documentMetadata.reason });
    return;
  }

  const { mediaId, fileName, mimeType } = documentMetadata;
  let stage = "MEDIA_DOWNLOAD";
  let temporaryFile = null;
  let temporaryRecord = null;

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

    stage = "TEMPORARY_UPLOAD";
    temporaryFile = await deps.saveTemporary({ fileBuffer, mimeType });

    // Filename is only a hint. Content-based classification comes later.
    const classification = classifyDocument({ fileName, mimeType });

    console.log("Initial document classification", {
      messageRef: ref,
      documentType: classification.documentType,
      confidence: classification.confidence,
      source: classification.source,
    });

    stage = "RECORD_INSERT";
    temporaryRecord = await deps.createTemporaryRecord({
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

    // Only the error type is logged: messages from the database can contain
    // query values.
    if (temporaryRecord) {
      // Recorded: processing (which records FAILED itself) is not repeated.
      console.error("WhatsApp document processing failed:", { messageRef: ref, stage: "PROCESSING", errorType: error?.name ?? "Error" });
      return;
    }

    // Nothing recorded yet: remove an uploaded object so no unreferenced
    // file stays in temporary/, then let Meta retry the message.
    if (temporaryFile) {
      const cleanup = await deps.removeTemporary(temporaryFile.storagePath);
      if (!cleanup?.removed) {
        console.error("WhatsApp temporary file NOT removed after a failed record insert", { messageRef: ref, error: cleanup?.error ?? "unknown" });
      }
    }
    console.error("WhatsApp document not recorded; the message will be retried:", { messageRef: ref, stage, errorType: error?.name ?? "Error" });
    throw new RetryableMessageError(stage, error);
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
  removeTemporary = (storagePath) => removeObject(storagePath),
} = {}) {
  const router = express.Router();
  const deps = { getMediaUrl, downloadMedia, saveTemporary, createTemporaryRecord, processDocument: processDocumentFn, removeTemporary };

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
  // One message: claim its ID, handle it, and complete or release the claim.
  // Returns false when the message must be retried.
  async function handleMessage(message) {
    const messageId = message?.id;
    if (typeof messageId !== "string" || messageId.length === 0) {
      console.warn("WhatsApp message without an ID ignored");
      return true;
    }

    const ref = messageRef(messageId);

    // Claimed before any download or OCR: a retry or replay of the same
    // message, even one arriving while this one is still running, stops here.
    if (!messageCache.claim(messageId)) {
      console.log("Duplicate WhatsApp message ignored:", { messageRef: ref });
      return true;
    }

    try {
      if (SUPPORTED_MEDIA_MESSAGE_TYPES.includes(message.type)) {
        await handleMediaMessage({ message, ref, deps });
      }

      console.log("WhatsApp Message Parsed:", { messageRef: ref, messageType: message.type });

      messageCache.complete(messageId);
      return true;
    } catch (error) {
      // Nothing was recorded for this message: let Meta's retry try again.
      messageCache.release(messageId);
      console.error("WhatsApp webhook parsing error:", { messageRef: ref, errorType: error?.name ?? "Error" });
      return false;
    }
  }

  router.post("/webhook", verifyWhatsappSignature, async (req, res) => {
    // Meta can batch several entries, changes and messages in one delivery.
    // Each message is handled on its own, one after the other. Status
    // updates and other events have no messages: acknowledged and ignored.
    const messages = listMessages(req.body);

    let allHandled = true;
    for (const message of messages) {
      if (!(await handleMessage(message))) allHandled = false;
    }

    // 500 makes Meta resend the whole delivery; messages already handled are
    // skipped then by their claimed IDs, so only the failed ones run again.
    return res.sendStatus(allHandled ? 200 : 500);
  });

  return router;
}

export default createWhatsappRouter();
