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

const router = express.Router();

/*
GET /webhook
 Verification endpoint for Meta WhatsApp Webhook
 */
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  // Check if the mode and token are correct
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("Webhook verified successfully!");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

/*
  POST /webhook
  Endpoint to receive and process incoming WhatsApp webhook events
 */
router.post("/webhook", verifyWhatsappSignature, async (req, res) => {
  try {
    // Meta webhook payload eken main values tika gannawa
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // FIX: Meta payload eke property eka "messages"
    if (!value?.messages || value.messages.length === 0) {
      return res.sendStatus(200);
    }

    // First incoming message eka process karanawa
    const message = value.messages[0];

    // Sender WhatsApp number
    const senderNumber = message.from;

    // Unique WhatsApp message ID
    const messageId = message.id;

    // FIX: Message type eka message object eken gannawa
    const messageType = message.type;

    let mediaId = null;
    let fileName = null;
    let mimeType = null;

    // Ignore duplicate messages
    if (isMessageProcessed(messageId)) {
      console.log("Duplicate WhatsApp message ignored:", messageId);
      return res.sendStatus(200);
    }

    // Process document messages
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

      // Valid document metadata
      mediaId = documentMetadata.mediaId;
      fileName = documentMetadata.fileName;
      mimeType = documentMetadata.mimeType;

      try {
        const mediaUrl = await getWhatsappMediaUrl(mediaId);
        const fileBuffer = await downloadWhatsappMedia(mediaUrl);

        // File Validation
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

        // Save temporary storage
        const temporaryFile = await saveTemporaryFile({
          fileBuffer,
          originalFileName: fileName,
          mimeType,
        });

        const temporaryRecord = await createTemporaryDocumentRecord({
          whatsappNumber: senderNumber,
          temporaryStoragePath: temporaryFile.storagePath,
        });

        console.log("Temporary document record created:", {
          temporaryId: temporaryRecord.temporaryId,
          whatsappNumber: temporaryRecord.whatsappNumber,
          documentType: temporaryRecord.documentType,
          processingStatus: temporaryRecord.processingStatus,
          temporaryStoragePath: temporaryRecord.temporaryStoragePath,
        });

        console.log("WhatsApp Document temmporary stored:", {
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
      } catch (error) {
        console.error("WhatsApp media download failed:", error.message);
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

    // Meta webhook ekata quick success response ekak denawa
    return res.sendStatus(200);
  } catch (error) {
    console.error("WhatsApp webhook parsing error:", error);
    return res.sendStatus(500);
  }
});

export default router;
