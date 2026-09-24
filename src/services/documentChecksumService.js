// Duplicate detection by SHA-256 (proposal §31, Phase 7 decisions D8/D9).
// Checksums are unique per client, not globally: the same file under another
// client is a case for review, not something the database should reject.

export const CHECKSUM_OUTCOME = Object.freeze({
    NEW: "NEW",
    DUPLICATE: "DUPLICATE",                          // same client already has this exact file
    CROSS_CLIENT_CONFLICT: "CROSS_CLIENT_CONFLICT",  // another client has this exact file
});

// Loaded lazily so unit tests can pass a fake client without touching the DB.
async function resolveDb(db) {
    return db ?? (await import("../config/prisma.js")).default;
}

// For a document about to be stored under a client. Same-client first, so a
// file the client already has is never reported as a conflict. The other
// client's identity is never returned: only whether a match exists.
export async function checkClientChecksum({ passportId, fileSha256 }, { db } = {}) {
    if (!passportId || !fileSha256) {
        throw new Error("checkClientChecksum needs a passport ID and a checksum");
    }

    const client = await resolveDb(db);

    const sameClient = await client.document.findFirst({
        where: { passportId, fileSha256 },
        select: { documentId: true },
    });
    if (sameClient) {
        return { outcome: CHECKSUM_OUTCOME.DUPLICATE, existingDocumentId: sameClient.documentId };
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
