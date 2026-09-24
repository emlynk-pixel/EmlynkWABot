// In-memory stand-in for a Supabase storage bucket (storage.from(bucket)).
// Mirrors the real behaviour the code relies on: copy never overwrites
// (409 "already exists"), missing sources give 404, results are
// { data, error } objects rather than exceptions.
export function createFakeBucket(initialPaths = [], options = {}) {
    const objects = new Map(initialPaths.map((path) => [path, true]));
    const calls = [];
    const { failCopy = false, failRemove = false, takenOnCopy = [] } = options;
    const raceTaken = new Set(takenOnCopy);

    return {
        objects,
        calls,
        has: (path) => objects.has(path),
        async exists(path) {
            calls.push({ method: "exists", path });
            return objects.has(path) ? { data: true, error: null } : { data: false, error: { statusCode: "404", message: "Object not found" } };
        },
        async copy(fromPath, toPath) {
            calls.push({ method: "copy", fromPath, toPath });
            if (failCopy) return { data: null, error: { statusCode: "500", message: "Internal storage error" } };
            if (!objects.has(fromPath)) return { data: null, error: { statusCode: "404", message: "Object not found" } };
            // Simulates another request taking the name between exists() and copy().
            if (raceTaken.has(toPath)) {
                raceTaken.delete(toPath);
                objects.set(toPath, true);
                return { data: null, error: { statusCode: "409", message: "The resource already exists" } };
            }
            if (objects.has(toPath)) return { data: null, error: { statusCode: "409", message: "The resource already exists" } };
            objects.set(toPath, true);
            return { data: { path: toPath }, error: null };
        },
        async remove(paths) {
            calls.push({ method: "remove", paths });
            if (failRemove) return { data: null, error: { message: "Remove failed" } };
            paths.forEach((path) => objects.delete(path));
            return { data: paths, error: null };
        },
    };
}
