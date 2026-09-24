import express from "express";

// Middleware & Validation
import { verifyWhatsappSignature } from "../middleware/verifyWhatsAppSignature.js";
import { isMessageProcessed, markMessageAsProcessed } from "../utils/messageIdempotency.js";
import { validateDocumentFile } from "../utils/fileValidation.js";
import { extractDocumentMetadata } from "../utils/whatsappMedia.js";

// Services
import { getWhatsappMediaUrl, downloadWhatsappMedia } from "../services/whatsappMediaService.js";
import { saveTemporaryFile } from "../services/temporaryStorageService.js";
import { createTemporaryDocumentRecord } from "../services/temporaryDataService.js";
import { classifyDocument } from "../services/documentClassificationService.js";
import { extractDocumentText } from "../services/ocrService.js";

const router = express.Router();

/*
  GET /webhook
  Meta calls this once when the webhook URL is registered.
*/
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN;

  // Without the expectedToken check, an unset env var would match a missing token.
  if (expectedToken && mode === "subscribe" && token === expectedToken) {
    console.log("Webhook verified successfully!");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

/*
  POST /webhook
  Incoming WhatsApp events (messages, status updates, etc.).
*/
router.post("/webhook", verifyWhatsappSignature, async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Status updates and other events have no messages. Acknowledge and ignore them.
    if (!value?.messages || value.messages.length === 0) {
      return res.sendStatus(200);
    }

    // Only the first message in the event is handled for now.
    const message = value.messages[0];
    const senderNumber = message.from;
    const messageId = message.id;
    const messageType = message.type;

    let mediaId = null;
    let fileName = null;
    let mimeType = null;

    // Meta may deliver the same event more than once.
    if (isMessageProcessed(messageId)) {
      console.log("Duplicate WhatsApp message ignored:", messageId);
      return res.sendStatus(200);
    }

    if (messageType === "document") {
      const documentMetadata = extractDocumentMetadata(message);

      if (!documentMetadata.valid) {
        console.warn("Invalid Whatsapp document event", {
          messageId,
          senderNumber,
          reason: documentMetadata.reason,
        });
        return res.sendStatus(200);
      }

      mediaId = documentMetadata.mediaId;
      fileName = documentMetadata.fileName;
      mimeType = documentMetadata.mimeType;

      // Failures here still return 200 so Meta doesn't keep retrying the same message.
      try {
        const mediaUrl = await getWhatsappMediaUrl(mediaId);
        const fileBuffer = await downloadWhatsappMedia(mediaUrl);

        const fileValidation = validateDocumentFile({
          mimeType,
          fileSize: fileBuffer.length,
        });

        if (!fileValidation.valid) {
          console.warn("WhatsApp document validation failed:", {
            messageId,
            reason: fileValidation.reason,
          });
          return res.sendStatus(200);
        }

        console.log("WhatsApp document validation passed", {
          messageId,
          fileName,
          mimeType,
          fileSize: fileBuffer.length,
        });

        const temporaryFile = await saveTemporaryFile({
          fileBuffer,
          originalFileName: fileName,
          mimeType,
        });

        // Filename is only a hint. Content-based classification comes later.
        const classification = classifyDocument({
          fileName,
          mimeType,
        });

        console.log("Initial document classification", {
          messageId,
          documentType: classification.documentType,
          confidence: classification.confidence,
          source: classification.source,
        });

        const temporaryRecord = await createTemporaryDocumentRecord({
          whatsappNumber: senderNumber,
          temporaryStoragePath: temporaryFile.storagePath,
          documentType: classification.documentType,
        });

        console.log("Temporary document record created:", {
          temporaryId: temporaryRecord.temporaryId,
          whatsappNumber: temporaryRecord.whatsappNumber,
          documentType: temporaryRecord.documentType,
          processingStatus: temporaryRecord.processingStatus,
          temporaryStoragePath: temporaryRecord.temporaryStoragePath,
        });

        console.log("WhatsApp document temporarily stored:", {
          messageId,
          storedFileName: temporaryFile.storedFileName,
          storagePath: temporaryFile.storagePath,
        });

        console.log("WhatsApp media downloaded:", {
          messageId,
          fileName,
          mimeType,
          fileSize: fileBuffer.length,
        });

        // Only the length is logged. The text itself may contain passport details.
        const textExtraction = await extractDocumentText({
          fileBuffer,
          mimeType,
        });

        console.log("Document text extraction result:", {
          messageId,
          success: textExtraction.success,
          method: textExtraction.method,
          textLength: textExtraction.text.length || 0,
          confidence: textExtraction.confidence ?? null,
        });
      } catch (error) {
        // Covers download, upload, DB insert and OCR, not only the download.
        console.error("WhatsApp document processing failed:", {
          messageId,
          error: error.message,
        });
        return res.sendStatus(200);
      }
    }

    console.log("WhatsApp Message Parsed:", {
      senderNumber,
      messageId,
      messageType,
      fileName,
      mediaId,
      mimeType,
    });

    markMessageAsProcessed(messageId);

    return res.sendStatus(200);
  } catch (error) {
    console.error("WhatsApp webhook parsing error:", error);
    return res.sendStatus(500);
  }
});

export default router;
