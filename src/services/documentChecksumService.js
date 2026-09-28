// Duplicate detection by SHA-256 (proposal §31, Phase 7 decisions D8/D9).
// Checksums are unique per client, not globally: the same file under another
// client is a case for review, not something the database should reject.

import { resolveDb } from "../utils/resolveClients.js";

export const CHECKSUM_OUTCOME = Object.freeze({
    NEW: "NEW",
    // M1: this submission's own document, stored by an earlier attempt that
    // was interrupted before it could finish (the worker resumes it).
    ALREADY_STORED: "ALREADY_STORED",
    DUPLICATE: "DUPLICATE",                          // same client already has this exact file
    CROSS_CLIENT_CONFLICT: "CROSS_CLIENT_CONFLICT",  // another client has this exact file
});


// For a document about to be stored under a client. Same-client first, so a
// file the client already has is never reported as a conflict. The other
// client's identity is never returned: only whether a match exists.
export async function checkClientChecksum({ passportId, fileSha256, temporaryId = null }, { db } = {}) {
    if (!passportId || !fileSha256) {
        throw new Error("checkClientChecksum needs a passport ID and a checksum");
    }

    const client = await resolveDb(db);

    const sameClient = await client.document.findFirst({
        where: { passportId, fileSha256 },
        select: { documentId: true, verificationStatus: true, temporaryId: true, storagePath: true, storedFilename: true },
    });
    if (sameClient && temporaryId && sameClient.temporaryId === temporaryId) {
        return {
            outcome: CHECKSUM_OUTCOME.ALREADY_STORED,
            existingDocumentId: sameClient.documentId,
            existingVerified: sameClient.verificationStatus === "VERIFIED",
            existingDocument: {
                documentId: sameClient.documentId, verificationStatus: sameClient.verificationStatus,
                storagePath: sameClient.storagePath, storedFilename: sameClient.storedFilename,
            },
        };
    }
    if (sameClient) {
        // M4: an exact copy of a VERIFIED document goes to admin review
        // (storagePlacementService.decidePlacement); other duplicates don't.
        return {
            outcome: CHECKSUM_OUTCOME.DUPLICATE,
            existingDocumentId: sameClient.documentId,
            existingVerified: sameClient.verificationStatus === "VERIFIED",
        };
    }

    const otherClient = await client.document.findFirst({
        where: { fileSha256, passportId: { not: passportId } },
        select: { documentId: true },
    });
    if (otherClient) {
        return { outcome: CHECKSUM_OUTCOME.CROSS_CLIENT_CONFLICT, existingDocumentId: null };
    }

    return { outcome: CHECKSUM_OUTCOME.NEW, existingDocumentId: null };
}

// For documents that can't go to a client folder: has this sender already
// sent this exact file, and is it already waiting in pending/? Only earlier
// rows that actually reached pending/ count, so a file whose first attempt
// failed can still be processed when it's sent again.
export async function findPendingDuplicate({ whatsappNumber, fileSha256, temporaryId }, { db } = {}) {
    if (!whatsappNumber || !fileSha256) return null;

    const client = await resolveDb(db);

    return client.temporaryData.findFirst({
        where: {
            whatsappNumber,
            fileSha256,
            temporaryId: { not: temporaryId },
            pendingStoragePath: { not: null },
        },
        select: { temporaryId: true },
    });
}
