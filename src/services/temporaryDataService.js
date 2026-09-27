import crypto from "crypto";

// Loaded lazily so unit tests can pass a fake client without touching the DB.
async function resolveDb(db) {
    return db ?? (await import("../config/prisma.js")).default;
}

// Create the temporary_data row for a newly stored document. It is the
// durable job of the background worker (M1): committed before the webhook
// answers Meta, with what processing needs later (message ID, the file name
// and time as received). A second row for the same WhatsApp message is
// refused by the unique message_id: then { duplicate: true } is returned.
export async function createTemporaryDocumentRecord({
    whatsappNumber,
    temporaryStoragePath,
    fileSha256,
    messageId = null,
    originalFilename = null,
    receivedAt = null,
}, { db } = {}){
    const temporaryId = crypto.randomUUID();

    // Always UNCLASSIFIED at this stage. The filename guess the route passes in
    // is not trusted. Content-based classification updates this afterwards.
    const documentType = "UNCLASSIFIED";
    const processingStatus = "TEMPORARY_STORED";

    const client = await resolveDb(db);
    try {
        return await client.temporaryData.create({
            data:{
                temporaryId,
                whatsappNumber,
                documentType,
                temporaryStoragePath,
                processingStatus,
                fileSha256,
                messageId,
                originalFilename,
                receivedAt,
            },
        });
    } catch (error) {
        const target = [error?.meta?.target].flat().join(",");
        if (error?.code === "P2002" && /message_id|messageId/.test(target)) {
            return { duplicate: true, temporaryId: null };
        }
        throw error;
    }
}

// Only these columns change after processing. whatsapp_number, the
// checksum and the temporary storage path stay as received.
// processingSummary / reviewReason: Phase 10 review data (PII-free summary).
const UPDATABLE_FIELDS = ["documentType", "processingStatus", "passportId", "uniqueId", "pendingStoragePath", "processingSummary", "reviewReason"];

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
