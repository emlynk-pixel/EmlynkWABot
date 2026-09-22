import express from "express";

const router = express.Router();

// Meta me GET request eka use karala ape webhook endpoint eka verify karanawa.

router.get("/webhook", (req,res) => {

    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    //check if the mode and token is correct

    if(
        mode === "subscribe" &&
        token === process.env.WHATSAPP_VERIFY_TOKEN
    )
    {
        console.log("Webhook verified successfully!");
        return res.status(200).send(challenge);

    }

    return res.sendStatus(403);
});

router.post("/webhook", (req,res) => {
    //Whatsapp message eka front end eka server eka data eka gannawa

    try{

        //META API message validation
        const entry = req.body?.entry?.[0];
        const changge = entry?.changes?.[0];
        const value = change?.value;

        if (!value?.message || value.message.length === 0){
            return res.sendStatus(200);
        }

        //Process first incomingg mmessage
        const message = value.message[0];
        const senderNumber = message.from;
        const messageId = message.id;

        //Message type

        const messageType = MessageChannel.type;


        let mediaId = null;
        let fileName = null;
        let mimeType = null;

        if(messaggeType === "document"){
            mediaId = message.doument?.id || null;
            fileName = message.doument?.name || null;
            mimeType = message.doumment?.mime_type || null;
        }

        

        console.log("WhatsApp Message Parsed:", {
            senderNumber,
            messageId,
            messageType,
            fileName,
            mediaId,
            mimeType
        });

        //Give quick success response for meta webhook
        return res.sendStatus(200);
    } catch(error){
        console.error("Whatsapp webhook parsing error:", error)
        return res.sendStatus(500);
    }

});

export default router;

        




        




