export function classifyDocument({
    fileName,
    mimeType,
}){

    if(!fileName){
        return {
            documentType: "UNKNOWN",
            confidence: 0,
            source: "FILENAME",

        };
    }

    //Covert file name into Lowercase

    const normalizedFileName = fileName.toLowerCase();

    //Matching filename patterns to determine document type

    if(
        normalizedFileName.includes("passport")||
        normalizedFileName.includes("travel document")

    ){
        return {
            documentType: "PASSPORT",
            confidence: 50,
            source: "FILENAME",
        };
    }

    if(
        normalizedFileName.includes("medical")||
        normalizedFileName.includes("health")
    ){
        return{
            documentType: "MEDICAL",
            confidence: 50,
            source: "FILENAME",
        };
    }

    if(
        normalizedFileName.includes("police") ||
        normalizedFileName.includes("clearance")
    ){
        return{
            documentType: "POLICE_REPORT",
            confidence: 50,
            source: "FILENAME",
        };
    }

    return{
        documentType:"UNKNOWN",
        confidence: 0,
        source: "FILENAME",
    };
}