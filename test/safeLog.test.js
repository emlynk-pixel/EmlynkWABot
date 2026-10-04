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
        describe("confirmed shape for this project's stack (PrismaClient 6.19.3 + @prisma/adapter-pg)", () => {
            // Reproduced locally: a `$queryRaw`/`$executeRaw` tagged-template call
            // against a stubbed `pg.Pool` that rejects with a duck-typed Postgres
            // driver error ({ code: "42P01", severity: "ERROR", message: ... },
            // matching node-postgres's own error shape) surfaces to application
            // code as exactly this - a flat `meta.code`/`meta.message`, not the
            // richer internal `{ driverAdapterError: { cause: { kind,
            // originalCode, originalMessage } } }` shape the adapter uses
            // internally. Prisma normalizes it back to the flat shape for
            // backward compatibility with the classic query engine's public
            // `.meta` contract.
            test("a captured real error: relation does not exist (42P01)", () => {
                const error = Object.assign(new Error('relation "rate_limits" does not exist'), {
                    code: "P2010",
                    meta: { code: "42P01", message: 'relation "rate_limits" does not exist' },
                    clientVersion: "6.19.3",
                    name: "PrismaClientKnownRequestError",
                });
                assert.deepEqual(safePrismaErrorFields(error), {
                    prismaCode: "P2010",
                    prismaMeta: { dbErrorCode: "42P01", dbErrorMessage: "relation [redacted] does not exist" },
                });
            });

            test("a SQLSTATE-shaped meta.code is kept as dbErrorCode, meta.message as redacted dbErrorMessage", () => {
                const error = Object.assign(new Error("raw query failed"), {
                    code: "P2010",
                    meta: { code: "42501", message: "permission denied for table rate_limits" },
                });
                assert.deepEqual(safePrismaErrorFields(error), {
                    prismaCode: "P2010",
                    prismaMeta: { dbErrorCode: "42501", dbErrorMessage: "permission denied for table rate_limits" },
                });
            });

            test("dbErrorMessage is redacted and truncated the same way as every other logged message", () => {
                // Postgres's own message format quotes identifiers/usernames
                // (e.g. this exact wording for a failed auth attempt) - it never
                // echoes a submitted password in plaintext. safeErrorText's
                // quoted-value redaction covers that convention.
                const error = Object.assign(new Error("raw query failed"), {
                    code: "P2010",
                    meta: { code: "28P01", message: "password authentication failed for user \"postgres.myproject\"" },
                });
                const result = safePrismaErrorFields(error);
                assert.ok(!JSON.stringify(result).includes("myproject"));
                assert.deepEqual(result, {
                    prismaCode: "P2010",
                    prismaMeta: { dbErrorCode: "28P01", dbErrorMessage: "password authentication failed for user [redacted]" },
                });
            });

            test("dbErrorMessage is truncated to 200 characters, same cap as every other logged message", () => {
                const error = Object.assign(new Error("raw query failed"), {
                    code: "P2010",
                    meta: { code: "08006", message: "connection failure: " + "x".repeat(300) },
                });
                const result = safePrismaErrorFields(error);
                assert.equal(result.prismaMeta.dbErrorMessage.length, 200);
            });

            test("no meta.message -> dbErrorCode only, no dbErrorMessage key", () => {
                const error = Object.assign(new Error("raw query failed"), {
                    code: "P2010",
                    meta: { code: "53300" },
                });
                assert.deepEqual(safePrismaErrorFields(error), {
                    prismaCode: "P2010",
                    prismaMeta: { dbErrorCode: "53300" },
                });
            });

            test("a meta.code that isn't SQLSTATE-shaped is dropped, not passed through", () => {
                const error = Object.assign(new Error("raw query failed"), {
                    code: "P2010",
                    meta: { code: "some arbitrary driver text, not a SQLSTATE" },
                });
                assert.deepEqual(safePrismaErrorFields(error), { prismaCode: "P2010" });
            });
        });

        test("a nested driverAdapterError.cause shape (not what this stack produces) is not specially unwrapped", () => {
            const error = Object.assign(new Error("raw query failed"), {
                code: "P2010",
                meta: { driverAdapterError: { cause: { kind: "DatabaseAccessDenied", originalCode: "42501" } } },
            });
            // No top-level meta.code here, so nothing is extracted - documents
            // current behaviour rather than asserting this shape is real.
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
