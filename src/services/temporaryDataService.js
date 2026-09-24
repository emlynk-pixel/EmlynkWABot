import crypto from "crypto";

// Loaded lazily so unit tests can pass a fake client without touching the DB.
async function resolveDb(db) {
    return db ?? (await import("../config/prisma.js")).default;
}

// Create the temporary_data row for a newly stored document.
export async function createTemporaryDocumentRecord({
    whatsappNumber,
    temporaryStoragePath,
}, { db } = {}){
    const temporaryId = crypto.randomUUID();

    // Always UNCLASSIFIED at this stage. The filename guess the route passes in
    // is not trusted. Content-based classification updates this afterwards.
    const documentType = "UNCLASSIFIED";
    const processingStatus = "TEMPORARY_STORED";

    const client = await resolveDb(db);
    const temporaryRecord = await client.temporaryData.create({
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

// Only these columns change after classification and identity checks.
// whatsapp_number and the storage path stay as received.
const UPDATABLE_FIELDS = ["documentType", "processingStatus", "passportId", "uniqueId"];

export async function updateTemporaryDocumentRecord(temporaryId, changes, { db } = {}) {
    const data = Object.fromEntries(
        Object.entries(changes).filter(([field, value]) => UPDATABLE_FIELDS.includes(field) && value !== undefined)
    );

    const client = await resolveDb(db);
    return client.temporaryData.update({
        where: { temporaryId },
        data,
    });
}
