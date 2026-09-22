//Extract media metadata from whatsapp document messages

export function extractDocumentMetadata(message){
    //Reject if not document msg

    if(!message || message.type !== "document"){
        return{
            valid: false,
            reason: "NOT_A_DOCUMENT",

        };

    }

    //If not meta media ID file cannot download

    if(!message.document?.id){
        return{
            valid:false,
            reason:"NO_MEDIA_ID",
        };
    }

    //Return valid document mmetadata

    return{
        valid:true,
        mediaId: message.document.id,
        fileName: message.document.filename,
        mimeType: message.document.mime_type,
    };
}