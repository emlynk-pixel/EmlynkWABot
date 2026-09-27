// Copy objects inside the private bucket for Phase 7. Copies only: the
// temporary object stays until Phase 8 finalization (decision D1). Nothing
// here overwrites an object or creates a public URL.

// Enough for passport.pdf … passport_v20.pdf style collisions; more means
// something is wrong and should fail loudly rather than loop.
export const MAX_NAME_ATTEMPTS = 20;

// The bucket is loaded lazily so tests can pass a fake without Supabase.
async function resolveBucket(bucket) {
    if (bucket) return bucket;
    const { default: supabase } = await import("../config/supabase.js");
    return supabase.storage.from(process.env.SUPABASE_BUCKET);
}

// Supabase answers a copy onto an existing key with 409 / "already exists".
function isCollision(error) {
    const status = String(error?.statusCode ?? error?.status ?? "");
    return status === "409" || /already exists|duplicate/i.test(error?.message ?? "");
}

export class StorageCopyError extends Error {
    constructor(message) {
        super(message);
        this.name = "StorageCopyError";
    }
}

// Copy fromPath into folder under the first name that isn't taken.
// nameForAttempt(1), nameForAttempt(2), … supplies the candidate names
// (e.g. passport.pdf, passport_v2.pdf or scan.pdf, scan_2.pdf).
// M1 (background worker only; see placementRecovery.js):
//   beforeCopy(path)     runs right before the copy (renews the worker's
//                        claim and records the name it is about to use)
//   reuseExisting(path)  true when a taken name holds this submission's own
//                        copy from an interrupted earlier attempt: it is
//                        used as it is ({ reused: true }), no second copy.
export async function copyToFreeName({ fromPath, folder, nameForAttempt, firstAttempt = 1, beforeCopy, reuseExisting }, { bucket } = {}) {
    const storage = await resolveBucket(bucket);

    for (let attempt = firstAttempt; attempt < firstAttempt + MAX_NAME_ATTEMPTS; attempt++) {
        const fileName = nameForAttempt(attempt);
        const storagePath = `${folder}/${fileName}`;
        const reuse = async () => Boolean(reuseExisting) && (await reuseExisting(storagePath));

        const { data: taken, error: existsError } = await storage.exists(storagePath);
        if (existsError && !/not found|404|400/i.test(`${existsError.statusCode ?? ""} ${existsError.message ?? ""}`)) {
            throw new StorageCopyError(`Storage check failed: ${existsError.message}`);
        }
        if (taken) {
            if (await reuse()) return { storagePath, fileName, attempt, reused: true };
            continue;
        }

        if (beforeCopy) await beforeCopy(storagePath);
        const { error } = await storage.copy(fromPath, storagePath);
        if (!error) {
            return { storagePath, fileName, attempt };
        }
        // Someone else took this name between the check and the copy (or an
        // earlier attempt's copy of this submission landed late).
        if (isCollision(error)) {
            if (await reuse()) return { storagePath, fileName, attempt, reused: true };
            continue;
        }

        throw new StorageCopyError(`Storage copy failed: ${error.message}`);
    }

    throw new StorageCopyError(`No free file name after ${MAX_NAME_ATTEMPTS} attempts`);
}

// Delete one object, e.g. to undo a copy when the database write failed.
// Never throws: the caller decides what a failed clean-up means.
export async function removeObject(storagePath, { bucket } = {}) {
    try {
        const storage = await resolveBucket(bucket);
        const { error } = await storage.remove([storagePath]);
        return error ? { removed: false, error: error.message } : { removed: true, error: null };
    } catch (error) {
        return { removed: false, error: error.message };
    }
}
