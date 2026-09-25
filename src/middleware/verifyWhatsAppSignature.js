import crypto from "crypto";

// Reject webhook POSTs that weren't signed by Meta with our app secret.
export function verifyWhatsappSignature(req, res, next) {
    const signature = req.get("x-hub-signature-256");

    if (!process.env.META_APP_SECRET) {
        console.error("META_APP_SECRET is not configured");
        return res.sendStatus(500);
    }

    if (!signature) {
        console.warn("Missing webhook signature");
        return res.sendStatus(401);
    }

    // Set by express.json() in app.js. The HMAC must use the exact bytes Meta sent.
    if (!req.rawBody) {
        console.error("Raw webhook body is not available");
        return res.sendStatus(400);
    }

    const expectedSignature = "sha256=" +
        crypto.createHmac("sha256", process.env.META_APP_SECRET)
            .update(req.rawBody)
            .digest("hex");

    try {
        const receivedBuffer = Buffer.from(signature);
        const expectedBuffer = Buffer.from(expectedSignature);

        // timingSafeEqual throws on different lengths, so check first.
        if (receivedBuffer.length !== expectedBuffer.length) {
            console.warn("Invalid WhatsApp webhook signature");
            return res.sendStatus(401);
        }

        if (!crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
            console.warn("Invalid WhatsApp webhook signature");
            return res.sendStatus(401);
        }

        next();
    } catch (error) {
        console.error("WhatsApp webhook signature verification error:", { errorType: error?.name ?? "Error" });
        return res.sendStatus(401);
    }
}
