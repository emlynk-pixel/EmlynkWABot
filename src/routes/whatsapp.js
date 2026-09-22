import express from "express";

const router = express.Router();

// Meta me GET request eka use karala ape webhook endpoint eka verify karanawa
router.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    // Check if the mode and token are correct
    if (
        mode === "subscribe" &&
        token === process.env.WHATSAPP_VERIFY_TOKEN
    ) {
        console.log("Webhook verified successfully!");
        return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
});

router.post("/webhook", (req, res) => {
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

        // FIX: messageType spelling saha document property names
        if (messageType === "document") {
            // Media download karanna passe use karana Meta media ID eka
            mediaId = message.document?.id || null;

            // Original uploaded filename eka
            fileName = message.document?.filename || null;

            // Example: application/pdf
            mimeType = message.document?.mime_type || null;
        }

        console.log("WhatsApp Message Parsed:", {
            senderNumber,
            messageId,
            messageType,
            fileName,
            mediaId,
            mimeType
        });

        // Meta webhook ekata quick success response ekak denawa
        return res.sendStatus(200);

    } catch (error) {
        console.error("WhatsApp webhook parsing error:", error);
        return res.sendStatus(500);
    }
});

export default router;