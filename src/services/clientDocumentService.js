import crypto from "crypto";

import { copyToFreeName, removeObject } from "./permanentStorageService.js";
import { placementCopyHooks } from "./placementRecovery.js";
import { ClaimLostError } from "./temporaryDataService.js";
import {
    clientFolderPath,
    extensionForMimeType,
    sanitizeFileName,
    standardFileName,
    timestampFileName,
    withNumericSuffix,
} from "../utils/storageNaming.js";

// documents.verification_status is a plain text column (decision D6: VERIFIED
// or REVIEW_REQUIRED). M4 (multiple verified documents of the same type)
// adds a third value, SUPERSEDED: the previous VERIFIED document of a type,
// kept exactly as it was (file, checksum, audit history) after an admin
// explicitly replaces it with a different file (adminReviewActionService.js
// replaceVerifiedDocument). No migration: the column already accepts any
// text. Every place that means "the client's current document of this type"
// (hasVerifiedDocument, findVerifiedOfType, completeness counts, the police
// countdown) filters for VERIFIED specifically, so a SUPERSEDED document is
// never counted as verified, never blocks a later replacement, and is never
// treated as still needing review. It stays visible (Documents list, client
// page) for the audit trail; nothing here ever deletes it.
export const VERIFICATION_STATUS = Object.freeze({
    VERIFIED: "VERIFIED",
    REVIEW_REQUIRED: "REVIEW_REQUIRED",
    SUPERSEDED: "SUPERSEDED",
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

// M1: a worker write that commits together with a renewal of its claim
// (documents insert, client record). A slow write can't outlive the
// transaction (timeout well below the worker lease).
export const CLAIMED_WRITE_OPTIONS = Object.freeze({ maxWait: 10_000, timeout: 30_000 });

// Does the client already have a VERIFIED document of this type? A new
// document that would be stored as REVIEW_REQUIRED next to it could never be
// approved (one verified document per type), so it goes to pending/ instead
// (storagePlacementService.decidePlacement). Nothing is changed here.
export async function hasVerifiedDocument({ passportId, documentType }, { db } = {}) {
    const client = await resolveDb(db);
    const existing = await client.document.findFirst({
        where: { passportId, documentType, verificationStatus: VERIFICATION_STATUS.VERIFIED },
        select: { documentId: true },
    });
    return Boolean(existing);
}

// Copy a document into clients/{passport_id}/… and record it in documents.
//   UNCLEAR  -> keeps the sanitized original file name (_2, _3 on collision)
//   others   -> standard name, next version (passport.pdf, passport_v2.pdf, …)
// If the database write fails, the copy is removed again; the temporary
// object is never touched. Nothing returned here contains document text.
// M1: with the worker's `claim`, the claim is renewed before the copy, the
// insert commits only together with a renewal (one transaction: a stale
// attempt can never add a document), and an interrupted earlier attempt's
// copy of this submission is reused (placementRecovery.js). An attempt that
// lost its claim never removes its copy: the attempt that owns the
// submission now may be using it.
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
}, { db, bucket, now = new Date(), claim = null } = {}) {
    const verificationStatus = verificationStatusForBand(band);
    const extension = extensionForMimeType(mimeType);
    const folder = clientFolderPath(passportId, documentType);
    const client = await resolveDb(db);
    const hooks = placementCopyHooks({ claim, fileSha256 }, { db: client, bucket });

    // Photos arrive without a file name; documents.original_filename is required.
    const fallbackName = timestampFileName(receivedAt ?? now, extension);
    const originalFilename = originalFileName || fallbackName;

    let copy;
    if (verificationStatus === VERIFICATION_STATUS.REVIEW_REQUIRED) {
        // UNCLEAR: keep the sender's name (proposal §17), made safe.
        const keptName = sanitizeFileName(originalFileName, extension) ?? fallbackName;
        copy = await copyToFreeName(
            { fromPath: temporaryStoragePath, folder, nameForAttempt: (n) => withNumericSuffix(keptName, n), ...hooks },
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
                ...hooks,
            },
            { bucket }
        );
    }

    const documentId = crypto.randomUUID();

    try {
        const insert = (tx) => tx.document.create({
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
        if (claim) {
            await client.$transaction(async (tx) => {
                await claim.renew({ tx });
                await insert(tx);
            }, CLAIMED_WRITE_OPTIONS);
        } else {
            await insert(client);
        }
    } catch (error) {
        if (claim) {
            // Lost the claim (now or while inserting): leave the copy alone.
            if (error instanceof ClaimLostError) throw error;
            await claim.renew();
            // Never remove a copy a document refers to.
            const inUse = await client.document.findFirst({ where: { storagePath: copy.storagePath }, select: { documentId: true } });
            if (inUse) throw new Error(`documents insert failed (${isUniqueViolation(error) ? "duplicate" : error.message}); copy kept (in use)`);
        }
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
