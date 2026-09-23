//Allowed doc MIME types

const ALLOWED_MIME_TYPES = [
    "application/pdf",
    "image/jpeg",
    "image/png"
];


//MAx File Size ( Temporary using 10Mb )

const MAX_FILE_SIZE = 10 * 1024 * 1024;

export function validateDocumentFile({
    mimeType,
    fileSize,
}) {

    //Check mime type

    if (!mimeType){
        return{
            valid: false,
            reason: "MISSING_MIME_TYPE",
        };
    }

    //Unsupported File types

    if(!ALLOWED_MIME_TYPES.includes(mimeType)){
        return {
            valid: false,
            reason: "UNSUPPORTED_FILE_TYPE",
            
        };
    }

    //Check file size

    if (!fileSize || fileSize <= 0) {
        return{
            valid: false,
            reason: "INVALID_FILE_SIZE",
        };
    }


    //Check maximun size

    if(fileSize > MAX_FILE_SIZE){
        return{
            valid: false,
            reason: "FILE_TOO_LARGE",
        };
    }

    //All valid
    return{
        valid: true,
    };
}