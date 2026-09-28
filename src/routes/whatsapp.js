import express from "express";
import crypto from "crypto";

// Middleware & Validation
import { verifyWhatsappSignature } from "../middleware/verifyWhatsAppSignature.js";
import { messageIdCache, MESSAGE_STATE } from "../utils/messageIdempotency.js";
import { validateDocumentFile } from "../utils/fileValidation.js";
import { extractDocumentMetadata, SUPPORTED_MEDIA_MESSAGE_TYPES } from "../utils/whatsappMedia.js";
import { sha256Hex } from "../utils/fileChecksum.js";

// Services
import { getWhatsappMediaUrl, downloadWhatsappMedia, MediaRejectedError } from "../services/whatsappMediaService.js";
import { saveTemporaryFile } from "../services/temporaryStorageService.js";
import { removeObject } from "../services/permanentStorageService.js";
import { createTemporaryDocumentRecord } from "../services/temporaryDataService.js";
import { notifySubmissionQueued } from "../services/submissionQueue.js";

// Logs never contain the sender's number, file names, storage paths, the
// media ID or the raw message ID. messageRef is a short one-way hash of the
// message ID, enough to connect the log lines of one message.
function messageRef(messageId) {
  return sha256Hex(Buffer.from(String(messageId))).slice(0, 12);
}

// How long a second delivery of a message waits for the first one, still
// running in this process, to record it (M1). Well below Meta's webhook
// timeout; if the first isn't done by then, the second answers 500 and Meta
// sends it again later.
export const DUPLICATE_WAIT_MS = 10_000;

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

// Download, validate and store one document/photo message, then hand it to
// background processing (M1). The webhook does not wait for OCR, identity
// checks or storage placement: the committed temporary_data row (status
// TEMPORARY_STORED) plus the file in temporary/ is the durable job, and the
// worker (src/services/submissionQueue.js) processes it.
// - A file refused on purpose (type, size, content) is logged and counts as
//   handled: Meta gets 200 and doesn't send it again.
// - A failure before the temporary_data record exists throws
//   RetryableMessageError; an uploaded temporary object is removed first,
//   so nothing is left behind and the retry starts clean.
// - The same WhatsApp message recorded twice (e.g. redelivered after a
//   restart) is refused by the unique message ID: the second upload is
//   removed and the message counts as handled.
// - Once the record exists the message is handled.
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

    stage = "RECORD_INSERT";
    const created = await deps.createTemporaryRecord({
      whatsappNumber: message.from,
      temporaryStoragePath: temporaryFile.storagePath,
      fileSha256,
      messageId: message.id,
      originalFilename: fileName ?? null,
      receivedAt: messageReceivedAt(message) ?? null,
    });

    if (created?.duplicate) {
      // Already recorded (redelivery): keep the first, drop this upload.
      const cleanup = await deps.removeTemporary(temporaryFile.storagePath);
      if (!cleanup?.removed) {
        console.error("WhatsApp duplicate upload NOT removed", { messageRef: ref, error: cleanup?.error ?? "unknown" });
      }
      console.log("Duplicate WhatsApp message already recorded:", { messageRef: ref });
      return;
    }
    temporaryRecord = created;

    console.log("Submission recorded for background processing:", {
      messageRef: ref,
      temporaryId: temporaryRecord.temporaryId,
      processingStatus: temporaryRecord.processingStatus,
    });

    // Durable now: wake the worker. Processing (OCR, identity, storage)
    // happens there; the webhook does not wait for it.
    try {
      deps.onRecorded(temporaryRecord);
    } catch (notifyError) {
      // The row is committed; the worker's poll picks it up anyway.
      console.error("Background worker not notified (it will poll):", { messageRef: ref, errorType: notifyError?.name ?? "Error" });
    }
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
      // Recorded: the worker processes it; nothing is repeated here.
      console.error("WhatsApp message handling failed after the submission was recorded:", { messageRef: ref, errorType: error?.name ?? "Error" });
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
  removeTemporary = (storagePath) => removeObject(storagePath),
  onRecorded = () => notifySubmissionQueued(),
  duplicateWaitMs = DUPLICATE_WAIT_MS,
} = {}) {
  const router = express.Router();
  const deps = { getMediaUrl, downloadMedia, saveTemporary, createTemporaryRecord, removeTemporary, onRecorded };
  // Message ID -> the promise of its handling while it runs in this process.
  const inFlight = new Map();

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
      if (!/^[a-zA-Z0-9_\-\.\:\+]+$/.test(challenge)) {
        return res.status(400).type("text/plain").send("Invalid challenge format");
      }
      console.log("Webhook verified successfully!");
      // Plain text: the challenge is echoed back and must not be served as HTML.
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(String(challenge));
    }

    return res.sendStatus(403);
  });

  /*
    POST /webhook
    Incoming WhatsApp events (messages, status updates, etc.).
  */
  // One message: claim its ID, handle it, and complete or release the claim.
  // Returns false when the message must be retried (the delivery gets 500).
  async function handleClaimedMessage(message, messageId, ref) {
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

  // Claimed before any download: a replay or retry of the same message is
  // never handled twice at once in this process. It is only acknowledged
  // (true) once the message has been handled: recorded durably, refused on
  // purpose, or found already recorded (unique message ID). While the first
  // delivery is still running, a second one waits for it (duplicateWaitMs):
  // if the first fails, the second takes over; if it is still running, the
  // second answers 500 so Meta retries. Across processes and restarts the
  // unique message_id decides (createTemporaryDocumentRecord).
  async function handleMessage(message) {
    const messageId = message?.id;
    if (typeof messageId !== "string" || messageId.length === 0) {
      console.warn("WhatsApp message without an ID ignored");
      return true;
    }

    // AUDIT-002: a message with no sender cannot be recorded or attributed.
    // Acknowledge it (200) so Meta doesn't retry it indefinitely.
    if (typeof message?.from !== "string" || message.from.length === 0) {
      console.warn("WhatsApp message without a sender ignored", { messageRef: messageRef(messageId) });
      return true;
    }

    const ref = messageRef(messageId);
    const deadline = Date.now() + duplicateWaitMs;

    for (;;) {
      if (messageCache.claim(messageId)) {
        const handling = handleClaimedMessage(message, messageId, ref);
        inFlight.set(messageId, handling);
        try {
          return await handling;
        } finally {
          inFlight.delete(messageId);
        }
      }

      if (messageCache.stateOf(messageId) === MESSAGE_STATE.PROCESSED) {
        console.log("Duplicate WhatsApp message ignored (already handled):", { messageRef: ref });
        return true;
      }

      const running = inFlight.get(messageId);
      const remaining = deadline - Date.now();
      if (!running || remaining <= 0) {
        console.warn("Duplicate WhatsApp message arrived while the first delivery is still being recorded; Meta will retry it:", { messageRef: ref });
        return false;
      }
      let timer;
      await Promise.race([running, new Promise((resolve) => { timer = setTimeout(resolve, remaining); })]);
      clearTimeout(timer);
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
