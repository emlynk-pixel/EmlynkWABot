// Pull the media fields out of a WhatsApp document message.
export function extractDocumentMetadata(message){
    if(!message || message.type !== "document"){
        return{
            valid: false,
            reason: "NOT_A_DOCUMENT",
        };
    }

    // Without a media ID there's nothing to download.
    if(!message.document?.id){
        return{
            valid: false,
            reason: "NO_MEDIA_ID",
        };
    }

    return{
        valid: true,
        mediaId: message.document.id,
        fileName: message.document.filename,
        mimeType: message.document.mime_type,
    };
}
