import crypto from "crypto";

import { copyToFreeName, removeObject } from "./permanentStorageService.js";
import {
    clientFolderPath,
    extensionForMimeType,
    sanitizeFileName,
    standardFileName,
    timestampFileName,
    withNumericSuffix,
} from "../utils/storageNaming.js";

// documents.verification_status only ever holds these two values (decision D6).
export const VERIFICATION_STATUS = Object.freeze({
    VERIFIED: "VERIFIED",
    REVIEW_REQUIRED: "REVIEW_REQUIRED",
});

// Proposal §24: VERIFIED -> STORED.
export const DOCUMENT_PROCESSING_STATUS_STORED = "STORED";

// Bands that may be stored under a client. UNDEFINED never is (it goes to pending/).
const VERIFICATION_BY_BAND = {
    VERIFIED: VERIFICATION_STATUS.VERIFIED,
    HIGH_CONFIDENCE: VERIFICATION_STATUS.VERIFIED,
    SLIGHTLY_UNCLEAR: VERIFICATION_STATUS.VERIFIED,
    UNCLEAR: VERIFICATION_STATUS.REVIEW_REQUIRED,
};

export const CLIENT_STORE_OUTCOME = Object.freeze({
    STORED: "STORED",
    DUPLICATE: "DUPLICATE", // a parallel request stored the same file first
});

export function verificationStatusForBand(band) {
    const status = VERIFICATION_BY_BAND[band];
    if (!status) {
        throw new Error(`Band ${band} is never stored under a client`);
    }
    return status;
}

async function resolveDb(db) {
    return db ?? (await import("../config/prisma.js")).default;
}

const isUniqueViolation = (error) => error?.code === "P2002";

// Copy a document into clients/{passport_id}/… and record it in documents.
//   UNCLEAR  -> keeps the sanitized original file name (_2, _3 on collision)
//   others   -> standard name, next version (passport.pdf, passport_v2.pdf, …)
// If the database write fails, the copy is removed again; the temporary
// object is never touched. Nothing returned here contains document text.
export async function storeClientDocument({
    temporaryStoragePath,
    passportId,
    documentType,
    band,
    mimeType,
    originalFileName,
    fileSize,
    fileSha256,
    documentConfidence,
    receivedAt,
    temporaryId,
    policeSubmittedDate,
}, { db, bucket, now = new Date() } = {}) {
    const verificationStatus = verificationStatusForBand(band);
    const extension = extensionForMimeType(mimeType);
    const folder = clientFolderPath(passportId, documentType);
    const client = await resolveDb(db);

    // Photos arrive without a file name; documents.original_filename is required.
    const fallbackName = timestampFileName(receivedAt ?? now, extension);
    const originalFilename = originalFileName || fallbackName;

    let copy;
    if (verificationStatus === VERIFICATION_STATUS.REVIEW_REQUIRED) {
        // UNCLEAR: keep the sender's name (proposal §17), made safe.
        const keptName = sanitizeFileName(originalFileName, extension) ?? fallbackName;
        copy = await copyToFreeName(
            { fromPath: temporaryStoragePath, folder, nameForAttempt: (n) => withNumericSuffix(keptName, n) },
            { bucket }
        );
    } else {
        const existing = await client.document.count({ where: { passportId, documentType } });
        copy = await copyToFreeName(
            {
                fromPath: temporaryStoragePath,
                folder,
                nameForAttempt: (version) => standardFileName(documentType, version, extension),
                firstAttempt: existing + 1,
            },
            { bucket }
        );
    }

    const documentId = crypto.randomUUID();

    try {
        await client.document.create({
            data: {
                documentId,
                passportId,
                documentType,
                originalFilename,
                storedFilename: copy.fileName,
                storagePath: copy.storagePath,
                mimeType,
                fileSize: BigInt(fileSize),
                receivedDate: receivedAt ?? now,
                processingStatus: DOCUMENT_PROCESSING_STATUS_STORED,
                verificationStatus,
                ocrConfidence: Math.round(documentConfidence * 100) / 100,
                fileSha256,
                // Submission it came from (review reason, processing summary).
                temporaryId: temporaryId ?? null,
                // Police slips: the resolved submitted date ("YYYY-MM-DD"),
                // start of the 21-day countdown. Null for everything else.
                policeSubmittedDate: policeSubmittedDate ? new Date(`${policeSubmittedDate}T00:00:00.000Z`) : null,
            },
        });
    } catch (error) {
        const cleanup = await removeObject(copy.storagePath, { bucket });

        if (isUniqueViolation(error) && cleanup.removed) {
            return { outcome: CLIENT_STORE_OUTCOME.DUPLICATE, documentId: null, storagePath: null, verificationStatus: null };
        }

        // Paths contain the passport number, so they stay out of the message.
        const cleanupNote = cleanup.removed ? "copy removed" : `copy NOT removed (${cleanup.error})`;
        throw new Error(`documents insert failed (${isUniqueViolation(error) ? "duplicate" : error.message}); ${cleanupNote}`);
    }

    return {
        outcome: CLIENT_STORE_OUTCOME.STORED,
        documentId,
        storagePath: copy.storagePath,
        storedFilename: copy.fileName,
        verificationStatus,
    };
}
