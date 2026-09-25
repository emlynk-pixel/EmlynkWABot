// Replay / duplicate protection for WhatsApp message IDs (SEC-006).
//
// A message ID is claimed as IN_PROGRESS as soon as the webhook accepts it,
// before any download or OCR, so a Meta retry or a replayed request that
// arrives meanwhile is ignored. When handling finishes it becomes PROCESSED.
// If handling crashes before it could record anything, the claim is released
// so Meta's retry can try again.
//
// Bounded: entries expire after ttlMs, and at most maxEntries are kept (the
// oldest are dropped first). In memory only: cleared on restart and not
// shared between app instances; after a restart the checksum checks still
// stop a resent file from being stored twice.

export const MESSAGE_ID_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const MESSAGE_ID_MAX_ENTRIES = 10_000;

export const MESSAGE_STATE = Object.freeze({
    IN_PROGRESS: "IN_PROGRESS",
    PROCESSED: "PROCESSED",
});

export function createMessageIdCache({
    ttlMs = MESSAGE_ID_TTL_MS,
    maxEntries = MESSAGE_ID_MAX_ENTRIES,
    now = () => Date.now(),
} = {}) {
    // Map keeps insertion order, so the first entries are the oldest.
    const entries = new Map();

    function pruneExpired() {
        const time = now();
        for (const [id, entry] of entries) {
            if (entry.expiresAt > time) break;
            entries.delete(id);
        }
    }

    function set(id, state) {
        entries.delete(id); // re-insert at the end so order follows expiry
        entries.set(id, { state, expiresAt: now() + ttlMs });
        while (entries.size > maxEntries) {
            entries.delete(entries.keys().next().value);
        }
    }

    return {
        // Returns true if this call claimed the ID; false if it is already
        // being handled or was handled recently.
        claim(id) {
            pruneExpired();
            const existing = entries.get(id);
            if (existing && existing.expiresAt > now()) return false;
            set(id, MESSAGE_STATE.IN_PROGRESS);
            return true;
        },
        complete(id) {
            set(id, MESSAGE_STATE.PROCESSED);
        },
        release(id) {
            entries.delete(id);
        },
        stateOf(id) {
            const entry = entries.get(id);
            return entry && entry.expiresAt > now() ? entry.state : null;
        },
        get size() {
            return entries.size;
        },
    };
}

// The instance used by the webhook.
export const messageIdCache = createMessageIdCache();
