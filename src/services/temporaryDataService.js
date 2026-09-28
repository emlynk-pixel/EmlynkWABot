import crypto from "crypto";
import { resolveDb } from "../utils/resolveClients.js";


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

// M1: the worker's attempt no longer owns the submission (its lease ran out
// and another attempt took it, or it was finished or given up meanwhile).
// Whatever this attempt worked out is discarded: it writes nothing more.
export class ClaimLostError extends Error {
    constructor() {
        super("The worker no longer owns this submission; its result is discarded");
        this.name = "ClaimLostError";
    }
}

// With `claim` (the background worker's attempt, submissionQueue.js) the
// row is only updated while that attempt still owns it: same status,
// attempt and lease. Otherwise nothing is written and ClaimLostError is
// thrown, so a late, stale attempt can never overwrite a newer result.
export async function updateTemporaryDocumentRecord(temporaryId, changes, { db, claim } = {}) {
    const data = Object.fromEntries(
        Object.entries(changes).filter(([field, value]) => UPDATABLE_FIELDS.includes(field) && value !== undefined)
    );

    const client = await resolveDb(db);
    if (claim) {
        const { count } = await client.temporaryData.updateMany({ where: claim.where(), data });
        if (count !== 1) throw new ClaimLostError();
        return { temporaryId, ...data };
    }
    return client.temporaryData.update({
        where: { temporaryId },
        data,
    });
}
