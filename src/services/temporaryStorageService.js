import crypto from "crypto";
import { extensionForMimeType } from "../utils/storageNaming.js";

async function defaultBucket() {
    const { default: supabase } = await import("../config/supabase.js");
    return supabase.storage.from(process.env.SUPABASE_BUCKET);
}

// Upload a received document to the private bucket under temporary/.
// The name is a random UUID and the extension comes from the validated MIME
// type only (SEC-010): the sender's file name never reaches the storage path,
// so "passport.exe" sent as a PDF is stored as {uuid}.pdf.
export async function saveTemporaryFile({
    fileBuffer,
    mimeType,
    bucket,
}) {
    const extension = extensionForMimeType(mimeType); // throws for anything not allowed

    const storedFileName = `${crypto.randomUUID()}${extension}`;
    const storagePath = `temporary/${storedFileName}`;

    const target = bucket ?? (await defaultBucket());
    const { error } = await target.upload(storagePath, fileBuffer, {
        contentType: mimeType,
        upsert: false,
    });

    if (error) {
        // Supabase's message only; the path is not included.
        throw new Error(
            `Supabase temporary upload failed: ${error.message}`
        );
    }

    return {
        storedFileName,
        storagePath,
    };
}
