import crypto from "crypto";
import prisma from "../config/prisma.js";

//Save temporary document in db record

export async function createTemporaryDocumentRecord({

    whatsappNumber,
    temporaryStoragePath,
}){

    //Generate unique ID for temp record

    const temporaryId = crypto.randomUUID();

    const documentType = "UNCLASSIFIED";

    //Current processingg state
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