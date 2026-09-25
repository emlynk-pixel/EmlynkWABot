import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    createMessageIdCache,
    MESSAGE_STATE,
    MESSAGE_ID_TTL_MS,
    MESSAGE_ID_MAX_ENTRIES,
} from "../src/utils/messageIdempotency.js";

// A clock the test controls.
function fakeClock(start = 1_000_000) {
    let time = start;
    return { now: () => time, advance: (ms) => { time += ms; } };
}

describe("createMessageIdCache", () => {
    test("defaults: 24-hour TTL, at most 10,000 IDs", () => {
        assert.equal(MESSAGE_ID_TTL_MS, 24 * 60 * 60 * 1000);
        assert.equal(MESSAGE_ID_MAX_ENTRIES, 10_000);
    });

    test("the first claim wins; a second claim of the same ID is refused", () => {
        const cache = createMessageIdCache();

        assert.equal(cache.claim("wamid.A"), true);
        assert.equal(cache.stateOf("wamid.A"), MESSAGE_STATE.IN_PROGRESS);
        assert.equal(cache.claim("wamid.A"), false, "still in progress");

        cache.complete("wamid.A");
        assert.equal(cache.stateOf("wamid.A"), MESSAGE_STATE.PROCESSED);
        assert.equal(cache.claim("wamid.A"), false, "already processed");
    });

    test("different IDs are independent", () => {
        const cache = createMessageIdCache();
        assert.equal(cache.claim("wamid.A"), true);
        assert.equal(cache.claim("wamid.B"), true);
    });

    test("a released claim can be claimed again (retry after a crash)", () => {
        const cache = createMessageIdCache();
        cache.claim("wamid.A");
        cache.release("wamid.A");

        assert.equal(cache.stateOf("wamid.A"), null);
        assert.equal(cache.claim("wamid.A"), true);
    });

    test("entries expire after the TTL", () => {
        const clock = fakeClock();
        const cache = createMessageIdCache({ ttlMs: 1_000, now: clock.now });

        cache.claim("wamid.A");
        cache.complete("wamid.A");
        clock.advance(999);
        assert.equal(cache.claim("wamid.A"), false);

        clock.advance(2);
        assert.equal(cache.claim("wamid.A"), true, "an expired ID may be handled again");
    });

    test("expired entries are removed, so the cache shrinks", () => {
        const clock = fakeClock();
        const cache = createMessageIdCache({ ttlMs: 1_000, now: clock.now });

        for (let i = 0; i < 50; i++) cache.claim(`wamid.${i}`);
        assert.equal(cache.size, 50);

        clock.advance(1_001);
        cache.claim("wamid.new");
        assert.equal(cache.size, 1);
    });

    test("never holds more than maxEntries: the oldest IDs are dropped first", () => {
        const cache = createMessageIdCache({ maxEntries: 10 });

        for (let i = 0; i < 1_000; i++) cache.claim(`wamid.${i}`);

        assert.equal(cache.size, 10);
        assert.equal(cache.stateOf("wamid.0"), null, "oldest dropped");
        assert.equal(cache.stateOf("wamid.999"), MESSAGE_STATE.IN_PROGRESS, "newest kept");
    });
});
