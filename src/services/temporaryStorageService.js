import path from "path";
import crypto from "crypto";
import supabase from "../config/supabase.js";

// Upload a received document to the private bucket under temporary/.
export async function saveTemporaryFile({
    fileBuffer,
    originalFileName,
    mimeType,
}) {

    // Fall back to the MIME type when the filename has no extension.
    let extension = path.extname(originalFileName || "");

    if (!extension){
        if (mimeType === "application/pdf"){
            extension = ".pdf";
        }else if ( mimeType === "image/jpeg"){
            extension = ".jpeg";

        }else if ( mimeType === "image/png"){
            extension = ".png";
        }

    }

// UUID name so the sender's filename never ends up in the storage path.
const storedFileName = `${crypto.randomUUID()}${extension}`;

const storagePath = `temporary/${storedFileName}`;

const { error } = await supabase.storage
    .from(process.env.SUPABASE_BUCKET)
    .upload(storagePath,fileBuffer,{
        contentType: mimeType,
        upsert: false,
    });

    if (error){
        throw new Error(
            `Supabase temporary upload failed: ${error.message}`
        );
    }


    return{
       storedFileName,
       storagePath,
    };

}
