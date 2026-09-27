import { CHECKSUM_OUTCOME, findPendingDuplicate } from "./documentChecksumService.js";
import { storeClientDocument, CLIENT_STORE_OUTCOME } from "./clientDocumentService.js";
import { copyToFreeName } from "./permanentStorageService.js";
import { placementCopyHooks } from "./placementRecovery.js";
import {
    DOCUMENT_STORAGE_TYPES,
    extensionForMimeType,
    pendingFolderPath,
    timestampFileName,
    withNumericSuffix,
} from "../utils/storageNaming.js";

// Where a processed document goes (Docs/11 placement rules).
export const PLACEMENT = Object.freeze({
    CLIENT: "CLIENT",   // clients/{passport_id}/…, with a documents row
    PENDING: "PENDING", // pending/…, recorded in temporary_data.pending_storage_path
    NONE: "NONE",       // stays in temporary/ only (duplicates)
});

export const CLIENT_BANDS = new Set(["VERIFIED", "HIGH_CONFIDENCE", "SLIGHTLY_UNCLEAR", "UNCLEAR"]);

// Pure decision. `clientIdentified` means Phase 6 linked the document to
// exactly one existing client (not provisional). `reviewBlocked` means a
// specific reason needs a person (identity, wrong document, police slip
// date), not just low confidence. `verifiedOfTypeExists` means the client
// already has a VERIFIED document of this type — a *different* file (an
// exact-checksum match is handled separately, above, as DUPLICATE). M4:
// whatever band this file would otherwise be stored at (even a clean
// VERIFIED read), it never automatically becomes a second VERIFIED document
// of the same type: it waits in pending/ for an admin (replace the existing
// one, keep this as a separate REVIEW_REQUIRED version, or remove it); the
// existing VERIFIED document is never touched automatically.
// `duplicateOfVerified` means the same client's matching file
// (checksumOutcome DUPLICATE) is VERIFIED.
// Rules are checked in order; anything that must not be attached to a
// client automatically goes to pending/.
export function decidePlacement({ processingStatus, band, documentType, clientIdentified, uniqueId, checksumOutcome, reviewBlocked = false, verifiedOfTypeExists = false, duplicateOfVerified = false }) {
    // M1: an interrupted earlier attempt already stored this submission's own
    // document; the attempt that resumes it uses that document (no new copy).
    if (checksumOutcome === CHECKSUM_OUTCOME.ALREADY_STORED) {
        return { placement: PLACEMENT.CLIENT, processingStatus, pendingOwner: null, alreadyStored: true };
    }
    // Same client already has this exact file (D8): nothing new is stored in
    // the client folder. M4: when that file is VERIFIED, the incoming copy is
    // not discarded but waits in pending/ for an admin (keep or remove); the
    // verified document is never changed. Other duplicates: nothing stored.
    if (checksumOutcome === CHECKSUM_OUTCOME.DUPLICATE) {
        return duplicateOfVerified && clientIdentified
            ? { placement: PLACEMENT.PENDING, processingStatus: "DUPLICATE", pendingOwner: uniqueId }
            : { placement: PLACEMENT.NONE, processingStatus: "DUPLICATE", pendingOwner: null };
    }

    // Exact file already belongs to another client (D9). Neither client's
    // folder name is used for the pending copy.
    if (checksumOutcome === CHECKSUM_OUTCOME.CROSS_CLIENT_CONFLICT) {
        return { placement: PLACEMENT.PENDING, processingStatus: "CONFLICT", pendingOwner: null };
    }

    const pendingOwner = clientIdentified ? uniqueId : null;
    const pending = (status) => ({ placement: PLACEMENT.PENDING, processingStatus: status, pendingOwner });

    // Conflicts, unusable documents and anything needing review (D5).
    if (["CONFLICT", "UNDEFINED", "MANUAL_REVIEW"].includes(processingStatus)) {
        return pending(processingStatus);
    }

    // In the UNCLEAR band the status stays UNCLEAR even when there is also a
    // review reason, and UNCLEAR may enter the client folder. A review reason
    // must still keep the file out of it, whatever the band.
    if (reviewBlocked) {
        return pending(processingStatus);
    }

    const hasClientFolder = Boolean(DOCUMENT_STORAGE_TYPES[documentType]);
    if (clientIdentified && hasClientFolder && CLIENT_BANDS.has(band)) {
        // M4: the client already has a VERIFIED document of this type, and
        // this is a different file. Storing it now — whether as a second
        // VERIFIED document or as a REVIEW_REQUIRED copy that could never be
        // approved while the other stays VERIFIED — would either create the
        // ambiguity this rule exists to prevent, or sit in the Review Queue
        // forever. It waits in pending/ instead, where an admin decides
        // (replace, keep as a separate version, or remove); the existing
        // VERIFIED document is left exactly as it is.
        if (verifiedOfTypeExists) {
            return pending(processingStatus);
        }
        return { placement: PLACEMENT.CLIENT, processingStatus, pendingOwner: null };
    }

    // Good enough to store, but there's no single client to store it under.
    return pending(processingStatus);
}

// Copy into pending/ unless the same sender's same file is already there.
async function placeInPending({ decision, temporaryId, temporaryStoragePath, whatsappNumber, fileSha256, mimeType, receivedAt }, { db, bucket, now, claim }) {
    const earlier = await findPendingDuplicate({ whatsappNumber, fileSha256, temporaryId }, { db });
    if (earlier) {
        return { placement: PLACEMENT.NONE, processingStatus: "DUPLICATE", pendingStoragePath: null, stored: null };
    }

    const baseName = timestampFileName(receivedAt ?? now, extensionForMimeType(mimeType));
    const copy = await copyToFreeName(
        {
            fromPath: temporaryStoragePath,
            folder: pendingFolderPath({ uniqueId: decision.pendingOwner, temporaryId }),
            nameForAttempt: (n) => withNumericSuffix(baseName, n),
            ...placementCopyHooks({ claim, fileSha256 }, { db, bucket }),
        },
        { bucket }
    );

    return { placement: PLACEMENT.PENDING, processingStatus: decision.processingStatus, pendingStoragePath: copy.storagePath, stored: null };
}

// Carry out a placement decision. The temporary object is never deleted
// here (Phase 8). Throws on storage/database failure; the caller records FAILED.
// `claim`: the background worker's attempt (M1): no copy or insert once it
// no longer owns the submission (ClaimLostError), and copies are repeatable.
export async function placeDocument(decision, context, { db, bucket, now = new Date(), claim = null } = {}) {
    if (decision.placement === PLACEMENT.NONE) {
        return { placement: PLACEMENT.NONE, processingStatus: decision.processingStatus, pendingStoragePath: null, stored: null };
    }

    if (decision.alreadyStored) {
        const existing = context.existingDocument;
        return {
            placement: PLACEMENT.CLIENT,
            processingStatus: decision.processingStatus,
            pendingStoragePath: null,
            stored: { outcome: CLIENT_STORE_OUTCOME.STORED, documentId: existing.documentId, storagePath: existing.storagePath, storedFilename: existing.storedFilename, verificationStatus: existing.verificationStatus },
        };
    }

    if (!context.temporaryStoragePath) {
        throw new Error("placeDocument needs the temporary storage path to copy from");
    }

    if (decision.placement === PLACEMENT.PENDING) {
        return placeInPending({ decision, ...context }, { db, bucket, now, claim });
    }

    const stored = await storeClientDocument(
        {
            temporaryStoragePath: context.temporaryStoragePath,
            passportId: context.passportId,
            documentType: context.documentType,
            band: context.band,
            mimeType: context.mimeType,
            originalFileName: context.originalFileName,
            fileSize: context.fileSize,
            fileSha256: context.fileSha256,
            documentConfidence: context.documentConfidence,
            receivedAt: context.receivedAt,
            temporaryId: context.temporaryId,
            policeSubmittedDate: context.policeSubmittedDate ?? null,
        },
        { db, bucket, now, claim }
    );

    // A parallel request stored the same file first.
    if (stored.outcome === CLIENT_STORE_OUTCOME.DUPLICATE) {
        return { placement: PLACEMENT.NONE, processingStatus: "DUPLICATE", pendingStoragePath: null, stored: null };
    }

    return { placement: PLACEMENT.CLIENT, processingStatus: decision.processingStatus, pendingStoragePath: null, stored };
}
