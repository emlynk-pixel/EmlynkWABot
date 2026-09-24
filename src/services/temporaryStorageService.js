import path from "path";
import crypto from "crypto";
import supabase from "../config/supabase.js";

// Used only when the original filename has no extension.
const EXTENSION_BY_MIME_TYPE = new Map([
    ["application/pdf", ".pdf"],
    ["image/jpeg", ".jpeg"],
    ["image/png", ".png"],
]);

// Upload a received document to the private bucket under temporary/.
export async function saveTemporaryFile({
    fileBuffer,
    originalFileName,
    mimeType,
}) {
    const extension =
        path.extname(originalFileName || "") ||
        EXTENSION_BY_MIME_TYPE.get(mimeType) ||
        "";

    // UUID name so the sender's filename never ends up in the storage path.
    const storedFileName = `${crypto.randomUUID()}${extension}`;
    const storagePath = `temporary/${storedFileName}`;

    const { error } = await supabase.storage
        .from(process.env.SUPABASE_BUCKET)
        .upload(storagePath, fileBuffer, {
            contentType: mimeType,
            upsert: false,
        });

    if (error) {
        throw new Error(
            `Supabase temporary upload failed: ${error.message}`
        );
    }

    return {
        storedFileName,
        storagePath,
    };
}
