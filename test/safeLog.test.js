import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { safePrismaErrorFields } from "../src/utils/safeLog.js";

describe("safePrismaErrorFields", () => {
    test("non-Prisma error -> null", () => {
        assert.equal(safePrismaErrorFields(new Error("boom")), null);
        assert.equal(safePrismaErrorFields(null), null);
        assert.equal(safePrismaErrorFields(undefined), null);
        assert.equal(safePrismaErrorFields({ code: "ENOENT" }), null); // not Prisma's P#### shape
    });

    test("Prisma code only, no meta -> just the code", () => {
        const error = Object.assign(new Error("table missing"), { code: "P2021" });
        assert.deepEqual(safePrismaErrorFields(error), { prismaCode: "P2021" });
    });

    test("Prisma code with allowlisted meta -> code and meta kept", () => {
        const error = Object.assign(new Error("table missing"), {
            code: "P2021",
            meta: { table: "rate_limits", modelName: "RateLimit" },
        });
        assert.deepEqual(safePrismaErrorFields(error), {
            prismaCode: "P2021",
            prismaMeta: { table: "rate_limits", modelName: "RateLimit" },
        });
    });

    test("meta keys outside the allowlist are dropped", () => {
        const error = Object.assign(new Error("x"), {
            code: "P2002",
            meta: { target: ["email"], cause: "duplicate row with email=someone@example.invalid" },
        });
        const result = safePrismaErrorFields(error);
        assert.deepEqual(result, { prismaCode: "P2002", prismaMeta: { target: ["email"] } });
        assert.ok(!JSON.stringify(result).includes("example.invalid"));
    });

    test("non-string/array meta values are dropped even for allowlisted keys", () => {
        const error = Object.assign(new Error("x"), {
            code: "P2025",
            meta: { table: { nested: "object" }, column: 123 },
        });
        assert.deepEqual(safePrismaErrorFields(error), { prismaCode: "P2025" });
    });

    test("the error's message is never read or returned", () => {
        const error = Object.assign(new Error("password=hunter2 for user@example.invalid"), {
            code: "P2021",
            meta: { table: "admins" },
        });
        const result = safePrismaErrorFields(error);
        assert.ok(!JSON.stringify(result).includes("hunter2"));
        assert.ok(!JSON.stringify(result).includes("example.invalid"));
    });

    describe("P2010 (raw query failed, e.g. $queryRaw/$executeRaw)", () => {
        test("a SQLSTATE-shaped meta.code is kept as dbErrorCode", () => {
            const error = Object.assign(new Error("raw query failed"), {
                code: "P2010",
                meta: { code: "42501", message: "permission denied for table rate_limits" },
            });
            assert.deepEqual(safePrismaErrorFields(error), {
                prismaCode: "P2010",
                prismaMeta: { dbErrorCode: "42501" },
            });
        });

        test("meta.message (can quote the failing SQL/values) is never returned", () => {
            const error = Object.assign(new Error("raw query failed"), {
                code: "P2010",
                meta: { code: "08006", message: "connection to server at \"db.internal\" failed: password=hunter2" },
            });
            const result = safePrismaErrorFields(error);
            assert.ok(!JSON.stringify(result).includes("hunter2"));
            assert.ok(!JSON.stringify(result).includes("db.internal"));
            assert.deepEqual(result, { prismaCode: "P2010", prismaMeta: { dbErrorCode: "08006" } });
        });

        test("a meta.code that isn't SQLSTATE-shaped is dropped, not passed through", () => {
            const error = Object.assign(new Error("raw query failed"), {
                code: "P2010",
                meta: { code: "some arbitrary driver text, not a SQLSTATE" },
            });
            assert.deepEqual(safePrismaErrorFields(error), { prismaCode: "P2010" });
        });

        test("no meta at all -> just the code", () => {
            const error = Object.assign(new Error("raw query failed"), { code: "P2010" });
            assert.deepEqual(safePrismaErrorFields(error), { prismaCode: "P2010" });
        });

        test("a bare 'code' key in meta is only trusted for P2010, not other codes", () => {
            const error = Object.assign(new Error("x"), {
                code: "P2025",
                meta: { code: "42501", cause: "Record not found" },
            });
            // P2025 doesn't use `meta.code` for a SQLSTATE; it must not be
            // picked up just because the key happens to be named "code".
            assert.deepEqual(safePrismaErrorFields(error), { prismaCode: "P2025" });
        });
    });
});
