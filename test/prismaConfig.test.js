import { describe, test } from "node:test";
import assert from "node:assert/strict";

// Placeholder so dotenv/config and the generated client don't need a real
// database; nothing in this file issues a query (pg.Pool connects lazily).
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";

describe("src/config/prisma.js pool size (serverless connection-exhaustion guard)", () => {
    test("defaults to a small, bounded pool size when DATABASE_POOL_MAX is unset", async () => {
        const { PRISMA_POOL_MAX } = await import("../src/config/prisma.js");
        assert.equal(PRISMA_POOL_MAX, 3);
    });
});
