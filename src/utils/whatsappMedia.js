// WhatsApp message types that carry a file we process. Both go through the
// same download, validation, storage and OCR flow.
// - document: sent as a file attachment (PDF, or an image sent as a file)
// - image: sent as a photo from the camera or gallery
export const SUPPORTED_MEDIA_MESSAGE_TYPES = Object.freeze(["document", "image"]);

// Pull the media fields out of a WhatsApp document or image message.
export function extractDocumentMetadata(message){
    if(!message || !SUPPORTED_MEDIA_MESSAGE_TYPES.includes(message.type)){
        return{
            valid: false,
            reason: "NOT_A_DOCUMENT",
        };
    }

    // Meta puts the media fields under a key named after the type.
    const media = message[message.type];

    // Without a media ID there's nothing to download.
    if(!media?.id){
        return{
            valid: false,
            reason: "NO_MEDIA_ID",
        };
    }

    return{
        valid: true,
        mediaId: media.id,
        // Photos have no filename. Leaving it null keeps a made-up name out
        // of the filename hint; the stored extension comes from the MIME type.
        fileName: message.type === "document" ? media.filename : null,
        mimeType: media.mime_type,
    };
}
