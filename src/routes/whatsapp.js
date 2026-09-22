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

    console.log(
        "Whatsapp webhook event",
         JSON.stringify(req.body,null,2)
    );

    //Heavy documments move to background queue and process

    return res.sendStatus(200);

  
});

export default router;