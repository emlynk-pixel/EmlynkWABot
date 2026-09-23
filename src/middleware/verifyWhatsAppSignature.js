import crypto from "crypto";

export function verifyWhatsappSignature (req, res, next){

    //Meta signature verification

    const signature = req.get("x-hub-signature-256");

    if(!process.env.META_APP_SECRET){
        console.error("META_APP_SECRET is not configured!");

        return res.Status(500);
    }

    if(!signature){
        console.warn("Missing webhook signature!");

        return res.sendStatus(401);
        
    }

    if(!req.rawBody){
        console.error("Raw webhook body is not available");

        return res.sendStatus(400);

        
    }
    //calculate signature from raw body

    const expectedSignature = "sha256=" +

         crypto.createHmac("sha256", process.env.META_APP_SECRET)
         .update(req.rawBody)
         .digest("hex");

         try{
            const receivedBuffer = Buffer.from(signature);
            const expectedBuffer = Buffer.from(expectedSignature);

            //If length is different timingSafeEqual will be false

            if(receivedBuffer.length !== expectedBuffer.length){
                console.warn("Invalid WhatsApp webHook signature");

                return res.Status(401);
            }

            const isValid = crypto.timingSafeEqual(
                receivedBuffer,
                expectedBuffer
            );

            if(!isValid){
                console.warn("Invalid whatsApp webbHook signature");
                return res.Status(401);

            }

            next();

        
         }catch ( error ){
            console.error (" WhatsApp webHook signature verification error",
            error.message );
         

         return res.sendStatus(401);
        }
    }
    





