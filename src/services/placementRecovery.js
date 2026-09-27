// M1: storage copies that are safe to repeat, for the background worker.
//
// Before copying a document into clients/ or pending/, the worker records
// the object path it is about to create on its temporary_data row
// (placement_path), in the same conditional update that renews its claim.
// If the attempt is interrupted after the copy (crash, lease lost), the next
// attempt of the same submission computes the same name and finds it taken.
// It uses that object instead of making a "_v2" / "_2" copy when all hold:
//   - it is the path this submission recorded (an earlier attempt of its own);
//   - no documents row and no other submission refers to that path (another
//     submission that picked the same name records it too);
//   - the object's SHA-256 is this submission's file.
// Nothing is ever deleted here ("no automatic removal"). An object that
// fails these checks is left alone and the next free name is used.
import { sha256Hex } from "../utils/fileChecksum.js";

async function isOwnEarlierCopy(storagePath, { claim, fileSha256 }, { db, bucket }) {
    if (!claim?.earlierPlacementPath || storagePath !== claim.earlierPlacementPath || !fileSha256 || !bucket) {
        return false;
    }
    const [document, otherSubmission] = await Promise.all([
        db.document.findFirst({ where: { storagePath }, select: { documentId: true } }),
        db.temporaryData.findFirst({
            where: {
                temporaryId: { not: claim.temporaryId },
                OR: [{ pendingStoragePath: storagePath }, { placementPath: storagePath }],
            },
            select: { temporaryId: true },
        }),
    ]);
    if (document || otherSubmission) return false;

    const { data, error } = await bucket.download(storagePath);
    if (error || !data) return false;
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(await data.arrayBuffer());
    return sha256Hex(buffer) === fileSha256.trim();
}

// copyToFreeName hooks for one placement. Without a claim (callers other
// than the worker) there are none and copying works exactly as before.
export function placementCopyHooks({ claim, fileSha256 }, { db, bucket }) {
    if (!claim) return {};
    return {
        beforeCopy: (storagePath) => claim.renew({ placementPath: storagePath }),
        reuseExisting: (storagePath) => isOwnEarlierCopy(storagePath, { claim, fileSha256 }, { db, bucket }),
    };
}
