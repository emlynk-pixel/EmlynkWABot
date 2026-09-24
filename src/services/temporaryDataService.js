import crypto from "crypto";
import prisma from "../config/prisma.js";

// Create the temporary_data row for a newly stored document.
export async function createTemporaryDocumentRecord({
    whatsappNumber,
    temporaryStoragePath,
}){
    const temporaryId = crypto.randomUUID();

    // Always UNCLASSIFIED at this stage. The filename guess the route passes in
    // is not trusted. Content-based classification will update this later.
    const documentType = "UNCLASSIFIED";
    const processingStatus = "TEMPORARY_STORED";

    const temporaryRecord = await prisma.temporaryData.create({
        data:{
            temporaryId,
            whatsappNumber,
            documentType,
            temporaryStoragePath,
            processingStatus,
        },
    });

    return temporaryRecord;
}
