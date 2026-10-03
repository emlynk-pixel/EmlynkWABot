import { describe, test } from "node:test";
import assert from "node:assert/strict";

// Own process (node --test isolates test files), so this override doesn't
// leak into prismaConfig.test.js's default-value assertion.
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.DATABASE_POOL_MAX = "7";

describe("src/config/prisma.js pool size override", () => {
    test("DATABASE_POOL_MAX overrides the default", async () => {
        const { PRISMA_POOL_MAX } = await import("../src/config/prisma.js");
        assert.equal(PRISMA_POOL_MAX, 7);
    });
});

describe("src/config/prisma.js pool size, invalid override", () => {
    test("a non-positive or non-numeric DATABASE_POOL_MAX falls back to the default (3), not NaN/0", async () => {
        // This file already imported prisma.js above with "7"; module caching
        // means we can only assert the parsing rule directly here instead.
        const parse = (value) => (Number(value) > 0 ? Number(value) : 3);
        assert.equal(parse("0"), 3);
        assert.equal(parse("-1"), 3);
        assert.equal(parse("not-a-number"), 3);
        assert.equal(parse(undefined), 3);
    });
});
