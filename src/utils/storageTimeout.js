// Time limits for Supabase Storage calls (M1).
//
// A storage call that never answers must not block the background worker:
// the worker's claim on a job is a lease (submissionQueue.js, 10 minutes),
// and each storage side effect (a copy into clients/ or pending/) happens
// right after the lease has been renewed. So one storage call must always
// end well inside the lease: STORAGE_TIMEOUT_MS < lease (checked where the
// lease is defined).
//
// Two layers:
// - createTimeoutFetch: the Supabase client's fetch; the HTTP request is
//   aborted after the limit (socket freed).
// - withStorageTimeout: wraps a bucket so every call settles within the
//   limit whatever the transport, answering like Supabase does on failure
//   ({ data: null, error }). Callers already treat such an error as a
//   failed call (download -> tried again later, copy -> FAILED).

export const STORAGE_TIMEOUT_MS = 60_000;

const TIMED_METHODS = new Set(["download", "upload", "copy", "move", "exists", "remove", "list"]);

// Deliberately without numbers in the message: callers match storage
// errors on "404" / "400" / "409" text.
export class StorageTimeoutError extends Error {
    constructor(operation) {
        super(`Storage request timed out (${operation})`);
        this.name = "StorageTimeoutError";
        this.statusCode = "TIMEOUT";
    }
}

function settleWithin(promise, timeoutMs, operation) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ data: null, error: new StorageTimeoutError(operation) }), timeoutMs);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

export function withStorageTimeout(bucket, timeoutMs = STORAGE_TIMEOUT_MS) {
    if (!bucket) return bucket;
    return new Proxy(bucket, {
        get(target, property) {
            const value = Reflect.get(target, property);
            if (typeof value !== "function") return value;
            if (!TIMED_METHODS.has(property)) return value.bind(target);
            return (...args) => settleWithin(value.apply(target, args), timeoutMs, property);
        },
    });
}

// fetch for createClient({ global: { fetch } }): aborts after timeoutMs,
// keeping any signal the caller passed.
export function createTimeoutFetch(timeoutMs = STORAGE_TIMEOUT_MS, fetchImpl = globalThis.fetch) {
    return (input, init = {}) => {
        const limit = AbortSignal.timeout(timeoutMs);
        const signal = init.signal ? AbortSignal.any([init.signal, limit]) : limit;
        return fetchImpl(input, { ...init, signal });
    };
}
