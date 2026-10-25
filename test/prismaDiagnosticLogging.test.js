import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { logPrismaDiagnostic } from "../src/middleware/errorHandler.js";

describe("Temporary diagnostic logging for Prisma errors (logPrismaDiagnostic)", () => {
    test("diagnoses and extracts underlying PostgreSQL error from PrismaClientUnknownRequestError", () => {
        const logged = [];
        const origError = console.error;
        console.error = (...args) => logged.push(args);

        try {
            const rawConnectorMessage =
                "Error occurred during query execution:\n" +
                'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "XX000", message: "(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15", severity: "FATAL", detail: None, column: None, hint: None }), transient: false })';

            const error = new Error(rawConnectorMessage);
            error.name = "PrismaClientUnknownRequestError";

            const req = {
                method: "GET",
                baseUrl: "/api/admin",
                path: "/candidates",
            };

            logPrismaDiagnostic(error, req);

            assert.equal(logged.length, 1);
            const [prefix, payload] = logged[0];
            assert.equal(prefix, "[PRISMA_DIAGNOSTIC_ERROR]");
            assert.equal(payload.name, "PrismaClientUnknownRequestError");
            assert.equal(payload.endpoint, "GET /api/admin/candidates");
            assert.equal(payload.code, null);
            assert.ok(payload.message.includes("(EMAXCONNSESSION) max clients reached"));
            assert.deepEqual(payload.underlyingDbError, {
                code: "XX000",
                message: "(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15",
                severity: "FATAL",
            });
        } finally {
            console.error = origError;
        }
    });

    test("redacts database connection strings and passwords from message and meta", () => {
        const logged = [];
        const origError = console.error;
        console.error = (...args) => logged.push(args);

        try {
            const error = new Error(
                "Failed to connect to postgresql://postgres.abc:SecretP@ssword123@aws-0-pooler.supabase.com:5432/postgres with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w"
            );
            error.name = "PrismaClientInitializationError";
            error.code = "P1001";
            error.meta = {
                database_url: "postgresql://user:topsecret@localhost:5432/db",
                token: "secret_token_value",
            };

            const req = {
                method: "GET",
                baseUrl: "/api/admin",
                path: "/candidates",
            };

            logPrismaDiagnostic(error, req);

            assert.equal(logged.length, 1);
            const [, payload] = logged[0];

            const serialized = JSON.stringify(payload);
            assert.ok(!serialized.includes("SecretP@ssword123"), "password must be redacted");
            assert.ok(!serialized.includes("topsecret"), "meta password must be redacted");
            assert.ok(!serialized.includes("secret_token_value"), "token must be redacted");
            assert.ok(!serialized.includes("dozjgNryP4J3jVmNHl0w"), "JWT signature must be redacted");
            assert.ok(serialized.includes("[redacted]"));
        } finally {
            console.error = origError;
        }
    });

    test("ignores non-candidate endpoints to prevent noise in other subsystems", () => {
        const logged = [];
        const origError = console.error;
        console.error = (...args) => logged.push(args);

        try {
            const error = new Error("Some DB error");
            error.name = "PrismaClientUnknownRequestError";

            const req = {
                method: "GET",
                baseUrl: "/api/users",
                path: "/me",
            };

            logPrismaDiagnostic(error, req);
            assert.equal(logged.length, 0);
        } finally {
            console.error = origError;
        }
    });

    test("ignores generic non-Prisma errors even on candidate endpoint", () => {
        const logged = [];
        const origError = console.error;
        console.error = (...args) => logged.push(args);

        try {
            const error = new TypeError("Cannot read property of undefined");

            const req = {
                method: "GET",
                baseUrl: "/api/admin",
                path: "/candidates",
            };

            logPrismaDiagnostic(error, req);
            assert.equal(logged.length, 0);
        } finally {
            console.error = origError;
        }
    });
});
