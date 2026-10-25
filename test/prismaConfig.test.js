import { describe, test } from "node:test";
import assert from "node:assert/strict";

// Prevent dotenv/config from loading DATABASE_POOL_MAX from local .env
process.env.DOTENV_CONFIG_PATH = "nonexistent";
delete process.env.DATABASE_POOL_MAX;
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";

describe("src/config/prisma.js pool size (serverless connection-exhaustion guard)", () => {
    test("defaults to a small, bounded pool size when DATABASE_POOL_MAX is unset", async () => {
        const { PRISMA_POOL_MAX } = await import("../src/config/prisma.js");
        assert.equal(PRISMA_POOL_MAX, 3);
    });
});
