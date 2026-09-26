import { CHECKSUM_OUTCOME, findPendingDuplicate } from "./documentChecksumService.js";
import { storeClientDocument, CLIENT_STORE_OUTCOME, VERIFICATION_STATUS, verificationStatusForBand } from "./clientDocumentService.js";
import { copyToFreeName } from "./permanentStorageService.js";
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

const CLIENT_BANDS = new Set(["VERIFIED", "HIGH_CONFIDENCE", "SLIGHTLY_UNCLEAR", "UNCLEAR"]);

// Pure decision. `clientIdentified` means Phase 6 linked the document to
// exactly one existing client (not provisional). `reviewBlocked` means a
// specific reason needs a person (identity, wrong document, police slip
// date), not just low confidence. `verifiedOfTypeExists` means the client
// already has a VERIFIED document of this type. Rules are checked in order;
// anything that must not be attached to a client automatically goes to pending/.
export function decidePlacement({ processingStatus, band, documentType, clientIdentified, uniqueId, checksumOutcome, reviewBlocked = false, verifiedOfTypeExists = false }) {
    // Same client already has this exact file (D8): nothing new is stored.
    if (checksumOutcome === CHECKSUM_OUTCOME.DUPLICATE) {
        return { placement: PLACEMENT.NONE, processingStatus: "DUPLICATE", pendingOwner: null };
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
        // A REVIEW_REQUIRED copy next to an existing VERIFIED document of the
        // same type could never be approved, so it would stay in the Review
        // Queue for good. It waits in pending/ instead, where it can be
        // approved or removed; the verified document is left as it is.
        if (verifiedOfTypeExists && verificationStatusForBand(band) === VERIFICATION_STATUS.REVIEW_REQUIRED) {
            return pending(processingStatus);
        }
        return { placement: PLACEMENT.CLIENT, processingStatus, pendingOwner: null };
    }

    // Good enough to store, but there's no single client to store it under.
    return pending(processingStatus);
}

// Copy into pending/ unless the same sender's same file is already there.
async function placeInPending({ decision, temporaryId, temporaryStoragePath, whatsappNumber, fileSha256, mimeType, receivedAt }, { db, bucket, now }) {
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
        },
        { bucket }
    );

    return { placement: PLACEMENT.PENDING, processingStatus: decision.processingStatus, pendingStoragePath: copy.storagePath, stored: null };
}

// Carry out a placement decision. The temporary object is never deleted
// here (Phase 8). Throws on storage/database failure; the caller records FAILED.
export async function placeDocument(decision, context, { db, bucket, now = new Date() } = {}) {
    if (decision.placement === PLACEMENT.NONE) {
        return { placement: PLACEMENT.NONE, processingStatus: decision.processingStatus, pendingStoragePath: null, stored: null };
    }

    if (!context.temporaryStoragePath) {
        throw new Error("placeDocument needs the temporary storage path to copy from");
    }

    if (decision.placement === PLACEMENT.PENDING) {
        return placeInPending({ decision, ...context }, { db, bucket, now });
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
        { db, bucket, now }
    );

    // A parallel request stored the same file first.
    if (stored.outcome === CLIENT_STORE_OUTCOME.DUPLICATE) {
        return { placement: PLACEMENT.NONE, processingStatus: "DUPLICATE", pendingStoragePath: null, stored: null };
    }

    return { placement: PLACEMENT.CLIENT, processingStatus: decision.processingStatus, pendingStoragePath: null, stored };
}
